import { describe, expect, it } from "vitest";
import { registrationEmailAllowed } from "./registration-access";

describe("registration feature gate", () => {
  it("fails closed when unset, disabled, or mistyped", () => {
    for (const mode of [undefined, "", "off", "enabled", "PUBLIC"]) {
      expect(registrationEmailAllowed("trainer@example.com", { TRAINERCRM_REGISTRATION_MODE: mode })).toBe(false);
    }
  });
  it("only allows the configured mailbox during pilot", () => {
    const env = { TRAINERCRM_REGISTRATION_MODE: "pilot", TRAINERCRM_REGISTRATION_PILOT_EMAIL: "Test.Trainer@example.com" };
    expect(registrationEmailAllowed("test.trainer@example.com", env)).toBe(true);
    expect(registrationEmailAllowed("other@example.com", env)).toBe(false);
    expect(registrationEmailAllowed("test.trainer@example.com", {TRAINERCRM_REGISTRATION_MODE:"pilot"})).toBe(false);
  });
  it("allows all normalized email addresses only in explicit public mode", () => {
    expect(registrationEmailAllowed("anyone@example.org", {TRAINERCRM_REGISTRATION_MODE:"public"})).toBe(true);
  });
});
