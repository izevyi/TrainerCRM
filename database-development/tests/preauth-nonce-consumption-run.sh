#!/usr/bin/env bash
set -eu

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
database_url='postgresql:///trainercrm_auto_test?user=petro&host=/var/run/postgresql'
result_dir=''
completed=no

finish() {
  rc=$?
  if [ -n "$result_dir" ] && [ -d "$result_dir" ]; then
    rm -r -- "$result_dir"
  fi
  if [ "$completed" != yes ]; then
    echo "FAIL: Milestone 7F.10 pre-auth nonce consumption" >&2
  fi
  exit "$rc"
}
trap finish EXIT

if [ "$(id -un)" != petro ]; then
  echo "FAIL: runner must execute as Ubuntu user petro" >&2
  exit 2
fi

# This read-only identity query is the only database access before every
# mutation. Fail closed unless all four properties match the disposable target.
identity="$(psql -X -At -v ON_ERROR_STOP=1 "$database_url" -c "
SELECT current_database() || '|' || session_user || '|' ||
       pg_get_userbyid(datdba) || '|' || rolsuper::text
  FROM pg_database
  JOIN pg_roles ON rolname = session_user
 WHERE datname = current_database();
")"
if [ "$identity" != 'trainercrm_auto_test|petro|petro|false' ]; then
  echo "FAIL: unexpected PostgreSQL identity: $identity" >&2
  exit 2
fi

result_dir="$(mktemp -d /tmp/trainercrm-preauth-nonce.XXXXXX)"

reset_schemas() {
  psql -X -v ON_ERROR_STOP=1 "$database_url" -c 'DROP SCHEMA IF EXISTS preauth_nonce_test CASCADE'
  psql -X -v ON_ERROR_STOP=1 "$database_url" -c 'DROP SCHEMA IF EXISTS authn CASCADE'
  psql -X -v ON_ERROR_STOP=1 "$database_url" -c 'DROP SCHEMA IF EXISTS booking CASCADE'
}

apply_migrations() {
  for migration in \
    "$root_dir/migrations/001_extensions.sql" \
    "$root_dir/migrations/002_schema.sql" \
    "$root_dir/migrations/003_booking_functions.sql" \
    "$root_dir/migrations/004_auth_foundation.sql" \
    "$root_dir/migrations/005_auth_invitation_commands.sql" \
    "$root_dir/migrations/006_email_subject_compatibility.sql" \
    "$root_dir/migrations/007_auth_invitation_acceptance.sql" \
    "$root_dir/migrations/008_auth_preauth_nonce_consumption.sql"
  do
    psql -X -v ON_ERROR_STOP=1 "$database_url" -f "$migration"
  done
}

# Never creates or drops a database. Only these fixed schemas in the identity-
# guarded disposable database are reset.
reset_schemas
apply_migrations
psql -X -v ON_ERROR_STOP=1 "$database_url" \
  -f "$root_dir/tests/preauth-nonce-consumption.sql"

race_epoch="$(psql -X -At -v ON_ERROR_STOP=1 "$database_url" \
  -c "select extract(epoch from clock_timestamp() + interval '2 seconds')")"
n=1
pids=''
while [ "$n" -le 20 ]; do
  psql -X -At -v ON_ERROR_STOP=1 "$database_url" -c "
SELECT pg_sleep(greatest(0, ${race_epoch} - extract(epoch from clock_timestamp())));
SELECT preauth_nonce_test.try_consume(${n});
" >"$result_dir/attempt-$n.out" 2>"$result_dir/attempt-$n.err" &
  pids="$pids $!"
  n=$((n + 1))
done
for child_pid in $pids; do
  wait "$child_pid"
done

accepted="$(awk '$0 == "ACCEPTED" {n++} END {print n+0}' "$result_dir"/attempt-*.out)"
invalid="$(awk '$0 == "LINK_INVALID" {n++} END {print n+0}' "$result_dir"/attempt-*.out)"
state="$(psql -X -At -v ON_ERROR_STOP=1 "$database_url" -c "
SELECT
  (SELECT count(*) FROM authn.preauth_nonce_consumptions
    WHERE nonce_digest = decode(repeat('c0', 32), 'hex')) || '|' ||
  (SELECT count(*) FROM authn.invitation_issuances
    WHERE id = 'b4000000-0000-0000-0000-000000000010' AND status = 'accepted') || '|' ||
  (SELECT count(*) FROM authn.email_identities
    WHERE canonical_email = 'race@example.invalid') || '|' ||
  (SELECT count(*) FROM authn.relationship_access
    WHERE client_id = 'b3000000-0000-0000-0000-000000000010') || '|' ||
  (SELECT count(*) FROM authn.authentication_audit
    WHERE invitation_id = 'b4000000-0000-0000-0000-000000000010');
