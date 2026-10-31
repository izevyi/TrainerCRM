\set ON_ERROR_STOP on

CREATE SCHEMA authn_test;

CREATE FUNCTION authn_test.assert(p_ok boolean, p_message text)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'assertion failed: %', p_message;
  END IF;
END
$function$;

SELECT authn_test.assert(to_regprocedure('booking.book_slot(uuid,uuid,uuid,text,text)') IS NOT NULL,
  'existing booking function remains available');
SELECT authn_test.assert(to_regnamespace('authn') IS NOT NULL,
  'authn schema exists');

INSERT INTO booking.tenants(id, public_slug) VALUES
  ('71000000-0000-0000-0000-000000000001', 'auth-foundation-a'),
  ('71000000-0000-0000-0000-000000000002', 'auth-foundation-b');

INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref, phone_verified_at) VALUES
  ('72000000-0000-0000-0000-000000000001', 'trainer', 'synthetic:auth_trainer_a', NULL),
  ('72000000-0000-0000-0000-000000000002', 'trainer', 'synthetic:auth_trainer_b', NULL),
  ('73000000-0000-0000-0000-000000000001', 'client', 'synthetic:auth_client_1', transaction_timestamp()),
  ('73000000-0000-0000-0000-000000000002', 'client', 'synthetic:auth_client_2', transaction_timestamp()),
  ('73000000-0000-0000-0000-000000000003', 'client', 'synthetic:auth_client_3', transaction_timestamp());

INSERT INTO booking.trainer_memberships(tenant_id, trainer_id) VALUES
  ('71000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001'),
  ('71000000-0000-0000-0000-000000000002', '72000000-0000-0000-0000-000000000002');

INSERT INTO booking.clients(id, tenant_id, trainer_id, display_name) VALUES
  ('74000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', 'Synthetic One'),
  ('74000000-0000-0000-0000-000000000002', '71000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', 'Synthetic Two'),
  ('74000000-0000-0000-0000-000000000003', '71000000-0000-0000-0000-000000000002', '72000000-0000-0000-0000-000000000002', 'Synthetic Three'),
  ('74000000-0000-0000-0000-000000000099', '71000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', 'Invitation Race');

-- A pending issuance stores a purpose-bound digest, never a bearer, and does
-- not create a verified identity or relationship as a side effect.
INSERT INTO authn.invitation_issuances(
  id, tenant_id, trainer_id, client_id, normalization_version,
  canonical_email, token_digest, pepper_version, expires_at, created_by,
  idempotency_key, request_hash
) VALUES (
  '75000000-0000-0000-0000-000000000001',
  '71000000-0000-0000-0000-000000000001',
  '72000000-0000-0000-0000-000000000001',
  '74000000-0000-0000-0000-000000000001', 1,
  'client.one@example.invalid', decode(repeat('01', 32), 'hex'), 1,
  transaction_timestamp() + interval '24 hours',
  '72000000-0000-0000-0000-000000000001',
  'invite-client-one', repeat('a', 64)
);
SELECT authn_test.assert((SELECT expires_at = created_at + interval '24 hours'
  FROM authn.invitation_issuances WHERE id = '75000000-0000-0000-0000-000000000001'),
  'invitation lifetime is exactly 24 hours');
SELECT authn_test.assert((SELECT octet_length(token_digest) = 32
  FROM authn.invitation_issuances WHERE id = '75000000-0000-0000-0000-000000000001'),
  'invitation stores a 32-byte digest');
SELECT authn_test.assert((SELECT count(*) = 0 FROM authn.email_identities),
  'pending invitation is not a verified identity');
SELECT authn_test.assert((SELECT count(*) = 0 FROM authn.relationship_access),
  'pending invitation grants no relationship access');

