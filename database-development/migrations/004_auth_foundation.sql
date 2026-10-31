BEGIN;

CREATE SCHEMA authn;
REVOKE ALL ON SCHEMA authn FROM PUBLIC;

CREATE TYPE authn.relationship_status AS ENUM ('active', 'revoked');
CREATE TYPE authn.invitation_status AS ENUM (
  'pending', 'accepted', 'revoked', 'superseded', 'expired'
);
CREATE TYPE authn.outbox_status AS ENUM (
  'queued', 'leased', 'delivered', 'failed'
);

-- This table contains verified identities only. Pending mailbox claims live on
-- invitation issuances and cannot be mistaken for proof of mailbox control.
CREATE TABLE authn.email_identities (
  id uuid PRIMARY KEY,
  subject_id uuid NOT NULL REFERENCES booking.auth_subjects(id),
  normalization_version smallint NOT NULL CHECK (normalization_version = 1),
  canonical_email text NOT NULL,
  display_email text NOT NULL,
  verified_at timestamptz NOT NULL,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (normalization_version, canonical_email),
  UNIQUE (subject_id),
  UNIQUE (id, subject_id),
  CHECK (octet_length(canonical_email) BETWEEN 3 AND 254),
  CHECK (canonical_email = lower(canonical_email)),
  CHECK (canonical_email ~ '^[a-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&''*+/=?^_`{|}~-]+)*@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  CHECK (display_email !~ '[[:cntrl:]]'),
  CHECK (octet_length(display_email) BETWEEN 3 AND 254),
  CHECK (verified_at >= created_at),
  CHECK (updated_at >= created_at),
  CHECK (disabled_at IS NULL OR disabled_at >= verified_at)
);

CREATE TABLE authn.relationship_access (
  client_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  trainer_id uuid NOT NULL,
  subject_id uuid NOT NULL REFERENCES booking.auth_subjects(id),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  status authn.relationship_status NOT NULL DEFAULT 'active',
  activated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (tenant_id, client_id),
  UNIQUE (tenant_id, trainer_id, client_id),
  UNIQUE (client_id, subject_id),
  FOREIGN KEY (tenant_id, trainer_id, client_id)
    REFERENCES booking.clients(tenant_id, trainer_id, id),
  CHECK (activated_at >= created_at),
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL
      AND length(btrim(revoke_reason)) BETWEEN 1 AND 120)
  )
);

CREATE TABLE authn.invitation_issuances (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  trainer_id uuid NOT NULL,
  client_id uuid NOT NULL,
  normalization_version smallint NOT NULL CHECK (normalization_version = 1),
  canonical_email text NOT NULL,
  token_digest bytea NOT NULL CHECK (octet_length(token_digest) = 32),
  pepper_version smallint NOT NULL CHECK (pepper_version > 0),
  status authn.invitation_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_identity_id uuid,
  accepted_subject_id uuid,
  revoked_at timestamptz,
  revoke_reason text,
  superseded_at timestamptz,
  superseded_by uuid,
  expired_at timestamptz,
  created_by uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (pepper_version, token_digest),
  UNIQUE (tenant_id, trainer_id, client_id, idempotency_key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, trainer_id, client_id)
    REFERENCES booking.clients(tenant_id, trainer_id, id),
  FOREIGN KEY (tenant_id, created_by)
    REFERENCES booking.trainer_memberships(tenant_id, trainer_id),
  FOREIGN KEY (accepted_identity_id, accepted_subject_id)
    REFERENCES authn.email_identities(id, subject_id),
  FOREIGN KEY (superseded_by) REFERENCES authn.invitation_issuances(id),
  CHECK (octet_length(canonical_email) BETWEEN 3 AND 254),
  CHECK (canonical_email = lower(canonical_email)),
  CHECK (expires_at = created_at + interval '24 hours'),
  CHECK (superseded_by IS NULL OR superseded_by <> id),
  CHECK (
    (status = 'pending'
      AND accepted_at IS NULL AND accepted_identity_id IS NULL
      AND accepted_subject_id IS NULL AND revoked_at IS NULL
      AND revoke_reason IS NULL AND superseded_at IS NULL
      AND superseded_by IS NULL AND expired_at IS NULL) OR
    (status = 'accepted'
      AND accepted_at IS NOT NULL AND accepted_at < expires_at
      AND accepted_identity_id IS NOT NULL AND accepted_subject_id IS NOT NULL
      AND revoked_at IS NULL AND revoke_reason IS NULL
      AND superseded_at IS NULL AND superseded_by IS NULL
      AND expired_at IS NULL) OR
    (status = 'revoked'
      AND accepted_at IS NULL AND accepted_identity_id IS NULL
      AND accepted_subject_id IS NULL AND revoked_at IS NOT NULL
      AND length(btrim(revoke_reason)) BETWEEN 1 AND 120
      AND superseded_at IS NULL AND superseded_by IS NULL
      AND expired_at IS NULL) OR
    (status = 'superseded'
      AND accepted_at IS NULL AND accepted_identity_id IS NULL
      AND accepted_subject_id IS NULL AND revoked_at IS NULL
      AND revoke_reason IS NULL AND superseded_at IS NOT NULL
      AND superseded_by IS NOT NULL AND expired_at IS NULL) OR
    (status = 'expired'
      AND accepted_at IS NULL AND accepted_identity_id IS NULL
      AND accepted_subject_id IS NULL AND revoked_at IS NULL
      AND revoke_reason IS NULL AND superseded_at IS NULL
      AND superseded_by IS NULL AND expired_at IS NOT NULL
      AND expired_at >= expires_at)
  )
);

