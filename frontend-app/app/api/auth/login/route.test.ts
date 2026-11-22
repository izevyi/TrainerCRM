import { beforeEach, describe, expect, it, vi } from "vitest";

import { LOGIN_BODY_MAX_BYTES, TrainerAuthError } from "../../../../lib/server/trainer-auth";
import { createLoginHandler } from "./handler";

const loginTrainer = vi.fn();
const rateLimit = vi.fn();
const POST = createLoginHandler(loginTrainer, rateLimit);

const trainer = {
  trainerId: "11111111-1111-4111-8111-111111111111",
  emailIdentityId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
  createdAt: "2026-11-01T00:00:00.000Z", idleExpiresAt: "2026-12-01T00:00:00.000Z",
  absoluteExpiresAt: "2027-05-01T00:00:00.000Z",
};
const request = (body: string) => new Request("http://localhost/api/auth/login", { method: "POST", body });

function streamingRequest(chunks: Uint8Array[], onCancel?: () => void, leaveOpen = false): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else if (!leaveOpen) controller.close();
    },
    cancel: onCancel,
  });
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    loginTrainer.mockReset();
    rateLimit.mockReset().mockResolvedValue(true);
    vi.unstubAllEnvs();
  });

  it("returns safe metadata and a bounded HttpOnly development cookie", async () => {
    loginTrainer.mockResolvedValue({ ...trainer, token: "x".repeat(43) });
    const response = await POST(request(JSON.stringify({ email: "Trainer@example.com", password: "secret" })));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/"); expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).not.toContain("Domain="); expect(cookie).not.toContain("Secure");
    expect(await response.json()).toEqual({ trainer });
  });

  it("adds Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    loginTrainer.mockResolvedValue({ ...trainer, token: "x".repeat(43) });
    const response = await POST(request(JSON.stringify({ email: "trainer@example.com", password: "secret" })));
    expect(response.headers.get("set-cookie")).toContain("; Secure");
  });

  it.each(["{", "[]", JSON.stringify({ email: "a@b.com" }), JSON.stringify({ email: "a@b.com", password: "x", extra: true })])
  ("rejects malformed input generically", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "INVALID_CREDENTIALS" });
    expect(loginTrainer).not.toHaveBeenCalled();
  });

  it("rejects oversized input", async () => {
    const response = await POST(request(JSON.stringify({ email: "a@b.com", password: "x".repeat(2_100) })));
    expect(response.status).toBe(401); expect(loginTrainer).not.toHaveBeenCalled();
  });

  it("enforces the cumulative byte limit across streamed chunks and cancels the body", async () => {
    const cancelled = vi.fn();
    const first = new Uint8Array(LOGIN_BODY_MAX_BYTES);
    const response = await POST(streamingRequest([first, new Uint8Array([1])], cancelled, true));

    expect(response.status).toBe(401);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(loginTrainer).not.toHaveBeenCalled();
  });

  it("reads a valid login split across multiple streamed chunks", async () => {
    loginTrainer.mockResolvedValue({ ...trainer, token: "x".repeat(43) });
    const encoded = new TextEncoder().encode(JSON.stringify({ email: "trainer@example.com", password: "secret" }));
    const response = await POST(streamingRequest([
      encoded.slice(0, 5),
      encoded.slice(5, 19),
      encoded.slice(19),
    ]));

    expect(response.status).toBe(200);
    expect(loginTrainer).toHaveBeenCalledWith("trainer@example.com", "secret");
  });

  it("does not distinguish wrong passwords and missing users", async () => {
    loginTrainer.mockRejectedValue(new TrainerAuthError("INVALID_CREDENTIALS"));
    const response = await POST(request(JSON.stringify({ email: "none@example.com", password: "wrong" })));
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "INVALID_CREDENTIALS" });
  });

  it("returns 429 without checking credentials once durable limit is reached", async () => {
    rateLimit.mockResolvedValue(false);
    const response = await POST(request(JSON.stringify({ email: "a@example.com", password: "secret" })));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({ error: "INVALID_CREDENTIALS" });
    expect(loginTrainer).not.toHaveBeenCalled();
  });

  it("fails closed if the durable limiter cannot access the database", async () => {
    rateLimit.mockRejectedValue(new Error("postgresql://private-database-url"));
    const response = await POST(request(JSON.stringify({ email: "a@example.com", password: "secret" })));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"AUTH_UNAVAILABLE"}');
    expect(loginTrainer).not.toHaveBeenCalled();
  });

  it("returns generic unavailable and leaks no secret", async () => {
    loginTrainer.mockRejectedValue(new Error("postgresql://admin:secret hash token"));
    const response = await POST(request(JSON.stringify({ email: "a@b.com", password: "secret" })));
    expect(response.status).toBe(503); expect(await response.text()).toBe('{"error":"AUTH_UNAVAILABLE"}');
  });
});
