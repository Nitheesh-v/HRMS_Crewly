# Phase 30.4 — Candidate BGV Consent Portal

## What this phase delivers

After a Phase 30.3 order is **PAID** (the commercial boundary), tenant HR can
send the candidate a secure consent invitation. The candidate opens a public,
token-authorized portal, sees who requested verification and which checks
were purchased, and explicitly **consents** or **declines**. Crewly stores
immutable consent provenance. HR sees the consent state. **Stop there** —
no document collection (30.5), no verifier work, no pipeline mutation.

## Three different decisions (kept separate)

| Decision | Owner | Stored |
| --- | --- | --- |
| Without-BGV acknowledgement | tenant HR (30.1) | `Candidate.bgvDecision` |
| Commercial authorization | tenant (30.3) | `BgvOrder.status === 'PAID'` |
| Candidate consent | **candidate** (30.4) | `BgvConsentAccessToken.finalDecision` |

Payment ≠ consent. Opening the email/portal ≠ consent. HR cannot consent for
the candidate. Consent ≠ BGV verified; decline ≠ BGV failed; decline never
auto-rejects the candidate.

## Invitation architecture (reuses the proven offer-token pattern)

- Collection `BgvConsentAccessToken` mirrors `OfferAccessToken` but is
  **purpose-isolated**: `purpose: 'BGV_CANDIDATE_CONSENT'` (asserted at
  resolution), separate routes, separate collection — its tokens can never
  act as offer / pre-onboarding / reset / setup tokens.
- Raw token = `randomToken(48)` (crypto.randomBytes, base64url). **Never
  persisted, never logged, never audited**: only `hashToken()` (sha256) is
  stored, `select:false`.
- One ACTIVE token per BGV order (`activeKey` partial unique index). Resend
  **rotates**: previous link is revoked (`SUPERSEDED`), a new one is issued;
  a completed consent/decline blocks reissue (no silent reopen).
- Expiry: `BGV_CONSENT_TOKEN_MAX_DAYS` (env-overridable, default 7, bounds
  1–30, same style as offer tokens). Expired links get a safe "link
  expired" page and cannot decide or reveal BGV details.
- Email: synchronous `sendMail(sensitive:true)` (the offer pattern) — the
  raw URL lives only in memory between issue and send; **no queue payload
  ever contains it**. Delivery failure revokes the undelivered link, keeps
  the PAID order authoritative, returns 503 and allows safe resend
  (at-least-once semantics, never exactly-once claimed). DEV/MOCK mode logs
  the portal URL once (`[DEV ONLY]`) so HR can test without SMTP.

## Scanner-safe GET — non-negotiable

`GET /api/public/candidate/bgv-consent/:token` resolves the token, shows the
safe page (company display name, candidate greeting, purchased checks from
the PAID order snapshot, consent statement + version, expiry) and increments
view telemetry **only**. It can never consent, decline, consume, start BGV,
create documents, contact verifiers or move the pipeline. Decisions are
explicit `POST .../consent` / `POST .../decline`.

Invalid/revoked tokens → generic 404 (no existence leak). Expired → safe
expired experience. Public responses contain no Mongo IDs, hashes, amounts
or tenant internals.

## Consent provenance

Every recorded decision stores: `finalDecision`, `decidedAt`,
`consentVersion` (`30.4.1`), `consentTextHash` (sha256 of the exact
statement shown), `checksSnapshot` (type+name copied from the PAID order
items at decision time) and `orderCode`. Later wording or catalogue price
changes cannot rewrite history.

## Decision rules

- `null → CONSENTED` / `null → DECLINED` (atomic conditional claim).
- Identical repeats replay idempotently (no duplicate audits/effects).
- `CONSENTED ↔ DECLINED` → 409 conflict; no silent re-consent in 30.4.
  Reopening a terminal decision is reserved for a future authorized
  workflow.

## Routes

| Route | Authority |
| --- | --- |
| `GET /api/public/candidate/bgv-consent/:token` | token + 80/15min rate limit |
| `POST .../consent`, `POST .../decline` | token + 10/15min decision limit |
| `POST /api/recruitment/bgv-orders/:orderId/consent-invitation` | `checkWriteAccess` + `BACKGROUND_VERIFICATION_MANAGE` |
| `GET /api/recruitment/candidates/:candidateId/bgv-consent-status` | `BACKGROUND_VERIFICATION_READ` |

