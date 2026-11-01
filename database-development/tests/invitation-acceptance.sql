\set ON_ERROR_STOP on

CREATE SCHEMA invitation_acceptance_test;

CREATE FUNCTION invitation_acceptance_test.assert(p_ok boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'assertion failed: %', p_message;
  END IF;
END
$function$;

CREATE FUNCTION invitation_acceptance_test.expect_link_invalid(
  p_tenant uuid, p_trainer uuid, p_client uuid, p_invitation uuid,
  p_pepper smallint, p_digest bytea
) RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM * FROM authn.accept_new_email_invitation(
    p_tenant, p_trainer, p_client, p_invitation, p_pepper, p_digest);
  RAISE EXCEPTION 'expected LINK_INVALID';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'LINK_INVALID' THEN RAISE; END IF;
END
$function$;

INSERT INTO booking.tenants(id, public_slug) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'acceptance-a'),
  ('a1000000-0000-0000-0000-000000000002', 'acceptance-b');
INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref) VALUES
  ('a2000000-0000-0000-0000-000000000001', 'trainer', 'synthetic:accept_trainer_a'),
  ('a2000000-0000-0000-0000-000000000002', 'trainer', 'synthetic:accept_trainer_b');
INSERT INTO booking.trainer_memberships(tenant_id, trainer_id) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001'),
  ('a1000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000002');

