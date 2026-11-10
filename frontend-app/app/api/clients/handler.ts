import { Buffer } from "node:buffer";

import {
  TRAINER_SESSION_COOKIE,
  TrainerAuthError,
  resolveTrainerSession,
} from "../../../lib/server/trainer-auth";
import {
  createTrainerClient,
  listTrainerClients,
} from "../../../lib/server/trainer-clients";

export const CLIENT_BODY_MAX_BYTES = 1_024;
const HEADERS = { "Cache-Control": "no-store" };

type Resolve = typeof resolveTrainerSession;
type List = typeof listTrainerClients;
type Create = typeof createTrainerClient;

function sessionToken(request: Request): string | undefined {
  const prefix = `${TRAINER_SESSION_COOKIE}=`;
  const matches = request.headers.get("cookie")?.split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(prefix)) ?? [];
  return matches.length === 1 ? matches[0].slice(prefix.length) : undefined;
}

function errorResponse(error: unknown): Response {
  const authUnavailable = error instanceof TrainerAuthError && error.code === "UNAVAILABLE";
  if (error instanceof TrainerAuthError || (error as { message?: unknown })?.message === "UNAUTHORIZED") {
    return Response.json(
      { error: authUnavailable ? "AUTH_UNAVAILABLE" : "UNAUTHORIZED" },
      { status: authUnavailable ? 503 : 401, headers: HEADERS },
    );
  }
  return Response.json({ error: "CLIENTS_UNAVAILABLE" }, { status: 503, headers: HEADERS });
}

async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_BODY");
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > CLIENT_BODY_MAX_BYTES) {
      await reader.cancel();
      throw new Error("INVALID_BODY");
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createClientsHandlers(
  resolve: Resolve = resolveTrainerSession,
  list: List = listTrainerClients,
  create: Create = createTrainerClient,
) {
  return {
    GET: async (request: Request): Promise<Response> => {
      const token = sessionToken(request);
      if (!token) return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: HEADERS });
      try {
        await resolve(token);
        return Response.json({ clients: await list(token) }, { status: 200, headers: HEADERS });
      } catch (error) {
        return errorResponse(error);
      }
    },
    POST: async (request: Request): Promise<Response> => {
      const token = sessionToken(request);
      if (!token) return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: HEADERS });
      try { await resolve(token); }
      catch (error) { return errorResponse(error); }
      let body: unknown;
      try { body = await readBody(request); }
      catch { return Response.json({ error: "INVALID_INPUT" }, { status: 400, headers: HEADERS }); }

      if (typeof body !== "object" || body === null || Array.isArray(body) ||
          Object.keys(body).length !== 2 || !("name" in body) || !("startingWeight" in body) ||
          typeof body.name !== "string" || typeof body.startingWeight !== "number") {
        return Response.json({ error: "INVALID_INPUT" }, { status: 400, headers: HEADERS });
      }
      const name = body.name.trim();
      const weight = body.startingWeight;
      const fieldErrors: { name?: string; startingWeight?: string } = {};
      if (name.length < 1) fieldErrors.name = "Name is required.";
      else if (name.length > 120 || Buffer.byteLength(name, "utf8") > 480) {
        fieldErrors.name = "Name must be at most 120 characters.";
      }
      if (!Number.isFinite(weight) || weight < 0.001 || weight > 1000 ||
          !Number.isInteger(weight * 1000)) {
        fieldErrors.startingWeight = "Starting weight must be between 0.001 and 1000 with at most 3 decimal places.";
      }
      if (Object.keys(fieldErrors).length > 0) {
        return Response.json({ error: "INVALID_INPUT", fieldErrors }, { status: 400, headers: HEADERS });
      }
      try {
        const client = await create(token, name, weight);
        return Response.json({ client }, { status: 201, headers: HEADERS });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
