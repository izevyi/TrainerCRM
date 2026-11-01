#!/usr/bin/env bash
set -eu

: "${DATABASE_URL:?Set DATABASE_URL to the dedicated trainercrm_7f3_test database}"
: "${TRAINERCRM_ALLOW_7F3_TEST_RESET:?Set TRAINERCRM_ALLOW_7F3_TEST_RESET=yes to allow the guarded fixture reset}"

if [ "$TRAINERCRM_ALLOW_7F3_TEST_RESET" != yes ]; then
  echo "Refusing reset without TRAINERCRM_ALLOW_7F3_TEST_RESET=yes" >&2
  exit 2
fi

database_name="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'select current_database()')"
if [ "$database_name" != trainercrm_7f3_test ]; then
  echo "Refusing to modify database other than trainercrm_7f3_test: $database_name" >&2
  exit 2
fi

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
result_dir="$(mktemp -d /tmp/trainercrm-7f3-invitations.XXXXXX)"
trap 'rm -r "$result_dir"' EXIT

# Never creates or drops a database. These fixed schemas are reset only inside
# the exact dedicated disposable database after the explicit opt-in above.
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS invitation_commands_test CASCADE'
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS authn CASCADE'
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS booking CASCADE'
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/001_extensions.sql"
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/002_schema.sql"
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/003_booking_functions.sql"
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/004_auth_foundation.sql"
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/005_auth_invitation_commands.sql"
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/tests/invitation-commands.sql"

run_race() {
  race_name="$1"
  race_sql="$2"
  connection_count="$3"
  race_epoch="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select extract(epoch from clock_timestamp() + interval '2 seconds')")"
  race_pids=''
  n=1
  while [ "$n" -le "$connection_count" ]; do
    psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" \
      -c "select pg_sleep(greatest(0, ${race_epoch} - extract(epoch from clock_timestamp()))); ${race_sql}" \
      >"$result_dir/$race_name-$n.out" 2>"$result_dir/$race_name-$n.err" &
    race_pids="$race_pids $!"
    n=$((n + 1))
  done
  for child_pid in $race_pids; do
    if ! wait "$child_pid"; then
      echo "$race_name connection failed" >&2
      sed -n '1,120p' "$result_dir"/"$race_name"-*.err >&2
      exit 1
    fi
  done
  if grep -q '^ERROR:' "$result_dir"/"$race_name"-*.out; then
    echo "$race_name returned an unexpected error" >&2
    sed -n '1,120p' "$result_dir"/"$race_name"-*.out >&2
    exit 1
  fi
}

run_race same-issue 'select invitation_commands_test.try_same_issue(1);' 12
same_created="$(awk '$0 == "CREATED" { count++ } END { print count + 0 }' "$result_dir"/same-issue-*.out)"
same_replayed="$(awk '$0 == "REPLAYED" { count++ } END { print count + 0 }' "$result_dir"/same-issue-*.out)"
same_triplet="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select (select count(*) from authn.invitation_issuances where client_id='83000000-0000-0000-0000-000000000099') || ':' || (select count(*) from authn.outbox o join authn.invitation_issuances i on i.id=o.invitation_id where i.client_id='83000000-0000-0000-0000-000000000099') || ':' || (select count(*) from authn.authentication_audit where relationship_client_id='83000000-0000-0000-0000-000000000099')")"
if [ "$same_created" != 1 ] || [ "$same_replayed" != 11 ] || [ "$same_triplet" != 1:1:1 ]; then
  echo "FAIL same issuance race: created=$same_created replayed=$same_replayed triplet=$same_triplet" >&2
  exit 1
fi
echo "PASS: same-key issuance race -> 1 create, 11 replays, one atomic triplet"

run_race revoke 'select invitation_commands_test.try_revoke('\''83000000-0000-0000-0000-000000000098'\'');' 12
revoke_won="$(awk '$0 == "REVOKED" { count++ } END { print count + 0 }' "$result_dir"/revoke-*.out)"
revoke_replayed="$(awk '$0 == "REPLAYED" { count++ } END { print count + 0 }' "$result_dir"/revoke-*.out)"
revoke_audits="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select count(*) from authn.authentication_audit where relationship_client_id='83000000-0000-0000-0000-000000000098' and event_type='invitation.revoked'")"
if [ "$revoke_won" != 1 ] || [ "$revoke_replayed" != 11 ] || [ "$revoke_audits" != 1 ]; then
  echo "FAIL revoke race: revoked=$revoke_won replayed=$revoke_replayed audits=$revoke_audits" >&2
  exit 1
fi
echo "PASS: revocation race -> 1 transition, 11 replays, one audit"

race_epoch="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select extract(epoch from clock_timestamp() + interval '2 seconds')")"
race_pids=''
n=1
while [ "$n" -le 12 ]; do
  if [ "$n" -le 6 ]; then
    race_sql="select invitation_commands_test.try_revoke('83000000-0000-0000-0000-000000000097');"
  else
    race_sql="select invitation_commands_test.try_issue_after_revoke($n);"
  fi
  psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" \
    -c "select pg_sleep(greatest(0, ${race_epoch} - extract(epoch from clock_timestamp()))); ${race_sql}" \
    >"$result_dir/issue-revoke-$n.out" 2>"$result_dir/issue-revoke-$n.err" &
  race_pids="$race_pids $!"
  n=$((n + 1))
done
for child_pid in $race_pids; do
  if ! wait "$child_pid"; then
    echo "Issue/revoke race connection failed" >&2
    exit 1
  fi
done
if grep -q '^ERROR:' "$result_dir"/issue-revoke-*.out; then
  echo "Issue/revoke race returned an unexpected error" >&2
  sed -n '1,120p' "$result_dir"/issue-revoke-*.out >&2
  exit 1
fi
race_state="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select count(*) filter (where status='revoked') || ':' || count(*) filter (where status='pending') from authn.invitation_issuances where client_id='83000000-0000-0000-0000-000000000097'")"
race_revoke_audits="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select count(*) from authn.authentication_audit where relationship_client_id='83000000-0000-0000-0000-000000000097' and event_type='invitation.revoked'")"
race_triplet="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select (select count(*) from authn.invitation_issuances where client_id='83000000-0000-0000-0000-000000000097') || ':' || (select count(*) from authn.outbox o join authn.invitation_issuances i on i.id=o.invitation_id where i.client_id='83000000-0000-0000-0000-000000000097') || ':' || (select count(*) from authn.authentication_audit where relationship_client_id='83000000-0000-0000-0000-000000000097' and event_type='invitation.created')")"
if [ "$race_revoke_audits" != 1 ] || { [ "$race_state" != 1:0 ] && [ "$race_state" != 1:1 ]; } || { [ "$race_triplet" != 1:1:1 ] && [ "$race_triplet" != 2:2:2 ]; }; then
  echo "FAIL issue/revoke race: state=$race_state triplet=$race_triplet revoke_audits=$race_revoke_audits" >&2
  exit 1
fi
echo "PASS: issue/revoke race -> serial state $race_state, one revoke audit, no orphan"

echo "PASS: Milestone 7F.3 invitation commands"
