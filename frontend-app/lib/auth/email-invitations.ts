import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { domainToASCII } from "node:url";

export const EMAIL_NORMALIZATION_VERSION = 1 as const;
export const INVITATION_TOKEN_BYTES = 32;
export const INVITATION_DIGEST_BYTES = 32;
export const INVITATION_LIFETIME_MS = 24 * 60 * 60 * 1000;

const MAX_EMAIL_BYTES = 254;
const MAX_LOCAL_BYTES = 64;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PURPOSE_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const LOCAL_PART_PATTERN =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FORBIDDEN_WHITESPACE_OR_CONTROL = /[\p{White_Space}\p{Cc}]/u;
const TOKEN_DOMAIN = "trainercrm.email-invitation.v1";

export class EmailInvitationSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailInvitationSecurityError";
  }
}

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

export function normalizeEmailV1(input: string): string {
  if (byteLength(input) > MAX_EMAIL_BYTES) {
    throw new EmailInvitationSecurityError("EMAIL_INVALID");
  }

  const email = input.replace(/^[\x20\x09]+|[\x20\x09]+$/g, "");
  if (!email || FORBIDDEN_WHITESPACE_OR_CONTROL.test(email)) {
    throw new EmailInvitationSecurityError("EMAIL_INVALID");
  }

  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) {
    throw new EmailInvitationSecurityError("EMAIL_INVALID");
  }

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (
    byteLength(local) > MAX_LOCAL_BYTES ||
    !LOCAL_PART_PATTERN.test(local) ||
    domain.endsWith(".") ||
    domain.startsWith("[")
  ) {
    throw new EmailInvitationSecurityError("EMAIL_INVALID");
  }

  const asciiDomain = domainToASCII(domain).toLowerCase();
  const labels = asciiDomain.split(".");
  if (
    !asciiDomain ||
    labels.length < 2 ||
    labels.some(
      (label) =>
        byteLength(label) > 63 || !DNS_LABEL_PATTERN.test(label),
    )
  ) {
    throw new EmailInvitationSecurityError("EMAIL_INVALID");
  }

  const canonical = `${local.toLowerCase()}@${asciiDomain}`;
  if (byteLength(canonical) > MAX_EMAIL_BYTES) {
    throw new EmailInvitationSecurityError("EMAIL_INVALID");
  }
  return canonical;
}

export function generateInvitationToken(): string {
  return randomBytes(INVITATION_TOKEN_BYTES).toString("base64url");
}

function decodeInvitationToken(token: string): Buffer {
  const decoded = Buffer.from(token, "base64url");
  if (
    !TOKEN_PATTERN.test(token) ||
    decoded.length !== INVITATION_TOKEN_BYTES ||
    decoded.toString("base64url") !== token
  ) {
    throw new EmailInvitationSecurityError("TOKEN_INVALID");
  }
  return decoded;
}

export function computeInvitationTokenDigest(
  token: string,
  purpose: string,
  secret: Uint8Array,
): Buffer {
  const tokenBytes = decodeInvitationToken(token);
  if (!PURPOSE_PATTERN.test(purpose)) {
    throw new EmailInvitationSecurityError("PURPOSE_INVALID");
  }
  if (secret.byteLength < INVITATION_TOKEN_BYTES) {
    throw new EmailInvitationSecurityError("SECRET_INVALID");
  }

  const purposeBytes = Buffer.from(purpose, "utf8");
  const purposeLength = Buffer.allocUnsafe(2);
  purposeLength.writeUInt16BE(purposeBytes.length);

  return createHmac("sha256", secret)
    .update(TOKEN_DOMAIN, "utf8")
    .update(Buffer.from([0]))
    .update(purposeLength)
    .update(purposeBytes)
    .update(Buffer.from([0]))
    .update(tokenBytes)
    .digest();
}

export function invitationDigestsEqual(
  expected: Uint8Array,
  candidate: Uint8Array,
): boolean {
  const expectedValid = expected.byteLength === INVITATION_DIGEST_BYTES;
  const candidateValid = candidate.byteLength === INVITATION_DIGEST_BYTES;
  const fixedExpected = expectedValid
    ? expected
    : Buffer.alloc(INVITATION_DIGEST_BYTES);
  const fixedCandidate = candidateValid
    ? candidate
    : Buffer.alloc(INVITATION_DIGEST_BYTES);
  const equal = timingSafeEqual(fixedExpected, fixedCandidate);
  return expectedValid && candidateValid && equal;
}

function requireTimestamp(timestampMs: number): void {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new EmailInvitationSecurityError("TIMESTAMP_INVALID");
  }
}

export function invitationExpiresAt(createdAtMs: number): number {
  requireTimestamp(createdAtMs);
  const expiresAtMs = createdAtMs + INVITATION_LIFETIME_MS;
  requireTimestamp(expiresAtMs);
  return expiresAtMs;
}

export function isInvitationExpired(
  createdAtMs: number,
  nowMs: number,
): boolean {
  requireTimestamp(nowMs);
  return nowMs >= invitationExpiresAt(createdAtMs);
}
