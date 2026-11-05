# Trusted Email Invitation Verification Adapter Design

Status: implementation-ready security design; not an implementation or production approval

Milestone: 7F.6
Scope: invitation acceptance for a new email identity

## Purpose and security outcome

The future adapter proves possession of the raw invitation bearer and, because that bearer was delivered to the invited address, treats successful possession as the mailbox-ownership proof for a new identity. It must derive the invitation and its tenant/trainer/client scope from that proof, validate the browser request, and only then invoke the database acceptance transaction.

Milestone 7F.5's `authn.accept_new_email_invitation` is an owner-only internal transaction primitive. It is not independently authenticated mailbox verification. Its tenant, trainer, client, invitation, pepper-version, and digest arguments are selectors and consistency checks supplied by its caller. A UUID, pepper version, or digest presented by a caller does not establish possession of the raw bearer. The function has no non-owner `EXECUTE` grantee and must not be exposed directly.

This document does not approve runtime wiring, a public endpoint, a database grant, production activation, an email provider, the proposed 10-minute step-up freshness, or the proposed 30-second session-rotation overlap.

## Implemented baseline

The following exists today in migrations 004–007 and their tests:

- `authn.invitation_issuances` stores a unique `(pepper_version, token_digest)`, immutable tenant/trainer/client and canonical-email scope, an exact 24-hour expiry, and a constrained lifecycle. It stores no raw bearer.
- Only one pending issuance per client is permitted. Pending invitations grant neither verified identity nor relationship access.
- `authn.email_identities` contains verified identities only and uniquely owns `(normalization_version, canonical_email)`.
- Issue and revoke commands use the lock order trainer identity, membership, client, invitation; write audit/outbox state transactionally; and remain owner-only.
- Migration 006 permits an email-only client subject with both legacy phone fields null. This does not reinterpret phone verification as email proof and does not grant legacy booking authority.
- `authn.accept_new_email_invitation` validates exact locked scope, pending status, `transaction_timestamp() < expires_at`, pepper version, and 32-byte digest. For a new canonical email it atomically creates the email-only subject and verified identity, activates the exact client and relationship, accepts the issuance, and appends two correlated audits.
- Acceptance rejects malformed inputs, wrong scope or digest, expiry equality, terminal or replayed issuance, and any already existing canonical identity with the same public `LINK_INVALID` database message. A forced audit failure rolls all acceptance writes back.
- The focused suite specifies a 20-way acceptance race with one success and 19 `LINK_INVALID` results, plus an accept/revoke race with one serial terminal state. `PUBLIC` and every non-owner grantee have no execution privilege.

The Milestone 7F.5 PostgreSQL acceptance and unchanged regression suites were subsequently executed successfully by the Auto-Company wrapper. That later evidence supersedes the older consensus entry that recorded them as `NOT RUN`. No tests were executed as part of this documentation cycle.

## Missing components

There is currently no HTTP route, trusted application adapter, raw-bearer parser, HMAC key service, pre-auth nonce store, Origin/CSRF enforcement, session issuer, rate limiter, email delivery worker, provider integration, or runtime database role/grant. The reference-only outbox is not deliverable. The database primitive does not perform constant-time raw-token verification and does not create a login session.

The repository's standalone invitation utility from Milestone 7F.2 defines useful token and HMAC behavior, but it is not wired to this database flow. An implementation must explicitly integrate or equivalently enforce it; mere presence of utility code is not a trust boundary.

## Trust boundaries

1. The browser and every URL, UUID, digest, email, forwarded header, and request body field are untrusted.
2. The raw invitation bearer is the only invitation credential. Mail delivery is transport, not proof; proof occurs when the adapter validates possession of that bearer on a state-changing POST.
3. The server adapter is the authentication boundary. It parses the raw bearer, obtains pepper material from an approved secret manager, computes the purpose-bound HMAC, resolves the issuance from the digest, validates the pre-auth request, and supplies database selectors derived from the locked issuance.
4. PostgreSQL is the atomic state-transition boundary. It remains authoritative for status, expiry, scope, uniqueness, locking, replay prevention, identity creation, relationship activation, and audit.
5. The mail provider, reverse proxy, observability stack, analytics, and browser storage are outside the proof boundary and must never receive the bearer.

