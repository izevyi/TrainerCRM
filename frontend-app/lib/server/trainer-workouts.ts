import { digestTrainerSessionToken } from "../auth/trainer-session-token";
import { queryDatabase, type DatabaseQuery } from "./db";

export type WorkoutInput = {
  clientId: string;
  appointmentId: string | null;
  date: string;
  time: string;
  type: string;
  completed: boolean;
  caloriesBurned: number | null;
  exercises: { name: string; sets: { weight: number; reps: number }[] }[];
};

export type WorkoutSet = { id: string; weight: number; reps: number };
export type WorkoutExercise = { id: string; name: string; sets: WorkoutSet[] };
export type TrainerWorkout = Omit<WorkoutInput, "exercises"> & {
  id: string;
  clientName: string;
  createdAt: string;
  updatedAt: string;
  exercises: WorkoutExercise[];
};

type WorkoutRow = { workout: TrainerWorkout };

export class TrainerWorkoutError extends Error {
  constructor(readonly code: "UNAUTHORIZED" | "NOT_FOUND" | "CONFLICT" | "INVALID_INPUT" | "UNAVAILABLE") {
    super(code);
    this.name = "TrainerWorkoutError";
  }
}

function translate(error: unknown): never {
  const message = (error as { message?: unknown })?.message;
  if (message === "UNAUTHORIZED") throw new TrainerWorkoutError("UNAUTHORIZED");
  if (message === "WORKOUT_NOT_FOUND") throw new TrainerWorkoutError("NOT_FOUND");
  if (message === "WORKOUT_CONFLICT") throw new TrainerWorkoutError("CONFLICT");
  if (message === "WORKOUT_INPUT_INVALID") throw new TrainerWorkoutError("INVALID_INPUT");
  throw new TrainerWorkoutError("UNAVAILABLE");
}

function normalize(row: WorkoutRow): TrainerWorkout {
  if (!row.workout || typeof row.workout !== "object") throw new Error("INVALID_WORKOUT_ROW");
  return row.workout;
}

export async function listTrainerWorkouts(
  token: string, clientId: string | null, query: DatabaseQuery = queryDatabase,
): Promise<TrainerWorkout[]> {
  try {
    const result = await query<WorkoutRow>(
      "SELECT workout FROM booking.list_trainer_workouts($1::bytea, $2::uuid)",
      [digestTrainerSessionToken(token), clientId],
    );
    return result.rows.map(normalize);
  } catch (error) { return translate(error); }
}

export async function getTrainerWorkout(
  token: string, workoutId: string, query: DatabaseQuery = queryDatabase,
): Promise<TrainerWorkout> {
  try {
    const result = await query<WorkoutRow>(
      "SELECT workout FROM booking.get_trainer_workout($1::bytea, $2::uuid)",
      [digestTrainerSessionToken(token), workoutId],
    );
    if (result.rowCount !== 1 || result.rows.length !== 1) throw new Error("WORKOUT_NOT_FOUND");
    return normalize(result.rows[0]);
  } catch (error) { return translate(error); }
}

async function write(
  functionName: "create_trainer_workout" | "update_trainer_workout",
  token: string, input: WorkoutInput, workoutId: string | null, query: DatabaseQuery,
): Promise<TrainerWorkout> {
  const idArgument = workoutId === null ? "" : "$2::uuid, ";
  const offset = workoutId === null ? 1 : 2;
  const values: unknown[] = [digestTrainerSessionToken(token)];
  if (workoutId !== null) values.push(workoutId);
  values.push(input.clientId, input.appointmentId, input.date, input.time, input.type,
    input.completed, input.caloriesBurned, JSON.stringify(input.exercises));
  try {
    const result = await query<WorkoutRow>(
      `SELECT workout FROM booking.${functionName}($1::bytea, ${idArgument}$${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}::date, $${offset + 4}::time, $${offset + 5}::text, $${offset + 6}::boolean, $${offset + 7}::numeric, $${offset + 8}::jsonb)`,
      values,
    );
    if (result.rowCount !== 1 || result.rows.length !== 1) throw new Error("WORKOUT_WRITE_FAILED");
    return normalize(result.rows[0]);
  } catch (error) { return translate(error); }
}

export function createTrainerWorkout(
  token: string, input: WorkoutInput, query: DatabaseQuery = queryDatabase,
): Promise<TrainerWorkout> {
  return write("create_trainer_workout", token, input, null, query);
}

export function updateTrainerWorkout(
  token: string, workoutId: string, input: WorkoutInput, query: DatabaseQuery = queryDatabase,
): Promise<TrainerWorkout> {
  return write("update_trainer_workout", token, input, workoutId, query);
}
