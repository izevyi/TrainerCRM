import { describe, expect, it, vi } from "vitest";

import { createDatabaseHealthChecker } from "./db";

const VALID_URL = "postgresql://trainer:secret@db.example.invalid/trainercrm";

type TestQuery = (
  queryText: string,
) => Promise<{ rowCount: number | null; rows: { ok: number }[] }>;

type TestPoolConstructor = new (config: unknown) => { query: TestQuery };

function makePool(query: TestQuery) {
  const constructor = vi.fn(function FakePool(this: { query: typeof query }) {
    this.query = query;
  });

  return constructor as typeof constructor & TestPoolConstructor;
}

describe("database health checker", () => {
  it("does not construct a pool during module import or checker creation", () => {
    const Pool = makePool(
      vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ ok: 1 }] }),
    );

    createDatabaseHealthChecker(Pool, { TRAINERCRM_DATABASE_URL: VALID_URL });

    expect(Pool).not.toHaveBeenCalled();
  });

  it("fails closed when configuration is missing", async () => {
    const Pool = makePool(
      vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ ok: 1 }] }),
    );
    const check = createDatabaseHealthChecker(Pool, {});

    await expect(check()).resolves.toBe(false);
    expect(Pool).not.toHaveBeenCalled();
  });

  it.each([
    "not a URL",
    "http://trainer:secret@db.example.invalid/trainercrm",
    "postgresql:///trainercrm",
    "postgresql://db.example.invalid/trainercrm",
    "postgresql://trainer@db.example.invalid/trainercrm",
    "postgresql://trainer:secret@db.example.invalid",
    " postgresql://trainer:secret@db.example.invalid/trainercrm",
  ])("fails closed for invalid configuration: %s", async (databaseUrl) => {
    const Pool = makePool(
      vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ ok: 1 }] }),
    );
    const check = createDatabaseHealthChecker(Pool, {
      TRAINERCRM_DATABASE_URL: databaseUrl,
    });

    await expect(check()).resolves.toBe(false);
    expect(Pool).not.toHaveBeenCalled();
  });

  it("returns true after SELECT 1 and reuses one bounded pool", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ ok: 1 }] });
    const Pool = makePool(query);
    const check = createDatabaseHealthChecker(Pool, {
      TRAINERCRM_DATABASE_URL: VALID_URL,
    });

    await expect(check()).resolves.toBe(true);
    await expect(check()).resolves.toBe(true);

    expect(Pool).toHaveBeenCalledTimes(1);
    expect(Pool).toHaveBeenCalledWith({
      connectionString: VALID_URL,
      max: 5,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 10_000,
      query_timeout: 3_000,
      statement_timeout: 3_000,
      allowExitOnIdle: true,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith("SELECT 1 AS ok");
  });

  it("returns false when the query fails without leaking the error", async () => {
    const secret = "postgresql://admin:do-not-leak@internal.example/trainercrm";
    const query = vi.fn().mockRejectedValue(new Error(secret));
    const Pool = makePool(query);
    const check = createDatabaseHealthChecker(Pool, {
      TRAINERCRM_DATABASE_URL: VALID_URL,
    });

    await expect(check()).resolves.toBe(false);
  });

  it("returns false for an unexpected SELECT result", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ ok: 0 }] });
    const Pool = makePool(query);
    const check = createDatabaseHealthChecker(Pool, {
      TRAINERCRM_DATABASE_URL: VALID_URL,
    });

    await expect(check()).resolves.toBe(false);
  });
});
