BEGIN;

-- Preserve the legacy phone-backed state while permitting a future email-only
-- client subject to exist before mailbox verification is completed atomically.
-- This migration does not grant relationship or booking access.
ALTER TABLE booking.auth_subjects
  ALTER COLUMN synthetic_phone_ref DROP NOT NULL,
  DROP CONSTRAINT auth_subjects_check,
  ADD CONSTRAINT auth_subjects_identity_compatibility_check CHECK (
    (role = 'trainer' AND synthetic_phone_ref IS NOT NULL) OR
    (
      role = 'client' AND (
        (synthetic_phone_ref IS NULL AND phone_verified_at IS NULL) OR
        (synthetic_phone_ref IS NOT NULL AND phone_verified_at IS NOT NULL)
      )
    )
  );

COMMIT;
