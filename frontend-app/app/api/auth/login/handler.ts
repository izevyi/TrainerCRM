import { Buffer } from "node:buffer";

import { allowLoginAttempt } from "../../../../lib/server/login-rate-limit";

import {
  LOGIN_BODY_MAX_BYTES,
  TRAINER_SESSION_COOKIE,
  TRAINER_SESSION_MAX_AGE_SECONDS,
  TrainerAuthError,
  loginTrainer,
} from "../../../../lib/server/trainer-auth";

const HEADERS = { "Cache-Control": "no-store" };
const invalid = () => Response.json({ error: "INVALID_CREDENTIALS" }, { status: 401, headers: HEADERS });

export function createLoginHandler(authenticate = loginTrainer, rateLimit = allowLoginAttempt) {
  return async function handleLogin(request: Request): Promise<Response> {
    let body: unknown;
    try {
      const reader = request.body?.getReader();
      if (!reader) return invalid();

      const chunks: Buffer[] = [];
      let bytesRead = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        bytesRead += value.byteLength;
        if (bytesRead > LOGIN_BODY_MAX_BYTES) {
          await reader.cancel();
          return invalid();
        }

        chunks.push(Buffer.from(value));
      }

      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return invalid();
    }
    if (
      typeof body !== "object" || body === null || Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !("email" in body) || !("password" in body) ||
      typeof body.email !== "string" || typeof body.password !== "string" ||
      Buffer.byteLength(body.email, "utf8") > 254 ||
      Buffer.byteLength(body.password, "utf8") > 1_024 || !body.password
    ) return invalid();

    try {
      if (!(await rateLimit(request, body.email))) throw new TrainerAuthError("RATE_LIMITED");
      const { token, ...trainer } = await authenticate(body.email, body.password);
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      return Response.json(
        { trainer },
        {
          status: 200,
          headers: {
            ...HEADERS,
            "Set-Cookie": `${TRAINER_SESSION_COOKIE}=${token}; Max-Age=${TRAINER_SESSION_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax${secure}`,
          },
        },
      );
    } catch (error) {
      if (error instanceof TrainerAuthError && error.code === "RATE_LIMITED") {
        return Response.json({ error: "INVALID_CREDENTIALS" }, { status: 429, headers: { ...HEADERS, "Retry-After": "60" } });
      }
      if (error instanceof TrainerAuthError && error.code === "INVALID_CREDENTIALS") return invalid();
      return Response.json({ error: "AUTH_UNAVAILABLE" }, { status: 503, headers: HEADERS });
    }
  };
}
