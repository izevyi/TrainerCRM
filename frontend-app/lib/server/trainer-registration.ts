import { normalizeEmailV1 } from "../auth/email-invitations";
import { hashTrainerPassword } from "../auth/trainer-password";
import { digestRegistrationToken, makeRegistrationToken, validRegistrationPassword } from "../registration/registration-token";
import { queryDatabase, type DatabaseQuery } from "./db";

export class RegistrationError extends Error {
  constructor(readonly code: "INVALID" | "UNAVAILABLE") {
    super(code);
    this.name = "RegistrationError";
  }
}

export type RegistrationTicket = Readonly<{ email: string; token: string }>|null;

export async function beginTrainerRegistration(
  email: string,
  password: string,
  query: DatabaseQuery = queryDatabase,
): Promise<RegistrationTicket> {
  let canonical: string;
  try {
    canonical = normalizeEmailV1(email);
    if (!validRegistrationPassword(password)) throw new Error("PASSWORD_INVALID");
  } catch { throw new RegistrationError("INVALID"); }

  try {
    const passwordHash = await hashTrainerPassword(password);
    const token = makeRegistrationToken();
    const result = await query<{ created: boolean }>(
      "SELECT authn.begin_trainer_registration($1::text,$2::text,$3::bytea) AS created",
      [canonical,passwordHash,digestRegistrationToken(token)],
    );
    if (result.rowCount !== 1 || typeof result.rows[0]?.created !== "boolean") {
      throw new Error("REGISTRATION_DB_RESULT_INVALID");
    }
    return result.rows[0].created ? { email: canonical, token } : null;
  } catch { throw new RegistrationError("UNAVAILABLE"); }
}

export async function verifyTrainerRegistration(
  token: string,
  query: DatabaseQuery = queryDatabase,
): Promise<boolean> {
  let digest: Buffer;
  try { digest = digestRegistrationToken(token); }
  catch { throw new RegistrationError("INVALID"); }
  try {
    const result = await query<{ trainer_id: string; tenant_id: string }>(
      "SELECT trainer_id,tenant_id FROM authn.complete_trainer_registration($1::bytea)",
      [digest],
    );
    return result.rowCount === 1 && !!result.rows[0]?.trainer_id && !!result.rows[0]?.tenant_id;
  } catch { throw new RegistrationError("UNAVAILABLE"); }
}
