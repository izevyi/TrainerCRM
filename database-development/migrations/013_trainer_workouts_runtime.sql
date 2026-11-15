BEGIN;

DO $prerequisite$
DECLARE v_owner oid;
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

-- Include appointment ownership and client identity in the referenced key so a
-- workout cannot link to another trainer's appointment or to an appointment
-- belonging to a different client, even outside the command functions.
ALTER TABLE booking.trainer_appointments
  ADD UNIQUE (tenant_id, trainer_id, client_id, id);

CREATE TABLE booking.trainer_workouts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  trainer_id uuid NOT NULL,
  client_id uuid NOT NULL,
  appointment_id uuid,
  workout_date date NOT NULL,
  workout_time time(0) NOT NULL,
  workout_type text NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  calories_burned numeric(10,2),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (tenant_id, trainer_id, id),
  UNIQUE (tenant_id, trainer_id, appointment_id),
  FOREIGN KEY (tenant_id, trainer_id)
    REFERENCES booking.trainer_memberships(tenant_id, trainer_id),
  FOREIGN KEY (tenant_id, trainer_id, client_id)
    REFERENCES booking.clients(tenant_id, trainer_id, id),
  FOREIGN KEY (tenant_id, trainer_id, client_id, appointment_id)
    REFERENCES booking.trainer_appointments(tenant_id, trainer_id, client_id, id),
  CHECK (length(workout_type) BETWEEN 1 AND 120 AND workout_type = btrim(workout_type)),
  CHECK (calories_burned IS NULL OR calories_burned BETWEEN 0 AND 100000),
  CHECK (updated_at >= created_at)
);

CREATE TABLE booking.workout_exercises (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  trainer_id uuid NOT NULL,
  workout_id uuid NOT NULL,
  exercise_order smallint NOT NULL,
  exercise_name text NOT NULL,
  UNIQUE (tenant_id, trainer_id, workout_id, exercise_order),
  FOREIGN KEY (tenant_id, trainer_id, workout_id)
    REFERENCES booking.trainer_workouts(tenant_id, trainer_id, id) ON DELETE CASCADE,
  CHECK (exercise_order BETWEEN 1 AND 50),
  CHECK (length(exercise_name) BETWEEN 1 AND 120 AND exercise_name = btrim(exercise_name))
);

CREATE TABLE booking.workout_sets (
  id uuid PRIMARY KEY,
  exercise_id uuid NOT NULL REFERENCES booking.workout_exercises(id) ON DELETE CASCADE,
  set_order smallint NOT NULL,
  weight numeric(8,3) NOT NULL,
  repetitions integer NOT NULL,
  UNIQUE (exercise_id, set_order),
  CHECK (set_order BETWEEN 1 AND 20),
  CHECK (weight BETWEEN 0 AND 1000),
  CHECK (repetitions BETWEEN 0 AND 10000)
);

CREATE INDEX trainer_workouts_client_date_idx
  ON booking.trainer_workouts(tenant_id, trainer_id, client_id, workout_date DESC, workout_time DESC);
CREATE INDEX workout_exercises_workout_idx
  ON booking.workout_exercises(tenant_id, trainer_id, workout_id, exercise_order);

CREATE FUNCTION booking.validate_workout_exercises(p_exercises jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT jsonb_typeof(p_exercises) = 'array'
     AND jsonb_array_length(p_exercises) <= 50
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_exercises) WITH ORDINALITY AS e(value, position)
        WHERE jsonb_typeof(e.value) <> 'object'
           OR (SELECT count(*) FROM jsonb_object_keys(e.value)) <> 2
           OR jsonb_typeof(e.value->'name') <> 'string'
           OR length(e.value->>'name') NOT BETWEEN 1 AND 120
           OR e.value->>'name' <> btrim(e.value->>'name')
           OR jsonb_typeof(e.value->'sets') <> 'array'
           OR jsonb_array_length(e.value->'sets') > 20
           OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(e.value->'sets') AS s(value)
              WHERE jsonb_typeof(s.value) <> 'object'
                 OR (SELECT count(*) FROM jsonb_object_keys(s.value)) <> 2
                 OR jsonb_typeof(s.value->'weight') <> 'number'
                 OR jsonb_typeof(s.value->'reps') <> 'number'
                 OR (s.value->>'weight')::numeric NOT BETWEEN 0 AND 1000
                 OR scale((s.value->>'weight')::numeric) > 3
                 OR (s.value->>'reps')::numeric NOT BETWEEN 0 AND 10000
                 OR scale((s.value->>'reps')::numeric) <> 0
           )
     )
