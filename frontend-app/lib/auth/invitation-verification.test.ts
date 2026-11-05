import { createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { computeInvitationTokenDigest } from "./email-invitations";
import {
  INVITATION_ACCEPTANCE_PURPOSE,
  deriveInvitationLookupCandidates,
  type ReadableInvitationPepper,
} from "./invitation-verification";

const rawBearer = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "hex",
).toString("base64url");
const pepper1 = Buffer.from(
  "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
  "hex",
);
const pepper2 = Buffer.from(
  "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f",
  "hex",
);
const invalidPepperConfigurations: readonly [
  readonly ReadableInvitationPepper[],
][] = [
  [[]],
  [[{ version: 0, pepper: pepper1 }]],
  [[{ version: -1, pepper: pepper1 }]],
  [[{ version: 1.5, pepper: pepper1 }]],
  [[{ version: 32_768, pepper: pepper1 }]],
  [[{ version: 1, pepper: Buffer.alloc(31) }]],
  [[
    { version: 3, pepper: pepper1 },
    { version: 3, pepper: pepper2 },
  ]],
];

describe("invitation bearer lookup candidate derivation", () => {
  it("derives the frozen invitation-acceptance HMAC for a canonical bearer", () => {
    const [candidate] = deriveInvitationLookupCandidates(rawBearer, [
      { version: 7, pepper: pepper1 },
    ]);

    expect(candidate.pepperVersion).toBe(7);
    expect(candidate.tokenDigest).toEqual(
      computeInvitationTokenDigest(
        rawBearer,
        INVITATION_ACCEPTANCE_PURPOSE,
        pepper1,
      ),
    );
    expect(candidate.tokenDigest.toString("hex")).toBe(
      "3dcc73198f72863ba7d75d5c37c285dddeae556ebdddfab87ec7b709fb6fad54",
    );
  });

  it("does not use an unframed HMAC or a different purpose", () => {
    const [candidate] = deriveInvitationLookupCandidates(rawBearer, [
      { version: 1, pepper: pepper1 },
    ]);
    const unframed = createHmac("sha256", pepper1)
      .update(Buffer.from(rawBearer, "base64url"))
      .digest();
    const otherPurpose = computeInvitationTokenDigest(
      rawBearer,
      "email-change.confirm",
      pepper1,
    );

    expect(candidate.tokenDigest).not.toEqual(unframed);
    expect(candidate.tokenDigest).not.toEqual(otherPurpose);
  });

  it("derives all readable versions in deterministic version order", () => {
    const candidates = deriveInvitationLookupCandidates(rawBearer, [
      { version: 9, pepper: pepper2 },
      { version: 2, pepper: pepper1 },
    ]);

    expect(candidates.map(({ pepperVersion }) => pepperVersion)).toEqual([2, 9]);
    expect(candidates[0].tokenDigest).toEqual(
      computeInvitationTokenDigest(rawBearer, "invitation.accept", pepper1),
    );
    expect(candidates[1].tokenDigest).toEqual(
      computeInvitationTokenDigest(rawBearer, "invitation.accept", pepper2),
    );
  });

  it.each([
    "",
    "A".repeat(42),
    "A".repeat(44),
    `${rawBearer}=`,
    `${rawBearer} `,
    ` ${rawBearer}`,
    `${rawBearer}\n`,
    `${rawBearer}\u0000`,
    rawBearer.replace(/.$/, "+"),
    rawBearer.replace(/.$/, "/"),
    "A".repeat(4_096),
  ])("rejects malformed or noncanonical bearer %j", (value) => {
    expect(() =>
      deriveInvitationLookupCandidates(value, [
        { version: 1, pepper: pepper1 },
      ]),
    ).toThrow("TOKEN_INVALID");
  });

  it.each([
    null,
    undefined,
    42,
    { token: rawBearer },
    new Uint8Array(32),
  ])("rejects non-string bearer %#", (value) => {
    expect(() =>
      deriveInvitationLookupCandidates(
        value as unknown as string,
        [{ version: 1, pepper: pepper1 }],
      ),
    ).toThrow("TOKEN_INVALID");
  });

  it.each(invalidPepperConfigurations)(
    "rejects invalid readable pepper configuration %#",
    (configuration) => {
      expect(() =>
        deriveInvitationLookupCandidates(rawBearer, configuration),
      ).toThrow("PEPPER_CONFIG_INVALID");
    },
  );

  it("accepts only raw bearer plus trusted peppers and returns no scope", () => {
    const [candidate] = deriveInvitationLookupCandidates(rawBearer, [
      { version: 1, pepper: pepper1 },
    ]);

    expect(Object.keys(candidate).sort()).toEqual([
      "pepperVersion",
      "tokenDigest",
    ]);
    expect(candidate).not.toHaveProperty("invitationId");
    expect(candidate).not.toHaveProperty("email");
    expect(candidate).not.toHaveProperty("scope");
  });

  it("has no logging or lookup side effect", () => {
    const log = console.log;
    let calls = 0;
    console.log = () => {
      calls += 1;
    };
    try {
      deriveInvitationLookupCandidates(rawBearer, [
        { version: 1, pepper: pepper1 },
      ]);
    } finally {
      console.log = log;
    }
    expect(calls).toBe(0);
  });
});
