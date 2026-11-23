import { normalizeEmailV1 } from "../auth/email-invitations";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Fail closed unless an operator explicitly enables registration.
 * pilot: only a single verified-in-the-configuration email can request a link.
 * public: normal self-service registration for all valid email addresses.
 */
export function registrationEmailAllowed(
  canonicalEmail: string,
  environment: Environment = process.env,
): boolean {
  if (environment.TRAINERCRM_REGISTRATION_MODE === "public") return true;
  if (environment.TRAINERCRM_REGISTRATION_MODE !== "pilot") return false;

  try {
    const pilot = normalizeEmailV1(environment.TRAINERCRM_REGISTRATION_PILOT_EMAIL ?? "");
    return canonicalEmail === pilot;
  } catch {
    return false;
  }
}