INSERT INTO authn.outbox(
  id, kind, invitation_id, template_id, idempotency_key
) VALUES (
  '76000000-0000-0000-0000-000000000001', 'invitation.delivery',
  '75000000-0000-0000-0000-000000000001', 'client-invitation-v1',
  'delivery-client-one'
);
INSERT INTO authn.authentication_audit(
  event_type, tenant_id, relationship_client_id, actor_subject_id,
  invitation_id, result, correlation_id
) VALUES (
  'invitation.created', '71000000-0000-0000-0000-000000000001',
  '74000000-0000-0000-0000-000000000001',
  '72000000-0000-0000-0000-000000000001',
  '75000000-0000-0000-0000-000000000001', 'succeeded',
  '77000000-0000-0000-0000-000000000001'
);
DO $test$
BEGIN
  INSERT INTO authn.authentication_audit(
    event_type, tenant_id, relationship_client_id, result, correlation_id
  ) VALUES (
    'invitation.created', '71000000-0000-0000-0000-000000000002',
    '74000000-0000-0000-0000-000000000001', 'succeeded',
    '77000000-0000-0000-0000-000000000099'
  );
  RAISE EXCEPTION 'expected audit tenant scope rejection';
EXCEPTION WHEN foreign_key_violation THEN NULL;
END
$test$;

INSERT INTO authn.email_identities(
  id, subject_id, normalization_version, canonical_email, display_email,
  verified_at
) VALUES (
  '78000000-0000-0000-0000-000000000001',
  '73000000-0000-0000-0000-000000000001', 1,
  'client.one@example.invalid', 'client.one@example.invalid',
  transaction_timestamp()
);
UPDATE authn.invitation_issuances
   SET status = 'accepted', accepted_at = expires_at - interval '1 microsecond',
       accepted_identity_id = '78000000-0000-0000-0000-000000000001',
       accepted_subject_id = '73000000-0000-0000-0000-000000000001'
 WHERE id = '75000000-0000-0000-0000-000000000001';
INSERT INTO authn.relationship_access(
  client_id, tenant_id, trainer_id, subject_id, activated_at
) VALUES (
  '74000000-0000-0000-0000-000000000001',
  '71000000-0000-0000-0000-000000000001',
  '72000000-0000-0000-0000-000000000001',
  '73000000-0000-0000-0000-000000000001', transaction_timestamp()
);
SELECT authn_test.assert((SELECT status = 'accepted'
  FROM authn.invitation_issuances WHERE id = '75000000-0000-0000-0000-000000000001'),
  'acceptance one microsecond before expiry is valid');

-- Cross-tenant relationship injection is rejected by the composite FK.
DO $test$
BEGIN
  INSERT INTO authn.relationship_access(
    client_id, tenant_id, trainer_id, subject_id, activated_at
  ) VALUES (
    '74000000-0000-0000-0000-000000000002',
    '71000000-0000-0000-0000-000000000002',
    '72000000-0000-0000-0000-000000000002',
    '73000000-0000-0000-0000-000000000001', transaction_timestamp()
  );
  RAISE EXCEPTION 'expected cross-tenant relationship rejection';
EXCEPTION
  WHEN foreign_key_violation THEN NULL;
  WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'RELATIONSHIP_IDENTITY_INVALID' THEN
      RAISE;
    END IF;
END
$test$;

-- Invalid digest length and an expiry other than exactly 24 hours are refused.
DO $test$
BEGIN
  INSERT INTO authn.invitation_issuances(
    id, tenant_id, trainer_id, client_id, normalization_version,
    canonical_email, token_digest, pepper_version, expires_at, created_by,
    idempotency_key, request_hash
  ) VALUES (
    '75000000-0000-0000-0000-000000000010',
    '71000000-0000-0000-0000-000000000001',
    '72000000-0000-0000-0000-000000000001',
    '74000000-0000-0000-0000-000000000002', 1,
    'invalid@example.invalid', decode('01', 'hex'), 1,
    transaction_timestamp() + interval '24 hours',
    '72000000-0000-0000-0000-000000000001',
    'invalid-digest-01', repeat('b', 64)
  );
  RAISE EXCEPTION 'expected digest length rejection';
