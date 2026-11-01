\set ON_ERROR_STOP on

CREATE SCHEMA email_subject_compatibility_test;

CREATE FUNCTION email_subject_compatibility_test.assert(
  p_ok boolean,
  p_message text
)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'assertion failed: %', p_message;
  END IF;
END
$function$;

-- The compatibility migration changes only synthetic_phone_ref nullability.
SELECT email_subject_compatibility_test.assert((
  SELECT is_nullable = 'YES'
    FROM information_schema.columns
   WHERE table_schema = 'booking'
     AND table_name = 'auth_subjects'
     AND column_name = 'synthetic_phone_ref'
), 'synthetic_phone_ref is nullable');

SELECT email_subject_compatibility_test.assert((
  SELECT is_nullable = 'YES'
    FROM information_schema.columns
   WHERE table_schema = 'booking'
     AND table_name = 'auth_subjects'
     AND column_name = 'phone_verified_at'
), 'phone_verified_at remains nullable');

-- An initial email-only client subject needs no fake phone data and no email
-- identity. Verification and relationship activation are separate later flows.
INSERT INTO booking.auth_subjects(id, role)
VALUES ('91000000-0000-0000-0000-000000000001', 'client');

INSERT INTO booking.auth_subjects(id, role)
VALUES ('91000000-0000-0000-0000-000000000002', 'client');

SELECT email_subject_compatibility_test.assert((
  SELECT synthetic_phone_ref IS NULL AND phone_verified_at IS NULL
    FROM booking.auth_subjects
   WHERE id = '91000000-0000-0000-0000-000000000001'
), 'email-only client stores neither synthetic phone field');

SELECT email_subject_compatibility_test.assert((
  SELECT count(*) = 2
    FROM booking.auth_subjects
   WHERE id IN (
     '91000000-0000-0000-0000-000000000001',
     '91000000-0000-0000-0000-000000000002'
   ) AND synthetic_phone_ref IS NULL AND phone_verified_at IS NULL
), 'multiple email-only subjects do not need fabricated unique references');

SELECT email_subject_compatibility_test.assert(
  NOT EXISTS (
    SELECT 1 FROM authn.email_identities
     WHERE subject_id = '91000000-0000-0000-0000-000000000001'
  ) AND NOT EXISTS (
    SELECT 1 FROM authn.relationship_access
     WHERE subject_id = '91000000-0000-0000-0000-000000000001'
  ),
  'initial subject insert creates no identity or relationship proof'
);

-- Half-populated client states and a trainer without its legacy reference are
-- invalid. A trainer remains valid without phone_verified_at, as before.
DO $test$
BEGIN
  BEGIN
    INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref)
    VALUES ('91000000-0000-0000-0000-000000000003', 'client', 'synthetic:half_ref');
    RAISE EXCEPTION 'expected half-populated client rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO booking.auth_subjects(id, role, phone_verified_at)
    VALUES ('91000000-0000-0000-0000-000000000004', 'client', transaction_timestamp());
    RAISE EXCEPTION 'expected verified-only client rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO booking.auth_subjects(id, role)
    VALUES ('91000000-0000-0000-0000-000000000005', 'trainer');
    RAISE EXCEPTION 'expected trainer reference rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref)
    VALUES ('91000000-0000-0000-0000-000000000006', 'client', 'not-a-synthetic-ref');
    RAISE EXCEPTION 'expected malformed reference rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$test$;

INSERT INTO booking.tenants(id, public_slug)
VALUES ('92000000-0000-0000-0000-000000000001', 'email-compatibility-test');

INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref)
VALUES (
  '93000000-0000-0000-0000-000000000001',
  'trainer',
  'synthetic:compatibility_trainer'
);

INSERT INTO booking.trainer_memberships(tenant_id, trainer_id)
VALUES (
  '92000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001'
);

-- Trainer/client role triggers remain authoritative.
DO $test$
BEGIN
  BEGIN
    INSERT INTO booking.trainer_memberships(tenant_id, trainer_id)
    VALUES (
      '92000000-0000-0000-0000-000000000001',
      '91000000-0000-0000-0000-000000000001'
    );
    RAISE EXCEPTION 'expected client trainer-membership rejection';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'TRAINER_IDENTITY_ROLE_INVALID' THEN RAISE; END IF;
  END;
END
$test$;

-- A client record, pending email invitation, verified email identity, and even
-- relationship_access remain insufficient for the unchanged legacy booking
-- command, which requires phone verification and a legacy accepted invite.
INSERT INTO booking.clients(
  id, tenant_id, trainer_id, auth_subject_id, display_name, status
) VALUES (
  '94000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000001',
  'Email Only Client',
  'active'
);

INSERT INTO authn.invitation_issuances(
  id, tenant_id, trainer_id, client_id, normalization_version,
  canonical_email, token_digest, pepper_version, expires_at, created_by,
  idempotency_key, request_hash, created_at
) VALUES (
  '95000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  '94000000-0000-0000-0000-000000000001',
  1, 'email.only@example.invalid', decode(repeat('ab', 32), 'hex'), 1,
  transaction_timestamp() + interval '24 hours',
  '93000000-0000-0000-0000-000000000001',
  'email-only-pending-001', repeat('a', 64), transaction_timestamp()
);

DO $test$
BEGIN
  BEGIN
    INSERT INTO authn.email_identities(
      id, subject_id, normalization_version, canonical_email,
      display_email, verified_at
    ) VALUES (
      '96000000-0000-0000-0000-000000000099',
      '91000000-0000-0000-0000-000000000002',
      1, 'unverified@example.invalid', 'unverified@example.invalid', NULL
    );
    RAISE EXCEPTION 'expected unverified identity rejection';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
