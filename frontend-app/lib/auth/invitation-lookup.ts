import { Buffer } from "node:buffer";

import { normalizeEmailV1 } from "./email-invitations";

import {
  deriveInvitationLookupCandidates,
  type ReadableInvitationPepper,
} from "./invitation-verification";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function isCanonicalEmailV1(value: unknown): value is string {
  if (typeof value !== "string") return false;

  try {
    return normalizeEmailV1(value) === value;
  } catch {
    return false;
  }
}

const LOOKUP_SQL = `
SELECT
  id AS "invitationId",
  tenant_id AS "tenantId",
  trainer_id AS "trainerId",
  client_id AS "clientId",
  normalization_version AS "normalizationVersion",
  canonical_email AS "canonicalEmail",
  pepper_version AS "pepperVersion",
  status::text AS status,
  transaction_timestamp() < expires_at AS "isUnexpired"
FROM authn.invitation_issuances
WHERE pepper_version = $1
  AND token_digest = $2
`;

export type InvitationQueryResult = Readonly<{
  rows: readonly unknown[];
}>;

/** Minimal interface implemented later by a reviewed PostgreSQL client. */
export type InvitationQueryExecutor = Readonly<{
  query: (
    sql: string,
    parameters: readonly unknown[],
  ) => Promise<InvitationQueryResult>;
}>;

export type ResolvedInvitationLookup = Readonly<{
  invitationId: string;
  tenantId: string;
  trainerId: string;
  clientId: string;
  normalizationVersion: number;
  canonicalEmail: string;
  pepperVersion: number;
  tokenDigest: Buffer;
}>;

export class InvitationLookupError extends Error {
  constructor() {
    super("LINK_INVALID");
    this.name = "InvitationLookupError";
  }
}

type ValidatedRow = Omit<ResolvedInvitationLookup, "tokenDigest">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new InvitationLookupError();
  }
  return value;
}

function validateRow(value: unknown): ValidatedRow {
  if (!isRecord(value)) {
    throw new InvitationLookupError();
  }

  const normalizationVersion = value.normalizationVersion;
  const pepperVersion = value.pepperVersion;
  const canonicalEmail = value.canonicalEmail;
  if (
    normalizationVersion !== 1 ||
    !Number.isInteger(pepperVersion) ||
    (pepperVersion as number) <= 0 ||
    (pepperVersion as number) > 32_767 ||
    !isCanonicalEmailV1(canonicalEmail) ||
    value.status !== "pending" ||
    value.isUnexpired !== true
  ) {
    throw new InvitationLookupError();
  }

  return {
    invitationId: requireUuid(value.invitationId),
    tenantId: requireUuid(value.tenantId),
    trainerId: requireUuid(value.trainerId),
    clientId: requireUuid(value.clientId),
    normalizationVersion: normalizationVersion as number,
    canonicalEmail,
    pepperVersion: pepperVersion as number,
  };
}

/**
 * Performs an internal, read-only lookup for an invitation bearer.
 *
 * The returned selectors are derived from the matched database row and are
 * not mailbox proof or acceptance authority. A later trusted adapter must
 * verify the pre-auth request and invoke the atomic acceptance command, which
 * locks and rechecks scope, digest, pending state, and strict database expiry.
 */
export async function lookupInvitationByBearer(
  rawBearer: string,
  readablePeppers: readonly ReadableInvitationPepper[],
  database: InvitationQueryExecutor,
): Promise<ResolvedInvitationLookup> {
  const candidates = deriveInvitationLookupCandidates(
    rawBearer,
    readablePeppers,
  );
  const results = await Promise.all(
    candidates.map((candidate) =>
      database.query(LOOKUP_SQL, [
        candidate.pepperVersion,
        candidate.tokenDigest,
      ]),
    ),
  );
  const matches: ResolvedInvitationLookup[] = [];

  for (const [index, result] of results.entries()) {
    const candidate = candidates[index];
    if (!isRecord(result) || !Array.isArray(result.rows)) {
      throw new InvitationLookupError();
    }
    if (result.rows.length > 1) {
      throw new InvitationLookupError();
    }
    if (result.rows.length === 1) {
      const row = validateRow(result.rows[0]);
      if (row.pepperVersion !== candidate.pepperVersion) {
        throw new InvitationLookupError();
      }
      matches.push({ ...row, tokenDigest: Buffer.from(candidate.tokenDigest) });
    }
  }

  if (matches.length !== 1) {
    throw new InvitationLookupError();
  }
  return matches[0];
}
