import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  TRAINER_PASSWORD_DERIVED_KEY_BYTES,
  TRAINER_PASSWORD_MAX_BYTES,
  TRAINER_PASSWORD_SALT_BYTES,
  hashTrainerPassword,
  verifyTrainerPassword,
} from "./trainer-password";

describe("trainer password hashing", () => {
  it("creates a versioned scrypt hash that verifies", async () => {
    const encoded = await hashTrainerPassword("correct horse battery staple");

    expect(encoded).toMatch(
      /^\$scrypt\$v=1\$N=16384,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/,
    );
    expect(await verifyTrainerPassword("correct horse battery staple", encoded)).toBe(true);
    expect(await verifyTrainerPassword("wrong password", encoded)).toBe(false);
  });

  it("uses a unique cryptographically random salt for every hash", async () => {
    const [first, second] = await Promise.all([
      hashTrainerPassword("same password"),
      hashTrainerPassword("same password"),
    ]);

    expect(first).not.toBe(second);
    const firstParts = first.split("$");
    const secondParts = second.split("$");
    expect(firstParts[4]).not.toBe(secondParts[4]);
    expect(Buffer.from(firstParts[4], "base64url")).toHaveLength(
      TRAINER_PASSWORD_SALT_BYTES,
    );
    expect(Buffer.from(firstParts[5], "base64url")).toHaveLength(
      TRAINER_PASSWORD_DERIVED_KEY_BYTES,
    );
  });

  it("accepts a password at the UTF-8 byte bound", async () => {
    const password = "a".repeat(TRAINER_PASSWORD_MAX_BYTES);
    const encoded = await hashTrainerPassword(password);
    expect(await verifyTrainerPassword(password, encoded)).toBe(true);
  });

  it.each(["", "é".repeat(TRAINER_PASSWORD_MAX_BYTES / 2 + 1)])(
    "rejects an empty or overlong password",
    async (password) => {
      await expect(hashTrainerPassword(password)).rejects.toThrow(
        "PASSWORD_INVALID",
      );
      const validHash = await hashTrainerPassword("valid password");
      expect(await verifyTrainerPassword(password, validHash)).toBe(false);
    },
  );

  it.each([
    "",
    "$argon2id$v=19$m=65536,t=3,p=1$bad$bad",
    "$scrypt$v=2$N=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$scrypt$v=1$N=16383,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$scrypt$v=1$N=262144,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$scrypt$v=1$N=16384,r=17,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$scrypt$v=1$N=16384,r=8,p=5$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$scrypt$v=1$N=16384,r=8,p=1$short$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "$scrypt$v=1$N=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$short",
    `$scrypt$v=1$N=16384,r=8,p=1$${"A".repeat(22)}$${"A".repeat(43)}$extra`,
    "x".repeat(1025),
  ])("safely rejects malformed or unbounded hash %j", async (encoded) => {
    expect(await verifyTrainerPassword("valid password", encoded)).toBe(false);
  });

  it("rejects a modified derived hash without throwing", async () => {
    const encoded = await hashTrainerPassword("valid password");
    const parts = encoded.split("$");
    const derived = Buffer.from(parts[5], "base64url");
    derived[0] ^= 1;
    parts[5] = derived.toString("base64url");

    expect(await verifyTrainerPassword("valid password", parts.join("$"))).toBe(
      false,
    );
  });
});
