import { localDateTimeFields } from "../appointments/calendar-date";
import type { ServerAppointment } from "../appointments/appointment-api";
import type { Workout } from "./workout-api";

/** A server-owned appointment selected in the calendar. */
export type AppointmentWorkoutTarget = Readonly<Pick<ServerAppointment, "id" | "clientId" | "startsAt">>;

/** Reuse an existing linked workout; never guess a link from a matching date. */
export function findAppointmentWorkout(workouts: readonly Workout[], target: AppointmentWorkoutTarget): Workout | undefined {
  return workouts.find((workout) => workout.appointmentId === target.id && workout.clientId === target.clientId);
}

/** Appointments use instants; workout date/time fields use the browser's local time. */
export function appointmentWorkoutFields(target: AppointmentWorkoutTarget) {
  const { date, time } = localDateTimeFields(target.startsAt);
  return { appointmentId: target.id, date, time };
}
