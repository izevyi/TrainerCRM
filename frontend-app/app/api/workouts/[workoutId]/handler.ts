import { resolveTrainerSession } from "../../../../lib/server/trainer-auth";
import { getTrainerWorkout, updateTrainerWorkout } from "../../../../lib/server/trainer-workouts";
import { errorResponse, HEADERS, readBody, sessionToken, UUID, validWorkoutInput } from "../handler";

type Context = { params: Promise<{ workoutId: string }> };

export function createWorkoutHandlers(
  resolve = resolveTrainerSession, get = getTrainerWorkout, update = updateTrainerWorkout,
) {
  return {
    GET: async (request: Request, context: Context): Promise<Response> => {
      const token = sessionToken(request); const { workoutId } = await context.params;
      if (!token) return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: HEADERS });
      if (!UUID.test(workoutId)) return Response.json({ error: "NOT_FOUND" }, { status: 404, headers: HEADERS });
      try { await resolve(token); return Response.json({ workout: await get(token, workoutId) }, { headers: HEADERS }); }
      catch (error) { return errorResponse(error); }
    },
    PUT: async (request: Request, context: Context): Promise<Response> => {
      const token = sessionToken(request); const { workoutId } = await context.params;
      if (!token) return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: HEADERS });
      if (!UUID.test(workoutId)) return Response.json({ error: "NOT_FOUND" }, { status: 404, headers: HEADERS });
      let body: unknown; try { body = await readBody(request); } catch { return Response.json({ error: "INVALID_INPUT" }, { status: 400, headers: HEADERS }); }
      if (!validWorkoutInput(body)) return Response.json({ error: "INVALID_INPUT" }, { status: 400, headers: HEADERS });
      try { await resolve(token); return Response.json({ workout: await update(token, workoutId, body) }, { headers: HEADERS }); }
      catch (error) { return errorResponse(error); }
    },
  };
}
