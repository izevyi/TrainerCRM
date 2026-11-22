import { digestTrainerSessionToken } from "../auth/trainer-session-token";
import { queryDatabase, type DatabaseQuery } from "./db";

export type TrainerWeight = { id: string; date: string; weight: number; createdAt: string };
type WeightRow = { measurement_id: string; measured_on: Date | string; weight: number | string; created_at: Date | string };

export class TrainerWeightError extends Error {
  constructor(readonly code: "UNAUTHORIZED" | "NOT_FOUND" | "CONFLICT" | "INVALID_INPUT" | "UNAVAILABLE") {
    super(code);
    this.name = "TrainerWeightError";
  }
}

function translate(error: unknown): never {
  const state = (error as { code?: unknown })?.code;
  const message = (error as { message?: unknown })?.message;
  if (message === "UNAUTHORIZED") throw new TrainerWeightError("UNAUTHORIZED");
  if (message === "WEIGHT_CLIENT_NOT_FOUND" || message === "WEIGHT_NOT_FOUND") throw new TrainerWeightError("NOT_FOUND");
  if (message === "WEIGHT_INPUT_INVALID") throw new TrainerWeightError("INVALID_INPUT");
  if (state === "23505") throw new TrainerWeightError("CONFLICT");
  throw new TrainerWeightError("UNAVAILABLE");
}

function map(row: WeightRow): TrainerWeight {
  const date = typeof row.measured_on === "string" ? row.measured_on.slice(0, 10) : row.measured_on.toISOString().slice(0, 10);
  const createdAt = new Date(row.created_at).toISOString();
  const weight = Number(row.weight);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(weight) || weight <= 0) {
    throw new Error("INVALID_WEIGHT_ROW");
  }
  return { id: row.measurement_id, date, weight, createdAt };
}

export async function listTrainerWeights(token: string, clientId: string, query: DatabaseQuery = queryDatabase): Promise<TrainerWeight[]> {
  try {
    const rows = await query<WeightRow>(
      "SELECT * FROM booking.list_trainer_weight_measurements($1::bytea,$2::uuid)",
      [digestTrainerSessionToken(token), clientId],
    );
    return rows.rows.map(map);
  } catch (error) { return translate(error); }
}

export async function saveTrainerWeight(
  token: string, clientId: string, date: string, weight: number, measurementId: string | null = null,
  query: DatabaseQuery = queryDatabase,
): Promise<TrainerWeight> {
  try {
    const result = await query<WeightRow>(
      "SELECT * FROM booking.write_trainer_weight_measurement($1::bytea,$2::uuid,$3::uuid,$4::date,$5::numeric)",
      [digestTrainerSessionToken(token), clientId, measurementId, date, weight],
    );
    if (result.rowCount !== 1 || result.rows.length !== 1) throw new Error("WEIGHT_RETURN_INVALID");
    return map(result.rows[0]);
  } catch (error) { return translate(error); }
}

export async function removeTrainerWeight(token: string, clientId: string, measurementId: string, query: DatabaseQuery = queryDatabase): Promise<void> {
  try {
    const result = await query<{ deleted: boolean }>(
      "SELECT booking.delete_trainer_weight_measurement($1::bytea,$2::uuid,$3::uuid) AS deleted",
      [digestTrainerSessionToken(token), clientId, measurementId],
    );
    if (result.rowCount !== 1 || result.rows[0]?.deleted !== true) throw new Error("WEIGHT_DELETE_INVALID");
  } catch (error) { return translate(error); }
}
