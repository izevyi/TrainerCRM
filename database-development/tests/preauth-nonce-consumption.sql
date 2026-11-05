\set ON_ERROR_STOP on

CREATE SCHEMA preauth_nonce_test;

CREATE FUNCTION preauth_nonce_test.assert(p_ok boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'assertion failed: %', p_message;
  END IF;
END
$function$;

CREATE FUNCTION preauth_nonce_test.expect_link_invalid(
  p_nonce bytea, p_issued timestamptz, p_expires timestamptz,
  p_client uuid, p_invitation uuid, p_invitation_digest bytea
) RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM *
    FROM authn.consume_preauth_nonce_and_accept_new_email_invitation(
      p_nonce, p_issued, p_expires,
      'b1000000-0000-0000-0000-000000000001',
      'b2000000-0000-0000-0000-000000000001',
      p_client, p_invitation, 1::smallint, p_invitation_digest);
  RAISE EXCEPTION 'expected LINK_INVALID';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'LINK_INVALID' THEN RAISE; END IF;
END
$function$;

INSERT INTO booking.tenants(id, public_slug) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'preauth-a'),
  ('b1000000-0000-0000-0000-000000000002', 'preauth-b');
INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref) VALUES
  ('b2000000-0000-0000-0000-000000000001', 'trainer', 'synthetic:preauth_trainer_a'),
  ('b2000000-0000-0000-0000-000000000002', 'trainer', 'synthetic:preauth_trainer_b');
INSERT INTO booking.trainer_memberships(tenant_id, trainer_id) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000002');

