import { createHmac } from "node:crypto";
import { isIP } from "node:net";

import { normalizeEmailV1 } from "../auth/email-invitations";
import { queryDatabase, type DatabaseQuery } from "./db";
import { TrainerAuthError } from "./trainer-auth";

const DOMAIN = "trainercrm.login-rate-limit.v1";
const SECRET_BYTES = 32;

type Environment = Readonly<Record<string, string | undefined>>;

function readSecret(environment: Environment): Buffer {
  const encoded = environment.TRAINERCRM_LOGIN_RATE_SECRET;
  if (!encoded || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new TrainerAuthError("UNAVAILABLE");
  }
  const secret = Buffer.from(encoded, "base64url");
  if (secret.length !== SECRET_BYTES || secret.toString("base64url") !== encoded) {
    throw new TrainerAuthError("UNAVAILABLE");
  }
  return secret;
}

function clientIp(request: Request, environment: Environment): string {
  // Deployment requirement: Next.js must be accessible only behind Caddy,
  // which must overwrite X-Forwarded-For with a trusted client address.
  // The final element is the nearest proxy-provided address, not the first
  // (potentially client-supplied) element.
  const forwarded = request.headers.get("x-forwarded-for");
  const candidate = forwarded?.split(",").at(-1)?.trim();
  if (candidate && isIP(candidate)) return candidate;
  if (environment.NODE_ENV !== "production") return "127.0.0.1";
  throw new TrainerAuthError("UNAVAILABLE");
}

function digest(secret: Buffer, scope: string, address: string, email = ""): Buffer {
  return createHmac("sha256", secret)
    .update(DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(scope, "utf8")
    .update("\0", "utf8")
    .update(address, "utf8")
    .update("\0", "utf8")
    .update(email, "utf8")
    .digest();
}

export async function allowLoginAttempt(
  request: Request,
  email: string,
  query: DatabaseQuery = queryDatabase,
  environment: Environment = process.env,
): Promise<boolean> {
  let canonical: string;
  try {
    canonical = normalizeEmailV1(email);
  } catch {
    throw new TrainerAuthError("INVALID_CREDENTIALS");
  }
  const secret = readSecret(environment);
  const address = clientIp(request, environment);
  const result = await query<{ allowed: boolean }>(
    "SELECT authn.consume_trainer_login_attempt($1::bytea, $2::bytea) AS allowed",
    [digest(secret, "ip", address), digest(secret, "ip-email", address, canonical)],
  );
  if (result.rowCount !== 1 || result.rows.length !== 1 ||
      typeof result.rows[0].allowed !== "boolean") {
    throw new TrainerAuthError("UNAVAILABLE");
  }
  return result.rows[0].allowed;
}
