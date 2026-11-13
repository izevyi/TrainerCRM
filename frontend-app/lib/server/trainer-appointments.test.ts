import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  cancelTrainerAppointment, createTrainerAppointment, listTrainerAppointments,
  rescheduleTrainerAppointment, TrainerAppointmentError,
} from "./trainer-appointments";

const token = Buffer.alloc(32, 7).toString("base64url");
const digest = createHash("sha256").update(Buffer.alloc(32, 7)).digest();
const row = {
  appointment_id: "30000000-0000-4000-8000-000000000001",
  client_id: "20000000-0000-4000-8000-000000000001", client_name: "Alice",
  starts_at: "2026-12-01T10:00:00Z", ends_at: "2026-12-01T11:00:00Z",
  appointment_status: "active" as const, cancelled_at: null,
  created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
};

describe("trainer appointment database adapter", () => {
  it("lists through a parameterized session-bound function", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [row] });
    const result = await listTrainerAppointments(token, "2026-12-01T00:00:00Z", "2026-12-02T00:00:00Z", query);
    expect(result[0]).toMatchObject({ clientName: "Alice", status: "active" });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("$1::bytea"), [digest, "2026-12-01T00:00:00Z", "2026-12-02T00:00:00Z"]);
  });

  it("passes no browser-supplied owner identifiers to commands", async () => {
    const commandRow = { ...row, id: row.appointment_id, appointment_id: undefined, status: "active", appointment_status: undefined };
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [commandRow] });
    await createTrainerAppointment(token, row.client_id, row.starts_at, row.ends_at, query);
    await rescheduleTrainerAppointment(token, row.appointment_id, row.starts_at, row.ends_at, query);
    await cancelTrainerAppointment(token, row.appointment_id, query);
    expect(query.mock.calls.map((call) => call[1].length)).toEqual([4, 4, 2]);
    expect(query.mock.calls.every((call) => call[1][0].equals(digest))).toBe(true);
  });

  it.each([
    ["UNAUTHORIZED", "UNAUTHORIZED"], ["APPOINTMENT_NOT_FOUND", "NOT_FOUND"],
    ["APPOINTMENT_CONFLICT", "CONFLICT"], ["APPOINTMENT_INPUT_INVALID", "INVALID_INPUT"],
  ])("maps safe database error %s", async (message, code) => {
    const query = vi.fn().mockRejectedValue(new Error(message));
    await expect(cancelTrainerAppointment(token, row.appointment_id, query))
      .rejects.toMatchObject({ code } as Partial<TrainerAppointmentError>);
  });
});
