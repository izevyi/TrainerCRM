import { createHash, randomBytes } from "node:crypto";

export const TRAINER_SESSION_TOKEN_BYTES = 32;
export const TRAINER_SESSION_DIGEST_BYTES = 32;

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class TrainerSessionTokenError extends Error {
  constructor(message: "SESSION_TOKEN_INVALID") {
    super(message);
    this.name = "TrainerSessionTokenError";
  }
}

function decodeSessionToken(token: string): Buffer {
  if (!SESSION_TOKEN_PATTERN.test(token)) {
    throw new TrainerSessionTokenError("SESSION_TOKEN_INVALID");
  }

  const decoded = Buffer.from(token, "base64url");
  if (
    decoded.length !== TRAINER_SESSION_TOKEN_BYTES ||
    decoded.toString("base64url") !== token
  ) {
    throw new TrainerSessionTokenError("SESSION_TOKEN_INVALID");
  }

  return decoded;
}

export function generateTrainerSessionToken(): string {
  return randomBytes(TRAINER_SESSION_TOKEN_BYTES).toString("base64url");
}

export function digestTrainerSessionToken(token: string): Buffer {
  return createHash("sha256").update(decodeSessionToken(token)).digest();
}
