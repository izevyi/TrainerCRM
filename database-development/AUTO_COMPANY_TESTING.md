# Auto-Company testing for TrainerCRM

## Run the suite

From the Auto-Company checkout, run:

```bash
cd /home/petro/projects/Auto-Company-test
make test
```

The command invokes `scripts/core/test-trainercrm.sh`. Run it as the Ubuntu user `petro`; the wrapper refuses any other user. It also expects the TrainerCRM repository at `/mnt/d/TrainerCRM` on branch `auto-company-test` and connects through the local PostgreSQL socket using:

```text
postgresql:///trainercrm_auto_test?user=petro&host=/var/run/postgresql
```

The database must already exist. The wrapper does not create or drop a database. The suite is destructive only to the fixed test schemas named by the Milestone 7F.5 runner, so `trainercrm_auto_test` must remain a dedicated disposable test database rather than a development, shared, or production database.

## Purpose of `trainercrm_auto_test`

`trainercrm_auto_test` is the fixed PostgreSQL target used by the Auto-Company regression wrapper. Before running any reset, the wrapper verifies the combined database identity is exactly:

```text
trainercrm_auto_test|petro|petro|false
```

This means the current database is `trainercrm_auto_test`, both the session user and database owner are `petro`, and the session user is not a PostgreSQL superuser. The wrapper then makes a temporary test tree, links the existing migrations and tests into it, and adapts a temporary copy of the Milestone 7F.5 runner to use `trainercrm_auto_test` and an Auto-Company-specific reset opt-in. The original TrainerCRM runner is not edited.

The suite applies migrations 001–007 and exercises the Milestone 7F.5 invitation-acceptance checks, its acceptance and accept/revoke races, and the unchanged booking and authentication regression suites.

## Why the original 7F.5 database guard is exact

The original runner contains this guard:

```bash
if [ "$database_name" != trainercrm_7f5_test ]; then
```

It also requires `TRAINERCRM_ALLOW_7F5_TEST_RESET=yes`. These two checks are the safety boundary before the runner drops and recreates fixed test schemas. The Auto-Company wrapper first verifies that both literal guards still exist in the original runner. It then changes only a temporary copy to target `trainercrm_auto_test` and to require `TRAINERCRM_ALLOW_AUTO_TEST_RESET=yes`.

Keep the original database comparison exact. Broadening it to a suffix, pattern, environment-selected name, or a different fixed name would weaken the fail-closed protection and would also cause the wrapper to stop with `FAIL: original database guard changed`. The original runner must remain safe when invoked independently against its dedicated `trainercrm_7f5_test` database; Auto-Company’s alternate database is permitted only in the guarded temporary copy.

## PASS, FAIL, and logs

During execution, the wrapper prints matching PostgreSQL and runner lines containing `PASS:`, `FAIL:`, `ERROR:`, `FATAL:`, or `assertion failed`.

A successful run ends with:

```text
PASS: AUTOMATED TRAINERCRM TEST SUITE
LOG=/home/petro/projects/Auto-Company-test/logs/trainercrm-auto-test-YYYYMMDD-HHMMSS.log
```

PASS means both conditions held: the temporary 7F.5 runner exited with status zero, and its log contained the final marker `PASS: Milestone 7F.5 invitation acceptance and regressions`.

A failed run prints:

```text
FAIL: AUTOMATED TRAINERCRM TEST SUITE
```

If test execution reached the logging stage, the wrapper then shows the last 35 log lines, prints `LOG=...`, and exits nonzero. Open that path for the complete combined standard-output and standard-error log. Early user, branch, PostgreSQL connection, database-identity, or original-runner guard failures occur before the test log is created and report their reason directly in the terminal. Later failures can represent a migration or SQL failure, race assertion failure, regression failure, or absence of the required final PASS marker; the top-level FAIL does not by itself identify which application behavior failed.

## Milestone 7F.5 is not a public endpoint

Milestone 7F.5 adds `authn.accept_new_email_invitation` as an internal database transaction primitive for accepting a new email identity. Its tenant, trainer, client, invitation, pepper-version, and token-digest arguments are selectors and consistency checks; they are not authentication and do not prove control of a mailbox or possession of the raw invitation bearer.

The migration revokes execution from `PUBLIC`, grants no non-owner role access, and the SQL suite verifies that the function has no non-owner grantee. It intentionally fails closed for an already verified identity because exact-subject authentication and fresh step-up are not implemented there.

Therefore the primitive must not be exposed directly as an HTTP/API email-verification endpoint or granted to an application role. A separately approved trusted adapter would first need to verify the raw bearer and the pre-auth request, then invoke the primitive through an explicitly reviewed execution boundary. Milestone 7F.5 provides neither that adapter nor sessions, request authentication, mailbox-proof handling, email delivery, or public endpoint behavior.
