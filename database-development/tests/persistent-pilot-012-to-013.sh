#!/usr/bin/env bash
set -euo pipefail

# Operator-controlled upgrade for the persistent local pilot. This script does
# not start, stop, initialize, reset, or discover any other PostgreSQL cluster.

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  printf 'Usage: %s preflight|upgrade|verify\n' "$0"
  printf 'Run preflight, then upgrade (which asks for exact confirmation), then verify.\n'
}

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
root_dir="$(CDPATH= cd -- "$script_dir/../.." && pwd)"
migration="$root_dir/database-development/migrations/013_trainer_workouts_runtime.sql"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
state_dir="$data_home/trainercrm-pilot"
pgdata="$state_dir/pgdata"
socket_dir="$state_dir/socket"
config_file="$state_dir/config"
initialized_file="$state_dir/initialized"
expected_013_sha256=36392633ba9019cbb36f6ff3b752cd319fcb6023ae94b62b9bdfcc077e25dbd4

safe_scalar() {
  local key="$1" pattern="$2" value count
  count="$(grep -c "^${key}=" "$config_file" || true)"
  [ "$count" = 1 ] || fail "Persistent configuration has an invalid $key entry."
  value="$(sed -n "s/^${key}=//p" "$config_file")"
  [[ "$value" =~ $pattern ]] || fail "Persistent configuration has an unsafe $key value."
  printf '%s\n' "$value"
}

find_postgres_bindir() {
  local candidate executable
  if command -v pg_config >/dev/null 2>&1; then
    candidate="$(pg_config --bindir 2>/dev/null || true)"
    if [ -n "$candidate" ]; then
      for executable in pg_ctl psql pg_dump pg_restore; do
        [ -x "$candidate/$executable" ] || candidate=""
      done
      [ -n "$candidate" ] && { printf '%s\n' "$candidate"; return; }
    fi
  fi
  for candidate in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin; do
    [ -d "$candidate" ] || continue
    for executable in pg_ctl psql pg_dump pg_restore; do
      [ -x "$candidate/$executable" ] || candidate=""
    done
    [ -n "$candidate" ] && { printf '%s\n' "$candidate"; return; }
  done
  return 1
}