## HR visibility

`getHrConsentStatus` derives: `NONE`, `INVITATION_SENT`, `INVITATION_EXPIRED`,
`INVITATION_REVOKED`, `CONSENTED`, `CONSENT_DECLINED` — and always returns
the order's `PAID` status alongside so **PAID ≠ CONSENTED** stays visible.
The candidate BGV panel shows this with Send/Resend invitation actions.

## Future billing compatibility

Eligibility consults only `BgvOrder.status === 'PAID'` — the authoritative
30.3 business state. No Razorpay/payment-provider field appears anywhere in
consent logic, so future credits / invoicing / subscription BGV / postpaid
can reach the same boundary. Those methods are future possibilities, **not**
current functionality.

## Tests

`Backend/test/bgvConsent.test.js` — 17 hermetic tests covering issuance
gates, hash-only persistence, purpose isolation, scanner-safe GET, explicit
POST decisions, idempotency, conflicts, expiry/revocation/rotation, tenant
isolation, provenance, snapshot immutability, audit token-redaction and the
no-side-effects boundary. Included in `npm run test:all` (902/902).

## Not implemented (by design)

Document/information collection (30.5), verifier accounts/assignment/
workbench, BGV case creation from consent, candidate auto-rejection,
pipeline auto-mutation, re-consent workflows, credits/invoicing.

## Addendum — Crewly-sent invitations & future billing boundary

**Responsibility split.** Tenant HR is the BGV *requester* (initiates, selects
checks, completes commercial authorization). Crewly/Infolexus is the
*service provider and invitation sender*: the backend generates the token,
renders and delivers the email from the configured verified sender
(`SMTP_FROM`, display label "Crewly Background Verification" — server-fixed;
no tenant/verifier/client input can choose a From address), hosts the public
portal and records consent/decline. The candidate is the consent
decision-maker and **never pays**. Production deployments must provision a
verified sender domain with SPF/DKIM/DMARC — a deployment requirement, not
application code.

**Email content.** Subject: "Background verification requested by
<Tenant Company Name>". Body states "<Tenant> has requested background
verification through Crewly, operated by Infolexus", lists the purchased
checks, the secure expiring link, expiry guidance and "you are never asked
to pay". No payment amounts, provider IDs, documents, identity numbers,
verifier or internal data; never claims completion.

**Trigger pattern B.** Authorized HR clicks "Send consent invitation"; the
action only asks Crewly's backend to generate+deliver. The raw token/URL is
never returned to HR APIs, never copyable, no mailto/manual-download
surfaces, frontend never constructs the secure link. Recipient always comes
from the authoritative Candidate document (tenant-scoped via the PAID
order) — body/query email overrides are ignored (not even parameters).

**Delivery states stay separate.** commercially authorized (PAID) →
invitation created → delivery pending/failed → consent pending →
consented/declined. SMTP failure returns 503, revokes the undelivered link,
leaves PAID untouched and surfaces `INVITATION_FAILED` to HR with safe
resend. At-least-once email semantics; exactly-once never claimed.

**Commercial authorization boundary.** `bgvOrderRules.commercialReadinessOf`
/ `isCommerciallyAuthorized` is the single mapping of the 30.3 state
(today: PAID) to `AUTHORIZED_FOR_PROCESSING`. The consent service contains
no Razorpay/payment-provider field access and no queue coupling, so future
modes (PREPAID_CREDITS, MONTHLY_INVOICE, SUBSCRIPTION_INCLUDED,
ENTERPRISE_POSTPAID — **not implemented**, not exposed in UI) can reach the
same boundary without redesigning invitation/consent/30.5+ workflows.

**Addendum tests** (8 added, suite now 25): unverified payment cannot
invite; boundary helper provider-agnostic + banned-coupling scan; Crewly
sender/tenant-requester/checks/no-pay email assertions; recipient/sender
override immunity; SMTP-failure state separation + safe resend; rotation
keeps one ACTIVE link and zero extra orders; route permission boundary;
frontend exposes no future billing modes.
