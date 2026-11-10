\set ON_ERROR_STOP on

INSERT INTO booking.tenants (id, public_slug) VALUES
  ('11000000-0000-4000-8000-000000000001', 'trainer-one'),
  ('11000000-0000-4000-8000-000000000002', 'trainer-two');
INSERT INTO booking.auth_subjects (id, role, synthetic_phone_ref) VALUES
  ('12000000-0000-4000-8000-000000000001', 'trainer', 'synthetic:trainer_one'),
  ('12000000-0000-4000-8000-000000000002', 'trainer', 'synthetic:trainer_two');
INSERT INTO booking.trainer_memberships (tenant_id, trainer_id) VALUES
  ('11000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001'),
  ('11000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-000000000002');
INSERT INTO authn.email_identities (
  id, subject_id, normalization_version, canonical_email, display_email, verified_at
) VALUES
  ('13000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', 1, 'one@example.invalid', 'one@example.invalid', transaction_timestamp()),
  ('13000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-000000000002', 1, 'two@example.invalid', 'two@example.invalid', transaction_timestamp());
INSERT INTO authn.trainer_password_credentials (
  trainer_subject_id, email_identity_id, password_hash
) VALUES
  ('12000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000001', '$scrypt$fixture-password-hash-value-0001'),
  ('12000000-0000-4000-8000-000000000002', '13000000-0000-4000-8000-000000000002', '$scrypt$fixture-password-hash-value-0002');
INSERT INTO authn.trainer_sessions (
  id, trainer_subject_id, token_sha256_digest, idle_expires_at, absolute_expires_at
) VALUES
  ('14000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', decode(repeat('11', 32), 'hex'), transaction_timestamp() + interval '1 day', transaction_timestamp() + interval '2 days'),
  ('14000000-0000-4000-8000-000000000002', '12000000-0000-4000-8000-000000000002', decode(repeat('22', 32), 'hex'), transaction_timestamp() + interval '1 day', transaction_timestamp() + interval '2 days'),
  ('14000000-0000-4000-8000-000000000003', '12000000-0000-4000-8000-000000000001', decode(repeat('33', 32), 'hex'), transaction_timestamp() + interval '1 day', transaction_timestamp() + interval '2 days'),
  ('14000000-0000-4000-8000-000000000004', '12000000-0000-4000-8000-000000000001', decode(repeat('44', 32), 'hex'), transaction_timestamp() + interval '1 second', transaction_timestamp() + interval '2 days');
UPDATE authn.trainer_sessions
   SET revoked_at = transaction_timestamp(), revoke_reason = 'test'
 WHERE id = '14000000-0000-4000-8000-000000000003';
UPDATE authn.trainer_sessions
   SET created_at = transaction_timestamp() - interval '2 days',
       last_seen_at = transaction_timestamp() - interval '2 days',
       idle_expires_at = transaction_timestamp() - interval '1 day'
 WHERE id = '14000000-0000-4000-8000-000000000004';

DO $security$
DECLARE
  v_execute_count integer;