load_and_validate_identity() {
  local resolved_state marker
  [ -d "$state_dir" ] && [ ! -L "$state_dir" ] || fail "Persistent pilot state directory is missing or symlinked."
  [ "$(stat -c %u "$state_dir")" = "$(id -u)" ] || fail "Persistent state is not owned by the current user."
  resolved_state="$(realpath -e "$state_dir")"
  case "$resolved_state/" in /tmp/*|/run/*|/mnt/*) fail "Persistent state is not on native local storage." ;; esac
  [ -f "$config_file" ] && [ ! -L "$config_file" ] || fail "Persistent pilot configuration is missing or symlinked."
  [ "$(stat -c %u "$config_file")" = "$(id -u)" ] && [ "$(stat -c %a "$config_file")" = 600 ] ||
    fail "Persistent configuration ownership or mode is unsafe."

  pg_port="$(safe_scalar pg_port '^[0-9]{1,5}$')"
  [ "$pg_port" -ge 1 ] && [ "$pg_port" -le 65535 ] || fail "Persistent PostgreSQL port is invalid."
  database_name="$(safe_scalar database_name '^trainercrm_persistent_[a-f0-9]{16}$')"
  [ "$database_name" != trainercrm_dev ] || fail "Refusing trainercrm_dev."
  cluster_admin="$(safe_scalar cluster_admin '^trainercrm_persistent_cluster_admin$')"
  operator_role="$(safe_scalar operator_role '^trainercrm_persistent_operator$')"
  app_role="$(safe_scalar app_role '^trainercrm_app$')"

  [ -f "$initialized_file" ] && [ ! -L "$initialized_file" ] || fail "Initialization marker is missing or symlinked."
  [ "$(stat -c %u "$initialized_file")" = "$(id -u)" ] && [ "$(stat -c %a "$initialized_file")" = 600 ] ||
    fail "Initialization marker ownership or mode is unsafe."
  marker="$(sed -n 's/^migrations=//p' "$initialized_file")"
  case "$mode:$marker" in
    preflight:001-012|upgrade:001-012|verify:001-013) ;;
    verify:001-012) fail "Marker still says 001-012; migration 013 is not accepted as complete." ;;
    preflight:001-013|upgrade:001-013) fail "Migration 013 is already marked applied." ;;
    *) fail "Initialization marker is inconsistent or from an unsupported migration state." ;;
  esac

  [ -f "$pgdata/PG_VERSION" ] && [ ! -L "$pgdata" ] || fail "The exact persistent pilot PGDATA is unavailable."
  [ "$(stat -c %u "$pgdata")" = "$(id -u)" ] && [ "$(stat -c %a "$pgdata")" = 700 ] ||
    fail "PGDATA ownership or mode is unsafe."
  [ -d "$socket_dir" ] && [ ! -L "$socket_dir" ] && [ "$(stat -c %u "$socket_dir")" = "$(id -u)" ] ||
    fail "Persistent pilot socket directory is unsafe."
  postgres_bindir="$(find_postgres_bindir || true)"
  [ -n "$postgres_bindir" ] || fail "PostgreSQL client/server tools are unavailable."
  pg_ctl="$postgres_bindir/pg_ctl"; psql="$postgres_bindir/psql"
  pg_dump="$postgres_bindir/pg_dump"; pg_restore="$postgres_bindir/pg_restore"
  "$pg_ctl" -D "$pgdata" status >/dev/null 2>&1 || fail "The exact persistent pilot PostgreSQL server must already be running."
  [ -s "$pgdata/postmaster.pid" ] || fail "The exact persistent pilot has no server identity file."
  [ "$(sed -n '2p' "$pgdata/postmaster.pid")" = "$pgdata" ] || fail "Running server identity does not name the exact pilot PGDATA."
  [ "$(sed -n '4p' "$pgdata/postmaster.pid")" = "$pg_port" ] || fail "Running PGDATA port differs from the saved pilot port."
  [ "$(sha256sum "$migration" | awk '{print $1}')" = "$expected_013_sha256" ] || fail "Migration 013 does not match reviewed HEAD 3e387dc."
}

run_psql() {
  "$psql" -X -qAt -h "$socket_dir" -p "$pg_port" -U "$operator_role" -d "$database_name" \
    -v ON_ERROR_STOP=1 "$@"
}

catalog_check() {
  local expected_state="$1" output
  output="$(run_psql -v expected_state="$expected_state" <<'SQL'
-- PILOT_4C_CATALOG_CHECK
-- psql does not expand variables inside dollar-quoted bodies. Set the
-- validated caller-supplied state outside the DO body, then read it there.
SELECT set_config('trainercrm.pilot_4c_expected_state', :'expected_state', false)
  AS pilot_4c_expected_state \gset
DO $check$
DECLARE
  owner_oid oid;
  object_013_count integer;
BEGIN
  IF current_database() !~ '^trainercrm_persistent_[a-f0-9]{16}$'
     OR current_database() = 'trainercrm_dev'
     OR session_user <> 'trainercrm_persistent_operator'
     OR current_user <> 'trainercrm_persistent_operator'
     OR (SELECT rolsuper FROM pg_roles WHERE rolname = session_user)
     OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) <> session_user THEN
    RAISE EXCEPTION 'persistent pilot database identity mismatch';
  END IF;
  SELECT oid INTO owner_oid FROM pg_roles
   WHERE rolname='trainercrm_clients_function_owner' AND NOT rolcanlogin
     AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit
     AND NOT rolreplication AND NOT rolbypassrls;
  IF owner_oid IS NULL OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=owner_oid)
     OR NOT pg_has_role(session_user,'trainercrm_clients_function_owner','MEMBER') THEN
    RAISE EXCEPTION 'migration 012 owner role prerequisite is unsafe';
  END IF;
  IF to_regclass('booking.clients') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='booking.clients'::regclass AND attname='starting_weight' AND atttypid='numeric'::regtype AND atttypmod=458759 AND NOT attnotnull AND NOT attisdropped)
     OR to_regclass('booking.clients_by_trainer_created_idx') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='booking.clients'::regclass AND conname='clients_starting_weight_valid' AND contype='c')
     OR to_regprocedure('booking.list_trainer_clients(bytea)') IS NULL
     OR to_regprocedure('booking.create_trainer_client(bytea,text,numeric)') IS NULL
     OR pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid='booking.list_trainer_clients(bytea)'::regprocedure)) <> 'trainercrm_clients_function_owner'
     OR pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid='booking.create_trainer_client(bytea,text,numeric)'::regprocedure)) <> 'trainercrm_clients_function_owner'
     OR NOT has_function_privilege('trainercrm_app','booking.list_trainer_clients(bytea)','EXECUTE')
     OR NOT has_function_privilege('trainercrm_app','booking.create_trainer_client(bytea,text,numeric)','EXECUTE')
     OR has_function_privilege('public','booking.list_trainer_clients(bytea)','EXECUTE')
     OR has_function_privilege('public','booking.create_trainer_client(bytea,text,numeric)','EXECUTE')
     OR NOT has_function_privilege('trainercrm_clients_function_owner','pg_catalog.gen_random_uuid()','EXECUTE')
     OR to_regclass('booking.trainer_appointments') IS NULL
     OR to_regtype('booking.appointment_status') IS NULL
     OR to_regprocedure('booking.resolve_appointment_trainer(bytea)') IS NULL
     OR to_regprocedure('booking.list_trainer_appointments(bytea,timestamptz,timestamptz)') IS NULL
     OR to_regprocedure('booking.create_trainer_appointment(bytea,uuid,timestamptz,timestamptz)') IS NULL
     OR to_regprocedure('booking.reschedule_trainer_appointment(bytea,uuid,timestamptz,timestamptz)') IS NULL
     OR to_regprocedure('booking.cancel_trainer_appointment(bytea,uuid)') IS NULL THEN
    RAISE EXCEPTION 'migration 012 prerequisites are absent or inconsistent';
  END IF;
  object_013_count :=
    (to_regclass('booking.trainer_workouts') IS NOT NULL)::integer
    + (to_regclass('booking.workout_exercises') IS NOT NULL)::integer
    + (to_regclass('booking.workout_sets') IS NOT NULL)::integer
    + (to_regclass('booking.trainer_workouts_client_date_idx') IS NOT NULL)::integer
    + (to_regclass('booking.workout_exercises_workout_idx') IS NOT NULL)::integer
    + (to_regprocedure('booking.validate_workout_exercises(jsonb)') IS NOT NULL)::integer
    + (to_regprocedure('booking.workout_document(uuid)') IS NOT NULL)::integer
    + (to_regprocedure('booking.list_trainer_workouts(bytea,uuid)') IS NOT NULL)::integer
    + (to_regprocedure('booking.get_trainer_workout(bytea,uuid)') IS NOT NULL)::integer
    + (to_regprocedure('booking.write_trainer_workout(bytea,uuid,uuid,uuid,date,time,text,boolean,numeric,jsonb)') IS NOT NULL)::integer
    + (to_regprocedure('booking.create_trainer_workout(bytea,uuid,uuid,date,time,text,boolean,numeric,jsonb)') IS NOT NULL)::integer
    + (to_regprocedure('booking.update_trainer_workout(bytea,uuid,uuid,uuid,date,time,text,boolean,numeric,jsonb)') IS NOT NULL)::integer
    + EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='booking.trainer_appointments'::regclass
        AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (tenant_id, trainer_id, client_id, id)')::integer;
  IF (current_setting('trainercrm.pilot_4c_expected_state')='012' AND object_013_count <> 0)
     OR (current_setting('trainercrm.pilot_4c_expected_state')='013' AND object_013_count <> 13) THEN
    RAISE EXCEPTION 'migration 013 state is absent, partial, or already applied';
  END IF;
END $check$;
SELECT 'STATE_OK|' || count(*) || '|' || coalesce(md5(string_agg(md5(row_to_json(manifest)::text),',' ORDER BY id)),'empty')
  FROM booking.auth_subjects AS manifest WHERE role='trainer';
SELECT 'CLIENTS_OK|' || count(*) || '|' || coalesce(md5(string_agg(md5(row_to_json(manifest)::text),',' ORDER BY id)),'empty')
  FROM booking.clients AS manifest;
SELECT 'APPOINTMENTS_OK|' || count(*) || '|' || coalesce(md5(string_agg(md5(row_to_json(manifest)::text),',' ORDER BY id)),'empty')
  FROM booking.trainer_appointments AS manifest;
SQL
)" || fail "Catalog safety check failed. No database change was made by this script."
  printf '%s\n' "$output"
}

verify_013() {
  local baseline="$1" after expected_trainers expected_clients expected_appointments
  expected_trainers="$(printf '%s\n' "$baseline" | sed -n 's/^STATE_OK|//p')"
  expected_clients="$(printf '%s\n' "$baseline" | sed -n 's/^CLIENTS_OK|//p')"
  expected_appointments="$(printf '%s\n' "$baseline" | sed -n 's/^APPOINTMENTS_OK|//p')"
  [ -n "$expected_trainers" ] && [ -n "$expected_clients" ] && [ -n "$expected_appointments" ] || fail "Could not retain the pre-upgrade row manifest."
  after="$(catalog_check 013)"
  [ "$(printf '%s\n' "$after" | sed -n 's/^STATE_OK|//p')" = "$expected_trainers" ] || fail "Trainer identities changed during upgrade."
  [ "$(printf '%s\n' "$after" | sed -n 's/^CLIENTS_OK|//p')" = "$expected_clients" ] || fail "Client identities changed during upgrade."
  [ "$(printf '%s\n' "$after" | sed -n 's/^APPOINTMENTS_OK|//p')" = "$expected_appointments" ] || fail "Appointments changed during upgrade."
  run_psql <<'SQL' >/dev/null || fail "SQL postcheck failed."
-- PILOT_4C_POSTCHECK
DO $verify$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'booking.validate_workout_exercises(jsonb)',
    'booking.workout_document(uuid)',
    'booking.list_trainer_workouts(bytea,uuid)',
    'booking.get_trainer_workout(bytea,uuid)',
    'booking.write_trainer_workout(bytea,uuid,uuid,uuid,date,time,text,boolean,numeric,jsonb)',
    'booking.create_trainer_workout(bytea,uuid,uuid,date,time,text,boolean,numeric,jsonb)',
    'booking.update_trainer_workout(bytea,uuid,uuid,uuid,date,time,text,boolean,numeric,jsonb)'
  ] LOOP
    IF to_regprocedure(f) IS NULL OR pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid=to_regprocedure(f))) <> 'trainercrm_clients_function_owner'
       OR has_function_privilege('public',f,'EXECUTE') THEN RAISE EXCEPTION 'unsafe workout function %',f; END IF;
  END LOOP;
  IF to_regclass('booking.trainer_workouts') IS NULL
     OR to_regclass('booking.workout_exercises') IS NULL
     OR to_regclass('booking.workout_sets') IS NULL
     OR to_regclass('booking.trainer_workouts_client_date_idx') IS NULL
     OR to_regclass('booking.workout_exercises_workout_idx') IS NULL
     OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='booking.trainer_workouts'::regclass)) <> session_user
     OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='booking.workout_exercises'::regclass)) <> session_user
     OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='booking.workout_sets'::regclass)) <> session_user
     OR (SELECT count(*) FROM pg_constraint WHERE conrelid='booking.trainer_workouts'::regclass AND contype <> 'n') <> 9
     OR (SELECT count(*) FROM pg_constraint WHERE conrelid='booking.workout_exercises'::regclass AND contype <> 'n') <> 5
     OR (SELECT count(*) FROM pg_constraint WHERE conrelid='booking.workout_sets'::regclass AND contype <> 'n') <> 6
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='booking.trainer_appointments'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (tenant_id, trainer_id, client_id, id)')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='booking.trainer_workouts'::regclass AND contype='f' AND confrelid='booking.trainer_memberships'::regclass AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (tenant_id, trainer_id) REFERENCES booking.trainer_memberships(tenant_id, trainer_id)%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='booking.trainer_workouts'::regclass AND contype='f' AND confrelid='booking.clients'::regclass AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (tenant_id, trainer_id, client_id) REFERENCES booking.clients(tenant_id, trainer_id, id)%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='booking.trainer_workouts'::regclass AND contype='f' AND confrelid='booking.trainer_appointments'::regclass AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (tenant_id, trainer_id, client_id, appointment_id) REFERENCES booking.trainer_appointments(tenant_id, trainer_id, client_id, id)%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='booking.workout_exercises'::regclass AND contype='f' AND confrelid='booking.trainer_workouts'::regclass AND confdeltype='c')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='booking.workout_sets'::regclass AND contype='f' AND confrelid='booking.workout_exercises'::regclass AND confdeltype='c')
     OR NOT has_function_privilege('trainercrm_app','booking.list_trainer_workouts(bytea,uuid)','EXECUTE')
     OR NOT has_function_privilege('trainercrm_app','booking.get_trainer_workout(bytea,uuid)','EXECUTE')
     OR NOT has_function_privilege('trainercrm_app','booking.create_trainer_workout(bytea,uuid,uuid,date,time,text,boolean,numeric,jsonb)','EXECUTE')
     OR NOT has_function_privilege('trainercrm_app','booking.update_trainer_workout(bytea,uuid,uuid,uuid,date,time,text,boolean,numeric,jsonb)','EXECUTE')
     OR has_function_privilege('trainercrm_app','booking.validate_workout_exercises(jsonb)','EXECUTE')
     OR has_function_privilege('trainercrm_app','booking.workout_document(uuid)','EXECUTE')
     OR has_function_privilege('trainercrm_app','booking.write_trainer_workout(bytea,uuid,uuid,uuid,date,time,text,boolean,numeric,jsonb)','EXECUTE')
     OR has_table_privilege('trainercrm_app','booking.trainer_workouts','SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('trainercrm_app','booking.workout_exercises','SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('trainercrm_app','booking.workout_sets','SELECT,INSERT,UPDATE,DELETE')
     OR has_schema_privilege('trainercrm_clients_function_owner','booking','CREATE')
     OR NOT has_table_privilege('trainercrm_clients_function_owner','booking.trainer_workouts','SELECT')
     OR NOT has_table_privilege('trainercrm_clients_function_owner','booking.trainer_workouts','INSERT')
     OR NOT has_table_privilege('trainercrm_clients_function_owner','booking.trainer_workouts','UPDATE')
     OR has_table_privilege('trainercrm_clients_function_owner','booking.trainer_workouts','DELETE')
     OR NOT has_table_privilege('trainercrm_clients_function_owner','booking.workout_exercises','SELECT')
     OR NOT has_table_privilege('trainercrm_clients_function_owner','booking.workout_exercises','INSERT')
     OR NOT has_table_privilege('trainercrm_clients_function_owner','booking.workout_exercises','DELETE')
     OR has_table_privilege('trainercrm_clients_function_owner','booking.workout_exercises','UPDATE')
     OR NOT has_table_privilege('trainercrm_clients_function_owner','booking.workout_sets','SELECT')
     OR NOT has_table_privilege('trainercrm_clients_function_owner','booking.workout_sets','INSERT')
     OR has_table_privilege('trainercrm_clients_function_owner','booking.workout_sets','UPDATE,DELETE')
     OR NOT has_function_privilege('trainercrm_app','booking.list_trainer_appointments(bytea,timestamptz,timestamptz)','EXECUTE')
     OR NOT has_function_privilege('trainercrm_app','booking.create_trainer_appointment(bytea,uuid,timestamptz,timestamptz)','EXECUTE')
     OR NOT has_function_privilege('trainercrm_app','booking.reschedule_trainer_appointment(bytea,uuid,timestamptz,timestamptz)','EXECUTE')
     OR NOT has_function_privilege('trainercrm_app','booking.cancel_trainer_appointment(bytea,uuid)','EXECUTE')
     OR has_table_privilege('trainercrm_app','booking.trainer_appointments','SELECT,INSERT,UPDATE,DELETE')
     OR has_schema_privilege('trainercrm_clients_function_owner','booking','CREATE')
     OR has_table_privilege('trainercrm_clients_function_owner','booking.trainer_appointments','DELETE')
     OR NOT has_table_privilege('trainercrm_clients_function_owner','booking.trainer_appointments','SELECT')
     OR NOT has_table_privilege('trainercrm_clients_function_owner','booking.trainer_appointments','INSERT')
     OR NOT has_table_privilege('trainercrm_clients_function_owner','booking.trainer_appointments','UPDATE')
     OR NOT has_function_privilege('trainercrm_app','booking.list_trainer_clients(bytea)','EXECUTE')
     OR NOT has_function_privilege('trainercrm_app','booking.create_trainer_client(bytea,text,numeric)','EXECUTE') THEN
    RAISE EXCEPTION 'workout schema, ownership, grants, or preserved client/calendar access is unsafe';
  END IF;
END $verify$;
SQL
  printf '%s\n' "$after"
}

mode="${1:-}"
case "$mode" in preflight|upgrade|verify) [ "$#" -eq 1 ] || fail "Unexpected arguments." ;; *) usage; exit 2 ;; esac
for command in awk grep id mktemp mv realpath sed sha256sum stat; do command -v "$command" >/dev/null || fail "Required command unavailable: $command"; done
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGOPTIONS PGREQUIRESSL PGSSLMODE
umask 077
load_and_validate_identity

case "$mode" in
  preflight)
    catalog_check 012 >/dev/null
    printf 'Preflight passed: exact persistent pilot is at migration 012; no changes made.\n'
    printf 'Next: %s upgrade\n' "$0"
    ;;
  verify)
    baseline="$(catalog_check 013)"
    verify_013 "$baseline" >/dev/null
    printf 'Verification passed: migration 013 and preserved client/calendar access are consistent.\n'
    ;;
  upgrade)
    baseline="$(catalog_check 012)"
    printf 'Exact target: persistent local pilot database %s at migration 012.\n' "$database_name"
    printf 'This will create a new verified backup and apply only migration 013.\n'
    printf 'Type UPGRADE TRAINERCRM PERSISTENT PILOT TO 013: '
    IFS= read -r confirmation
    [ "$confirmation" = 'UPGRADE TRAINERCRM PERSISTENT PILOT TO 013' ] || fail "Confirmation did not match; nothing changed."
    # Repeat every mutable catalog gate after confirmation and before backup.
    [ "$(catalog_check 012)" = "$baseline" ] || fail "Database state changed after preflight; refusing upgrade."
    backup_dir="$state_dir/upgrade-backups"
    mkdir -p "$backup_dir"; chmod 700 "$backup_dir"
    [ ! -L "$backup_dir" ] && [ "$(stat -c %u "$backup_dir")" = "$(id -u)" ] || fail "Backup directory is unsafe."
    backup_file="$(mktemp --tmpdir="$backup_dir" 'before-013-XXXXXXXX.dump')"
    chmod 600 "$backup_file"
    if ! "$pg_dump" -Fc -h "$socket_dir" -p "$pg_port" -U "$operator_role" -d "$database_name" -f "$backup_file" ||
       [ ! -s "$backup_file" ] || ! "$pg_restore" --list "$backup_file" >/dev/null; then
      fail "Backup creation or verification failed; migration 013 was not attempted. Inspect the newly created file manually."
    fi
    checksum_file="$backup_file.sha256"
    sha256sum "$backup_file" >"$checksum_file"; chmod 600 "$checksum_file"
    (cd "$backup_dir" && sha256sum -c "$(basename "$checksum_file")" >/dev/null) || fail "Backup checksum verification failed; migration 013 was not attempted."
    [ "$(catalog_check 012)" = "$baseline" ] || fail "Database state changed while the backup was created; migration 013 was not attempted."
    # Migration 013 contains its own BEGIN/COMMIT and ON_ERROR_STOP makes any SQL error fatal.
    run_psql -f "$migration" >/dev/null || fail "Migration 013 failed transactionally; backup is retained."
    verify_013 "$baseline" >/dev/null || fail "Migration committed but post-verification failed; marker remains 001-012 and manual review is required."
    marker_new="$initialized_file.new.$$"
    sed 's/^migrations=001-012$/migrations=001-013/' "$initialized_file" >"$marker_new"
    [ "$(grep -c '^migrations=001-013$' "$marker_new")" = 1 ] || fail "Could not prepare the migration marker; manual review is required."
    chmod 600 "$marker_new"; mv -f -- "$marker_new" "$initialized_file"
    printf 'Upgrade complete and verified. Backup: %s\nChecksum: %s\n' "$backup_file" "$checksum_file"
    ;;
esac
