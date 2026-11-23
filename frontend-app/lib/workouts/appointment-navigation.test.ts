import { describe, expect, it } from "vitest";
import { appointmentWorkoutFields, findAppointmentWorkout, type AppointmentWorkoutTarget } from "./appointment-navigation";
import type { Workout } from "./workout-api";

const clientId = "20000000-0000-4000-8000-000000000001";
const appointmentId = "30000000-0000-4000-8000-000000000002";
const target: AppointmentWorkoutTarget = { id: appointmentId, clientId, startsAt: new Date(2026, 10, 23, 9, 15).toISOString() };
const workout = (id: string, appointment: string | null, client = clientId): Workout => ({
  id, clientId: client, clientName: "Тест", appointmentId: appointment,
  date: "2026-11-23", time: "09:15:00", type: "Персональная тренировка", completed: false,
  caloriesBurned: null, exercises: [], createdAt: "2026-11-23T00:00:00Z", updatedAt: "2026-11-23T00:00:00Z",
});

describe("calendar → workout navigation", () => {
  it("prefills the linked appointment and local workout date/time", () => {
    expect(appointmentWorkoutFields(target)).toEqual({ appointmentId, date: "2026-11-23", time: "09:15" });
  });
  it("opens a linked workout and does not mistake an unlinked workout for it", () => {
    const unlinked = workout("unlinked", null);
    const linked = workout("linked", appointmentId);
    expect(findAppointmentWorkout([unlinked, linked], target)).toBe(linked);
    expect(findAppointmentWorkout([unlinked], target)).toBeUndefined();
  });
  it("rejects a workout whose client does not match the appointment", () => {
    expect(findAppointmentWorkout([workout("other", appointmentId, "different-client")], target)).toBeUndefined();
  });
});
