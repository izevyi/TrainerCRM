import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import Home from "./page";
import { login, logout, verifySession } from "../lib/auth/client-auth";

const trainer = {
  trainerId: "11111111-1111-4111-8111-111111111111",
  emailIdentityId: "22222222-2222-4222-8222-222222222222",
  tenantId: "33333333-3333-4333-8333-333333333333",
  createdAt: "2026-11-09T00:00:00.000Z",
  idleExpiresAt: "2026-11-10T00:00:00.000Z",
  absoluteExpiresAt: "2026-12-09T00:00:00.000Z",
};

function fetchResponse(status: number, body?: unknown) {
  return vi.fn(async () => new Response(
    body === undefined ? null : JSON.stringify(body),
    { status, headers: body === undefined ? undefined : { "Content-Type": "application/json" } },
  )) as unknown as typeof fetch;
}

describe("trainer authentication page", () => {
  it("renders only a session-loading state before CRM content", () => {
    const html = renderToStaticMarkup(<Home />);

    expect(html).toContain("Проверяем сеанс");
    expect(html).not.toContain("Расписание");
    expect(html).not.toContain("Анна Петрова");
  });

  it("restores an authenticated session on refresh with same-origin cookies", async () => {
    const fetcher = fetchResponse(200, { trainer });

    await expect(verifySession(fetcher)).resolves.toEqual({ ok: true, trainer });
    expect(fetcher).toHaveBeenCalledWith("/api/auth/me", expect.objectContaining({
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    }));
  });

  it("treats an absent or expired session as unauthorized", async () => {
    await expect(verifySession(fetchResponse(401, { error: "UNAUTHORIZED" })))
      .resolves.toEqual({ ok: false, kind: "unauthorized" });
  });

  it("reports unavailable session verification", async () => {
    await expect(verifySession(fetchResponse(503, { error: "AUTH_UNAVAILABLE" })))
      .resolves.toEqual({ ok: false, kind: "unavailable" });
    await expect(verifySession(vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch))
      .resolves.toEqual({ ok: false, kind: "unavailable" });
  });

  it("logs in through the existing endpoint without putting credentials in the URL", async () => {
    const fetcher = fetchResponse(200, { trainer });

    await expect(login("trainer@example.test", "secret", fetcher))
      .resolves.toEqual({ ok: true, trainer });
    expect(fetcher).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ email: "trainer@example.test", password: "secret" }),
    }));
  });

  it.each([
    [401, "unauthorized"],
    [429, "rate-limited"],
    [503, "unavailable"],
  ] as const)("maps login HTTP %s to %s", async (status, kind) => {
    await expect(login("trainer@example.test", "wrong", fetchResponse(status, {})))
      .resolves.toEqual({ ok: false, kind });
  });

  it("maps a network login failure to unavailable", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    await expect(login("trainer@example.test", "secret", fetcher))
      .resolves.toEqual({ ok: false, kind: "unavailable" });
  });

  it("logs out through the existing endpoint with same-origin cookies", async () => {
    const fetcher = fetchResponse(204);

    await expect(logout(fetcher)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
  });

  it("reports a logout network failure without throwing", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    await expect(logout(fetcher)).resolves.toBe(false);
  });
});
