BEGIN;

-- Administrative prerequisite (intentionally not created by this migration):
--   CREATE ROLE trainercrm_clients_function_owner
--     NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
--     NOREPLICATION NOBYPASSRLS;
-- The migration operator must be a member of that role so PostgreSQL permits
-- ALTER FUNCTION ... OWNER TO. Keep the role membership-free otherwise.
DO $prerequisite$
DECLARE
  v_owner oid;
BEGIN
  SELECT oid INTO v_owner
    FROM pg_catalog.pg_roles
   WHERE rolname = 'trainercrm_clients_function_owner'
     AND NOT rolcanlogin
     AND NOT rolsuper
     AND NOT rolcreatedb
     AND NOT rolcreaterole
     AND NOT rolinherit
     AND NOT rolreplication
     AND NOT rolbypassrls;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION USING MESSAGE =
      'trainercrm_clients_function_owner must be pre-provisioned as NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = v_owner) THEN
    RAISE EXCEPTION USING MESSAGE =
      'trainercrm_clients_function_owner must not be a member of another role';
  END IF;
  IF NOT pg_catalog.pg_has_role(
    current_user, 'trainercrm_clients_function_owner', 'MEMBER'
  ) THEN
    RAISE EXCEPTION USING MESSAGE =
      'migration operator must be a member of trainercrm_clients_function_owner';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
    'trainercrm_clients_function_owner', 'pg_catalog.gen_random_uuid()', 'EXECUTE'
  ) THEN
    RAISE EXCEPTION USING MESSAGE =
      'trainercrm_clients_function_owner requires EXECUTE on pg_catalog.gen_random_uuid()';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname = 'trainercrm_app'
       AND rolcanlogin
       AND NOT rolsuper
       AND NOT rolcreatedb
       AND NOT rolcreaterole
       AND NOT rolreplication
       AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION USING MESSAGE =
      'trainercrm_app must be a non-privileged login role';
  END IF;
END
$prerequisite$;

-- CRM client rows reuse the existing tenant/trainer ownership model. The
-- weight is nullable for pre-existing booking clients and mandatory through
-- the CRM creation command below.
ALTER TABLE booking.clients
  ADD COLUMN starting_weight numeric(7,3),
  ADD CONSTRAINT clients_starting_weight_valid
    CHECK (starting_weight IS NULL OR starting_weight BETWEEN 0.001 AND 1000.000);

CREATE INDEX clients_by_trainer_created_idx
  ON booking.clients(tenant_id, trainer_id, created_at, id);

