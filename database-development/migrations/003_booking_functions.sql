BEGIN;

CREATE FUNCTION booking.validate_client_identity_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, booking
AS $function$
BEGIN
  IF NEW.auth_subject_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM booking.auth_subjects AS a
     WHERE a.id = NEW.auth_subject_id AND a.role = 'client'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CLIENT_IDENTITY_ROLE_INVALID';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER clients_validate_identity_role
BEFORE INSERT OR UPDATE OF auth_subject_id ON booking.clients
FOR EACH ROW EXECUTE FUNCTION booking.validate_client_identity_role();

CREATE FUNCTION booking.validate_trainer_membership_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, booking
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM booking.auth_subjects AS a
     WHERE a.id = NEW.trainer_id AND a.role = 'trainer'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TRAINER_IDENTITY_ROLE_INVALID';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trainer_memberships_validate_identity_role
BEFORE INSERT OR UPDATE OF trainer_id ON booking.trainer_memberships
FOR EACH ROW EXECUTE FUNCTION booking.validate_trainer_membership_role();

CREATE FUNCTION booking.set_authoritative_booking_period()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, booking
AS $function$
DECLARE
  v_period tstzrange;
  v_client_subject uuid;
  v_client_status booking.client_status;
BEGIN
  SELECT tstzrange(s.starts_at, s.ends_at, '[)')
    INTO STRICT v_period
    FROM booking.availability_slots AS s
   WHERE s.id = NEW.slot_id AND s.tenant_id = NEW.tenant_id;

  SELECT c.auth_subject_id, c.status
    INTO STRICT v_client_subject, v_client_status
    FROM booking.clients AS c
   WHERE c.id = NEW.client_id
     AND c.tenant_id = NEW.tenant_id;

  IF v_client_subject IS DISTINCT FROM NEW.auth_subject_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ACTOR_CLIENT_MISMATCH';
  END IF;
  IF TG_OP = 'INSERT' AND v_client_status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CLIENT_INACTIVE';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1
      FROM booking.invitations AS i
      JOIN booking.auth_subjects AS a ON a.id = i.auth_subject_id
     WHERE i.tenant_id = NEW.tenant_id
       AND i.client_id = NEW.client_id
       AND i.auth_subject_id = NEW.auth_subject_id
       AND i.synthetic_phone_ref = a.synthetic_phone_ref
       AND i.status = 'accepted'
       AND i.accepted_at IS NOT NULL
       AND i.expires_at >= i.accepted_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVITE_INVALID';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.slot_id IS DISTINCT FROM OLD.slot_id OR
    NEW.client_id IS DISTINCT FROM OLD.client_id OR
    NEW.auth_subject_id IS DISTINCT FROM OLD.auth_subject_id OR
    NEW.seat IS DISTINCT FROM OLD.seat OR
    NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
    NEW.request_hash IS DISTINCT FROM OLD.request_hash OR
    NEW.booked_period IS DISTINCT FROM OLD.booked_period
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'BOOKING_IMMUTABLE_FIELDS';
  END IF;

  NEW.booked_period := v_period;
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END
$function$;

CREATE TRIGGER bookings_authoritative_period
BEFORE INSERT OR UPDATE ON booking.bookings
FOR EACH ROW EXECUTE FUNCTION booking.set_authoritative_booking_period();

