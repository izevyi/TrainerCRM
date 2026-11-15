import { describe, expect, it, vi } from "vitest";
import { cancelAppointment, createAppointment, listAppointments, rescheduleAppointment } from "./appointment-api";

const appointment = { id: "30000000-0000-4000-8000-000000000001", clientId: "20000000-0000-4000-8000-000000000001", clientName: "Анна", startsAt: "2026-11-13T02:00:00.000Z", endsAt: "2026-11-13T03:00:00.000Z", status: "active" as const, cancelledAt: null, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" };
function responder(status: number, body: unknown) { return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch; }

describe("appointment browser API", () => {
  it("lists through encoded half-open range parameters", async () => {
    const fetcher = responder(200, { appointments: [appointment] });
    await expect(listAppointments("2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z", fetcher)).resolves.toEqual({ ok: true, value: [appointment] });
    expect(vi.mocked(fetcher).mock.calls[0][0]).toContain("from=2026-11-01T00%3A00%3A00.000Z");
    expect(vi.mocked(fetcher).mock.calls[0][1]).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
  });

  it("creates and reschedules only with client UUID and RFC3339 timestamps", async () => {
    const create = responder(201, { appointment });
    await createAppointment(appointment.clientId, appointment.startsAt, appointment.endsAt, create);
    expect(JSON.parse(String(vi.mocked(create).mock.calls[0][1]?.body))).toEqual({ clientId: appointment.clientId, startsAt: appointment.startsAt, endsAt: appointment.endsAt });
    expect(String(vi.mocked(create).mock.calls[0][1]?.body)).not.toMatch(/trainerId|tenantId/);
    const patch = responder(200, { appointment });
    const movedStart = "2027-01-01T22:30:00.000Z"; const movedEnd = "2027-01-02T00:30:00.000Z";
    await rescheduleAppointment(appointment.id, movedStart, movedEnd, patch);
    expect(vi.mocked(patch).mock.calls[0][1]).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(vi.mocked(patch).mock.calls[0][1]?.body))).toEqual({ startsAt: movedStart, endsAt: movedEnd });
  });

  it("cancels via DELETE and accepts the cancelled server status", async () => {
    const cancelled = { ...appointment, status: "cancelled" as const, cancelledAt: "2026-11-13T01:00:00.000Z" };
    const fetcher = responder(200, { appointment: cancelled });
    await expect(cancelAppointment(appointment.id, fetcher)).resolves.toEqual({ ok: true, value: cancelled });
    expect(vi.mocked(fetcher).mock.calls[0][1]).toMatchObject({ method: "DELETE" });
  });

  it.each([[400, "validation"], [401, "unauthorized"], [403, "unauthorized"], [404, "not-found"], [409, "conflict"], [503, "unavailable"]] as const)("maps HTTP %s to %s", async (status, kind) => {
    await expect(createAppointment(appointment.clientId, appointment.startsAt, appointment.endsAt, responder(status, {}))).resolves.toEqual({ ok: false, kind });
  });

  it("distinguishes network, abort, and malformed responses", async () => {
    const network = vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    await expect(listAppointments(appointment.startsAt, appointment.endsAt, network)).resolves.toEqual({ ok: false, kind: "network" });
    const controller = new AbortController(); controller.abort();
    await expect(listAppointments(appointment.startsAt, appointment.endsAt, network, controller.signal)).resolves.toEqual({ ok: false, kind: "aborted" });
    await expect(listAppointments(appointment.startsAt, appointment.endsAt, responder(200, { appointments: [{ id: 1 }] }))).resolves.toEqual({ ok: false, kind: "unavailable" });
  });
});