CREATE FUNCTION booking.list_trainer_clients(
  p_token_sha256_digest bytea
)
RETURNS TABLE (
  client_id uuid,
  display_name text,
  starting_weight numeric,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE
  v_trainer_id uuid;
  v_tenant_id uuid;
BEGIN
  SELECT trainer.id, membership.tenant_id
    INTO v_trainer_id, v_tenant_id
    FROM authn.trainer_sessions AS session
    JOIN authn.trainer_password_credentials AS credential
      ON credential.trainer_subject_id = session.trainer_subject_id
    JOIN booking.auth_subjects AS trainer
      ON trainer.id = credential.trainer_subject_id
    JOIN authn.email_identities AS identity
      ON identity.id = credential.email_identity_id
     AND identity.subject_id = trainer.id
    JOIN booking.trainer_memberships AS membership
      ON membership.trainer_id = trainer.id
    JOIN booking.tenants AS tenant
      ON tenant.id = membership.tenant_id
   WHERE p_token_sha256_digest IS NOT NULL
     AND octet_length(p_token_sha256_digest) = 32
     AND session.token_sha256_digest = p_token_sha256_digest
     AND session.revoked_at IS NULL
     AND transaction_timestamp() < session.idle_expires_at
     AND transaction_timestamp() < session.absolute_expires_at
     AND session.created_at >= credential.password_changed_at
     AND trainer.role = 'trainer'
     AND trainer.status = 'active'
     AND identity.disabled_at IS NULL
     AND identity.verified_at <= session.created_at
     AND tenant.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNAUTHORIZED';
  END IF;

  RETURN QUERY
    SELECT client.id, client.display_name, client.starting_weight, client.created_at
      FROM booking.clients AS client
     WHERE client.tenant_id = v_tenant_id
       AND client.trainer_id = v_trainer_id
       AND client.starting_weight IS NOT NULL
     ORDER BY client.created_at, client.id;
END
$function$;

CREATE FUNCTION booking.create_trainer_client(
  p_token_sha256_digest bytea,
  p_display_name text,
  p_starting_weight numeric
)
RETURNS TABLE (
  client_id uuid,
  display_name text,
  starting_weight numeric,
  created_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE
  v_trainer_id uuid;
  v_tenant_id uuid;
  v_client_id uuid := gen_random_uuid();
BEGIN
  IF p_token_sha256_digest IS NULL OR octet_length(p_token_sha256_digest) <> 32 OR
     p_display_name IS NULL OR p_display_name <> btrim(p_display_name) OR
     length(p_display_name) NOT BETWEEN 1 AND 120 OR
     p_starting_weight IS NULL OR p_starting_weight < 0.001 OR
     p_starting_weight > 1000.000 OR scale(p_starting_weight) > 3 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CLIENT_INPUT_INVALID';
  END IF;

  SELECT trainer.id, membership.tenant_id
    INTO v_trainer_id, v_tenant_id
    FROM authn.trainer_sessions AS session
    JOIN authn.trainer_password_credentials AS credential
      ON credential.trainer_subject_id = session.trainer_subject_id
    JOIN booking.auth_subjects AS trainer
      ON trainer.id = credential.trainer_subject_id
    JOIN authn.email_identities AS identity
      ON identity.id = credential.email_identity_id
     AND identity.subject_id = trainer.id
    JOIN booking.trainer_memberships AS membership
      ON membership.trainer_id = trainer.id
    JOIN booking.tenants AS tenant
      ON tenant.id = membership.tenant_id
   WHERE session.token_sha256_digest = p_token_sha256_digest
     AND session.revoked_at IS NULL
     AND transaction_timestamp() < session.idle_expires_at
     AND transaction_timestamp() < session.absolute_expires_at
     AND session.created_at >= credential.password_changed_at
     AND trainer.role = 'trainer'
     AND trainer.status = 'active'
     AND identity.disabled_at IS NULL
     AND identity.verified_at <= session.created_at
     AND tenant.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNAUTHORIZED';
  END IF;

  INSERT INTO booking.clients (
    id, tenant_id, trainer_id, display_name, starting_weight
  ) VALUES (
    v_client_id, v_tenant_id, v_trainer_id, p_display_name, p_starting_weight
  );

  RETURN QUERY
    SELECT client.id, client.display_name, client.starting_weight, client.created_at
      FROM booking.clients AS client
     WHERE client.id = v_client_id;
END
$function$;

-- Give the dedicated owner only what these two functions execute. There are
-- no sequence-backed values in booking.clients.
GRANT USAGE ON SCHEMA booking, authn
  TO trainercrm_clients_function_owner;
GRANT SELECT ON TABLE
  authn.trainer_sessions,
  authn.trainer_password_credentials,
  authn.email_identities,
  booking.auth_subjects,
  booking.trainer_memberships,
  booking.tenants
  TO trainercrm_clients_function_owner;
GRANT SELECT, INSERT ON TABLE booking.clients
  TO trainercrm_clients_function_owner;

REVOKE ALL ON FUNCTION booking.list_trainer_clients(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.create_trainer_client(bytea, text, numeric) FROM PUBLIC;

-- The application role keeps no direct schema data access. Its only CRM
-- capability is execution of these session-bound functions.
REVOKE ALL ON ALL TABLES IN SCHEMA booking FROM trainercrm_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA booking FROM trainercrm_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA booking FROM trainercrm_app;
REVOKE ALL ON ALL TABLES IN SCHEMA authn FROM trainercrm_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA authn FROM trainercrm_app;
GRANT USAGE ON SCHEMA booking TO trainercrm_app;
GRANT EXECUTE ON FUNCTION booking.list_trainer_clients(bytea) TO trainercrm_app;
GRANT EXECUTE ON FUNCTION booking.create_trainer_client(bytea, text, numeric)
  TO trainercrm_app;

-- Apply every function ACL change while the migration operator still owns the
-- functions. PostgreSQL requires the prospective owner to have CREATE on the
-- containing schema during ownership transfer; remove that temporary grant
-- immediately after both transfers.
GRANT CREATE ON SCHEMA booking TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.list_trainer_clients(bytea)
  OWNER TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.create_trainer_client(bytea, text, numeric)
  OWNER TO trainercrm_clients_function_owner;
REVOKE CREATE ON SCHEMA booking FROM trainercrm_clients_function_owner;

COMMIT;
