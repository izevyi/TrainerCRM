BEGIN;

-- Independent, durable caps for public email registration. Login remains
-- on migration 014's more generous (30/min) login-specific limits.
-- All identifiers are 32-byte HMACs derived server-side; no IP/email stored.
DO $preflight$
DECLARE r pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_catalog.pg_roles
   WHERE rolname = 'trainercrm_registration_owner';
  IF NOT FOUND OR r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR
     r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls THEN
    RAISE EXCEPTION 'isolated registration owner required';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'trainercrm_registration_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'migration operator requires registration owner membership';
  END IF;
END
$preflight$;

CREATE TABLE authn.trainer_registration_rate_buckets (
  key_digest bytea PRIMARY KEY CHECK (octet_length(key_digest)=32),
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count > 0)
);
CREATE INDEX trainer_registration_rate_started_idx
  ON authn.trainer_registration_rate_buckets(window_started_at);
REVOKE ALL ON authn.trainer_registration_rate_buckets FROM PUBLIC, trainercrm_app;

-- Each attempt consumes all three atomic buckets. Windows are rolling from
-- the first attempt in the bucket (not calendar-hour/calendar-day boundaries).
-- One IP: <=5/hour; one recipient email: <=3/24h across all IPs;
-- site-wide: <=30/24h to bound SMTP volume even with distributed IPs.
CREATE FUNCTION authn.consume_trainer_registration_attempt(
  p_ip_digest bytea, p_email_digest bytea, p_global_digest bytea
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,authn
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_ip integer;
  v_email integer;
  v_global integer;
BEGIN
  IF p_ip_digest IS NULL OR p_email_digest IS NULL OR p_global_digest IS NULL OR
     octet_length(p_ip_digest) <> 32 OR octet_length(p_email_digest) <> 32 OR
     octet_length(p_global_digest) <> 32 OR p_ip_digest=p_email_digest OR
     p_ip_digest=p_global_digest OR p_email_digest=p_global_digest THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='REGISTRATION_RATE_INPUT_INVALID';
  END IF;

  IF random() < 0.01 AND pg_try_advisory_xact_lock(128394, 17) THEN
    DELETE FROM authn.trainer_registration_rate_buckets
     WHERE window_started_at < v_now - interval '48 hours';
  END IF;

  INSERT INTO authn.trainer_registration_rate_buckets AS b
    (key_digest,window_started_at,attempt_count)
  VALUES(p_ip_digest,v_now,1)
  ON CONFLICT (key_digest) DO UPDATE SET
    attempt_count=CASE WHEN b.window_started_at <= v_now-interval '1 hour'
      THEN 1 ELSE b.attempt_count+1 END,
    window_started_at=CASE WHEN b.window_started_at <= v_now-interval '1 hour'
      THEN v_now ELSE b.window_started_at END
  RETURNING attempt_count INTO v_ip;

  INSERT INTO authn.trainer_registration_rate_buckets AS b
    (key_digest,window_started_at,attempt_count)
  VALUES(p_email_digest,v_now,1)
  ON CONFLICT (key_digest) DO UPDATE SET
    attempt_count=CASE WHEN b.window_started_at <= v_now-interval '24 hours'
      THEN 1 ELSE b.attempt_count+1 END,
    window_started_at=CASE WHEN b.window_started_at <= v_now-interval '24 hours'
      THEN v_now ELSE b.window_started_at END
  RETURNING attempt_count INTO v_email;

  INSERT INTO authn.trainer_registration_rate_buckets AS b
    (key_digest,window_started_at,attempt_count)
  VALUES(p_global_digest,v_now,1)
  ON CONFLICT (key_digest) DO UPDATE SET
    attempt_count=CASE WHEN b.window_started_at <= v_now-interval '24 hours'
      THEN 1 ELSE b.attempt_count+1 END,
    window_started_at=CASE WHEN b.window_started_at <= v_now-interval '24 hours'
      THEN v_now ELSE b.window_started_at END
  RETURNING attempt_count INTO v_global;

  RETURN v_ip <= 5 AND v_email <= 3 AND v_global <= 30;
END
$function$;

REVOKE ALL ON FUNCTION authn.consume_trainer_registration_attempt(bytea,bytea,bytea)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authn.consume_trainer_registration_attempt(bytea,bytea,bytea)
  TO trainercrm_app;

GRANT CREATE ON SCHEMA authn TO trainercrm_registration_owner;
ALTER TABLE authn.trainer_registration_rate_buckets
  OWNER TO trainercrm_registration_owner;
ALTER FUNCTION authn.consume_trainer_registration_attempt(bytea,bytea,bytea)
  OWNER TO trainercrm_registration_owner;
REVOKE CREATE ON SCHEMA authn FROM trainercrm_registration_owner;

COMMIT;
