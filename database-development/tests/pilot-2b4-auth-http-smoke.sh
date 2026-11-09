#!/usr/bin/env bash
set -euo pipefail

# Local disposable PostgreSQL + real HTTP authentication smoke test. PostgreSQL
# administration uses peer auth; the application remains owned by this user.
for command in sudo psql node npm curl jq openssl sed setsid grep mktemp id; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command" >&2
    exit 2
  }
done

if [ "$(id -un)" = postgres ] || [ "$EUID" -eq 0 ]; then
  echo "Run this script as an ordinary WSL user, not as postgres or root." >&2
  exit 2
fi

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
frontend_dir="$root_dir/frontend-app"
migrations_dir="$root_dir/database-development/migrations"
temporary_dir="$(mktemp -d)"
random_suffix="$(openssl rand -hex 8)"
database_name="trainercrm_pilot_2b4_${random_suffix}_test"
application_role="trainercrm_pilot_2b4_${random_suffix}_app"
application_password="$(openssl rand -hex 32)"
trainer_password="$(openssl rand -base64 36 | tr -d '\n')"
trainer_email="pilot-2b4-${random_suffix}@example.invalid"
postgres_socket="${TRAINERCRM_POSTGRES_SOCKET:-/var/run/postgresql}"
server_pid=""
database_created=no
role_created=no
chmod 700 "$temporary_dir"

valid_resource_names() {
  [[ "$database_name" =~ ^trainercrm_pilot_2b4_[0-9a-f]{16}_test$ ]] &&
    [[ "$application_role" =~ ^trainercrm_pilot_2b4_[0-9a-f]{16}_app$ ]]
}

admin_psql() {
  sudo -u postgres psql -X --host="$postgres_socket" --username=postgres \
    -v ON_ERROR_STOP=1 "$@"
}

cleanup() {
  local original_status=$? cleanup_failed=no cleanup_state=""
  trap - EXIT INT TERM
  set +e

  if [ -n "$server_pid" ]; then
    kill -TERM -- "-$server_pid" >/dev/null 2>&1
    for _ in $(seq 1 50); do
      kill -0 "$server_pid" >/dev/null 2>&1 || break
      sleep 0.1
    done
    if kill -0 "$server_pid" >/dev/null 2>&1; then
      kill -KILL -- "-$server_pid" >/dev/null 2>&1
    fi
    wait "$server_pid" >/dev/null 2>&1
  fi

  # Revalidate immediately before each destructive statement; SQL predicates
  # independently constrain both DROP targets to this script's random namespace.
  if ! valid_resource_names; then
    cleanup_failed=yes
  else
    if [ "$database_created" = yes ]; then
      admin_psql --dbname=postgres --set=database_name="$database_name" <<'SQL' >/dev/null 2>&1
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
 WHERE datname = :'database_name'
   AND :'database_name' ~ '^trainercrm_pilot_2b4_[0-9a-f]{16}_test$'
   AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE %I', :'database_name')
 WHERE :'database_name' ~ '^trainercrm_pilot_2b4_[0-9a-f]{16}_test$'
\gexec
SQL
      [ $? -eq 0 ] || cleanup_failed=yes
    fi
    if [ "$role_created" = yes ]; then
      admin_psql --dbname=postgres --set=application_role="$application_role" <<'SQL' >/dev/null 2>&1
SELECT format('DROP ROLE %I', :'application_role')
 WHERE :'application_role' ~ '^trainercrm_pilot_2b4_[0-9a-f]{16}_app$'
\gexec
SQL
      [ $? -eq 0 ] || cleanup_failed=yes
    fi
  fi

  if valid_resource_names; then
    cleanup_state="$(admin_psql --dbname=postgres -At \
      --set=database_name="$database_name" \
      --set=application_role="$application_role" 2>/dev/null <<'SQL'
SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = :'database_name')::text
 || '|' || EXISTS(SELECT 1 FROM pg_roles WHERE rolname = :'application_role')::text;
