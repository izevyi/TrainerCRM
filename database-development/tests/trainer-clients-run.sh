#!/usr/bin/env bash
set -euo pipefail

: "${TRAINERCRM_CLIENTS_TEST_DATABASE:?Set the launcher-provided database name}"
: "${TRAINERCRM_CLIENTS_TEST_OPERATOR:?Set the launcher-provided operator role}"
: "${TRAINERCRM_CLIENTS_TEST_MARKER:?Set the launcher-provided disposable marker}"
: "${TRAINERCRM_ALLOW_CLIENTS_TEST_INIT:?Set TRAINERCRM_ALLOW_CLIENTS_TEST_INIT=yes}"

if [ "$TRAINERCRM_ALLOW_CLIENTS_TEST_INIT" != yes ]; then
  echo "Refusing initialization without TRAINERCRM_ALLOW_CLIENTS_TEST_INIT=yes" >&2
  exit 2
fi
if [[ ! "$TRAINERCRM_CLIENTS_TEST_DATABASE" =~ ^trainercrm_pilot_2c1_[0-9a-f]{16}_test$ ]] ||
   [[ ! "$TRAINERCRM_CLIENTS_TEST_OPERATOR" =~ ^trainercrm_pilot_2c1_[0-9a-f]{16}_operator$ ]] ||
   [[ ! "$TRAINERCRM_CLIENTS_TEST_MARKER" =~ ^trainercrm:disposable:pilot-2c1:[0-9a-f]{32}$ ]]; then
  echo "Refusing initialization: launcher resource names or marker are invalid." >&2
  exit 2
fi

test_psql() {
  psql -X -v ON_ERROR_STOP=1 "$@"
}

database_identity="$(test_psql -At -c "
SELECT current_database() || '|' || session_user || '|' ||
       pg_get_userbyid(datdba) || '|' || rolsuper::text || '|' ||
       coalesce(shobj_description(pg_database.oid, 'pg_database'), '')
  FROM pg_database
  JOIN pg_roles ON rolname = session_user
 WHERE datname = current_database()
")"
expected_identity="$TRAINERCRM_CLIENTS_TEST_DATABASE|$TRAINERCRM_CLIENTS_TEST_OPERATOR|$TRAINERCRM_CLIENTS_TEST_OPERATOR|false|$TRAINERCRM_CLIENTS_TEST_MARKER"
if [ "$database_identity" != "$expected_identity" ]; then
  echo "Refusing initialization: database identity, owner, operator, or disposable marker mismatch." >&2
  exit 2
fi

role_state="$(test_psql -At -c "
SELECT string_agg(rolname || ':' || rolcanlogin || ':' || rolsuper || ':' ||
                  rolcreatedb || ':' || rolcreaterole || ':' || rolinherit || ':' ||
                  rolreplication || ':' || rolbypassrls, ',' ORDER BY rolname)
  FROM pg_roles
 WHERE rolname IN ('trainercrm_app', 'trainercrm_clients_function_owner')
")"
if [ "$role_state" != 'trainercrm_app:true:false:false:false:true:false:false,trainercrm_clients_function_owner:false:false:false:false:false:false:false' ]; then
  echo "Required least-privilege disposable roles are missing or unsafe." >&2
  exit 2
fi
membership_state="$(test_psql -At -c "
SELECT pg_has_role(current_user, 'trainercrm_app', 'MEMBER') || '|' ||
       pg_has_role(current_user, 'trainercrm_clients_function_owner', 'MEMBER') || '|' ||
       NOT EXISTS (
         SELECT 1 FROM pg_auth_members
          WHERE member = (SELECT oid FROM pg_roles
                           WHERE rolname = 'trainercrm_clients_function_owner')
       )
")"
if [ "$membership_state" != 'true|true|true' ]; then
  echo "Operator memberships or function-owner isolation are invalid." >&2
  exit 2
fi

# Initialize only a database proven empty and freshly marked by the launcher.
# Never reset or drop schemas in an existing database.
schema_state="$(test_psql -At -c "
SELECT EXISTS (
  SELECT 1 FROM pg_namespace WHERE nspname IN ('booking', 'authn')
)::text
")"
if [ "$schema_state" != false ]; then
  echo "Refusing initialization: booking or authn already exists." >&2
  exit 2
fi

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
for migration_number in 001 002 003 004 005 006 007 008 009 010 011; do
  migration=("$root_dir"/migrations/"$migration_number"_*.sql)
  if [ "${#migration[@]}" -ne 1 ] || [ ! -f "${migration[0]}" ]; then
    echo "Expected exactly one migration matching ${migration_number}_*.sql" >&2
    exit 2
  fi
  test_psql -f "${migration[0]}"
done
test_psql -f "$root_dir/tests/trainer-clients.sql"