")"

if [ "$accepted" != 1 ] || [ "$invalid" != 19 ] || [ "$state" != '1|1|1|1|2' ]; then
  echo "FAIL: nonce race accepted=$accepted invalid=$invalid state=$state" >&2
  for output in "$result_dir"/attempt-*.out "$result_dir"/attempt-*.err; do
    if [ -s "$output" ]; then
      echo "--- $output" >&2
      sed -n '1,20p' "$output" >&2
    fi
  done
  exit 1
fi

echo "PASS: 20 concurrent attempts -> 1 acceptance, 19 LINK_INVALID, 1 nonce consumption"

# Independent cross-tenant race: same nonce, different invitations.
cross_epoch="$(psql -X -At -v ON_ERROR_STOP=1 "$database_url"   -c "SELECT extract(epoch from clock_timestamp() + interval '2 seconds')")"

n=1
pids=''
while [ "$n" -le 20 ]; do
  lane=$((n % 2 + 1))

  psql -X -At -v ON_ERROR_STOP=1 "$database_url" -c "
SELECT pg_sleep(greatest(0, ${cross_epoch} - extract(epoch from clock_timestamp())));
SELECT preauth_nonce_test.try_consume_cross(${lane});
" >"$result_dir/cross-$n.out" 2>"$result_dir/cross-$n.err" &

  pids="$pids $!"
  n=$((n + 1))
done

for child_pid in $pids; do
  wait "$child_pid"
done

cross_accepted="$(awk '$0 == "ACCEPTED" {n++} END {print n+0}' "$result_dir"/cross-*.out)"
cross_invalid="$(awk '$0 == "LINK_INVALID" {n++} END {print n+0}' "$result_dir"/cross-*.out)"

cross_state="$(psql -X -At -v ON_ERROR_STOP=1 "$database_url" -c "
SELECT
 (SELECT count(*) FROM authn.preauth_nonce_consumptions
  WHERE nonce_digest = decode(repeat('d0', 32), 'hex')) || '|' ||
 (SELECT count(*) FROM authn.invitation_issuances
  WHERE id IN (
    'b4000000-0000-0000-0000-000000000011',
    'b4000000-0000-0000-0000-000000000099'
  ) AND status = 'accepted') || '|' ||
 (SELECT count(*) FROM authn.invitation_issuances
  WHERE id IN (
    'b4000000-0000-0000-0000-000000000011',
    'b4000000-0000-0000-0000-000000000099'
  ) AND status = 'pending') || '|' ||
 (SELECT count(*) FROM authn.relationship_access
  WHERE client_id IN (
    'b3000000-0000-0000-0000-000000000011',
    'b3000000-0000-0000-0000-000000000099'
  )) || '|' ||
 (SELECT count(*) FROM authn.authentication_audit
  WHERE invitation_id IN (
    'b4000000-0000-0000-0000-000000000011',
    'b4000000-0000-0000-0000-000000000099'
  )) || '|' ||
 (SELECT count(*) FROM authn.email_identities
  WHERE canonical_email IN (
    'cross-a@example.invalid', 'cross-b@example.invalid'
  )) || '|' ||
 (SELECT count(*) FROM authn.preauth_nonce_consumptions AS consumption
  JOIN authn.invitation_issuances AS issuance
    ON issuance.id = consumption.invitation_id
  WHERE consumption.nonce_digest = decode(repeat('d0', 32), 'hex')
    AND issuance.status = 'accepted');
")"

if [ "$cross_accepted" != 1 ] ||
   [ "$cross_invalid" != 19 ] ||
   [ "$cross_state" != '1|1|1|1|2|1|1' ]; then
  echo "FAIL: cross-tenant race accepted=$cross_accepted invalid=$cross_invalid state=$cross_state" >&2
  for output in "$result_dir"/cross-*.out "$result_dir"/cross-*.err; do
    if [ -s "$output" ]; then
      echo "--- $output" >&2
      sed -n '1,10p' "$output" >&2
    fi
  done
  exit 1
fi

echo "PASS: cross-tenant nonce race -> 1 accepted, 19 LINK_INVALID, 1 consumption"

echo "PASS: Milestone 7F.10 pre-auth nonce consumption"
completed=yes
