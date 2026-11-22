import { Buffer } from "node:buffer";
import { isValidMeasurementDate } from "../../../../../lib/progress/weight-history";
import { TRAINER_SESSION_COOKIE, TrainerAuthError, resolveTrainerSession } from "../../../../../lib/server/trainer-auth";
import {
  listTrainerWeights, saveTrainerWeight, removeTrainerWeight, TrainerWeightError,
} from "../../../../../lib/server/trainer-weights";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADERS = { "Cache-Control": "no-store" };
type Context = { params: Promise<{ clientId: string }> };
const jsonError = (code: string, status: number) => Response.json({ error: code }, { status, headers: HEADERS });

function tokenOf(request: Request): string | null {
  const prefix = `${TRAINER_SESSION_COOKIE}=`;
  const matches = request.headers.get("cookie")?.split(";").map(value => value.trim())
    .filter(value => value.startsWith(prefix)) ?? [];
  return matches.length === 1 ? matches[0].slice(prefix.length) : null;
}

async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("BODY_REQUIRED");
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 2048) { await reader.cancel(); throw new Error("BODY_TOO_LARGE"); }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.001 && value <= 1000 && Number.isInteger(value * 1000);
}
function failure(error: unknown): Response {
  if (error instanceof TrainerAuthError) return jsonError(error.code === "UNAVAILABLE" ? "AUTH_UNAVAILABLE" : "UNAUTHORIZED", error.code === "UNAVAILABLE" ? 503 : 401);
  if (error instanceof TrainerWeightError) {
    const status = { UNAUTHORIZED: 401, NOT_FOUND: 404, CONFLICT: 409, INVALID_INPUT: 400, UNAVAILABLE: 503 }[error.code];
    return jsonError(error.code === "UNAVAILABLE" ? "WEIGHTS_UNAVAILABLE" : error.code, status);
  }
  return jsonError("WEIGHTS_UNAVAILABLE", 503);
}

export function createWeightHandlers(
  resolve = resolveTrainerSession, list = listTrainerWeights,
  save = saveTrainerWeight, remove = removeTrainerWeight,
) {
  const prepare = async (request: Request, context: Context) => {
    const token = tokenOf(request);
    if (!token) return null;
    const { clientId } = await context.params;
    if (!UUID.test(clientId)) return { token, clientId: null };
    return { token, clientId };
  };
  return {
    GET: async (request: Request, context: Context): Promise<Response> => {
      const target = await prepare(request, context);
      if (!target) return jsonError("UNAUTHORIZED", 401);
      if (!target.clientId) return jsonError("INVALID_INPUT", 400);
      try {
        await resolve(target.token);
        return Response.json({ measurements: await list(target.token, target.clientId) }, { headers: HEADERS });
      } catch (error) { return failure(error); }
    },
    POST: async (request: Request, context: Context): Promise<Response> => {
      const target = await prepare(request, context);
      if (!target) return jsonError("UNAUTHORIZED", 401);
      if (!target.clientId) return jsonError("INVALID_INPUT", 400);
      if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return jsonError("INVALID_INPUT", 400);
      let body: unknown;
      try { body = await readBody(request); } catch { return jsonError("INVALID_INPUT", 400); }
      if (!isObject(body) || !exact(body, ["date", "weight"]) ||
        typeof body.date !== "string" || !isValidMeasurementDate(body.date) || !validWeight(body.weight)) return jsonError("INVALID_INPUT", 400);
      try {
        await resolve(target.token);
        return Response.json({ measurement: await save(target.token, target.clientId, body.date, body.weight) }, { status: 201, headers: HEADERS });
      } catch (error) { return failure(error); }
    },
    PUT: async (request: Request, context: Context): Promise<Response> => {
      const target = await prepare(request, context);
      if (!target) return jsonError("UNAUTHORIZED", 401);
      if (!target.clientId) return jsonError("INVALID_INPUT", 400);
      if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return jsonError("INVALID_INPUT", 400);
      let body: unknown;
      try { body = await readBody(request); } catch { return jsonError("INVALID_INPUT", 400); }
      if (!isObject(body) || !exact(body, ["id", "date", "weight"]) ||
        typeof body.id !== "string" || !UUID.test(body.id) || typeof body.date !== "string" ||
        !isValidMeasurementDate(body.date) || !validWeight(body.weight)) return jsonError("INVALID_INPUT", 400);
      try {
        await resolve(target.token);
        return Response.json({ measurement: await save(target.token, target.clientId, body.date, body.weight, body.id) }, { headers: HEADERS });
      } catch (error) { return failure(error); }
    },
    DELETE: async (request: Request, context: Context): Promise<Response> => {
      const target = await prepare(request, context);
      if (!target) return jsonError("UNAUTHORIZED", 401);
      if (!target.clientId) return jsonError("INVALID_INPUT", 400);
      if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return jsonError("INVALID_INPUT", 400);
      let body: unknown;
      try { body = await readBody(request); } catch { return jsonError("INVALID_INPUT", 400); }
      if (!isObject(body) || !exact(body, ["id"]) || typeof body.id !== "string" || !UUID.test(body.id)) return jsonError("INVALID_INPUT", 400);
      try {
        await resolve(target.token);
        await remove(target.token, target.clientId, body.id);
        return Response.json({ deleted: true }, { headers: HEADERS });
      } catch (error) { return failure(error); }
    },
  };
}
