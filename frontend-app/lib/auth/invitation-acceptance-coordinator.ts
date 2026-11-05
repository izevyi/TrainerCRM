import { Buffer } from "node:buffer";

import {
  lookupInvitationByBearer,
  type InvitationQueryExecutor,
} from "./invitation-lookup";
import type { ReadableInvitationPepper } from "./invitation-verification";
import { verifyPreauthNonce } from "./preauth-nonce";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POSITIVE_BIGINT_PATTERN = /^[1-9][0-9]*$/;

const ACCEPTANCE_SQL = `
SELECT
  invitation_id AS "invitationId",
  subject_id AS "subjectId",
  identity_id AS "identityId",
  relationship_version::text AS "relationshipVersion"
FROM authn.consume_preauth_nonce_and_accept_new_email_invitation(
  $1, $2, $3, $4, $5, $6, $7, $8, $9
)
`;

export type InvitationAcceptanceDatabase = InvitationQueryExecutor;

export type InvitationAcceptanceConfiguration = Readonly<{
  applicationOrigin: string;
  preauthMacKey: Uint8Array;
  readableInvitationPeppers: readonly ReadableInvitationPepper[];
}>;

export type AcceptNewEmailInvitationOptions = Readonly<{
  rawBearer: string;
  challenge: string;
  cookieNonce: string;
  requestOrigin: string | null | undefined;
  configuration: InvitationAcceptanceConfiguration;
  database: InvitationAcceptanceDatabase;
  nowMs?: number;
}>;

export type AcceptedNewEmailInvitation = Readonly<{
  invitationId: string;
  subjectId: string;
  identityId: string;
  relationshipVersion: string;
}>;

export class InvitationAcceptanceError extends Error {
  constructor() {
    super("LINK_INVALID");
    this.name = "InvitationAcceptanceError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new InvitationAcceptanceError();
  }
  return value;
}

function validateAcceptanceRow(value: unknown): AcceptedNewEmailInvitation {
  if (!isRecord(value)) throw new InvitationAcceptanceError();
  const relationshipVersion = value.relationshipVersion;
  if (
    typeof relationshipVersion !== "string" ||
    !POSITIVE_BIGINT_PATTERN.test(relationshipVersion)
  ) {
    throw new InvitationAcceptanceError();
  }

  return {
    invitationId: requireUuid(value.invitationId),
    subjectId: requireUuid(value.subjectId),
    identityId: requireUuid(value.identityId),
    relationshipVersion,
  };
}

/**
 * Coordinates the internal new-identity acceptance flow. The pre-auth envelope
 * authenticates request freshness and cookie binding only; the independent raw
 * bearer lookup resolves invitation scope, and PostgreSQL remains the final
 * atomic acceptance and nonce-consumption authority.
 */
export async function acceptNewEmailInvitation(
  options: AcceptNewEmailInvitationOptions,
): Promise<AcceptedNewEmailInvitation> {
  try {
    if (!isRecord(options) || !isRecord(options.configuration)) {
      throw new InvitationAcceptanceError();
    }

    const verifiedNonce = verifyPreauthNonce({
      challenge: options.challenge,
      cookieNonce: options.cookieNonce,
      requestOrigin: options.requestOrigin,
      applicationOrigin: options.configuration.applicationOrigin,
      macKey: options.configuration.preauthMacKey,
      nowMs: options.nowMs,
    });
    const invitation = await lookupInvitationByBearer(
      options.rawBearer,
      options.configuration.readableInvitationPeppers,
      options.database,
    );
    const result = await options.database.query(ACCEPTANCE_SQL, [
      Buffer.from(verifiedNonce.nonceDigest),
      new Date(verifiedNonce.issuedAtMs),
      new Date(verifiedNonce.expiresAtMs),
      invitation.tenantId,
      invitation.trainerId,
      invitation.clientId,
      invitation.invitationId,
      invitation.pepperVersion,
      Buffer.from(invitation.tokenDigest),
    ]);

    if (
      !isRecord(result) ||
      !Array.isArray(result.rows) ||
      result.rows.length !== 1
    ) {
      throw new InvitationAcceptanceError();
    }
    const acceptance = validateAcceptanceRow(result.rows[0]);
    if (acceptance.invitationId !== invitation.invitationId) {
      throw new InvitationAcceptanceError();
    }
    return acceptance;
  } catch {
    throw new InvitationAcceptanceError();
  }
}
