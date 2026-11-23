import { describe, expect, it } from "vitest";
import type { ServerAppointment } from "./appointment-api";
import { appointmentHistory } from "./appointment-history";

function appointment(id: string, startsAt: string, endsAt: string, status: "active" | "cancelled" = "active"): ServerAppointment {
  return { id, clientId: "client", startsAt, endsAt, status, cancelledAt: status === "cancelled" ? "2026-11-20T11:00:00.000Z" : null, createdAt: startsAt, updatedAt: startsAt };
}

describe("calendar appointment history", () => {
  const month = new Date(2026, 10, 1);
  const now = new Date("2026-11-23T09:00:00.000Z");

  it("shows cancelled appointments even when their scheduled time is in the future", () => {
    expect(appointmentHistory([appointment("c", "2026-11-28T09:00:00.000Z", "2026-11-28T10:00:00.000Z", "cancelled")], month, now))
      .toMatchObject([{ id: "c", historyStatus: "cancelled" }]);
  });

  it("treats elapsed active appointments as past, not completed", () => {
    const result = appointmentHistory([appointment("p", "2026-11-20T09:00:00.000Z", "2026-11-20T10:00:00.000Z")], month, now);
    expect(result).toMatchObject([{ id: "p", historyStatus: "past", status: "active" }]);
  });

  it("excludes active future and not-yet-ended appointments", () => {
    const items = [
      appointment("future", "2026-11-25T09:00:00.000Z", "2026-11-25T10:00:00.000Z"),
      appointment("ongoing", "2026-11-23T08:30:00.000Z", "2026-11-23T09:30:00.000Z"),
    ];
    expect(appointmentHistory(items, month, now)).toEqual([]);
  });

  it("shows only the displayed month and sorts newest first", () => {
    const items = [
      appointment("oct", "2026-10-31T12:00:00.000Z", "2026-10-31T13:00:00.000Z", "cancelled"),
      appointment("a", "2026-11-01T12:00:00.000Z", "2026-11-01T13:00:00.000Z", "cancelled"),
      appointment("b", "2026-11-22T12:00:00.000Z", "2026-11-22T13:00:00.000Z"),
      appointment("dec", "2026-12-01T12:00:00.000Z", "2026-12-01T13:00:00.000Z", "cancelled"),
    ];
    expect(appointmentHistory(items, month, now).map((item) => item.id)).toEqual(["b", "a"]);
  });
});
