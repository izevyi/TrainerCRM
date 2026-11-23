import type { ServerAppointment } from "./appointment-api";

/** A past appointment has ended by the clock, not necessarily been completed. */
export type HistoryFilter = "all" | "past" | "cancelled";
export type HistoryAppointment = ServerAppointment & { historyStatus: "past" | "cancelled" };

/** Only appointments beginning in the displayed browser-local calendar month are shown. */
export function appointmentHistory(
  appointments: readonly ServerAppointment[],
  month: Date,
  now: Date,
): HistoryAppointment[] {
  return appointments.flatMap((item): HistoryAppointment[] => {
    const starts = new Date(item.startsAt);
    if (starts.getFullYear() !== month.getFullYear() || starts.getMonth() !== month.getMonth()) return [];
    if (item.status === "cancelled") return [{ ...item, historyStatus: "cancelled" }];
    if (item.status === "active" && new Date(item.endsAt).getTime() <= now.getTime()) {
      return [{ ...item, historyStatus: "past" }];
    }
    return [];
  }).sort((a, b) => b.startsAt.localeCompare(a.startsAt) || a.id.localeCompare(b.id));
}