SQL
)"
  fi
  if [ "$cleanup_state" = 'false|false' ]; then
    [ "$cleanup_failed" = no ] &&
      echo "Cleanup verified: temporary server, database, role, and credential files removed."
  else
    cleanup_failed=yes
  fi

  if [ "$cleanup_failed" = yes ]; then
    echo "Cleanup failed or could not be verified. Manual recovery may be required:" >&2
    printf 'Temporary database: %s\nTemporary role: %s\n' \
      "$database_name" "$application_role" >&2
    original_status=1
  fi
  rm -rf -- "$temporary_dir"
  unset application_password trainer_password application_url
  exit "$original_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

valid_resource_names || { echo "Generated resource names failed validation." >&2; exit 2; }
[ "$(admin_psql --dbname=postgres -Atc 'SELECT current_database()')" = postgres ] || {
  echo "Peer administration did not select the postgres database." >&2
  exit 2
}

if admin_psql --dbname=postgres -At --set=database_name="$database_name" \
    --set=application_role="$application_role" <<'SQL' | grep -q '^t$'; then
SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = :'database_name')
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname = :'application_role');
SQL
  echo "Randomized database or role unexpectedly already exists." >&2
  exit 2
fi

# Hex makes this stdin-fed psql variable incapable of altering the command
# stream, and avoids exposing the password in process arguments.
{
  printf "\\set application_password '%s'\n" "$application_password"
  cat <<'SQL'
SELECT format(
 'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
 :'application_role', :'application_password') \gexec
SQL
} | admin_psql --dbname=postgres --set=application_role="$application_role" >/dev/null
role_created=yes

admin_psql --dbname=postgres --set=database_name="$database_name" <<'SQL' >/dev/null
SELECT format('CREATE DATABASE %I', :'database_name') \gexec
SQL
database_created=yes
admin_psql --dbname=postgres --set=database_name="$database_name" \
  --set=application_role="$application_role" <<'SQL' >/dev/null
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'database_name') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database_name', :'application_role') \gexec
SQL

for migration in 001_extensions.sql 002_schema.sql 003_booking_functions.sql \
  004_auth_foundation.sql 005_auth_invitation_commands.sql \
  006_email_subject_compatibility.sql 007_auth_invitation_acceptance.sql \
  008_auth_preauth_nonce_consumption.sql 009_trainer_login_foundation.sql; do
  admin_psql --dbname="$database_name" -f "$migrations_dir/$migration" >/dev/null
done
sed "s/\btrainercrm_app\b/$application_role/g" \
  "$migrations_dir/010_trainer_login_runtime.sql" |
  admin_psql --dbname="$database_name" >/dev/null

trainer_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
identity_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
tenant_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
password_hash="$(TRAINER_PASSWORD="$trainer_password" node <<'NODE'
const { randomBytes, scrypt } = require("node:crypto");
const password = process.env.TRAINER_PASSWORD;
const salt = randomBytes(16);
scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, key) => {
  if (error) throw error;
  process.stdout.write(`$scrypt$v=1$N=16384,r=8,p=1$${salt.toString("base64url")}$${key.toString("base64url")}`);
});
NODE
)"

admin_psql --dbname="$database_name" --set=trainer_id="$trainer_id" \
  --set=identity_id="$identity_id" --set=tenant_id="$tenant_id" \
  --set=trainer_email="$trainer_email" --set=password_hash="$password_hash" <<'SQL' >/dev/null
INSERT INTO booking.tenants(id, public_slug) VALUES (:'tenant_id', 'pilot-2b4-smoke');
INSERT INTO booking.auth_subjects(id, role, synthetic_phone_ref)
 VALUES (:'trainer_id', 'trainer', 'synthetic:pilot_2b4_trainer');
INSERT INTO booking.trainer_memberships(tenant_id, trainer_id)
 VALUES (:'tenant_id', :'trainer_id');
INSERT INTO authn.email_identities(
 id, subject_id, normalization_version, canonical_email, display_email, verified_at)
 VALUES (:'identity_id', :'trainer_id', 1, :'trainer_email', :'trainer_email',
 transaction_timestamp());
INSERT INTO authn.trainer_password_credentials(
 trainer_subject_id, email_identity_id, password_hash, password_changed_at)
 VALUES (:'trainer_id', :'identity_id', :'password_hash',
 date_trunc('milliseconds', transaction_timestamp()) + interval '0.001123 seconds');
