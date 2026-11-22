BEGIN;

-- Extend the persistent trainer workspace only. Existing client/training rows
-- are not rewritten, and local-browser weight history is never imported.
DO $preflight$
DECLARE r pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_catalog.pg_roles
   WHERE rolname = 'trainercrm_clients_function_owner';
  IF NOT FOUND OR r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR
     r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls OR
     EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = r.oid) THEN
    RAISE EXCEPTION 'trainercrm_clients_function_owner must be an isolated NOLOGIN role';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'trainercrm_clients_function_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'migration operator lacks function-owner membership';
  END IF;
END
$preflight$;

CREATE TABLE booking.trainer_weight_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  trainer_id uuid NOT NULL,
  client_id uuid NOT NULL,
  measured_on date NOT NULL,
  weight numeric(7,3) NOT NULL CHECK (weight BETWEEN 0.001 AND 1000.000),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (tenant_id, trainer_id, client_id, measured_on),
  FOREIGN KEY (tenant_id, trainer_id, client_id)
    REFERENCES booking.clients(tenant_id, trainer_id, id)
);
CREATE INDEX trainer_weight_measurements_by_client
  ON booking.trainer_weight_measurements(tenant_id, trainer_id, client_id, measured_on, id);

CREATE FUNCTION booking.list_trainer_weight_measurements(
  p_session_digest bytea, p_client_id uuid
)
RETURNS TABLE (measurement_id uuid, measured_on date, weight numeric, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE v_trainer uuid; v_tenant uuid;
BEGIN
  SELECT r.trainer_id, r.tenant_id INTO v_trainer, v_tenant
    FROM booking.resolve_appointment_trainer(p_session_digest) AS r;
  IF p_client_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM booking.clients c
     WHERE c.id=p_client_id AND c.tenant_id=v_tenant AND c.trainer_id=v_trainer
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='WEIGHT_CLIENT_NOT_FOUND';
  END IF;
  RETURN QUERY SELECT m.id, m.measured_on, m.weight, m.created_at
    FROM booking.trainer_weight_measurements m
   WHERE m.tenant_id=v_tenant AND m.trainer_id=v_trainer AND m.client_id=p_client_id
   ORDER BY m.measured_on, m.id;
END
$function$;

CREATE FUNCTION booking.write_trainer_weight_measurement(
  p_session_digest bytea, p_client_id uuid, p_measurement_id uuid,
  p_measured_on date, p_weight numeric
)
RETURNS TABLE (measurement_id uuid, measured_on date, weight numeric, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE v_trainer uuid; v_tenant uuid; v_id uuid;
BEGIN
  IF p_measured_on IS NULL OR p_weight IS NULL OR p_weight < 0.001 OR
     p_weight > 1000 OR scale(p_weight) > 3 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='WEIGHT_INPUT_INVALID';
  END IF;
  SELECT r.trainer_id, r.tenant_id INTO v_trainer, v_tenant
    FROM booking.resolve_appointment_trainer(p_session_digest) AS r;
  IF p_client_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM booking.clients c
     WHERE c.id=p_client_id AND c.tenant_id=v_tenant AND c.trainer_id=v_trainer
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='WEIGHT_CLIENT_NOT_FOUND';
  END IF;
  IF p_measurement_id IS NULL THEN
    INSERT INTO booking.trainer_weight_measurements AS m
      (tenant_id, trainer_id, client_id, measured_on, weight)
    VALUES (v_tenant, v_trainer, p_client_id, p_measured_on, p_weight)
    RETURNING m.id INTO v_id;
  ELSE
    UPDATE booking.trainer_weight_measurements AS m
       SET measured_on=p_measured_on, weight=p_weight,
           updated_at=transaction_timestamp()
     WHERE m.id=p_measurement_id AND m.client_id=p_client_id
       AND m.tenant_id=v_tenant AND m.trainer_id=v_trainer
    RETURNING m.id INTO v_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='WEIGHT_NOT_FOUND';
    END IF;
  END IF;
  RETURN QUERY SELECT m.id, m.measured_on, m.weight, m.created_at
    FROM booking.trainer_weight_measurements m
   WHERE m.id=v_id AND m.tenant_id=v_tenant AND m.trainer_id=v_trainer;
END
$function$;

CREATE FUNCTION booking.delete_trainer_weight_measurement(
  p_session_digest bytea, p_client_id uuid, p_measurement_id uuid
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE v_trainer uuid; v_tenant uuid;
BEGIN
  SELECT r.trainer_id, r.tenant_id INTO v_trainer, v_tenant
    FROM booking.resolve_appointment_trainer(p_session_digest) AS r;
  DELETE FROM booking.trainer_weight_measurements AS m
   WHERE m.id=p_measurement_id AND m.client_id=p_client_id
     AND m.trainer_id=v_trainer AND m.tenant_id=v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='WEIGHT_NOT_FOUND';
  END IF;
  RETURN true;
END
$function$;

-- Only the isolated function owner can manipulate the new table.
GRANT SELECT, INSERT, UPDATE, DELETE ON booking.trainer_weight_measurements
  TO trainercrm_clients_function_owner;
REVOKE ALL ON booking.trainer_weight_measurements FROM PUBLIC, trainercrm_app;

REVOKE ALL ON FUNCTION booking.list_trainer_weight_measurements(bytea,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.write_trainer_weight_measurement(bytea,uuid,uuid,date,numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.delete_trainer_weight_measurement(bytea,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking.list_trainer_weight_measurements(bytea,uuid),
  booking.write_trainer_weight_measurement(bytea,uuid,uuid,date,numeric),
  booking.delete_trainer_weight_measurement(bytea,uuid,uuid)
  TO trainercrm_app;

GRANT CREATE ON SCHEMA booking TO trainercrm_clients_function_owner;
ALTER TABLE booking.trainer_weight_measurements OWNER TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.list_trainer_weight_measurements(bytea,uuid)
  OWNER TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.write_trainer_weight_measurement(bytea,uuid,uuid,date,numeric)
  OWNER TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.delete_trainer_weight_measurement(bytea,uuid,uuid)
  OWNER TO trainercrm_clients_function_owner;
REVOKE CREATE ON SCHEMA booking FROM trainercrm_clients_function_owner;

COMMIT;
