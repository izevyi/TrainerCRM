import { createHmac } from "node:crypto";
import { isIP } from "node:net";

import { queryDatabase, type DatabaseQuery } from "./db";
import { allowLoginAttempt } from "./login-rate-limit";

const DOMAIN = "trainercrm.registration-quota.v2";
type Environment = Readonly<Record<string, string | undefined>>;

// Quotas in migration 017: 5 per IP/hour, 3 per mailbox/day,
// 30 site-wide/day.  Every attempted signup counts, even a known email.
export async function allowRegistrationAttempt(
  request: Request,
  canonicalEmail: string,
  query: DatabaseQuery = queryDatabase,
  environment: Environment = process.env,
): Promise<boolean> {
  const encoded = environment.TRAINERCRM_LOGIN_RATE_SECRET;
  if (!encoded || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error("REGISTRATION_UNAVAILABLE");
  const secret = Buffer.from(encoded, "base64url");
  if (secret.length !== 32 || secret.toString("base64url") !== encoded) {
    throw new Error("REGISTRATION_UNAVAILABLE");
  }
  const candidate = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  const ip = candidate && isIP(candidate) ? candidate :
    environment.NODE_ENV === "production" ? null : "127.0.0.1";
  if (!ip) throw new Error("REGISTRATION_UNAVAILABLE");

  function hash(scope: string, value: string): Buffer {
    return createHmac("sha256", secret)
      .update(DOMAIN + "\0" + scope + "\0" + value, "utf8").digest();
  }
  const response = await query<{ allowed: boolean }>(
    "SELECT authn.consume_trainer_registration_attempt($1::bytea,$2::bytea,$3::bytea) AS allowed",
    [hash("ip", ip), hash("email", canonicalEmail), hash("global", "all")],
  );
  if (response.rowCount !== 1 || response.rows.length !== 1 ||
      typeof response.rows[0]?.allowed !== "boolean") {
    throw new Error("REGISTRATION_UNAVAILABLE");
  }
  return response.rows[0].allowed;
}

// Confirming a cryptographically random link does NOT send email. Retain the
// existing login-grade limiter for verification requests, separately scoped.
export async function allowRegistrationVerificationAttempt(
  request: Request,
  query: DatabaseQuery = queryDatabase,
  environment: Environment = process.env,
): Promise<boolean> {
  return allowLoginAttempt(request, "verify@trainer-crm.ru", query, environment);
}