END
$test$;

INSERT INTO authn.email_identities(
  id, subject_id, normalization_version, canonical_email,
  display_email, verified_at
) VALUES (
  '96000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000001',
  1, 'email.only@example.invalid', 'email.only@example.invalid',
  transaction_timestamp()
);

INSERT INTO authn.relationship_access(
  client_id, tenant_id, trainer_id, subject_id, activated_at
) VALUES (
  '94000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000001',
  transaction_timestamp()
);

INSERT INTO booking.availability_slots(
  id, tenant_id, trainer_id, starts_at, ends_at
) VALUES (
  '97000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  transaction_timestamp() + interval '7 days',
  transaction_timestamp() + interval '7 days 1 hour'
);

DO $test$
BEGIN
  BEGIN
    PERFORM booking.book_slot(
      '91000000-0000-0000-0000-000000000001',
      '94000000-0000-0000-0000-000000000001',
      '97000000-0000-0000-0000-000000000001',
      'email-only-booking', repeat('b', 32)
    );
    RAISE EXCEPTION 'expected email-only booking rejection';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'FORBIDDEN' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO booking.bookings(
      id, tenant_id, slot_id, client_id, auth_subject_id, seat,
      booked_period, idempotency_key, request_hash
    ) VALUES (
      '98000000-0000-0000-0000-000000000001',
      '92000000-0000-0000-0000-000000000001',
      '97000000-0000-0000-0000-000000000001',
      '94000000-0000-0000-0000-000000000001',
      '91000000-0000-0000-0000-000000000001', 1,
      tstzrange(transaction_timestamp(), transaction_timestamp() + interval '1 hour', '[)'),
      'email-only-direct', repeat('c', 32)
    );
    RAISE EXCEPTION 'expected direct email-only booking rejection';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'INVITE_INVALID' THEN RAISE; END IF;
  END;
END
$test$;

SELECT email_subject_compatibility_test.assert(
  NOT EXISTS (
    SELECT 1 FROM booking.bookings
     WHERE auth_subject_id = '91000000-0000-0000-0000-000000000001'
  ) AND NOT EXISTS (
    SELECT 1 FROM booking.booking_events
     WHERE actor_subject_id = '91000000-0000-0000-0000-000000000001'
  ),
  'email-only authorization failures make no booking or event write'
);

-- Legacy phone-backed subjects and booking authorization still work.
INSERT INTO booking.auth_subjects(
  id, role, synthetic_phone_ref, phone_verified_at
) VALUES (
  '91000000-0000-0000-0000-000000000010',
  'client', 'synthetic:legacy_compat_client', transaction_timestamp()
);

INSERT INTO booking.clients(
  id, tenant_id, trainer_id, auth_subject_id, display_name, status
) VALUES (
  '94000000-0000-0000-0000-000000000010',
  '92000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000010',
  'Legacy Phone Client', 'active'
);

INSERT INTO booking.invitations(
  id, tenant_id, trainer_id, client_id, auth_subject_id,
  synthetic_phone_ref, token_hash, status, expires_at, accepted_at, created_by
) VALUES (
  '99000000-0000-0000-0000-000000000010',
  '92000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  '94000000-0000-0000-0000-000000000010',
  '91000000-0000-0000-0000-000000000010',
  'synthetic:legacy_compat_client', repeat('d', 64), 'accepted',
  transaction_timestamp() + interval '7 days', transaction_timestamp(),
  '93000000-0000-0000-0000-000000000001'
);

SELECT * FROM booking.book_slot(
  '91000000-0000-0000-0000-000000000010',
  '94000000-0000-0000-0000-000000000010',
  '97000000-0000-0000-0000-000000000001',
  'legacy-compatible', repeat('e', 32)
);

SELECT email_subject_compatibility_test.assert((
  SELECT count(*) = 1
    FROM booking.bookings
   WHERE client_id = '94000000-0000-0000-0000-000000000010'
     AND status = 'confirmed'
), 'legacy phone-backed booking remains authorized');

SELECT email_subject_compatibility_test.assert((
  SELECT count(*) = 1
    FROM booking.booking_events AS event
    JOIN booking.bookings AS booking ON booking.id = event.booking_id
   WHERE booking.client_id = '94000000-0000-0000-0000-000000000010'
     AND event.event_type = 'booking.confirmed'
), 'legacy booking audit remains atomic');

-- No new PUBLIC access is introduced by the compatibility migration.
SELECT email_subject_compatibility_test.assert(NOT EXISTS (
  SELECT 1
    FROM pg_namespace AS namespace,
         LATERAL aclexplode(coalesce(
           namespace.nspacl,
           acldefault('n', namespace.nspowner)
         )) AS privilege
   WHERE namespace.nspname IN ('booking', 'authn')
     AND privilege.grantee = 0
), 'PUBLIC has no booking or authn schema privileges');

SELECT email_subject_compatibility_test.assert(NOT EXISTS (
  SELECT 1
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace,
         LATERAL aclexplode(coalesce(
           procedure.proacl,
           acldefault('f', procedure.proowner)
         )) AS privilege
   WHERE namespace.nspname IN ('booking', 'authn')
     AND privilege.grantee = 0
), 'PUBLIC has no booking or authn function privileges');

SELECT 'PASS: email subject compatibility' AS result;
