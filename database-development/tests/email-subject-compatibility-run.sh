#!/usr/bin/env bash
set -eu

: "${DATABASE_URL:?Set DATABASE_URL to the dedicated trainercrm_7f4_test database}"
: "${TRAINERCRM_ALLOW_7F4_TEST_RESET:?Set TRAINERCRM_ALLOW_7F4_TEST_RESET=yes to allow the guarded fixture reset}"

if [ "$TRAINERCRM_ALLOW_7F4_TEST_RESET" != yes ]; then
  echo "Refusing reset without TRAINERCRM_ALLOW_7F4_TEST_RESET=yes" >&2
  exit 2
fi

database_name="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'select current_database()')"
if [ "$database_name" != trainercrm_7f4_test ]; then
  echo "Refusing to modify database other than trainercrm_7f4_test: $database_name" >&2
  exit 2
fi

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

reset_schemas() {
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS email_subject_compatibility_test CASCADE'
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS invitation_commands_test CASCADE'
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS authn_test CASCADE'
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS booking_test CASCADE'
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS authn CASCADE'
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS booking CASCADE'
}

apply_migrations() {
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/001_extensions.sql"
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/002_schema.sql"
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/003_booking_functions.sql"
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/004_auth_foundation.sql"
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/005_auth_invitation_commands.sql"
  psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/006_email_subject_compatibility.sql"
}

# This runner never creates or drops a database. It resets only fixed fixture
# schemas after both exact guards above have succeeded.
reset_schemas
apply_migrations
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/tests/email-subject-compatibility.sql"

# Existing booking regression SQL is executed unchanged against the migrated
# schema. The independent-connection race scripts are then run unchanged.
reset_schemas
apply_migrations
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/tests/serial.sql"
"$root_dir/tests/concurrency.sh"
"$root_dir/tests/extended-concurrency.sh"

# Existing authentication regression SQL is also executed unchanged. Their
# original runners target other exact disposable databases, so this 7F.4 runner
# invokes the SQL suites directly after an isolated reset.
reset_schemas
apply_migrations
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/tests/auth-foundation.sql"

reset_schemas
apply_migrations
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/tests/invitation-commands.sql"

echo "PASS: Milestone 7F.4 email subject compatibility and regressions"
