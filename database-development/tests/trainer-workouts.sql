\set ON_ERROR_STOP on

INSERT INTO booking.tenants (id, public_slug) VALUES
 ('11000000-0000-4000-8000-000000000001','workout-one'),
 ('11000000-0000-4000-8000-000000000002','workout-two');
INSERT INTO booking.auth_subjects (id,role,synthetic_phone_ref) VALUES
 ('12000000-0000-4000-8000-000000000001','trainer','synthetic:workout_one'),
 ('12000000-0000-4000-8000-000000000002','trainer','synthetic:workout_two');
INSERT INTO booking.trainer_memberships (tenant_id,trainer_id) VALUES
 ('11000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001'),
 ('11000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000002');
INSERT INTO authn.email_identities (id,subject_id,normalization_version,canonical_email,display_email,verified_at) VALUES
 ('13000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001',1,'one@example.invalid','one@example.invalid',transaction_timestamp()),
 ('13000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000002',1,'two@example.invalid','two@example.invalid',transaction_timestamp());
INSERT INTO authn.trainer_password_credentials (trainer_subject_id,email_identity_id,password_hash) VALUES
 ('12000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','$scrypt$fixture-password-hash-value-0001'),
 ('12000000-0000-4000-8000-000000000002','13000000-0000-4000-8000-000000000002','$scrypt$fixture-password-hash-value-0002');
INSERT INTO authn.trainer_sessions (id,trainer_subject_id,token_sha256_digest,created_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES
 ('14000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001',decode(repeat('11',32),'hex'),transaction_timestamp(),transaction_timestamp(),transaction_timestamp()+interval '1 day',transaction_timestamp()+interval '2 days'),
 ('14000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000002',decode(repeat('22',32),'hex'),transaction_timestamp(),transaction_timestamp(),transaction_timestamp()+interval '1 day',transaction_timestamp()+interval '2 days'),
 ('14000000-0000-4000-8000-000000000003','12000000-0000-4000-8000-000000000001',decode(repeat('33',32),'hex'),transaction_timestamp()-interval '2 days',transaction_timestamp()-interval '2 days',transaction_timestamp()-interval '1 day',transaction_timestamp()+interval '1 day');
INSERT INTO booking.clients (id,tenant_id,trainer_id,display_name,starting_weight) VALUES
 ('21000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','Client one',70),
 ('21000000-0000-4000-8000-000000000003','11000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','Client three',75),
 ('21000000-0000-4000-8000-000000000002','11000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000002','Client two',80);
INSERT INTO booking.trainer_appointments (id,tenant_id,trainer_id,client_id,starts_at,ends_at) VALUES
 ('22000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','2030-01-01 10:00Z','2030-01-01 11:00Z'),
 ('22000000-0000-4000-8000-000000000002','11000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000002','21000000-0000-4000-8000-000000000002','2030-01-01 10:00Z','2030-01-01 11:00Z');

DO $security$
DECLARE v_count integer;
BEGIN
  IF has_table_privilege('trainercrm_app','booking.trainer_workouts','SELECT,INSERT,UPDATE,DELETE') OR
     has_table_privilege('trainercrm_app','booking.workout_exercises','SELECT,INSERT,UPDATE,DELETE') OR
     has_table_privilege('trainercrm_app','booking.workout_sets','SELECT,INSERT,UPDATE,DELETE') OR
     has_function_privilege('public','booking.create_trainer_workout(bytea,uuid,uuid,date,time,text,boolean,numeric,jsonb)','EXECUTE') OR
     has_schema_privilege('trainercrm_clients_function_owner','booking','CREATE') OR
     has_table_privilege('trainercrm_clients_function_owner','booking.trainer_workouts','DELETE') THEN
    RAISE EXCEPTION 'unsafe workout runtime privileges';
  END IF;
  IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid='booking.create_trainer_workout(bytea,uuid,uuid,date,time,text,boolean,numeric,jsonb)'::regprocedure)) <> 'trainercrm_clients_function_owner' THEN
    RAISE EXCEPTION 'unsafe workout function owner';
  END IF;
  IF NOT has_function_privilege('trainercrm_app','booking.list_trainer_clients(bytea)','EXECUTE') OR
     NOT has_function_privilege('trainercrm_app','booking.create_trainer_appointment(bytea,uuid,timestamptz,timestamptz)','EXECUTE') THEN
    RAISE EXCEPTION 'migration 013 changed migration 011/012 privileges';
  END IF;
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE n.nspname IN ('booking','authn') AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='trainercrm_app') AND a.privilege_type='EXECUTE';
  IF v_count <> 14 THEN RAISE EXCEPTION 'unexpected app executable count %',v_count; END IF;
