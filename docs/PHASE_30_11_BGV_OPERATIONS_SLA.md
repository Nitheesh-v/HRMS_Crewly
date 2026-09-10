# Phase 30.11 — BGV Operations, SLA, Audit & Notifications

> Internal operations visibility for the Phase 30 BGV pipeline. This is **NOT**
> a hiring-decision dashboard, **NOT** a tenant surface, and **NOT** a second
> state machine. Phase 30 is **NOT complete** — 30.12 remains mandatory.

## 1. Scope delivered

| Area | What shipped |
|---|---|
| Ops dashboard | Derived counts + drill-down queues for 11 states, server-side paging (cap 50), filters (state/check/verifier/order ref/SLA), age sort |
| SLA | `BgvSlaPolicy` singleton (5 check types, NO seeded defaults), pure `bgvSlaRules`, statuses ON_TRACK / DUE_SOON / OVERDUE / PAUSED / COMPLETED / SLA_NOT_CONFIGURED |
| Verifier workload | Per-verifier assigned/in-progress/waiting-candidate/waiting-third-party/submitted-QA/overdue counts + status + specialisations (human planning only) |
| Reminders | Consent / submission / info / verifier-SLA / QA reminders through the existing EmailDelivery outbox, new `email-bgv30-reminder` job, bucketed deterministic event keys |
| Reconciliation | `npm run bgv:reminders:reconcile` (bounded, idempotent) — Mongo is the source of truth |
| UI | `/super-admin/bgv-ops` (Overview / Queues / Workload / SLA settings), dark Crewly tokens, Lucide, drill-down links to Assignments + QA |

## 2. Derived states (no competing state machine)

Every row is computed on read from authoritative documents; nothing new is stored:

| Ops state | Derived from |
|---|---|
| `AWAITING_CONSENT` | PAID order, no `BgvCollectionCase` (30.4) |
| `AWAITING_CANDIDATE_SUBMISSION` | case exists, `status != SUBMITTED` (30.5) |
| `UNASSIGNED` | submitted case, no CURRENT `BgvCheckAssignment` (30.7) |
| `IN_PROGRESS` | assignment and/or verification `IN_PROGRESS` (30.7/30.8) |
| `AWAITING_CANDIDATE` / `AWAITING_THIRD_PARTY` | verification state (30.8/30.9) |
| `AWAITING_QA` | verification `SUBMITTED` + `qa.status PENDING` (30.10) |
| `QA_RETURNED` / `APPROVED` | verification `QA_RETURNED` / `qa.status APPROVED` (30.10) |
| `REPORT_READY` / `RELEASED` | latest `BgvFinalReport.status` (30.10) |

Unpaid orders never appear: the only commercial gate consumed is
`isCommerciallyAuthorized(order)` (`status === 'PAID'`) — **never**
`razorpayPaymentId` or any amount (payment future-proofing).

## 3. SLA semantics (documented decisions)

- **Clock start** = the LATER of `case.submittedAt` (30.5 freeze) and
  `assignment.assignedAt` (30.7). Before either, nobody is accountable;
  `UNASSIGNED` rows instead show submission age vs the optional
  `unassignedTargetHours`.
- **Pause**: time while `AWAITING_CANDIDATE` is excluded from accountable
  time using 30.9 info-request intervals (`requestedAt → respondedAt/
  resolvedAt/cancelledAt`, open interval pauses until now) when
  `pauseOnCandidateWait` (default true). **Third-party waits do NOT pause** —
  chasing external sources is the verifier's job (explicit policy choice).
- **Completed** (report generated/released or QA approved) stops the clock →
  `COMPLETED` (late completions remain visible via accountable time).
- **Not configured**: no policy document, or a missing per-check target ⇒
  `SLA_NOT_CONFIGURED` shown explicitly. No defaults are seeded anywhere.
- No countdowns are stored; the backend recomputes on every request; the
  frontend has **no timers** — refresh re-derives.
- Escalation is indicator-only (`OVERDUE` + days). Nothing auto-rejects,
  penalises, reassigns, or changes conclusions.

Config API: `GET/PUT /api/super-admin/bgv-ops/sla` (PUT requires
`bgv-operations:manage`, validates exactly the 5 check types, whole hours
1–720, dueSoon ≤168, full-replacement targets map; the write is the **only**
new audit row: `BGV_SLA_POLICY_UPDATED`, safe metadata).

## 4. Reminders & queue security

- Scan (reconcile script) → `requestEmailDelivery('email-bgv30-reminder')`
  on the existing EMAIL queue. **No new queues, no QueueScheduler** (the
  codebase has none), no repeatable jobs.
