import { describe, expect, it, vi } from "vitest";
import { TrainerAuthError } from "../../../../lib/server/trainer-auth";
import { createMeHandler } from "./handler";

describe("GET /api/auth/me", () => {
  it("returns only resolved trainer metadata with no-store", async () => {
    const trainer = { trainerId: "t", emailIdentityId: "e", tenantId: "n", createdAt: "c", idleExpiresAt: "i", absoluteExpiresAt: "a" };
    const GET = createMeHandler(vi.fn().mockResolvedValue(trainer));
    const response = await GET(new Request("http://localhost", { headers: { cookie: "trainercrm_session=valid" } }));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ trainer });
  });
  it("rejects missing and invalid sessions without trainer data", async () => {
    const GET = createMeHandler(vi.fn().mockRejectedValue(new TrainerAuthError("UNAUTHORIZED")));
    let response = await GET(new Request("http://localhost"));
    expect(response.status).toBe(401); expect(await response.text()).not.toContain("trainerId");
    response = await GET(new Request("http://localhost", { headers: { cookie: "trainercrm_session=bad" } }));
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
  });
  it("rejects ambiguous duplicate session cookies without resolving either token", async () => {
    const resolve = vi.fn();
    const GET = createMeHandler(resolve);
    const response = await GET(new Request("http://localhost", {
      headers: { cookie: "trainercrm_session=first; trainercrm_session=second" },
    }));
    expect(response.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });
  it("conceals database errors", async () => {
    const GET = createMeHandler(vi.fn().mockRejectedValue(new TrainerAuthError("UNAVAILABLE")));
    const response = await GET(new Request("http://localhost", { headers: { cookie: "trainercrm_session=secret" } }));
    expect(response.status).toBe(503); expect(await response.text()).toBe('{"error":"AUTH_UNAVAILABLE"}');
  });
});
