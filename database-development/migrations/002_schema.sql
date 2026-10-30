BEGIN;

CREATE SCHEMA IF NOT EXISTS booking;
REVOKE ALL ON SCHEMA booking FROM PUBLIC;

CREATE TYPE booking.subject_role AS ENUM ('trainer', 'client');
CREATE TYPE booking.record_status AS ENUM ('active', 'disabled');
CREATE TYPE booking.client_status AS ENUM ('invited', 'active', 'disabled');
CREATE TYPE booking.invitation_status AS ENUM ('pending', 'accepted', 'revoked', 'expired');
CREATE TYPE booking.slot_status AS ENUM ('open', 'blocked', 'cancelled');
CREATE TYPE booking.booking_status AS ENUM ('confirmed', 'cancelled');

CREATE TABLE booking.tenants (
  id uuid PRIMARY KEY,
  public_slug text NOT NULL UNIQUE CHECK (public_slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  status booking.record_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE booking.auth_subjects (
  id uuid PRIMARY KEY,
  role booking.subject_role NOT NULL,
  synthetic_phone_ref text NOT NULL UNIQUE CHECK (synthetic_phone_ref ~ '^synthetic:[a-z0-9_-]+$'),
  phone_verified_at timestamptz,
  status booking.record_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (role <> 'client' OR phone_verified_at IS NOT NULL)
);

CREATE TABLE booking.trainer_memberships (
  tenant_id uuid NOT NULL REFERENCES booking.tenants(id),
  trainer_id uuid NOT NULL REFERENCES booking.auth_subjects(id),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, trainer_id),
  UNIQUE (trainer_id)
);

CREATE TABLE booking.clients (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  trainer_id uuid NOT NULL,
  auth_subject_id uuid,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  status booking.client_status NOT NULL DEFAULT 'invited',
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, trainer_id, id),
  UNIQUE (tenant_id, id, auth_subject_id),
  UNIQUE (trainer_id, auth_subject_id),
  FOREIGN KEY (tenant_id, trainer_id)
    REFERENCES booking.trainer_memberships(tenant_id, trainer_id),
  FOREIGN KEY (auth_subject_id) REFERENCES booking.auth_subjects(id),
  CHECK ((status = 'active') = (auth_subject_id IS NOT NULL))
);

CREATE TABLE booking.invitations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  trainer_id uuid NOT NULL,
  client_id uuid NOT NULL,
  auth_subject_id uuid,
  synthetic_phone_ref text NOT NULL CHECK (synthetic_phone_ref ~ '^synthetic:[a-z0-9_-]+$'),
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) >= 32),
  status booking.invitation_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, trainer_id, client_id)
    REFERENCES booking.clients(tenant_id, trainer_id, id),
  FOREIGN KEY (auth_subject_id) REFERENCES booking.auth_subjects(id),
  FOREIGN KEY (tenant_id, created_by)
    REFERENCES booking.trainer_memberships(tenant_id, trainer_id),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'pending' AND auth_subject_id IS NULL AND accepted_at IS NULL AND revoked_at IS NULL) OR
    (status = 'accepted' AND auth_subject_id IS NOT NULL AND accepted_at IS NOT NULL AND revoked_at IS NULL) OR
    (status = 'revoked' AND accepted_at IS NULL AND revoked_at IS NOT NULL) OR
    (status = 'expired' AND accepted_at IS NULL AND revoked_at IS NULL)
  )
);

CREATE TABLE booking.availability_slots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  trainer_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status booking.slot_status NOT NULL DEFAULT 'open',
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, trainer_id, id),
  FOREIGN KEY (tenant_id, trainer_id)
    REFERENCES booking.trainer_memberships(tenant_id, trainer_id),
  FOREIGN KEY (cancelled_by) REFERENCES booking.auth_subjects(id),
  CHECK (ends_at > starts_at),
  CHECK (
    (status <> 'cancelled' AND cancelled_at IS NULL AND cancelled_by IS NULL) OR
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
  ),
  EXCLUDE USING gist (
    trainer_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'open')
);

CREATE TABLE booking.bookings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  client_id uuid NOT NULL,
  auth_subject_id uuid NOT NULL,
  seat smallint NOT NULL CHECK (seat IN (1, 2)),
  status booking.booking_status NOT NULL DEFAULT 'confirmed',
  booked_period tstzrange NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash text NOT NULL CHECK (length(request_hash) BETWEEN 32 AND 200),
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancellation_reason text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (client_id, idempotency_key),
  FOREIGN KEY (tenant_id, slot_id)
    REFERENCES booking.availability_slots(tenant_id, id),
  FOREIGN KEY (tenant_id, client_id, auth_subject_id)
    REFERENCES booking.clients(tenant_id, id, auth_subject_id),
  FOREIGN KEY (auth_subject_id) REFERENCES booking.auth_subjects(id),
  FOREIGN KEY (cancelled_by) REFERENCES booking.auth_subjects(id),
  CHECK (NOT isempty(booked_period)),
  CHECK (lower_inc(booked_period) AND NOT upper_inc(booked_period)),
  CHECK (
    (status = 'confirmed' AND cancelled_at IS NULL AND cancelled_by IS NULL) OR
    (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX bookings_confirmed_seat_uq
  ON booking.bookings(slot_id, seat) WHERE status = 'confirmed';
CREATE UNIQUE INDEX bookings_confirmed_client_slot_uq
  ON booking.bookings(slot_id, client_id) WHERE status = 'confirmed';
ALTER TABLE booking.bookings ADD CONSTRAINT bookings_verified_identity_no_overlap
  EXCLUDE USING gist (auth_subject_id WITH =, booked_period WITH &&)
  WHERE (status = 'confirmed');

CREATE TABLE booking.booking_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  booking_id uuid,
  slot_id uuid NOT NULL,
  actor_subject_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('booking.confirmed', 'booking.cancelled', 'slot.cancelled')),
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  correlation_id uuid NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (tenant_id, booking_id) REFERENCES booking.bookings(tenant_id, id),
  FOREIGN KEY (tenant_id, slot_id) REFERENCES booking.availability_slots(tenant_id, id),
  FOREIGN KEY (actor_subject_id) REFERENCES booking.auth_subjects(id),
  CHECK (jsonb_typeof(metadata_json) = 'object')
);

CREATE INDEX availability_open_by_trainer_idx
  ON booking.availability_slots(trainer_id, starts_at) WHERE status = 'open';
CREATE INDEX bookings_confirmed_by_slot_idx
  ON booking.bookings(slot_id) WHERE status = 'confirmed';
CREATE INDEX bookings_client_history_idx
  ON booking.bookings(client_id, created_at DESC);
CREATE INDEX booking_events_tenant_time_idx
  ON booking.booking_events(tenant_id, occurred_at DESC);

REVOKE ALL ON ALL TABLES IN SCHEMA booking FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA booking FROM PUBLIC;

COMMIT;