- Cadence via deterministic buckets in the event key
  `bgv30-<kind>-<orderId>-<checkType|ORDER>-<requestId|na>-b<bucket>`
  (unique on `EmailDelivery.eventKey`): candidate kinds 48h buckets, max 3;
  verifier SLA daily, max 5, only when DUE_SOON/OVERDUE; QA daily, max 2.
  Re-runs collapse to `duplicate: true`. Delivery is honestly
  **at-least-once** — exactly-once is never claimed.
- **Payloads are references only**: `{orderId, kind, checkType, requestId,
  bucket}` — never tokens, portal URLs, PII, documents, notes, report
  content or HTML.
- The worker **re-fetches Mongo and skips stale** milestones
  (ALREADY_DECIDED / ALREADY_SUBMITTED / ALREADY_RESPONDED /
  QA_NO_LONGER_PENDING / CHECK_NO_LONGER_ACTIVE / SLA_NO_LONGER_RED /
  ORDER_INACTIVE) → delivery marked STALE.
- **Portal tokens rotate only at dispatch**, only when no active unexpired
  token exists, hash-only storage; rotation carries the completed CONSENTED
  decision and never reopens a decline. No "Copy Raw Portal Link" anywhere.
- SMTP failure ⇒ EmailDelivery FAILED/retry only — business state is never
  mutated by mail. Redis outage loses nothing: Mongo remains the source of
  truth and the reconcile script re-enqueues bounded work.
- Recipients: candidates get candidate comms from Crewly (sender
  `Crewly Background Verification`, "operated by Infolexus", never asks for
  payment); verifier nudges go to the assigned ACTIVE verifier; QA nudges go
  to platform users holding `bgv-qa:review`. Tenant HR receives **nothing**
  new from 30.11 — no internal details leak to HR.

## 5. Authorization & boundaries

- Routes mount under `requireSuperAdmin + permit('bgv-operations:read' |
  'bgv-operations:manage')`; `bgv-operations:*` is SUPER_ADMIN-only (via
  `*`). Tenant JWTs die at the platform gate before any DB access; verifier
  and QA principals live on separate stacks/permissions.
- Verifier workload is **never** exposed to tenant HR; the tenant continues
  to see only the 30.x customer-facing progress states.
- No revenue/profitability/compensation/billing analytics, no ML/risk
  scoring — counts, workload and SLA only.
- BGV authorization is **never cached**. The dashboard does no caching in
  v1 (small derived scans; a short-lived ops cache can be added later —
  fail-open to Mongo, no sensitive content, no KEYS/FLUSH).
- Indexes: existing ones cover the scans (`bgvOrder` indexed on every BGV
  model, `{bgvOrder,checkType,activeKey}` partial-unique, `status` indexed
  on info requests) — no new indexes were needed, so none were added.

## 6. Files

Backend (new): `src/services/bgv/bgvSlaRules.js`,
`src/services/bgv/bgvOperationsDashboardService.js`,
`src/services/bgv/bgvReminderService.js`, `src/models/BgvSlaPolicy.js`,
`src/controllers/bgvOperationsDashboardController.js`,
`scripts/bgv-reminder-reconcile.js`, `test/bgvOperations.test.js` (26 tests).
Backend (edited): `queueConfig.js` (EMAIL_BGV30_REMINDER),
`emailProcessor.js` (key whitelist + `emailBgv30Reminder` handler),
`mailer.js` (`bgv30ReminderEmail`), `superAdminRoutes.js` (5 routes),
`emailDelivery.test.js` (10→11 job names), `package.json` (scripts).
Frontend (new): `src/pages/admin/SuperAdminBgvOpsDashboardPage.jsx`.
Frontend (edited): `superAdminService.js` (+`put` helper, 5 methods),
`AppRoutes.jsx` (`bgv-ops`), `SuperAdminLayout.jsx` (nav, Gauge import).

## 7. Verification

- `npm run test:all` → **1021/1021 pass** (995 baseline + 26 new).
- `npm run test:bgv-operations` → 26/26.
- `npm run build` (Frontend) → success (1.14s; pre-existing chunk-size
  warning only).
- Redaction scan over all new/changed files: no PAN/Aadhaar/UAN/bank/doc
  content/selfie/token/URL/payment/credential strings.
- Reminder reconcile + mail sending are **BLOCKED in the Arena sandbox**
  (no Redis/SMTP/Mongo daemons) — covered hermetically by tests; run
  `npm run bgv:reminders:reconcile` on localhost acceptance.

## 8. Phase 30 status

30.1–30.11 delivered. **Phase 30 is NOT complete: 30.12 is mandatory and
NOT implemented.** DigiLocker API integration and prepaid/monthly/
subscription/postpaid billing are NOT implemented.
