import { Buffer } from "node:buffer";

import {
  EmailInvitationSecurityError,
  computeInvitationTokenDigest,
} from "./email-invitations";

export const INVITATION_ACCEPTANCE_PURPOSE = "invitation.accept" as const;

const MAX_POSTGRES_SMALLINT = 32_767;

/** Trusted server-side configuration. Pepper bytes must never come from a request. */
export type ReadableInvitationPepper = Readonly<{
  version: number;
  pepper: Uint8Array;
}>;

/**
 * A database lookup selector derived from the raw bearer. It is not proof that
 * an invitation exists, is pending/unexpired, or belongs to a mailbox.
 */
export type InvitationLookupCandidate = Readonly<{
  pepperVersion: number;
  tokenDigest: Buffer;
}>;

function validateAndOrderPeppers(
  readablePeppers: readonly ReadableInvitationPepper[],
): readonly ReadableInvitationPepper[] {
  if (!Array.isArray(readablePeppers) || readablePeppers.length === 0) {
    throw new EmailInvitationSecurityError("PEPPER_CONFIG_INVALID");
  }

  const versions = new Set<number>();
  for (const entry of readablePeppers) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !Number.isInteger(entry.version) ||
      entry.version <= 0 ||
      entry.version > MAX_POSTGRES_SMALLINT ||
      !(entry.pepper instanceof Uint8Array) ||
      entry.pepper.byteLength < 32 ||
      versions.has(entry.version)
    ) {
      throw new EmailInvitationSecurityError("PEPPER_CONFIG_INVALID");
    }
    versions.add(entry.version);
  }

  return [...readablePeppers].sort((left, right) => left.version - right.version);
}

/**
 * Derives every supported `(pepper_version, token_digest)` lookup candidate.
 *
 * This pure helper performs no database lookup, status/expiry check, mailbox
 * proof, logging, or mutation. A trusted adapter must resolve exactly one
 * authoritative invitation row and the database must recheck it under lock.
 * This module depends on Node-only invitation crypto and must not be imported
 * by Client Components.
 */
export function deriveInvitationLookupCandidates(
  rawBearer: string,
  readablePeppers: readonly ReadableInvitationPepper[],
): readonly InvitationLookupCandidate[] {
  if (typeof rawBearer !== "string") {
    throw new EmailInvitationSecurityError("TOKEN_INVALID");
  }

  const orderedPeppers = validateAndOrderPeppers(readablePeppers);

  return orderedPeppers.map(({ version, pepper }) => ({
    pepperVersion: version,
    tokenDigest: computeInvitationTokenDigest(
      rawBearer,
      INVITATION_ACCEPTANCE_PURPOSE,
      pepper,
    ),
  }));
}
