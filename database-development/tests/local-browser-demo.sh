#!/usr/bin/env bash
set -euo pipefail

# Disposable, browser-facing TrainerCRM demo. This deliberately does not read
# project dotenv files and never discovers or connects to an existing cluster.

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
root_dir="$(CDPATH= cd -- "$script_dir/../.." && pwd)"
frontend_dir="$root_dir/frontend-app"
migrations_dir="$root_dir/database-development/migrations"
runtime_parent="${XDG_RUNTIME_DIR:-/tmp}"
runtime_dir="$runtime_parent/trainercrm-local-demo-$(id -u)"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

stop_demo() {
  [ -d "$runtime_dir" ] || fail "No local TrainerCRM demo is recorded at $runtime_dir"
  [ ! -L "$runtime_dir" ] || fail "Refusing symlinked demo runtime directory: $runtime_dir"
  [ "$(stat -c %u "$runtime_dir" 2>/dev/null || printf invalid)" = "$(id -u)" ] ||
    fail "Demo runtime directory is not owned by the current user: $runtime_dir"
  [ -r "$runtime_dir/launcher.pid" ] || fail "Demo launcher PID is missing; inspect $runtime_dir"
  launcher_pid="$(cat "$runtime_dir/launcher.pid")"
  [[ "$launcher_pid" =~ ^[1-9][0-9]*$ ]] || fail "Invalid demo launcher PID in $runtime_dir"
  [ -r "$runtime_dir/launcher.starttime" ] || fail "Demo launcher identity is missing; inspect $runtime_dir"
  recorded_starttime="$(cat "$runtime_dir/launcher.starttime")"
  current_starttime="$(awk '{print $22}' "/proc/$launcher_pid/stat" 2>/dev/null || true)"
  [ -n "$current_starttime" ] && [ "$current_starttime" = "$recorded_starttime" ] ||
    fail "Recorded launcher PID no longer identifies this demo; refusing to signal it. Inspect $runtime_dir"
  kill -0 "$launcher_pid" 2>/dev/null ||
    fail "Demo launcher is not running. PGDATA was retained; inspect $runtime_dir before manual recovery."
  kill -TERM "$launcher_pid"
  for _ in $(seq 1 300); do
    [ ! -e "$runtime_dir" ] && { echo "TrainerCRM demo stopped and temporary data removed."; return; }
    kill -0 "$launcher_pid" 2>/dev/null || break
    sleep 0.1
  done
  [ ! -e "$runtime_dir" ] ||
    fail "Demo cleanup was not verified. Data was retained at $runtime_dir"
}

if [ "${1:-start}" = stop ]; then
  [ "$#" -eq 1 ] || fail "Usage: $0 stop"
  stop_demo
  exit 0
fi
[ "${1:-start}" = start ] && [ "$#" -le 1 ] || fail "Usage: $0 [start|stop]"

for command in awk chmod curl id node npm openssl psql setsid stat; do
  command -v "$command" >/dev/null 2>&1 || fail "Required command is unavailable: $command"
done
[ "$(id -un)" != postgres ] && [ "$EUID" -ne 0 ] ||
  fail "Run as an ordinary user, not as postgres or root."
[ -d "$frontend_dir/node_modules" ] || fail "Frontend dependencies are missing; this launcher never installs them."
[ ! -e "$frontend_dir/.next/dev/lock" ] ||
  fail "Next.js development build lock is occupied: $frontend_dir/.next/dev/lock"
[ ! -e "$runtime_dir" ] ||
  fail "Demo runtime path already exists: $runtime_dir (use '$0 stop' if a demo is running)"

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
[ -n "$postgres_bindir" ] || fail "Native PostgreSQL server tools are unavailable; no server was contacted."
initdb="$postgres_bindir/initdb"
pg_ctl="$postgres_bindir/pg_ctl"
psql="$postgres_bindir/psql"
export PATH="$postgres_bindir:$PATH"

old_umask="$(umask)"
umask 077
mkdir "$runtime_dir"
pgdata="$runtime_dir/pgdata"
socket_dir="$runtime_dir/socket"
log_file="$runtime_dir/postgres.log"
app_log="$runtime_dir/application.log"
credentials_file="$runtime_dir/credentials.txt"
mkdir "$pgdata" "$socket_dir"
chmod 700 "$runtime_dir" "$pgdata" "$socket_dir"
printf '%s\n' "$$" >"$runtime_dir/launcher.pid"
awk '{print $22}' "/proc/$$/stat" >"$runtime_dir/launcher.starttime"

