import { describe, expect, it } from "vitest";
import { digestRegistrationToken, makeRegistrationToken, validRegistrationPassword } from "./registration-token";

describe("self registration token and password", () => {
  it("generates opaque 256-bit single-use tokens", () => {
    const one=makeRegistrationToken(), two=makeRegistrationToken();
    expect(one).toHaveLength(43);
    expect(two).toHaveLength(43);
    expect(one).not.toBe(two);
    expect(digestRegistrationToken(one)).toHaveLength(32);
    expect(digestRegistrationToken(one)).toEqual(digestRegistrationToken(one));
    expect(digestRegistrationToken(one)).not.toEqual(digestRegistrationToken(two));
    expect(() => digestRegistrationToken("insecure")) .toThrow();
  });
  it("requires at least eight Unicode characters", () => {
    expect(validRegistrationPassword("abc1234")).toBe(false);
    expect(validRegistrationPassword("abc12345")).toBe(true);
    expect(validRegistrationPassword("пароль12")).toBe(true);
    expect(validRegistrationPassword("абвгдеж")).toBe(false);
    expect(validRegistrationPassword("x".repeat(1025))).toBe(false);
  });
});
