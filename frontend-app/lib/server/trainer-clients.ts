import { digestTrainerSessionToken } from "../auth/trainer-session-token";
import { queryDatabase, type DatabaseQuery } from "./db";

export type TrainerClient = {
  id: string;
  name: string;
  startingWeight: number;
  createdAt: string;
};

type ClientRow = {
  client_id: string;
  display_name: string;
  starting_weight: string | number;
  created_at: Date | string;
};

function mapClient(row: ClientRow): TrainerClient {
  const startingWeight = Number(row.starting_weight);
  const createdAt = row.created_at instanceof Date
    ? row.created_at.toISOString()
    : new Date(row.created_at).toISOString();
  if (!Number.isFinite(startingWeight) || Number.isNaN(Date.parse(createdAt))) {
    throw new Error("INVALID_CLIENT_ROW");
  }
  return { id: row.client_id, name: row.display_name, startingWeight, createdAt };
}

export async function listTrainerClients(
  sessionToken: string,
  query: DatabaseQuery = queryDatabase,
): Promise<TrainerClient[]> {
  const result = await query<ClientRow>(
    "SELECT * FROM booking.list_trainer_clients($1::bytea)",
    [digestTrainerSessionToken(sessionToken)],
  );
  return result.rows.map(mapClient);
}

export async function createTrainerClient(
  sessionToken: string,
  name: string,
  startingWeight: number,
  query: DatabaseQuery = queryDatabase,
): Promise<TrainerClient> {
  const result = await query<ClientRow>(
    "SELECT * FROM booking.create_trainer_client($1::bytea, $2::text, $3::numeric)",
    [digestTrainerSessionToken(sessionToken), name, startingWeight],
  );
  if (result.rowCount !== 1 || result.rows.length !== 1) {
    throw new Error("CLIENT_CREATE_FAILED");
  }
  return mapClient(result.rows[0]);
}
