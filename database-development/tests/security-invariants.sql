\set ON_ERROR_STOP on


CREATE OR REPLACE FUNCTION booking_test.assert(
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


SELECT booking_test.assert(NOT EXISTS (
  SELECT 1 FROM pg_namespace AS n,
       LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) AS x
   WHERE n.nspname = 'booking' AND x.grantee = 0
), 'PUBLIC has no booking schema privileges');
SELECT booking_test.assert(NOT EXISTS (
  SELECT 1 FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace,
       LATERAL aclexplode(coalesce(c.relacl, acldefault(CASE c.relkind WHEN 'S' THEN 'S'::"char" ELSE 'r'::"char" END, c.relowner))) AS x
   WHERE n.nspname = 'booking' AND c.relkind IN ('r', 'p', 'S', 'v', 'm') AND x.grantee = 0
), 'PUBLIC has no direct table, view, or sequence privileges');
SELECT booking_test.assert(NOT EXISTS (
  SELECT 1 FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace,
       LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS x
   WHERE n.nspname = 'booking' AND x.grantee = 0
), 'PUBLIC has no booking function privileges');

DO $test$
BEGIN
  PERFORM booking.book_slot(
    '33000000-0000-0000-0001-000000000002',
    '44000000-0000-0000-0001-000000000003',
    '66000000-0000-0000-0001-000000000003', 'unauthorized-client', repeat('u', 32));
  RAISE EXCEPTION 'expected FORBIDDEN';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'FORBIDDEN' THEN RAISE; END IF;
END
$test$;
DO $test$
BEGIN
  PERFORM booking.book_slot(
    '33000000-0000-0000-0002-000000000001',
    '44000000-0000-0000-0002-000000000002',
    '66000000-0000-0000-0001-000000000003', 'wrong-tenant-slot', repeat('t', 32));
  RAISE EXCEPTION 'expected SLOT_UNAVAILABLE';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'SLOT_UNAVAILABLE' THEN RAISE; END IF;
END
$test$;

-- Owner-level direct SQL is constrained, but owner access is not a runtime authorization model.
DO $test$
BEGIN
  INSERT INTO booking.bookings(id, tenant_id, slot_id, client_id, auth_subject_id, seat, booked_period, idempotency_key, request_hash)
  VALUES ('77000000-0000-0000-0000-000000000001', '12000000-0000-0000-0000-000000000002', '66000000-0000-0000-0001-000000000003', '44000000-0000-0000-0001-000000000016', '33000000-0000-0000-0001-000000000016', 1, tstzrange(now(), now() + interval '1 hour'), 'forged-tenant-direct', repeat('f', 32));
  RAISE EXCEPTION 'expected tenant forgery rejection';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'expected tenant forgery rejection' THEN RAISE; END IF;
END
$test$;
DO $test$
BEGIN
  INSERT INTO booking.bookings(id, tenant_id, slot_id, client_id, auth_subject_id, seat, booked_period, idempotency_key, request_hash)
  VALUES ('77000000-0000-0000-0000-000000000002', '12000000-0000-0000-0000-000000000001', '66000000-0000-0000-0001-000000000003', '44000000-0000-0000-0001-000000000016', '33000000-0000-0000-0001-000000000017', 1, tstzrange(now(), now() + interval '1 hour'), 'forged-client-direct', repeat('g', 32));
  RAISE EXCEPTION 'expected client identity forgery rejection';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'ACTOR_CLIENT_MISMATCH' THEN RAISE; END IF;
END
$test$;
DO $test$
BEGIN
  INSERT INTO booking.bookings(id, tenant_id, slot_id, client_id, auth_subject_id, seat, booked_period, idempotency_key, request_hash)
  VALUES ('77000000-0000-0000-0000-000000000003', '12000000-0000-0000-0000-000000000001', '66000000-0000-0000-0001-000000000003', '44000000-0000-0000-0001-000000000016', '33000000-0000-0000-0001-000000000016', 3, tstzrange(now(), now() + interval '1 hour'), 'forged-seat-direct', repeat('h', 32));
  RAISE EXCEPTION 'expected seat forgery rejection';