Mailbox ownership is therefore proven at the adapter's successful raw-bearer verification, immediately before and as a precondition of the atomic acceptance transaction. A matching canonical email, UUID, stored digest, provider delivery receipt, GET request, or legacy `phone_verified_at` is not mailbox proof.

## Raw bearer and HMAC verification

The public acceptance request contains only the raw token and the pre-auth confirmation nonce. It must not accept invitation, client, trainer, tenant, pepper-version, digest, canonical-email, or subject identifiers from the browser.

The adapter must apply this sequence:

1. Enforce method, content type, body-size limit, exact Origin policy, and nonce validity before database work. Reject duplicate JSON keys and unknown fields.
2. Parse a single canonical base64url token encoding exactly 32 random bytes (256 bits). Reject padding, alternate encodings, whitespace, controls, CR/LF, and oversized input before logging or HMAC work.
3. Compute `HMAC-SHA-256(pepper[version], framed-purpose || raw-token-bytes)` using the frozen invitation-acceptance purpose/domain framing. A plain hash, client-computed digest, or HMAC without purpose separation is invalid.
4. For each currently readable invitation pepper version, compute a fixed-size candidate digest. Query by the server-derived `(pepper_version, token_digest)` only. Do not query by a caller UUID and then compare a caller digest.
5. Require exactly one matching issuance. Derive invitation, tenant, trainer, client, normalization version, and canonical email from that row. Never copy those values from the request.
6. Invoke a reviewed database command that re-locks the issuance and rechecks the derived version/digest and all scope, status, expiry, and identity conditions. The current 7F.5 primitive performs these locked checks, but a future wrapper is needed to couple nonce consumption and any session issuance.

Candidate HMAC work should be uniform across configured readable versions, and comparisons outside PostgreSQL must use constant-time fixed-32-byte comparison. Public behavior must not reveal whether a version exists. A selector embedded in a token is optional only if it is random/non-enumerable and authenticated as part of the HMAC input; it must never become authority or appear in logs. The simplest approved-compatible implementation is no public UUID selector.

## Pepper lifecycle

- Pepper values are high-entropy secrets held outside PostgreSQL and source control. The database stores only a positive version and 32-byte HMAC digest.
- New invitations use exactly one active write version. Verification reads every still-supported version for at least the maximum invitation lifetime plus operational clock/deployment margin.
- A version must not be removed while a nonterminal, unexpired issuance can reference it. Emergency compromise handling requires a separately approved mass-revocation and communication procedure; silently accepting with a replacement key is unsafe.
- Key access is limited to the verification service. Startup must fail closed if the configured write version is absent, duplicated, too short, or not present in the read set.
- Metrics may identify a pepper version, but logs must never contain pepper bytes, raw tokens, candidate digests, or token-derived stable fingerprints.

Expiry is authoritative database transaction time: acceptance is allowed only when `transaction_timestamp() < expires_at`; equality is expired. Public verification must not update a pending row merely because it is expired. Replay protection comes from the locked pending-to-accepted transition, the lifecycle constraints, unique identity claim, and single-use nonce. Accepted, revoked, superseded, explicitly expired, and previously consumed links all fail without additional business or audit writes.

## Pre-auth nonce and request-origin defense

The generic confirmation page may issue a stateless, short-lived, single-purpose nonce envelope and a `__Host-` pre-auth cookie. Both use independent random values of at least 128 bits and a server MAC key distinct from invitation peppers. The envelope binds purpose `invitation.accept`, issued/expiry times, the expected canonical application origin, and the cookie nonce digest. It contains no token, email, invitation ID, or scope. The cookie is `Secure; HttpOnly; SameSite=Lax; Path=/` with no `Domain`; neither value goes to localStorage.

Issuing this envelope on GET creates no server or invitation state. POST must present the envelope, matching cookie, and raw bearer. The adapter verifies the MAC, strict expiry (`now < expires_at`), purpose, origin binding, and cookie binding, then records a nonce digest exactly once. Nonce consumption and invitation acceptance must commit atomically in the same PostgreSQL transaction, or both roll back. The nonce-consumption table therefore needs a unique digest, purpose, created/consumed/expiry times, and bounded cleanup; it stores neither token nor cookie value.