CREATE FUNCTION booking.book_slot(
  p_actor_subject_id uuid,
  p_client_id uuid,
  p_slot_id uuid,
  p_idempotency_key text,
  p_request_hash text
)
RETURNS TABLE (booking_id uuid, assigned_seat smallint, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, booking
AS $function$
DECLARE
  v_tenant_id uuid;
  v_subject_id uuid;
  v_slot booking.availability_slots%ROWTYPE;
  v_existing booking.bookings%ROWTYPE;
  v_seat smallint;
  v_booking_id uuid := gen_random_uuid();
  v_correlation_id uuid := gen_random_uuid();
BEGIN
  IF p_idempotency_key IS NULL OR p_request_hash IS NULL OR
     length(p_idempotency_key) NOT BETWEEN 8 AND 200 OR
     length(p_request_hash) NOT BETWEEN 32 AND 200 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_KEY_INVALID';
  END IF;

  -- Identity is always locked before a slot, serializing overlap checks across trainers.
  SELECT c.tenant_id, c.auth_subject_id
    INTO v_tenant_id, v_subject_id
    FROM booking.clients AS c
    JOIN booking.auth_subjects AS a ON a.id = c.auth_subject_id
   WHERE c.id = p_client_id
     AND c.status = 'active'
     AND a.id = p_actor_subject_id
     AND a.role = 'client'
     AND a.status = 'active'
     AND a.phone_verified_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM booking.invitations AS i
        WHERE i.tenant_id = c.tenant_id
          AND i.client_id = c.id
          AND i.auth_subject_id = a.id
          AND i.synthetic_phone_ref = a.synthetic_phone_ref
          AND i.status = 'accepted'
          AND i.accepted_at IS NOT NULL
          AND i.expires_at >= i.accepted_at
     )
   FOR UPDATE OF a, c;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FORBIDDEN';
  END IF;

  SELECT * INTO v_existing
    FROM booking.bookings AS b
   WHERE b.client_id = p_client_id AND b.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.seat, true;
    RETURN;
  END IF;

  SELECT * INTO v_slot
    FROM booking.availability_slots AS s
   WHERE s.id = p_slot_id
   FOR UPDATE;
  IF NOT FOUND OR v_slot.tenant_id <> v_tenant_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SLOT_UNAVAILABLE';
  END IF;
  IF v_slot.status <> 'open' OR v_slot.starts_at <= transaction_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SLOT_UNAVAILABLE';
  END IF;

  IF EXISTS (
    SELECT 1 FROM booking.bookings AS b
     WHERE b.slot_id = p_slot_id AND b.client_id = p_client_id AND b.status = 'confirmed'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ALREADY_BOOKED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM booking.bookings AS b
     WHERE b.auth_subject_id = p_actor_subject_id
       AND b.status = 'confirmed'
       AND b.booked_period && tstzrange(v_slot.starts_at, v_slot.ends_at, '[)')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CLIENT_TIME_CONFLICT';
  END IF;

  SELECT candidate.seat INTO v_seat
    FROM (VALUES (1::smallint), (2::smallint)) AS candidate(seat)
    LEFT JOIN booking.bookings AS b
      ON b.slot_id = p_slot_id AND b.seat = candidate.seat AND b.status = 'confirmed'
   WHERE b.id IS NULL
   ORDER BY candidate.seat
   LIMIT 1;
  IF v_seat IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SLOT_FULL';
  END IF;

  INSERT INTO booking.bookings (
    id, tenant_id, slot_id, client_id, auth_subject_id, seat, status,
    booked_period, idempotency_key, request_hash
  ) VALUES (
    v_booking_id, v_tenant_id, p_slot_id, p_client_id, p_actor_subject_id, v_seat,
    'confirmed', tstzrange(v_slot.starts_at, v_slot.ends_at, '[)'),
    p_idempotency_key, p_request_hash
  );
  INSERT INTO booking.booking_events (
    tenant_id, booking_id, slot_id, actor_subject_id, event_type, correlation_id
  ) VALUES (
    v_tenant_id, v_booking_id, p_slot_id, p_actor_subject_id,
    'booking.confirmed', v_correlation_id
  );
  RETURN QUERY SELECT v_booking_id, v_seat, false;
END
$function$;

CREATE FUNCTION booking.cancel_booking_at(
  p_actor_subject_id uuid,
  p_booking_id uuid,
  p_effective_now timestamptz
)
RETURNS TABLE (booking_id uuid, cancelled boolean, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, booking
AS $function$
DECLARE
  v_booking booking.bookings%ROWTYPE;
  v_slot_id uuid;
  v_starts_at timestamptz;
  v_correlation_id uuid := gen_random_uuid();
BEGIN
  PERFORM 1 FROM booking.auth_subjects AS a
   WHERE a.id = p_actor_subject_id AND a.role = 'client' AND a.status = 'active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FORBIDDEN';
  END IF;

  SELECT b.slot_id INTO v_slot_id
    FROM booking.bookings AS b
   WHERE b.id = p_booking_id AND b.auth_subject_id = p_actor_subject_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NOT_FOUND';
  END IF;

  -- Match trainer cancellation lock order: identity, then slot, then booking.
  SELECT s.starts_at INTO v_starts_at
    FROM booking.availability_slots AS s
   WHERE s.id = v_slot_id
   FOR UPDATE;
  SELECT b.* INTO STRICT v_booking
    FROM booking.bookings AS b
   WHERE b.id = p_booking_id AND b.auth_subject_id = p_actor_subject_id
   FOR UPDATE;
  IF v_booking.status = 'cancelled' THEN
    RETURN QUERY SELECT v_booking.id, true, true;
    RETURN;
  END IF;
  IF p_effective_now > v_starts_at - interval '24 hours' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CUTOFF_PASSED';
  END IF;

  UPDATE booking.bookings
     SET status = 'cancelled', cancelled_at = p_effective_now,
         cancelled_by = p_actor_subject_id, cancellation_reason = 'client_cancelled',
         version = version + 1
   WHERE id = p_booking_id;
  INSERT INTO booking.booking_events (
    tenant_id, booking_id, slot_id, actor_subject_id, event_type, correlation_id
  ) VALUES (
    v_booking.tenant_id, v_booking.id, v_booking.slot_id, p_actor_subject_id,
    'booking.cancelled', v_correlation_id
  );
  RETURN QUERY SELECT v_booking.id, true, false;
END
$function$;

CREATE FUNCTION booking.cancel_booking(p_actor_subject_id uuid, p_booking_id uuid)
RETURNS TABLE (booking_id uuid, cancelled boolean, replayed boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, booking
AS $function$
  SELECT * FROM booking.cancel_booking_at(p_actor_subject_id, p_booking_id, transaction_timestamp())
$function$;

CREATE FUNCTION booking.cancel_slot(
  p_actor_subject_id uuid,
  p_slot_id uuid,
  p_expected_version bigint,
  p_confirm_occupied boolean,
  p_reason text
)
RETURNS TABLE (slot_id uuid, cancelled_bookings integer, new_version bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, booking
AS $function$
DECLARE
  v_slot booking.availability_slots%ROWTYPE;
  v_count integer;
  v_correlation_id uuid := gen_random_uuid();
BEGIN
  PERFORM 1 FROM booking.auth_subjects AS a
   WHERE a.id = p_actor_subject_id AND a.role = 'trainer' AND a.status = 'active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FORBIDDEN';
  END IF;
  SELECT * INTO v_slot FROM booking.availability_slots AS s
   WHERE s.id = p_slot_id AND s.trainer_id = p_actor_subject_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NOT_FOUND';
  END IF;
  IF v_slot.version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'STALE_STATE';
  END IF;
  IF v_slot.status = 'cancelled' THEN
    RETURN QUERY SELECT v_slot.id, 0, v_slot.version;
    RETURN;
  END IF;
  SELECT count(*)::integer INTO v_count FROM booking.bookings AS b
   WHERE b.slot_id = p_slot_id AND b.status = 'confirmed';
  IF v_count > 0 AND p_confirm_occupied IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CONFIRMATION_REQUIRED', DETAIL = v_count::text;
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VALIDATION_ERROR';
  END IF;

  WITH cancelled AS (
    UPDATE booking.bookings AS b
       SET status = 'cancelled', cancelled_at = transaction_timestamp(),
           cancelled_by = p_actor_subject_id, cancellation_reason = p_reason,
           version = version + 1
     WHERE b.slot_id = p_slot_id AND b.status = 'confirmed'
     RETURNING b.tenant_id, b.id, b.slot_id
  )
  INSERT INTO booking.booking_events (
    tenant_id, booking_id, slot_id, actor_subject_id, event_type, correlation_id
  )
  SELECT c.tenant_id, c.id, c.slot_id, p_actor_subject_id, 'booking.cancelled', v_correlation_id
    FROM cancelled AS c;
  UPDATE booking.availability_slots
     SET status = 'cancelled', cancelled_at = transaction_timestamp(),
         cancelled_by = p_actor_subject_id, cancellation_reason = p_reason,
         version = version + 1
   WHERE id = p_slot_id
   RETURNING version INTO v_slot.version;
  INSERT INTO booking.booking_events (
    tenant_id, booking_id, slot_id, actor_subject_id, event_type, correlation_id,
    metadata_json
  ) VALUES (
    v_slot.tenant_id, NULL, p_slot_id, p_actor_subject_id, 'slot.cancelled',
    v_correlation_id, jsonb_build_object('cancelled_booking_count', v_count)
  );
  RETURN QUERY SELECT p_slot_id, v_count, v_slot.version;
END
$function$;

REVOKE ALL ON FUNCTION booking.set_authoritative_booking_period() FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.validate_client_identity_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.validate_trainer_membership_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.book_slot(uuid, uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.cancel_booking_at(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.cancel_booking(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION booking.cancel_slot(uuid, uuid, bigint, boolean, text) FROM PUBLIC;

COMMIT;
