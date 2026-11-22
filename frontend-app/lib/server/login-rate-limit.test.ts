import { describe, expect, it, vi } from "vitest";

import type { DatabaseQuery } from "./db";
import { TrainerAuthError } from "./trainer-auth";
import { allowLoginAttempt } from "./login-rate-limit";

const env = { NODE_ENV: "production", TRAINERCRM_LOGIN_RATE_SECRET: Buffer.alloc(32, 17).toString("base64url") };
const req = (address: string) => new Request("https://trainer-crm.ru/api/auth/login", {
  headers: { "x-forwarded-for": address },
});

function successQuery() {
  return vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ allowed: true }] });
}

describe("durable login limiter adapter", () => {
  it("sends only fixed-size HMAC digests, never an email, IP or password to SQL", async () => {
    const query = successQuery();
    await expect(allowLoginAttempt(req("203.0.113.10"), " Trainer@EXAMPLE.com ",
      query as unknown as DatabaseQuery, env)).resolves.toBe(true);
    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("authn.consume_trainer_login_attempt");
    expect(values).toHaveLength(2);
    for (const value of values as Buffer[]) { expect(Buffer.isBuffer(value)).toBe(true); expect(value).toHaveLength(32); }
    expect(values[0]).not.toEqual(values[1]);
    expect(JSON.stringify(query.mock.calls)).not.toContain("trainer@example.com");
    expect(JSON.stringify(query.mock.calls)).not.toContain("203.0.113.10");
  });

  it("uses the nearest trusted proxy address, not the first forwarded value", async () => {
    const query1 = successQuery();
    const query2 = successQuery();
    await allowLoginAttempt(req("198.51.100.1, 203.0.113.10"), "a@example.com", query1 as unknown as DatabaseQuery, env);
    await allowLoginAttempt(req("203.0.113.10"), "a@example.com", query2 as unknown as DatabaseQuery, env);
    expect(query1.mock.calls[0][1]).toEqual(query2.mock.calls[0][1]);
  });

  it("changes the pair digest by email, and the IP digest by IP", async () => {
    const q1 = successQuery(); const q2 = successQuery(); const q3 = successQuery();
    await allowLoginAttempt(req("203.0.113.10"), "a@example.com", q1 as unknown as DatabaseQuery, env);
    await allowLoginAttempt(req("203.0.113.10"), "b@example.com", q2 as unknown as DatabaseQuery, env);
    await allowLoginAttempt(req("203.0.113.11"), "a@example.com", q3 as unknown as DatabaseQuery, env);
    expect(q1.mock.calls[0][1][0]).toEqual(q2.mock.calls[0][1][0]);
    expect(q1.mock.calls[0][1][1]).not.toEqual(q2.mock.calls[0][1][1]);
    expect(q1.mock.calls[0][1][0]).not.toEqual(q3.mock.calls[0][1][0]);
  });

  it("fails closed if secret or a trusted production source IP is missing", async () => {
    const query = successQuery();
    await expect(allowLoginAttempt(req("203.0.113.10"), "a@example.com", query as unknown as DatabaseQuery,
      { NODE_ENV: "production" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(allowLoginAttempt(new Request("https://trainer-crm.ru/api/auth/login"), "a@example.com",
      query as unknown as DatabaseQuery, env)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(query).not.toHaveBeenCalled();
  });

  it("treats malformed addresses and database failures safely", async () => {
    const query = vi.fn().mockRejectedValue(new Error("secret database error"));
    await expect(allowLoginAttempt(req("203.0.113.10"), "a@example.com",
      query as unknown as DatabaseQuery, env)).rejects.toThrow();
    await expect(allowLoginAttempt(req("203.0.113.10"), "broken email",
      query as unknown as DatabaseQuery, env)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(new TrainerAuthError("UNAVAILABLE").message).toBe("UNAVAILABLE");
  });
});