For POST, require `Origin` to equal an allowlisted configured HTTPS origin byte-for-byte after standards-compliant origin parsing. Reject missing, `null`, malformed, multiple, forwarded, or cross-origin values; do not construct the allowlist from `Host`, `X-Forwarded-*`, or request parameters. If product owners later require a Referer fallback, it needs explicit approval and equivalent exact-origin parsing. SameSite cookies and the nonce supplement, not replace, Origin checking. CORS must not allow credentialed foreign origins, and simple form content types must be rejected if the endpoint contract is JSON.

## Safe HTTP behavior

`GET /invite`, `HEAD`, link previews, conditional requests, and scanner/prefetch traffic must never validate or consume the invitation, create a subject/session, change last-seen state, terminalize expiry, enqueue mail, or append a transition audit. They return the same generic, no-store confirmation shell whether the bearer is absent, malformed, valid, expired, or terminal. `HEAD` has GET-equivalent headers and no body.

The page must send `Cache-Control: no-store, private`, `Referrer-Policy: no-referrer`, a restrictive CSP, no third-party resources, no analytics, and no service-worker or browser persistence of the URL. Client code should remove the token from the visible URL with `history.replaceState` after copying it only to ephemeral memory, but this is leakage reduction, not verification. Logs and proxy configuration must redact the query string before request logging. The preferred future delivery URL places the bearer in a fragment and moves it into the POST body, subject to browser implementation review, because fragments are not sent in HTTP requests.

Only explicit POST performs verification and mutation. It returns a no-store generic response and clears the pre-auth cookie. Retries with a consumed bearer or nonce fail generically; the adapter must not auto-repeat a transaction after an ambiguous commit unless a separately designed idempotent response-handoff mechanism exists.

## Transaction and race design

The final POST transaction must preserve the established lock order: trainer identity, membership, client, invitation. It then rechecks all scope from the matched issuance, pending status, strict expiry, pepper version/digest, exact invited client state, and canonical identity uniqueness before any durable result.

The preferred implementation is a new owner-defined wrapper command accepting only server-derived proof material and nonce digest, which consumes the nonce and performs the 7F.5 transition in one transaction. Do not grant the browser or a broad API role direct table access. If the application begins a database transaction and calls the current primitive, it must use the same connection for nonce consumption and any session creation; cross-service compensation is not atomic.

Concurrent accept/accept and accept/revoke attempts must serialize on the same locks. Exactly one terminal outcome may commit. Unique `(normalization_version, canonical_email)` remains the last concurrent identity-claim arbiter. Unique-violation, deadlock, serialization failure, timeout, lost connection, or audit/session failure must roll back the whole transaction and map to a coarse response; never return success before commit. Deadlock/serialization retry is allowed only for a still-valid, unconsumed server-side request identity and must not mint another bearer, nonce, subject, or audit.

Session creation is missing. If the desired product behavior is login immediately after new-identity acceptance, session family/session creation and cookie issuance must be designed and committed with acceptance or use a durable one-time post-commit handoff. That requires a separate approved implementation dependency; the adapter must not improvise a bearer in application memory.

## Existing verified identities

The current function intentionally fails closed if the canonical address already belongs to any identity, including a disabled one, and leaves the invitation pending. The adapter must preserve this behavior. It must never create, merge, reassign, enable, or link an existing subject based on email equality plus invitation possession.

The 7E.2 contract proposes that an existing verified identity additionally prove a current session for that exact subject and fresh step-up, or complete a separate purpose-bound sign-in challenge. The proposed freshness is 10 minutes and is not owner-approved. Until the owner approves the authentication method and freshness and a separate existing-identity command is implemented, every such acceptance returns the same generic invalid-link response and performs no mutation.

## Public errors, observability, and privacy

Absent, malformed, wrong-purpose, unknown-pepper, unmatched, expired, accepted, revoked, superseded, wrong-scope, existing-identity, and replay cases return the same status, schema, cache headers, and coarse `LINK_INVALID` message. Nonce/Origin failures should be equally coarse at the public boundary. Rate limiting must not expose invitation or email existence. Response latency should be padded or otherwise tested so gross parsing, HMAC-version, lookup, and state differences are not a practical oracle; correctness must not depend on perfect timing equality.

Use a fresh request/correlation ID unrelated to the bearer. Security logs may record event class, coarse result/reason, route template, timestamp, deployment, pepper version, and rate-limit bucket only where needed. Never log raw/full or partial tokens, token digests, HMAC candidates, nonce/cookie/CSRF values, full email, request body, query string, provider payload, session bearer, full IP, or full User-Agent. If abuse signals are approved, use short-retention rotating keyed digests and document access and erasure. Sanitize CR/LF and length-limit every logged field. Database rejection paths should not append per-attempt audit rows that enable enumeration or amplify attacks; aggregate metrics are preferable.

