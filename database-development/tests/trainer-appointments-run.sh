#!/usr/bin/env bash
set -euo pipefail

: "${TRAINERCRM_APPOINTMENTS_TEST_DATABASE:?launcher database required}"
: "${TRAINERCRM_APPOINTMENTS_TEST_OPERATOR:?launcher operator required}"
: "${TRAINERCRM_APPOINTMENTS_TEST_MARKER:?launcher marker required}"
: "${TRAINERCRM_ALLOW_APPOINTMENTS_TEST_INIT:?explicit initialization opt-in required}"
[ "$TRAINERCRM_ALLOW_APPOINTMENTS_TEST_INIT" = yes ] || exit 2
[[ "$TRAINERCRM_APPOINTMENTS_TEST_DATABASE" =~ ^trainercrm_pilot_3a_[0-9a-f]{16}_test$ ]] || exit 2
[[ "$TRAINERCRM_APPOINTMENTS_TEST_OPERATOR" =~ ^trainercrm_pilot_3a_[0-9a-f]{16}_operator$ ]] || exit 2
[[ "$TRAINERCRM_APPOINTMENTS_TEST_MARKER" =~ ^trainercrm:disposable:pilot-3a:[0-9a-f]{32}$ ]] || exit 2

identity="$(psql -X -At -v ON_ERROR_STOP=1 -c "SELECT current_database() || '|' || session_user || '|' || pg_get_userbyid(datdba) || '|' || rolsuper || '|' || coalesce(shobj_description(pg_database.oid, 'pg_database'), '') FROM pg_database JOIN pg_roles ON rolname=session_user WHERE datname=current_database()")"
[ "$identity" = "$TRAINERCRM_APPOINTMENTS_TEST_DATABASE|$TRAINERCRM_APPOINTMENTS_TEST_OPERATOR|$TRAINERCRM_APPOINTMENTS_TEST_OPERATOR|false|$TRAINERCRM_APPOINTMENTS_TEST_MARKER" ] || { echo "Unsafe disposable database identity" >&2; exit 2; }
[ "$(psql -X -At -v ON_ERROR_STOP=1 -c "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('booking','authn'))")" = f ] || { echo "Refusing non-empty database" >&2; exit 2; }

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
for migration_number in 001 002 003 004 005 006 007 008 009 010 011 012; do
  migration=("$root_dir"/migrations/"$migration_number"_*.sql)
  [ "${#migration[@]}" -eq 1 ] && [ -f "${migration[0]}" ] || exit 2
  psql -X -v ON_ERROR_STOP=1 -f "${migration[0]}"
done
psql -X -v ON_ERROR_STOP=1 -f "$root_dir/tests/trainer-appointments.sql"