EXCEPTION WHEN check_violation THEN NULL;
END
$test$;
DO $test$
BEGIN
  INSERT INTO authn.invitation_issuances(
    id, tenant_id, trainer_id, client_id, normalization_version,
    canonical_email, token_digest, pepper_version, expires_at, created_by,
    idempotency_key, request_hash
  ) VALUES (
    '75000000-0000-0000-0000-000000000011',
    '71000000-0000-0000-0000-000000000001',
    '72000000-0000-0000-0000-000000000001',
    '74000000-0000-0000-0000-000000000002', 1,
    'wrong.expiry@example.invalid', decode(repeat('02', 32), 'hex'), 1,
    transaction_timestamp() + interval '23 hours',
    '72000000-0000-0000-0000-000000000001',
    'invalid-expiry-01', repeat('c', 64)
  );
  RAISE EXCEPTION 'expected fixed expiry rejection';
EXCEPTION WHEN check_violation THEN NULL;
END
$test$;

-- Expiry equality is invalid and leaves the pending row unchanged.
INSERT INTO authn.invitation_issuances(
  id, tenant_id, trainer_id, client_id, normalization_version,
  canonical_email, token_digest, pepper_version, expires_at, created_by,
  idempotency_key, request_hash
) VALUES (
  '75000000-0000-0000-0000-000000000002',
  '71000000-0000-0000-0000-000000000001',
  '72000000-0000-0000-0000-000000000001',
  '74000000-0000-0000-0000-000000000002', 1,
  'client.two@example.invalid', decode(repeat('03', 32), 'hex'), 1,
  transaction_timestamp() + interval '24 hours',
  '72000000-0000-0000-0000-000000000001',
  'invite-client-two', repeat('d', 64)
);
INSERT INTO authn.email_identities(
  id, subject_id, normalization_version, canonical_email, display_email,
  verified_at
) VALUES (
  '78000000-0000-0000-0000-000000000002',
  '73000000-0000-0000-0000-000000000002', 1,
  'client.two@example.invalid', 'client.two@example.invalid',
  transaction_timestamp()
);
DO $test$
BEGIN
  UPDATE authn.invitation_issuances
     SET status = 'accepted', accepted_at = expires_at,
         accepted_identity_id = '78000000-0000-0000-0000-000000000002',
         accepted_subject_id = '73000000-0000-0000-0000-000000000002'
   WHERE id = '75000000-0000-0000-0000-000000000002';
  RAISE EXCEPTION 'expected expiry equality rejection';
EXCEPTION WHEN check_violation THEN NULL;
END
$test$;
SELECT authn_test.assert((SELECT status = 'pending'
  FROM authn.invitation_issuances WHERE id = '75000000-0000-0000-0000-000000000002'),
  'failed equality acceptance leaves invitation pending');

-- Terminal state and immutable scope cannot be rewound or rewritten.
DO $test$
BEGIN
  UPDATE authn.invitation_issuances SET status = 'pending', accepted_at = NULL,
    accepted_identity_id = NULL, accepted_subject_id = NULL
  WHERE id = '75000000-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'expected terminal transition rejection';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'INVITATION_INVALID_TRANSITION' THEN RAISE; END IF;
END
$test$;
DO $test$
BEGIN
  UPDATE authn.invitation_issuances
     SET canonical_email = 'changed@example.invalid'
   WHERE id = '75000000-0000-0000-0000-000000000002';
  RAISE EXCEPTION 'expected immutable invitation rejection';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'INVITATION_IMMUTABLE_FIELDS' THEN RAISE; END IF;
END
$test$;

-- Relationship state changes require an exact version increment.
DO $test$
BEGIN
  UPDATE authn.relationship_access
     SET status = 'revoked', revoked_at = transaction_timestamp(),
         revoke_reason = 'synthetic test'
   WHERE client_id = '74000000-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'expected relationship version rejection';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'RELATIONSHIP_VERSION_INVALID' THEN RAISE; END IF;
END
$test$;
SELECT authn_test.assert((SELECT status = 'active' AND version = 1
  FROM authn.relationship_access WHERE client_id = '74000000-0000-0000-0000-000000000001'),
  'stale relationship transition made no change');

-- Audit rows are append-only for UPDATE, DELETE, and TRUNCATE.
DO $test$
BEGIN
  UPDATE authn.authentication_audit SET result = 'rejected';
  RAISE EXCEPTION 'expected audit update rejection';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'AUTHENTICATION_AUDIT_APPEND_ONLY' THEN RAISE; END IF;