EXCEPTION WHEN check_violation THEN NULL;
END
$test$;
INSERT INTO booking.bookings(id, tenant_id, slot_id, client_id, auth_subject_id, seat, booked_period, idempotency_key, request_hash)
VALUES ('77000000-0000-0000-0000-000000000004', '12000000-0000-0000-0000-000000000001', '66000000-0000-0000-0001-000000000003', '44000000-0000-0000-0001-000000000016', '33000000-0000-0000-0001-000000000016', 1, tstzrange(now(), now() + interval '5 minutes'), 'forged-time-direct', repeat('i', 32));
SELECT booking_test.assert((
  SELECT b.booked_period = tstzrange(s.starts_at, s.ends_at, '[)')
    FROM booking.bookings b JOIN booking.availability_slots s ON s.id = b.slot_id
   WHERE b.id = '77000000-0000-0000-0000-000000000004'
), 'direct SQL cannot forge booked time interval');
DELETE FROM booking.bookings WHERE id = '77000000-0000-0000-0000-000000000004';

-- The public cancellation wrapper must use database transaction time. In one
-- transaction, a slot exactly 24 hours away is exactly on the allowed boundary.
BEGIN;
INSERT INTO booking.availability_slots(id, tenant_id, trainer_id, starts_at, ends_at)
VALUES ('66000000-0000-0000-0003-000000000001', '12000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000011', transaction_timestamp() + interval '24 hours', transaction_timestamp() + interval '25 hours');
SELECT * FROM booking.book_slot(
  '33000000-0000-0000-0001-000000000017',
  '44000000-0000-0000-0001-000000000017',
  '66000000-0000-0000-0003-000000000001', 'database-time-cutoff', repeat('j', 32)
);
SELECT * FROM booking.cancel_booking(
  '33000000-0000-0000-0001-000000000017',
  (SELECT id FROM booking.bookings WHERE idempotency_key = 'database-time-cutoff')
);
SELECT * FROM booking.cancel_booking(
  '33000000-0000-0000-0001-000000000017',
  (SELECT id FROM booking.bookings WHERE idempotency_key = 'database-time-cutoff')
);
SELECT booking_test.assert((
  SELECT status = 'cancelled' FROM booking.bookings WHERE idempotency_key = 'database-time-cutoff'
), 'database-time cancellation allows exact 24-hour boundary');
SELECT booking_test.assert((
  SELECT count(*) = 1 FROM booking.booking_events e JOIN booking.bookings b ON b.id = e.booking_id
   WHERE b.idempotency_key = 'database-time-cutoff' AND e.event_type = 'booking.cancelled'
), 'cancellation replay creates no duplicate audit event');
COMMIT;

SELECT booking_test.assert(NOT EXISTS (
  SELECT 1 FROM booking.bookings WHERE status = 'confirmed' AND seat NOT IN (1, 2)
), 'confirmed seats remain exactly 1 or 2');
SELECT booking_test.assert(NOT EXISTS (
  SELECT slot_id FROM booking.bookings WHERE status = 'confirmed' GROUP BY slot_id HAVING count(*) > 2
), 'capacity never exceeds two');
SELECT booking_test.assert(NOT EXISTS (
  SELECT slot_id, client_id FROM booking.bookings WHERE status = 'confirmed' GROUP BY slot_id, client_id HAVING count(*) > 1
), 'one confirmed booking per client and slot');
SELECT booking_test.assert(NOT EXISTS (
  SELECT 1 FROM booking.bookings a JOIN booking.bookings b
    ON a.id < b.id AND a.auth_subject_id = b.auth_subject_id
   AND a.status = 'confirmed' AND b.status = 'confirmed' AND a.booked_period && b.booked_period
), 'no confirmed identity overlap');
SELECT booking_test.assert(NOT EXISTS (
  SELECT b.id FROM booking.bookings b
  LEFT JOIN booking.booking_events e ON e.booking_id = b.id AND e.event_type = 'booking.confirmed'
  GROUP BY b.id HAVING count(e.id) <> 1
), 'every booking has one confirmation audit event');
SELECT booking_test.assert(NOT EXISTS (
  SELECT b.id FROM booking.bookings b
  LEFT JOIN booking.booking_events e ON e.booking_id = b.id AND e.event_type = 'booking.cancelled'
  WHERE b.status = 'cancelled'
  GROUP BY b.id HAVING count(e.id) <> 1
), 'every cancelled booking has one cancellation audit event');

SELECT 'PASS: security negatives and persisted invariants' AS result;
