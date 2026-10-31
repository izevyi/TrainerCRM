#!/usr/bin/env bash
set -eu

: "${DATABASE_URL:?Set DATABASE_URL to the dedicated trainercrm_7f_test database}"
: "${TRAINERCRM_ALLOW_7F_TEST_RESET:?Set TRAINERCRM_ALLOW_7F_TEST_RESET=yes to allow the guarded fixture reset}"

if [ "$TRAINERCRM_ALLOW_7F_TEST_RESET" != yes ]; then
  echo "Refusing reset without TRAINERCRM_ALLOW_7F_TEST_RESET=yes" >&2
  exit 2
fi

database_name="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'select current_database()')"
if [ "$database_name" != trainercrm_7f_test ]; then
  echo "Refusing to modify database other than trainercrm_7f_test: $database_name" >&2
  exit 2
fi

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
result_dir="$(mktemp -d /tmp/trainercrm-7f-auth.XXXXXX)"
trap 'rm -r "$result_dir"' EXIT

# This runner never creates or drops a database. The fixed schemas below are
# test fixtures inside the exact dedicated database guarded above.
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS authn_test CASCADE'
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS authn CASCADE'
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS booking CASCADE'
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/001_extensions.sql"
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/002_schema.sql"
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/003_booking_functions.sql"
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/004_auth_foundation.sql"
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/tests/auth-foundation.sql"

race_epoch="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select extract(epoch from clock_timestamp() + interval '2 seconds')")"
n=1
identity_pids=''
while [ "$n" -le 12 ]; do
  psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" \
    -c "select pg_sleep(greatest(0, ${race_epoch} - extract(epoch from clock_timestamp()))); select authn_test.try_identity(${n});" \
    >"$result_dir/identity-$n.out" 2>"$result_dir/identity-$n.err" &
  identity_pids="$identity_pids $!"
  n=$((n + 1))
done
for child_pid in $identity_pids; do
  if ! wait "$child_pid"; then
    echo "Identity race connection failed" >&2
    sed -n '1,120p' "$result_dir"/identity-*.err >&2
    exit 1
  fi
done

identity_won="$(awk '$0 == "WON" { count++ } END { print count + 0 }' "$result_dir"/identity-*.out)"
identity_conflict="$(awk '$0 == "CONFLICT" { count++ } END { print count + 0 }' "$result_dir"/identity-*.out)"
identity_rows="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select count(*) from authn.email_identities where canonical_email = 'canonical.race@example.invalid'")"
if [ "$identity_won" != 1 ] || [ "$identity_conflict" != 11 ] || [ "$identity_rows" != 1 ]; then
  echo "FAIL identity race: won=$identity_won conflict=$identity_conflict rows=$identity_rows" >&2
  exit 1
fi
echo "PASS: identity race -> 1 verified canonical identity, 11 conflicts"

race_epoch="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select extract(epoch from clock_timestamp() + interval '2 seconds')")"
n=1
invitation_pids=''
while [ "$n" -le 12 ]; do
  psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" \
    -c "select pg_sleep(greatest(0, ${race_epoch} - extract(epoch from clock_timestamp()))); select authn_test.try_invitation(${n});" \
    >"$result_dir/invitation-$n.out" 2>"$result_dir/invitation-$n.err" &
  invitation_pids="$invitation_pids $!"
  n=$((n + 1))
done
for child_pid in $invitation_pids; do
  if ! wait "$child_pid"; then
    echo "Invitation race connection failed" >&2
    sed -n '1,120p' "$result_dir"/invitation-*.err >&2
    exit 1
  fi
done

invitation_won="$(awk '$0 == "WON" { count++ } END { print count + 0 }' "$result_dir"/invitation-*.out)"
invitation_conflict="$(awk '$0 == "CONFLICT" { count++ } END { print count + 0 }' "$result_dir"/invitation-*.out)"
invitation_rows="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select count(*) from authn.invitation_issuances where client_id = '74000000-0000-0000-0000-000000000099' and status = 'pending'")"
if [ "$invitation_won" != 1 ] || [ "$invitation_conflict" != 11 ] || [ "$invitation_rows" != 1 ]; then
  echo "FAIL invitation race: won=$invitation_won conflict=$invitation_conflict pending=$invitation_rows" >&2
  exit 1
fi
echo "PASS: invitation race -> 1 usable pending issuance, 11 conflicts"

echo "PASS: Milestone 7F.1 auth foundation"