END
$security$;

SET ROLE trainercrm_app;
DO $tests$
DECLARE w uuid; n integer; doc jsonb;
BEGIN
  SELECT (workout->>'id')::uuid INTO STRICT w FROM booking.create_trainer_workout(
    decode(repeat('11',32),'hex'),'21000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000001','2030-01-01','10:00','Personal',false,NULL,
    '[{"name":"Squat","sets":[{"weight":40.5,"reps":12},{"weight":45,"reps":10}]}]'::jsonb);
  SELECT workout INTO STRICT doc FROM booking.get_trainer_workout(decode(repeat('11',32),'hex'),w);
  IF doc->>'clientName'<>'Client one' OR
     (doc->>'appointmentId')::uuid<>'22000000-0000-4000-8000-000000000001'::uuid OR
     jsonb_array_length(doc->'exercises')<>1 OR
     jsonb_array_length(doc->'exercises'->0->'sets')<>2 THEN RAISE EXCEPTION 'aggregate did not persist'; END IF;
  SELECT count(*) INTO n FROM booking.list_trainer_workouts(decode(repeat('22',32),'hex'),NULL) WHERE (workout->>'id')::uuid=w;
  IF n<>0 THEN RAISE EXCEPTION 'cross-trainer list leak'; END IF;
  BEGIN PERFORM booking.get_trainer_workout(decode(repeat('22',32),'hex'),w); RAISE EXCEPTION 'cross-trainer read accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'WORKOUT_NOT_FOUND' THEN RAISE; END IF; END;
  BEGIN PERFORM booking.update_trainer_workout(decode(repeat('22',32),'hex'),w,'21000000-0000-4000-8000-000000000002',NULL,'2030-01-02','11:00','Foreign',true,1,'[]'); RAISE EXCEPTION 'cross-trainer update accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'WORKOUT_NOT_FOUND' THEN RAISE; END IF; END;
  BEGIN PERFORM booking.create_trainer_workout(decode(repeat('11',32),'hex'),'21000000-0000-4000-8000-000000000002',NULL,'2030-01-02','11:00','Foreign',false,NULL,'[]'); RAISE EXCEPTION 'foreign client accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'WORKOUT_NOT_FOUND' THEN RAISE; END IF; END;
  BEGIN PERFORM booking.create_trainer_workout(decode(repeat('11',32),'hex'),'21000000-0000-4000-8000-000000000003','22000000-0000-4000-8000-000000000001','2030-01-02','11:00','Wrong client appointment',false,NULL,'[]'); RAISE EXCEPTION 'wrong-client appointment accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'WORKOUT_NOT_FOUND' THEN RAISE; END IF; END;
  BEGIN PERFORM booking.create_trainer_workout(decode(repeat('11',32),'hex'),'21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000002','2030-01-02','11:00','Foreign appointment',false,NULL,'[]'); RAISE EXCEPTION 'foreign appointment accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'WORKOUT_NOT_FOUND' THEN RAISE; END IF; END;
  PERFORM booking.update_trainer_workout(decode(repeat('11',32),'hex'),w,'21000000-0000-4000-8000-000000000001',NULL,'2030-01-02','11:30','Updated',true,250,'[{"name":"Press","sets":[{"weight":20,"reps":8}]}]');
  SELECT workout INTO STRICT doc FROM booking.get_trainer_workout(decode(repeat('11',32),'hex'),w);
  IF doc->>'type'<>'Updated' OR (doc->>'completed')::boolean IS NOT TRUE OR doc->'exercises'->0->>'name'<>'Press' THEN RAISE EXCEPTION 'update did not persist'; END IF;
  BEGIN PERFORM booking.create_trainer_workout(decode(repeat('11',32),'hex'),'21000000-0000-4000-8000-000000000001',NULL,'2030-01-02','11:00','Bad',false,NULL,'[{"name":"x","sets":[{"weight":1001,"reps":1}]}]'); RAISE EXCEPTION 'malformed aggregate accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN IF SQLERRM<>'WORKOUT_INPUT_INVALID' THEN RAISE; END IF; END;
  BEGIN PERFORM booking.list_trainer_workouts(decode(repeat('33',32),'hex'),NULL); RAISE EXCEPTION 'expired session accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'UNAUTHORIZED' THEN RAISE; END IF; END;
END
$tests$;
RESET ROLE;

SELECT 'PASS: workout persistence, replacement update, sessions, ownership, appointment linkage, and validation';