CREATE UNIQUE INDEX invitation_one_pending_per_client_uq
  ON authn.invitation_issuances(client_id) WHERE status = 'pending';
CREATE INDEX invitation_digest_lookup_idx
  ON authn.invitation_issuances(pepper_version, token_digest);
CREATE INDEX invitation_pending_expiry_idx
  ON authn.invitation_issuances(expires_at) WHERE status = 'pending';
CREATE INDEX relationship_subject_idx
  ON authn.relationship_access(subject_id, status);

CREATE TABLE authn.outbox (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind = 'invitation.delivery'),
  invitation_id uuid NOT NULL REFERENCES authn.invitation_issuances(id),
  template_id text NOT NULL CHECK (template_id ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  status authn.outbox_status NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  lease_until timestamptz,
  provider_message_reference text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (kind, idempotency_key),
  UNIQUE (invitation_id),
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'queued' AND lease_until IS NULL AND delivered_at IS NULL) OR
    (status = 'leased' AND lease_until IS NOT NULL AND delivered_at IS NULL) OR
    (status = 'delivered' AND lease_until IS NULL AND delivered_at IS NOT NULL) OR
    (status = 'failed' AND lease_until IS NULL AND delivered_at IS NULL)
  )
);

CREATE INDEX outbox_ready_idx
  ON authn.outbox(next_attempt_at, created_at)
  WHERE status IN ('queued', 'failed');

CREATE TABLE authn.authentication_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL CHECK (
    event_type IN (
      'identity.verified', 'invitation.created', 'invitation.accepted',
      'invitation.revoked', 'invitation.superseded', 'invitation.expired',
      'relationship.activated', 'relationship.revoked'
    )
  ),
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  tenant_id uuid REFERENCES booking.tenants(id),
  relationship_client_id uuid,
  actor_subject_id uuid REFERENCES booking.auth_subjects(id),
  target_subject_id uuid REFERENCES booking.auth_subjects(id),
  invitation_id uuid,
  result text NOT NULL CHECK (result IN ('succeeded', 'rejected')),
  reason_code text CHECK (
    reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'
  ),
  correlation_id uuid NOT NULL,
  FOREIGN KEY (tenant_id, relationship_client_id)
    REFERENCES booking.clients(tenant_id, id),
  FOREIGN KEY (tenant_id, invitation_id)
    REFERENCES authn.invitation_issuances(tenant_id, id),
  CHECK (
    (result = 'succeeded' AND reason_code IS NULL) OR
    (result = 'rejected' AND reason_code IS NOT NULL)
  )
);

CREATE INDEX authentication_audit_tenant_time_idx
  ON authn.authentication_audit(tenant_id, occurred_at DESC);
CREATE INDEX authentication_audit_correlation_idx
  ON authn.authentication_audit(correlation_id);

CREATE FUNCTION authn.validate_email_identity_subject()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM booking.auth_subjects AS subject
     WHERE subject.id = NEW.subject_id
       AND subject.role = 'client'
       AND subject.status = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EMAIL_IDENTITY_SUBJECT_INVALID';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER email_identities_validate_subject