## Required future automated tests

Before any runtime exposure, add tests covering:

- accepted/rejected canonical token encodings, 256-bit length, purpose separation, deterministic HMAC vectors, fixed-size constant-time comparison, malformed/oversized/log-injection input, write/read pepper rotation, missing-key fail-closed startup, and retirement boundaries;
- proof lookup derived only from raw bearer, with browser UUID/digest/email/scope fields rejected or ignored, and no alternate query path capable of selecting by those fields;
- absent, random, expired at equality, accepted, revoked, superseded, wrong version, existing identity, and nonce replay producing the same public contract and bounded timing distributions;
- stateless nonce MAC/expiry/purpose/cookie binding, single consumption, rollback reuse after failed transaction, parallel reuse, cookie flags, exact Origin matrix, missing/null/multiple/malformed Origin, hostile forwarded headers, Referer policy, content type, CORS, and CSRF attempts;
- GET, HEAD, prefetch headers, link scanners, conditional requests, refresh, and multiple tabs causing zero database/session/outbox/audit mutation; no bearer in logs, Referer, analytics, traces, metrics, cache, browser persistence, exceptions, or third-party requests;
- expiry at minus one microsecond, equality, and plus one microsecond using database time; no public-read terminalization;
- 20 simultaneous POST accepts yielding one complete identity/relationship/acceptance result and 19 generic failures; accept/revoke and future accept/resend races yielding one serial terminal state; nonce, identity, audit, and session exact counts;
- injected failure after nonce consumption and after every provisional acceptance/session/audit write, proving complete rollback; unique-claim, deadlock, serialization, timeout, and lost-commit behavior;
- existing active and disabled identities, different/stale/missing subject sessions, and attacker-versus-legitimate races all remaining fail-closed until the approved exact-subject step-up path exists;
- restricted-role integration proving only allowlisted execution, no table/sequence DML, no owner membership or `SET ROLE`, fixed search path, no `PUBLIC`, and unchanged 7C/7D and Milestone 7F.1–7F.5 regressions.

Use synthetic `example.invalid` data, independent PostgreSQL connections with explicit barriers, and an isolated exact test database. The production runtime must have no test clock or reset capability.

## Implementation dependencies and owner decisions

Implementation depends on all of the following:

- an approved server runtime and route placement, canonical HTTPS origin allowlist, proxy query-redaction configuration, CSP, rate limits, body limits, and deployment topology;
- an approved secret manager and operational policy for invitation peppers, nonce MAC keys, active/read versions, rotation, compromise response, and key-access audit;
- a reviewed integration of the existing 32-byte token/HMAC utility or equivalent frozen framing, with Node/runtime compatibility confirmed;
- a new migration for atomic nonce consumption and, preferably, a proof-oriented wrapper command; exact schema, cleanup/retention, privileges, and backup/restore behavior require review;
- an explicitly approved narrow runtime role and exact `EXECUTE` grants. None are approved by this design;
- a session design if acceptance should log the client in, including atomic creation or durable handoff, cookie behavior, revocation, and failure recovery;
- operational logging/redaction, privacy retention, incident response, monitoring, and timing/rate-limit thresholds;
- separately approved email delivery architecture, secure link construction, recipient reference, worker, provider, and legal/privacy controls. No provider is selected here.

Owner decisions still unresolved are:

1. Whether and how new-identity acceptance creates a session atomically.
2. The exact pre-auth nonce lifetime, cleanup retention, and whether strict Origin without Referer fallback is acceptable.
3. The existing-identity authentication flow and step-up freshness. Ten minutes remains a proposal, not approval.
4. Session rotation and recovery behavior. Thirty seconds of overlap remains a proposal, not approval, and is not required for this adapter design.
5. The runtime/database role, exact new wrapper signature, and any new `EXECUTE` grant.
6. Pepper storage, rotation ownership, compromise response, and operational access.
7. Rate-limit and timing-equalization thresholds based on measured deployment behavior.
8. Email provider, delivery worker, legal/privacy controls, production activation, and public API exposure.

Until those decisions and a separately scoped implementation are approved, the safe state is the current dormant owner-only primitive with no public or runtime execution path.