SQL
unset password_hash

pgpass_file="$temporary_dir/pgpass"
printf '127.0.0.1:*:%s:%s:%s\n' \
  "$database_name" "$application_role" "$application_password" >"$pgpass_file"
chmod 600 "$pgpass_file"
PGPASSFILE="$pgpass_file" psql -X -At -v ON_ERROR_STOP=1 --host=127.0.0.1 \
  --username="$application_role" --dbname="$database_name" <<'SQL' >"$temporary_dir/privileges"
SELECT has_schema_privilege(current_user, 'authn', 'USAGE'),
 has_table_privilege(current_user, 'authn.trainer_sessions', 'SELECT'),
 has_table_privilege(current_user, 'authn.trainer_password_credentials', 'SELECT'),
 has_function_privilege(current_user, 'authn.resolve_trainer_password(text)', 'EXECUTE'),
 has_function_privilege(current_user, 'authn.create_trainer_session(uuid,timestamp with time zone,bytea)', 'EXECUTE'),
 has_function_privilege(current_user, 'authn.resolve_trainer_session(bytea)', 'EXECUTE'),
 has_function_privilege(current_user, 'authn.revoke_trainer_session(bytea)', 'EXECUTE');
SQL
grep -qx 't|f|f|t|t|t|t' "$temporary_dir/privileges" || {
  echo "Least-privilege application role assertion failed." >&2
  exit 1
}

application_url="postgresql://${application_role}:${application_password}@127.0.0.1/${database_name}"
unset application_password
port="$(node <<'NODE'
const server = require("node:net").createServer();
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port));
  server.close();
});
NODE
)"
(
  cd "$frontend_dir"
  export TRAINERCRM_DATABASE_URL="$application_url" NODE_ENV=development
  exec setsid npm run dev -- --hostname 127.0.0.1 --port "$port"
) >"$temporary_dir/server.log" 2>&1 &
server_pid=$!
unset application_url
base_url="http://127.0.0.1:$port"

ready=no
for _ in $(seq 1 120); do
  kill -0 "$server_pid" >/dev/null 2>&1 || {
    echo "Application server exited before becoming ready." >&2
    exit 1
  }
  if curl --silent --show-error --fail --max-time 2 "$base_url/api/health" \
      -o /dev/null 2>/dev/null; then
    ready=yes
    break
  fi
  sleep 0.25
done
[ "$ready" = yes ] || { echo "Application server readiness timed out." >&2; exit 1; }

http_status() {
  curl --silent --show-error --max-time 10 -o "$1" -w '%{http_code}' "${@:2}"
}
status="$(http_status "$temporary_dir/unauthenticated.json" "$base_url/api/auth/me")"
[ "$status" = 401 ] && jq -e '.error == "UNAUTHORIZED"' "$temporary_dir/unauthenticated.json" >/dev/null ||
  { echo "FAIL: unauthenticated access was not rejected." >&2; exit 1; }

jq -n --arg email "$trainer_email" --arg password "${trainer_password}x" \
  '{email: $email, password: $password}' >"$temporary_dir/wrong-login.json"
status="$(http_status "$temporary_dir/wrong-response.json" -X POST \
  -H 'Content-Type: application/json' --data-binary "@$temporary_dir/wrong-login.json" \
  "$base_url/api/auth/login")"
[ "$status" = 401 ] && jq -e '.error == "INVALID_CREDENTIALS"' "$temporary_dir/wrong-response.json" >/dev/null ||
  { echo "FAIL: wrong password was not rejected." >&2; exit 1; }

jq -n --arg email "$trainer_email" --arg password "$trainer_password" \
  '{email: $email, password: $password}' >"$temporary_dir/login.json"
status="$(curl --silent --show-error --max-time 10 -o "$temporary_dir/login-response.json" \
  -D "$temporary_dir/login-headers" -c "$temporary_dir/cookies" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' --data-binary "@$temporary_dir/login.json" \
  "$base_url/api/auth/login")"

