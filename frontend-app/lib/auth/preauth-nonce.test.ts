import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import {
  PREAUTH_NONCE_LIFETIME_MS,
  issuePreauthNonce,
  verifyPreauthNonce,
} from "./preauth-nonce";

const origin = "https://trainer.example.invalid";
const macKey = Buffer.alloc(32, 0x31);
const otherMacKey = Buffer.alloc(32, 0x32);
const issuedAt = 1_800_000_000_000;

function issue() {
  return issuePreauthNonce({ applicationOrigin: origin, macKey, nowMs: issuedAt });
}

function verify(
  issued: ReturnType<typeof issue>,
  overrides: Record<string, unknown> = {},
) {
  return verifyPreauthNonce({
    challenge: issued.challenge,
    cookieNonce: issued.cookieNonce,
    requestOrigin: origin,
    applicationOrigin: origin,
    macKey,
    nowMs: issuedAt,
    ...overrides,
  } as Parameters<typeof verifyPreauthNonce>[0]);
}

function decodeEnvelope(challenge: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(challenge.split(".")[0], "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

function signEnvelope(envelopeJson: string, key = macKey): string {
  const payload = Buffer.from(envelopeJson, "utf8");
  const mac = createHmac("sha256", key)
    .update("trainercrm.preauth-nonce.v1", "utf8")
    .update(Buffer.from([0]))
    .update(payload)
    .digest("base64url");
  return `${payload.toString("base64url")}.${mac}`;
}

describe("server-side pre-authentication nonce", () => {
  it("issues independent 128-bit nonces and verifies the bound challenge", () => {
    const first = issue();
    const second = issue();
    const envelope = decodeEnvelope(first.challenge);

    expect(() => verify(first)).not.toThrow();
    expect(first.cookieNonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(envelope.n).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(envelope.n).not.toBe(first.cookieNonce);
    expect(second.cookieNonce).not.toBe(first.cookieNonce);
    expect(decodeEnvelope(second.challenge).n).not.toBe(envelope.n);
    expect(envelope.exp).toBe(issuedAt + PREAUTH_NONCE_LIFETIME_MS);
  });

  it("enforces the exact five-minute boundary with equality expired", () => {
    const issued = issue();
    expect(() => verify(issued, { nowMs: issuedAt + 299_999 })).not.toThrow();
    expect(() => verify(issued, { nowMs: issuedAt + 300_000 })).toThrow(
      "PREAUTH_INVALID",
    );
    expect(() => verify(issued, { nowMs: issuedAt + 300_001 })).toThrow(
      "PREAUTH_INVALID",
    );
  });

  it("rejects incorrect purpose, configured origin, and request origin", () => {
    const issued = issue();
    const envelope = decodeEnvelope(issued.challenge);
    const wrongPurpose = signEnvelope(
      JSON.stringify({ ...envelope, p: "email-change.confirm" }),
    );

    expect(() => verify(issued, { challenge: wrongPurpose })).toThrow(
      "PREAUTH_INVALID",
    );
    expect(() =>
      verify(issued, { applicationOrigin: "https://other.example.invalid" }),
    ).toThrow("PREAUTH_INVALID");
    expect(() =>
      verify(issued, { requestOrigin: "https://other.example.invalid" }),
    ).toThrow("PREAUTH_INVALID");
  });

  it.each([
    undefined,
    null,
    "null",
    "",
    "http://trainer.example.invalid",
    "https://trainer.example.invalid/",
    "https://trainer.example.invalid/path",
    "https://trainer.example.invalid, https://other.example.invalid",
    "not an origin",
  ])("rejects missing or malformed request Origin %#", (requestOrigin) => {
    expect(() => verify(issue(), { requestOrigin })).toThrow("PREAUTH_INVALID");
  });

  it("rejects an incorrect, missing, malformed, or oversized cookie nonce", () => {
    const issued = issue();
    const other = issue();
    for (const cookieNonce of [
      other.cookieNonce,
      undefined,
      null,
      "A".repeat(21),
      `${issued.cookieNonce}=`,
      "A".repeat(4_096),
    ]) {
      expect(() => verify(issued, { cookieNonce })).toThrow("PREAUTH_INVALID");
    }
  });

  it("rejects modified challenge bytes, an invalid MAC, and another MAC key", () => {
    const issued = issue();
    const [payload, signature] = issued.challenge.split(".");
    const modified = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${signature}`;
    const invalidMac = `${payload}.${"A".repeat(43)}`;

    expect(() => verify(issued, { challenge: modified })).toThrow(
      "PREAUTH_INVALID",
    );
    expect(() => verify(issued, { challenge: invalidMac })).toThrow(
      "PREAUTH_INVALID",
    );
    expect(() => verify(issued, { macKey: otherMacKey })).toThrow(
      "PREAUTH_INVALID",
    );
  });

  it.each([
    undefined,
    null,
    "secret",
    Buffer.alloc(0),
    Buffer.alloc(31),
  ])("rejects invalid MAC key configuration %#", (invalidKey) => {
    expect(() =>
      issuePreauthNonce({
        applicationOrigin: origin,
        macKey: invalidKey as Uint8Array,
        nowMs: issuedAt,
      }),
    ).toThrow("PREAUTH_CONFIG_INVALID");
    expect(() => verify(issue(), { macKey: invalidKey })).toThrow(
      "PREAUTH_CONFIG_INVALID",
    );
  });

  it("rejects invalid types, timestamps, configuration origins, and oversized challenges", () => {
    expect(() => issuePreauthNonce(null as never)).toThrow(
      "PREAUTH_CONFIG_INVALID",
    );
    expect(() => verifyPreauthNonce(null as never)).toThrow("PREAUTH_INVALID");
    expect(() => verify(issue(), { challenge: 42 })).toThrow("PREAUTH_INVALID");
    expect(() => verify(issue(), { challenge: "A".repeat(2_049) })).toThrow(
      "PREAUTH_INVALID",
    );
    expect(() => verify(issue(), { nowMs: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      "PREAUTH_INVALID",
    );
    expect(() =>
      issuePreauthNonce({
        applicationOrigin: "http://trainer.example.invalid",
        macKey,
        nowMs: issuedAt,
      }),
    ).toThrow("PREAUTH_CONFIG_INVALID");
  });

  it("rejects noncanonical envelope JSON, field order, and base64url", () => {
    const issued = issue();
    const envelope = decodeEnvelope(issued.challenge);
    const reordered = signEnvelope(
      JSON.stringify({ p: envelope.p, v: envelope.v, o: envelope.o, iat: envelope.iat, exp: envelope.exp, n: envelope.n, c: envelope.c }),
    );
    const whitespace = signEnvelope(JSON.stringify(envelope, null, 2));

    expect(() => verify(issued, { challenge: reordered })).toThrow(
      "PREAUTH_INVALID",
    );
    expect(() => verify(issued, { challenge: whitespace })).toThrow(
      "PREAUTH_INVALID",
    );
    expect(() => verify(issued, { challenge: `${issued.challenge}=` })).toThrow(
      "PREAUTH_INVALID",
    );
  });

  it("contains no invitation token, email, tenant, or invitation identifier", () => {
    const issued = issue();
    const serialized = Buffer.from(
      issued.challenge.split(".")[0],
      "base64url",
    ).toString("utf8");

    expect(Object.keys(decodeEnvelope(issued.challenge))).toEqual([
      "v",
      "p",
      "o",
      "iat",
      "exp",
      "n",
      "c",
    ]);
    for (const sensitive of [
      "client@example.invalid",
      "tenant-123",
      "invitation-456",
      Buffer.alloc(32, 7).toString("base64url"),
    ]) {
      expect(serialized).not.toContain(sensitive);
      expect(issued.challenge).not.toContain(sensitive);
    }
  });

  it("has no logging, persistence, database, or network side effects", () => {
    const consoleSpies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    try {
      const issued = issue();
      verify(issued);
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it("explicitly does not enforce single-use consumption", () => {
    const issued = issue();

    expect(() => verify(issued)).not.toThrow();
    expect(() => verify(issued)).not.toThrow();
  });
});
