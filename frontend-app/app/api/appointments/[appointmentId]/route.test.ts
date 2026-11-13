import { describe, expect, it, vi } from "vitest";
import { TrainerAuthError } from "../../../../lib/server/trainer-auth";
import { TrainerAppointmentError } from "../../../../lib/server/trainer-appointments";
import { createAppointmentHandlers } from "./handler";

const cookie = { cookie: "trainercrm_session=valid-token" };
const id = "30000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ appointmentId: id }) };
const session = { trainerId: "t" };

describe("/api/appointments/[appointmentId]", () => {
  it("reschedules and cancels using the session and path id", async () => {
    const reschedule = vi.fn().mockResolvedValue({ id }); const cancel = vi.fn().mockResolvedValue({ id, status: "cancelled" });
    const handlers = createAppointmentHandlers(vi.fn().mockResolvedValue(session), reschedule, cancel);
    const patch = await handlers.PATCH(new Request("http://x", { method: "PATCH", headers: cookie,
      body: JSON.stringify({ startsAt: "2026-12-01T10:00:00Z", endsAt: "2026-12-01T11:00:00Z" }) }), context);
    const remove = await handlers.DELETE(new Request("http://x", { method: "DELETE", headers: cookie }), context);
    expect(patch.status).toBe(200); expect(remove.status).toBe(200);
    expect(reschedule.mock.calls[0][0]).toBe("valid-token"); expect(cancel).toHaveBeenCalledWith("valid-token", id);
  });

  it("does not expose malformed or foreign appointment existence", async () => {
    const handlers = createAppointmentHandlers(vi.fn().mockResolvedValue(session), vi.fn(), vi.fn().mockRejectedValue(new TrainerAppointmentError("NOT_FOUND")));
    const malformed = await handlers.DELETE(new Request("http://x", { method: "DELETE", headers: cookie }), { params: Promise.resolve({ appointmentId: "bad" }) });
    const foreign = await handlers.DELETE(new Request("http://x", { method: "DELETE", headers: cookie }), context);
    expect(malformed.status).toBe(404); expect(foreign.status).toBe(404);
    expect(await malformed.json()).toEqual(await foreign.json());
  });

  it("rejects extra ownership fields and invalid ranges", async () => {
    const reschedule = vi.fn(); const handlers = createAppointmentHandlers(vi.fn().mockResolvedValue(session), reschedule, vi.fn());
    const response = await handlers.PATCH(new Request("http://x", { method: "PATCH", headers: cookie,
      body: JSON.stringify({ startsAt: "2026-12-01T11:00:00Z", endsAt: "2026-12-01T10:00:00Z", trainerId: "x" }) }), context);
    expect(response.status).toBe(400); expect(reschedule).not.toHaveBeenCalled();
  });

  it.each(["0000-12-01T10:00:00Z", "2026-02-30T10:00:00Z"])(
    "rejects PostgreSQL-incompatible reschedule timestamp %s before database access",
    async (startsAt) => {
      const resolve = vi.fn().mockRejectedValue(new TrainerAuthError("UNAVAILABLE")); const reschedule = vi.fn();
      const handlers = createAppointmentHandlers(resolve, reschedule, vi.fn());
      const response = await handlers.PATCH(new Request("http://x", { method: "PATCH", headers: cookie,
        body: JSON.stringify({ startsAt, endsAt: "2026-12-01T11:00:00Z" }) }), context);
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "INVALID_INPUT" });
      expect(resolve).not.toHaveBeenCalled(); expect(reschedule).not.toHaveBeenCalled();
    },
  );
});
