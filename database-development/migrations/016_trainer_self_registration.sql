BEGIN;

-- Separate, least-privileged SECURITY DEFINER owner. Provision once by DBA:
-- CREATE ROLE trainercrm_registration_owner NOLOGIN NOSUPERUSER NOCREATEDB
--   NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
-- The migration operator must be a member of this owner role.
DO $preflight$
DECLARE r pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname='trainercrm_registration_owner';
  IF NOT FOUND OR r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR
     r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls OR
     EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid) THEN
    RAISE EXCEPTION 'trainercrm_registration_owner must be isolated NOLOGIN/NOINHERIT';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'trainercrm_registration_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'migration operator lacks trainercrm_registration_owner membership';
  END IF;
END
$preflight$;

-- Pending mailboxes MUST NOT appear in authn.email_identities: that table is
-- reserved for verified owners. Store only a password HASH and token DIGEST.
CREATE TABLE authn.trainer_registration_pending (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  canonical_email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  token_digest bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (transaction_timestamp() + interval '24 hours'),
  CHECK (octet_length(canonical_email) BETWEEN 3 AND 254),
  CHECK (canonical_email=lower(canonical_email)),
  CHECK (canonical_email ~ '^[a-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&''*+/=?^_`{|}~-]+)*@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  CHECK (password_hash LIKE '$scrypt$%'),
  CHECK (octet_length(password_hash) BETWEEN 30 AND 1024),
  CHECK (octet_length(token_digest)=32),
  CHECK (expires_at=created_at+interval '24 hours')
);
CREATE INDEX trainer_registration_pending_expiry_idx
  ON authn.trainer_registration_pending(expires_at);
REVOKE ALL ON authn.trainer_registration_pending FROM PUBLIC, trainercrm_app;

-- Returns false for both existing accounts and cooldowns, so the HTTP layer
-- can always give the same non-enumerating response.
CREATE FUNCTION authn.begin_trainer_registration(
  p_email text, p_password_hash text, p_token_digest bytea
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,authn,booking
AS $function$
DECLARE v_id uuid;
BEGIN
  IF p_email IS NULL OR octet_length(p_email) NOT BETWEEN 3 AND 254 OR
     p_email <> lower(p_email) OR p_password_hash IS NULL OR
     p_password_hash NOT LIKE '$scrypt$%' OR
     octet_length(p_password_hash) NOT BETWEEN 30 AND 1024 OR
     p_token_digest IS NULL OR octet_length(p_token_digest)<>32 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='REGISTRATION_INPUT_INVALID';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('trainer-register:'||p_email,0));
  IF EXISTS (SELECT 1 FROM authn.email_identities WHERE canonical_email=p_email) THEN
    RETURN false;
  END IF;

  -- Clean up stale applications opportunistically, using an indexed predicate.
  DELETE FROM authn.trainer_registration_pending
   WHERE expires_at < transaction_timestamp() - interval '7 days';

  INSERT INTO authn.trainer_registration_pending AS pending
    (canonical_email,password_hash,token_digest)
  VALUES (p_email,p_password_hash,p_token_digest)
  ON CONFLICT (canonical_email) DO UPDATE
    SET password_hash=EXCLUDED.password_hash,
        token_digest=EXCLUDED.token_digest,
        created_at=transaction_timestamp(),
        expires_at=transaction_timestamp()+interval '24 hours'
    WHERE pending.created_at <= transaction_timestamp() - interval '15 minutes'
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END
$function$;

-- A single atomic statement consumes the link and creates all required
-- subject/membership/verified-identity/credential rows. A replay returns none.
CREATE FUNCTION authn.complete_trainer_registration(p_token_digest bytea)
RETURNS TABLE(trainer_id uuid, tenant_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,authn,booking
AS $function$
DECLARE
  v_pending authn.trainer_registration_pending%ROWTYPE;
  v_email text;
  v_trainer uuid := pg_catalog.gen_random_uuid();
  v_tenant uuid := pg_catalog.gen_random_uuid();
  v_identity uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF p_token_digest IS NULL OR octet_length(p_token_digest)<>32 THEN
    RETURN;
  END IF;
  -- Read email first, take the SAME advisory lock as begin(), THEN lock the
  -- pending row. Avoid deadlock with concurrent ON CONFLICT updates.
  SELECT canonical_email INTO v_email FROM authn.trainer_registration_pending
   WHERE token_digest=p_token_digest;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('trainer-register:'||v_email,0));
  SELECT * INTO v_pending FROM authn.trainer_registration_pending
   WHERE token_digest=p_token_digest FOR UPDATE;
  IF NOT FOUND OR v_pending.expires_at <= transaction_timestamp() THEN RETURN; END IF;
  DELETE FROM authn.trainer_registration_pending WHERE id=v_pending.id;
  IF EXISTS (SELECT 1 FROM authn.email_identities
             WHERE canonical_email=v_pending.canonical_email) THEN RETURN; END IF;

  INSERT INTO booking.tenants(id,public_slug)
    VALUES(v_tenant, 'trainer-'||replace(v_tenant::text,'-',''));
  INSERT INTO booking.auth_subjects(id,role,synthetic_phone_ref)
    VALUES(v_trainer,'trainer','synthetic:registration_'||replace(v_trainer::text,'-',''));
  INSERT INTO booking.trainer_memberships(tenant_id,trainer_id)
    VALUES(v_tenant,v_trainer);
  INSERT INTO authn.email_identities
    (id,subject_id,normalization_version,canonical_email,display_email,verified_at)
    VALUES(v_identity,v_trainer,1,v_pending.canonical_email,v_pending.canonical_email,transaction_timestamp());
  INSERT INTO authn.trainer_password_credentials
    (trainer_subject_id,email_identity_id,password_hash)
    VALUES(v_trainer,v_identity,v_pending.password_hash);
  RETURN QUERY SELECT v_trainer,v_tenant;
END
$function$;

-- Give the isolated function owner only the necessary privileges.
GRANT USAGE ON SCHEMA booking,authn TO trainercrm_registration_owner;
GRANT SELECT ON authn.email_identities TO trainercrm_registration_owner;
GRANT INSERT ON authn.email_identities, authn.trainer_password_credentials,
  booking.tenants, booking.auth_subjects, booking.trainer_memberships
  TO trainercrm_registration_owner;
GRANT SELECT,INSERT,UPDATE,DELETE ON authn.trainer_registration_pending
  TO trainercrm_registration_owner;

REVOKE ALL ON FUNCTION authn.begin_trainer_registration(text,text,bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION authn.complete_trainer_registration(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authn.begin_trainer_registration(text,text,bytea),
  authn.complete_trainer_registration(bytea) TO trainercrm_app;

GRANT CREATE ON SCHEMA authn TO trainercrm_registration_owner;
ALTER TABLE authn.trainer_registration_pending OWNER TO trainercrm_registration_owner;
ALTER FUNCTION authn.begin_trainer_registration(text,text,bytea)
  OWNER TO trainercrm_registration_owner;
ALTER FUNCTION authn.complete_trainer_registration(bytea)
  OWNER TO trainercrm_registration_owner;
REVOKE CREATE ON SCHEMA authn FROM trainercrm_registration_owner;

COMMIT;
