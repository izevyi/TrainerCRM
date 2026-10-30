\set ON_ERROR_STOP on
CREATE SCHEMA IF NOT EXISTS booking_test;
CREATE OR REPLACE FUNCTION booking_test.try_book(p_subject uuid, p_client uuid, p_key text)
RETURNS text LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM booking.book_slot(p_subject, p_client, '66000000-0000-0000-0000-000000000001', p_key, repeat('c', 32));
  RETURN 'BOOKED';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  RETURN SQLERRM;
END
$function$;

INSERT INTO booking.tenants(id, public_slug)
VALUES ('11000000-0000-0000-0000-000000000001', 'synthetic-concurrency');
INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref)
VALUES ('22000000-0000-0000-0000-000000000001', 'trainer', 'synthetic:concurrency_trainer');
INSERT INTO booking.trainer_memberships(tenant_id, trainer_id)
VALUES ('11000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000001');
INSERT INTO booking.availability_slots(id, tenant_id, trainer_id, starts_at, ends_at)
VALUES ('66000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000001', transaction_timestamp() + interval '7 days', transaction_timestamp() + interval '7 days 1 hour');

WITH seed AS (SELECT n, lpad(to_hex(n), 12, '0') AS suffix FROM generate_series(1, 20) AS n)
INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref, phone_verified_at)
SELECT ('33000000-0000-0000-0000-' || suffix)::uuid, 'client', 'synthetic:concurrent_' || n, transaction_timestamp() FROM seed;
WITH seed AS (SELECT n, lpad(to_hex(n), 12, '0') AS suffix FROM generate_series(1, 20) AS n)
INSERT INTO booking.clients(id, tenant_id, trainer_id, auth_subject_id, display_name, status)
SELECT ('44000000-0000-0000-0000-' || suffix)::uuid, '11000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000001', ('33000000-0000-0000-0000-' || suffix)::uuid, 'Synthetic Concurrent ' || n, 'active' FROM seed;
WITH seed AS (SELECT n, lpad(to_hex(n), 12, '0') AS suffix FROM generate_series(1, 20) AS n)
INSERT INTO booking.invitations(id, tenant_id, trainer_id, client_id, auth_subject_id, synthetic_phone_ref, token_hash, status, expires_at, accepted_at, created_by)
SELECT ('55000000-0000-0000-0000-' || suffix)::uuid, '11000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000001', ('44000000-0000-0000-0000-' || suffix)::uuid, ('33000000-0000-0000-0000-' || suffix)::uuid, 'synthetic:concurrent_' || n, md5('synthetic-token-' || n) || md5('synthetic-token-b-' || n), 'accepted', transaction_timestamp() + interval '7 days', transaction_timestamp(), '22000000-0000-0000-0000-000000000001' FROM seed;