BEGIN
  IF (SELECT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR
             rolinherit OR rolreplication OR rolbypassrls
        FROM pg_roles
       WHERE rolname = 'trainercrm_clients_function_owner') THEN
    RAISE EXCEPTION 'function owner has unsafe role attributes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members
     WHERE member = (SELECT oid FROM pg_roles
                      WHERE rolname = 'trainercrm_clients_function_owner')
  ) THEN
    RAISE EXCEPTION 'function owner inherits another role';
  END IF;
  IF (SELECT proowner <> (SELECT oid FROM pg_roles
                           WHERE rolname = 'trainercrm_clients_function_owner')
        FROM pg_proc
       WHERE oid = 'booking.list_trainer_clients(bytea)'::regprocedure) OR
     (SELECT proowner <> (SELECT oid FROM pg_roles
                           WHERE rolname = 'trainercrm_clients_function_owner')
        FROM pg_proc
       WHERE oid = 'booking.create_trainer_client(bytea,text,numeric)'::regprocedure) THEN
    RAISE EXCEPTION 'unexpected client function owner';
  END IF;
  IF has_function_privilege('public', 'booking.list_trainer_clients(bytea)', 'EXECUTE') OR
     has_function_privilege('public', 'booking.create_trainer_client(bytea,text,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can execute client runtime functions';
  END IF;
  IF has_schema_privilege(
    'trainercrm_clients_function_owner', 'booking', 'CREATE'
  ) THEN
    RAISE EXCEPTION 'function owner retained schema CREATE';
  END IF;
  IF NOT has_table_privilege('trainercrm_clients_function_owner', 'booking.clients', 'SELECT,INSERT') OR
     NOT has_table_privilege('trainercrm_clients_function_owner', 'authn.trainer_sessions', 'SELECT') OR
     has_table_privilege('trainercrm_clients_function_owner', 'booking.clients', 'UPDATE,DELETE') OR
     has_table_privilege('trainercrm_clients_function_owner', 'authn.trainer_sessions', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'function owner table privileges are not least privilege';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class AS object
    JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
    WHERE namespace.nspname IN ('booking', 'authn')
      AND CASE WHEN object.relkind = 'S' THEN
        has_sequence_privilege(
          'trainercrm_clients_function_owner', object.oid, 'USAGE,SELECT,UPDATE'
        )
      ELSE false END
  ) THEN
    RAISE EXCEPTION 'function owner has direct sequence access';
  END IF;
  SELECT count(*) INTO v_execute_count
    FROM pg_proc AS function
    JOIN pg_namespace AS namespace ON namespace.oid = function.pronamespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(function.proacl, acldefault('f', function.proowner))
    ) AS privilege
   WHERE namespace.nspname IN ('booking', 'authn')
     AND privilege.grantee = (SELECT oid FROM pg_roles
                               WHERE rolname = 'trainercrm_app')
     AND privilege.privilege_type = 'EXECUTE';
  IF v_execute_count <> 6 THEN
    RAISE EXCEPTION 'application role has unexpected executable function count: %', v_execute_count;
  END IF;
END
$security$;

SET ROLE trainercrm_app;

DO $test$
DECLARE
  v_first uuid;
  v_second uuid;
  v_count integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class AS object
    JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
    WHERE namespace.nspname IN ('booking', 'authn')
      AND object.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND has_table_privilege(current_user, object.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  ) OR EXISTS (
    SELECT 1 FROM pg_class AS object
    JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
    WHERE namespace.nspname IN ('booking', 'authn')
      AND CASE WHEN object.relkind = 'S' THEN
        has_sequence_privilege(current_user, object.oid, 'USAGE,SELECT,UPDATE')
      ELSE false END
  ) THEN
    RAISE EXCEPTION 'application role has direct table access';
  END IF;

  SELECT client_id INTO STRICT v_first
    FROM booking.create_trainer_client(decode(repeat('11', 32), 'hex'), 'First owner', 70.250);
  SELECT client_id INTO STRICT v_second
    FROM booking.create_trainer_client(decode(repeat('22', 32), 'hex'), 'Second owner', 80.500);

  SELECT count(*) INTO v_count
    FROM booking.list_trainer_clients(decode(repeat('11', 32), 'hex'))
   WHERE client_id = v_first AND display_name = 'First owner';
  IF v_count <> 1 THEN RAISE EXCEPTION 'trainer one cannot read own client'; END IF;

  SELECT count(*) INTO v_count
    FROM booking.list_trainer_clients(decode(repeat('11', 32), 'hex'))
   WHERE client_id = v_second;
  IF v_count <> 0 THEN RAISE EXCEPTION 'cross-trainer read succeeded'; END IF;

  BEGIN
    PERFORM booking.list_trainer_clients(decode(repeat('33', 32), 'hex'));
    RAISE EXCEPTION 'revoked session succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'UNAUTHORIZED' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM booking.list_trainer_clients(decode(repeat('44', 32), 'hex'));
    RAISE EXCEPTION 'expired session succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'UNAUTHORIZED' THEN RAISE; END IF;
  END;
END
$test$;

RESET ROLE;
DO $write_isolation$
BEGIN
  IF (SELECT count(*) FROM booking.clients
       WHERE display_name = 'First owner'
         AND tenant_id = '11000000-0000-4000-8000-000000000001'
         AND trainer_id = '12000000-0000-4000-8000-000000000001') <> 1 OR
     (SELECT count(*) FROM booking.clients
       WHERE display_name = 'Second owner'
         AND tenant_id = '11000000-0000-4000-8000-000000000002'
         AND trainer_id = '12000000-0000-4000-8000-000000000002') <> 1 THEN
    RAISE EXCEPTION 'client write escaped its authenticated trainer tenant';
  END IF;
END
$write_isolation$;
SELECT 'PASS: trainer client isolation, session rejection, ownership, and runtime permissions';
