import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const PREAUTH_NONCE_LIFETIME_MS = 300_000;
export const PREAUTH_NONCE_PURPOSE = "invitation.accept" as const;

const ENVELOPE_VERSION = 1 as const;
const NONCE_BYTES = 16;
const MAC_BYTES = 32;
const MINIMUM_MAC_KEY_BYTES = 32;
const MAX_CHALLENGE_LENGTH = 2_048;
const MAX_ORIGIN_LENGTH = 2_048;
const BASE64URL_128_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL_256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;
const MAC_DOMAIN = "trainercrm.preauth-nonce.v1";

type Envelope = Readonly<{
  v: 1;
  p: typeof PREAUTH_NONCE_PURPOSE;
  o: string;
  iat: number;
  exp: number;
  n: string;
  c: string;
}>;

export type IssuedPreauthNonce = Readonly<{
  challenge: string;
  cookieNonce: string;
}>;

export type IssuePreauthNonceOptions = Readonly<{
  applicationOrigin: string;
  macKey: Uint8Array;
  nowMs?: number;
}>;

export type VerifyPreauthNonceOptions = Readonly<{
  challenge: string;
  cookieNonce: string;
  requestOrigin: string | null | undefined;
  applicationOrigin: string;
  macKey: Uint8Array;
  nowMs?: number;
}>;

export class PreauthNonceError extends Error {
  constructor(message: "PREAUTH_CONFIG_INVALID" | "PREAUTH_INVALID") {
    super(message);
    this.name = "PreauthNonceError";
  }
}

function configInvalid(): never {
  throw new PreauthNonceError("PREAUTH_CONFIG_INVALID");
}

function invalid(): never {
  throw new PreauthNonceError("PREAUTH_INVALID");
}

function requireMacKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < MINIMUM_MAC_KEY_BYTES
  ) {
    configInvalid();
  }
  return value;
}

function requireTimestamp(value: unknown, configuration: boolean): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    if (configuration) configInvalid();
    invalid();
  }
  return value;
}

function requireCanonicalHttpsOrigin(value: unknown, configuration: boolean): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ORIGIN_LENGTH
  ) {
    if (configuration) configInvalid();
    invalid();
  }

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.origin !== value
    ) {
      throw new Error("noncanonical origin");
    }
  } catch {
    if (configuration) configInvalid();
    invalid();
  }
  return value;
}

function decodeCanonicalBase64url(
  value: unknown,
  pattern: RegExp,
  expectedBytes: number,
): Buffer {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.byteLength !== expectedBytes ||
    decoded.toString("base64url") !== value
  ) {
    invalid();
  }
  return decoded;
}

function cookieBinding(cookieNonce: string): string {
  const nonce = decodeCanonicalBase64url(
    cookieNonce,
    BASE64URL_128_PATTERN,
    NONCE_BYTES,
  );
  return createHash("sha256").update(nonce).digest("base64url");
}

function serializeEnvelope(envelope: Envelope): string {
  // Property order is part of the v1 canonical encoding.
  return JSON.stringify({
    v: envelope.v,
    p: envelope.p,
    o: envelope.o,
    iat: envelope.iat,
    exp: envelope.exp,
    n: envelope.n,
    c: envelope.c,
  });
}

function computeMac(payload: Uint8Array, macKey: Uint8Array): Buffer {
  return createHmac("sha256", macKey)
    .update(MAC_DOMAIN, "utf8")
    .update(Buffer.from([0]))
    .update(payload)
    .digest();
}

