import { Buffer } from "node:buffer";
import { TRAINER_SESSION_COOKIE, TrainerAuthError, resolveTrainerSession } from "../../../lib/server/trainer-auth";
import {
  createTrainerWorkout, listTrainerWorkouts, TrainerWorkoutError, type WorkoutInput,
} from "../../../lib/server/trainer-workouts";

export const WORKOUT_BODY_MAX_BYTES = 64 * 1024;
export const HEADERS = { "Cache-Control": "no-store" };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return year >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function sessionToken(request: Request): string | undefined {
  const prefix = `${TRAINER_SESSION_COOKIE}=`;
  const values = request.headers.get("cookie")?.split(";").map((value) => value.trim())
    .filter((value) => value.startsWith(prefix)) ?? [];
  return values.length === 1 ? values[0].slice(prefix.length) : undefined;
}

export async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_BODY");
  const chunks: Buffer[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > WORKOUT_BODY_MAX_BYTES) { await reader.cancel(); throw new Error("INVALID_BODY"); }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

export function validWorkoutInput(value: unknown): value is WorkoutInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (!exactKeys(body, ["clientId", "appointmentId", "date", "time", "type", "completed", "caloriesBurned", "exercises"]) ||
      typeof body.clientId !== "string" || !UUID.test(body.clientId) ||
      !(body.appointmentId === null || (typeof body.appointmentId === "string" && UUID.test(body.appointmentId))) ||
      typeof body.date !== "string" || !validDate(body.date) ||
      typeof body.time !== "string" || !TIME.test(body.time) ||
      typeof body.type !== "string" || body.type !== body.type.trim() || body.type.length < 1 || body.type.length > 120 ||
      typeof body.completed !== "boolean" ||
      !(body.caloriesBurned === null || (typeof body.caloriesBurned === "number" && Number.isFinite(body.caloriesBurned) && body.caloriesBurned >= 0 && body.caloriesBurned <= 100000 && Number.isInteger(body.caloriesBurned * 100))) ||
      !Array.isArray(body.exercises) || body.exercises.length > 50) return false;
  return body.exercises.every((rawExercise) => {
    if (typeof rawExercise !== "object" || rawExercise === null || Array.isArray(rawExercise)) return false;
    const exercise = rawExercise as Record<string, unknown>;
    if (!exactKeys(exercise, ["name", "sets"]) || typeof exercise.name !== "string" ||
        exercise.name !== exercise.name.trim() || exercise.name.length < 1 || exercise.name.length > 120 ||
        !Array.isArray(exercise.sets) || exercise.sets.length > 20) return false;
    return exercise.sets.every((rawSet) => {
      if (typeof rawSet !== "object" || rawSet === null || Array.isArray(rawSet)) return false;
      const set = rawSet as Record<string, unknown>;
      return exactKeys(set, ["weight", "reps"]) && typeof set.weight === "number" &&
        Number.isFinite(set.weight) && set.weight >= 0 && set.weight <= 1000 && Number.isInteger(set.weight * 1000) &&
        typeof set.reps === "number" && Number.isInteger(set.reps) && set.reps >= 0 && set.reps <= 10000;
    });
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof TrainerAuthError) return Response.json(
    { error: error.code === "UNAVAILABLE" ? "AUTH_UNAVAILABLE" : "UNAUTHORIZED" },
    { status: error.code === "UNAVAILABLE" ? 503 : 401, headers: HEADERS },
  );
  if (error instanceof TrainerWorkoutError) {
    const status = { UNAUTHORIZED: 401, NOT_FOUND: 404, CONFLICT: 409, INVALID_INPUT: 400, UNAVAILABLE: 503 }[error.code];
    return Response.json({ error: error.code === "UNAVAILABLE" ? "WORKOUTS_UNAVAILABLE" : error.code }, { status, headers: HEADERS });
  }
  return Response.json({ error: "WORKOUTS_UNAVAILABLE" }, { status: 503, headers: HEADERS });
}

export function createWorkoutsHandlers(
  resolve = resolveTrainerSession, list = listTrainerWorkouts, create = createTrainerWorkout,
) {
  return {
    GET: async (request: Request): Promise<Response> => {
      const token = sessionToken(request); if (!token) return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: HEADERS });
      const url = new URL(request.url); const clientId = url.searchParams.get("clientId");
      if (url.searchParams.size > 1 || (url.searchParams.size === 1 && (!clientId || !UUID.test(clientId)))) return Response.json({ error: "INVALID_INPUT" }, { status: 400, headers: HEADERS });
      try { await resolve(token); return Response.json({ workouts: await list(token, clientId) }, { headers: HEADERS }); }
      catch (error) { return errorResponse(error); }
    },
    POST: async (request: Request): Promise<Response> => {
      const token = sessionToken(request); if (!token) return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: HEADERS });
      let body: unknown; try { body = await readBody(request); } catch { return Response.json({ error: "INVALID_INPUT" }, { status: 400, headers: HEADERS }); }
      if (!validWorkoutInput(body)) return Response.json({ error: "INVALID_INPUT" }, { status: 400, headers: HEADERS });
      try { await resolve(token); return Response.json({ workout: await create(token, body) }, { status: 201, headers: HEADERS }); }
      catch (error) { return errorResponse(error); }
    },
  };
}
