#!/usr/bin/env bash
set -eu

: "${DATABASE_URL:?Set DATABASE_URL to the dedicated trainercrm_7f5_test database}"
: "${TRAINERCRM_ALLOW_7F5_TEST_RESET:?Set TRAINERCRM_ALLOW_7F5_TEST_RESET=yes to allow the guarded fixture reset}"
if [ "$TRAINERCRM_ALLOW_7F5_TEST_RESET" != yes ]; then
  echo "Refusing reset without TRAINERCRM_ALLOW_7F5_TEST_RESET=yes" >&2
  exit 2
fi

database_name="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'select current_database()')"
if [ "$database_name" != trainercrm_7f5_test ]; then
  echo "Refusing to modify database other than trainercrm_7f5_test: $database_name" >&2
  exit 2
fi

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
result_dir="$(mktemp -d /tmp/trainercrm-7f5-acceptance.XXXXXX)"
trap 'rm -r "$result_dir"' EXIT

reset_schemas() {
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS invitation_acceptance_test CASCADE'
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS email_subject_compatibility_test CASCADE'
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS invitation_commands_test CASCADE'
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS authn_test CASCADE'
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS booking_test CASCADE'
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS authn CASCADE'
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS booking CASCADE'
}

apply_migrations() {
  for migration in \
    "$root_dir/migrations/001_extensions.sql" \
    "$root_dir/migrations/002_schema.sql" \
    "$root_dir/migrations/003_booking_functions.sql" \
    "$root_dir/migrations/004_auth_foundation.sql" \
    "$root_dir/migrations/005_auth_invitation_commands.sql" \
    "$root_dir/migrations/006_email_subject_compatibility.sql" \
    "$root_dir/migrations/007_auth_invitation_acceptance.sql"
  do
    psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$migration"
  done
}

# Never creates or drops a database; only fixed test schemas after exact guards.
reset_schemas
apply_migrations
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/tests/invitation-acceptance.sql"

race_epoch="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select extract(epoch from clock_timestamp() + interval '2 seconds')")"
n=1
pids=''
while [ "$n" -le 20 ]; do
  psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select pg_sleep(greatest(0, ${race_epoch} - extract(epoch from clock_timestamp()))); select invitation_acceptance_test.try_accept(${n}, 'a4000000-0000-0000-0000-000000000007', 'a3000000-0000-0000-0000-000000000007', repeat('77', 32));" >"$result_dir/accept-$n.out" 2>"$result_dir/accept-$n.err" &
  pids="$pids $!"
  n=$((n + 1))
done
for child_pid in $pids; do wait "$child_pid"; done
accepted="$(awk '$0 == "ACCEPTED" {n++} END {print n+0}' "$result_dir"/accept-*.out)"
invalid="$(awk '$0 == "LINK_INVALID" {n++} END {print n+0}' "$result_dir"/accept-*.out)"
state="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select (select count(*) from authn.email_identities where canonical_email='race@example.invalid') || '|' || (select count(*) from authn.relationship_access where client_id='a3000000-0000-0000-0000-000000000007') || '|' || (select count(*) from authn.authentication_audit where invitation_id='a4000000-0000-0000-0000-000000000007');")"
if [ "$accepted" != 1 ] || [ "$invalid" != 19 ] || [ "$state" != '1|1|2' ]; then
  echo "FAIL acceptance race: accepted=$accepted invalid=$invalid state=$state" >&2
  exit 1
fi
echo "PASS: 20 acceptance attempts -> 1 accepted, 19 invalid, exact state and audits"

race_epoch="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select extract(epoch from clock_timestamp() + interval '2 seconds')")"
psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select pg_sleep(greatest(0, ${race_epoch} - extract(epoch from clock_timestamp()))); select invitation_acceptance_test.try_accept(1, 'a4000000-0000-0000-0000-000000000008', 'a3000000-0000-0000-0000-000000000008', repeat('88', 32));" >"$result_dir/accept-revoke.out" &
pid_a=$!
psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select pg_sleep(greatest(0, ${race_epoch} - extract(epoch from clock_timestamp()))); select invitation_acceptance_test.try_revoke_race();" >"$result_dir/revoke.out" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
terminal="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select status from authn.invitation_issuances where id='a4000000-0000-0000-0000-000000000008'")"
if [ "$terminal" != accepted ] && [ "$terminal" != revoked ]; then
  echo "FAIL accept/revoke race: terminal=$terminal" >&2
  exit 1
fi
echo "PASS: accept/revoke race -> one terminal serial state ($terminal)"

# Unchanged booking and auth SQL regressions on the exact isolated database.
reset_schemas
apply_migrations
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/tests/serial.sql"
"$root_dir/tests/concurrency.sh"
"$root_dir/tests/extended-concurrency.sh"
reset_schemas
apply_migrations
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/tests/auth-foundation.sql"
reset_schemas
apply_migrations
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/tests/invitation-commands.sql"
reset_schemas
apply_migrations
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/tests/email-subject-compatibility.sql"

echo "PASS: Milestone 7F.5 invitation acceptance and regressions"
