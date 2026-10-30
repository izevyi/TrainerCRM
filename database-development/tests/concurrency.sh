#!/usr/bin/env bash
set -eu

: "${DATABASE_URL:?Set DATABASE_URL to the same dedicated _7c_test database used by run.sh}"
root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
result_dir="$(mktemp -d /tmp/trainercrm-7c-concurrency.XXXXXX)"
trap 'rm -r "$result_dir"' EXIT

psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/tests/concurrency-setup.sql"
start_epoch="$(psql -X -At "$DATABASE_URL" -c "select extract(epoch from clock_timestamp() + interval '3 seconds')")"

n=1
while [ "$n" -le 20 ]; do
  suffix="$(printf '%012x' "$n")"
  psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select pg_sleep(greatest(0, ${start_epoch} - extract(epoch from clock_timestamp()))); select booking_test.try_book('33000000-0000-0000-0000-${suffix}', '44000000-0000-0000-0000-${suffix}', 'concurrent-key-${suffix}');" >"$result_dir/$n.out" 2>"$result_dir/$n.err" &
  n=$((n + 1))
done
wait

booked="$(grep -h '^BOOKED$' "$result_dir"/*.out | wc -l | tr -d ' ')"
full="$(grep -h '^SLOT_FULL$' "$result_dir"/*.out | wc -l | tr -d ' ')"
confirmed="$(psql -X -At "$DATABASE_URL" -c "select count(*) from booking.bookings where slot_id='66000000-0000-0000-0000-000000000001' and status='confirmed'")"
seats="$(psql -X -At "$DATABASE_URL" -c "select string_agg(seat::text, ',' order by seat) from booking.bookings where slot_id='66000000-0000-0000-0000-000000000001' and status='confirmed'")"
events="$(psql -X -At "$DATABASE_URL" -c "select count(*) from booking.booking_events where slot_id='66000000-0000-0000-0000-000000000001' and event_type='booking.confirmed'")"

if [ "$booked" != 2 ] || [ "$full" != 18 ] || [ "$confirmed" != 2 ] || [ "$seats" != '1,2' ] || [ "$events" != 2 ]; then
  echo "FAIL booked=$booked full=$full confirmed=$confirmed seats=$seats events=$events" >&2
  sed -n '1,120p' "$result_dir"/*.out "$result_dir"/*.err >&2
  exit 1
fi
echo "PASS: 20 independent connections -> 2 BOOKED, 18 SLOT_FULL, seats 1,2, audit events 2"
