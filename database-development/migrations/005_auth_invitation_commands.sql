BEGIN;

-- These commands are intentionally not an authentication boundary. The actor UUID
-- is an internal assertion from a future authenticated adapter. No application or
-- runtime role receives EXECUTE in this migration.
CREATE FUNCTION authn.issue_email_invitation(
  p_actor_subject_id uuid,
  p_tenant_id uuid,
  p_trainer_id uuid,
  p_client_id uuid,
  p_canonical_email text,
  p_normalization_version smallint,
  p_token_digest bytea,
  p_pepper_version smallint,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS TABLE (
  invitation_id uuid,
  invitation_status authn.invitation_status,
  created_at timestamptz,
  expires_at timestamptz,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE
  v_now timestamptz := transaction_timestamp();
  v_invitation authn.invitation_issuances%ROWTYPE;
  v_invitation_id uuid := gen_random_uuid();
  v_correlation_id uuid := gen_random_uuid();
BEGIN
  IF p_actor_subject_id IS NULL OR p_tenant_id IS NULL OR
     p_trainer_id IS NULL OR p_client_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RESOURCE_NOT_FOUND';
  END IF;
  IF p_actor_subject_id <> p_trainer_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RESOURCE_NOT_FOUND';
  END IF;
  IF p_normalization_version IS DISTINCT FROM 1 OR
     p_canonical_email IS NULL OR
     octet_length(p_canonical_email) NOT BETWEEN 3 AND 254 OR
     p_canonical_email <> lower(p_canonical_email) OR
     p_canonical_email !~ '^[a-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&''*+/=?^_`{|}~-]+)*@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' OR
     p_token_digest IS NULL OR octet_length(p_token_digest) <> 32 OR
     p_pepper_version IS NULL OR p_pepper_version <= 0 OR
     p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 200 OR
     p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VALIDATION_ERROR';
  END IF;

  -- Global order for these commands: trainer identity, membership, client,
  -- invitation. Callers retry a transaction aborted by PostgreSQL deadlock
  -- detection; no command catches or partially commits such failures.
  PERFORM 1
    FROM booking.auth_subjects AS actor
   WHERE actor.id = p_actor_subject_id
     AND actor.role = 'trainer'
     AND actor.status = 'active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RESOURCE_NOT_FOUND';
  END IF;

  PERFORM 1
    FROM booking.trainer_memberships AS membership
   WHERE membership.tenant_id = p_tenant_id
     AND membership.trainer_id = p_trainer_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RESOURCE_NOT_FOUND';
  END IF;

  PERFORM 1
    FROM booking.clients AS client
   WHERE client.id = p_client_id
     AND client.tenant_id = p_tenant_id
     AND client.trainer_id = p_trainer_id
     AND client.status = 'invited'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RESOURCE_NOT_FOUND';
  END IF;

  SELECT issuance.*
    INTO v_invitation
    FROM authn.invitation_issuances AS issuance
   WHERE issuance.tenant_id = p_tenant_id
     AND issuance.trainer_id = p_trainer_id
     AND issuance.client_id = p_client_id
     AND issuance.idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_invitation.request_hash <> p_request_hash THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN QUERY SELECT v_invitation.id, v_invitation.status,
      v_invitation.created_at, v_invitation.expires_at, true;
    RETURN;
  END IF;

  INSERT INTO authn.invitation_issuances(
    id, tenant_id, trainer_id, client_id, normalization_version,
    canonical_email, token_digest, pepper_version, expires_at, created_by,
    idempotency_key, request_hash, created_at
  ) VALUES (
    v_invitation_id, p_tenant_id, p_trainer_id, p_client_id,
    p_normalization_version, p_canonical_email, p_token_digest,
    p_pepper_version, v_now + interval '24 hours', p_actor_subject_id,
    p_idempotency_key, p_request_hash, v_now
  )
  RETURNING * INTO v_invitation;

  -- Metadata only: no raw token, link, body, recipient, or provider payload.
  -- This row is not claimed to be deliverable until a separately approved
  -- secure recipient-reference and worker design exists.
  INSERT INTO authn.outbox(
    id, kind, invitation_id, template_id, idempotency_key,
    next_attempt_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), 'invitation.delivery', v_invitation_id,
    'client-invitation-v1', v_invitation_id::text, v_now, v_now, v_now
  );

  INSERT INTO authn.authentication_audit(
    event_type, occurred_at, tenant_id, relationship_client_id,
    actor_subject_id, invitation_id, result, correlation_id
  ) VALUES (
    'invitation.created', v_now, p_tenant_id, p_client_id,
    p_actor_subject_id, v_invitation_id, 'succeeded', v_correlation_id
  );

  RETURN QUERY SELECT v_invitation.id, v_invitation.status,
    v_invitation.created_at, v_invitation.expires_at, false;
END
$function$;

CREATE FUNCTION authn.revoke_email_invitation(
  p_actor_subject_id uuid,
  p_tenant_id uuid,
  p_trainer_id uuid,
  p_client_id uuid,
  p_invitation_id uuid
)
RETURNS TABLE (
  invitation_id uuid,
  invitation_status authn.invitation_status,
  revoked_at timestamptz,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE
  v_now timestamptz := transaction_timestamp();
  v_invitation authn.invitation_issuances%ROWTYPE;
BEGIN
  IF p_actor_subject_id IS NULL OR p_tenant_id IS NULL OR
     p_trainer_id IS NULL OR p_client_id IS NULL OR p_invitation_id IS NULL OR
     p_actor_subject_id <> p_trainer_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RESOURCE_NOT_FOUND';
  END IF;

  PERFORM 1
    FROM booking.auth_subjects AS actor
   WHERE actor.id = p_actor_subject_id
     AND actor.role = 'trainer'
     AND actor.status = 'active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RESOURCE_NOT_FOUND';
  END IF;

  PERFORM 1
    FROM booking.trainer_memberships AS membership
   WHERE membership.tenant_id = p_tenant_id
     AND membership.trainer_id = p_trainer_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RESOURCE_NOT_FOUND';
  END IF;

  PERFORM 1
    FROM booking.clients AS client
   WHERE client.id = p_client_id
     AND client.tenant_id = p_tenant_id
     AND client.trainer_id = p_trainer_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RESOURCE_NOT_FOUND';
  END IF;

  SELECT issuance.*
    INTO v_invitation
    FROM authn.invitation_issuances AS issuance
   WHERE issuance.id = p_invitation_id
     AND issuance.tenant_id = p_tenant_id
     AND issuance.trainer_id = p_trainer_id
     AND issuance.client_id = p_client_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RESOURCE_NOT_FOUND';
  END IF;

  IF v_invitation.status = 'revoked' THEN
    RETURN QUERY SELECT v_invitation.id, v_invitation.status,
      v_invitation.revoked_at, true;
    RETURN;
  END IF;
  -- Expiry equality is no longer an authorized pending action. The command
  -- does not terminalize expired rows; expiry maintenance is out of scope.
  IF v_invitation.status <> 'pending' OR v_now >= v_invitation.expires_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVITATION_STATE_CONFLICT';
  END IF;

  UPDATE authn.invitation_issuances AS issuance
     SET status = 'revoked', revoked_at = v_now,
         revoke_reason = 'trainer_revoked'
   WHERE issuance.id = v_invitation.id
  RETURNING * INTO v_invitation;

  INSERT INTO authn.authentication_audit(
    event_type, occurred_at, tenant_id, relationship_client_id,
    actor_subject_id, invitation_id, result, correlation_id
  ) VALUES (
    'invitation.revoked', v_now, p_tenant_id, p_client_id,
    p_actor_subject_id, v_invitation.id, 'succeeded', gen_random_uuid()
  );

  RETURN QUERY SELECT v_invitation.id, v_invitation.status,
    v_invitation.revoked_at, false;
END
$function$;

REVOKE ALL ON FUNCTION authn.issue_email_invitation(
  uuid, uuid, uuid, uuid, text, smallint, bytea, smallint, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION authn.revoke_email_invitation(
  uuid, uuid, uuid, uuid, uuid
) FROM PUBLIC;

COMMIT;