$function$;

CREATE FUNCTION booking.workout_document(p_workout_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, booking
AS $function$
  SELECT jsonb_build_object(
    'id', workout.id, 'clientId', workout.client_id,
    'clientName', client.display_name, 'appointmentId', workout.appointment_id,
    'date', workout.workout_date, 'time', workout.workout_time,
    'type', workout.workout_type, 'completed', workout.completed,
    'caloriesBurned', workout.calories_burned,
    'createdAt', workout.created_at, 'updatedAt', workout.updated_at,
    'exercises', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', exercise.id, 'name', exercise.exercise_name,
        'sets', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'id', workout_set.id, 'weight', workout_set.weight,
            'reps', workout_set.repetitions
          ) ORDER BY workout_set.set_order)
          FROM booking.workout_sets AS workout_set
          WHERE workout_set.exercise_id = exercise.id
        ), '[]'::jsonb)
      ) ORDER BY exercise.exercise_order)
      FROM booking.workout_exercises AS exercise
      WHERE exercise.tenant_id = workout.tenant_id
        AND exercise.trainer_id = workout.trainer_id
        AND exercise.workout_id = workout.id
    ), '[]'::jsonb)
  )
  FROM booking.trainer_workouts AS workout
  JOIN booking.clients AS client
    ON client.tenant_id = workout.tenant_id
   AND client.trainer_id = workout.trainer_id
   AND client.id = workout.client_id
  WHERE workout.id = p_workout_id
$function$;

