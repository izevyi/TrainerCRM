import { createHash, randomBytes } from "node:crypto";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const REGISTRATION_TOKEN_BYTES = 32;

export function makeRegistrationToken(): string {
  return randomBytes(REGISTRATION_TOKEN_BYTES).toString("base64url");
}

export function digestRegistrationToken(token: string): Buffer {
  if (!TOKEN_PATTERN.test(token)) throw new Error("REGISTRATION_TOKEN_INVALID");
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== REGISTRATION_TOKEN_BYTES || bytes.toString("base64url") !== token) {
    throw new Error("REGISTRATION_TOKEN_INVALID");
  }
  return createHash("sha256")
    .update("trainercrm.registration-token.v1\0", "utf8")
    .update(bytes)
    .digest();
}

export function validRegistrationPassword(password: string): boolean {
  // Eight Unicode characters, not eight UTF-8 bytes.
  return Array.from(password).length >= 8 && Buffer.byteLength(password, "utf8") <= 1024;
}