server_started=no
app_pid=""
cleanup() {
  local status=$? cleanup_failed=no
  trap - EXIT INT TERM
  set +e
  if [ -n "$app_pid" ]; then
    if kill -0 "$app_pid" 2>/dev/null; then
      kill -TERM -- "-$app_pid" 2>/dev/null
      for _ in $(seq 1 100); do
        kill -0 "$app_pid" 2>/dev/null || break
        sleep 0.1
      done
    fi
    if kill -0 "$app_pid" 2>/dev/null; then
      echo "Application process did not stop; temporary data was retained at $runtime_dir" >&2
      cleanup_failed=yes
    else
      wait "$app_pid" 2>/dev/null
    fi
  fi
  if [ "$server_started" = yes ]; then
    if "$pg_ctl" -D "$pgdata" status >/dev/null 2>&1; then
      "$pg_ctl" -D "$pgdata" -m fast -w stop >/dev/null 2>&1
    fi
    if "$pg_ctl" -D "$pgdata" status >/dev/null 2>&1; then
      echo "PostgreSQL shutdown could not be verified; PGDATA was retained at $pgdata" >&2
      cleanup_failed=yes
    else
      server_started=no
    fi
  fi
  if [ "$cleanup_failed" = no ]; then
    rm -rf -- "$runtime_dir"
  else
    status=1
  fi
  unset TRAINERCRM_DATABASE_URL PGPASSWORD PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER
  umask "$old_umask"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Ignore all inherited libpq selectors. Every administrative connection below
# is explicitly pinned to this cluster's private Unix socket.
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE
unset PGSERVICE PGSERVICEFILE PGOPTIONS PGREQUIRESSL PGSSLMODE

random_port() {
  node <<'NODE'
const server = require("node:net").createServer();
server.on("error", (error) => { throw error; });
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port));
  server.close();
});
NODE
}

pg_port="$(random_port)"
app_port="$(random_port)"
while [ "$pg_port" = "$app_port" ]; do app_port="$(random_port)"; done
suffix="$(openssl rand -hex 8)"
database_name="trainercrm_demo_${suffix}"
cluster_admin="trainercrm_demo_cluster_admin"
operator_role="trainercrm_demo_operator"
app_role="trainercrm_app"
app_password="$(openssl rand -hex 32)"
trainer_one_password="$(openssl rand -base64 30 | tr -d '\n')"
trainer_two_password="$(openssl rand -base64 30 | tr -d '\n')"

"$initdb" -D "$pgdata" --username="$cluster_admin" --auth-local=trust \
  --auth-host=reject --no-locale --encoding=UTF8 >/dev/null
# Permit TCP only for the generated application role/database pair. Migration
# administration remains pinned to the private Unix socket; every other host
# connection is rejected even though PostgreSQL listens only on loopback.
{
  printf 'local all all trust\n'
  printf 'host %s %s 127.0.0.1/32 scram-sha-256\n' "$database_name" "$app_role"
  printf 'host all all 127.0.0.1/32 reject\n'
  printf 'host all all ::1/128 reject\n'
} >"$pgdata/pg_hba.conf"
server_started=yes
postgres_options="-c listen_addresses=127.0.0.1 -c unix_socket_directories=$socket_dir -c unix_socket_permissions=0700 -c port=$pg_port"
"$pg_ctl" -D "$pgdata" -l "$log_file" -o "$postgres_options" -w start ||
  fail "Isolated PostgreSQL failed to start (the random port may have become occupied); see $log_file"

bootstrap_sql="$runtime_dir/bootstrap.sql"
cat >"$bootstrap_sql" <<'SQL'
CREATE ROLE trainercrm_demo_operator
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE trainercrm_app
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE trainercrm_clients_function_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT trainercrm_clients_function_owner TO trainercrm_demo_operator;
SQL
# Create roles first, then create the randomized database through a quoted psql variable.
"$psql" -X --host="$socket_dir" --port="$pg_port" --username="$cluster_admin" \
  --dbname=postgres -v ON_ERROR_STOP=1 --single-transaction -f "$bootstrap_sql" >/dev/null
{
  printf "\\set app_password '%s'\n" "$app_password"
  cat <<'SQL'
ALTER ROLE trainercrm_app PASSWORD :'app_password';
SELECT format('CREATE DATABASE %I OWNER trainercrm_demo_operator', :'database_name') \gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'database_name') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO trainercrm_app', :'database_name') \gexec
SQL
} | "$psql" -X --host="$socket_dir" --port="$pg_port" --username="$cluster_admin" \
  --dbname=postgres -v ON_ERROR_STOP=1 -v database_name="$database_name" >/dev/null