CREATE FUNCTION booking.list_trainer_workouts(
  p_token_sha256_digest bytea, p_client_id uuid
)
RETURNS TABLE (workout jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE v_trainer_id uuid; v_tenant_id uuid;
BEGIN
  SELECT resolved.trainer_id, resolved.tenant_id INTO v_trainer_id, v_tenant_id
    FROM booking.resolve_appointment_trainer(p_token_sha256_digest) AS resolved;
  IF p_client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM booking.clients AS client WHERE client.id = p_client_id
      AND client.tenant_id = v_tenant_id AND client.trainer_id = v_trainer_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'WORKOUT_NOT_FOUND';
  END IF;
  RETURN QUERY
    SELECT booking.workout_document(stored.id)
      FROM booking.trainer_workouts AS stored
     WHERE stored.tenant_id = v_tenant_id AND stored.trainer_id = v_trainer_id
       AND (p_client_id IS NULL OR stored.client_id = p_client_id)
     ORDER BY stored.workout_date DESC, stored.workout_time DESC, stored.id;
END
$function$;

CREATE FUNCTION booking.get_trainer_workout(
  p_token_sha256_digest bytea, p_workout_id uuid
)
RETURNS TABLE (workout jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE v_trainer_id uuid; v_tenant_id uuid;
BEGIN
  IF p_workout_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'WORKOUT_INPUT_INVALID';
  END IF;
  SELECT resolved.trainer_id, resolved.tenant_id INTO v_trainer_id, v_tenant_id
    FROM booking.resolve_appointment_trainer(p_token_sha256_digest) AS resolved;
  RETURN QUERY SELECT booking.workout_document(stored.id)
    FROM booking.trainer_workouts AS stored
   WHERE stored.id = p_workout_id AND stored.tenant_id = v_tenant_id
     AND stored.trainer_id = v_trainer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'WORKOUT_NOT_FOUND';
  END IF;
END
$function$;

CREATE FUNCTION booking.write_trainer_workout(
  p_token_sha256_digest bytea, p_workout_id uuid, p_client_id uuid,
  p_appointment_id uuid, p_workout_date date, p_workout_time time,
  p_workout_type text, p_completed boolean, p_calories_burned numeric,
  p_exercises jsonb
)
RETURNS TABLE (workout jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
DECLARE
  v_trainer_id uuid; v_tenant_id uuid; v_workout_id uuid;
  v_exercise jsonb; v_set jsonb; v_exercise_id uuid;
  v_exercise_order integer; v_set_order integer;
BEGIN
  IF p_client_id IS NULL OR p_workout_date IS NULL OR p_workout_time IS NULL OR
     p_workout_type IS NULL OR p_workout_type <> btrim(p_workout_type) OR
     length(p_workout_type) NOT BETWEEN 1 AND 120 OR p_completed IS NULL OR
     (p_calories_burned IS NOT NULL AND (p_calories_burned < 0 OR
       p_calories_burned > 100000 OR scale(p_calories_burned) > 2)) OR
     NOT coalesce(booking.validate_workout_exercises(p_exercises), false) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'WORKOUT_INPUT_INVALID';
  END IF;
  SELECT resolved.trainer_id, resolved.tenant_id INTO v_trainer_id, v_tenant_id
    FROM booking.resolve_appointment_trainer(p_token_sha256_digest) AS resolved;
  IF NOT EXISTS (
    SELECT 1 FROM booking.clients AS client WHERE client.id = p_client_id
      AND client.tenant_id = v_tenant_id AND client.trainer_id = v_trainer_id
  ) OR (p_appointment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM booking.trainer_appointments AS appointment
     WHERE appointment.id = p_appointment_id AND appointment.tenant_id = v_tenant_id
       AND appointment.trainer_id = v_trainer_id AND appointment.client_id = p_client_id
  )) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'WORKOUT_NOT_FOUND';
  END IF;

  IF p_workout_id IS NULL THEN
    v_workout_id := gen_random_uuid();
    BEGIN
      INSERT INTO booking.trainer_workouts (
        id, tenant_id, trainer_id, client_id, appointment_id, workout_date,
        workout_time, workout_type, completed, calories_burned
      ) VALUES (
        v_workout_id, v_tenant_id, v_trainer_id, p_client_id, p_appointment_id,
        p_workout_date, p_workout_time, p_workout_type, p_completed, p_calories_burned
      );
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'WORKOUT_CONFLICT';
    END;
  ELSE
    v_workout_id := p_workout_id;
    BEGIN
      UPDATE booking.trainer_workouts AS stored
         SET client_id = p_client_id, appointment_id = p_appointment_id,
             workout_date = p_workout_date, workout_time = p_workout_time,
             workout_type = p_workout_type, completed = p_completed,
             calories_burned = p_calories_burned,
             updated_at = transaction_timestamp()
       WHERE stored.id = v_workout_id AND stored.tenant_id = v_tenant_id
         AND stored.trainer_id = v_trainer_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'WORKOUT_CONFLICT';
    END;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'WORKOUT_NOT_FOUND';
    END IF;
    DELETE FROM booking.workout_exercises AS exercise
     WHERE exercise.tenant_id = v_tenant_id AND exercise.trainer_id = v_trainer_id
       AND exercise.workout_id = v_workout_id;
  END IF;

  FOR v_exercise, v_exercise_order IN
    SELECT value, ordinality::integer FROM jsonb_array_elements(p_exercises) WITH ORDINALITY
  LOOP
    v_exercise_id := gen_random_uuid();
    INSERT INTO booking.workout_exercises (
      id, tenant_id, trainer_id, workout_id, exercise_order, exercise_name
    ) VALUES (
      v_exercise_id, v_tenant_id, v_trainer_id, v_workout_id,
      v_exercise_order, v_exercise->>'name'
    );
    FOR v_set, v_set_order IN
      SELECT value, ordinality::integer FROM jsonb_array_elements(v_exercise->'sets') WITH ORDINALITY
    LOOP
      INSERT INTO booking.workout_sets (
        id, exercise_id, set_order, weight, repetitions
      ) VALUES (
        gen_random_uuid(), v_exercise_id, v_set_order,
        (v_set->>'weight')::numeric, (v_set->>'reps')::integer
      );
    END LOOP;
  END LOOP;
  RETURN QUERY SELECT booking.workout_document(v_workout_id);
END
$function$;

CREATE FUNCTION booking.create_trainer_workout(
  p_token_sha256_digest bytea, p_client_id uuid, p_appointment_id uuid,
  p_workout_date date, p_workout_time time, p_workout_type text,
  p_completed boolean, p_calories_burned numeric, p_exercises jsonb
)
RETURNS TABLE (workout jsonb)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, booking
AS $function$
  SELECT * FROM booking.write_trainer_workout(
    p_token_sha256_digest, NULL, p_client_id, p_appointment_id,
    p_workout_date, p_workout_time, p_workout_type, p_completed,
    p_calories_burned, p_exercises
  )
$function$;

CREATE FUNCTION booking.update_trainer_workout(
  p_token_sha256_digest bytea, p_workout_id uuid, p_client_id uuid,
  p_appointment_id uuid, p_workout_date date, p_workout_time time,
  p_workout_type text, p_completed boolean, p_calories_burned numeric,
  p_exercises jsonb
)
RETURNS TABLE (workout jsonb)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, booking
AS $function$
  SELECT * FROM booking.write_trainer_workout(
    p_token_sha256_digest, p_workout_id, p_client_id, p_appointment_id,
    p_workout_date, p_workout_time, p_workout_type, p_completed,
    p_calories_burned, p_exercises
  )
$function$;

GRANT SELECT ON TABLE authn.trainer_sessions, authn.trainer_password_credentials,
  authn.email_identities, booking.auth_subjects, booking.trainer_memberships,
  booking.tenants, booking.clients, booking.trainer_appointments
  TO trainercrm_clients_function_owner;
GRANT SELECT, INSERT, UPDATE ON TABLE booking.trainer_workouts
  TO trainercrm_clients_function_owner;
GRANT SELECT, INSERT, DELETE ON TABLE booking.workout_exercises
  TO trainercrm_clients_function_owner;
GRANT SELECT, INSERT ON TABLE booking.workout_sets
  TO trainercrm_clients_function_owner;

REVOKE ALL ON FUNCTION booking.validate_workout_exercises(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.workout_document(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.list_trainer_workouts(bytea,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.get_trainer_workout(bytea,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.write_trainer_workout(bytea,uuid,uuid,uuid,date,time,text,boolean,numeric,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.create_trainer_workout(bytea,uuid,uuid,date,time,text,boolean,numeric,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.update_trainer_workout(bytea,uuid,uuid,uuid,date,time,text,boolean,numeric,jsonb) FROM PUBLIC;

GRANT USAGE ON SCHEMA booking TO trainercrm_app;
GRANT EXECUTE ON FUNCTION booking.list_trainer_workouts(bytea,uuid),
  booking.get_trainer_workout(bytea,uuid),
  booking.create_trainer_workout(bytea,uuid,uuid,date,time,text,boolean,numeric,jsonb),
  booking.update_trainer_workout(bytea,uuid,uuid,uuid,date,time,text,boolean,numeric,jsonb)
  TO trainercrm_app;

GRANT CREATE ON SCHEMA booking TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.validate_workout_exercises(jsonb) OWNER TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.workout_document(uuid) OWNER TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.list_trainer_workouts(bytea,uuid) OWNER TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.get_trainer_workout(bytea,uuid) OWNER TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.write_trainer_workout(bytea,uuid,uuid,uuid,date,time,text,boolean,numeric,jsonb) OWNER TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.create_trainer_workout(bytea,uuid,uuid,date,time,text,boolean,numeric,jsonb) OWNER TO trainercrm_clients_function_owner;
ALTER FUNCTION booking.update_trainer_workout(bytea,uuid,uuid,uuid,date,time,text,boolean,numeric,jsonb) OWNER TO trainercrm_clients_function_owner;
REVOKE CREATE ON SCHEMA booking FROM trainercrm_clients_function_owner;

COMMIT;
