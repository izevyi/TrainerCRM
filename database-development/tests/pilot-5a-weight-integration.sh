#!/usr/bin/env bash
set -euo pipefail

for command in openssl mktemp chmod id; do command -v "$command" >/dev/null || exit 2; done
[ "$EUID" -ne 0 ] && [ "$(id -un)" != postgres ] || { echo "Run as an ordinary user" >&2; exit 2; }
bindir="$(pg_config --bindir 2>/dev/null || true)"
for executable in initdb pg_ctl postgres psql; do [ -x "$bindir/$executable" ] || { echo "PostgreSQL server tools are unavailable" >&2; exit 2; }; done
export PATH="$bindir:$PATH"
tests_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
temporary_dir="$(mktemp -d /tmp/trainercrm-pilot-4a.XXXXXXXX)"
pgdata="$temporary_dir/pgdata"; socket_dir="$temporary_dir/socket"; log_file="$temporary_dir/postgres.log"
chmod 700 "$temporary_dir"; mkdir "$pgdata" "$socket_dir"; chmod 700 "$pgdata" "$socket_dir"
suffix="$(openssl rand -hex 8)"; marker="trainercrm:disposable:pilot-4a:$(openssl rand -hex 16)"
database_name="trainercrm_pilot_4a_${suffix}_test"; operator_role="trainercrm_pilot_4a_${suffix}_operator"
cluster_admin=trainercrm_pilot_4a_cluster_admin; server_started=no
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGOPTIONS
export PGHOST="$socket_dir" PGPORT=5432
cleanup() {
  status=$?; trap - EXIT INT TERM; set +e
  if [ "$server_started" = yes ]; then "$bindir/pg_ctl" -D "$pgdata" -m fast -w stop >/dev/null 2>&1; fi
  rm -rf -- "$temporary_dir"
  [ "$status" -ne 0 ] || echo "Cleanup verified: temporary PostgreSQL stopped and removed."
  exit "$status"
}
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
"$bindir/initdb" -D "$pgdata" --username="$cluster_admin" --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >/dev/null
server_started=yes
if ! "$bindir/pg_ctl" -D "$pgdata" -l "$log_file" -o "-c listen_addresses= -c unix_socket_directories=$socket_dir -c unix_socket_permissions=0700 -c port=5432" -w start >/dev/null; then
  sed -n '1,160p' "$log_file" >&2
  exit 2
fi
"$bindir/psql" -X -U "$cluster_admin" -d postgres -v ON_ERROR_STOP=1 -v op="$operator_role" <<'SQL' >/dev/null
CREATE ROLE trainercrm_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE trainercrm_clients_function_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', :'op') \gexec
SELECT format('GRANT trainercrm_app, trainercrm_clients_function_owner TO %I', :'op') \gexec
SQL
"$bindir/psql" -X -U "$cluster_admin" -d postgres -v ON_ERROR_STOP=1 -v db="$database_name" -v op="$operator_role" -v marker="$marker" <<'SQL' >/dev/null
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'op') \gexec
SELECT format('COMMENT ON DATABASE %I IS %L', :'db', :'marker') \gexec
SQL
export PGDATABASE="$database_name" PGUSER="$operator_role"
export TRAINERCRM_WORKOUTS_TEST_DATABASE="$database_name" TRAINERCRM_WORKOUTS_TEST_OPERATOR="$operator_role"
export TRAINERCRM_WORKOUTS_TEST_MARKER="$marker" TRAINERCRM_ALLOW_WORKOUTS_TEST_INIT=yes
echo "Running workout tests in an isolated temporary PostgreSQL cluster."
"$tests_dir/trainer-workouts-run.sh"
echo "===== APPLY WEIGHT HISTORY MIGRATION 015 ====="
psql -X -v ON_ERROR_STOP=1 -f "$tests_dir/../migrations/015_trainer_client_weight_history.sql" > /dev/null
psql -X -v ON_ERROR_STOP=1 -f "$tests_dir/trainer-weight-measurements.sql"
echo "PASS: isolated PostgreSQL client weight integration tests completed."
