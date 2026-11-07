import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashTrainerPassword } from "../auth/trainer-password";
import { generateTrainerSessionToken } from "../auth/trainer-session-token";
import type { DatabaseQuery } from "./db";
import {
  TrainerAuthError,
  consumeLoginAttempt,
  loginTrainer,
  resetLoginAttemptsForTests,
  resolveTrainerSession,
  revokeTrainerSession,
} from "./trainer-auth";

const IDs = {
  trainer: "11111111-1111-4111-8111-111111111111",
  identity: "22222222-2222-4222-8222-222222222222",
  tenant: "33333333-3333-4333-8333-333333333333",
  session: "44444444-4444-4444-8444-444444444444",
};
const changedAt = "2026-11-01T00:00:00.000Z";

function sessionRow() {
  return {
    session_id: IDs.session, trainer_subject_id: IDs.trainer,
    email_identity_id: IDs.identity, tenant_id: IDs.tenant,
    created_at: changedAt, idle_expires_at: "2026-12-01T00:00:00.000Z",
    absolute_expires_at: "2027-05-01T00:00:00.000Z",
  };
}

describe("trainer authentication service", () => {
  beforeEach(resetLoginAttemptsForTests);

  it("verifies the password before creating a parameterized digest-only session", async () => {
    const passwordHash = await hashTrainerPassword("correct horse");
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        trainer_subject_id: IDs.trainer, email_identity_id: IDs.identity,
        tenant_id: IDs.tenant, password_hash: passwordHash,
        password_changed_at: changedAt,
      }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [sessionRow()] }) as unknown as DatabaseQuery;

    const result = await loginTrainer(" Trainer@EXAMPLE.com ", "correct horse", query);

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.trainerId).toBe(IDs.trainer);
    expect(query).toHaveBeenNthCalledWith(1,
      "SELECT * FROM authn.resolve_trainer_password($1::text)", ["trainer@example.com"]);
    expect(query).toHaveBeenNthCalledWith(2,
      "SELECT * FROM authn.create_trainer_session($1::uuid, $2::timestamptz, $3::bytea)",
      [IDs.trainer, changedAt, expect.any(Buffer)]);
    expect((query as unknown as ReturnType<typeof vi.fn>).mock.calls[1][2]).toBeUndefined();
  });

  it("uses a generic failure and never creates a session for a wrong password", async () => {
    const passwordHash = await hashTrainerPassword("right password");
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{
      trainer_subject_id: IDs.trainer, email_identity_id: IDs.identity,
      tenant_id: IDs.tenant, password_hash: passwordHash, password_changed_at: changedAt,
    }] }) as unknown as DatabaseQuery;
    await expect(loginTrainer("trainer@example.com", "wrong", query))
      .rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("collapses absent users and malformed email to invalid credentials", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) as unknown as DatabaseQuery;
    await expect(loginTrainer("nobody@example.com", "password", query))
      .rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(loginTrainer("bad email", "password", query))
      .rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("maps database errors to unavailable without leaking their message", async () => {
    const query = vi.fn().mockRejectedValue(new Error("postgresql://secret hash token")) as unknown as DatabaseQuery;
    const error = await loginTrainer("trainer@example.com", "password", query).catch((value) => value);
    expect(error).toBeInstanceOf(TrainerAuthError);
    expect(error).toMatchObject({ code: "UNAVAILABLE", message: "UNAVAILABLE" });
  });

  it("bounds local login attempts", () => {
    for (let count = 0; count < 5; count += 1) expect(consumeLoginAttempt("key", 1)).toBe(true);
    expect(consumeLoginAttempt("key", 1)).toBe(false);
    expect(consumeLoginAttempt("key", 60_001)).toBe(true);
  });

  it("resolves valid sessions and rejects invalid, expired or malformed ones", async () => {
    const token = generateTrainerSessionToken();
    const valid = vi.fn().mockResolvedValue({ rowCount: 1, rows: [sessionRow()] }) as unknown as DatabaseQuery;
    await expect(resolveTrainerSession(token, valid)).resolves.toMatchObject({ trainerId: IDs.trainer });
    expect((valid as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1][0]).toBeInstanceOf(Buffer);

    const expired = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) as unknown as DatabaseQuery;
    await expect(resolveTrainerSession(token, expired)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(resolveTrainerSession("malformed", valid)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("revokes using only a token digest", async () => {
    const token = generateTrainerSessionToken();
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ revoked: true }] }) as unknown as DatabaseQuery;
    await revokeTrainerSession(token, query);
    expect(query).toHaveBeenCalledWith(
      "SELECT authn.revoke_trainer_session($1::bytea) AS revoked", [expect.any(Buffer)]);
    expect(JSON.stringify((query as unknown as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(token);
  });
});
