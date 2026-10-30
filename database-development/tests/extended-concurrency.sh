#!/usr/bin/env bash
set -eu

: "${DATABASE_URL:?Set DATABASE_URL to the same dedicated _7c_test database used by run.sh}"
root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
result_dir="$(mktemp -d /tmp/trainercrm-7d-races.XXXXXX)"
trap 'rm -r "$result_dir"' EXIT

psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/tests/extended-concurrency-setup.sql"

race_epoch="$(psql -X -At "$DATABASE_URL" -c "select extract(epoch from clock_timestamp() + interval '2 seconds')")"
n=2
while [ "$n" -le 11 ]; do
  suffix="$(printf '%012d' "$n")"
  psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select pg_sleep(greatest(0, ${race_epoch} - extract(epoch from clock_timestamp()))); select booking_test.try_book_any('33000000-0000-0000-0001-${suffix}', '44000000-0000-0000-0001-${suffix}', '66000000-0000-0000-0001-000000000001', 'final-seat-${suffix}', repeat('2', 32));" >"$result_dir/final-$n.out" 2>"$result_dir/final-$n.err" &
  n=$((n + 1))
done
wait
booked="$(grep -h '^BOOKED$' "$result_dir"/final-*.out | wc -l | tr -d ' ')"
full="$(grep -h '^SLOT_FULL$' "$result_dir"/final-*.out | wc -l | tr -d ' ')"
state="$(psql -X -At "$DATABASE_URL" -c "select count(*) || '|' || string_agg(seat::text, ',' order by seat) from booking.bookings where slot_id='66000000-0000-0000-0001-000000000001' and status='confirmed'")"
if [ "$booked" != 1 ] || [ "$full" != 9 ] || [ "$state" != '2|1,2' ]; then
  echo "FAIL final-seat booked=$booked full=$full state=$state" >&2
  exit 1
fi
echo "PASS: final-seat race -> 1 BOOKED, 9 SLOT_FULL, final seats 1,2"

race_epoch="$(psql -X -At "$DATABASE_URL" -c "select extract(epoch from clock_timestamp() + interval '2 seconds')")"
n=1
while [ "$n" -le 10 ]; do
  psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select pg_sleep(greatest(0, ${race_epoch} - extract(epoch from clock_timestamp()))); select booking_test.try_book_any('33000000-0000-0000-0001-000000000012', '44000000-0000-0000-0001-000000000012', '66000000-0000-0000-0001-000000000002', 'same-idempotency-key', repeat('3', 32));" >"$result_dir/idem-$n.out" 2>"$result_dir/idem-$n.err" &
  n=$((n + 1))
done
wait
idem_booked="$(grep -h '^BOOKED$' "$result_dir"/idem-*.out | wc -l | tr -d ' ')"
idem_replayed="$(grep -h '^REPLAYED$' "$result_dir"/idem-*.out | wc -l | tr -d ' ')"
idem_state="$(psql -X -At "$DATABASE_URL" -c "select (select count(*) from booking.bookings where client_id='44000000-0000-0000-0001-000000000012' and idempotency_key='same-idempotency-key') || '|' || (select count(*) from booking.booking_events e join booking.bookings b on b.id=e.booking_id where b.client_id='44000000-0000-0000-0001-000000000012' and b.idempotency_key='same-idempotency-key' and e.event_type='booking.confirmed')")"
changed="$(psql -X -At "$DATABASE_URL" -c "select booking_test.try_book_any('33000000-0000-0000-0001-000000000012', '44000000-0000-0000-0001-000000000012', '66000000-0000-0000-0001-000000000002', 'same-idempotency-key', repeat('4', 32))")"
if [ "$idem_booked" != 1 ] || [ "$idem_replayed" != 9 ] || [ "$idem_state" != '1|1' ] || [ "$changed" != 'IDEMPOTENCY_CONFLICT' ]; then
  echo "FAIL idempotency booked=$idem_booked replayed=$idem_replayed state=$idem_state changed=$changed" >&2
  exit 1
fi
echo "PASS: idempotency race -> 1 BOOKED, 9 REPLAYED, one booking/event, changed payload rejected"

