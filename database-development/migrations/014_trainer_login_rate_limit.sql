BEGIN;

-- Pre-provision this role as NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
-- NOINHERIT NOREPLICATION NOBYPASSRLS, with membership granted only to
-- trainercrm_persistent_operator. The role is an isolated function/table
-- owner, not an account that can log in.
DO $preflight$
DECLARE
  role_record pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO role_record FROM pg_catalog.pg_roles
   WHERE rolname = 'trainercrm_login_rate_owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trainercrm_login_rate_owner must be pre-provisioned';
  END IF;
  IF role_record.rolcanlogin OR role_record.rolsuper OR
     role_record.rolcreatedb OR role_record.rolcreaterole OR
     role_record.rolinherit OR role_record.rolreplication OR
     role_record.rolbypassrls THEN
    RAISE EXCEPTION 'trainercrm_login_rate_owner must be a restricted NOLOGIN NOINHERIT role';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'trainercrm_login_rate_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'migration operator must be a member of trainercrm_login_rate_owner';
  END IF;
END
$preflight$;

-- Private, short-lived counters; no clear-text email or IP is stored.
-- The server sends two HMAC-SHA256 digests made with a separate 32-byte secret.
CREATE TABLE authn.trainer_login_attempt_buckets (
  key_digest bytea PRIMARY KEY CHECK (octet_length(key_digest) = 32),
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count > 0)
);

CREATE INDEX trainer_login_attempt_buckets_started_idx
  ON authn.trainer_login_attempt_buckets(window_started_at);

REVOKE ALL ON TABLE authn.trainer_login_attempt_buckets FROM PUBLIC;
REVOKE ALL ON TABLE authn.trainer_login_attempt_buckets FROM trainercrm_app;

-- Atomic PostgreSQL upserts make counts consistent across app workers/restarts.
-- One IP: at most 30/minute; one (IP,email) combination: at most 5/minute.
CREATE FUNCTION authn.consume_trainer_login_attempt(
  p_ip_digest bytea,
  p_pair_digest bytea
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, authn
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_ip_count integer;
  v_pair_count integer;
BEGIN
  IF p_ip_digest IS NULL OR p_pair_digest IS NULL OR
     octet_length(p_ip_digest) <> 32 OR
     octet_length(p_pair_digest) <> 32 OR
     p_ip_digest = p_pair_digest THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'LOGIN_RATE_INPUT_INVALID';
  END IF;

  -- Opportunistic cleanup, serialized across concurrent logins.
  IF random() < 0.02 AND pg_try_advisory_xact_lock(128394, 14) THEN
    DELETE FROM authn.trainer_login_attempt_buckets
      WHERE window_started_at < v_now - interval '2 minutes';
  END IF;

  INSERT INTO authn.trainer_login_attempt_buckets AS bucket
    (key_digest, window_started_at, attempt_count)
  VALUES (p_ip_digest, v_now, 1)
  ON CONFLICT (key_digest) DO UPDATE
    SET attempt_count = CASE
          WHEN bucket.window_started_at <= v_now - interval '60 seconds' THEN 1
          ELSE bucket.attempt_count + 1
        END,
        window_started_at = CASE
          WHEN bucket.window_started_at <= v_now - interval '60 seconds' THEN v_now
          ELSE bucket.window_started_at
        END
  RETURNING attempt_count INTO v_ip_count;

  INSERT INTO authn.trainer_login_attempt_buckets AS bucket
    (key_digest, window_started_at, attempt_count)
  VALUES (p_pair_digest, v_now, 1)
  ON CONFLICT (key_digest) DO UPDATE
    SET attempt_count = CASE
          WHEN bucket.window_started_at <= v_now - interval '60 seconds' THEN 1
          ELSE bucket.attempt_count + 1
        END,
        window_started_at = CASE
          WHEN bucket.window_started_at <= v_now - interval '60 seconds' THEN v_now
          ELSE bucket.window_started_at
        END
  RETURNING attempt_count INTO v_pair_count;

  RETURN v_ip_count <= 30 AND v_pair_count <= 5;
END
$function$;

REVOKE ALL ON FUNCTION authn.consume_trainer_login_attempt(bytea,bytea)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authn.consume_trainer_login_attempt(bytea,bytea)
  TO trainercrm_app;

-- SECURITY DEFINER must not run with migration operator/superuser privileges.
-- The isolated role owns only the limiter's table and function.
GRANT USAGE, CREATE ON SCHEMA authn TO trainercrm_login_rate_owner;
ALTER TABLE authn.trainer_login_attempt_buckets
  OWNER TO trainercrm_login_rate_owner;
ALTER FUNCTION authn.consume_trainer_login_attempt(bytea,bytea)
  OWNER TO trainercrm_login_rate_owner;
REVOKE CREATE ON SCHEMA authn FROM trainercrm_login_rate_owner;

COMMIT;
