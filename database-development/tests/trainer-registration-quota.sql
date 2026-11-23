\set ON_ERROR_STOP on

DO $privileges$
BEGIN
 IF has_table_privilege('trainercrm_app','authn.trainer_registration_rate_buckets','SELECT') OR
    has_table_privilege('trainercrm_app','authn.trainer_registration_rate_buckets','UPDATE') OR
    NOT has_function_privilege('trainercrm_app','authn.consume_trainer_registration_attempt(bytea,bytea,bytea)','EXECUTE') OR
    has_schema_privilege('trainercrm_registration_owner','authn','CREATE') OR
    (SELECT pg_get_userbyid(relowner) FROM pg_class
       WHERE oid='authn.trainer_registration_rate_buckets'::regclass)
      <> 'trainercrm_registration_owner' THEN
   RAISE EXCEPTION 'registration quota privileges are unsafe';
 END IF;
 RAISE NOTICE 'PASS: quota owner and application permissions';
END $privileges$;

SET ROLE trainercrm_app;
DO $per_ip$
DECLARE i integer; got boolean;
BEGIN
 FOR i IN 1..6 LOOP
   SELECT authn.consume_trainer_registration_attempt(
     decode(repeat('a',64),'hex'),
     decode('b1'||lpad(to_hex(i),62,'0'),'hex'),
     decode(repeat('c',64),'hex')) INTO got;
   IF got IS DISTINCT FROM (i <= 5) THEN
     RAISE EXCEPTION 'hourly IP quota failed at %: %',i,got;
   END IF;
 END LOOP;
 RAISE NOTICE 'PASS: maximum 5 attempts per IP per hour';
END $per_ip$;
RESET ROLE;

SET ROLE trainercrm_registration_owner;
TRUNCATE authn.trainer_registration_rate_buckets;
RESET ROLE;

SET ROLE trainercrm_app;
DO $email$
DECLARE i integer; got boolean;
BEGIN
 FOR i IN 1..4 LOOP
   SELECT authn.consume_trainer_registration_attempt(
     decode('a1'||lpad(to_hex(i),62,'0'),'hex'),
     decode(repeat('b',64),'hex'),
     decode(repeat('c',64),'hex')) INTO got;
   IF got IS DISTINCT FROM (i <= 3) THEN
     RAISE EXCEPTION 'recipient daily quota failed at %: %',i,got;
   END IF;
 END LOOP;
 RAISE NOTICE 'PASS: maximum 3 attempts per email per 24 hours across IPs';
END $email$;
RESET ROLE;

SET ROLE trainercrm_registration_owner;
TRUNCATE authn.trainer_registration_rate_buckets;
RESET ROLE;

SET ROLE trainercrm_app;
DO $global$
DECLARE i integer; got boolean;
BEGIN
 FOR i IN 1..31 LOOP
   SELECT authn.consume_trainer_registration_attempt(
     decode('a1'||lpad(to_hex(i),62,'0'),'hex'),
     decode('b1'||lpad(to_hex(i),62,'0'),'hex'),
     decode(repeat('c',64),'hex')) INTO got;
   IF got IS DISTINCT FROM (i <= 30) THEN
     RAISE EXCEPTION 'global daily quota failed at %: %',i,got;
   END IF;
 END LOOP;
 RAISE NOTICE 'PASS: site-wide maximum 30 attempts per 24 hours';
END $global$;
RESET ROLE;

SET ROLE trainercrm_registration_owner;
UPDATE authn.trainer_registration_rate_buckets
 SET window_started_at = clock_timestamp() - interval '25 hours';
RESET ROLE;

SET ROLE trainercrm_app;
DO $reset$
DECLARE got boolean;
BEGIN
  SELECT authn.consume_trainer_registration_attempt(
     decode('a1'||lpad(to_hex(1),62,'0'),'hex'),
     decode('b1'||lpad(to_hex(1),62,'0'),'hex'),
     decode(repeat('c',64),'hex')) INTO got;
  IF got IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'expired quota buckets did not reset';
  END IF;
  BEGIN
    PERFORM authn.consume_trainer_registration_attempt(
      decode(repeat('b',64),'hex'), decode(repeat('b',64),'hex'), decode(repeat('c',64),'hex'));
    RAISE EXCEPTION 'equal digests should be rejected';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  RAISE NOTICE 'PASS: quota expiry and invalid-input rejection';
END $reset$;
RESET ROLE;