END
$test$;
DO $test$
BEGIN
  DELETE FROM authn.authentication_audit;
  RAISE EXCEPTION 'expected audit delete rejection';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'AUTHENTICATION_AUDIT_APPEND_ONLY' THEN RAISE; END IF;
END
$test$;
DO $test$
BEGIN
  TRUNCATE authn.authentication_audit;
  RAISE EXCEPTION 'expected audit truncate rejection';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'AUTHENTICATION_AUDIT_APPEND_ONLY' THEN RAISE; END IF;
END
$test$;

-- No ordinary authn column provides a raw bearer/token/cookie/CSRF/body slot.
SELECT authn_test.assert(NOT EXISTS (
  SELECT 1
    FROM information_schema.columns
   WHERE table_schema = 'authn'
     AND column_name ~ '(raw_token|bearer|cookie|csrf|request_body|payload)'
), 'authn schema has no raw secret/body storage column');
SELECT authn_test.assert(position('phone_verified_at' in pg_get_functiondef(
  'authn.validate_email_identity_subject()'::regprocedure)) = 0,
  'legacy phone verification is not email proof');

-- PUBLIC receives no authn schema/object/function access.
SELECT authn_test.assert(NOT EXISTS (
  SELECT 1 FROM pg_namespace AS n,
       LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) AS x
   WHERE n.nspname = 'authn' AND x.grantee = 0
), 'PUBLIC has no authn schema privilege');
SELECT authn_test.assert(NOT EXISTS (
  SELECT 1 FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace,
       LATERAL aclexplode(coalesce(c.relacl,
         acldefault(CASE c.relkind WHEN 'S' THEN 'S'::"char" ELSE 'r'::"char" END, c.relowner))) AS x
   WHERE n.nspname = 'authn' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
     AND x.grantee = 0
), 'PUBLIC has no authn table, view, or sequence privilege');
SELECT authn_test.assert(NOT EXISTS (
  SELECT 1 FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace,
       LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS x
   WHERE n.nspname = 'authn' AND x.grantee = 0
), 'PUBLIC has no authn function execute privilege');

-- Seed independent client subjects for the identity race.
INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref, phone_verified_at)
SELECT md5('identity-race-' || n::text)::uuid, 'client'::booking.subject_role,
       'synthetic:identity_race_' || n::text, transaction_timestamp()
  FROM generate_series(1, 12) AS n;

CREATE FUNCTION authn_test.try_identity(p_n integer)
RETURNS text
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO authn.email_identities(
    id, subject_id, normalization_version, canonical_email, display_email,
    verified_at
  ) VALUES (
    md5('identity-row-' || p_n::text)::uuid,
    md5('identity-race-' || p_n::text)::uuid,
    1, 'canonical.race@example.invalid',
    CASE WHEN p_n % 2 = 0 THEN 'Canonical.Race@example.invalid'
         ELSE 'canonical.race@example.invalid' END,
    transaction_timestamp()
  );
  RETURN 'WON';
EXCEPTION WHEN unique_violation THEN
  RETURN 'CONFLICT';
END
$function$;

CREATE FUNCTION authn_test.try_invitation(p_n integer)
RETURNS text
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO authn.invitation_issuances(
    id, tenant_id, trainer_id, client_id, normalization_version,
    canonical_email, token_digest, pepper_version, expires_at, created_by,
    idempotency_key, request_hash
  ) VALUES (
    md5('invitation-row-' || p_n::text)::uuid,
    '71000000-0000-0000-0000-000000000001',
    '72000000-0000-0000-0000-000000000001',
    '74000000-0000-0000-0000-000000000099', 1,
    'invitation.race@example.invalid',
    decode(lpad(to_hex(p_n), 64, '0'), 'hex'), 1,
    transaction_timestamp() + interval '24 hours',
    '72000000-0000-0000-0000-000000000001',
    'invitation-race-' || lpad(p_n::text, 3, '0'), repeat('e', 64)
  );
  RETURN 'WON';
EXCEPTION WHEN unique_violation THEN
  RETURN 'CONFLICT';
END
$function$;

SELECT 'PASS: auth foundation serial checks' AS result;
