\set ON_ERROR_STOP on

INSERT INTO booking.tenants (id, public_slug) VALUES
 ('11000000-0000-4000-8000-000000000001','appointment-one'),
 ('11000000-0000-4000-8000-000000000002','appointment-two');
INSERT INTO booking.auth_subjects (id,role,synthetic_phone_ref) VALUES
 ('12000000-0000-4000-8000-000000000001','trainer','synthetic:appointment_one'),
 ('12000000-0000-4000-8000-000000000002','trainer','synthetic:appointment_two');
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
 ('14000000-0000-4000-8000-000000000003','12000000-0000-4000-8000-000000000001',decode(repeat('33',32),'hex'),transaction_timestamp()-interval '2 days',transaction_timestamp()-interval '2 days',transaction_timestamp()-interval '1 day',transaction_timestamp()+interval '1 day'),
 ('14000000-0000-4000-8000-000000000004','12000000-0000-4000-8000-000000000001',decode(repeat('44',32),'hex'),transaction_timestamp(),transaction_timestamp(),transaction_timestamp()+interval '1 day',transaction_timestamp()+interval '2 days');
UPDATE authn.trainer_sessions SET revoked_at=transaction_timestamp(),revoke_reason='test'
 WHERE id='14000000-0000-4000-8000-000000000004';
INSERT INTO booking.clients (id,tenant_id,trainer_id,display_name,starting_weight) VALUES
 ('21000000-0000-4000-8000-000000000001','11000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','Client one',70),
 ('21000000-0000-4000-8000-000000000002','11000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000002','Client two',80);

DO $security$
DECLARE v_count integer;
BEGIN
  IF (SELECT pg_get_userbyid(proowner)
        FROM pg_proc
       WHERE oid = 'booking.list_trainer_clients(bytea)'::regprocedure) <>
       'trainercrm_clients_function_owner' OR
     (SELECT pg_get_userbyid(proowner)
        FROM pg_proc
       WHERE oid = 'booking.create_trainer_client(bytea,text,numeric)'::regprocedure) <>
       'trainercrm_clients_function_owner' OR
     NOT has_function_privilege(
       'trainercrm_app','booking.list_trainer_clients(bytea)','EXECUTE'
     ) OR
     NOT has_function_privilege(
       'trainercrm_app','booking.create_trainer_client(bytea,text,numeric)','EXECUTE'
     ) OR
     has_function_privilege(
       'public','booking.list_trainer_clients(bytea)','EXECUTE'
     ) OR
     has_function_privilege(
       'public','booking.create_trainer_client(bytea,text,numeric)','EXECUTE'
     ) THEN
    RAISE EXCEPTION 'migration 012 changed migration 011 function ownership or privileges';
  END IF;
  IF has_table_privilege('trainercrm_app','booking.trainer_appointments','SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'application role has appointment table DML';
  END IF;
  IF has_function_privilege('public','booking.create_trainer_appointment(bytea,uuid,timestamptz,timestamptz)','EXECUTE') OR
     has_schema_privilege('trainercrm_clients_function_owner','booking','CREATE') OR
     has_table_privilege('trainercrm_clients_function_owner','booking.trainer_appointments','DELETE') THEN
    RAISE EXCEPTION 'unsafe runtime privileges';
  END IF;
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE n.nspname IN ('booking','authn') AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='trainercrm_app') AND a.privilege_type='EXECUTE';
  IF v_count <> 10 THEN RAISE EXCEPTION 'unexpected app executable count %',v_count; END IF;
END $security$;

