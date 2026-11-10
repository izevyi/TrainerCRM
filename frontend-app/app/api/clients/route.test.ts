import { describe, expect, it, vi } from "vitest";

import { TrainerAuthError } from "../../../lib/server/trainer-auth";
import { createClientsHandlers } from "./handler";

const session = { trainerId: "trainer", emailIdentityId: "email", tenantId: "tenant", createdAt: "c", idleExpiresAt: "i", absoluteExpiresAt: "a" };
const cookie = { cookie: "trainercrm_session=valid-token" };
const client = { id: "10000000-0000-4000-8000-000000000001", name: "Ирина", startingWeight: 72.5, createdAt: "2026-01-01T00:00:00.000Z" };

describe("/api/clients", () => {
  it("rejects unauthenticated GET and POST", async () => {
    const handlers = createClientsHandlers(vi.fn(), vi.fn(), vi.fn());
    const get = await handlers.GET(new Request("http://localhost/api/clients"));
    const post = await handlers.POST(new Request("http://localhost/api/clients", { method: "POST", body: "{}" }));
    expect(get.status).toBe(401);
    expect(post.status).toBe(401);
  });

  it("lists clients using only the session bearer", async () => {
    const resolve = vi.fn().mockResolvedValue(session);
    const list = vi.fn().mockResolvedValue([client]);
    const { GET } = createClientsHandlers(resolve, list, vi.fn());
    const response = await GET(new Request("http://localhost/api/clients", { headers: cookie }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ clients: [client] });
    expect(list).toHaveBeenCalledWith("valid-token");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("creates a validated client and ignores no owner selectors", async () => {
    const create = vi.fn().mockResolvedValue(client);
    const { POST } = createClientsHandlers(vi.fn().mockResolvedValue(session), vi.fn(), create);
    const response = await POST(new Request("http://localhost/api/clients", {
      method: "POST", headers: { ...cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "  Ирина  ", startingWeight: 72.5 }),
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ client });
    expect(create).toHaveBeenCalledWith("valid-token", "Ирина", 72.5);
  });

  it.each([
    {},
    { name: "", startingWeight: 70 },
    { name: "x".repeat(121), startingWeight: 70 },
    { name: "A", startingWeight: 0 },
    { name: "A", startingWeight: 1000.001 },
    { name: "A", startingWeight: 70.0001 },
    { name: "A", startingWeight: 70, trainerId: "attacker" },
  ])("rejects invalid input %#", async (body) => {
    const create = vi.fn();
    const { POST } = createClientsHandlers(vi.fn(), vi.fn(), create);
    const response = await POST(new Request("http://localhost/api/clients", {
      method: "POST", headers: cookie, body: JSON.stringify(body),
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_INPUT");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects revoked sessions before data access", async () => {
    const list = vi.fn();
    const { GET } = createClientsHandlers(
      vi.fn().mockRejectedValue(new TrainerAuthError("UNAUTHORIZED")), list, vi.fn(),
    );
    const response = await GET(new Request("http://localhost/api/clients", { headers: cookie }));
    expect(response.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects a session revoked between resolution and the database command", async () => {
    const { GET } = createClientsHandlers(
      vi.fn().mockResolvedValue(session),
      vi.fn().mockRejectedValue(new Error("UNAUTHORIZED")),
      vi.fn(),
    );
    const response = await GET(new Request("http://localhost/api/clients", { headers: cookie }));
    expect(response.status).toBe(401);
  });
});
