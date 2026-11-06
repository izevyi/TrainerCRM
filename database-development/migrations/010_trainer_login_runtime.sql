BEGIN;

-- This runtime boundary is for the trusted application server only. Browsers
-- never receive database credentials, password hashes, or raw session rows.

CREATE FUNCTION authn.resolve_trainer_password(
  p_canonical_email text
)
RETURNS TABLE (
  trainer_subject_id uuid,
  email_identity_id uuid,
  tenant_id uuid,
  password_hash text,
  password_changed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
  SELECT credential.trainer_subject_id,
         identity.id,
         membership.tenant_id,
         credential.password_hash,
         credential.password_changed_at
    FROM authn.trainer_password_credentials AS credential
    JOIN booking.auth_subjects AS trainer
      ON trainer.id = credential.trainer_subject_id
    JOIN authn.email_identities AS identity
      ON identity.id = credential.email_identity_id
     AND identity.subject_id = trainer.id
    JOIN booking.trainer_memberships AS membership
      ON membership.trainer_id = trainer.id
    JOIN booking.tenants AS tenant
      ON tenant.id = membership.tenant_id
   WHERE p_canonical_email IS NOT NULL
     AND octet_length(p_canonical_email) BETWEEN 3 AND 254
     AND p_canonical_email = lower(p_canonical_email)
     AND p_canonical_email = btrim(p_canonical_email)
     AND identity.canonical_email = p_canonical_email
     AND identity.verified_at <= transaction_timestamp()
     AND identity.disabled_at IS NULL
     AND credential.password_changed_at <= transaction_timestamp()
     AND trainer.role = 'trainer'
     AND trainer.status = 'active'
     AND tenant.status = 'active'
$function$;

CREATE FUNCTION authn.create_trainer_session(
  p_trainer_subject_id uuid,
  p_verified_password_changed_at timestamptz,
  p_token_sha256_digest bytea
)
RETURNS TABLE (
  session_id uuid,
  trainer_subject_id uuid,
  email_identity_id uuid,
  tenant_id uuid,
  created_at timestamptz,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE
  v_now timestamptz := transaction_timestamp();
  v_identity_id uuid;
  v_tenant_id uuid;
  v_session_id uuid := gen_random_uuid();
BEGIN
  IF p_trainer_subject_id IS NULL OR
     p_verified_password_changed_at IS NULL OR
     p_token_sha256_digest IS NULL OR
     octet_length(p_token_sha256_digest) <> 32 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'SESSION_INPUT_INVALID';
  END IF;

  SELECT identity.id, membership.tenant_id
    INTO v_identity_id, v_tenant_id
    FROM authn.trainer_password_credentials AS credential
    JOIN booking.auth_subjects AS trainer
      ON trainer.id = credential.trainer_subject_id
    JOIN authn.email_identities AS identity
      ON identity.id = credential.email_identity_id
     AND identity.subject_id = trainer.id
    JOIN booking.trainer_memberships AS membership
      ON membership.trainer_id = trainer.id
    JOIN booking.tenants AS tenant
      ON tenant.id = membership.tenant_id
   WHERE credential.trainer_subject_id = p_trainer_subject_id
     AND trainer.role = 'trainer'
     AND trainer.status = 'active'
     AND identity.disabled_at IS NULL
     AND identity.verified_at <= v_now
     AND credential.password_changed_at = p_verified_password_changed_at
     AND p_verified_password_changed_at <= v_now
     AND tenant.status = 'active'
   FOR UPDATE OF credential;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TRAINER_LOGIN_INVALID';
  END IF;

  BEGIN
    INSERT INTO authn.trainer_sessions (
      id, trainer_subject_id, token_sha256_digest, created_at, last_seen_at,
      idle_expires_at, absolute_expires_at
    ) VALUES (
      v_session_id, p_trainer_subject_id, p_token_sha256_digest, v_now, v_now,
      v_now + interval '30 days', v_now + interval '180 days'
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SESSION_INPUT_INVALID';
  END;

  RETURN QUERY SELECT v_session_id, p_trainer_subject_id, v_identity_id,
                      v_tenant_id, v_now, v_now + interval '30 days',
                      v_now + interval '180 days';
END
$function$;

CREATE FUNCTION authn.resolve_trainer_session(
  p_token_sha256_digest bytea
)
RETURNS TABLE (
  session_id uuid,
  trainer_subject_id uuid,
  email_identity_id uuid,
  tenant_id uuid,
  created_at timestamptz,
  last_seen_at timestamptz,
  idle_expires_at timestamptz,
  absolute_expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE
  v_now timestamptz := transaction_timestamp();
BEGIN
  IF p_token_sha256_digest IS NULL OR
     octet_length(p_token_sha256_digest) <> 32 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'SESSION_INPUT_INVALID';
  END IF;

  RETURN QUERY
    UPDATE authn.trainer_sessions AS session
       SET last_seen_at = v_now,
           idle_expires_at = least(v_now + interval '30 days',
                                   session.absolute_expires_at)
      FROM authn.trainer_password_credentials AS credential
      JOIN booking.auth_subjects AS trainer
        ON trainer.id = credential.trainer_subject_id
      JOIN authn.email_identities AS identity
        ON identity.id = credential.email_identity_id
       AND identity.subject_id = trainer.id
      JOIN booking.trainer_memberships AS membership
        ON membership.trainer_id = trainer.id
      JOIN booking.tenants AS tenant
        ON tenant.id = membership.tenant_id
     WHERE session.token_sha256_digest = p_token_sha256_digest
       AND session.trainer_subject_id = credential.trainer_subject_id
       AND session.revoked_at IS NULL
       AND v_now < session.idle_expires_at
       AND v_now < session.absolute_expires_at
       AND session.created_at >= credential.password_changed_at
       AND trainer.role = 'trainer'
       AND trainer.status = 'active'
       AND identity.disabled_at IS NULL
       AND identity.verified_at <= session.created_at
       AND tenant.status = 'active'
    RETURNING session.id, session.trainer_subject_id, identity.id,
              membership.tenant_id, session.created_at, session.last_seen_at,
              session.idle_expires_at, session.absolute_expires_at;
END
$function$;

CREATE FUNCTION authn.revoke_trainer_session(
  p_token_sha256_digest bytea
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, authn
AS $function$
DECLARE
  v_revoked boolean;
BEGIN
  IF p_token_sha256_digest IS NULL OR
     octet_length(p_token_sha256_digest) <> 32 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'SESSION_INPUT_INVALID';
  END IF;

  UPDATE authn.trainer_sessions
     SET revoked_at = transaction_timestamp(),
         revoke_reason = 'logout'
   WHERE token_sha256_digest = p_token_sha256_digest
     AND revoked_at IS NULL;

  v_revoked := FOUND;
  RETURN v_revoked;
END
$function$;

REVOKE ALL ON FUNCTION authn.resolve_trainer_password(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION authn.create_trainer_session(
  uuid, timestamptz, bytea
) FROM PUBLIC;
REVOKE ALL ON FUNCTION authn.resolve_trainer_session(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION authn.revoke_trainer_session(bytea) FROM PUBLIC;

-- Remove any inherited or earlier accidental object access before granting the
-- exact runtime surface. These are revocations, never broad grants.
REVOKE ALL ON ALL TABLES IN SCHEMA authn FROM trainercrm_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA authn FROM trainercrm_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA authn FROM trainercrm_app;
REVOKE ALL ON SCHEMA booking FROM trainercrm_app;
REVOKE ALL ON SCHEMA authn FROM trainercrm_app;

GRANT USAGE ON SCHEMA authn TO trainercrm_app;
GRANT EXECUTE ON FUNCTION authn.resolve_trainer_password(text)
  TO trainercrm_app;
GRANT EXECUTE ON FUNCTION authn.create_trainer_session(
  uuid, timestamptz, bytea
)
  TO trainercrm_app;
GRANT EXECUTE ON FUNCTION authn.resolve_trainer_session(bytea)
  TO trainercrm_app;
GRANT EXECUTE ON FUNCTION authn.revoke_trainer_session(bytea)
  TO trainercrm_app;

COMMIT;