function parseEnvelope(payload: Buffer): Envelope {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString("utf8"));
  } catch {
    invalid();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid();
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).join(",") !== "v,p,o,iat,exp,n,c" ||
    record.v !== ENVELOPE_VERSION ||
    record.p !== PREAUTH_NONCE_PURPOSE
  ) {
    invalid();
  }

  const envelope: Envelope = {
    v: ENVELOPE_VERSION,
    p: PREAUTH_NONCE_PURPOSE,
    o: requireCanonicalHttpsOrigin(record.o, false),
    iat: requireTimestamp(record.iat, false),
    exp: requireTimestamp(record.exp, false),
    n: typeof record.n === "string" ? record.n : invalid(),
    c: typeof record.c === "string" ? record.c : invalid(),
  };
  decodeCanonicalBase64url(envelope.n, BASE64URL_128_PATTERN, NONCE_BYTES);
  decodeCanonicalBase64url(envelope.c, BASE64URL_256_PATTERN, MAC_BYTES);
  if (serializeEnvelope(envelope) !== payload.toString("utf8")) invalid();
  return envelope;
}

/**
 * Issues a stateless invitation-confirmation challenge and its matching cookie
 * nonce. The MAC key is trusted server configuration and must be independent
 * of every invitation-token pepper.
 */
export function issuePreauthNonce(
  options: IssuePreauthNonceOptions,
): IssuedPreauthNonce {
  if (typeof options !== "object" || options === null) configInvalid();
  const macKey = requireMacKey(options.macKey);
  const applicationOrigin = requireCanonicalHttpsOrigin(
    options.applicationOrigin,
    true,
  );
  const issuedAt = requireTimestamp(options.nowMs ?? Date.now(), true);
  const expiresAt = issuedAt + PREAUTH_NONCE_LIFETIME_MS;
  requireTimestamp(expiresAt, true);

  // Separate randomBytes calls make the challenge and cookie nonces independent.
  const challengeNonce = randomBytes(NONCE_BYTES).toString("base64url");
  const cookieNonce = randomBytes(NONCE_BYTES).toString("base64url");
  const envelope: Envelope = {
    v: ENVELOPE_VERSION,
    p: PREAUTH_NONCE_PURPOSE,
    o: applicationOrigin,
    iat: issuedAt,
    exp: expiresAt,
    n: challengeNonce,
    c: cookieBinding(cookieNonce),
  };
  const payload = Buffer.from(serializeEnvelope(envelope), "utf8");
  const mac = computeMac(payload, macKey);

  return {
    challenge: `${payload.toString("base64url")}.${mac.toString("base64url")}`,
    cookieNonce,
  };
}

/**
 * Authenticates a stateless challenge. A successful result is deliberately not
 * proof of one-time use: durable, atomic consumption belongs in PostgreSQL.
 */
export function verifyPreauthNonce(
  options: VerifyPreauthNonceOptions,
): void {
  if (typeof options !== "object" || options === null) invalid();
  const macKey = requireMacKey(options.macKey);
  const applicationOrigin = requireCanonicalHttpsOrigin(
    options.applicationOrigin,
    true,
  );
  const requestOrigin = requireCanonicalHttpsOrigin(options.requestOrigin, false);
  const nowMs = requireTimestamp(options.nowMs ?? Date.now(), false);
  if (
    typeof options.challenge !== "string" ||
    options.challenge.length > MAX_CHALLENGE_LENGTH ||
    !CHALLENGE_PATTERN.test(options.challenge)
  ) {
    invalid();
  }

  const [encodedPayload, encodedMac] = options.challenge.split(".");
  const payload = Buffer.from(encodedPayload, "base64url");
  if (payload.toString("base64url") !== encodedPayload) invalid();
  const suppliedMac = decodeCanonicalBase64url(
    encodedMac,
    BASE64URL_256_PATTERN,
    MAC_BYTES,
  );
  const expectedMac = computeMac(payload, macKey);
  if (!timingSafeEqual(expectedMac, suppliedMac)) invalid();

  const envelope = parseEnvelope(payload);
  if (
    requestOrigin !== applicationOrigin ||
    envelope.o !== applicationOrigin ||
    envelope.exp - envelope.iat !== PREAUTH_NONCE_LIFETIME_MS ||
    nowMs < envelope.iat ||
    nowMs >= envelope.exp ||
    cookieBinding(options.cookieNonce) !== envelope.c
  ) {
    invalid();
  }
}
