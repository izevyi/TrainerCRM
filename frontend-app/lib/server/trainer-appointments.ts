import { digestTrainerSessionToken } from "../auth/trainer-session-token";
import { queryDatabase, type DatabaseQuery } from "./db";

export type AppointmentStatus = "active" | "cancelled";
export type TrainerAppointment = {
  id: string;
  clientId: string;
  clientName?: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type AppointmentRow = {
  appointment_id?: string;
  id?: string;
  client_id: string;
  client_name?: string;
  starts_at: Date | string;
  ends_at: Date | string;
  status?: AppointmentStatus;
  appointment_status?: AppointmentStatus;
  cancelled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export class TrainerAppointmentError extends Error {
  constructor(readonly code: "UNAUTHORIZED" | "NOT_FOUND" | "CONFLICT" | "INVALID_INPUT" | "UNAVAILABLE") {
    super(code);
    this.name = "TrainerAppointmentError";
  }
}

function timestamp(value: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (Number.isNaN(Date.parse(result))) throw new Error("INVALID_APPOINTMENT_ROW");
  return result;
}

function mapAppointment(row: AppointmentRow): TrainerAppointment {
  const id = row.appointment_id ?? row.id;
  const status = row.appointment_status ?? row.status;
  if (!id || (status !== "active" && status !== "cancelled")) {
    throw new Error("INVALID_APPOINTMENT_ROW");
  }
  return {
    id,
    clientId: row.client_id,
    ...(row.client_name === undefined ? {} : { clientName: row.client_name }),
    startsAt: timestamp(row.starts_at),
    endsAt: timestamp(row.ends_at),
    status,
    cancelledAt: row.cancelled_at === null ? null : timestamp(row.cancelled_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function translate(error: unknown): never {
  const message = (error as { message?: unknown })?.message;
  if (message === "UNAUTHORIZED") throw new TrainerAppointmentError("UNAUTHORIZED");
  if (message === "APPOINTMENT_NOT_FOUND") throw new TrainerAppointmentError("NOT_FOUND");
  if (message === "APPOINTMENT_CONFLICT") throw new TrainerAppointmentError("CONFLICT");
  if (message === "APPOINTMENT_INPUT_INVALID" || message === "APPOINTMENT_RANGE_INVALID") {
    throw new TrainerAppointmentError("INVALID_INPUT");
  }
  throw new TrainerAppointmentError("UNAVAILABLE");
}

async function command(
  sql: string,
  values: readonly unknown[],
  query: DatabaseQuery,
): Promise<TrainerAppointment> {
  try {
    const result = await query<AppointmentRow>(sql, values);
    if (result.rowCount !== 1 || result.rows.length !== 1) throw new Error("COMMAND_FAILED");
    return mapAppointment(result.rows[0]);
  } catch (error) { return translate(error); }
}

export async function listTrainerAppointments(
  sessionToken: string,
  from: string,
  to: string,
  query: DatabaseQuery = queryDatabase,
): Promise<TrainerAppointment[]> {
  try {
    const result = await query<AppointmentRow>(
      "SELECT * FROM booking.list_trainer_appointments($1::bytea, $2::timestamptz, $3::timestamptz)",
      [digestTrainerSessionToken(sessionToken), from, to],
    );
    return result.rows.map(mapAppointment);
  } catch (error) { return translate(error); }
}

export async function createTrainerAppointment(
  sessionToken: string, clientId: string, startsAt: string, endsAt: string,
  query: DatabaseQuery = queryDatabase,
): Promise<TrainerAppointment> {
  return command(
    "SELECT id, client_id, starts_at, ends_at, status, cancelled_at, created_at, updated_at FROM booking.create_trainer_appointment($1::bytea, $2::uuid, $3::timestamptz, $4::timestamptz)",
    [digestTrainerSessionToken(sessionToken), clientId, startsAt, endsAt], query,
  );
}

export async function rescheduleTrainerAppointment(
  sessionToken: string, appointmentId: string, startsAt: string, endsAt: string,
  query: DatabaseQuery = queryDatabase,
): Promise<TrainerAppointment> {
  return command(
    "SELECT id, client_id, starts_at, ends_at, status, cancelled_at, created_at, updated_at FROM booking.reschedule_trainer_appointment($1::bytea, $2::uuid, $3::timestamptz, $4::timestamptz)",
    [digestTrainerSessionToken(sessionToken), appointmentId, startsAt, endsAt], query,
  );
}

export async function cancelTrainerAppointment(
  sessionToken: string, appointmentId: string,
  query: DatabaseQuery = queryDatabase,
): Promise<TrainerAppointment> {
  return command(
    "SELECT id, client_id, starts_at, ends_at, status, cancelled_at, created_at, updated_at FROM booking.cancel_trainer_appointment($1::bytea, $2::uuid)",
    [digestTrainerSessionToken(sessionToken), appointmentId], query,
  );
}
