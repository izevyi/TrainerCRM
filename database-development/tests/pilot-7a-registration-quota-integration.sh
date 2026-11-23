#!/usr/bin/env bash
set -euo pipefail

[ "${EUID}" -ne 0 ] && [ "$(id -un)" != postgres ] || { echo 'Run as ordinary unprivileged user' >&2; exit 2; }
for cmd in openssl mktemp chmod id pg_config; do command -v "$cmd" >/dev/null || exit 2; done
bindir="$(pg_config --bindir)"
for cmd in initdb pg_ctl postgres psql; do [ -x "$bindir/$cmd" ] || { echo "Missing PG server tool $cmd" >&2; exit 2; }; done
export PATH="$bindir:$PATH"
tests_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
root_dir="$(CDPATH= cd -- "$tests_dir/.." && pwd)"
base="$(mktemp -d /tmp/trainercrm-register-7a.XXXXXXXX)"
pgdata="$base/pgdata"; socket="$base/socket"; log="$base/pg.log"
chmod 700 "$base"; mkdir "$pgdata" "$socket"; chmod 700 "$pgdata" "$socket"
started=no
cleanup() {
  rc=$?; trap - EXIT INT TERM; set +e
  if [ "$started" = yes ]; then "$bindir/pg_ctl" -D "$pgdata" -m fast -w stop >/dev/null 2>&1; fi
  rm -rf -- "$base"
  [ "$rc" -ne 0 ] || echo 'Cleanup verified: temporary PostgreSQL stopped and removed.'
  exit "$rc"
}
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGOPTIONS
export PGHOST="$socket" PGPORT=5432
admin=trainercrm_registration_cluster_admin
suffix="$(openssl rand -hex 8)"
operator="trainercrm_registration_${suffix}_operator"
database="trainercrm_registration_${suffix}_test"
"$bindir/initdb" -D "$pgdata" --username="$admin" --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >/dev/null
started=yes
"$bindir/pg_ctl" -D "$pgdata" -l "$log" -o "-c listen_addresses= -c unix_socket_directories=$socket -c unix_socket_permissions=0700" -w start >/dev/null
"$bindir/psql" -X -U "$admin" -d postgres -v ON_ERROR_STOP=1 -v op="$operator" <<'SQL' >/dev/null
CREATE ROLE trainercrm_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE trainercrm_clients_function_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE trainercrm_login_rate_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE trainercrm_registration_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', :'op') \gexec
SELECT format('GRANT trainercrm_app, trainercrm_clients_function_owner, trainercrm_login_rate_owner, trainercrm_registration_owner TO %I', :'op') \gexec
SQL
"$bindir/psql" -X -U "$admin" -d postgres -v ON_ERROR_STOP=1 -v db="$database" -v op="$operator" <<'SQL' >/dev/null
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'op') \gexec
SQL
export PGDATABASE="$database" PGUSER="$operator"
echo '===== APPLY FRESH MIGRATIONS 001 THROUGH 017 ====='
for n in $(seq -w 1 17); do
  migration=("$root_dir"/migrations/"$(printf '%03d' "$((10#$n))")"_*.sql)
  [ "${#migration[@]}" -eq 1 ] && [ -f "${migration[0]}" ] || { echo "Expected one migration $n" >&2; exit 2; }
  "$bindir/psql" -X -v ON_ERROR_STOP=1 -f "${migration[0]}" > /dev/null
done
echo '===== TEST REGISTRATION RATE QUOTAS ====='
"$bindir/psql" -X -v ON_ERROR_STOP=1 -f "$tests_dir/trainer-registration-quota.sql"
echo 'PASS: isolated PostgreSQL registration quota integration tests completed.'
