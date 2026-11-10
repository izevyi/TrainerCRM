#!/usr/bin/env bash
set -euo pipefail

for command in openssl mktemp chmod id; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command" >&2; exit 2;
  }
done
if [ "$(id -un)" = postgres ] || [ "$EUID" -eq 0 ]; then
  echo "Run as an ordinary WSL user, not as postgres or root." >&2; exit 2
fi

find_postgres_bindir() {
  local candidate executable
  if command -v pg_config >/dev/null 2>&1; then
    candidate="$(pg_config --bindir 2>/dev/null || true)"
    if [ -n "$candidate" ]; then
      for executable in initdb pg_ctl postgres psql; do
        [ -x "$candidate/$executable" ] || candidate=""
      done
      [ -n "$candidate" ] && { printf '%s\n' "$candidate"; return; }
    fi
  fi
  for candidate in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin; do
    [ -d "$candidate" ] || continue
    for executable in initdb pg_ctl postgres psql; do
      [ -x "$candidate/$executable" ] || candidate=""
    done
    [ -n "$candidate" ] && { printf '%s\n' "$candidate"; return; }
  done
  return 1
}

postgres_bindir="$(find_postgres_bindir || true)"
if [ -z "$postgres_bindir" ]; then
  echo "PostgreSQL server tools are unavailable." >&2
  echo "Install native PostgreSQL binaries providing pg_config, initdb, pg_ctl, postgres, and psql; no existing server was contacted." >&2
  exit 2
fi
initdb="$postgres_bindir/initdb"
pg_ctl="$postgres_bindir/pg_ctl"
psql="$postgres_bindir/psql"
export PATH="$postgres_bindir:$PATH"

tests_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
temporary_dir="$(mktemp -d /tmp/trainercrm-pilot-2c1.XXXXXXXX)"
pgdata="$temporary_dir/pgdata"
socket_dir="$temporary_dir/socket"
log_file="$temporary_dir/postgres.log"
chmod 700 "$temporary_dir"
mkdir "$pgdata" "$socket_dir"
chmod 700 "$pgdata" "$socket_dir"

suffix="$(openssl rand -hex 8)"
marker="trainercrm:disposable:pilot-2c1:$(openssl rand -hex 16)"
database_name="trainercrm_pilot_2c1_${suffix}_test"
operator_role="trainercrm_pilot_2c1_${suffix}_operator"
cluster_admin="trainercrm_pilot_2c1_cluster_admin"
server_started=no

# Ignore inherited libpq connection selectors and pin every connection to the
# private socket. The server is configured not to open a TCP listener.
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE
unset PGSERVICE PGSERVICEFILE PGOPTIONS PGREQUIRESSL PGSSLMODE
export PGHOST="$socket_dir" PGPORT=5432

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [ "$server_started" = yes ]; then
    if "$pg_ctl" -D "$pgdata" status >/dev/null 2>&1; then
      "$pg_ctl" -D "$pgdata" -m fast -w stop >/dev/null 2>&1
    fi
    if "$pg_ctl" -D "$pgdata" status >/dev/null 2>&1; then
      echo "Temporary PostgreSQL shutdown could not be verified; data was retained." >&2
      printf 'Temporary directory: %s\n' "$temporary_dir" >&2
      printf 'Recovery: %q -D %q -m fast -w stop\n' "$pg_ctl" "$pgdata" >&2
      exit 1
    fi
    server_started=no
  fi
  rm -rf -- "$temporary_dir"
  unset PGHOST PGPORT PGDATABASE PGUSER TRAINERCRM_CLIENTS_TEST_DATABASE
  unset TRAINERCRM_CLIENTS_TEST_OPERATOR TRAINERCRM_CLIENTS_TEST_MARKER
  unset TRAINERCRM_ALLOW_CLIENTS_TEST_INIT
  if [ "$status" -eq 0 ]; then
    echo "Cleanup verified: temporary PostgreSQL stopped and PGDATA removed."
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$initdb" -D "$pgdata" --username="$cluster_admin" --auth-local=trust \
  --auth-host=reject --no-locale --encoding=UTF8 >/dev/null
server_started=yes
postgres_options="-c listen_addresses= -c unix_socket_directories=$socket_dir -c unix_socket_permissions=0700 -c port=5432"
"$pg_ctl" -D "$pgdata" -l "$log_file" -o "$postgres_options" -w start

bootstrap_sql="$temporary_dir/bootstrap.sql"
cat >"$bootstrap_sql" <<'SQL'
CREATE ROLE trainercrm_app
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE trainercrm_clients_function_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'operator_role'
) \gexec
SELECT format('GRANT trainercrm_app TO %I', :'operator_role') \gexec
SELECT format(
  'GRANT trainercrm_clients_function_owner TO %I', :'operator_role'
) \gexec
SQL
"$psql" -X --host="$socket_dir" --port=5432 --username="$cluster_admin" \
  --dbname=postgres -v ON_ERROR_STOP=1 -v operator_role="$operator_role" \
  --single-transaction -f "$bootstrap_sql" >/dev/null
provision_database_sql="$temporary_dir/provision-database.sql"
cat >"$provision_database_sql" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'op') \gexec
SELECT format('COMMENT ON DATABASE %I IS %L', :'db', :'marker') \gexec
SQL
"$psql" -X --host="$socket_dir" --port=5432 --username="$cluster_admin" \
  --dbname=postgres -v ON_ERROR_STOP=1 -v db="$database_name" \
  -v op="$operator_role" -v marker="$marker" \
  -f "$provision_database_sql" >/dev/null

export PGDATABASE="$database_name" PGUSER="$operator_role"
export TRAINERCRM_CLIENTS_TEST_DATABASE="$database_name"
export TRAINERCRM_CLIENTS_TEST_OPERATOR="$operator_role"
export TRAINERCRM_CLIENTS_TEST_MARKER="$marker"
export TRAINERCRM_ALLOW_CLIENTS_TEST_INIT=yes

echo "Running trainer-client integration tests in an isolated temporary PostgreSQL cluster."
"$tests_dir/trainer-clients-run.sh"
echo "PASS: PostgreSQL trainer-client integration tests completed."
