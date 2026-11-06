BEGIN;

-- Email identities remain verified-only. Permit active trainer subjects to own
-- one as well as active client subjects; relationship access still performs
-- its separate client-specific validation.
CREATE OR REPLACE FUNCTION authn.validate_email_identity_subject()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM booking.auth_subjects AS subject
     WHERE subject.id = NEW.subject_id
       AND subject.role IN ('trainer', 'client')
       AND subject.status = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EMAIL_IDENTITY_SUBJECT_INVALID';
  END IF;
  RETURN NEW;
END
$function$;

-- A trainer login credential belongs to the existing trainer auth subject and
-- to that subject's verified email identity. Password material is accepted
-- only in the application-defined scrypt hash format; plaintext passwords have no column.
CREATE TABLE authn.trainer_password_credentials (
  trainer_subject_id uuid PRIMARY KEY,
  email_identity_id uuid NOT NULL UNIQUE,
  password_hash text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (trainer_subject_id)
    REFERENCES booking.auth_subjects(id),
  FOREIGN KEY (email_identity_id, trainer_subject_id)
    REFERENCES authn.email_identities(id, subject_id),
  CHECK (password_hash LIKE '$scrypt$%'),
  CHECK (octet_length(password_hash) BETWEEN 30 AND 1024),
  CHECK (password_changed_at >= created_at),
  CHECK (updated_at >= created_at)
);

CREATE FUNCTION authn.validate_trainer_password_credential()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM booking.auth_subjects AS subject
      JOIN authn.email_identities AS identity
        ON identity.id = NEW.email_identity_id
       AND identity.subject_id = subject.id
     WHERE subject.id = NEW.trainer_subject_id
       AND subject.role = 'trainer'
       AND subject.status = 'active'
       AND identity.disabled_at IS NULL
       AND identity.verified_at <= NEW.password_changed_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TRAINER_CREDENTIAL_IDENTITY_INVALID';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trainer_password_credentials_validate_identity
BEFORE INSERT OR UPDATE OF trainer_subject_id, email_identity_id,
  password_hash, password_changed_at
ON authn.trainer_password_credentials
FOR EACH ROW EXECUTE FUNCTION authn.validate_trainer_password_credential();

-- Opaque session bearers are never stored. The server hashes each raw token
-- with SHA-256 and persists only the fixed-size digest used for lookup.
CREATE TABLE authn.trainer_sessions (
  id uuid PRIMARY KEY,
  trainer_subject_id uuid NOT NULL
    REFERENCES authn.trainer_password_credentials(trainer_subject_id),
  token_sha256_digest bytea NOT NULL UNIQUE
    CHECK (octet_length(token_sha256_digest) = 32),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  CHECK (last_seen_at >= created_at),
  CHECK (idle_expires_at > created_at),
  CHECK (absolute_expires_at > created_at),
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK (last_seen_at < idle_expires_at),
  CHECK (
    (revoked_at IS NULL AND revoke_reason IS NULL) OR
    (revoked_at IS NOT NULL AND revoked_at >= created_at
      AND revoke_reason IS NOT NULL
      AND length(btrim(revoke_reason)) BETWEEN 1 AND 120)
  )
);

CREATE INDEX trainer_sessions_subject_active_idx
  ON authn.trainer_sessions(trainer_subject_id, idle_expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX trainer_sessions_expiry_idx
  ON authn.trainer_sessions(absolute_expires_at)
  WHERE revoked_at IS NULL;

-- Keep login secrets and session state owner-internal. In particular, this
-- migration grants trainercrm_app no table privilege; a later runtime cycle
-- must expose only narrowly reviewed server-side functions or views.
REVOKE ALL ON TABLE authn.trainer_password_credentials FROM PUBLIC;
REVOKE ALL ON TABLE authn.trainer_sessions FROM PUBLIC;
REVOKE ALL ON FUNCTION authn.validate_email_identity_subject() FROM PUBLIC;
REVOKE ALL ON FUNCTION authn.validate_trainer_password_credential() FROM PUBLIC;

COMMIT;
