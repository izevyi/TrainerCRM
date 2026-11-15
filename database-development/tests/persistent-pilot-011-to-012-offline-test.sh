#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
upgrade="$script_dir/persistent-pilot-011-to-012.sh"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
mockbin="$tmp/bin"; state="$tmp/data/trainercrm-pilot"
mkdir -p "$mockbin" "$state/pgdata" "$state/socket"
chmod 700 "$state" "$state/pgdata" "$state/socket"
printf '16\n' >"$state/pgdata/PG_VERSION"
printf '999999\n%s\n0\n45432\n' "$state/pgdata" >"$state/pgdata/postmaster.pid"
cat >"$state/config" <<'EOF'
pg_port=45432
app_port=45433
database_name=trainercrm_persistent_0123456789abcdef
cluster_admin=trainercrm_persistent_cluster_admin
operator_role=trainercrm_persistent_operator
app_role=trainercrm_app
app_password=offline-secret-must-not-print
EOF
chmod 600 "$state/config"
printf 'migrations=001-011\ninitialized_at=2026-01-01T00:00:00Z\n' >"$state/initialized"
chmod 600 "$state/initialized"
calls="$tmp/calls"; dbstate="$tmp/dbstate"; printf '011\n' >"$dbstate"

cat >"$mockbin/pg_config" <<EOF
#!/usr/bin/env bash
printf '%s\n' '$mockbin'
EOF
cat >"$mockbin/realpath" <<EOF
#!/usr/bin/env bash
if [ "\${*: -1}" = '$state' ]; then printf '%s\n' /home/offline/trainercrm-pilot; else /usr/bin/realpath "\$@"; fi
EOF
cat >"$mockbin/pg_ctl" <<EOF
#!/usr/bin/env bash
printf 'pg_ctl %s\n' "\$*" >>'$calls'
exit 0
EOF
cat >"$mockbin/psql" <<EOF
#!/usr/bin/env bash
input="\$(command cat)"
printf 'psql %s\n' "\$*" >>'$calls'
if [[ " \$* " == *" -f "* ]]; then printf '012\n' >'$dbstate'; exit 0; fi
if [[ "\$input" == *PILOT_3C_CATALOG_CHECK* ]]; then
  # Reproduce the relevant psql rule: variables inside dollar quotes remain
  # literal. Fail if the regression reintroduces such a reference.
  check_body="\${input#*DO \$check\$}"
  check_body="\${check_body%%END \$check\$;*}"
  [[ "\$check_body" != *":'expected_state'"* ]] || exit 97
  [[ "\$input" == *"set_config('trainercrm.pilot_3c_expected_state', :'expected_state', false)"* ]] || exit 98
  [[ "\$check_body" == *"current_setting('trainercrm.pilot_3c_expected_state')='011'"* ]] || exit 99
  [[ "\$check_body" == *"current_setting('trainercrm.pilot_3c_expected_state')='012'"* ]] || exit 100
  expected_state=
  while [ "\$#" -gt 0 ]; do
    if [ "\$1" = -v ] && [ "\$#" -ge 2 ]; then
      case "\$2" in expected_state=*) expected_state="\${2#expected_state=}" ;; esac
      shift
    fi
    shift
  done
  case "\$expected_state" in 011|012) ;; *) exit 101 ;; esac
  [ "\$(<'$dbstate')" = "\$expected_state" ] || exit 1
  printf 'STATE_OK|2|trainershash\nCLIENTS_OK|3|clientshash\n'
fi
exit 0
EOF
cat >"$mockbin/pg_dump" <<EOF
#!/usr/bin/env bash
printf 'pg_dump %s\n' "\$*" >>'$calls'
while [ "\$#" -gt 0 ]; do [ "\$1" = -f ] && { shift; printf 'verified mock dump\n' >"\$1"; exit 0; }; shift; done
exit 1
EOF
cat >"$mockbin/pg_restore" <<EOF
#!/usr/bin/env bash
printf 'pg_restore %s\n' "\$*" >>'$calls'
grep -q 'verified mock dump' "\${@: -1}"
EOF
chmod +x "$mockbin"/*

run() { PATH="$mockbin:$PATH" XDG_DATA_HOME="$tmp/data" "$upgrade" "$@"; }
run preflight >"$tmp/preflight.out"
grep -q 'no changes made' "$tmp/preflight.out"
! grep -q 'offline-secret' "$tmp/preflight.out"
[ "$(<"$dbstate")" = 011 ]
grep -q 'psql .* -v expected_state=011' "$calls"

if printf 'wrong\n' | run upgrade >"$tmp/refuse.out" 2>&1; then exit 1; fi
[ "$(<"$dbstate")" = 011 ]
! grep -q '^pg_dump ' "$calls"

printf 'UPGRADE TRAINERCRM PERSISTENT PILOT TO 012\n' | run upgrade >"$tmp/upgrade.out"
[ "$(<"$dbstate")" = 012 ]
grep -q '^pg_dump ' "$calls"
grep -q '^pg_restore ' "$calls"
restore_line="$(grep -n '^pg_restore ' "$calls" | tail -1 | cut -d: -f1)"
migration_line="$(grep -n 'psql .* -f .*012_trainer_appointments_runtime.sql' "$calls" | tail -1 | cut -d: -f1)"
[ "$restore_line" -lt "$migration_line" ]
grep -q 'migrations=001-012' "$state/initialized"
! grep -q 'offline-secret' "$tmp/upgrade.out"
run verify >"$tmp/verify.out"
grep -q 'Verification passed' "$tmp/verify.out"
grep -q 'psql .* -v expected_state=012' "$calls"

# Already-applied and forbidden-name states must fail before dump or migration.
if run preflight >"$tmp/already.out" 2>&1; then exit 1; fi
sed -i 's/trainercrm_persistent_0123456789abcdef/trainercrm_dev/' "$state/config"
if run verify >"$tmp/dev.out" 2>&1; then exit 1; fi
grep -q 'unsafe database_name' "$tmp/dev.out"

# Static safety assertions: no lifecycle/reset command and only reviewed migration 012.
! grep -Eq 'pg_ctl.*(start|stop)|(^|[[:space:]])initdb([[:space:]]|$)|rm[[:space:]]+-rf' "$upgrade"
grep -q '012_trainer_appointments_runtime.sql' "$upgrade"
! grep -q 'DATABASE_URL' "$upgrade"
! sed -n '/^DO \$[^$]*\$/,/^END \$[^$]*\$;/p' "$upgrade" | grep -q ":'"
printf 'Offline persistent pilot 011-to-012 safety test passed.\n'
