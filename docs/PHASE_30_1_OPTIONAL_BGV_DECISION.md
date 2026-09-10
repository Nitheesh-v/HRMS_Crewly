# PHASE 30.1 — OPTIONAL BGV DECISION

Crewly Internal Background Verification Service — sub-phase 30.1.

## Purpose

BGV is **optional** for tenants. After the existing **human** recruitment
final selection (`recordCandidateFinalDecision`, stage `SELECTED`), tenant HR
explicitly chooses one of:

1. **PROCEED WITHOUT BGV** — an HR acknowledgement (with confirmation modal in
   the UI). It is NOT candidate consent and it NEVER labels the candidate
   `BGV_CLEAR` / `VERIFIED` / `PASSED`.
2. **INITIATE BGV** — records the HR intention to use Crewly BGV. Pricing,
   purchase, candidate consent, documents, verifiers and verification belong
   to later Phase 30 sub-phases (30.2+). No fake payment UI is created.

## Persisted state (extends, never replaces, Phase 27.15)

`Candidate.bgvDecision` sub-document:

```
status:    NONE | PROCEEDED_WITHOUT_BGV | BGV_INITIATED
decidedBy: User ref (actor from authenticated context)
decidedAt: Date
reason:    optional tenant text, trimmed, max 300 chars
```

- Timeline: `CandidateHistory` actions `BGV_DECISION_WAIVED` /
  `BGV_DECISION_INITIATED`, source `BGV_DECISION` (append-only).
- Audit: existing `recordAudit` (securityauditService) with action equal to
  the history action, `previousValue/newValue = { bgvDecision }`, safe
  metadata only. No secrets, no documents, no PAN/Aadhaar/UAN/bank values.
- The decision is **separate from the pipeline stage**: Phase 30.1 never
  mutates `currentStage`; `transitionCandidateStage` remains the only stage
  mutator. No automatic select/reject/hire/convert.

## Eligibility & safety rules (`services/bgv/bgvDecisionRules.js`, pure)

- Available only post-selection: `SELECTED, OFFER, OFFER_ACCEPTED,
  PRE_ONBOARDING, JOINED`. Earlier stages → 409 `NOT_POST_SELECTION`.
- An active Phase 27.15 case blocks both choices (`BGV_ALREADY_STARTED` /
  `BGV_CASE_EXISTS`) — no waiving an in-flight verification.
- Idempotency: identical repeated decision returns the authoritative state,
  no duplicate history/audit rows (atomic `NONE -> target` claim guards
  duplicate clicks/retries; the loser re-reads and resolves idempotent or
  conflict).
- Conflicts: opposite decision after one is recorded → 409, no silent toggle.
- Tenant security: candidate loaded with `{ _id|candidateCode, companyId }`
  from `req.companyId`; other-tenant refs are a clean 404 (no existence
  leak). `companyId` in body/query is never read.

## API

- `POST /api/recruitment/candidates/:candidateId/bgv-decision`
  `{ decision: 'PROCEED_WITHOUT_BGV' | 'INITIATE_BGV', reason? }`
  Gate: `checkWriteAccess` + `requirePermission('BACKGROUND_VERIFICATION_MANAGE')`
  (reused — HR_MANAGER already holds it alongside `CANDIDATE_FINAL_DECISION`;
  **no new permission, `SYSTEM_PERMISSION_VERSION` stays 26**).
- `GET /api/recruitment/candidates/:candidateId/background-verification`
  now also returns `stage`, `decision` and server-computed `eligibility`
  (`proceedWithoutBgv` / `initiateBgv` allow+code) used by the UI.

## Conversion gate composition (27.13/27.15 preserved + waiver)

`evaluateBgvForConversion` was refactored onto the pure
`composeConversionBgvEligibility` with **identical 27.15 branches** plus one
addition: required + **no case** + `PROCEEDED_WITHOUT_BGV` → `{ required:
true, satisfied: true, waived: true }` (audited HR acknowledgement). An
existing case keeps its original meaning; a waiver never overrides an
in-progress or HOLD/CANCELLED case. `BGV_INITIATED` alone is NOT a clearance.

## UI (`CandidateBgvDecisionSection.jsx`, rendered by `CandidateBgvPanel`)

- Candidate detail page (`/app/recruitment/candidates/:candidateRef`).
- No decision + eligible + `BACKGROUND_VERIFICATION_MANAGE`: two labelled
  buttons. “Proceed Without BGV” opens the reusable `Modal` with the four
  acknowledgement points, optional reason (300 max), Cancel / Confirm.
  “Initiate BGV” posts directly with busy/disabled states.
- Persisted states render refresh-safe badges: amber **BGV Not Requested**
  (“has NOT been BGV cleared”, reason, timestamp) or green **BGV Requested**
  (next-product-step handoff note).
- Pre-selection candidates show an informational line only; backend remains
  the authority.
- MongoDB is the source of truth — state survives refresh/reopen.
- Self-healing: after every submit attempt (success or a 409 conflict caused
  by a stale page/tab), the section re-fetches the authoritative summary so
  the persisted badge replaces the buttons without a manual refresh.

## Automated QA

- New hermetic suite `Backend/test/bgvDecision.test.js` (19 tests): pure
  rules, composition, service idempotency/conflict/tenant-isolation/audit/
  no-stage-mutation. Added to `test:all` and `test:rms`;
  script `npm run test:bgv-decision`.
- RCA hotfix in `test/bgvQueue.test.js`: the fixture used a fixed
  `2026-08-28` start date that aged past `BGV_POLL_MAX_WINDOW_MS` (7 days)
  on 2026-09-04, turning two poll tests red; fixture now uses a relative
  “one hour ago” date.
- Result at delivery: `test:all` = **829/829 pass**.

## Manual localhost acceptance

See the delivery report / TESTING section: URLs
`http://localhost:5173` (frontend, Vite) proxying `/api` to
`http://localhost:5000` (backend). Tests A–G cover visibility, cancel,
confirm-without, initiate, idempotency, ineligible candidate, permissions.

## Limitations (by design, Phase 30.1 boundary)

No pricing/catalogue (30.2), no order/payment/Razorpay (30.3), no candidate
secure link/consent (30.4), no document collection (30.5), no verifier
accounts (30.6), no assignment/workbench (30.7–30.9), no QA/report (30.10),
no SLA/ops (30.11). Existing 27.15 tenant-internal BGV is unchanged.
