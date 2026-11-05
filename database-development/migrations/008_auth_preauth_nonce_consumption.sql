BEGIN;

-- Durable replay state for an already authenticated pre-auth challenge. This
-- table never stores the raw challenge nonce, cookie nonce, invitation bearer,
-- or either HMAC key. It is owner-internal and receives no runtime grant.
CREATE TABLE authn.preauth_nonce_consumptions (
  nonce_digest bytea PRIMARY KEY CHECK (octet_length(nonce_digest) = 32),
  invitation_id uuid NOT NULL REFERENCES authn.invitation_issuances(id),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at = issued_at + interval '300 seconds'),
  CHECK (consumed_at >= issued_at AND consumed_at < expires_at)
);

-- Internal transaction primitive only. These arguments are trusted selectors
-- produced after a future server adapter verifies the raw invitation bearer,
-- pre-auth HMAC envelope, exact HTTPS Origin, matching cookie, purpose, and
-- lifetime. They are not independently authentication or mailbox proof.
CREATE FUNCTION authn.consume_preauth_nonce_and_accept_new_email_invitation(
  p_nonce_digest bytea,
  p_nonce_issued_at timestamptz,
  p_nonce_expires_at timestamptz,
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
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_nonce_digest IS NULL OR octet_length(p_nonce_digest) <> 32 OR
     p_nonce_issued_at IS NULL OR p_nonce_expires_at IS NULL OR
     p_nonce_expires_at <> p_nonce_issued_at + interval '300 seconds' OR
     p_nonce_issued_at > v_now OR v_now >= p_nonce_expires_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LINK_INVALID';
  END IF;

  -- Preserve the established trainer, membership, client, invitation lock
  -- order and every acceptance invariant by calling, not copying, migration
  -- 007's primitive. RETURN QUERY is buffered until this function completes.
  RETURN QUERY
    SELECT accepted.invitation_id, accepted.subject_id,
           accepted.identity_id, accepted.relationship_version
      FROM authn.accept_new_email_invitation(
        p_tenant_id, p_trainer_id, p_client_id, p_invitation_id,
        p_pepper_version, p_token_digest
      ) AS accepted;

  -- Acceptance may have waited on any established lock. Re-read wall-clock
  -- time so a nonce that reached its deadline while waiting cannot succeed.
  v_now := clock_timestamp();
  IF p_nonce_issued_at > v_now OR v_now >= p_nonce_expires_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LINK_INVALID';
  END IF;

  BEGIN
    INSERT INTO authn.preauth_nonce_consumptions(
      nonce_digest, invitation_id, issued_at, expires_at
    ) VALUES (
      p_nonce_digest, p_invitation_id, p_nonce_issued_at, p_nonce_expires_at
    );
  EXCEPTION WHEN unique_violation THEN
    -- The primary-key constraint is the global one-time-use arbiter, including
    -- reuse against a different invitation. Do not disclose which conflict won.
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LINK_INVALID';
  END;

  -- A uniqueness wait can also cross the deadline. Raising here rolls back the
  -- nonce row and every change made by the existing acceptance function.
  -- The delegated acceptance function uses transaction_timestamp().
  -- Recheck invitation expiry using wall-clock time after all waits.
  -- Failure rolls back acceptance, nonce consumption and audits together.
  IF clock_timestamp() >= p_nonce_expires_at OR NOT EXISTS (
    SELECT 1
      FROM authn.invitation_issuances AS issuance
     WHERE issuance.id = p_invitation_id
       AND clock_timestamp() < issuance.expires_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LINK_INVALID';
  END IF;
END
$function$;

REVOKE ALL ON TABLE authn.preauth_nonce_consumptions FROM PUBLIC;
REVOKE ALL ON FUNCTION authn.consume_preauth_nonce_and_accept_new_email_invitation(
  bytea, timestamptz, timestamptz, uuid, uuid, uuid, uuid, smallint, bytea
) FROM PUBLIC;

COMMIT;