BEFORE INSERT OR UPDATE OF subject_id ON authn.email_identities
FOR EACH ROW EXECUTE FUNCTION authn.validate_email_identity_subject();

CREATE FUNCTION authn.validate_relationship_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM booking.clients AS client
      JOIN booking.auth_subjects AS subject ON subject.id = NEW.subject_id
      JOIN authn.email_identities AS identity ON identity.subject_id = subject.id
     WHERE client.id = NEW.client_id
       AND client.tenant_id = NEW.tenant_id
       AND client.trainer_id = NEW.trainer_id
       AND subject.role = 'client'
       AND subject.status = 'active'
       AND identity.disabled_at IS NULL
       AND identity.verified_at <= NEW.activated_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RELATIONSHIP_IDENTITY_INVALID';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER relationship_access_validate_identity
BEFORE INSERT OR UPDATE OF tenant_id, trainer_id, client_id, subject_id, activated_at
ON authn.relationship_access
FOR EACH ROW EXECUTE FUNCTION authn.validate_relationship_access();

CREATE FUNCTION authn.validate_invitation_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, booking, authn
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.trainer_id IS DISTINCT FROM OLD.trainer_id
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.normalization_version IS DISTINCT FROM OLD.normalization_version
       OR NEW.canonical_email IS DISTINCT FROM OLD.canonical_email
       OR NEW.token_digest IS DISTINCT FROM OLD.token_digest
       OR NEW.pepper_version IS DISTINCT FROM OLD.pepper_version
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVITATION_IMMUTABLE_FIELDS';
    END IF;
    IF OLD.status <> 'pending' OR NEW.status = 'pending' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVITATION_INVALID_TRANSITION';
    END IF;
  END IF;

  IF NEW.status = 'accepted' AND NOT EXISTS (
    SELECT 1 FROM authn.email_identities AS identity
     WHERE identity.id = NEW.accepted_identity_id
       AND identity.subject_id = NEW.accepted_subject_id
       AND identity.normalization_version = NEW.normalization_version
       AND identity.canonical_email = NEW.canonical_email
       AND identity.disabled_at IS NULL
       AND identity.verified_at <= NEW.accepted_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVITATION_IDENTITY_MISMATCH';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER invitation_issuances_validate_transition
BEFORE INSERT OR UPDATE ON authn.invitation_issuances
FOR EACH ROW EXECUTE FUNCTION authn.validate_invitation_transition();

CREATE FUNCTION authn.enforce_email_identity_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, authn
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.normalization_version IS DISTINCT FROM OLD.normalization_version
     OR NEW.canonical_email IS DISTINCT FROM OLD.canonical_email
     OR NEW.display_email IS DISTINCT FROM OLD.display_email
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EMAIL_IDENTITY_IMMUTABLE_FIELDS';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER email_identities_immutable_fields
BEFORE UPDATE ON authn.email_identities
FOR EACH ROW EXECUTE FUNCTION authn.enforce_email_identity_immutability();

CREATE FUNCTION authn.enforce_relationship_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, authn
AS $function$
BEGIN
  IF NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.trainer_id IS DISTINCT FROM OLD.trainer_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RELATIONSHIP_IMMUTABLE_SCOPE';
  END IF;
  IF NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason THEN
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RELATIONSHIP_VERSION_INVALID';
    END IF;
  ELSIF NEW.version <> OLD.version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'RELATIONSHIP_VERSION_INVALID';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER relationship_access_enforce_transition
BEFORE UPDATE ON authn.relationship_access
FOR EACH ROW EXECUTE FUNCTION authn.enforce_relationship_transition();

CREATE FUNCTION authn.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, authn
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AUTHENTICATION_AUDIT_APPEND_ONLY';
END
$function$;

CREATE TRIGGER authentication_audit_append_only
BEFORE UPDATE OR DELETE ON authn.authentication_audit
FOR EACH ROW EXECUTE FUNCTION authn.reject_audit_mutation();

CREATE TRIGGER authentication_audit_no_truncate
BEFORE TRUNCATE ON authn.authentication_audit
FOR EACH STATEMENT EXECUTE FUNCTION authn.reject_audit_mutation();

REVOKE ALL ON ALL TABLES IN SCHEMA authn FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA authn FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA authn FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA authn REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA authn REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA authn REVOKE ALL ON FUNCTIONS FROM PUBLIC;

COMMIT;
