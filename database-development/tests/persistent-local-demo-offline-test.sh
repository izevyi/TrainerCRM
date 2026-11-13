#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
launcher="$script_dir/persistent-local-demo.sh"
test_home="$(mktemp -d)"
trap 'rm -rf -- "$test_home"' EXIT

export XDG_DATA_HOME="$test_home/data"
export TRAINERCRM_PERSISTENT_LIBRARY_ONLY=1
# shellcheck source=persistent-local-demo.sh
. "$launcher"
unset TRAINERCRM_PERSISTENT_LIBRARY_ONLY

mkdir -p "$state_dir"
chmod 700 "$state_dir"
calls="$test_home/calls"
port_counter="$test_home/port-counter"
printf '42000\n' >"$port_counter"

random_port() {
  local port
  port="$(<"$port_counter")"
  printf '%s\n' "$((port + 1))" >"$port_counter"
  printf '%s\n' "$port"
}

mock_initdb() {
  printf 'initdb\n' >>"$calls"
  printf '16\n' >"$pgdata/PG_VERSION"
}

mock_psql() {
  local arg input="" previous="" role="" host=""
  for arg in "$@"; do
    if [ "$arg" = -f ]; then printf 'migration\n' >>"$calls"; fi
    [ "$previous" = -U ] && role="$arg"
    [ "$previous" = -h ] && host="$arg"
    previous="$arg"
  done
  if [ ! -t 0 ]; then input="$(command cat)"; fi
  if [[ "$input" == *'CREATE ROLE trainercrm_app'* ]]; then printf 'roles\n' >>"$calls"; fi
  if [[ "$input" == *'ALTER ROLE trainercrm_app PASSWORD'* ]]; then printf 'app-password\n' >>"$calls"; fi
  if [[ "$input" == *'INSERT INTO booking.tenants'* ]]; then printf 'seed\n' >>"$calls"; fi
  if [ "$role" = trainercrm_app ] && [ "$host" = 127.0.0.1 ] && [ -n "${PGPASSWORD:-}" ]; then
    printf 'app-authentication\n' >>"$calls"
  fi
}

start_postgres_raw() {
  printf 'postgres-start-mocked\n' >>"$calls"
  initialization_server_started=no
}

initdb=mock_initdb
psql=mock_psql
initialization_in_progress=no
initialization_server_started=no
initialization_postgres_pid=""
initialization_postgres_start=""

initialize

[ -n "${app_password:-}" ] || fail "Regression: app_password was lost when initialize returned."
build_database_url
[[ "$database_url" == "postgresql://trainercrm_app:"*"@127.0.0.1:42000/trainercrm_persistent_"* ]] ||
  fail "Regression: application database URL could not be assembled after initialization."
[ -s "$initialized_file" ] || fail "Initialization marker was not written."
[ "$(stat -c %a "$config_file")" = 600 ] || fail "Configuration mode is not 600."
[ "$(stat -c %a "$credentials_file")" = 600 ] || fail "Credentials mode is not 600."
[ "$(grep -c '^migration$' "$calls")" -eq 11 ] || fail "Expected all 11 migration invocations."
for phase in initdb roles app-password seed app-authentication postgres-start-mocked; do
  grep -qx "$phase" "$calls" || fail "Missing mocked initialization phase: $phase"
done

# Exercise the persisted-config path in a fresh variable state, including the
# exact credential needed by start_command after a later invocation.
pg_port= app_port= database_name= cluster_admin= operator_role= app_role= app_password=
load_config
build_database_url
[ -n "$app_password" ] || fail "Saved app_password was not restored."

# Removing only the success marker simulates an interrupted first run. The
# launcher must retain and reject it before unrelated frontend preflight
# failures, not invoke initialization again.
mv -- "$initialized_file" "$initialized_file.saved"
partial_frontend="$test_home/partial-frontend"
mkdir -p "$partial_frontend/node_modules/.bin" "$partial_frontend/.next/dev"
: >"$partial_frontend/node_modules/.bin/next"
chmod +x "$partial_frontend/node_modules/.bin/next"
: >"$partial_frontend/.next/dev/lock"
frontend_dir="$partial_frontend"
if (start_command) >"$test_home/partial.out" 2>&1; then
  fail "Partial initialization was automatically resumed."
fi
grep -q 'Partial initialization found' "$test_home/partial.out" ||
  fail "Partial initialization did not get the expected diagnostic."
mv -- "$initialized_file.saved" "$initialized_file"

# A truncated config must produce a controlled diagnostic, not an unbound
# variable failure. Preserve and restore the real generated config.
mv -- "$config_file" "$config_file.good"
printf 'pg_port=42000\n' >"$config_file"
chmod 600 "$config_file"
if (load_config) >"$test_home/truncated.out" 2>&1; then
  fail "Truncated configuration was accepted."
fi
grep -Eq 'ERROR: (Invalid saved ports|Invalid saved database name)' "$test_home/truncated.out" ||
  fail "Truncated configuration did not get a controlled diagnostic."
