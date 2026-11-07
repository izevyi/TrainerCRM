import { describe, expect, it, vi } from "vitest";
import { TrainerAuthError } from "../../../../lib/server/trainer-auth";
import { createLogoutHandler } from "./handler";

describe("POST /api/auth/logout", () => {
  it("revokes the session and clears the cookie without a body", async () => {
    const revokeTrainerSession = vi.fn().mockResolvedValue(undefined);
    const POST = createLogoutHandler(revokeTrainerSession);
    const response = await POST(new Request("http://localhost", { method: "POST", headers: { cookie: "trainercrm_session=token" } }));
    expect(response.status).toBe(204); expect(await response.text()).toBe("");
    expect(revokeTrainerSession).toHaveBeenCalledWith("token");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("is safe without a cookie and exposes no session data", async () => {
    const revokeTrainerSession = vi.fn();
    const POST = createLogoutHandler(revokeTrainerSession);
    const response = await POST(new Request("http://localhost", { method: "POST" }));
    expect(response.status).toBe(204); expect(revokeTrainerSession).not.toHaveBeenCalled();
  });
  it("does not revoke an ambiguous duplicate cookie and still clears it", async () => {
    const revokeTrainerSession = vi.fn();
    const POST = createLogoutHandler(revokeTrainerSession);
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      headers: { cookie: "trainercrm_session=first; trainercrm_session=second" },
    }));
    expect(response.status).toBe(204);
    expect(revokeTrainerSession).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it("clears the cookie on database failure without leaking details", async () => {
    const POST = createLogoutHandler(vi.fn().mockRejectedValue(new TrainerAuthError("UNAVAILABLE")));
    const response = await POST(new Request("http://localhost", { method: "POST", headers: { cookie: "trainercrm_session=secret" } }));
    expect(response.status).toBe(503); expect(await response.text()).toBe('{"error":"AUTH_UNAVAILABLE"}');
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
