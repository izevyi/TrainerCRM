import { createHmac } from "node:crypto";
import { isIP } from "node:net";

import { queryDatabase, type DatabaseQuery } from "./db";

const DOMAIN = "trainercrm.registration-rate.v1";

export async function allowRegistrationAttempt(
  request: Request,
  canonicalEmail: string,
  query: DatabaseQuery = queryDatabase,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  const encoded = environment.TRAINERCRM_LOGIN_RATE_SECRET;
  if (!encoded || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error("REGISTRATION_UNAVAILABLE");
  const secret = Buffer.from(encoded, "base64url");
  if (secret.length !== 32 || secret.toString("base64url") !== encoded) {
    throw new Error("REGISTRATION_UNAVAILABLE");
  }
  const ipCandidate = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  const ip = ipCandidate && isIP(ipCandidate) ? ipCandidate :
    environment.NODE_ENV === "production" ? null : "127.0.0.1";
  if (!ip) throw new Error("REGISTRATION_UNAVAILABLE");
  function hash(scope: string, address: string): Buffer {
    return createHmac("sha256", secret)
      .update(DOMAIN + "\0" + scope + "\0" + address, "utf8").digest();
  }
  // Existing durable DB limiter: 30/min per IP, 5/min per IP+email.
  // Key domain separation keeps these buckets separate from login attempts.
  const response = await query<{ allowed: boolean }>(
    "SELECT authn.consume_trainer_login_attempt($1::bytea,$2::bytea) AS allowed",
    [hash("ip", ip), hash("ip-email", ip + "\0" + canonicalEmail)],
  );
  if (response.rowCount !== 1 || typeof response.rows[0]?.allowed !== "boolean") {
    throw new Error("REGISTRATION_UNAVAILABLE");
  }
  return response.rows[0].allowed;
}