# Diagnose response metadata without ever emitting the response body, session
# value, or complete Set-Cookie header. Keep the cookie attribute assertions
# independent of their order in the header.
safe_error_code="$(jq -r '
  if .error == "INVALID_CREDENTIALS" or .error == "AUTH_UNAVAILABLE" or
     .error == "UNAUTHORIZED"
  then .error
  elif has("error") then "unrecognized"
  else "none"
  end
' "$temporary_dir/login-response.json" 2>/dev/null || printf 'unreadable')"
trainer_id_matched=no
session_cookie_present=no
httponly_present=no
samesite_present=no
cookie_jar_contains_cookie=no
jq -e --arg trainer "$trainer_id" \
  '.trainer.trainerId == $trainer' "$temporary_dir/login-response.json" >/dev/null 2>&1 &&
  trainer_id_matched=yes
grep -Eqi '^set-cookie:[[:space:]]*trainercrm_session=' "$temporary_dir/login-headers" &&
  session_cookie_present=yes
grep -Eqi '^set-cookie:[[:space:]]*trainercrm_session=.*;[[:space:]]*HttpOnly([[:space:]]*;|[[:space:]]*$)' \
  "$temporary_dir/login-headers" && httponly_present=yes
grep -Eqi '^set-cookie:[[:space:]]*trainercrm_session=.*;[[:space:]]*SameSite=Lax([[:space:]]*;|[[:space:]]*$)' \
  "$temporary_dir/login-headers" && samesite_present=yes
grep -q $'\ttrainercrm_session\t' "$temporary_dir/cookies" &&
  cookie_jar_contains_cookie=yes

if [ "$status" != 200 ] || [ "$trainer_id_matched" != yes ] ||
   [ "$session_cookie_present" != yes ] || [ "$httponly_present" != yes ] ||
   [ "$samesite_present" != yes ] || [ "$cookie_jar_contains_cookie" != yes ]; then
  if [ "$status" = 401 ] || [ "$status" = 429 ]; then
    failure_kind=authentication_failure
  elif [ "$status" = 200 ]; then
    failure_kind=successful_authentication_with_response_assertion_failure
  else
    failure_kind=authentication_endpoint_failure
  fi
  echo "FAIL: correct-password login check failed." >&2
  printf '%s\n' \
    "Classification: $failure_kind" \
    "HTTP status: $status" \
    "Safe JSON error code: $safe_error_code" \
    "Trainer ID matched: $trainer_id_matched" \
    "Session cookie present: $session_cookie_present" \
    "HttpOnly present: $httponly_present" \
    "SameSite=Lax present: $samesite_present" \
    "Cookie jar contained session cookie: $cookie_jar_contains_cookie" >&2
  exit 1
fi

cp "$temporary_dir/cookies" "$temporary_dir/revoked-cookies"
status="$(http_status "$temporary_dir/me.json" -b "$temporary_dir/cookies" "$base_url/api/auth/me")"
[ "$status" = 200 ] &&
  jq -e --arg trainer "$trainer_id" '.trainer.trainerId == $trainer' "$temporary_dir/me.json" >/dev/null ||
  { echo "FAIL: session verification failed." >&2; exit 1; }

status="$(curl --silent --show-error --max-time 10 -o "$temporary_dir/logout-response" \
  -D "$temporary_dir/logout-headers" -b "$temporary_dir/cookies" -c "$temporary_dir/cookies" \
  -w '%{http_code}' -X POST "$base_url/api/auth/logout")"
[ "$status" = 204 ] &&
  grep -qi '^set-cookie: trainercrm_session=.*Max-Age=0' "$temporary_dir/logout-headers" ||
  { echo "FAIL: logout did not revoke and clear the session." >&2; exit 1; }

status="$(http_status "$temporary_dir/revoked.json" -b "$temporary_dir/revoked-cookies" "$base_url/api/auth/me")"
[ "$status" = 401 ] && jq -e '.error == "UNAUTHORIZED"' "$temporary_dir/revoked.json" >/dev/null ||
  { echo "FAIL: revoked session was not rejected." >&2; exit 1; }
echo "All PILOT-2B.4 live PostgreSQL HTTP authentication scenarios passed."
