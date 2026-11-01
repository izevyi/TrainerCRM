BEGIN;

-- Internal transaction primitive only. The digest and scope arguments are not
-- authentication or mailbox-ownership proof. A separately approved trusted
-- adapter must verify the raw bearer and pre-auth request before this function
-- may receive any non-owner EXECUTE grant. This migration grants none.
CREATE FUNCTION authn.accept_new_email_invitation(
  p_tenant_id uuid,
  p_trainer_id uuid,
  p_client_id uuid,
  p_invitation_id uuid,
  p_pepper_version smallint,
  p_token_digest bytea
)
RETURNS TABLE (
  invitation_id uuid,
  subject_id uuid,
  identity_id uuid,
  relationship_version bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE
  v_now timestamptz := transaction_timestamp();
  v_subject_id uuid := gen_random_uuid();
  v_identity_id uuid := gen_random_uuid();
  v_correlation_id uuid := gen_random_uuid();
  v_invitation authn.invitation_issuances%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR p_trainer_id IS NULL OR p_client_id IS NULL OR
     p_invitation_id IS NULL OR p_pepper_version IS NULL OR
     p_pepper_version <= 0 OR p_token_digest IS NULL OR
     octet_length(p_token_digest) <> 32 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LINK_INVALID';
  END IF;

  -- Match issue/revoke order: trainer identity, membership, client, invitation.
  PERFORM 1
    FROM booking.auth_subjects AS trainer
   WHERE trainer.id = p_trainer_id
     AND trainer.role = 'trainer'
     AND trainer.status = 'active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LINK_INVALID';
  END IF;

  PERFORM 1
    FROM booking.trainer_memberships AS membership
   WHERE membership.tenant_id = p_tenant_id
     AND membership.trainer_id = p_trainer_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LINK_INVALID';
  END IF;

  PERFORM 1
    FROM booking.clients AS client
   WHERE client.id = p_client_id
     AND client.tenant_id = p_tenant_id
     AND client.trainer_id = p_trainer_id
     AND client.status = 'invited'
     AND client.auth_subject_id IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LINK_INVALID';
  END IF;

  SELECT issuance.*
    INTO v_invitation
    FROM authn.invitation_issuances AS issuance
   WHERE issuance.id = p_invitation_id
     AND issuance.tenant_id = p_tenant_id
     AND issuance.trainer_id = p_trainer_id
     AND issuance.client_id = p_client_id
   FOR UPDATE;
  IF NOT FOUND OR v_invitation.status <> 'pending' OR
     v_now >= v_invitation.expires_at OR
     v_invitation.pepper_version <> p_pepper_version OR
     v_invitation.token_digest <> p_token_digest THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LINK_INVALID';
  END IF;

  -- Existing identities require an exact-subject authenticated session and a
  -- separately approved fresh step-up. Never merge or link them here.
  IF EXISTS (
    SELECT 1
      FROM authn.email_identities AS identity
     WHERE identity.normalization_version = v_invitation.normalization_version
       AND identity.canonical_email = v_invitation.canonical_email
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LINK_INVALID';
  END IF;

  INSERT INTO booking.auth_subjects(id, role)
  VALUES (v_subject_id, 'client');

  INSERT INTO authn.email_identities(
    id, subject_id, normalization_version, canonical_email, display_email,
    verified_at, created_at, updated_at
  ) VALUES (
    v_identity_id, v_subject_id, v_invitation.normalization_version,
    v_invitation.canonical_email, v_invitation.canonical_email,
    v_now, v_now, v_now
  );

  UPDATE booking.clients AS client
     SET auth_subject_id = v_subject_id, status = 'active'
   WHERE client.id = p_client_id
     AND client.tenant_id = p_tenant_id
     AND client.trainer_id = p_trainer_id;

  INSERT INTO authn.relationship_access(
    client_id, tenant_id, trainer_id, subject_id,
    version, status, activated_at, created_at, updated_at
  ) VALUES (
    p_client_id, p_tenant_id, p_trainer_id, v_subject_id,
    1, 'active', v_now, v_now, v_now
  );

  UPDATE authn.invitation_issuances AS issuance
     SET status = 'accepted', accepted_at = v_now,
         accepted_identity_id = v_identity_id,
         accepted_subject_id = v_subject_id
   WHERE issuance.id = p_invitation_id;

  INSERT INTO authn.authentication_audit(
    event_type, occurred_at, tenant_id, relationship_client_id,
    target_subject_id, invitation_id, result, correlation_id
  ) VALUES
    ('invitation.accepted', v_now, p_tenant_id, p_client_id,
     v_subject_id, p_invitation_id, 'succeeded', v_correlation_id),
    ('relationship.activated', v_now, p_tenant_id, p_client_id,
     v_subject_id, p_invitation_id, 'succeeded', v_correlation_id);

  RETURN QUERY SELECT p_invitation_id, v_subject_id, v_identity_id, 1::bigint;
END
$function$;

REVOKE ALL ON FUNCTION authn.accept_new_email_invitation(
  uuid, uuid, uuid, uuid, smallint, bytea
) FROM PUBLIC;

COMMIT;
