\set ON_ERROR_STOP on
BEGIN;

CREATE SCHEMA booking_test;
CREATE FUNCTION booking_test.assert(p_ok boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
  IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'assertion failed: %', p_message; END IF;
END
$function$;

INSERT INTO booking.tenants(id, public_slug) VALUES
  ('10000000-0000-0000-0000-000000000001', 'synthetic-tenant-a'),
  ('10000000-0000-0000-0000-000000000002', 'synthetic-tenant-b');
INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref, phone_verified_at) VALUES
  ('20000000-0000-0000-0000-000000000001', 'trainer', 'synthetic:trainer_a', NULL),
  ('20000000-0000-0000-0000-000000000002', 'trainer', 'synthetic:trainer_b', NULL),
  ('30000000-0000-0000-0000-000000000001', 'client', 'synthetic:client_1', transaction_timestamp()),
  ('30000000-0000-0000-0000-000000000002', 'client', 'synthetic:client_2', transaction_timestamp()),
  ('30000000-0000-0000-0000-000000000003', 'client', 'synthetic:client_3', transaction_timestamp());
INSERT INTO booking.trainer_memberships(tenant_id, trainer_id) VALUES
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002');
INSERT INTO booking.clients(id, tenant_id, trainer_id, auth_subject_id, display_name, status) VALUES
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Synthetic Client 1', 'active'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'Synthetic Client 2', 'active'),
  ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 'Synthetic Client 3', 'active'),
  ('40000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'Synthetic Client 1 B', 'active');
INSERT INTO booking.invitations(
  id, tenant_id, trainer_id, client_id, auth_subject_id, synthetic_phone_ref,
  token_hash, status, expires_at, accepted_at, created_by
) SELECT
  ('50000000-0000-0000-0000-00000000000' || n)::uuid,
  tenant_id, trainer_id, client_id, subject_id, phone_ref,
  repeat(n::text, 32), 'accepted', transaction_timestamp() + interval '7 days',
  transaction_timestamp(), trainer_id
FROM (VALUES
  (1, '10000000-0000-0000-0000-000000000001'::uuid, '20000000-0000-0000-0000-000000000001'::uuid, '40000000-0000-0000-0000-000000000001'::uuid, '30000000-0000-0000-0000-000000000001'::uuid, 'synthetic:client_1'),
  (2, '10000000-0000-0000-0000-000000000001'::uuid, '20000000-0000-0000-0000-000000000001'::uuid, '40000000-0000-0000-0000-000000000002'::uuid, '30000000-0000-0000-0000-000000000002'::uuid, 'synthetic:client_2'),
  (3, '10000000-0000-0000-0000-000000000001'::uuid, '20000000-0000-0000-0000-000000000001'::uuid, '40000000-0000-0000-0000-000000000003'::uuid, '30000000-0000-0000-0000-000000000003'::uuid, 'synthetic:client_3'),
  (4, '10000000-0000-0000-0000-000000000002'::uuid, '20000000-0000-0000-0000-000000000002'::uuid, '40000000-0000-0000-0000-000000000004'::uuid, '30000000-0000-0000-0000-000000000001'::uuid, 'synthetic:client_1')
) AS seed(n, tenant_id, trainer_id, client_id, subject_id, phone_ref);

INSERT INTO booking.availability_slots(id, tenant_id, trainer_id, starts_at, ends_at) VALUES
  ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', transaction_timestamp() + interval '48 hours', transaction_timestamp() + interval '49 hours'),
  ('60000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', transaction_timestamp() + interval '48 hours 30 minutes', transaction_timestamp() + interval '49 hours 30 minutes'),
  ('60000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', transaction_timestamp() + interval '72 hours', transaction_timestamp() + interval '73 hours'),
  ('60000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', transaction_timestamp() + interval '74 hours', transaction_timestamp() + interval '75 hours');

SELECT * FROM booking.book_slot('30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', 'serial-key-0001', repeat('a', 32));
SELECT * FROM booking.book_slot('30000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000001', 'serial-key-0002', repeat('b', 32));
DO $test$
BEGIN
  PERFORM booking.book_slot('30000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000001', 'serial-key-0003', repeat('c', 32));
  RAISE EXCEPTION 'expected SLOT_FULL';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'SLOT_FULL' THEN RAISE; END IF;
END
$test$;
SELECT booking_test.assert((SELECT count(*) = 2 FROM booking.bookings WHERE slot_id = '60000000-0000-0000-0000-000000000001' AND status = 'confirmed'), 'third seat rejected');
SELECT booking_test.assert((SELECT array_agg(seat ORDER BY seat) = ARRAY[1::smallint,2::smallint] FROM booking.bookings WHERE slot_id = '60000000-0000-0000-0000-000000000001' AND status = 'confirmed'), 'seats fixed to 1 and 2');

-- Same key/payload replays; changed payload conflicts.
SELECT booking_test.assert((SELECT replayed FROM booking.book_slot('30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', 'serial-key-0001', repeat('a', 32))), 'idempotent replay');
DO $test$
BEGIN
  PERFORM booking.book_slot('30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', 'serial-key-0001', repeat('z', 32));
  RAISE EXCEPTION 'expected IDEMPOTENCY_CONFLICT';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'IDEMPOTENCY_CONFLICT' THEN RAISE; END IF;
END
$test$;

-- Cross-trainer overlap for the same verified identity is rejected.
DO $test$
BEGIN
  PERFORM booking.book_slot('30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000004', '60000000-0000-0000-0000-000000000002', 'serial-key-0004', repeat('d', 32));
  RAISE EXCEPTION 'expected CLIENT_TIME_CONFLICT';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'CLIENT_TIME_CONFLICT' THEN RAISE; END IF;
END
$test$;

-- Equality at the cutoff is allowed and releases the seat for reuse.
SELECT * FROM booking.cancel_booking_at(
  '30000000-0000-0000-0000-000000000001',
  (SELECT id FROM booking.bookings WHERE idempotency_key = 'serial-key-0001'),
  transaction_timestamp() + interval '24 hours'
);
SELECT * FROM booking.book_slot('30000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000001', 'serial-key-0005', repeat('e', 32));
SELECT booking_test.assert((SELECT count(*) = 2 FROM booking.bookings WHERE slot_id = '60000000-0000-0000-0000-000000000001' AND status = 'confirmed'), 'seat reused after cancellation');

-- One microsecond after the cutoff is late and makes no write.
SELECT * FROM booking.book_slot('30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000003', 'serial-key-0006', repeat('f', 32));
DO $test$
DECLARE v_id uuid := (SELECT id FROM booking.bookings WHERE idempotency_key = 'serial-key-0006');
BEGIN
  PERFORM booking.cancel_booking_at('30000000-0000-0000-0000-000000000001', v_id, transaction_timestamp() + interval '48 hours 1 microsecond');
  RAISE EXCEPTION 'expected CUTOFF_PASSED';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'CUTOFF_PASSED' THEN RAISE; END IF;
END
$test$;
SELECT booking_test.assert((SELECT status = 'confirmed' FROM booking.bookings WHERE idempotency_key = 'serial-key-0006'), 'late cancellation made no write');

-- One microsecond before the cutoff is timely.
SELECT * FROM booking.book_slot('30000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000004', 'serial-key-0007', repeat('h', 32));
SELECT * FROM booking.cancel_booking_at(
  '30000000-0000-0000-0000-000000000002',
  (SELECT id FROM booking.bookings WHERE idempotency_key = 'serial-key-0007'),
  transaction_timestamp() + interval '49 hours 59 minutes 59.999999 seconds'
);
SELECT booking_test.assert((SELECT status = 'cancelled' FROM booking.bookings WHERE idempotency_key = 'serial-key-0007'), 'one microsecond before cutoff allowed');

-- Direct duplicate client/slot and invalid seat writes remain constraint-protected.
DO $test$
BEGIN
  INSERT INTO booking.bookings(id, tenant_id, slot_id, client_id, auth_subject_id, seat, booked_period, idempotency_key, request_hash)
  VALUES ('70000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 2, tstzrange(transaction_timestamp(), transaction_timestamp() + interval '1 hour', '[)'), 'duplicate-client', repeat('i', 32));
  RAISE EXCEPTION 'expected duplicate client/slot rejection';
EXCEPTION WHEN unique_violation THEN NULL;
END
$test$;
DO $test$
BEGIN
  INSERT INTO booking.bookings(id, tenant_id, slot_id, client_id, auth_subject_id, seat, booked_period, idempotency_key, request_hash)
  VALUES ('70000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 3, tstzrange(transaction_timestamp(), transaction_timestamp() + interval '1 hour', '[)'), 'invalid-seat-003', repeat('j', 32));
  RAISE EXCEPTION 'expected invalid seat rejection';
EXCEPTION WHEN check_violation THEN NULL;
END
$test$;
DO $test$
BEGIN
  INSERT INTO booking.bookings(id, tenant_id, slot_id, client_id, auth_subject_id, seat, booked_period, idempotency_key, request_hash)
  VALUES ('70000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 1, tstzrange(transaction_timestamp(), transaction_timestamp() + interval '1 hour', '[)'), 'duplicate-seat-1', repeat('l', 32));
  RAISE EXCEPTION 'expected duplicate seat rejection';
EXCEPTION WHEN unique_violation THEN NULL;
END
$test$;
INSERT INTO booking.bookings(id, tenant_id, slot_id, client_id, auth_subject_id, seat, booked_period, idempotency_key, request_hash)
VALUES ('70000000-0000-0000-0000-000000000013', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 1, tstzrange(transaction_timestamp(), transaction_timestamp() + interval '1 hour', '[)'), 'forged-period-1', repeat('m', 32));
SELECT booking_test.assert((
  SELECT b.booked_period = tstzrange(s.starts_at, s.ends_at, '[)')
    FROM booking.bookings AS b JOIN booking.availability_slots AS s ON s.id = b.slot_id
   WHERE b.id = '70000000-0000-0000-0000-000000000013'
), 'forged period overwritten from slot');

-- Overlapping open slots for one trainer are excluded.
DO $test$
BEGIN
  INSERT INTO booking.availability_slots(id, tenant_id, trainer_id, starts_at, ends_at)
  VALUES ('60000000-0000-0000-0000-000000000099', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', transaction_timestamp() + interval '72 hours 30 minutes', transaction_timestamp() + interval '73 hours 30 minutes');
  RAISE EXCEPTION 'expected open slot overlap rejection';
EXCEPTION WHEN exclusion_violation THEN NULL;
END
$test$;

-- Actor/client mismatch is concealed as FORBIDDEN and creates no booking.
DO $test$
BEGIN
  PERFORM booking.book_slot('30000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000004', 'mismatch-key-1', repeat('k', 32));
  RAISE EXCEPTION 'expected FORBIDDEN';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'FORBIDDEN' THEN RAISE; END IF;
END
$test$;

-- Tenant/identity injection and forged periods are rejected or overwritten authoritatively.
DO $test$
DECLARE v_rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO booking.bookings(id, tenant_id, slot_id, client_id, auth_subject_id, seat, booked_period, idempotency_key, request_hash)
    VALUES ('70000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 1, tstzrange(transaction_timestamp(), transaction_timestamp() + interval '1 hour', '[)'), 'forged-tenant-1', repeat('g', 32));
  EXCEPTION WHEN OTHERS THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'tenant injection was accepted'; END IF;
END
$test$;
SELECT booking_test.assert(NOT EXISTS (
  SELECT 1 FROM pg_namespace AS n, LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) AS x
  WHERE n.nspname = 'booking' AND x.grantee = 0 AND x.privilege_type = 'USAGE'
), 'PUBLIC has no schema usage');
SELECT booking_test.assert(NOT EXISTS (
  SELECT 1 FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace,
    LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) AS x
  WHERE n.nspname = 'booking' AND c.relname = 'bookings' AND x.grantee = 0 AND x.privilege_type = 'INSERT'
), 'PUBLIC has no direct insert');
SELECT booking_test.assert(NOT EXISTS (
  SELECT 1 FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace,
    LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS x
  WHERE n.nspname = 'booking' AND p.proname = 'book_slot' AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'
), 'PUBLIC cannot book');

-- Trainer cannot cancel an occupied slot without explicit confirmation.
DO $test$
BEGIN
  PERFORM booking.cancel_slot('20000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', 1, false, 'synthetic cancellation');
  RAISE EXCEPTION 'expected CONFIRMATION_REQUIRED';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'CONFIRMATION_REQUIRED' THEN RAISE; END IF;
END
$test$;
SELECT booking_test.assert((SELECT status = 'open' FROM booking.availability_slots WHERE id = '60000000-0000-0000-0000-000000000001'), 'unconfirmed trainer cancellation made no write');
DO $test$
BEGIN
  PERFORM booking.cancel_slot('20000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', 1, NULL, 'synthetic cancellation');
  RAISE EXCEPTION 'expected CONFIRMATION_REQUIRED for NULL confirmation';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'CONFIRMATION_REQUIRED' THEN RAISE; END IF;
END
$test$;
SELECT booking_test.assert((SELECT status = 'open' FROM booking.availability_slots WHERE id = '60000000-0000-0000-0000-000000000001'), 'NULL confirmation made no write');

ROLLBACK;
