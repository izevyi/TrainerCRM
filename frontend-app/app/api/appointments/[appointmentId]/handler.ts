import { cancelTrainerAppointment, rescheduleTrainerAppointment } from "../../../../lib/server/trainer-appointments";
import { resolveTrainerSession } from "../../../../lib/server/trainer-auth";
import { errorResponse, HEADERS, readBody, sessionToken, UUID, validRange } from "../handler";

type Context = { params: Promise<{ appointmentId: string }> };

export function createAppointmentHandlers(
  resolve = resolveTrainerSession,
  reschedule = rescheduleTrainerAppointment,
  cancel = cancelTrainerAppointment,
) {
  return {
    PATCH: async (request: Request, context: Context): Promise<Response> => {
      const token = sessionToken(request); const { appointmentId } = await context.params;
      if (!token) return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: HEADERS });
      if (!UUID.test(appointmentId)) return Response.json({ error: "NOT_FOUND" }, { status: 404, headers: HEADERS });
      let body: unknown; try { body = await readBody(request); } catch { return Response.json({ error: "INVALID_INPUT" }, { status: 400, headers: HEADERS }); }
      if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 2 ||
          !("startsAt" in body) || !("endsAt" in body) || !validRange(body.startsAt, body.endsAt)) {
        return Response.json({ error: "INVALID_INPUT" }, { status: 400, headers: HEADERS });
      }
      try { await resolve(token); } catch (error) { return errorResponse(error); }
      try { return Response.json({ appointment: await reschedule(token, appointmentId, body.startsAt as string, body.endsAt as string) }, { headers: HEADERS }); }
      catch (error) { return errorResponse(error); }
    },
    DELETE: async (request: Request, context: Context): Promise<Response> => {
      const token = sessionToken(request); const { appointmentId } = await context.params;
      if (!token) return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: HEADERS });
      if (!UUID.test(appointmentId)) return Response.json({ error: "NOT_FOUND" }, { status: 404, headers: HEADERS });
      try { await resolve(token); return Response.json({ appointment: await cancel(token, appointmentId) }, { headers: HEADERS }); }
      catch (error) { return errorResponse(error); }
    },
  };
}
