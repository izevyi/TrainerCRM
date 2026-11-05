import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import {
  acceptNewEmailInvitation,
  InvitationAcceptanceError,
  type InvitationAcceptanceDatabase,
} from "./invitation-acceptance-coordinator";
import { issuePreauthNonce } from "./preauth-nonce";

const origin = "https://trainer.example.invalid";
const nowMs = 1_800_000_000_000;
const macKey = Buffer.alloc(32, 0x31);
const pepper = Buffer.alloc(32, 0x42);
const bearer = Buffer.alloc(32, 0x53).toString("base64url");
const ids = {
  invitationId: "10000000-0000-4000-8000-000000000001",
  tenantId: "20000000-0000-4000-8000-000000000002",
  trainerId: "30000000-0000-4000-8000-000000000003",
  clientId: "40000000-0000-4000-8000-000000000004",
  subjectId: "50000000-0000-4000-8000-000000000005",
  identityId: "60000000-0000-4000-8000-000000000006",
} as const;

function lookupRow(overrides: Record<string, unknown> = {}) {
  return {
    invitationId: ids.invitationId,
    tenantId: ids.tenantId,
    trainerId: ids.trainerId,
    clientId: ids.clientId,
    normalizationVersion: 1,
    canonicalEmail: "client@example.invalid",
    pepperVersion: 7,
    status: "pending",
    isUnexpired: true,
    ...overrides,
  };
}

function acceptanceRow(overrides: Record<string, unknown> = {}) {
  return {
    invitationId: ids.invitationId,
    subjectId: ids.subjectId,
    identityId: ids.identityId,
    relationshipVersion: "1",
    ...overrides,
  };
}

function database(
  acceptRows?: readonly unknown[],
): InvitationAcceptanceDatabase & { query: ReturnType<typeof vi.fn> } {
  const rows = acceptRows ?? [acceptanceRow()];
  return {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes("FROM authn.invitation_issuances")
        ? [lookupRow()]
        : rows,
    })),
  };
}

function validOptions(db = database()) {
  const nonce = issuePreauthNonce({
    applicationOrigin: origin,
    macKey,
    nowMs,
  });
  return {
    rawBearer: bearer,
    challenge: nonce.challenge,
    cookieNonce: nonce.cookieNonce,
    requestOrigin: origin,
    configuration: {
      applicationOrigin: origin,
      preauthMacKey: macKey,
      readableInvitationPeppers: [{ version: 7, pepper }],
    },
    database: db,
    nowMs,
  } as const;
}

