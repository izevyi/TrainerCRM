#!/usr/bin/env bash
set -eu

: "${DATABASE_URL:?Set DATABASE_URL to a dedicated synthetic test database ending in _7c_test}"
: "${TRAINERCRM_ALLOW_TEST_RESET:?Set TRAINERCRM_ALLOW_TEST_RESET=yes to allow the guarded test schema reset}"
if [ "$TRAINERCRM_ALLOW_TEST_RESET" != yes ]; then
  echo "Refusing reset without TRAINERCRM_ALLOW_TEST_RESET=yes" >&2
  exit 2
fi

database_name="$(psql -X -At "$DATABASE_URL" -c 'select current_database()')"
case "$database_name" in
  *_7c_test) ;;
  *) echo "Refusing to modify non-test database: $database_name" >&2; exit 2 ;;
esac

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS booking_test CASCADE'
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'DROP SCHEMA IF EXISTS booking CASCADE'
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/001_extensions.sql"
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/002_schema.sql"
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/migrations/003_booking_functions.sql"
psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/tests/serial.sql"
"$root_dir/tests/concurrency.sh"
