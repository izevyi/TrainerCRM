\set ON_ERROR_STOP on

DO $tests$
DECLARE
  h text := '$scrypt$v=1$N=16384,r=8,p=1$abcdefghijklmnopqrstuv$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN';
  d1 bytea := decode(repeat('a',64),'hex');
  d2 bytea := decode(repeat('b',64),'hex');
  d3 bytea := decode(repeat('c',64),'hex');
  trainer uuid;
  tenant uuid;
BEGIN
  IF NOT authn.begin_trainer_registration('new-one@example.test',h,d1) THEN
    RAISE EXCEPTION 'new registration was not created';
  END IF;
  IF authn.begin_trainer_registration('new-one@example.test',h,d2) THEN
    RAISE EXCEPTION 'cooldown did not block resend';
  END IF;
  IF (SELECT count(*) FROM authn.email_identities)<>0 THEN
    RAISE EXCEPTION 'unverified registration created an identity';
  END IF;
  IF EXISTS (SELECT 1 FROM authn.complete_trainer_registration(d2)) THEN
    RAISE EXCEPTION 'wrong token was accepted';
  END IF;
  SELECT r.trainer_id,r.tenant_id INTO trainer,tenant
    FROM authn.complete_trainer_registration(d1) r;
  IF trainer IS NULL OR tenant IS NULL THEN
    RAISE EXCEPTION 'verification failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM booking.trainer_memberships m
    JOIN booking.tenants t ON t.id=m.tenant_id
    JOIN booking.auth_subjects s ON s.id=m.trainer_id
    JOIN authn.email_identities e ON e.subject_id=s.id
    JOIN authn.trainer_password_credentials c ON c.trainer_subject_id=s.id
    WHERE m.trainer_id=trainer AND m.tenant_id=tenant AND s.role='trainer'
      AND e.canonical_email='new-one@example.test'
      AND c.password_hash=h
  ) THEN RAISE EXCEPTION 'registration did not create complete account'; END IF;
  IF EXISTS(SELECT 1 FROM authn.complete_trainer_registration(d1)) THEN
    RAISE EXCEPTION 'link replay was accepted';
  END IF;
  IF authn.begin_trainer_registration('new-one@example.test',h,d2) THEN
    RAISE EXCEPTION 'existing verified email accepted';
  END IF;
  IF NOT authn.begin_trainer_registration('new-two@example.test',h,d3) THEN
    RAISE EXCEPTION 'second registration failed';
  END IF;
  IF EXISTS (SELECT 1 FROM authn.complete_trainer_registration(decode(repeat('d',64),'hex'))) THEN
    RAISE EXCEPTION 'invalid token was accepted';
  END IF;
  UPDATE authn.trainer_registration_pending
     SET created_at=transaction_timestamp()-interval '2 days',
         expires_at=transaction_timestamp()-interval '1 day'
   WHERE canonical_email='new-two@example.test';
  IF EXISTS (SELECT 1 FROM authn.complete_trainer_registration(d3)) THEN
    RAISE EXCEPTION 'expired link was accepted';
  END IF;
  IF (SELECT count(*) FROM authn.email_identities)<>1 THEN
    RAISE EXCEPTION 'wrong number of verified identities';
  END IF;
  IF (SELECT count(*) FROM authn.trainer_registration_pending)<>1 THEN
    RAISE EXCEPTION 'wrong number of pending requests';
  END IF;
  RAISE NOTICE 'PASS: verified-only identities, account creation, cooldown, replay and duplicate protection';
END
$tests$;

DO $permissions$
BEGIN
 IF has_table_privilege('trainercrm_app','authn.trainer_registration_pending','SELECT') OR
    has_table_privilege('trainercrm_app','authn.trainer_registration_pending','INSERT') OR
    has_table_privilege('trainercrm_app','authn.email_identities','INSERT') OR
    has_table_privilege('trainercrm_app','authn.trainer_password_credentials','SELECT') OR
    has_table_privilege('trainercrm_app','booking.tenants','INSERT') OR
    has_schema_privilege('trainercrm_registration_owner','authn','CREATE') THEN
   RAISE EXCEPTION 'registration grants are too broad';
 END IF;
 IF NOT has_function_privilege('trainercrm_app','authn.begin_trainer_registration(text,text,bytea)','EXECUTE') OR
    NOT has_function_privilege('trainercrm_app','authn.complete_trainer_registration(bytea)','EXECUTE') THEN
   RAISE EXCEPTION 'registration functions unavailable to app';
 END IF;
 IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='authn.trainer_registration_pending'::regclass)
    <> 'trainercrm_registration_owner' THEN
   RAISE EXCEPTION 'registration table owner mismatch';
 END IF;
 RAISE NOTICE 'PASS: minimal permissions and isolated function owner';
END
$permissions$;

SET ROLE trainercrm_app;
DO $runtime$
DECLARE h text := '$scrypt$v=1$N=16384,r=8,p=1$abcdefghijklmnopqrstuv$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN';
BEGIN
 IF NOT authn.begin_trainer_registration('from-app@example.test',h,decode(repeat('e',64),'hex')) THEN
   RAISE EXCEPTION 'app cannot execute registration function';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM authn.complete_trainer_registration(decode(repeat('e',64),'hex'))) THEN
   RAISE EXCEPTION 'app cannot verify registration';
 END IF;
 RAISE NOTICE 'PASS: app registration functions execute without direct table privileges';
END
$runtime$;
RESET ROLE;

DO $isolation$
BEGIN
 IF (SELECT count(*) FROM booking.trainer_memberships)<>2 OR
    (SELECT count(DISTINCT tenant_id) FROM booking.trainer_memberships)<>2 OR
    (SELECT count(DISTINCT trainer_id) FROM booking.trainer_memberships)<>2 THEN
   RAISE EXCEPTION 'registration did not create isolated tenant and trainer IDs';
 END IF;
 RAISE NOTICE 'PASS: each verified trainer receives separate tenant and subject';
END
$isolation$;
