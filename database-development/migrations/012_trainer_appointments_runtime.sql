BEGIN;

-- Appointment commands share the isolated runtime owner introduced by 011.
-- The application login receives EXECUTE only and never direct table DML.
DO $prerequisite$
DECLARE
  v_owner oid;
BEGIN
  SELECT oid INTO v_owner FROM pg_catalog.pg_roles
   WHERE rolname = 'trainercrm_clients_function_owner'
     AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
     AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication
     AND NOT rolbypassrls;
  IF v_owner IS NULL OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = v_owner
  ) THEN
    RAISE EXCEPTION USING MESSAGE =
      'trainercrm_clients_function_owner must remain an isolated non-login role';
  END IF;
  IF NOT pg_catalog.pg_has_role(
    current_user, 'trainercrm_clients_function_owner', 'MEMBER'
  ) THEN
    RAISE EXCEPTION USING MESSAGE =
      'migration operator must be a member of trainercrm_clients_function_owner';
  END IF;
END
$prerequisite$;

CREATE TYPE booking.appointment_status AS ENUM ('active', 'cancelled');

CREATE TABLE booking.trainer_appointments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  trainer_id uuid NOT NULL,
  client_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status booking.appointment_status NOT NULL DEFAULT 'active',
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, trainer_id)
    REFERENCES booking.trainer_memberships(tenant_id, trainer_id),
  FOREIGN KEY (tenant_id, trainer_id, client_id)
    REFERENCES booking.clients(tenant_id, trainer_id, id),
  CHECK (ends_at > starts_at),
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'active' AND cancelled_at IS NULL) OR
    (status = 'cancelled' AND cancelled_at IS NOT NULL)
  ),
  EXCLUDE USING gist (
    trainer_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'active')
);

CREATE INDEX trainer_appointments_range_idx
  ON booking.trainer_appointments(tenant_id, trainer_id, starts_at, id);
CREATE INDEX trainer_appointments_client_idx
  ON booking.trainer_appointments(tenant_id, trainer_id, client_id, starts_at DESC);

CREATE FUNCTION booking.resolve_appointment_trainer(
  p_token_sha256_digest bytea,
  OUT trainer_id uuid,
  OUT tenant_id uuid
)
RETURNS record
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
BEGIN
  SELECT trainer.id, membership.tenant_id
    INTO trainer_id, tenant_id
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
    JOIN booking.tenants AS tenant ON tenant.id = membership.tenant_id
   WHERE p_token_sha256_digest IS NOT NULL
     AND octet_length(p_token_sha256_digest) = 32
     AND session.token_sha256_digest = p_token_sha256_digest
     AND session.revoked_at IS NULL
     AND transaction_timestamp() < session.idle_expires_at
     AND transaction_timestamp() < session.absolute_expires_at
     AND session.created_at >= credential.password_changed_at
     AND trainer.role = 'trainer' AND trainer.status = 'active'
     AND identity.disabled_at IS NULL
     AND identity.verified_at <= session.created_at
     AND tenant.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNAUTHORIZED';
  END IF;
END
$function$;

