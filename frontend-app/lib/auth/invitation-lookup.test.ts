import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import {
  InvitationLookupError,
  lookupInvitationByBearer,
  type InvitationQueryExecutor,
} from "./invitation-lookup";

const bearer = Buffer.alloc(32, 7).toString("base64url");
const pepper1 = Buffer.alloc(32, 11);
const pepper2 = Buffer.alloc(32, 22);
const ids = {
  invitationId: "10000000-0000-4000-8000-000000000001",
  tenantId: "20000000-0000-4000-8000-000000000002",
  trainerId: "30000000-0000-4000-8000-000000000003",
  clientId: "40000000-0000-4000-8000-000000000004",
} as const;

function row(overrides: Record<string, unknown> = {}) {
  return {
    ...ids,
    normalizationVersion: 1,
    canonicalEmail: "client@example.invalid",
    pepperVersion: 2,
    status: "pending",
    isUnexpired: true,
    ...overrides,
  };
}

function fakeQuery(
  implementation: InvitationQueryExecutor["query"],
): InvitationQueryExecutor & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn(implementation) };
}

describe("internal invitation lookup", () => {
  it("returns exact database-derived identifiers and scope for one match", async () => {
    const database = fakeQuery(async (_sql, parameters) => ({
      rows: parameters[0] === 2 ? [row()] : [],
    }));

    const result = await lookupInvitationByBearer(
      bearer,
      [
        { version: 1, pepper: pepper1 },
        { version: 2, pepper: pepper2 },
      ],
      database,
    );

    expect(result).toMatchObject({
      ...ids,
      normalizationVersion: 1,
      canonicalEmail: "client@example.invalid",
      pepperVersion: 2,
    });
    expect(result.tokenDigest).toEqual(database.query.mock.calls[1][1][1]);
    expect(Object.keys(result).sort()).toEqual([
      "canonicalEmail",
      "clientId",
      "invitationId",
      "normalizationVersion",
      "pepperVersion",
      "tenantId",
      "tokenDigest",
      "trainerId",
    ]);
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing invitation after searching every readable version", async () => {
    const database = fakeQuery(async () => ({ rows: [] }));

    await expect(
      lookupInvitationByBearer(
        bearer,
        [
          { version: 9, pepper: pepper2 },
          { version: 3, pepper: pepper1 },
        ],
        database,
      ),
    ).rejects.toBeInstanceOf(InvitationLookupError);
    expect(database.query).toHaveBeenCalledTimes(2);
    expect(database.query.mock.calls.map((call) => call[1][0])).toEqual([3, 9]);
  });

  it("does not exit early after a successful older-pepper match", async () => {
    const database = fakeQuery(async (_sql, parameters) => ({
      rows: parameters[0] === 1 ? [row({ pepperVersion: 1 })] : [],
    }));

    await lookupInvitationByBearer(
      bearer,
      [
        { version: 1, pepper: pepper1 },
        { version: 2, pepper: pepper2 },
      ],
      database,
    );
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it("rejects matches from more than one readable pepper", async () => {
    const database = fakeQuery(async (_sql, parameters) => ({
      rows: [row({ pepperVersion: parameters[0] })],
    }));

    await expect(
      lookupInvitationByBearer(
        bearer,
        [
          { version: 1, pepper: pepper1 },
          { version: 2, pepper: pepper2 },
        ],
        database,
      ),
    ).rejects.toThrow("LINK_INVALID");
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate rows from a single query", async () => {
    const database = fakeQuery(async () => ({ rows: [row(), row()] }));
    await expect(
      lookupInvitationByBearer(
        bearer,
        [{ version: 2, pepper: pepper2 }],
        database,
      ),
    ).rejects.toThrow("LINK_INVALID");
  });

  it("queries every version before rejecting a corrupted row", async () => {
    const database = fakeQuery(async (_sql, parameters) => ({
      rows:
        parameters[0] === 1
          ? [row({ pepperVersion: 1, clientId: "corrupted" })]
          : [],
    }));
    await expect(
      lookupInvitationByBearer(
        bearer,
        [
          { version: 1, pepper: pepper1 },
          { version: 2, pepper: pepper2 },
        ],
        database,
      ),
    ).rejects.toThrow("LINK_INVALID");
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it.each([
    null,
    [],
    row({ invitationId: "not-a-uuid" }),
    row({ tenantId: null }),
    row({ normalizationVersion: "1" }),
    row({ canonicalEmail: "CLIENT@example.invalid" }),
    row({ canonicalEmail: "client@localhost" }),
    row({ canonicalEmail: "client@bad..invalid" }),
    row({ canonicalEmail: "клиент@example.invalid" }),
    row({ pepperVersion: 1 }),
    row({ status: "accepted" }),
    row({ isUnexpired: "true" }),
  ])("rejects a malformed or inconsistent database row %#", async (badRow) => {
    const database = fakeQuery(async () => ({ rows: [badRow] }));
    await expect(
      lookupInvitationByBearer(
        bearer,
        [{ version: 2, pepper: pepper2 }],
        database,
      ),
    ).rejects.toThrow("LINK_INVALID");
  });

  it.each([
    { status: "accepted", isUnexpired: true },
    { status: "revoked", isUnexpired: true },
    { status: "superseded", isUnexpired: true },
    { status: "expired", isUnexpired: false },
    { status: "pending", isUnexpired: false },
  ])("rejects non-pending or database-expired records %#", async (state) => {
    const database = fakeQuery(async () => ({ rows: [row(state)] }));
    await expect(
      lookupInvitationByBearer(
        bearer,
        [{ version: 2, pepper: pepper2 }],
        database,
      ),
    ).rejects.toThrow("LINK_INVALID");
  });

  it("uses only a parameterized read-only SELECT without bearer or pepper exposure", async () => {
    const database = fakeQuery(async () => ({ rows: [] }));
    await expect(
      lookupInvitationByBearer(
        bearer,
        [{ version: 1, pepper: pepper1 }],
        database,
      ),
    ).rejects.toThrow("LINK_INVALID");

    const [sql, parameters] = database.query.mock.calls[0];
    expect(sql.trimStart().startsWith("SELECT")).toBe(true);
    expect(sql).toContain("pepper_version = $1");
    expect(sql).toContain("token_digest = $2");
    expect(sql).toContain("transaction_timestamp() < expires_at");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CALL)\b/i);
    expect(sql).not.toContain(bearer);
    expect(parameters).toHaveLength(2);
    expect(parameters[0]).toBe(1);
    expect(parameters[1]).toBeInstanceOf(Buffer);
    expect(parameters).not.toContain(bearer);
    expect(parameters).not.toContain(pepper1);
    expect(JSON.stringify(parameters)).not.toContain(bearer);
    expect(JSON.stringify(parameters)).not.toContain(pepper1.toString("hex"));
  });

  it("propagates unexpected database failures", async () => {
    const failure = new Error("database unavailable");
    const database = fakeQuery(async () => {
      throw failure;
    });
    await expect(
      lookupInvitationByBearer(
        bearer,
        [{ version: 1, pepper: pepper1 }],
        database,
      ),
    ).rejects.toBe(failure);
  });

  it("performs no mutation, logging, or persistence side effect", async () => {
    const database = fakeQuery(async () => ({ rows: [] }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        lookupInvitationByBearer(
          bearer,
          [{ version: 1, pepper: pepper1 }],
          database,
        ),
      ).rejects.toThrow("LINK_INVALID");
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(database.query.mock.calls[0][0]).not.toMatch(
        /\b(?:INSERT|UPDATE|DELETE|CALL)\b/i,
      );
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
