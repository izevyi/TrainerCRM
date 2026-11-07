import {
  TRAINER_SESSION_COOKIE,
  TrainerAuthError,
  revokeTrainerSession,
} from "../../../../lib/server/trainer-auth";

const HEADERS = { "Cache-Control": "no-store" };

function clearCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${TRAINER_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function cookieValue(request: Request): string | undefined {
  const prefix = `${TRAINER_SESSION_COOKIE}=`;
  const matches = request.headers.get("cookie")?.split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(prefix)) ?? [];
  return matches.length === 1 ? matches[0].slice(prefix.length) : undefined;
}

export function createLogoutHandler(revoke = revokeTrainerSession) {
  return async function handleLogout(request: Request): Promise<Response> {
    const token = cookieValue(request);
    if (token) {
      try {
        await revoke(token);
      } catch (error) {
        const unavailable = error instanceof TrainerAuthError
          ? error.code === "UNAVAILABLE"
          : (error as { code?: unknown })?.code === "UNAVAILABLE";
        if (unavailable) {
          return Response.json(
            { error: "AUTH_UNAVAILABLE" },
            { status: 503, headers: { ...HEADERS, "Set-Cookie": clearCookie() } },
          );
        }
      }
    }
    return new Response(null, { status: 204, headers: { ...HEADERS, "Set-Cookie": clearCookie() } });
  };
}
