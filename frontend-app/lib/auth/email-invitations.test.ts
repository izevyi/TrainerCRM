import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  EMAIL_NORMALIZATION_VERSION,
  INVITATION_DIGEST_BYTES,
  INVITATION_LIFETIME_MS,
  INVITATION_TOKEN_BYTES,
  computeInvitationTokenDigest,
  generateInvitationToken,
  invitationDigestsEqual,
  invitationExpiresAt,
  isInvitationExpired,
  normalizeEmailV1,
} from "./email-invitations";

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const secret = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "hex",
);

describe("email normalization v1", () => {
  it("exports the frozen normalization version", () => {
    expect(EMAIL_NORMALIZATION_VERSION).toBe(1);
  });

  it.each([
    [" User.Name+tag@Example.COM ", "user.name+tag@example.com"],
    ["\tADMIN@EXAMPLE.INVALID\t", "admin@example.invalid"],
    ["user@bücher.example", "user@xn--bcher-kva.example"],
    ["user@BÜCHER.EXAMPLE", "user@xn--bcher-kva.example"],
    ["USER@faß.de", "user@xn--fa-hia.de"],
    ["user@ｅｘａｍｐｌｅ.com", "user@example.com"],
    ["user@example。com", "user@example.com"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeEmailV1(input)).toBe(expected);
  });

  it.each([
    "",
    "user",
    "@example.com",
    "user@",
    "a@b@example.com",
    '"user"@example.com',
    "user(comment)@example.com",
    "üser@example.com",
    "user@[127.0.0.1]",
    "user@example.com.",
    "user..name@example.com",
    ".user@example.com",
    "user.@example.com",
    "user name@example.com",
    "user\n@example.com",
    "user\u00a0@example.com",
    "user@example..com",
    "user@-example.com",
    "user@example-.com",
    "user@a_b.example",
    "user@localhost",
    `user@${"a".repeat(64)}.com`,
    "user@\u200d.com",
    `${"a".repeat(65)}@example.com`,
    `${"a".repeat(244)}@example.com`,
  ])("rejects invalid address %j", (input) => {
    expect(() => normalizeEmailV1(input)).toThrow("EMAIL_INVALID");
  });

  it("rejects an overlong raw input even when ASCII trimming would shorten it", () => {
    const padded = `${" ".repeat(242)}a@example.com`;
    expect(Buffer.byteLength(padded)).toBeGreaterThan(254);
    expect(() => normalizeEmailV1(padded)).toThrow("EMAIL_INVALID");
  });

  it("accepts a 64-byte local part", () => {
    expect(normalizeEmailV1(`${"A".repeat(64)}@example.com`)).toBe(
      `${"a".repeat(64)}@example.com`,
    );
  });

  it("accepts a structurally valid address at exactly 254 UTF-8 bytes", () => {
    const domain = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(61)}`;
    const input = `${"d".repeat(64)}@${domain}`;
    expect(Buffer.byteLength(input)).toBe(254);
    expect(normalizeEmailV1(input)).toBe(input);
  });
});

describe("invitation token security", () => {
  it("generates a canonical token with exactly 256 random bits", () => {
    const generated = generateInvitationToken();
    expect(generated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(generated, "base64url")).toHaveLength(
      INVITATION_TOKEN_BYTES,
    );
  });

  it("produces a stable purpose-bound HMAC-SHA-256 digest", () => {
    const digest = computeInvitationTokenDigest(
      token,
      "invitation.accept",
      secret,
    );
    expect(digest).toHaveLength(INVITATION_DIGEST_BYTES);
    expect(digest.toString("hex")).toBe(
      "547dd1c7bcf3d89e10873b14678190adad7b8e57c950757b2bc416698b819bc2",
    );
  });

  it("does not match the same token under the wrong purpose", () => {
    const expected = computeInvitationTokenDigest(
      token,
      "invitation.accept",
      secret,
    );
    const wrongPurpose = computeInvitationTokenDigest(
      token,
      "email-change.confirm",
      secret,
    );
    expect(invitationDigestsEqual(expected, wrongPurpose)).toBe(false);
  });

  it("compares equal digests and rejects unequal or malformed digests", () => {
    const expected = computeInvitationTokenDigest(
      token,
      "invitation.accept",
      secret,
    );
    expect(invitationDigestsEqual(expected, Buffer.from(expected))).toBe(true);

    const changed = Buffer.from(expected);
    changed[0] ^= 1;
    expect(invitationDigestsEqual(expected, changed)).toBe(false);
    expect(invitationDigestsEqual(expected, expected.subarray(1))).toBe(false);
  });

  it.each([
    "",
    "not-base64url!",
    "A".repeat(42),
    "A".repeat(44),
  ])("rejects invalid raw token %j", (invalidToken) => {
    expect(() =>
      computeInvitationTokenDigest(
        invalidToken,
        "invitation.accept",
        secret,
      ),
    ).toThrow("TOKEN_INVALID");
  });

  it("rejects an invalid purpose and a short injected secret", () => {
    expect(() =>
      computeInvitationTokenDigest(token, "Invitation Accept", secret),
    ).toThrow("PURPOSE_INVALID");
    expect(() =>
      computeInvitationTokenDigest(
        token,
        "invitation.accept",
        Buffer.alloc(31),
      ),
    ).toThrow("SECRET_INVALID");
  });
});

describe("invitation expiration", () => {
  const createdAt = Date.UTC(2026, 9, 31, 12, 30, 0, 0);
  const expiresAt = createdAt + INVITATION_LIFETIME_MS;

  it("computes an exact 24-hour expiration without reading the clock", () => {
    expect(invitationExpiresAt(createdAt)).toBe(expiresAt);
  });

  it.each([
    [expiresAt - 1, false],
    [expiresAt, true],
    [expiresAt + 1, true],
  ])("checks boundary timestamp %d as expired=%s", (now, expected) => {
    expect(isInvitationExpired(createdAt, now)).toBe(expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects invalid timestamp %s",
    (invalidTimestamp) => {
      expect(() => invitationExpiresAt(invalidTimestamp)).toThrow(
        "TIMESTAMP_INVALID",
      );
      expect(() => isInvitationExpired(createdAt, invalidTimestamp)).toThrow(
        "TIMESTAMP_INVALID",
      );
    },
  );
});