INSERT INTO booking.clients(id, tenant_id, trainer_id, display_name)
SELECT ('b3000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       'b1000000-0000-0000-0000-000000000001',
       'b2000000-0000-0000-0000-000000000001', 'Preauth ' || n
  FROM generate_series(1, 20) AS n;
INSERT INTO booking.clients(id, tenant_id, trainer_id, display_name) VALUES
  ('b3000000-0000-0000-0000-000000000099',
   'b1000000-0000-0000-0000-000000000002',
   'b2000000-0000-0000-0000-000000000002', 'Unrelated tenant');

CREATE FUNCTION preauth_nonce_test.seed_invitation(
  p_n integer, p_email text, p_digest_hex text,
  p_status authn.invitation_status DEFAULT 'pending',
  p_created_at timestamptz DEFAULT transaction_timestamp()
) RETURNS uuid LANGUAGE plpgsql AS $function$
DECLARE
  v_client uuid := ('b3000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_invitation uuid := ('b4000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid;
BEGIN
  INSERT INTO authn.invitation_issuances(
    id, tenant_id, trainer_id, client_id, normalization_version,
    canonical_email, token_digest, pepper_version, status, expires_at,
    revoked_at, revoke_reason, expired_at, created_by,
    idempotency_key, request_hash, created_at
  ) VALUES (
    v_invitation, 'b1000000-0000-0000-0000-000000000001',
    'b2000000-0000-0000-0000-000000000001', v_client, 1,
    p_email, decode(p_digest_hex, 'hex'), 1, p_status,
    p_created_at + interval '24 hours',
    CASE WHEN p_status = 'revoked' THEN p_created_at + interval '1 hour' END,
    CASE WHEN p_status = 'revoked' THEN 'synthetic_revocation' END,
    CASE WHEN p_status = 'expired' THEN p_created_at + interval '24 hours' END,
    'b2000000-0000-0000-0000-000000000001',
    'preauth-' || lpad(p_n::text, 3, '0'), repeat(to_hex(p_n % 16), 64), p_created_at
  );
  RETURN v_invitation;
END
$function$;

-- An unrelated active identity and relationship must remain byte-for-byte scoped.
INSERT INTO booking.auth_subjects(id, role) VALUES
  ('b5000000-0000-0000-0000-000000000020', 'client');
INSERT INTO authn.email_identities(
  id, subject_id, normalization_version, canonical_email, display_email,
  verified_at, created_at, updated_at
) VALUES (
  'b6000000-0000-0000-0000-000000000020',
  'b5000000-0000-0000-0000-000000000020', 1,
  'unrelated@example.invalid', 'unrelated@example.invalid',
  transaction_timestamp(), transaction_timestamp(), transaction_timestamp());
UPDATE booking.clients
   SET auth_subject_id = 'b5000000-0000-0000-0000-000000000020', status = 'active'
 WHERE id = 'b3000000-0000-0000-0000-000000000020';
INSERT INTO authn.relationship_access(
  client_id, tenant_id, trainer_id, subject_id, activated_at
) VALUES (
  'b3000000-0000-0000-0000-000000000020',
  'b1000000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000001',
  'b5000000-0000-0000-0000-000000000020', transaction_timestamp());

-- Success consumes one nonce and delegates all acceptance state to migration 007.
SELECT preauth_nonce_test.seed_invitation(1, 'success@example.invalid', repeat('11', 32));
SELECT * FROM authn.consume_preauth_nonce_and_accept_new_email_invitation(
  decode(repeat('a1', 32), 'hex'), transaction_timestamp() - interval '1 second',
  transaction_timestamp() + interval '299 seconds',
  'b1000000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000001',
  'b3000000-0000-0000-0000-000000000001',
  'b4000000-0000-0000-0000-000000000001',
  1::smallint, decode(repeat('11', 32), 'hex'));
SELECT preauth_nonce_test.assert((
  SELECT count(*) = 1 AND min(invitation_id::text)::uuid = 'b4000000-0000-0000-0000-000000000001'
    FROM authn.preauth_nonce_consumptions
   WHERE nonce_digest = decode(repeat('a1', 32), 'hex')
), 'success persists exactly one nonce consumption');
SELECT preauth_nonce_test.assert((
  SELECT issuance.status = 'accepted' AND client.status = 'active'
         AND client.auth_subject_id = issuance.accepted_subject_id
    FROM authn.invitation_issuances AS issuance
    JOIN booking.clients AS client ON client.id = issuance.client_id
   WHERE issuance.id = 'b4000000-0000-0000-0000-000000000001'
), 'success accepts invitation and activates exact client');
SELECT preauth_nonce_test.assert((
  SELECT count(*) = 1
    FROM authn.email_identities AS identity
    JOIN authn.invitation_issuances AS issuance
      ON issuance.accepted_identity_id = identity.id
   WHERE issuance.id = 'b4000000-0000-0000-0000-000000000001'
     AND identity.canonical_email = 'success@example.invalid'
), 'success creates the exact verified identity');
SELECT preauth_nonce_test.assert((
  SELECT count(*) = 1 FROM authn.relationship_access
   WHERE client_id = 'b3000000-0000-0000-0000-000000000001'
     AND status = 'active' AND version = 1
), 'success creates one active relationship');
SELECT preauth_nonce_test.assert((
  SELECT count(*) = 2 AND count(DISTINCT correlation_id) = 1
    FROM authn.authentication_audit
   WHERE invitation_id = 'b4000000-0000-0000-0000-000000000001'
), 'success preserves exact correlated acceptance audits');

-- Accepted replay and cross-invitation global nonce reuse both fail closed.
SELECT preauth_nonce_test.expect_link_invalid(
  decode(repeat('a1', 32), 'hex'), transaction_timestamp() - interval '1 second',
  transaction_timestamp() + interval '299 seconds',
  'b3000000-0000-0000-0000-000000000001',
  'b4000000-0000-0000-0000-000000000001', decode(repeat('11', 32), 'hex'));
SELECT preauth_nonce_test.seed_invitation(2, 'cross-reuse@example.invalid', repeat('22', 32));
SELECT preauth_nonce_test.expect_link_invalid(
  decode(repeat('a1', 32), 'hex'), transaction_timestamp() - interval '1 second',
  transaction_timestamp() + interval '299 seconds',
  'b3000000-0000-0000-0000-000000000002',
  'b4000000-0000-0000-0000-000000000002', decode(repeat('22', 32), 'hex'));
SELECT preauth_nonce_test.assert((
  SELECT status = 'pending' FROM authn.invitation_issuances
   WHERE id = 'b4000000-0000-0000-0000-000000000002'
), 'cross-invitation nonce conflict rolls acceptance back');

-- Exact 300-second boundary, future issuance, bad length, and inconsistent
-- metadata are rejected without consuming a nonce or touching the invitation.
SELECT preauth_nonce_test.seed_invitation(3, 'metadata@example.invalid', repeat('33', 32));
DO $test$
DECLARE v_boundary timestamptz := clock_timestamp();
BEGIN
  PERFORM preauth_nonce_test.expect_link_invalid(
    decode(repeat('a3', 32), 'hex'), v_boundary - interval '300 seconds', v_boundary,
    'b3000000-0000-0000-0000-000000000003',
    'b4000000-0000-0000-0000-000000000003', decode(repeat('33', 32), 'hex'));
END
$test$;
SELECT preauth_nonce_test.expect_link_invalid(
  decode(repeat('a4', 32), 'hex'), transaction_timestamp() + interval '1 second',
  transaction_timestamp() + interval '301 seconds',
  'b3000000-0000-0000-0000-000000000003',
  'b4000000-0000-0000-0000-000000000003', decode(repeat('33', 32), 'hex'));
SELECT preauth_nonce_test.expect_link_invalid(
  decode(repeat('a5', 31), 'hex'), transaction_timestamp() - interval '1 second',
  transaction_timestamp() + interval '299 seconds',
  'b3000000-0000-0000-0000-000000000003',
  'b4000000-0000-0000-0000-000000000003', decode(repeat('33', 32), 'hex'));
SELECT preauth_nonce_test.expect_link_invalid(
  decode(repeat('a6', 32), 'hex'), transaction_timestamp() - interval '1 second',
  transaction_timestamp() + interval '298 seconds',
  'b3000000-0000-0000-0000-000000000003',
  'b4000000-0000-0000-0000-000000000003', decode(repeat('33', 32), 'hex'));
SELECT preauth_nonce_test.assert((
  SELECT status = 'pending' FROM authn.invitation_issuances
   WHERE id = 'b4000000-0000-0000-0000-000000000003'
), 'invalid nonce metadata leaves invitation pending');
SELECT preauth_nonce_test.assert((
  SELECT count(*) = 1 FROM authn.preauth_nonce_consumptions
), 'invalid attempts add no nonce consumption');

-- Revoked, expired, and existing-identity invitations remain unusable.
SELECT preauth_nonce_test.seed_invitation(
  4, 'revoked@example.invalid', repeat('44', 32), 'revoked',
  transaction_timestamp() - interval '2 hours');
SELECT preauth_nonce_test.expect_link_invalid(
  decode(repeat('b4', 32), 'hex'), transaction_timestamp(), transaction_timestamp() + interval '300 seconds',
  'b3000000-0000-0000-0000-000000000004',
  'b4000000-0000-0000-0000-000000000004', decode(repeat('44', 32), 'hex'));
SELECT preauth_nonce_test.seed_invitation(
  5, 'expired@example.invalid', repeat('55', 32), 'expired',
  transaction_timestamp() - interval '25 hours');
SELECT preauth_nonce_test.expect_link_invalid(
  decode(repeat('b5', 32), 'hex'), transaction_timestamp(), transaction_timestamp() + interval '300 seconds',
  'b3000000-0000-0000-0000-000000000005',
  'b4000000-0000-0000-0000-000000000005', decode(repeat('55', 32), 'hex'));
SELECT preauth_nonce_test.seed_invitation(6, 'unrelated@example.invalid', repeat('66', 32));
SELECT preauth_nonce_test.expect_link_invalid(
  decode(repeat('b6', 32), 'hex'), transaction_timestamp(), transaction_timestamp() + interval '300 seconds',
  'b3000000-0000-0000-0000-000000000006',
  'b4000000-0000-0000-0000-000000000006', decode(repeat('66', 32), 'hex'));

-- An audit failure in delegated acceptance rolls back nonce consumption too.
SELECT preauth_nonce_test.seed_invitation(7, 'rollback@example.invalid', repeat('77', 32));
CREATE FUNCTION preauth_nonce_test.fail_acceptance_audit()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.invitation_id = 'b4000000-0000-0000-0000-000000000007' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INJECTED_AUDIT_FAILURE';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER preauth_nonce_fail_audit
BEFORE INSERT ON authn.authentication_audit
FOR EACH ROW EXECUTE FUNCTION preauth_nonce_test.fail_acceptance_audit();
DO $test$
BEGIN
  PERFORM * FROM authn.consume_preauth_nonce_and_accept_new_email_invitation(
    decode(repeat('b7', 32), 'hex'), transaction_timestamp(), transaction_timestamp() + interval '300 seconds',
    'b1000000-0000-0000-0000-000000000001',
    'b2000000-0000-0000-0000-000000000001',
    'b3000000-0000-0000-0000-000000000007',
    'b4000000-0000-0000-0000-000000000007',
    1::smallint, decode(repeat('77', 32), 'hex'));
  RAISE EXCEPTION 'expected injected failure';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'INJECTED_AUDIT_FAILURE' THEN RAISE; END IF;
END
$test$;
DROP TRIGGER preauth_nonce_fail_audit ON authn.authentication_audit;
SELECT preauth_nonce_test.assert(NOT EXISTS (
  SELECT 1 FROM authn.preauth_nonce_consumptions
   WHERE nonce_digest = decode(repeat('b7', 32), 'hex')
), 'acceptance failure rolls nonce consumption back');
SELECT preauth_nonce_test.assert((
  SELECT status = 'pending' FROM authn.invitation_issuances
   WHERE id = 'b4000000-0000-0000-0000-000000000007'
), 'acceptance failure leaves invitation pending');
SELECT preauth_nonce_test.assert((
  SELECT status = 'invited' AND auth_subject_id IS NULL FROM booking.clients
   WHERE id = 'b3000000-0000-0000-0000-000000000007'
), 'acceptance failure rolls client activation back');

SELECT preauth_nonce_test.assert((
  SELECT client.status = 'active'
         AND client.auth_subject_id = 'b5000000-0000-0000-0000-000000000020'
         AND relationship.status = 'active' AND relationship.version = 1
         AND identity.canonical_email = 'unrelated@example.invalid'
    FROM booking.clients AS client
    JOIN authn.relationship_access AS relationship ON relationship.client_id = client.id
    JOIN authn.email_identities AS identity ON identity.subject_id = client.auth_subject_id
   WHERE client.id = 'b3000000-0000-0000-0000-000000000020'
), 'unrelated identity and relationship remain unchanged');

-- Transaction started before invitation expiry but remained open
-- until after the expiry. Acceptance must fail and roll back.
BEGIN;
SELECT preauth_nonce_test.seed_invitation(
  8, 'wait-expired@example.invalid', repeat('88', 32),
  'pending', transaction_timestamp() - interval '24 hours' + interval '1 second'
);
SELECT pg_sleep(3);
SELECT preauth_nonce_test.expect_link_invalid(
  decode(repeat('b8', 32), 'hex'),
  transaction_timestamp() - interval '1 second',
  transaction_timestamp() + interval '299 seconds',
  'b3000000-0000-0000-0000-000000000008',
  'b4000000-0000-0000-0000-000000000008',
  decode(repeat('88', 32), 'hex')
);
SELECT preauth_nonce_test.assert((
  SELECT status = 'pending'
    FROM authn.invitation_issuances
   WHERE id = 'b4000000-0000-0000-0000-000000000008'
), 'wall-clock expired invitation remains pending');
SELECT preauth_nonce_test.assert(NOT EXISTS (
  SELECT 1 FROM authn.preauth_nonce_consumptions
   WHERE nonce_digest = decode(repeat('b8', 32), 'hex')
), 'wall-clock expiry rolls back nonce consumption');
COMMIT;

-- Fixture and wrapper for the runner's independent 20-connection race.
SELECT preauth_nonce_test.seed_invitation(10, 'race@example.invalid', repeat('10', 32));
CREATE FUNCTION preauth_nonce_test.try_consume(p_attempt integer)
RETURNS text LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM * FROM authn.consume_preauth_nonce_and_accept_new_email_invitation(
    decode(repeat('c0', 32), 'hex'), transaction_timestamp(), transaction_timestamp() + interval '300 seconds',
    'b1000000-0000-0000-0000-000000000001',
    'b2000000-0000-0000-0000-000000000001',
    'b3000000-0000-0000-0000-000000000010',
    'b4000000-0000-0000-0000-000000000010',
    1::smallint, decode(repeat('10', 32), 'hex'));
  RETURN 'ACCEPTED';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  RETURN SQLERRM;
END
$function$;

SELECT preauth_nonce_test.assert(NOT EXISTS (
  SELECT 1
    FROM pg_proc AS proc
    JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace,
         LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS privilege
   WHERE namespace.nspname = 'authn'
     AND proc.proname = 'consume_preauth_nonce_and_accept_new_email_invitation'
     AND privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
), 'PUBLIC cannot execute nonce consumption');
SELECT preauth_nonce_test.assert(NOT EXISTS (
  SELECT 1
    FROM pg_proc AS proc
    JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace,
         LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS privilege
   WHERE namespace.nspname = 'authn'
     AND proc.proname = 'consume_preauth_nonce_and_accept_new_email_invitation'
     AND privilege.grantee <> proc.proowner
), 'nonce command has no non-owner grantee');
SELECT preauth_nonce_test.assert((
  SELECT proc.prosecdef
         AND proc.proconfig @> ARRAY['search_path=pg_catalog, booking, authn']
    FROM pg_proc AS proc
    JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
   WHERE namespace.nspname = 'authn'
     AND proc.proname = 'consume_preauth_nonce_and_accept_new_email_invitation'
), 'nonce command is security definer with fixed path');


-- Cross-tenant race: two independent invitation scopes compete
-- for the SAME globally unique pre-auth nonce digest.
SELECT preauth_nonce_test.seed_invitation(
  11, 'cross-a@example.invalid', repeat('aa', 32)
);

INSERT INTO authn.invitation_issuances(
  id, tenant_id, trainer_id, client_id,
  normalization_version, canonical_email,
  token_digest, pepper_version, status,
  expires_at, created_by, idempotency_key,
  request_hash, created_at
) VALUES (
  'b4000000-0000-0000-0000-000000000099',
  'b1000000-0000-0000-0000-000000000002',
  'b2000000-0000-0000-0000-000000000002',
  'b3000000-0000-0000-0000-000000000099',
  1, 'cross-b@example.invalid',
  decode(repeat('99', 32), 'hex'),
  1, 'pending',
  transaction_timestamp() + interval '24 hours',
  'b2000000-0000-0000-0000-000000000002',
  'preauth-cross-b', repeat('9', 64),
  transaction_timestamp()
);

CREATE TABLE preauth_nonce_test.cross_nonce_clock AS
SELECT clock_timestamp() AS issued_at;

CREATE FUNCTION preauth_nonce_test.try_consume_cross(p_lane integer)
RETURNS text LANGUAGE plpgsql AS $function$
DECLARE
  v_issued timestamptz;
  v_num integer;
  v_tenant uuid;
  v_trainer uuid;
  v_client uuid;
  v_invitation uuid;
  v_digest bytea;
BEGIN
  IF p_lane NOT IN (1, 2) THEN
    RETURN 'INVALID_LANE';
  END IF;

  SELECT issued_at INTO STRICT v_issued
    FROM preauth_nonce_test.cross_nonce_clock;

  v_num := CASE WHEN p_lane = 1 THEN 11 ELSE 99 END;

  v_tenant := (
    'b1000000-0000-0000-0000-' ||
    lpad(p_lane::text, 12, '0')
  )::uuid;

  v_trainer := (
    'b2000000-0000-0000-0000-' ||
    lpad(p_lane::text, 12, '0')
  )::uuid;

  v_client := (
    'b3000000-0000-0000-0000-' ||
    lpad(v_num::text, 12, '0')
  )::uuid;

  v_invitation := (
    'b4000000-0000-0000-0000-' ||
    lpad(v_num::text, 12, '0')
  )::uuid;

  v_digest := decode(
    repeat(CASE WHEN p_lane = 1 THEN 'aa' ELSE '99' END, 32),
    'hex'
  );

  PERFORM * FROM
    authn.consume_preauth_nonce_and_accept_new_email_invitation(
      decode(repeat('d0', 32), 'hex'),
      v_issued,
      v_issued + interval '300 seconds',
      v_tenant, v_trainer, v_client,
      v_invitation, 1::smallint, v_digest
    );

  RETURN 'ACCEPTED';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  RETURN SQLERRM;
END
$function$;

SELECT 'PASS: pre-auth nonce consumption serial checks' AS result;
