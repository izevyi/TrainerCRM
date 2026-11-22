\set ON_ERROR_STOP on

DO $security$
BEGIN
  IF pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='booking.trainer_weight_measurements'::regclass)) <> 'trainercrm_clients_function_owner' OR
     pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid='booking.write_trainer_weight_measurement(bytea,uuid,uuid,date,numeric)'::regprocedure)) <> 'trainercrm_clients_function_owner' OR
     has_table_privilege('trainercrm_app','booking.trainer_weight_measurements','SELECT') OR
     has_table_privilege('trainercrm_app','booking.trainer_weight_measurements','INSERT') OR
     has_table_privilege('trainercrm_app','booking.trainer_weight_measurements','DELETE') OR
     has_function_privilege('public','booking.list_trainer_weight_measurements(bytea,uuid)','EXECUTE') OR
     has_schema_privilege('trainercrm_clients_function_owner','booking','CREATE') THEN
    RAISE EXCEPTION 'weight history privileges unsafe';
  END IF;
END
$security$;

SET ROLE trainercrm_app;
DO $test$
DECLARE
  v_id uuid;
  n integer;
  v_weight numeric;
BEGIN
  SELECT count(*) INTO n FROM booking.list_trainer_weight_measurements(
    decode(repeat('11',32),'hex'), '21000000-0000-4000-8000-000000000001');
  IF n <> 0 THEN RAISE EXCEPTION 'expected empty weight history'; END IF;

  SELECT measurement_id INTO STRICT v_id FROM booking.write_trainer_weight_measurement(
    decode(repeat('11',32),'hex'), '21000000-0000-4000-8000-000000000001', NULL, '2030-01-01',70.5);
  SELECT weight INTO STRICT v_weight FROM booking.list_trainer_weight_measurements(
    decode(repeat('11',32),'hex'), '21000000-0000-4000-8000-000000000001');
  IF v_weight <> 70.5 THEN RAISE EXCEPTION 'saved measurement mismatch'; END IF;

  -- A different trainer cannot even enumerate the other trainer's client history.
  BEGIN
    PERFORM booking.list_trainer_weight_measurements(decode(repeat('22',32),'hex'), '21000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'cross-trainer list accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'WEIGHT_CLIENT_NOT_FOUND' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM booking.write_trainer_weight_measurement(decode(repeat('22',32),'hex'), '21000000-0000-4000-8000-000000000001', NULL, '2030-01-02', 80);
    RAISE EXCEPTION 'cross-trainer write accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'WEIGHT_CLIENT_NOT_FOUND' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM booking.write_trainer_weight_measurement(decode(repeat('22',32),'hex'), '21000000-0000-4000-8000-000000000002', v_id, '2030-01-02', 80);
    RAISE EXCEPTION 'cross-trainer update accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'WEIGHT_NOT_FOUND' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM booking.delete_trainer_weight_measurement(decode(repeat('22',32),'hex'), '21000000-0000-4000-8000-000000000002', v_id);
    RAISE EXCEPTION 'cross-trainer delete accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'WEIGHT_NOT_FOUND' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM booking.write_trainer_weight_measurement(decode(repeat('11',32),'hex'), '21000000-0000-4000-8000-000000000001', NULL, '2030-01-01', 71);
    RAISE EXCEPTION 'duplicate date accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    PERFORM booking.list_trainer_weight_measurements(decode(repeat('33',32),'hex'), '21000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'expired session accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'UNAUTHORIZED' THEN RAISE; END IF;
  END;

  SELECT weight INTO STRICT v_weight FROM booking.write_trainer_weight_measurement(
    decode(repeat('11',32),'hex'), '21000000-0000-4000-8000-000000000001', v_id, '2030-01-02', 69.25);
  IF v_weight <> 69.25 THEN RAISE EXCEPTION 'update did not persist'; END IF;
  PERFORM booking.delete_trainer_weight_measurement(
    decode(repeat('11',32),'hex'), '21000000-0000-4000-8000-000000000001', v_id);
  SELECT count(*) INTO n FROM booking.list_trainer_weight_measurements(
    decode(repeat('11',32),'hex'), '21000000-0000-4000-8000-000000000001');
  IF n <> 0 THEN RAISE EXCEPTION 'deleted measurement still listed'; END IF;
END
$test$;
RESET ROLE;
SELECT 'PASS: isolated trainer weight create/list/update/delete, conflict, session, ownership';