for migration in "$migrations_dir"/{001_extensions,002_schema,003_booking_functions,004_auth_foundation,005_auth_invitation_commands,006_email_subject_compatibility,007_auth_invitation_acceptance,008_auth_preauth_nonce_consumption,009_trainer_login_foundation,010_trainer_login_runtime,011_trainer_clients_runtime}.sql; do
  "$psql" -X --host="$socket_dir" --port="$pg_port" --username="$operator_role" \
    --dbname="$database_name" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
done

ids="$(node <<'NODE'
const { randomUUID } = require("node:crypto");
process.stdout.write(Array.from({ length: 6 }, () => randomUUID()).join("\n"));
NODE
)"
mapfile -t demo_ids <<<"$ids"
[ "${#demo_ids[@]}" -eq 6 ] || fail "Could not generate demo identifiers."
hashes="$(TRAINER_ONE_PASSWORD="$trainer_one_password" TRAINER_TWO_PASSWORD="$trainer_two_password" node <<'NODE'
const { randomBytes, scrypt } = require("node:crypto");
const hash = (password) => new Promise((resolve, reject) => {
  const salt = randomBytes(16);
  scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, key) => {
    if (error) reject(error);
    else resolve(`$scrypt$v=1$N=16384,r=8,p=1$${salt.toString("base64url")}$${key.toString("base64url")}`);
  });
});
Promise.all([hash(process.env.TRAINER_ONE_PASSWORD), hash(process.env.TRAINER_TWO_PASSWORD)])
  .then((values) => process.stdout.write(values.join("\n")))
  .catch((error) => { throw error; });
NODE
)"
mapfile -t password_hashes <<<"$hashes"
[ "${#password_hashes[@]}" -eq 2 ] || fail "Could not create trainer password hashes."

"$psql" -X --host="$socket_dir" --port="$pg_port" --username="$operator_role" \
  --dbname="$database_name" -v ON_ERROR_STOP=1 \
  -v tenant_one="${demo_ids[0]}" -v trainer_one="${demo_ids[1]}" -v identity_one="${demo_ids[2]}" \
  -v tenant_two="${demo_ids[3]}" -v trainer_two="${demo_ids[4]}" -v identity_two="${demo_ids[5]}" \
  -v hash_one="${password_hashes[0]}" -v hash_two="${password_hashes[1]}" <<'SQL' >/dev/null
BEGIN;
INSERT INTO booking.tenants(id, public_slug) VALUES
  (:'tenant_one', 'local-demo-trainer-one'), (:'tenant_two', 'local-demo-trainer-two');
INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref) VALUES
  (:'trainer_one', 'trainer', 'synthetic:local_demo_trainer_one'),
  (:'trainer_two', 'trainer', 'synthetic:local_demo_trainer_two');
INSERT INTO booking.trainer_memberships(tenant_id, trainer_id) VALUES
  (:'tenant_one', :'trainer_one'), (:'tenant_two', :'trainer_two');
INSERT INTO authn.email_identities(
  id, subject_id, normalization_version, canonical_email, display_email, verified_at
) VALUES
  (:'identity_one', :'trainer_one', 1, 'trainer.one@example.invalid', 'trainer.one@example.invalid', transaction_timestamp()),
  (:'identity_two', :'trainer_two', 1, 'trainer.two@example.invalid', 'trainer.two@example.invalid', transaction_timestamp());
INSERT INTO authn.trainer_password_credentials(
  trainer_subject_id, email_identity_id, password_hash, password_changed_at
) VALUES
  (:'trainer_one', :'identity_one', :'hash_one', transaction_timestamp()),
  (:'trainer_two', :'identity_two', :'hash_two', transaction_timestamp());
COMMIT;
SQL
unset hashes password_hashes

privileges="$runtime_dir/privileges"
PGPASSWORD="$app_password" "$psql" -X -At --host=127.0.0.1 --port="$pg_port" \
  --username="$app_role" --dbname="$database_name" -v ON_ERROR_STOP=1 <<'SQL' >"$privileges"
