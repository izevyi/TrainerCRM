import { allowedRegistrationOrigin, limitedJsonBody } from "../../../../lib/server/registration-http";
import { verifyTrainerRegistration, RegistrationError } from "../../../../lib/server/trainer-registration";
import { allowRegistrationVerificationAttempt } from "../../../../lib/server/registration-rate-limit";

const HEADERS = { "Cache-Control":"no-store" };

export function createVerifyRegistrationHandler(verify = verifyTrainerRegistration, rate = allowRegistrationVerificationAttempt) {
  return async function POST(request: Request): Promise<Response> {
    if (!allowedRegistrationOrigin(request)) {
      return Response.json({ error:"INVALID_TOKEN" }, { status:400, headers:HEADERS });
    }
    let token: string;
    try {
      const body = await limitedJsonBody(request,512);
      if (!body || typeof body!=="object" || Array.isArray(body) ||
          Object.keys(body).length!==1 || !("token" in body) ||
          typeof body.token!=="string") throw new Error();
      token = body.token;
    } catch {
      return Response.json({ error:"INVALID_TOKEN" }, { status:400, headers:HEADERS });
    }
    try {
      if (!(await rate(request))) {
        return Response.json({ error:"RATE_LIMITED" }, { status:429, headers:{ ...HEADERS,"Retry-After":"60" } });
      }
      if (await verify(token)) {
        return Response.json({ status:"VERIFIED" }, { status:200, headers:HEADERS });
      }
      return Response.json({ error:"INVALID_TOKEN" }, { status:400, headers:HEADERS });
    } catch(error) {
      if (error instanceof RegistrationError && error.code==="INVALID") {
        return Response.json({ error:"INVALID_TOKEN" }, { status:400, headers:HEADERS });
      }
      return Response.json({ error:"REGISTRATION_UNAVAILABLE" }, { status:503, headers:HEADERS });
    }
  };
}
