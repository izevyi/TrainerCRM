import { normalizeEmailV1 } from "../../../../lib/auth/email-invitations";
import { validRegistrationPassword } from "../../../../lib/registration/registration-token";
import { limitedJsonBody, allowedRegistrationOrigin } from "../../../../lib/server/registration-http";
import { sendRegistrationEmail } from "../../../../lib/server/registration-mail";
import { allowRegistrationAttempt } from "../../../../lib/server/registration-rate-limit";
import { registrationEmailAllowed } from "../../../../lib/server/registration-access";
import { beginTrainerRegistration, RegistrationError } from "../../../../lib/server/trainer-registration";

const HEADERS = { "Cache-Control":"no-store" };
const accepted = () => Response.json({ status:"CHECK_EMAIL" }, { status:202, headers:HEADERS });
const invalid = () => Response.json({ error:"INVALID_REGISTRATION" }, { status:400, headers:HEADERS });
const unavailable = () => Response.json({ error:"REGISTRATION_UNAVAILABLE" }, { status:503, headers:HEADERS });

type Begin = typeof beginTrainerRegistration;
type Rate = typeof allowRegistrationAttempt;
type Mail = typeof sendRegistrationEmail;

export function createRegisterHandler(
  begin: Begin = beginTrainerRegistration,
  rate: Rate = allowRegistrationAttempt,
  send: Mail = sendRegistrationEmail,
) {
  return async function POST(request: Request): Promise<Response> {
    if (!allowedRegistrationOrigin(request)) return invalid();
    let email: string;
    let password: string;
    try {
      const body = await limitedJsonBody(request);
      if (!body || typeof body!=="object" || Array.isArray(body) ||
          Object.keys(body).length!==2 || !("email" in body) || !("password" in body) ||
          typeof body.email!=="string" || typeof body.password!=="string" ||
          !validRegistrationPassword(body.password)) return invalid();
      email = normalizeEmailV1(body.email);
      password = body.password;
    } catch { return invalid(); }
    try {
      // Default-deny: the pilot can only register the approved email.
      // This check runs on the server and cannot be bypassed by the UI.
      if (!registrationEmailAllowed(email)) return unavailable();
      if (!(await rate(request,email))) {
        return Response.json({ error:"RATE_LIMITED" }, {
          status:429, headers:{ ...HEADERS,"Retry-After":"60" },
        });
      }
      const ticket = await begin(email,password);
      if (ticket) await send(ticket.email,ticket.token);
      // Identical response for known accounts and pending/cooldown cases.
      return accepted();
    } catch (error) {
      if (error instanceof RegistrationError && error.code==="INVALID") return invalid();
      return unavailable();
    }
  };
}