SELECT has_table_privilege(current_user, 'authn.trainer_sessions', 'SELECT'),
       has_table_privilege(current_user, 'booking.clients', 'SELECT'),
       has_function_privilege(current_user, 'authn.resolve_trainer_password(text)', 'EXECUTE'),
       has_function_privilege(current_user, 'booking.list_trainer_clients(bytea)', 'EXECUTE'),
       has_function_privilege(current_user, 'booking.create_trainer_client(bytea,text,numeric)', 'EXECUTE');
SQL
grep -qx 'f|f|t|t|t' "$privileges" || fail "Least-privilege application role assertion failed."

base_url="http://127.0.0.1:$app_port"
{
  printf 'TrainerCRM local demo\n\n'
  printf 'Browser URL: %s\n\n' "$base_url"
  printf 'Trainer one\nEmail: trainer.one@example.invalid\nPassword: %s\nTenant: local-demo-trainer-one\n\n' "$trainer_one_password"
  printf 'Trainer two\nEmail: trainer.two@example.invalid\nPassword: %s\nTenant: local-demo-trainer-two\n' "$trainer_two_password"
} >"$credentials_file"
chmod 600 "$credentials_file"

database_url="postgresql://${app_role}:${app_password}@127.0.0.1:${pg_port}/${database_name}"
unset app_password
(
  cd "$frontend_dir"
  export TRAINERCRM_DATABASE_URL="$database_url" NODE_ENV=development
  exec setsid npm run dev -- --hostname 127.0.0.1 --port "$app_port"
) >"$app_log" 2>&1 &
app_pid=$!
printf '%s\n' "$app_pid" >"$runtime_dir/application.pid"
unset database_url

ready=no
for _ in $(seq 1 160); do
  kill -0 "$app_pid" 2>/dev/null || fail "Application exited before readiness; see $app_log"
  if curl --silent --show-error --fail --max-time 2 "$base_url/api/health" -o /dev/null 2>/dev/null; then
    ready=yes
    break
  fi
  sleep 0.25
done
[ "$ready" = yes ] || fail "Application readiness timed out; see $app_log"

# Authenticate both synthetic accounts without printing secrets or cookies.
for trainer_number in one two; do
  email="trainer.$trainer_number@example.invalid"
  if [ "$trainer_number" = one ]; then password="$trainer_one_password"; expected_trainer="${demo_ids[1]}"; else password="$trainer_two_password"; expected_trainer="${demo_ids[4]}"; fi
  login_body="$runtime_dir/login-$trainer_number.json"
  response_body="$runtime_dir/login-$trainer_number-response.json"
  cookies="$runtime_dir/cookies-$trainer_number"
  EMAIL="$email" PASSWORD="$password" node -e 'process.stdout.write(JSON.stringify({email:process.env.EMAIL,password:process.env.PASSWORD}))' >"$login_body"
  status="$(curl --silent --show-error --max-time 10 -o "$response_body" -c "$cookies" -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' --data-binary "@$login_body" "$base_url/api/auth/login")"
  [ "$status" = 200 ] || fail "Authentication readiness check failed for trainer $trainer_number (HTTP $status)."
  EXPECTED_TRAINER="$expected_trainer" RESPONSE_FILE="$response_body" node <<'NODE' || fail "Authentication returned the wrong trainer."
const body = require(process.env.RESPONSE_FILE);
if (body?.trainer?.trainerId !== process.env.EXPECTED_TRAINER) process.exit(1);
NODE
  status="$(curl --silent --show-error --max-time 10 -o /dev/null -b "$cookies" -w '%{http_code}' "$base_url/api/auth/me")"
  [ "$status" = 200 ] || fail "Authenticated session readiness check failed for trainer $trainer_number."
  rm -f -- "$login_body" "$response_body" "$cookies"
done
unset trainer_one_password trainer_two_password password

printf '\nTrainerCRM local demo is ready.\nBrowser URL: %s\nCredentials: %s (mode 600)\nLogs: %s and %s\nStop command: %s stop\n\n' \
  "$base_url" "$credentials_file" "$app_log" "$log_file" "$0"
echo "This launcher remains attached and will keep the demo running."

wait "$app_pid"
app_status=$?
app_pid=""
fail "Application server exited with status $app_status; see $app_log"