! grep -q 'unbound variable' "$test_home/truncated.out" || fail "Truncated configuration triggered set -u."
mv -- "$config_file.good" "$config_file"

# A silent early application exit must still produce useful diagnostics and
# must not abort under set -e while /proc identity is being captured.
fake_frontend="$test_home/fake-frontend"
mkdir -p "$fake_frontend/node_modules/.bin"
fake_next="$fake_frontend/node_modules/.bin/next"
printf '#!/usr/bin/env bash\nexit 23\n' >"$fake_next"
chmod +x "$fake_next"
frontend_dir="$fake_frontend"
app_log="$test_home/application.log"
app_pid_file="$test_home/application.pid"
app_start_file="$test_home/application.starttime"
app_port=43123
database_url='postgresql://mock:mock@127.0.0.1:5432/mock'
start_application_process
if record_app_identity; then
  wait "$app_pid" 2>/dev/null || true
else
  : # An immediate exit may win the /proc race; that is an expected path.
fi
[ -s "$app_log" ] || fail "Silent application exit left an empty log."
grep -q 'Launcher diagnostic: starting Next.js' "$app_log" ||
  fail "Application log lacks the sanitized startup diagnostic."
grep -Eq 'Next.js exited with status 23|exited before its identity could be recorded' "$app_log" ||
  fail "Application log lacks the sanitized early-exit diagnostic."
! grep -q 'postgresql://' "$app_log" || fail "Application diagnostics leaked the database URL."
rm -f -- "$app_pid_file" "$app_start_file"

# A live mocked server must be recorded as the process-group leader with the
# instance marker, so the existing verified-group shutdown remains effective.
printf '#!/usr/bin/env bash\nwhile :; do sleep 1; done\n' >"$fake_next"
chmod +x "$fake_next"
: >"$app_log"
start_application_process
record_app_identity || fail "Live mocked application identity was not recorded."
read_app_identity || fail "Live mocked application failed identity verification."
[ -n "$(app_group_members)" ] || fail "Live mocked application group was not discoverable."
stop_app_group || fail "Live mocked application group did not stop."
wait "$app_pid" 2>/dev/null || true
rm -f -- "$app_pid_file" "$app_start_file"

# Readiness uses one wall-clock deadline, permits a slow cold start, and
# requires an exact HTTP 200 rather than accepting another HTTP response.
read_app_identity() { return 0; }
sleep() { mock_sleep "$@"; }
readiness_curl_counter="$test_home/readiness-curl-counter"
readiness_curl_bounded="$test_home/readiness-curl-bounded"
printf '0\n' >"$readiness_curl_counter"
curl() {
  local calls
  [[ " $* " == *" --connect-timeout 1 "* ]] &&
    [[ " $* " == *" --max-time 2 "* ]] &&
    [[ " $* " == *" --write-out %{http_code} "* ]] && printf 'yes\n' >"$readiness_curl_bounded"
  calls="$(<"$readiness_curl_counter")"
  calls=$((calls + 1))
  printf '%s\n' "$calls" >"$readiness_curl_counter"
  if [ "$calls" -lt 70 ]; then printf '503'; else printf '200'; fi
}
mock_sleep() { SECONDS=$((SECONDS + 2)); }
SECONDS=0
wait_for_application_readiness 180 'http://127.0.0.1:43123/api/health' ||
  fail "Slow cold-start readiness did not succeed."
[ "$(<"$readiness_curl_counter")" -eq 70 ] || fail "Slow cold-start readiness used an unexpected number of checks."
[ -s "$readiness_curl_bounded" ] || fail "Readiness HTTP checks were not bounded or did not capture status."
[ "$SECONDS" -ge 130 ] && [ "$SECONDS" -lt 180 ] || fail "Slow cold-start readiness did not exercise the extended deadline."

curl() { SECONDS=$((SECONDS + 1)); printf '503'; }
SECONDS=0
if wait_for_application_readiness 5 'http://127.0.0.1:43123/api/health'; then
  fail "Non-200 health responses were accepted."
fi
[ "$readiness_failure" = timeout ] || fail "Readiness timeout was misclassified."
[ "$SECONDS" -ge 5 ] && [ "$SECONDS" -le 6 ] || fail "Readiness did not honor its wall-clock deadline."

early_exit_checks=0
read_app_identity() {
  early_exit_checks=$((early_exit_checks + 1))
  [ "$early_exit_checks" -lt 3 ]
}
curl() { printf '503'; }
SECONDS=0
if wait_for_application_readiness 180 'http://127.0.0.1:43123/api/health'; then
  fail "Early application exit was accepted as ready."
fi
[ "$readiness_failure" = exit ] || fail "Early application exit was misclassified."
[ "$SECONDS" -lt 10 ] || fail "Early application exit was not detected promptly."

unset -f read_app_identity sleep curl

printf 'Offline persistent initialization regression test passed.\n'
