\set ON_ERROR_STOP on

CREATE SCHEMA invitation_commands_test;

CREATE FUNCTION invitation_commands_test.assert(p_ok boolean, p_message text)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'assertion failed: %', p_message;
  END IF;
END
$function$;

INSERT INTO booking.tenants(id, public_slug) VALUES
  ('81000000-0000-0000-0000-000000000001', 'invitation-command-a'),
  ('81000000-0000-0000-0000-000000000002', 'invitation-command-b');

INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref, phone_verified_at) VALUES
  ('82000000-0000-0000-0000-000000000001', 'trainer', 'synthetic:command_trainer_a', NULL),
  ('82000000-0000-0000-0000-000000000002', 'trainer', 'synthetic:command_trainer_b', NULL),
  ('82000000-0000-0000-0000-000000000003', 'trainer', 'synthetic:command_trainer_disabled', NULL);
UPDATE booking.auth_subjects SET status = 'disabled'
 WHERE id = '82000000-0000-0000-0000-000000000003';

INSERT INTO booking.trainer_memberships(tenant_id, trainer_id) VALUES
  ('81000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001'),
  ('81000000-0000-0000-0000-000000000002', '82000000-0000-0000-0000-000000000002');

INSERT INTO booking.clients(id, tenant_id, trainer_id, display_name) VALUES
  ('83000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001', 'Command One'),
  ('83000000-0000-0000-0000-000000000002', '81000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001', 'Command Rollback'),
  ('83000000-0000-0000-0000-000000000003', '81000000-0000-0000-0000-000000000002', '82000000-0000-0000-0000-000000000002', 'Other Tenant'),
  ('83000000-0000-0000-0000-000000000010', '81000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001', 'Expiry Before'),
  ('83000000-0000-0000-0000-000000000011', '81000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001', 'Expiry Equal'),
  ('83000000-0000-0000-0000-000000000012', '81000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001', 'Expiry After'),
  ('83000000-0000-0000-0000-000000000097', '81000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001', 'Issue Revoke Race'),
  ('83000000-0000-0000-0000-000000000098', '81000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001', 'Revoke Race'),
  ('83000000-0000-0000-0000-000000000099', '81000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001', 'Issue Race');

CREATE TEMP TABLE first_issue AS
SELECT * FROM authn.issue_email_invitation(
  '82000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001',
  '83000000-0000-0000-0000-000000000001',
  'command.one@example.invalid', 1::smallint, decode(repeat('11', 32), 'hex'), 1::smallint,
  'issue-command-one', repeat('a', 64)
);
SELECT invitation_commands_test.assert((SELECT NOT replayed FROM first_issue),
  'first issuance is not a replay');
SELECT invitation_commands_test.assert((SELECT invitation_status = 'pending' FROM first_issue),
  'first issuance is pending');
SELECT invitation_commands_test.assert((SELECT expires_at = created_at + interval '24 hours' FROM first_issue),
  'command uses authoritative creation time and exact 24-hour expiry');
SELECT invitation_commands_test.assert((SELECT count(*) = 1 FROM authn.invitation_issuances
  WHERE client_id = '83000000-0000-0000-0000-000000000001'), 'one issuance created');
SELECT invitation_commands_test.assert((SELECT count(*) = 1 FROM authn.outbox AS outbox
  JOIN first_issue AS issued ON issued.invitation_id = outbox.invitation_id), 'one outbox row created');
SELECT invitation_commands_test.assert((SELECT count(*) = 1 FROM authn.authentication_audit AS audit
  JOIN first_issue AS issued ON issued.invitation_id = audit.invitation_id
  WHERE audit.event_type = 'invitation.created'), 'one creation audit created');
SELECT invitation_commands_test.assert(NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'authn' AND table_name = 'outbox'
     AND column_name ~ '(token|link|email|body|secret|payload)'
), 'outbox exposes no token, link, email, body, secret, or payload column');

CREATE TEMP TABLE replay_issue AS
SELECT * FROM authn.issue_email_invitation(
  '82000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001',
  '83000000-0000-0000-0000-000000000001',
  'command.one@example.invalid', 1::smallint, decode(repeat('22', 32), 'hex'), 1::smallint,
  'issue-command-one', repeat('a', 64)
);
SELECT invitation_commands_test.assert((SELECT replayed FROM replay_issue),
  'same key and request hash replays');
SELECT invitation_commands_test.assert((SELECT replay_issue.invitation_id = first_issue.invitation_id
  FROM replay_issue, first_issue), 'replay returns original invitation');
SELECT invitation_commands_test.assert((SELECT count(*) = 1 FROM authn.outbox AS outbox
  JOIN first_issue AS issued ON issued.invitation_id = outbox.invitation_id), 'replay creates no outbox row');