CREATE FUNCTION booking.list_trainer_appointments(
  p_token_sha256_digest bytea,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  appointment_id uuid, client_id uuid, client_name text,
  starts_at timestamptz, ends_at timestamptz,
  appointment_status booking.appointment_status,
  cancelled_at timestamptz, created_at timestamptz, updated_at timestamptz
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
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR
     p_to - p_from > interval '31 days' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'APPOINTMENT_RANGE_INVALID';
  END IF;
  SELECT resolved.trainer_id, resolved.tenant_id
    INTO v_trainer_id, v_tenant_id
    FROM booking.resolve_appointment_trainer(p_token_sha256_digest) AS resolved;
  RETURN QUERY
    SELECT appointment.id, appointment.client_id, client.display_name,
           appointment.starts_at, appointment.ends_at, appointment.status,
           appointment.cancelled_at, appointment.created_at, appointment.updated_at
      FROM booking.trainer_appointments AS appointment
      JOIN booking.clients AS client
        ON client.tenant_id = appointment.tenant_id
       AND client.trainer_id = appointment.trainer_id
       AND client.id = appointment.client_id
     WHERE appointment.tenant_id = v_tenant_id
       AND appointment.trainer_id = v_trainer_id
       AND appointment.starts_at < p_to
       AND appointment.ends_at > p_from
     ORDER BY appointment.starts_at, appointment.id;
END
$function$;

CREATE FUNCTION booking.create_trainer_appointment(
  p_token_sha256_digest bytea,
  p_client_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
RETURNS SETOF booking.trainer_appointments
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE
  v_trainer_id uuid; v_tenant_id uuid; v_id uuid := gen_random_uuid();
BEGIN
  IF p_client_id IS NULL OR p_starts_at IS NULL OR p_ends_at IS NULL OR
     p_ends_at <= p_starts_at THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'APPOINTMENT_INPUT_INVALID';
  END IF;
  SELECT resolved.trainer_id, resolved.tenant_id INTO v_trainer_id, v_tenant_id
    FROM booking.resolve_appointment_trainer(p_token_sha256_digest) AS resolved;
  IF NOT EXISTS (
    SELECT 1 FROM booking.clients AS client
     WHERE client.id = p_client_id AND client.tenant_id = v_tenant_id
       AND client.trainer_id = v_trainer_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'APPOINTMENT_NOT_FOUND';
  END IF;
  BEGIN
    INSERT INTO booking.trainer_appointments (
      id, tenant_id, trainer_id, client_id, starts_at, ends_at
    ) VALUES (v_id, v_tenant_id, v_trainer_id, p_client_id, p_starts_at, p_ends_at);
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'APPOINTMENT_CONFLICT';
  END;
  RETURN QUERY SELECT * FROM booking.trainer_appointments WHERE id = v_id;
END
$function$;

CREATE FUNCTION booking.reschedule_trainer_appointment(
  p_token_sha256_digest bytea,
  p_appointment_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
RETURNS SETOF booking.trainer_appointments
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE v_trainer_id uuid; v_tenant_id uuid;
BEGIN
  IF p_appointment_id IS NULL OR p_starts_at IS NULL OR p_ends_at IS NULL OR
     p_ends_at <= p_starts_at THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'APPOINTMENT_INPUT_INVALID';
  END IF;
  SELECT resolved.trainer_id, resolved.tenant_id INTO v_trainer_id, v_tenant_id
    FROM booking.resolve_appointment_trainer(p_token_sha256_digest) AS resolved;
  BEGIN
    RETURN QUERY
      UPDATE booking.trainer_appointments AS appointment
         SET starts_at = p_starts_at, ends_at = p_ends_at,
             updated_at = transaction_timestamp()
       WHERE appointment.id = p_appointment_id
         AND appointment.tenant_id = v_tenant_id
         AND appointment.trainer_id = v_trainer_id
         AND appointment.status = 'active'
      RETURNING appointment.*;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'APPOINTMENT_CONFLICT';
  END;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'APPOINTMENT_NOT_FOUND';
  END IF;
END
$function$;

CREATE FUNCTION booking.cancel_trainer_appointment(
  p_token_sha256_digest bytea,
  p_appointment_id uuid
)
RETURNS SETOF booking.trainer_appointments
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE v_trainer_id uuid; v_tenant_id uuid;
BEGIN
  IF p_appointment_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'APPOINTMENT_INPUT_INVALID';
  END IF;
  SELECT resolved.trainer_id, resolved.tenant_id INTO v_trainer_id, v_tenant_id
    FROM booking.resolve_appointment_trainer(p_token_sha256_digest) AS resolved;
  RETURN QUERY
    UPDATE booking.trainer_appointments AS appointment
       SET status = 'cancelled', cancelled_at = transaction_timestamp(),
           updated_at = transaction_timestamp()
     WHERE appointment.id = p_appointment_id
       AND appointment.tenant_id = v_tenant_id
       AND appointment.trainer_id = v_trainer_id
       AND appointment.status = 'active'
    RETURNING appointment.*;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'APPOINTMENT_NOT_FOUND';
  END IF;
END
$function$;

GRANT SELECT ON TABLE authn.trainer_sessions, authn.trainer_password_credentials,
  authn.email_identities, booking.auth_subjects, booking.trainer_memberships,
  booking.tenants, booking.clients TO trainercrm_clients_function_owner;
GRANT SELECT, INSERT, UPDATE ON TABLE booking.trainer_appointments
  TO trainercrm_clients_function_owner;

REVOKE ALL ON FUNCTION booking.resolve_appointment_trainer(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.list_trainer_appointments(bytea,timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.create_trainer_appointment(bytea,uuid,timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.reschedule_trainer_appointment(bytea,uuid,timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.cancel_trainer_appointment(bytea,uuid) FROM PUBLIC;

REVOKE ALL ON ALL TABLES IN SCHEMA booking FROM trainercrm_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA booking FROM trainercrm_app;
GRANT USAGE ON SCHEMA booking TO trainercrm_app;
GRANT EXECUTE ON FUNCTION
  booking.list_trainer_appointments(bytea,timestamptz,timestamptz),
  booking.create_trainer_appointment(bytea,uuid,timestamptz,timestamptz),
  booking.reschedule_trainer_appointment(bytea,uuid,timestamptz,timestamptz),
  booking.cancel_trainer_appointment(bytea,uuid) TO trainercrm_app;

GRANT CREATE ON SCHEMA booking TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.resolve_appointment_trainer(bytea) OWNER TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.list_trainer_appointments(bytea,timestamptz,timestamptz) OWNER TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.create_trainer_appointment(bytea,uuid,timestamptz,timestamptz) OWNER TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.reschedule_trainer_appointment(bytea,uuid,timestamptz,timestamptz) OWNER TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.cancel_trainer_appointment(bytea,uuid) OWNER TO trainercrm_clients_function_owner;
REVOKE CREATE ON SCHEMA booking FROM trainercrm_clients_function_owner;

COMMIT;
