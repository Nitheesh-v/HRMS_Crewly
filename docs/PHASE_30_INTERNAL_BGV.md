# Phase 30 — Internal BGV (Consolidated Reference)

Crewly-operated, per-candidate background verification built on top of the
existing HRMS. Phase 30 spans sub-phases 30.1 → 30.12; this document is the
consolidated architecture/security reference. Per-sub-phase detail lives in
`docs/PHASE_30_*_*.md`. Companion checklist: `docs/PHASE_30_TESTING_CHECKLIST.md`.

## 1. Complete supported workflow

Interviews / final human selection → **HR BGV decision** (30.1):

- **Without BGV** — HR records `PROCEED_WITHOUT_BGV` (reason required,
  audited, reversible decision record). Recruitment continues normally.
  This is NOT "BGV cleared" — no verification state is ever implied.
- **With BGV** — HR initiates an order:
  1. **30.2 Catalogue** — platform (BILLING_ADMIN/SUPER_ADMIN) manages the 5
     products and prices. Backend is the only price authority.
  2. **30.3 Order** — per-candidate order; immutable server-priced snapshot;
     Razorpay (or explicit mock) payment; server-side HMAC verification;
     duplicate-purchase protection via `openKey`; `PAID` is terminal.
  3. **30.4 Consent** — Crewly (never the tenant's mail identity) emails the
     candidate a hash-only, purpose-scoped, expiring portal token. Candidate
     explicitly CONSENTS or DECLINES via POST. GET is scanner-safe
     (decision-free). Decline is neither failure nor rejection.
  4. **30.5 Collection** — consented candidate enters information for the
     purchased checks only; private uploads (MIME allowlist, magic bytes,
     size caps); drafts; explicit final submission freezes the package
     (idempotent replay).
  5. **30.6 Verifiers** — internal Crewly verifiers: separate principal,
     separate session stack, bcryptjs passwords, hash-only setup/reset
     tokens, OTP 2FA optional, soft deactivation, generic auth errors.
  6. **30.7 Assignment** — platform operators assign ONE primary verifier per
     check (specialization required, atomic CURRENT assignment, immutable
     history). Verifier work queue comes only from their CURRENT assignments.
  7. **30.8 Workbench** — method allowlist per check, append-only activities,
     structured discrepancies, controlled states (IN_PROGRESS /
     AWAITING_THIRD_PARTY / AWAITING_CANDIDATE / SUBMITTED), verifier
     conclusions (VERIFIED / VERIFIED_WITH_DISCREPANCY / UNABLE_TO_VERIFY /
     INCONCLUSIVE). Verifiers make NO recruitment decisions.
  8. **30.9 Additional info** — verifier requests missing evidence by
     category; candidate responds through the same secure portal; only the
     requested category unlocks; v1 evidence preserved; requests survive
     reassignment; audit safe-metadata only.
  9. **30.10 QA & report** — internal QA approves or returns findings
     (reason ≥10 chars, immutable revisions); readiness engine enforces all
     purchased checks approved + zero open info requests at generate AND
     release; snapshot report `BGVRPT-######` (TenantSequence), private
     PDFKit PDF; **GENERATED ≠ RELEASED**; tenant HR sees/downloads only
     RELEASED reports scoped by `req.companyId`.
  10. **30.11 Operations** — internal derived dashboard (11 states), SLA
     policy (5 check types, no seeded defaults), verifier workload,
     bucketed reminders via the existing EmailDelivery outbox.
  11. **30.12 Hardening** — consolidated security regression
     (`test/phase30Security.test.js`), verifier portal route guard, payment
     verifier awaited, this documentation.
- **Human decision** — the tenant HR makes the employment decision. BGV
  outcomes (CLEAR / CLEAR_WITH_DISCREPANCIES / HOLD) are information only;
  no BGV code changes `candidate.currentStage`, rejects, hires, or withdraws
  offers.

## 2. The five checks (final Phase 30 scope)

`IDENTITY`, `ADDRESS`, `EDUCATION`, `EMPLOYMENT`, `REFERENCE`
(`BGV_CATALOGUE_TYPES`). Criminal/court, watchlist/PEP, credit,
medical/drug, professional-licence checks are **deliberately absent** and
cannot be purchased, assigned, or verified.

## 3. Security architecture summary

- **Tenant isolation** — authority is ONLY `req.companyId`; every BGV
  tenant query filters `{ _id, companyId }`; `req.body/query.companyId`
  is never used as authority; cross-tenant existence is never leaked
  (generic not-found).
- **Candidate tokens** — crypto-random raw token shown once; only
  `hashToken(raw)` persisted; purpose `BGV_CANDIDATE_CONSENT`; expiry;
  revocation + safe reissue (rotation carries the completed decision and
  never reopens a decline); no token in logs/audit/queues; GET routes are
  read-only; consent/decline/save/submit/respond are POST-only.
- **Verifier principal** — never a tenant `User`; session middleware
  re-checks the revocable session row AND account ACTIVE state on every
  request; no temporary passwords ever; access = CURRENT assignment to the
  session verifier (specialization alone grants nothing; former verifiers
  denied); identity never taken from query/body.
- **Check-level privacy** — per-checkType DTOs; an EMPLOYMENT verifier never
  receives identity/selfie/address/education/reference data; evidence
  downloads re-verify the assignment chain server-side and are audited
  (safe metadata only).
- **Platform gates** — `requireSuperAdmin + permit(...)`: `bgv-catalog:*`
  (BILLING_ADMIN/SUPER_ADMIN), `bgv-verifiers:*`, `bgv-operations:*`
  (SUPER_ADMIN via `*`), `bgv-qa:*` (PLATFORM_ADMIN/SUPER_ADMIN). Tenant
  tokens die at the platform principal gate before privileged DB work.
- **Files** — private storage only (0600 local dir or Cloudinary
  `authenticated` fetched server-side; signed URLs live ≤5 min and are never
  returned to clients); MIME allowlists + magic-byte inspection + size
  caps + sanitized names; versions preserved (REPLACED, never overwritten);
  malware posture honest: `NOT_CONFIGURED` is never faked `CLEAN`.
- **Payments** — backend price authority; `CLIENT_MONEY_KEYS` rejected;
  immutable snapshot; server HMAC verification (awaited — 30.12); mock
  confirm only for mock-gateway orders; forged signature → `PAYMENT_FAILED`;
  duplicate callbacks idempotent; SMTP/queue failure never mutates payment
  state. Commercial-readiness abstraction
  (`isCommerciallyAuthorized(order)` ⇔ `status === 'PAID'`) is the ONLY
  gate downstream phases consume — no scattered `razorpayPaymentId`
  dependency (future billing boundary, §8).
- **Queues/workers** — references-only payloads (ids/kind/bucket/epoch);
  workers re-fetch Mongo and skip stale milestones with explicit reasons;
  deterministic event keys give at-least-once, de-duplicated delivery
  (never claimed exactly-once); Mongo remains the source of truth — Redis
  loss loses no business data; bounded reconcile scripts
  (`email:reconcile`, `queue:reconcile`, `bgv:reminders:reconcile`);
  no `KEYS`/`FLUSHDB`/`FLUSHALL` anywhere.
- **Sensitive data** — PAN/Aadhaar/UAN/passport/DL masked in APIs/UI;
  identifiers encrypted at rest where retained; verifier questionnaires
  reject credential/OTP/geolocation/full-identifier keys outright; UAN is
  supporting evidence only; no secrets in logs/audit/queues/tests.
- **DigiLocker boundary** — ONLY `DIGILOCKER_ISSUER_ASSISTED`
  (manual/issuer-assisted review of candidate-provided material,
  provenance `CANDIDATE_PROVIDED_DIGILOCKER`). No password/OTP capture, no
  scraping, no fake OAuth, no direct-API claim; report wording preserves
  the accurate method label.
- **Audit** — decision/waiver, pricing, order/payment, invitation,
  consent/decline, evidence, verifier lifecycle, assignment, activities,
  info requests, QA, report generate/release/download audited with SAFE
  metadata; dashboard count reads deliberately NOT audited; the only 30.11
  audit addition is `BGV_SLA_POLICY_UPDATED`.

## 4. Frontend surfaces (route guards mirror, backend enforces)

| Persona | Routes |
|---|---|
| Tenant HR | recruitment candidate drawer BGV panel (`/app/recruitment/...`) |
| Candidate | `/candidate/bgv-consent/:secureToken` (public, token-scoped) |
| Verifier | `/bgv-verifier/login|setup/:token|forgot|reset|` + guarded `/bgv-verifier`, `/bgv-verifier/work[/:orderId/:checkType]` (30.12 `RequireVerifierAuth` + 401 interceptor) |
| Super Admin | `/super-admin/bgv-services`, `/bgv-verifiers`, `/bgv-operations`, `/bgv-qa`, `/bgv-ops` |

## 5. Testing map

- Per-phase hermetic suites: `bgvDecision`, `bgvCatalogue`, `bgvOrder`,
  `bgvConsent`, `bgvCollection`, `bgvVerifier`, `bgvAssignment`,
  `bgvWorkbench`, `bgvInfoRequest`, `bgvQaReport`, `bgvOperations`.
- Consolidated security regression: `test/phase30Security.test.js`
  (`npm run test:phase30-security`) — 39 boundary tests across tenancy,
  platform, verifier, tokens (incl. §11 mail-scanner GET regression),
  consent, files, payment, workflow, human-decision, queue, DigiLocker.
- Broad regression: `npm run test:all` (current checkout: 1060 pass).
- Frontend: `npm run build`.

## 6. Failure behavior / runbook

- Redis down: business data safe in Mongo; dashboards fail over safely;
  queued intents recovered by existing reconcile scripts.
- SMTP down: EmailDelivery FAILED/retry; reminders re-derive from Mongo on
  the next reconcile; no business-state mutation.
- Payment webhook duplicates: idempotent replay of authoritative state.
- Stale queue jobs: worker revalidation skips with explicit reasons.
- Verifier deactivated mid-work: immediate access loss; history preserved;
  operator may reassign through the normal flow.

## 7. Known limitations

- Sandbox (Arena) cannot run live Mongo/Redis/SMTP/Cloudinary/Razorpay —
  those checks are marked BLOCKED there and belong to localhost acceptance.
- SLA v1 scans derive in-memory (fine at current volumes); a bounded cache
  can be added later (fail-open to Mongo, no sensitive content).
- Malware scanning reports `NOT_CONFIGURED` unless a real scanner is wired.

## 8. NOT implemented (potential future phases — unapproved)

- **Direct DigiLocker API integration** (requires approved access; separate
  future phase)
- Criminal / court checks; watchlist / PEP screening
- Credit checks; medical / drug checks; professional-licence verification
- Prepaid BGV credits; monthly consolidated BGV invoicing;
  subscription-included BGV allowance; enterprise postpaid BGV

Future billing must extend the commercial-readiness boundary
(`isCommerciallyAuthorized`), never re-derive payment provider fields.
