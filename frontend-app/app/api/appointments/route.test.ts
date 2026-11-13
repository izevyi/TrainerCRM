import { describe, expect, it, vi } from "vitest";
import { TrainerAuthError } from "../../../lib/server/trainer-auth";
import { TrainerAppointmentError } from "../../../lib/server/trainer-appointments";
import { createAppointmentsHandlers } from "./handler";

const cookie = { cookie: "trainercrm_session=valid-token" };
const session = { trainerId: "t", tenantId: "n", emailIdentityId: "e", createdAt: "c", idleExpiresAt: "i", absoluteExpiresAt: "a" };
const clientId = "20000000-0000-4000-8000-000000000001";
const startsAt = "2026-12-01T10:00:00Z"; const endsAt = "2026-12-01T11:00:00Z";

describe("/api/appointments", () => {
  it("requires a session for reads and writes", async () => {
    const handlers = createAppointmentsHandlers(vi.fn(), vi.fn(), vi.fn());
    expect((await handlers.GET(new Request(`http://x/api/appointments?from=${startsAt}&to=${endsAt}`))).status).toBe(401);
    expect((await handlers.POST(new Request("http://x/api/appointments", { method: "POST", body: "{}" }))).status).toBe(401);
  });

  it("lists a bounded range using only the session bearer", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const { GET } = createAppointmentsHandlers(vi.fn().mockResolvedValue(session), list, vi.fn());
    const response = await GET(new Request(`http://x/api/appointments?from=${encodeURIComponent(startsAt)}&to=${encodeURIComponent(endsAt)}`, { headers: cookie }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ appointments: [] });
    expect(list).toHaveBeenCalledWith("valid-token", startsAt, endsAt);
  });

  it("preserves valid RFC3339 offsets when listing", async () => {
    const from = "2026-12-01T10:00:00+07:00"; const to = "2026-12-01T11:00:00+07:00";
    const list = vi.fn().mockResolvedValue([]);
    const { GET } = createAppointmentsHandlers(vi.fn().mockResolvedValue(session), list, vi.fn());
    const response = await GET(new Request(`http://x/api/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { headers: cookie }));
    expect(response.status).toBe(200); expect(list).toHaveBeenCalledWith("valid-token", from, to);
  });

  it.each([
    "?from=bad&to=2026-12-01T11:00:00Z",
    "?from=2026-12-02T11:00:00Z&to=2026-12-01T11:00:00Z",
    "?from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z",
    "?from=2026-12-01T00:00:00Z&to=2026-12-02T00:00:00Z&trainerId=x",
  ])("rejects invalid list range %s", async (queryString) => {
    const response = await createAppointmentsHandlers().GET(new Request(`http://x/api/appointments${queryString}`, { headers: cookie }));
    expect(response.status).toBe(400);
  });

  it.each(["0000-12-01T10:00:00Z", "2026-02-30T10:00:00Z"])(
    "rejects PostgreSQL-incompatible list timestamp %s before database access",
    async (from) => {
      const resolve = vi.fn().mockRejectedValue(new TrainerAuthError("UNAVAILABLE")); const list = vi.fn();
      const response = await createAppointmentsHandlers(resolve, list, vi.fn()).GET(new Request(
        `http://x/api/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(endsAt)}`,
        { headers: cookie },
      ));
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "INVALID_INPUT" });
      expect(resolve).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
    },
  );

  it("creates a validated appointment without owner selectors", async () => {
    const create = vi.fn().mockResolvedValue({ id: "a" });
    const { POST } = createAppointmentsHandlers(vi.fn().mockResolvedValue(session), vi.fn(), create);
    const response = await POST(new Request("http://x/api/appointments", { method: "POST", headers: cookie,
      body: JSON.stringify({ clientId, startsAt, endsAt }) }));
    expect(response.status).toBe(201); expect(create).toHaveBeenCalledWith("valid-token", clientId, startsAt, endsAt);
  });

  it.each([
    {}, { clientId: "bad", startsAt, endsAt }, { clientId, startsAt: endsAt, endsAt: startsAt },
    { clientId, startsAt, endsAt, trainerId: "attacker" },
  ])("rejects invalid creation %#", async (body) => {
    const create = vi.fn(); const { POST } = createAppointmentsHandlers(vi.fn().mockResolvedValue(session), vi.fn(), create);
    const response = await POST(new Request("http://x/api/appointments", { method: "POST", headers: cookie, body: JSON.stringify(body) }));
    expect(response.status).toBe(400); expect(create).not.toHaveBeenCalled();
  });

  it.each(["0000-12-01T10:00:00Z", "2026-02-30T10:00:00Z"])(
    "rejects PostgreSQL-incompatible creation timestamp %s before database access",
    async (invalidStartsAt) => {
      const resolve = vi.fn().mockRejectedValue(new TrainerAuthError("UNAVAILABLE")); const create = vi.fn();
      const response = await createAppointmentsHandlers(resolve, vi.fn(), create).POST(new Request(
        "http://x/api/appointments",
        { method: "POST", headers: cookie, body: JSON.stringify({ clientId, startsAt: invalidStartsAt, endsAt }) },
      ));
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "INVALID_INPUT" });
      expect(resolve).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    },
  );

  it("maps expired sessions, hidden targets, and conflicts", async () => {
    const expired = createAppointmentsHandlers(vi.fn().mockRejectedValue(new TrainerAuthError("UNAUTHORIZED")), vi.fn(), vi.fn());
    expect((await expired.GET(new Request(`http://x/api/appointments?from=${startsAt}&to=${endsAt}`, { headers: cookie }))).status).toBe(401);
    for (const [code, status] of [["NOT_FOUND", 404], ["CONFLICT", 409]] as const) {
      const handlers = createAppointmentsHandlers(vi.fn().mockResolvedValue(session), vi.fn(), vi.fn().mockRejectedValue(new TrainerAppointmentError(code)));
      const response = await handlers.POST(new Request("http://x/api/appointments", { method: "POST", headers: cookie, body: JSON.stringify({ clientId, startsAt, endsAt }) }));
      expect(response.status).toBe(status);
    }
  });
});