SELECT invitation_commands_test.assert((SELECT count(*) = 1 FROM authn.authentication_audit AS audit
  JOIN first_issue AS issued ON issued.invitation_id = audit.invitation_id), 'replay creates no audit row');

DO $test$
BEGIN
  PERFORM * FROM authn.issue_email_invitation(
    '82000000-0000-0000-0000-000000000001',
    '81000000-0000-0000-0000-000000000001',
    '82000000-0000-0000-0000-000000000001',
    '83000000-0000-0000-0000-000000000001',
    'command.one@example.invalid', 1::smallint, decode(repeat('33', 32), 'hex'), 1::smallint,
    'issue-command-one', repeat('b', 64));
  RAISE EXCEPTION 'expected idempotency conflict';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'IDEMPOTENCY_CONFLICT' THEN RAISE; END IF;
END
$test$;

DO $test$
BEGIN
  PERFORM * FROM authn.issue_email_invitation(
    '82000000-0000-0000-0000-000000000002',
    '81000000-0000-0000-0000-000000000001',
    '82000000-0000-0000-0000-000000000001',
    '83000000-0000-0000-0000-000000000001',
    'command.one@example.invalid', 1::smallint, decode(repeat('44', 32), 'hex'), 1::smallint,
    'unauthorized-issue', repeat('c', 64));
  RAISE EXCEPTION 'expected concealed authorization failure';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'RESOURCE_NOT_FOUND' THEN RAISE; END IF;
END
$test$;

CREATE FUNCTION invitation_commands_test.fail_selected_audit()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.relationship_client_id = '83000000-0000-0000-0000-000000000002' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INJECTED_AUDIT_FAILURE';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER invitation_commands_fail_selected_audit
BEFORE INSERT ON authn.authentication_audit
FOR EACH ROW EXECUTE FUNCTION invitation_commands_test.fail_selected_audit();
DO $test$
BEGIN
  PERFORM * FROM authn.issue_email_invitation(
    '82000000-0000-0000-0000-000000000001',
    '81000000-0000-0000-0000-000000000001',
    '82000000-0000-0000-0000-000000000001',
    '83000000-0000-0000-0000-000000000002',
    'rollback@example.invalid', 1::smallint, decode(repeat('55', 32), 'hex'), 1::smallint,
    'rollback-command', repeat('d', 64));
  RAISE EXCEPTION 'expected injected failure';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'INJECTED_AUDIT_FAILURE' THEN RAISE; END IF;
END
$test$;
SELECT invitation_commands_test.assert((SELECT count(*) = 0 FROM authn.invitation_issuances
  WHERE client_id = '83000000-0000-0000-0000-000000000002'), 'audit failure rolls back issuance');
SELECT invitation_commands_test.assert((SELECT count(*) = 0 FROM authn.outbox AS outbox
  JOIN authn.invitation_issuances AS issuance ON issuance.id = outbox.invitation_id
  WHERE issuance.client_id = '83000000-0000-0000-0000-000000000002'), 'audit failure rolls back outbox');
DROP TRIGGER invitation_commands_fail_selected_audit ON authn.authentication_audit;

-- One statement gives all three fixtures and command calls the same stable
-- transaction_timestamp(): expiry -1 microsecond succeeds; equality and one
-- microsecond after expiry are rejected without changing the pending rows.
DO $test$
DECLARE
  v_now timestamptz := transaction_timestamp();
  v_offset interval;
  v_client uuid;
  v_invitation uuid;