INSERT INTO booking.clients(id, tenant_id, trainer_id, display_name)
SELECT ('a3000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       'a1000000-0000-0000-0000-000000000001',
       'a2000000-0000-0000-0000-000000000001', 'Acceptance ' || n
  FROM generate_series(1, 12) AS n;
INSERT INTO booking.clients(id, tenant_id, trainer_id, display_name) VALUES
  ('a3000000-0000-0000-0000-000000000099', 'a1000000-0000-0000-0000-000000000002',
   'a2000000-0000-0000-0000-000000000002', 'Other Tenant');

CREATE FUNCTION invitation_acceptance_test.seed_invitation(
  p_n integer, p_email text, p_digest_hex text,
  p_status authn.invitation_status DEFAULT 'pending',
  p_created_at timestamptz DEFAULT transaction_timestamp()
) RETURNS uuid LANGUAGE plpgsql AS $function$
DECLARE
  v_client uuid := ('a3000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_invitation uuid := ('a4000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
BEGIN
  INSERT INTO authn.invitation_issuances(
    id, tenant_id, trainer_id, client_id, normalization_version,
    canonical_email, token_digest, pepper_version, status, expires_at,
    revoked_at, revoke_reason, created_by, idempotency_key, request_hash, created_at
  ) VALUES (
    v_invitation, 'a1000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', v_client, 1,
    p_email, decode(p_digest_hex, 'hex'), 1, p_status,
    p_created_at + interval '24 hours',
    CASE WHEN p_status = 'revoked' THEN p_created_at + interval '1 hour' END,
    CASE WHEN p_status = 'revoked' THEN 'synthetic_revocation' END,
    'a2000000-0000-0000-0000-000000000001',
    'acceptance-' || lpad(p_n::text, 3, '0'), repeat(to_hex(p_n % 16), 64), p_created_at
  );
  RETURN v_invitation;
END
$function$;

-- Positive path: all state changes share one database transaction timestamp.
SELECT invitation_acceptance_test.seed_invitation(1, 'new.client@example.invalid', repeat('11', 32));
SELECT * FROM authn.accept_new_email_invitation(
  'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001',
  1::smallint, decode(repeat('11', 32), 'hex'));
SELECT invitation_acceptance_test.assert((
  SELECT status = 'accepted' AND accepted_at < expires_at
    FROM authn.invitation_issuances WHERE id = 'a4000000-0000-0000-0000-000000000001'
), 'success accepts exactly before expiry');
SELECT invitation_acceptance_test.assert((
  SELECT client.status = 'active' AND client.auth_subject_id = issuance.accepted_subject_id
    FROM booking.clients AS client JOIN authn.invitation_issuances AS issuance
      ON issuance.client_id = client.id
   WHERE client.id = 'a3000000-0000-0000-0000-000000000001'
), 'success activates exact client and binds generated subject');
SELECT invitation_acceptance_test.assert((
  SELECT subject.synthetic_phone_ref IS NULL AND subject.phone_verified_at IS NULL
    FROM booking.auth_subjects AS subject JOIN authn.invitation_issuances AS issuance
      ON issuance.accepted_subject_id = subject.id
   WHERE issuance.id = 'a4000000-0000-0000-0000-000000000001'
), 'new subject is email-only');
SELECT invitation_acceptance_test.assert((
  SELECT count(*) = 1 FROM authn.email_identities AS identity
  JOIN authn.invitation_issuances AS issuance ON issuance.accepted_identity_id = identity.id
  WHERE issuance.id = 'a4000000-0000-0000-0000-000000000001'
    AND identity.canonical_email = issuance.canonical_email
), 'one exact verified identity created');
SELECT invitation_acceptance_test.assert((
  SELECT count(*) = 1 FROM authn.relationship_access
   WHERE client_id = 'a3000000-0000-0000-0000-000000000001'
     AND status = 'active' AND version = 1
), 'one active relationship created');
SELECT invitation_acceptance_test.assert((
  SELECT count(*) = 2 AND count(DISTINCT correlation_id) = 1
    FROM authn.authentication_audit
   WHERE invitation_id = 'a4000000-0000-0000-0000-000000000001'
     AND event_type IN ('invitation.accepted', 'relationship.activated')
), 'exact acceptance and relationship audits share correlation');

-- Replay and digest mismatch are fail-closed and create no additional state.
SELECT invitation_acceptance_test.expect_link_invalid(
  'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001',
  1::smallint, decode(repeat('11', 32), 'hex'));
SELECT invitation_acceptance_test.assert((SELECT count(*) = 2 FROM authn.authentication_audit
  WHERE invitation_id = 'a4000000-0000-0000-0000-000000000001'), 'replay adds no audit');

SELECT invitation_acceptance_test.seed_invitation(2, 'wrong.proof@example.invalid', repeat('22', 32));
SELECT invitation_acceptance_test.expect_link_invalid(
  'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000002', 'a4000000-0000-0000-0000-000000000002',
  1::smallint, decode(repeat('23', 32), 'hex'));
SELECT invitation_acceptance_test.expect_link_invalid(
  'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000002', 'a4000000-0000-0000-0000-000000000002',
  1::smallint, NULL);
SELECT invitation_acceptance_test.expect_link_invalid(
  'a1000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000002',
  'a3000000-0000-0000-0000-000000000099', 'a4000000-0000-0000-0000-000000000002',
  1::smallint, decode(repeat('22', 32), 'hex'));
SELECT invitation_acceptance_test.assert((SELECT status = 'pending' FROM authn.invitation_issuances
  WHERE id = 'a4000000-0000-0000-0000-000000000002'), 'wrong/missing proof and scope leave pending');

-- Expiry equality is invalid and does not terminalize the row.
SELECT invitation_acceptance_test.seed_invitation(
  3, 'expired@example.invalid', repeat('33', 32), 'pending', transaction_timestamp() - interval '24 hours');
SELECT invitation_acceptance_test.expect_link_invalid(
  'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000003', 'a4000000-0000-0000-0000-000000000003',
  1::smallint, decode(repeat('33', 32), 'hex'));
SELECT invitation_acceptance_test.assert((SELECT status = 'pending' FROM authn.invitation_issuances
  WHERE id = 'a4000000-0000-0000-0000-000000000003'), 'expiry equality leaves pending');

-- Revoked and existing verified identities always fail without linking.
SELECT invitation_acceptance_test.seed_invitation(
  4, 'revoked@example.invalid', repeat('44', 32), 'revoked', transaction_timestamp() - interval '2 hours');
SELECT invitation_acceptance_test.expect_link_invalid(
  'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000004', 'a4000000-0000-0000-0000-000000000004',
  1::smallint, decode(repeat('44', 32), 'hex'));

INSERT INTO booking.auth_subjects(id, role) VALUES
  ('a5000000-0000-0000-0000-000000000005', 'client');
INSERT INTO authn.email_identities(
  id, subject_id, normalization_version, canonical_email, display_email,
  verified_at, created_at, updated_at
) VALUES (
  'a6000000-0000-0000-0000-000000000005', 'a5000000-0000-0000-0000-000000000005',
  1, 'existing@example.invalid', 'existing@example.invalid',
  transaction_timestamp(), transaction_timestamp(), transaction_timestamp());
SELECT invitation_acceptance_test.seed_invitation(5, 'existing@example.invalid', repeat('55', 32));
SELECT invitation_acceptance_test.expect_link_invalid(
  'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000005', 'a4000000-0000-0000-0000-000000000005',
  1::smallint, decode(repeat('55', 32), 'hex'));
SELECT invitation_acceptance_test.assert((SELECT status = 'pending' FROM authn.invitation_issuances
  WHERE id = 'a4000000-0000-0000-0000-000000000005'), 'existing subject remains pending');

-- Explicit expired and superseded terminal rows are also unusable.
INSERT INTO authn.invitation_issuances(
  id, tenant_id, trainer_id, client_id, normalization_version,
  canonical_email, token_digest, pepper_version, status, expires_at,
  expired_at, created_by, idempotency_key, request_hash, created_at
) VALUES (
  'a4000000-0000-0000-0000-000000000009',
  'a1000000-0000-0000-0000-000000000001',
  'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000009', 1,
  'terminal.expired@example.invalid', decode(repeat('99', 32), 'hex'), 1,
  'expired', transaction_timestamp() - interval '1 hour', transaction_timestamp(),
  'a2000000-0000-0000-0000-000000000001', 'terminal-expired-009', repeat('9', 64),
  transaction_timestamp() - interval '25 hours'
);
INSERT INTO authn.invitation_issuances(
  id, tenant_id, trainer_id, client_id, normalization_version,
  canonical_email, token_digest, pepper_version, expires_at,
  created_by, idempotency_key, request_hash, created_at
) VALUES (
  'a4000000-0000-0000-0000-000000000110',
  'a1000000-0000-0000-0000-000000000001',
  'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000010', 1,
  'terminal.new@example.invalid', decode(repeat('10', 32), 'hex'), 1,
  transaction_timestamp() + interval '24 hours',
  'a2000000-0000-0000-0000-000000000001', 'terminal-new-010', repeat('a', 64),
  transaction_timestamp()
);
INSERT INTO authn.invitation_issuances(
  id, tenant_id, trainer_id, client_id, normalization_version,
  canonical_email, token_digest, pepper_version, status, expires_at,
  superseded_at, superseded_by, created_by, idempotency_key, request_hash, created_at
) VALUES (
  'a4000000-0000-0000-0000-000000000010',
  'a1000000-0000-0000-0000-000000000001',
  'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000010', 1,
  'terminal.old@example.invalid', decode(repeat('aa', 32), 'hex'), 1,
  'superseded', transaction_timestamp() + interval '23 hours', transaction_timestamp(),
  'a4000000-0000-0000-0000-000000000110',
  'a2000000-0000-0000-0000-000000000001', 'terminal-old-010', repeat('b', 64),
  transaction_timestamp() - interval '1 hour'
);
SELECT invitation_acceptance_test.expect_link_invalid(
  'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000009', 'a4000000-0000-0000-0000-000000000009',
  1::smallint, decode(repeat('99', 32), 'hex'));
SELECT invitation_acceptance_test.expect_link_invalid(
  'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000010', 'a4000000-0000-0000-0000-000000000010',
  1::smallint, decode(repeat('aa', 32), 'hex'));

-- Forced audit failure rolls back subject, identity, client, relationship and acceptance.
SELECT invitation_acceptance_test.seed_invitation(6, 'rollback@example.invalid', repeat('66', 32));
CREATE FUNCTION invitation_acceptance_test.fail_acceptance_audit()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.invitation_id = 'a4000000-0000-0000-0000-000000000006' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INJECTED_ACCEPTANCE_AUDIT_FAILURE';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER invitation_acceptance_fail_audit
BEFORE INSERT ON authn.authentication_audit
FOR EACH ROW EXECUTE FUNCTION invitation_acceptance_test.fail_acceptance_audit();
DO $test$
BEGIN
  PERFORM * FROM authn.accept_new_email_invitation(
    'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000006', 'a4000000-0000-0000-0000-000000000006',
    1::smallint, decode(repeat('66', 32), 'hex'));
  RAISE EXCEPTION 'expected injected failure';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'INJECTED_ACCEPTANCE_AUDIT_FAILURE' THEN RAISE; END IF;
END
$test$;
DROP TRIGGER invitation_acceptance_fail_audit ON authn.authentication_audit;
SELECT invitation_acceptance_test.assert((SELECT status = 'pending' FROM authn.invitation_issuances
  WHERE id = 'a4000000-0000-0000-0000-000000000006'), 'forced failure rolls back invitation');
SELECT invitation_acceptance_test.assert((SELECT status = 'invited' AND auth_subject_id IS NULL
  FROM booking.clients WHERE id = 'a3000000-0000-0000-0000-000000000006'), 'forced failure rolls back client');
SELECT invitation_acceptance_test.assert(NOT EXISTS (SELECT 1 FROM authn.email_identities
  WHERE canonical_email = 'rollback@example.invalid'), 'forced failure rolls back identity');

-- Fixtures and wrappers used by independent-connection races.
SELECT invitation_acceptance_test.seed_invitation(7, 'race@example.invalid', repeat('77', 32));
SELECT invitation_acceptance_test.seed_invitation(8, 'revoke.race@example.invalid', repeat('88', 32));
CREATE FUNCTION invitation_acceptance_test.try_accept(p_n integer, p_invitation uuid, p_client uuid, p_hex text)
RETURNS text LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM * FROM authn.accept_new_email_invitation(
    'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001',
    p_client, p_invitation, 1::smallint, decode(p_hex, 'hex'));
  RETURN 'ACCEPTED';
EXCEPTION WHEN SQLSTATE 'P0001' THEN RETURN SQLERRM;
END
$function$;
CREATE FUNCTION invitation_acceptance_test.try_revoke_race()
RETURNS text LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM * FROM authn.revoke_email_invitation(
    'a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000008',
    'a4000000-0000-0000-0000-000000000008');
  RETURN 'REVOKED';
EXCEPTION WHEN SQLSTATE 'P0001' THEN RETURN SQLERRM;
END
$function$;

SELECT invitation_acceptance_test.assert(NOT EXISTS (
  SELECT 1
  FROM pg_proc AS proc
  JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace,
       LATERAL aclexplode(coalesce(
         proc.proacl, acldefault('f', proc.proowner)
       )) AS privilege
  WHERE namespace.nspname = 'authn'
    AND proc.proname = 'accept_new_email_invitation'
    AND privilege.grantee = 0
    AND privilege.privilege_type = 'EXECUTE'
), 'PUBLIC cannot accept invitations');
SELECT invitation_acceptance_test.assert(NOT EXISTS (
  SELECT 1 FROM pg_proc AS proc JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace,
       LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS privilege
   WHERE namespace.nspname = 'authn' AND proc.proname = 'accept_new_email_invitation'
     AND privilege.grantee <> proc.proowner
), 'acceptance command has no non-owner grantee');
SELECT invitation_acceptance_test.assert((
  SELECT proc.prosecdef AND proc.proconfig @> ARRAY['search_path=pg_catalog, booking, authn']
  FROM pg_proc AS proc JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
  WHERE namespace.nspname = 'authn' AND proc.proname = 'accept_new_email_invitation'
), 'acceptance command is security definer with fixed path');

SELECT 'PASS: invitation acceptance serial checks' AS result;
