import { Buffer } from "node:buffer";
import { TRAINER_SESSION_COOKIE, TrainerAuthError, resolveTrainerSession } from "../../../lib/server/trainer-auth";
import {
  createTrainerAppointment, listTrainerAppointments, TrainerAppointmentError,
} from "../../../lib/server/trainer-appointments";

export const APPOINTMENT_BODY_MAX_BYTES = 2_048;
export const APPOINTMENT_RANGE_MAX_MS = 31 * 24 * 60 * 60 * 1_000;
export const HEADERS = { "Cache-Control": "no-store" };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;

export function sessionToken(request: Request): string | undefined {
  const prefix = `${TRAINER_SESSION_COOKIE}=`;
  const matches = request.headers.get("cookie")?.split(";").map((v) => v.trim())
    .filter((v) => v.startsWith(prefix)) ?? [];
  return matches.length === 1 ? matches[0].slice(prefix.length) : undefined;
}

export function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339.exec(value);
  if (!match) return false;

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = Number(match[7] ?? 0); const offsetMinute = Number(match[8] ?? 0);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1] &&
    hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value));
}

export function errorResponse(error: unknown): Response {
  if (error instanceof TrainerAuthError) {
    return Response.json(
      { error: error.code === "UNAVAILABLE" ? "AUTH_UNAVAILABLE" : "UNAUTHORIZED" },
      { status: error.code === "UNAVAILABLE" ? 503 : 401, headers: HEADERS },
    );
  }
  if (error instanceof TrainerAppointmentError) {
    const status = { UNAUTHORIZED: 401, NOT_FOUND: 404, CONFLICT: 409, INVALID_INPUT: 400, UNAVAILABLE: 503 }[error.code];
    const code = error.code === "UNAVAILABLE" ? "APPOINTMENTS_UNAVAILABLE" : error.code;
    return Response.json({ error: code }, { status, headers: HEADERS });
  }
  return Response.json({ error: "APPOINTMENTS_UNAVAILABLE" }, { status: 503, headers: HEADERS });
}

export async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_BODY");
  const chunks: Buffer[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > APPOINTMENT_BODY_MAX_BYTES) { await reader.cancel(); throw new Error("INVALID_BODY"); }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function validRange(startsAt: unknown, endsAt: unknown, bounded = false): startsAt is string {
  if (!validTimestamp(startsAt) || !validTimestamp(endsAt)) return false;
  const duration = Date.parse(endsAt) - Date.parse(startsAt);
  return duration > 0 && (!bounded || duration <= APPOINTMENT_RANGE_MAX_MS);
}

export function createAppointmentsHandlers(
  resolve = resolveTrainerSession,
  list = listTrainerAppointments,
  create = createTrainerAppointment,
) {
  return {
    GET: async (request: Request): Promise<Response> => {
      const token = sessionToken(request);
      if (!token) return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: HEADERS });
      const url = new URL(request.url); const from = url.searchParams.get("from"); const to = url.searchParams.get("to");
      if (url.searchParams.size !== 2 || !validRange(from, to, true)) {
        return Response.json({ error: "INVALID_INPUT" }, { status: 400, headers: HEADERS });
      }
      try { await resolve(token); return Response.json({ appointments: await list(token, from as string, to as string) }, { headers: HEADERS }); }
      catch (error) { return errorResponse(error); }
    },
    POST: async (request: Request): Promise<Response> => {
      const token = sessionToken(request);
      if (!token) return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: HEADERS });
      let body: unknown; try { body = await readBody(request); } catch { return Response.json({ error: "INVALID_INPUT" }, { status: 400, headers: HEADERS }); }
      if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 3 ||
          !("clientId" in body) || !("startsAt" in body) || !("endsAt" in body) ||
          typeof body.clientId !== "string" || !UUID.test(body.clientId) || !validRange(body.startsAt, body.endsAt)) {
        return Response.json({ error: "INVALID_INPUT" }, { status: 400, headers: HEADERS });
      }
      try { await resolve(token); } catch (error) { return errorResponse(error); }
      try { return Response.json({ appointment: await create(token, body.clientId, body.startsAt as string, body.endsAt as string) }, { status: 201, headers: HEADERS }); }
      catch (error) { return errorResponse(error); }
    },
  };
}