BEGIN
  FOREACH v_offset IN ARRAY ARRAY[
    (-interval '24 hours' + interval '1 microsecond'),
    interval '-24 hours',
    (-interval '24 hours' - interval '1 microsecond')
  ] LOOP
    v_client := CASE v_offset
      WHEN (-interval '24 hours' + interval '1 microsecond') THEN '83000000-0000-0000-0000-000000000010'::uuid
      WHEN interval '-24 hours' THEN '83000000-0000-0000-0000-000000000011'::uuid
      ELSE '83000000-0000-0000-0000-000000000012'::uuid
    END;
    v_invitation := CASE v_client
      WHEN '83000000-0000-0000-0000-000000000010'::uuid THEN '84000000-0000-0000-0000-000000000010'::uuid
      WHEN '83000000-0000-0000-0000-000000000011'::uuid THEN '84000000-0000-0000-0000-000000000011'::uuid
      ELSE '84000000-0000-0000-0000-000000000012'::uuid
    END;
    INSERT INTO authn.invitation_issuances(
      id, tenant_id, trainer_id, client_id, normalization_version,
      canonical_email, token_digest, pepper_version, expires_at, created_by,
      idempotency_key, request_hash, created_at
    ) VALUES (
      v_invitation, '81000000-0000-0000-0000-000000000001',
      '82000000-0000-0000-0000-000000000001', v_client, 1,
      'expiry.' || right(v_client::text, 2) || '@example.invalid',
      decode(lpad(right(replace(v_client::text, '-', ''), 2), 64, '0'), 'hex'), 1,
      v_now + v_offset + interval '24 hours',
      '82000000-0000-0000-0000-000000000001',
      'expiry-boundary-' || right(v_client::text, 2), repeat('9', 64),
      v_now + v_offset
    );
  END LOOP;

  PERFORM * FROM authn.revoke_email_invitation(
    '82000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001',
    '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000010',
    '84000000-0000-0000-0000-000000000010');
  BEGIN
    PERFORM * FROM authn.revoke_email_invitation(
      '82000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001',
      '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000011',
      '84000000-0000-0000-0000-000000000011');
    RAISE EXCEPTION 'expected equality expiry conflict';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'INVITATION_STATE_CONFLICT' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM * FROM authn.revoke_email_invitation(
      '82000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001',
      '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000012',
      '84000000-0000-0000-0000-000000000012');
    RAISE EXCEPTION 'expected post-expiry conflict';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'INVITATION_STATE_CONFLICT' THEN RAISE; END IF;
  END;
END
$test$;
SELECT invitation_commands_test.assert((SELECT status = 'revoked' FROM authn.invitation_issuances
  WHERE id = '84000000-0000-0000-0000-000000000010'), 'one microsecond before expiry can revoke');
SELECT invitation_commands_test.assert((SELECT count(*) = 2 FROM authn.invitation_issuances
  WHERE id IN ('84000000-0000-0000-0000-000000000011', '84000000-0000-0000-0000-000000000012')
    AND status = 'pending'), 'expiry equality and after expiry make no change');

CREATE TEMP TABLE first_revoke AS
SELECT revoke.* FROM first_issue AS issued,
LATERAL authn.revoke_email_invitation(
  '82000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001',
  '83000000-0000-0000-0000-000000000001', issued.invitation_id
) AS revoke;
SELECT invitation_commands_test.assert((SELECT invitation_status = 'revoked' AND NOT replayed FROM first_revoke),
  'authorized pending invitation is revoked');
CREATE TEMP TABLE replay_revoke AS
SELECT revoke.* FROM first_issue AS issued,
LATERAL authn.revoke_email_invitation(
  '82000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001',
  '83000000-0000-0000-0000-000000000001', issued.invitation_id
) AS revoke;
SELECT invitation_commands_test.assert((SELECT replayed FROM replay_revoke),
  'repeated revocation replays');
SELECT invitation_commands_test.assert((SELECT count(*) = 1 FROM authn.authentication_audit AS audit
  JOIN first_issue AS issued ON issued.invitation_id = audit.invitation_id
  WHERE audit.event_type = 'invitation.revoked'), 'repeated revocation creates no duplicate audit');

-- Race fixtures are created through the production command, not direct table writes.
SELECT * FROM authn.issue_email_invitation(
  '82000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000098',
  'revoke.race@example.invalid', 1::smallint, decode(repeat('66', 32), 'hex'), 1::smallint,
  'revoke-race-seed', repeat('e', 64));
SELECT * FROM authn.issue_email_invitation(
  '82000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000097',
  'issue.revoke.race@example.invalid', 1::smallint, decode(repeat('77', 32), 'hex'), 1::smallint,
  'issue-revoke-seed', repeat('f', 64));

CREATE FUNCTION invitation_commands_test.fail_revoke_audit()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.event_type = 'invitation.revoked'
     AND NEW.relationship_client_id = '83000000-0000-0000-0000-000000000098' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INJECTED_REVOKE_AUDIT_FAILURE';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER invitation_commands_fail_revoke_audit
BEFORE INSERT ON authn.authentication_audit
FOR EACH ROW EXECUTE FUNCTION invitation_commands_test.fail_revoke_audit();
DO $test$
DECLARE v_invitation uuid;
BEGIN
  SELECT id INTO STRICT v_invitation FROM authn.invitation_issuances
   WHERE client_id = '83000000-0000-0000-0000-000000000098';
  PERFORM * FROM authn.revoke_email_invitation(
    '82000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001',
    '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000098',
    v_invitation);
  RAISE EXCEPTION 'expected injected revoke audit failure';
EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM <> 'INJECTED_REVOKE_AUDIT_FAILURE' THEN RAISE; END IF;
END
$test$;
SELECT invitation_commands_test.assert((SELECT status = 'pending' AND revoked_at IS NULL
  AND revoke_reason IS NULL FROM authn.invitation_issuances
  WHERE client_id = '83000000-0000-0000-0000-000000000098'),
  'revoke audit failure rolls back invitation transition');
