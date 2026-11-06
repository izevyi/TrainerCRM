import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  TRAINER_SESSION_DIGEST_BYTES,
  TRAINER_SESSION_TOKEN_BYTES,
  digestTrainerSessionToken,
  generateTrainerSessionToken,
} from "./trainer-session-token";

describe("trainer session tokens", () => {
  it("generates unique canonical tokens with 256 bits of entropy", () => {
    const tokens = new Set(
      Array.from({ length: 32 }, () => generateTrainerSessionToken()),
    );

    expect(tokens).toHaveLength(32);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(
        TRAINER_SESSION_TOKEN_BYTES,
      );
    }
  });

  it("returns a PostgreSQL bytea-compatible 32-byte SHA-256 digest", () => {
    const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const tokenBytes = Buffer.alloc(TRAINER_SESSION_TOKEN_BYTES);
    const digest = digestTrainerSessionToken(token);

    expect(Buffer.isBuffer(digest)).toBe(true);
    expect(digest).toHaveLength(TRAINER_SESSION_DIGEST_BYTES);
    expect(digest.equals(createHash("sha256").update(tokenBytes).digest())).toBe(
      true,
    );
  });

  it("produces different digests for different tokens", () => {
    const first = generateTrainerSessionToken();
    const second = generateTrainerSessionToken();
    expect(digestTrainerSessionToken(first).equals(digestTrainerSessionToken(second))).toBe(
      false,
    );
  });

  it.each([
    "",
    "not-base64url!",
    "A".repeat(42),
    "A".repeat(44),
    "A".repeat(43) + "=",
    "_".repeat(43),
  ])("rejects malformed session token %j", (token) => {
    expect(() => digestTrainerSessionToken(token)).toThrow(
      "SESSION_TOKEN_INVALID",
    );
  });
});

describe("session token input bounds", () => {
  it("rejects oversized malformed tokens", () => {
    expect(() =>
      digestTrainerSessionToken("A".repeat(1_000_000))
    ).toThrow("SESSION_TOKEN_INVALID");
  });
});
