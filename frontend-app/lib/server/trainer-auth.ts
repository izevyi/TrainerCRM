import { normalizeEmailV1 } from "../auth/email-invitations";
import { verifyTrainerPassword } from "../auth/trainer-password";
import {
  digestTrainerSessionToken,
  generateTrainerSessionToken,
} from "../auth/trainer-session-token";
import { queryDatabase, type DatabaseQuery } from "./db";

export const TRAINER_SESSION_COOKIE = "trainercrm_session";
export const TRAINER_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const LOGIN_BODY_MAX_BYTES = 2_048;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PasswordRow = {
  trainer_subject_id: string;
  email_identity_id: string;
  tenant_id: string;
  password_hash: string;
  password_changed_at: string;
};

type SessionRow = {
  session_id: string;
  trainer_subject_id: string;
  email_identity_id: string;
  tenant_id: string;
  created_at: Date | string;
  idle_expires_at: Date | string;
  absolute_expires_at: Date | string;
};

export type TrainerSession = {
  trainerId: string;
  emailIdentityId: string;
  tenantId: string;
  createdAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
};

export type TrainerLoginResult = TrainerSession & { token: string };

export class TrainerAuthError extends Error {
  constructor(readonly code: "INVALID_CREDENTIALS" | "UNAUTHORIZED" | "RATE_LIMITED" | "UNAVAILABLE") {
    super(code);
    this.name = "TrainerAuthError";
  }
}

function iso(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapSession(row: SessionRow): TrainerSession | null {
  const createdAt = iso(row.created_at);
  const idleExpiresAt = iso(row.idle_expires_at);
  const absoluteExpiresAt = iso(row.absolute_expires_at);
  if (
    !UUID.test(row.session_id) ||
    !UUID.test(row.trainer_subject_id) ||
    !UUID.test(row.email_identity_id) ||
    !UUID.test(row.tenant_id) ||
    !createdAt || !idleExpiresAt || !absoluteExpiresAt
  ) return null;
  return {
    trainerId: row.trainer_subject_id,
    emailIdentityId: row.email_identity_id,
    tenantId: row.tenant_id,
    createdAt,
    idleExpiresAt,
    absoluteExpiresAt,
  };
}

export async function loginTrainer(
  email: string,
  password: string,
  query: DatabaseQuery = queryDatabase,
): Promise<TrainerLoginResult> {
  let canonicalEmail: string;
  try {
    canonicalEmail = normalizeEmailV1(email);
  } catch {
    throw new TrainerAuthError("INVALID_CREDENTIALS");
  }

  try {
    const resolved = await query<PasswordRow>(
      `SELECT trainer_subject_id, email_identity_id, tenant_id, password_hash,
              password_changed_at::text AS password_changed_at
         FROM authn.resolve_trainer_password($1::text)`,
      [canonicalEmail],
    );
    if (resolved.rowCount !== 1 || resolved.rows.length !== 1) {
      throw new TrainerAuthError("INVALID_CREDENTIALS");
    }
    const trainer = resolved.rows[0];
    if (
      !UUID.test(trainer.trainer_subject_id) ||
      !UUID.test(trainer.email_identity_id) ||
      !UUID.test(trainer.tenant_id) ||
      typeof trainer.password_hash !== "string" ||
      !iso(trainer.password_changed_at) ||
      !(await verifyTrainerPassword(password, trainer.password_hash))
    ) throw new TrainerAuthError("INVALID_CREDENTIALS");

    const token = generateTrainerSessionToken();
    const created = await query<SessionRow>(
      "SELECT * FROM authn.create_trainer_session($1::uuid, $2::timestamptz, $3::bytea)",
      [trainer.trainer_subject_id, trainer.password_changed_at, digestTrainerSessionToken(token)],
    );
    const session = created.rowCount === 1 && created.rows.length === 1
      ? mapSession(created.rows[0])
      : null;
    if (!session) throw new TrainerAuthError("UNAVAILABLE");
    return { ...session, token };
  } catch (error) {
    if (error instanceof TrainerAuthError) throw error;
    throw new TrainerAuthError("UNAVAILABLE");
  }
}

export async function resolveTrainerSession(
  token: string,
  query: DatabaseQuery = queryDatabase,
): Promise<TrainerSession> {
  let digest: Buffer;
  try { digest = digestTrainerSessionToken(token); }
  catch { throw new TrainerAuthError("UNAUTHORIZED"); }
  try {
    const result = await query<SessionRow>(
      "SELECT * FROM authn.resolve_trainer_session($1::bytea)",
      [digest],
    );
    const session = result.rowCount === 1 && result.rows.length === 1
      ? mapSession(result.rows[0])
      : null;
    if (!session) throw new TrainerAuthError("UNAUTHORIZED");
    return session;
  } catch (error) {
    if (error instanceof TrainerAuthError) throw error;
    throw new TrainerAuthError("UNAVAILABLE");
  }
}

export async function revokeTrainerSession(
  token: string,
  query: DatabaseQuery = queryDatabase,
): Promise<void> {
  let digest: Buffer;
  try { digest = digestTrainerSessionToken(token); }
  catch { throw new TrainerAuthError("UNAUTHORIZED"); }
  try {
    await query<{ revoked: boolean }>(
      "SELECT authn.revoke_trainer_session($1::bytea) AS revoked",
      [digest],
    );
  } catch {
    throw new TrainerAuthError("UNAVAILABLE");
  }
}
