# TrainerCRM PostgreSQL booking foundation (Milestone 7C)

This directory is an isolated, synthetic-only PostgreSQL prototype. It does not read, write, migrate, or reinterpret TrainerCRM's existing `localStorage` v1 data. A booking is not a completed `Training`.

## Requirements and migration order

- PostgreSQL 14 or newer. `gen_random_uuid()` is expected from PostgreSQL core.
- The standard `btree_gist` extension must be available and the migration user must be allowed to enable it.
- Apply to a new, dedicated database in this order:
  1. `migrations/001_extensions.sql`
  2. `migrations/002_schema.sql`
  3. `migrations/003_booking_functions.sql`

Migrations are versioned and intentionally target an empty database; they are not repeatable in place. They use ordinary PostgreSQL SQL/PL/pgSQL and no Supabase-specific objects.

## Implemented guarantees

- Fixed seats `1` and `2`; a confirmed seat and a confirmed client/slot pair are unique.
- Open slots for a trainer cannot overlap. Confirmed bookings for one verified identity cannot overlap across trainers or tenants; adjacent half-open periods are allowed.
- `booked_period` is derived from the slot by a trigger. Client, identity, seat, period, tenant, and idempotency fields cannot be changed after insert.
- Tenant-qualified foreign keys prevent cross-tenant slot/client injection. Active clients require a verified client identity and an accepted trainer invitation.
- `booking.book_slot` locks identity then slot, chooses the lowest free seat, and never accepts a seat from the caller. It returns stable exception messages such as `SLOT_FULL`, `CLIENT_TIME_CONFLICT`, and `IDEMPOTENCY_CONFLICT`.
- Idempotency is durable per client/key: the same request hash returns the existing booking; a changed hash is rejected.
- Client cancellation allows exact equality at `starts_at - interval '24 hours'`. Cancelled rows remain as history and release partial unique/exclusion constraints.
- Trainer cancellation locks the slot, requires expected version and explicit confirmation when occupied, cancels affected bookings atomically, and appends audit.
- Booking/audit writes occur in one database transaction. `PUBLIC` has no schema, table, sequence, or function access.

`booking.cancel_booking_at` exists only to verify the cutoff boundary deterministically. It is revoked from `PUBLIC` and must never be granted to an application role. Production integration grants only `booking.cancel_booking`, which uses database transaction time.

## Runtime privileges and integration boundary

The migrations do not create cluster-wide roles because many managed PostgreSQL services restrict `CREATE ROLE`. Create a server-only `NOLOGIN` group role through the chosen provider's approved administration process, then grant only:

```sql
GRANT USAGE ON SCHEMA booking TO trainercrm_booking_api;
GRANT EXECUTE ON FUNCTION booking.book_slot(uuid, uuid, uuid, text, text) TO trainercrm_booking_api;
GRANT EXECUTE ON FUNCTION booking.cancel_booking(uuid, uuid) TO trainercrm_booking_api;
GRANT EXECUTE ON FUNCTION booking.cancel_slot(uuid, uuid, bigint, boolean, text) TO trainercrm_booking_api;
```

The server login may inherit that role. Do not grant table DML, migration-owner membership, trigger helpers, the test-clock helper, or database credentials to a browser. Actor, client, tenant, seat, and role values must be resolved by a trusted server endpoint; direct browser database writes are unsupported.

## Automated tests

`tests/run.sh` refuses databases whose name does not end in `_7c_test` and requires the explicit `TRAINERCRM_ALLOW_TEST_RESET=yes` opt-in. It resets only the `booking` and `booking_test` schemas in that dedicated database, applies migrations, runs serial constraints/transaction checks, and launches 20 independent `psql` processes against one empty slot. The concurrency acceptance condition is exactly 2 `BOOKED`, 18 `SLOT_FULL`, seats `1,2`, two confirmed rows, and two confirmation audit events.

Run with an already installed PostgreSQL client/server:

```bash
createdb trainercrm_7c_test
TRAINERCRM_ALLOW_TEST_RESET=yes \
  DATABASE_URL='postgresql:///trainercrm_7c_test' \
  bash ./database-development/tests/run.sh
```

No PostgreSQL or container tools were available during this cycle, so these tests are prepared but **NOT EXECUTED**.

### Optional local Docker procedure (manual only)

The owner must first install/provide Docker outside this cycle. The database port is bound only to loopback and all values are synthetic:

```bash
docker run --detach --name trainercrm-pg-7c \
  --publish 127.0.0.1:55432:5432 \
  --env POSTGRES_DB=trainercrm_7c_test \
  --env POSTGRES_USER=trainercrm_test \
  --env POSTGRES_PASSWORD=synthetic-local-only \
  --mount type=volume,src=trainercrm-pg-7c-data,dst=/var/lib/postgresql/data \
  --mount type=bind,src=/mnt/d/TrainerCRM/database-development,dst=/workspace,readonly \
  postgres:17

docker exec trainercrm-pg-7c pg_isready -U trainercrm_test -d trainercrm_7c_test
docker exec \
  --env TRAINERCRM_ALLOW_TEST_RESET=yes \
  --env DATABASE_URL='postgresql://trainercrm_test:synthetic-local-only@127.0.0.1:5432/trainercrm_7c_test' \
  --workdir /workspace \
  trainercrm-pg-7c \
  bash tests/run.sh
```

Stop and remove the disposable container while retaining the named test volume:

```bash
docker stop trainercrm-pg-7c
docker rm trainercrm-pg-7c
```

Only after explicitly confirming that the named volume contains no wanted data, remove it manually:

```bash
docker volume rm trainercrm-pg-7c-data
```

Never use these commands with production credentials, personal data, a shared database, a public bind address, or a production volume.

## Assumptions, unsupported features, and risks

- Identities use synthetic references only. Encryption/HMAC key management, real phones, OTP, sessions, SMS, auth recovery, and invitation acceptance workflows are not implemented.
- No application API or frontend integration, no localStorage migration, no booking-to-Training conversion, no rescheduling, notifications, outbox, RLS policy matrix, PITR, or deployment is included.
- `SECURITY DEFINER` functions are defense in depth, not authentication. A future server must authenticate sessions, resolve actor identity, map stable SQL messages to coarse API errors, and set timeouts.
- Constraint and lock behavior is designed for concurrency but remains unverified until the supplied tests run on real PostgreSQL with genuinely independent connections.
- The serial suite covers core capacity, idempotency, cross-trainer overlap, cutoff equality/late behavior, cancellation/seat reuse, tenant injection, privileges, and occupied-slot confirmation. Further acceptance work should add one-seat-left, concurrent idempotent replay, same-identity overlapping-slot races, cancellation races, restore, and application-version compatibility.
- Production provider, regions, privacy/legal controls, runtime roles, backup/restore, monitoring, and RLS remain human approval gates.

## Safe future integration path

After human review and real-PostgreSQL test evidence, add a server-only database adapter in a separately approved cycle. Give it only narrow function execution, map function outcomes to the documented stable API contract, add authenticated invitation/session flows, and keep the current localStorage implementation untouched until a separately designed migration is approved.
