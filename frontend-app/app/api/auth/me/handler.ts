import {
  TRAINER_SESSION_COOKIE,
  TrainerAuthError,
  resolveTrainerSession,
} from "../../../../lib/server/trainer-auth";

const HEADERS = { "Cache-Control": "no-store" };

function cookieValue(request: Request): string | undefined {
  const prefix = `${TRAINER_SESSION_COOKIE}=`;
  const matches = request.headers.get("cookie")?.split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(prefix)) ?? [];
  return matches.length === 1 ? matches[0].slice(prefix.length) : undefined;
}

export function createMeHandler(resolve = resolveTrainerSession) {
  return async function handleMe(request: Request): Promise<Response> {
    const token = cookieValue(request);
    if (!token) return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: HEADERS });
    try {
      const trainer = await resolve(token);
      return Response.json({ trainer }, { status: 200, headers: HEADERS });
    } catch (error) {
      const unavailable = error instanceof TrainerAuthError
        ? error.code === "UNAVAILABLE"
        : (error as { code?: unknown })?.code === "UNAVAILABLE";
      const status = unavailable ? 503 : 401;
      const code = status === 503 ? "AUTH_UNAVAILABLE" : "UNAUTHORIZED";
      return Response.json({ error: code }, { status, headers: HEADERS });
    }
  };
}
