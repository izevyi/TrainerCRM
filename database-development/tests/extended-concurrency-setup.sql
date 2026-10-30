\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION booking_test.try_book_any(
  p_subject uuid, p_client uuid, p_slot uuid, p_key text, p_hash text
) RETURNS text LANGUAGE plpgsql AS $function$
DECLARE v_replayed boolean;
BEGIN
  SELECT replayed INTO v_replayed
    FROM booking.book_slot(p_subject, p_client, p_slot, p_key, p_hash);
  IF v_replayed THEN RETURN 'REPLAYED'; END IF;
  RETURN 'BOOKED';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  RETURN SQLERRM;
END
$function$;

INSERT INTO booking.tenants(id, public_slug) VALUES
  ('12000000-0000-0000-0000-000000000001', 'synthetic-races-a'),
  ('12000000-0000-0000-0000-000000000002', 'synthetic-races-b');
INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref) VALUES
  ('22000000-0000-0000-0000-000000000011', 'trainer', 'synthetic:races_trainer_a'),
  ('22000000-0000-0000-0000-000000000012', 'trainer', 'synthetic:races_trainer_b');
INSERT INTO booking.trainer_memberships(tenant_id, trainer_id) VALUES
  ('12000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000011'),
  ('12000000-0000-0000-0000-000000000002', '22000000-0000-0000-0000-000000000012');

WITH seed AS (SELECT n, lpad(n::text, 12, '0') AS suffix FROM generate_series(1, 20) AS n)
INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref, phone_verified_at)
SELECT ('33000000-0000-0000-0001-' || suffix)::uuid, 'client',
       'synthetic:race_client_' || n, transaction_timestamp()
  FROM seed;
WITH seed AS (SELECT n, lpad(n::text, 12, '0') AS suffix FROM generate_series(1, 20) AS n)
INSERT INTO booking.clients(id, tenant_id, trainer_id, auth_subject_id, display_name, status)
SELECT ('44000000-0000-0000-0001-' || suffix)::uuid,
       '12000000-0000-0000-0000-000000000001',
       '22000000-0000-0000-0000-000000000011',
       ('33000000-0000-0000-0001-' || suffix)::uuid,
       'Synthetic Race Client ' || n, 'active'
  FROM seed;
WITH seed AS (SELECT n, lpad(n::text, 12, '0') AS suffix FROM generate_series(1, 20) AS n)
INSERT INTO booking.invitations(
  id, tenant_id, trainer_id, client_id, auth_subject_id, synthetic_phone_ref,
  token_hash, status, expires_at, accepted_at, created_by
)
SELECT ('55000000-0000-0000-0001-' || suffix)::uuid,
       '12000000-0000-0000-0000-000000000001',
       '22000000-0000-0000-0000-000000000011',
       ('44000000-0000-0000-0001-' || suffix)::uuid,
       ('33000000-0000-0000-0001-' || suffix)::uuid,
       'synthetic:race_client_' || n,
       md5('race-token-a-' || n) || md5('race-token-b-' || n),
       'accepted', transaction_timestamp() + interval '30 days', transaction_timestamp(),
       '22000000-0000-0000-0000-000000000011'
  FROM seed;

INSERT INTO booking.availability_slots(id, tenant_id, trainer_id, starts_at, ends_at) VALUES
  ('66000000-0000-0000-0001-000000000001', '12000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000011', transaction_timestamp() + interval '10 days', transaction_timestamp() + interval '10 days 1 hour'),
  ('66000000-0000-0000-0001-000000000002', '12000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000011', transaction_timestamp() + interval '11 days', transaction_timestamp() + interval '11 days 1 hour'),
  ('66000000-0000-0000-0001-000000000003', '12000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000011', transaction_timestamp() + interval '12 days', transaction_timestamp() + interval '12 days 1 hour'),
  ('66000000-0000-0000-0001-000000000004', '12000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000011', transaction_timestamp() + interval '14 days', transaction_timestamp() + interval '14 days 1 hour');

-- The final-seat race starts with exactly one confirmed booking.
SELECT * FROM booking.book_slot(
  '33000000-0000-0000-0001-000000000001',
  '44000000-0000-0000-0001-000000000001',
  '66000000-0000-0000-0001-000000000001', 'final-seat-seed', repeat('1', 32)
);

-- One verified identity represented by clients in two tenants/trainers.
INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref, phone_verified_at)
VALUES ('33000000-0000-0000-0002-000000000001', 'client', 'synthetic:overlap_identity', transaction_timestamp());
INSERT INTO booking.clients(id, tenant_id, trainer_id, auth_subject_id, display_name, status) VALUES
  ('44000000-0000-0000-0002-000000000001', '12000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000011', '33000000-0000-0000-0002-000000000001', 'Synthetic Overlap A', 'active'),
  ('44000000-0000-0000-0002-000000000002', '12000000-0000-0000-0000-000000000002', '22000000-0000-0000-0000-000000000012', '33000000-0000-0000-0002-000000000001', 'Synthetic Overlap B', 'active');
INSERT INTO booking.invitations(id, tenant_id, trainer_id, client_id, auth_subject_id, synthetic_phone_ref, token_hash, status, expires_at, accepted_at, created_by) VALUES
  ('55000000-0000-0000-0002-000000000001', '12000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000011', '44000000-0000-0000-0002-000000000001', '33000000-0000-0000-0002-000000000001', 'synthetic:overlap_identity', repeat('a', 64), 'accepted', transaction_timestamp() + interval '30 days', transaction_timestamp(), '22000000-0000-0000-0000-000000000011'),
  ('55000000-0000-0000-0002-000000000002', '12000000-0000-0000-0000-000000000002', '22000000-0000-0000-0000-000000000012', '44000000-0000-0000-0002-000000000002', '33000000-0000-0000-0002-000000000001', 'synthetic:overlap_identity', repeat('b', 64), 'accepted', transaction_timestamp() + interval '30 days', transaction_timestamp(), '22000000-0000-0000-0000-000000000012');
INSERT INTO booking.availability_slots(id, tenant_id, trainer_id, starts_at, ends_at) VALUES
  ('66000000-0000-0000-0002-000000000001', '12000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000011', transaction_timestamp() + interval '13 days', transaction_timestamp() + interval '13 days 1 hour'),
  ('66000000-0000-0000-0002-000000000002', '12000000-0000-0000-0000-000000000002', '22000000-0000-0000-0000-000000000012', transaction_timestamp() + interval '13 days 30 minutes', transaction_timestamp() + interval '13 days 1 hour 30 minutes'),
  ('66000000-0000-0000-0002-000000000003', '12000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000011', transaction_timestamp() + interval '15 days', transaction_timestamp() + interval '15 days 1 hour'),
  ('66000000-0000-0000-0002-000000000004', '12000000-0000-0000-0000-000000000002', '22000000-0000-0000-0000-000000000012', transaction_timestamp() + interval '15 days 1 hour', transaction_timestamp() + interval '15 days 2 hours');

-- Cancellation fixture starts full; client 15 will compete for the released seat.
SELECT * FROM booking.book_slot('33000000-0000-0000-0001-000000000013', '44000000-0000-0000-0001-000000000013', '66000000-0000-0000-0001-000000000004', 'cancel-seed-0013', repeat('d', 32));
SELECT * FROM booking.book_slot('33000000-0000-0000-0001-000000000014', '44000000-0000-0000-0001-000000000014', '66000000-0000-0000-0001-000000000004', 'cancel-seed-0014', repeat('e', 32));