function independentlyDeriveNonceDigest(challenge: string): Buffer {
  const envelope = JSON.parse(
    Buffer.from(challenge.split(".")[0], "base64url").toString("utf8"),
  ) as { n: string };
  const purpose = Buffer.from("invitation.accept", "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(purpose.length);
  return createHash("sha256")
    .update("trainercrm.preauth-nonce-consumption.v1", "utf8")
    .update(Buffer.from([0]))
    .update(length)
    .update(purpose)
    .update(Buffer.from([0]))
    .update(Buffer.from(envelope.n, "base64url"))
    .digest();
}

describe("internal new-email invitation acceptance coordinator", () => {
  it("completes the flow and returns only minimal verified acceptance metadata", async () => {
    const db = database();
    const result = await acceptNewEmailInvitation(validOptions(db));

    expect(result).toEqual({
      invitationId: ids.invitationId,
      subjectId: ids.subjectId,
      identityId: ids.identityId,
      relationshipVersion: "1",
    });
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it("uses the exact parameterized migration 008 function and argument order", async () => {
    const db = database();
    const options = validOptions(db);
    await acceptNewEmailInvitation(options);
    const [sql, parameters] = db.query.mock.calls[1];

    expect(sql).toContain(
      "FROM authn.consume_preauth_nonce_and_accept_new_email_invitation(\n  $1, $2, $3, $4, $5, $6, $7, $8, $9\n)",
    );
    expect(sql).not.toContain(bearer);
    expect(parameters).toEqual([
      independentlyDeriveNonceDigest(options.challenge),
      new Date(nowMs),
      new Date(nowMs + 300_000),
      ids.tenantId,
      ids.trainerId,
      ids.clientId,
      ids.invitationId,
      7,
      db.query.mock.calls[0][1][1],
    ]);
    expect(parameters[0]).toHaveLength(32);
    expect(parameters[8]).toHaveLength(32);
  });

  it("passes no raw bearer, cookie nonce, challenge, MAC key, or pepper to SQL", async () => {
    const db = database();
    const options = validOptions(db);
    await acceptNewEmailInvitation(options);

    for (const [sql, parameters] of db.query.mock.calls) {
      expect(sql).not.toContain(options.rawBearer);
      expect(sql).not.toContain(options.challenge);
      expect(parameters).not.toContain(options.rawBearer);
      expect(parameters).not.toContain(options.challenge);
      expect(parameters).not.toContain(options.cookieNonce);
      expect(parameters).not.toContain(macKey);
      expect(parameters).not.toContain(pepper);
    }
  });

  it.each([
    ["invalid bearer", { rawBearer: "invalid" }],
    ["invalid challenge", { challenge: "invalid" }],
    ["missing Origin", { requestOrigin: undefined }],
    ["incorrect Origin", { requestOrigin: "https://other.example.invalid" }],
    ["non-HTTPS Origin", { requestOrigin: "http://trainer.example.invalid" }],
    [
      "incorrect cookie",
      { cookieNonce: Buffer.alloc(16, 9).toString("base64url") },
    ],
    ["expired challenge", { nowMs: nowMs + 300_000 }],
  ])("fails generically for %s", async (_label, override) => {
    const db = database();
    await expect(
      acceptNewEmailInvitation({ ...validOptions(db), ...override }),
    ).rejects.toEqual(new InvitationAcceptanceError());
  });

  it("does not query lookup or acceptance after pre-auth validation fails", async () => {
    const db = database();
    await expect(
      acceptNewEmailInvitation({ ...validOptions(db), challenge: "invalid" }),
    ).rejects.toThrow("LINK_INVALID");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("fails generically and skips acceptance when no invitation matches", async () => {
    const db = database();
    db.query.mockImplementation(async () => ({ rows: [] }));
    await expect(acceptNewEmailInvitation(validOptions(db))).rejects.toThrow(
      "LINK_INVALID",
    );
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("treats lookup success as insufficient when atomic acceptance fails", async () => {
    const db = database();
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM authn.invitation_issuances")) {
        return { rows: [lookupRow()] };
      }
      throw new Error("LINK_INVALID");
    });

    await expect(acceptNewEmailInvitation(validOptions(db))).rejects.toThrow(
      "LINK_INVALID",
    );
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it.each([
    { rows: [] },
    { rows: [acceptanceRow(), acceptanceRow()] },
    { rows: [null] },
    { rows: [acceptanceRow({ invitationId: ids.clientId })] },
    { rows: [acceptanceRow({ subjectId: "corrupted" })] },
    { rows: [acceptanceRow({ identityId: null })] },
    { rows: [acceptanceRow({ relationshipVersion: 1 })] },
    { rows: [acceptanceRow({ relationshipVersion: "0" })] },
  ])(
    "rejects missing, duplicate, or corrupted acceptance rows %#",
    async ({ rows }) => {
      await expect(
        acceptNewEmailInvitation(validOptions(database(rows))),
      ).rejects.toThrow("LINK_INVALID");
    },
  );

  it("fails closed without retrying a database failure", async () => {
    const db = database();
    db.query.mockRejectedValue(new Error("database internals"));

    await expect(acceptNewEmailInvitation(validOptions(db))).rejects.toEqual(
      new InvitationAcceptanceError(),
    );
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("does not log, create sessions, or send email", async () => {
    const db = database();
    const consoleSpies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    const session = vi.fn();
    const email = vi.fn();
    try {
      await acceptNewEmailInvitation(validOptions(db));
      expect(session).not.toHaveBeenCalled();
      expect(email).not.toHaveBeenCalled();
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
      expect(db.query.mock.calls).toHaveLength(2);
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it("does not confuse the cookie or raw bearer with the nonce digest", async () => {
    const db = database();
    const options = validOptions(db);
    await acceptNewEmailInvitation(options);
    const nonceDigest = db.query.mock.calls[1][1][0] as Buffer;
    const unframedChallengeNonce = Buffer.from(
      (JSON.parse(
        Buffer.from(options.challenge.split(".")[0], "base64url").toString(),
      ) as { n: string }).n,
      "base64url",
    );

    expect(nonceDigest).not.toEqual(
      createHash("sha256")
        .update(Buffer.from(options.cookieNonce, "base64url"))
        .digest(),
    );
    expect(nonceDigest).not.toEqual(
      createHash("sha256").update(unframedChallengeNonce).digest(),
    );
    expect(nonceDigest).not.toEqual(
      createHash("sha256")
        .update(Buffer.from(bearer, "base64url"))
        .digest(),
    );
  });
});
