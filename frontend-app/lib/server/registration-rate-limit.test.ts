import { describe, expect, it, vi } from "vitest";

import type { DatabaseQuery } from "./db";
import { allowRegistrationAttempt, allowRegistrationVerificationAttempt } from "./registration-rate-limit";

const env = {
  NODE_ENV: "production",
  TRAINERCRM_LOGIN_RATE_SECRET: Buffer.alloc(32, 42).toString("base64url"),
};
const request = (xff?: string) => new Request("https://trainer-crm.ru/api/auth/register", {
  headers: xff ? { "x-forwarded-for": xff } : {},
});
const db = () => vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ allowed: true }] });

describe("durable signup quotas", () => {
  it("uses separate HMAC buckets for IP, recipient and global quota", async () => {
    const q1 = db(); const q2 = db(); const q3 = db();
    expect(await allowRegistrationAttempt(request("192.0.2.10"), "one@example.test", q1 as unknown as DatabaseQuery, env)).toBe(true);
    await allowRegistrationAttempt(request("192.0.2.10"), "two@example.test", q2 as unknown as DatabaseQuery, env);
    await allowRegistrationAttempt(request("192.0.2.11"), "one@example.test", q3 as unknown as DatabaseQuery, env);
    const [sql, a] = q1.mock.calls[0];
    const b = q2.mock.calls[0][1];
    const c = q3.mock.calls[0][1];
    expect(sql).toContain("authn.consume_trainer_registration_attempt");
    expect(a).toHaveLength(3);
    for (const digest of a as Buffer[]) expect(digest).toHaveLength(32);
    expect(a[0]).toEqual(b[0]);
    expect(a[0]).not.toEqual(c[0]);
    expect(a[1]).not.toEqual(b[1]);
    expect(a[1]).toEqual(c[1]);
    expect(a[2]).toEqual(b[2]);
    expect(a[2]).toEqual(c[2]);
    expect(JSON.stringify(q1.mock.calls)).not.toContain("one@example.test");
  });
  it("uses the nearest proxy address and fails closed without a trusted production IP", async () => {
    const q1 = db(); const q2 = db();
    await allowRegistrationAttempt(request("198.51.100.20, 192.0.2.10"), "one@example.test", q1 as unknown as DatabaseQuery, env);
    await allowRegistrationAttempt(request("192.0.2.10"), "one@example.test", q2 as unknown as DatabaseQuery, env);
    expect(q1.mock.calls[0][1]).toEqual(q2.mock.calls[0][1]);
    await expect(allowRegistrationAttempt(request(), "one@example.test", q1 as unknown as DatabaseQuery, env)).rejects.toThrow("REGISTRATION_UNAVAILABLE");
    await expect(allowRegistrationAttempt(request("192.0.2.10"), "one@example.test", q1 as unknown as DatabaseQuery, { NODE_ENV: "production" })).rejects.toThrow("REGISTRATION_UNAVAILABLE");
  });
  it("fails closed on unexpected database result", async () => {
    const q = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(allowRegistrationAttempt(request("192.0.2.10"), "one@example.test", q as unknown as DatabaseQuery, env)).rejects.toThrow("REGISTRATION_UNAVAILABLE");
  });
  it("keeps verification on the separate existing login limiter", async () => {
    const q = db();
    expect(await allowRegistrationVerificationAttempt(request("192.0.2.10"), q as unknown as DatabaseQuery, env)).toBe(true);
    expect(q.mock.calls[0][0]).toContain("authn.consume_trainer_login_attempt");
    expect(q.mock.calls[0][1]).toHaveLength(2);
  });
});
