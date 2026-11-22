import { describe, expect, it, vi } from "vitest";
import { TrainerAuthError } from "../../../../../lib/server/trainer-auth";
import { TrainerWeightError } from "../../../../../lib/server/trainer-weights";
import { createWeightHandlers } from "./handler";

const clientId = "10000000-0000-4000-8000-000000000001";
const measurementId = "20000000-0000-4000-8000-000000000001";
const ctx = { params: Promise.resolve({ clientId }) };
const cookie = { cookie: "trainercrm_session=fake-unit-session" };
const url = `https://trainer-crm.ru/api/clients/${clientId}/weights`;
const request = (method: string, body?: unknown, headers: Record<string, string> = cookie) => new Request(url, {
  method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const data = { id: measurementId, date: "2026-11-22", weight: 75.5, createdAt: "2026-11-22T00:00:00Z" };
const handlers = (resolve = vi.fn().mockResolvedValue({}), list = vi.fn().mockResolvedValue([data]),
  save = vi.fn().mockResolvedValue(data), remove = vi.fn().mockResolvedValue(undefined)) =>
  createWeightHandlers(resolve, list, save, remove);

describe("/api/clients/[clientId]/weights", () => {
  it("requires authentication on every method", async () => {
    const routes = handlers();
    for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
      const response = await routes[method](request(method, undefined, {}), ctx);
      expect(response.status).toBe(401);
    }
  });
  it("lists scoped measurements and disables caching", async () => {
    const list = vi.fn().mockResolvedValue([data]);
    const routes = handlers(undefined, list);
    const response = await routes.GET(request("GET"), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ measurements: [data] });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(list).toHaveBeenCalledWith("fake-unit-session", clientId);
  });
  it("validates create/update/delete and never accepts a trainer id", async () => {
    const save = vi.fn().mockResolvedValue(data);
    const remove = vi.fn();
    const routes = handlers(undefined, undefined, save, remove);
    expect((await routes.POST(request("POST", { date: "2026-02-30", weight: 75 }), ctx)).status).toBe(400);
    expect((await routes.POST(request("POST", { date: "2026-11-22", weight: 75, trainerId: clientId }), ctx)).status).toBe(400);
    expect((await routes.POST(request("POST", { date: "2026-11-22", weight: 75.1234 }), ctx)).status).toBe(400);
    expect(save).not.toHaveBeenCalled();
    expect((await routes.POST(request("POST", { date: "2026-11-22", weight: 75.5 }), ctx)).status).toBe(201);
    expect(save).toHaveBeenCalledWith("fake-unit-session", clientId, "2026-11-22", 75.5);
    expect((await routes.PUT(request("PUT", { id: measurementId, date: "2026-11-23", weight: 75 }), ctx)).status).toBe(200);
    expect(save).toHaveBeenCalledWith("fake-unit-session", clientId, "2026-11-23", 75, measurementId);
    expect((await routes.DELETE(request("DELETE", { id: measurementId }), ctx)).status).toBe(200);
    expect(remove).toHaveBeenCalledWith("fake-unit-session", clientId, measurementId);
  });
  it("rejects expired session, foreign client and conflicting dates", async () => {
    const revoked = handlers(vi.fn().mockRejectedValue(new TrainerAuthError("UNAUTHORIZED")));
    expect((await revoked.GET(request("GET"), ctx)).status).toBe(401);
    const foreign = handlers(undefined, vi.fn().mockRejectedValue(new TrainerWeightError("NOT_FOUND")));
    expect((await foreign.GET(request("GET"), ctx)).status).toBe(404);
    const conflict = handlers(undefined, undefined, vi.fn().mockRejectedValue(new TrainerWeightError("CONFLICT")));
    expect((await conflict.POST(request("POST", { date: "2026-11-22", weight: 75 }), ctx)).status).toBe(409);
  });
  it("hides database errors", async () => {
    const broken = handlers(undefined, vi.fn().mockRejectedValue(new Error("private database info")));
    const response = await broken.GET(request("GET"), ctx);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private database info");
  });
});