race_epoch="$(psql -X -At "$DATABASE_URL" -c "select extract(epoch from clock_timestamp() + interval '2 seconds')")"
psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select pg_sleep(greatest(0, ${race_epoch} - extract(epoch from clock_timestamp()))); select booking_test.try_book_any('33000000-0000-0000-0002-000000000001', '44000000-0000-0000-0002-000000000001', '66000000-0000-0000-0002-000000000001', 'overlap-race-a', repeat('5', 32));" >"$result_dir/overlap-a.out" &
psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select pg_sleep(greatest(0, ${race_epoch} - extract(epoch from clock_timestamp()))); select booking_test.try_book_any('33000000-0000-0000-0002-000000000001', '44000000-0000-0000-0002-000000000002', '66000000-0000-0000-0002-000000000002', 'overlap-race-b', repeat('6', 32));" >"$result_dir/overlap-b.out" &
wait
overlap_booked="$(grep -h '^BOOKED$' "$result_dir"/overlap-*.out | wc -l | tr -d ' ')"
overlap_conflict="$(grep -h '^CLIENT_TIME_CONFLICT$' "$result_dir"/overlap-*.out | wc -l | tr -d ' ')"
race_epoch="$(psql -X -At "$DATABASE_URL" -c "select extract(epoch from clock_timestamp() + interval '2 seconds')")"
psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select pg_sleep(greatest(0, ${race_epoch} - extract(epoch from clock_timestamp()))); select booking_test.try_book_any('33000000-0000-0000-0002-000000000001', '44000000-0000-0000-0002-000000000001', '66000000-0000-0000-0002-000000000003', 'adjacent-race-a', repeat('7', 32));" >"$result_dir/adjacent-a.out" &
psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select pg_sleep(greatest(0, ${race_epoch} - extract(epoch from clock_timestamp()))); select booking_test.try_book_any('33000000-0000-0000-0002-000000000001', '44000000-0000-0000-0002-000000000002', '66000000-0000-0000-0002-000000000004', 'adjacent-race-b', repeat('8', 32));" >"$result_dir/adjacent-b.out" &
wait
adjacent_booked="$(grep -h '^BOOKED$' "$result_dir"/adjacent-*.out | wc -l | tr -d ' ')"
if [ "$overlap_booked" != 1 ] || [ "$overlap_conflict" != 1 ] || [ "$adjacent_booked" != 2 ]; then
  echo "FAIL overlap booked=$overlap_booked conflict=$overlap_conflict adjacent_booked=$adjacent_booked" >&2
  exit 1
fi
echo "PASS: overlap race -> 1 BOOKED, 1 CLIENT_TIME_CONFLICT; both adjacent periods BOOKED"

cancel_booking_id="$(psql -X -At "$DATABASE_URL" -c "select id from booking.bookings where idempotency_key='cancel-seed-0013'")"
psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "begin; select cancelled from booking.cancel_booking('33000000-0000-0000-0001-000000000013', '${cancel_booking_id}'); select pg_sleep(2); commit;" >"$result_dir/cancel.out" &
sleep 0.3
start_ms="$(date +%s%N | cut -c1-13)"
competing="$(psql -X -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "select booking_test.try_book_any('33000000-0000-0000-0001-000000000015', '44000000-0000-0000-0001-000000000015', '66000000-0000-0000-0001-000000000004', 'cancel-competitor', repeat('8', 32))")"
end_ms="$(date +%s%N | cut -c1-13)"
wait
elapsed_ms=$((end_ms - start_ms))
cancel_state="$(psql -X -At "$DATABASE_URL" -c "select count(*) || '|' || count(distinct seat) from booking.bookings where slot_id='66000000-0000-0000-0001-000000000004' and status='confirmed'")"
cancel_events="$(psql -X -At "$DATABASE_URL" -c "select count(*) from booking.booking_events where booking_id='${cancel_booking_id}' and event_type='booking.cancelled'")"
if [ "$competing" != 'BOOKED' ] || [ "$elapsed_ms" -lt 1200 ] || [ "$cancel_state" != '2|2' ] || [ "$cancel_events" != 1 ]; then
  echo "FAIL cancellation competitor=$competing elapsed_ms=$elapsed_ms state=$cancel_state cancel_events=$cancel_events" >&2
  exit 1
fi
echo "PASS: cancellation race -> competitor waited ${elapsed_ms}ms for commit, seat reused, capacity 2"

psql -X -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$root_dir/tests/security-invariants.sql"