SET ROLE trainercrm_app;
DO $tests$
DECLARE a1 uuid; a2 uuid; n integer;
BEGIN
  SELECT id INTO STRICT a1 FROM booking.create_trainer_appointment(decode(repeat('11',32),'hex'),'21000000-0000-4000-8000-000000000001','2030-01-01 10:00Z','2030-01-01 11:00Z');
  SELECT count(*) INTO n FROM booking.list_trainer_appointments(decode(repeat('11',32),'hex'),'2030-01-01 00:00Z','2030-01-02 00:00Z') WHERE appointment_id=a1;
  IF n<>1 THEN RAISE EXCEPTION 'owner cannot list appointment'; END IF;
  SELECT count(*) INTO n FROM booking.list_trainer_appointments(decode(repeat('22',32),'hex'),'2030-01-01 00:00Z','2030-01-02 00:00Z') WHERE appointment_id=a1;
  IF n<>0 THEN RAISE EXCEPTION 'cross-trainer list leak'; END IF;
  BEGIN PERFORM booking.create_trainer_appointment(decode(repeat('11',32),'hex'),'21000000-0000-4000-8000-000000000002','2030-01-01 12:00Z','2030-01-01 13:00Z'); RAISE EXCEPTION 'foreign client accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'APPOINTMENT_NOT_FOUND' THEN RAISE; END IF; END;
  BEGIN PERFORM booking.create_trainer_appointment(decode(repeat('11',32),'hex'),'21000000-0000-4000-8000-000000000001','2030-01-01 10:30Z','2030-01-01 11:30Z'); RAISE EXCEPTION 'overlap accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'APPOINTMENT_CONFLICT' THEN RAISE; END IF; END;
  SELECT id INTO STRICT a2 FROM booking.create_trainer_appointment(decode(repeat('11',32),'hex'),'21000000-0000-4000-8000-000000000001','2030-01-01 12:00Z','2030-01-01 13:00Z');
  BEGIN PERFORM booking.reschedule_trainer_appointment(decode(repeat('11',32),'hex'),a2,'2030-01-01 10:30Z','2030-01-01 12:30Z'); RAISE EXCEPTION 'conflicting reschedule accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'APPOINTMENT_CONFLICT' THEN RAISE; END IF; END;
  PERFORM booking.reschedule_trainer_appointment(decode(repeat('11',32),'hex'),a2,'2030-01-01 13:00Z','2030-01-01 14:00Z');
  PERFORM booking.cancel_trainer_appointment(decode(repeat('11',32),'hex'),a1);
  SELECT id INTO STRICT a1 FROM booking.create_trainer_appointment(decode(repeat('11',32),'hex'),'21000000-0000-4000-8000-000000000001','2030-01-01 10:00Z','2030-01-01 11:00Z');
  BEGIN PERFORM booking.cancel_trainer_appointment(decode(repeat('22',32),'hex'),a1); RAISE EXCEPTION 'foreign cancel accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'APPOINTMENT_NOT_FOUND' THEN RAISE; END IF; END;
  BEGIN PERFORM booking.reschedule_trainer_appointment(decode(repeat('22',32),'hex'),a1,'2030-01-02 10:00Z','2030-01-02 11:00Z'); RAISE EXCEPTION 'foreign reschedule accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'APPOINTMENT_NOT_FOUND' THEN RAISE; END IF; END;
  BEGIN PERFORM booking.list_trainer_appointments(decode(repeat('33',32),'hex'),'2030-01-01 00:00Z','2030-01-02 00:00Z'); RAISE EXCEPTION 'expired session accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'UNAUTHORIZED' THEN RAISE; END IF; END;
  BEGIN PERFORM booking.list_trainer_appointments(decode(repeat('44',32),'hex'),'2030-01-01 00:00Z','2030-01-02 00:00Z'); RAISE EXCEPTION 'revoked session accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'UNAUTHORIZED' THEN RAISE; END IF; END;
END $tests$;
RESET ROLE;

DO $history$
BEGIN
 IF (SELECT count(*) FROM booking.trainer_appointments WHERE status='cancelled' AND cancelled_at IS NOT NULL)<>1 THEN
   RAISE EXCEPTION 'cancelled history not retained';
 END IF;
END $history$;
SELECT 'PASS: appointment creation, listing, isolation, rescheduling, cancellation, expiry, and conflicts';