SELECT invitation_commands_test.assert((SELECT count(*) = 0 FROM authn.authentication_audit
  WHERE relationship_client_id = '83000000-0000-0000-0000-000000000098'
    AND event_type = 'invitation.revoked'), 'failed revoke leaves no revoke audit');
DROP TRIGGER invitation_commands_fail_revoke_audit ON authn.authentication_audit;

CREATE FUNCTION invitation_commands_test.try_same_issue(p_n integer)
RETURNS text LANGUAGE plpgsql AS $function$
DECLARE v_replayed boolean;
BEGIN
  SELECT issued.replayed INTO v_replayed FROM authn.issue_email_invitation(
    '82000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001',
    '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000099',
    'issue.race@example.invalid', 1::smallint, decode(repeat('88', 32), 'hex'), 1::smallint,
    'same-issue-race', repeat('1', 64)) AS issued;
  RETURN CASE WHEN v_replayed THEN 'REPLAYED' ELSE 'CREATED' END;
EXCEPTION WHEN OTHERS THEN RETURN 'ERROR:' || SQLSTATE || ':' || SQLERRM;
END
$function$;

CREATE FUNCTION invitation_commands_test.try_revoke(p_client uuid)
RETURNS text LANGUAGE plpgsql AS $function$
DECLARE v_invitation uuid; v_replayed boolean;
BEGIN
  SELECT id INTO STRICT v_invitation FROM authn.invitation_issuances
   WHERE client_id = p_client AND idempotency_key IN ('revoke-race-seed', 'issue-revoke-seed');
  SELECT revoked.replayed INTO v_replayed FROM authn.revoke_email_invitation(
    '82000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001',
    '82000000-0000-0000-0000-000000000001', p_client, v_invitation) AS revoked;
  RETURN CASE WHEN v_replayed THEN 'REPLAYED' ELSE 'REVOKED' END;
EXCEPTION WHEN OTHERS THEN RETURN 'ERROR:' || SQLSTATE || ':' || SQLERRM;
END
$function$;

CREATE FUNCTION invitation_commands_test.try_issue_after_revoke(p_n integer)
RETURNS text LANGUAGE plpgsql AS $function$
DECLARE v_replayed boolean;
BEGIN
  SELECT issued.replayed INTO v_replayed FROM authn.issue_email_invitation(
    '82000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001',
    '82000000-0000-0000-0000-000000000001', '83000000-0000-0000-0000-000000000097',
    'issue.revoke.race@example.invalid', 1::smallint,
    decode(lpad(to_hex(256 + p_n), 64, '0'), 'hex'), 1::smallint,
    'issue-after-revoke-' || lpad(p_n::text, 3, '0'), repeat('2', 64)) AS issued;
  RETURN CASE WHEN v_replayed THEN 'REPLAYED' ELSE 'CREATED' END;
EXCEPTION
  WHEN unique_violation THEN RETURN 'CONFLICT';
  WHEN OTHERS THEN RETURN 'ERROR:' || SQLSTATE || ':' || SQLERRM;
END
$function$;

SELECT invitation_commands_test.assert(NOT has_schema_privilege('public', 'authn', 'USAGE'),
  'PUBLIC has no authn schema usage');
SELECT invitation_commands_test.assert(NOT has_function_privilege('public',
  'authn.issue_email_invitation(uuid,uuid,uuid,uuid,text,smallint,bytea,smallint,text,text)', 'EXECUTE'),
  'PUBLIC cannot issue invitations');
SELECT invitation_commands_test.assert(NOT has_function_privilege('public',
  'authn.revoke_email_invitation(uuid,uuid,uuid,uuid,uuid)', 'EXECUTE'),
  'PUBLIC cannot revoke invitations');
SELECT invitation_commands_test.assert(NOT EXISTS (
  SELECT 1
    FROM pg_proc AS proc
    JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace,
    LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS privilege
   WHERE namespace.nspname = 'authn'
     AND proc.proname IN ('issue_email_invitation', 'revoke_email_invitation')
     AND privilege.grantee <> proc.proowner
), 'invitation commands have no non-owner grantee');
SELECT invitation_commands_test.assert((
  SELECT bool_and(proc.prosecdef AND proc.proconfig @> ARRAY['search_path=pg_catalog, booking, authn'])
    FROM pg_proc AS proc
    JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
   WHERE namespace.nspname = 'authn'
     AND proc.proname IN ('issue_email_invitation', 'revoke_email_invitation')
), 'invitation commands are security definer with a fixed search path');

SELECT 'PASS: invitation command serial checks' AS result;
