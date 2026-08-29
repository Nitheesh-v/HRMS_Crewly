# Phase 28.3 — Production Email Queue + Async Mail Delivery

Status: COMPLETE (email queueing + delivery; no 28.4 work started — handoff at the end)

## Core flow

```
Business service (API process)
  1. commit business state to MongoDB (first)
  2. dispatchEmailDelivery()          → EmailDelivery row (PENDING) + payload refs only
  3. enqueueJob(email, …, jobId)      → BullMQ email queue (deterministic id email-<deliveryId>)
  4. HTTP response returns            → business success, NEVER "email sent"
        │
        ▼  (BullMQ, crewly:<env>:email:*)
Email worker (worker process, 28.2 dual-worker)
  5. strict payload validation (job name + allowed keys only)
  6. atomic claim (PROCESSING, re-entrant for retries)
  7. reload authoritative data UNDER companyId (recipient email included)
  8. stale-state check against CURRENT state
  9. existing mailer (src/utils/mailer.js — SMTP or MOCK, unchanged)
 10. mark delivery SENT / FAILED / STALE (Mongo is the audit of record)
```

Deliveries are **at-least-once**: the claim + stale checks + eventKey
dedupe guarantee the same logical event is never sent twice, and a
worker crash simply leaves the job for BullMQ to re-process.

## What was implemented

| File | Purpose |
| --- | --- |
| `Backend/src/models/EmailDelivery.js` | Compact outbox model — `eventKey` unique, references only, no body/secrets |
| `Backend/src/services/emailDeliveryService.js` | `dispatchEmailDelivery` (PENDING-first, E11000 race), `requestEmailDelivery` (never throws), `claimEmailDelivery`, `markEmailDelivery`, `reconcileStuckEmailDeliveries`, `buildEventKey` |
| `Backend/src/workers/emailProcessor.js` | 7 handlers + strict payload validator + SMTP failure classifier + interview stale predicate |
| `Backend/src/workers/index.js` | 28.2 worker extended: SYSTEM + EMAIL workers in one process; failed email job → `FAILED/RETRIES_EXHAUSTED` on the delivery |
| `Backend/src/config/queueConfig.js` | +7 `EMAIL_*` job names, `EMAIL_JOB_OPTIONS` (attempts 5, exponential backoff), `parseEmailWorkerConcurrency` (default 2, clamped 1–10) |
| `Backend/scripts/email-reconcile.js` | `npm run email:reconcile` — dev/ops CLI, no HTTP endpoint |
| Migrated call sites | `candidateApplicationJobs.js`, `candidateApplicationService.js`, `interviewNotificationDispatcher.js`, `candidatePipelineService.js` (manual SEND_EMAIL), `publicOfferService.js` (candidate decision), `offerService.js` (withdrawal), `preOnboardingService.js` (document decisions ×3) |
| `Backend/test/emailDelivery.test.js` | Hermetic DI-stub suite (15 tests, no Redis/Mongo) |

## Queued emails (7 jobs)

| Job | Trigger | Event key (dedupe identity) |
| --- | --- | --- |
| `email-application-received` | Public application submitted | `APPLICATION_RECEIVED:<candidateId>` |
| `email-pipeline-update` | Stage transition / manual SEND_EMAIL | `PIPELINE_UPDATE:<candidateId>:<stage>[:<ts>]` — the timestamp part exists ONLY for the manual bulk action (an explicit resend is a distinct event) |
| `email-interview-candidate` | Interview scheduled / rescheduled / cancelled / status change | `INTERVIEW_<EVENT>:<interviewId>:<scheduleVersion>` |
| `email-interview-interviewer` | Interviewer assignment + same events | `INTERVIEWER_<EVENT>:<interviewId>:<interviewerId>:<scheduleVersion>` |
| `email-offer-decision` | Candidate accepts / rejects (public portal) | `OFFER_DECISION:<offerId>:<ACCEPTED\|REJECTED>` |
| `email-offer-withdrawn` | HR withdraws a sent/viewed offer | `OFFER_WITHDRAWN:<offerId>` |
| `email-preonboarding-doc-decision` | Document verified / resubmission required / ready-to-join | `PREONBOARDING_DOC:<preOnboardingId>:<documentId>:<DECISION>:v<version>` ; ready-to-join uses `PREONBOARDING_READY:<preOnboardingId>` |

`scheduleVersion` is the ISO `scheduledStartAt` of the event — reschedule
#2 supersedes reschedule #1.

Job payloads carry **references only** (entity IDs + `deliveryId` +
`correlationId` + `companyId` — the last three added by dispatch). No
recipient email, no rendered HTML, no tokens, no SMTP credentials. The
worker validator REJECTS any unknown key — there is deliberately no
arbitrary-email job and no public send-email endpoint.

## Intentionally left SYNCHRONOUS (token/secret emails)

| Email | Why synchronous |
| --- | --- |
| Offer candidate access (`offerService` access email) | Body contains the raw portal token (`secureToken`); token must never pass through Redis |
| Pre-onboarding candidate access | Portal token in the URL |
| Account setup (candidate join) | Setup-URL token |
| Password reset (user + super admin) | Reset token; time-critical security email — must not sit in a queue |
| 2FA code | Code is a secret, short-TTL |
| Welcome email | Plaintext temporary password |
| Company onboarding email | Temporary admin password |
| Application receipt (HR-facing) | Out of 28.3 scope (documented, unchanged) |

These keep the existing token architecture untouched — the queue was not
allowed to weaken it. In-app notifications (`notifyUser` /
`notifySmart` / `notifyRoles`) are a separate channel and remain intact.

## Outbox model (`EmailDelivery`)

- Fields: `companyId`, `jobName`, `eventType`, `eventKey` (unique),
  `entityType`, `entityId`, `recipientType`, `recipientReference`,
  `payload` (refs only), `status`, `queueJobId`, `deliveryMode`,
  `attemptCount`, `lastFailureCategory`, timestamps.
- Statuses: `PENDING → QUEUED → PROCESSING → SENT | FAILED | STALE`,
  plus `FAILED_TO_QUEUE` (intent persisted, Redis unavailable).
  There is no `RETRYING` status: a retry is the same delivery in
  `PROCESSING` with a higher `attemptCount` (BullMQ owns retry state).
- No email body, no secret, no token is ever stored.

## Idempotency (outside Redis)

- The unique `eventKey` (safe parts only — ids, stages, versions, never
  email or tokens) is the logical-event identity. A repeated event
  returns the existing delivery without a second job.
- The worker claim (`findOneAndUpdate` on non-terminal status) makes
  duplicate/replayed jobs safe no-ops; `SENT` is final and can never be
  overwritten.
- Job id is deterministic: `email-<deliveryMongoId>`. BullMQ REJECTS
  custom job ids containing `:` (its key separator), so the id is
  hyphen-joined, not colon-joined (the colon-joined form is still
  used for the Mongo-only `eventKey`). Reconciliation re-adds the
  same job id, so BullMQ's job-id dedupe prevents duplicates even on
  re-runs.

## Retry + failure classification

- `EMAIL_JOB_OPTIONS`: 5 attempts, exponential backoff (base 2s, factor
  2, max 100s ceiling per job config), keep 100 completed / 50 failed.
- Retryable (job throws → BullMQ backs off): `SMTP_CONNECTION_ERROR`,
  `SMTP_TIMEOUT`, `UNKNOWN`.
- Terminal (delivery marked `FAILED`, no hammering): `SMTP_AUTH_ERROR`,
  `RECIPIENT_REJECTED`, `MAIL_CONFIG_MISSING`, `ENTITY_NOT_FOUND`,
  `TENANT_MISMATCH`, `STALE_STATE`, plus `RETRIES_EXHAUSTED` after the
  final attempt (written by the worker's failed handler).

## Stale-state protection (worker re-fetches, never trusts the queue)

- Application: candidate still references the job and is `ACTIVE`.
- Pipeline: current stage still equals the event's stage.
- Interview: event type must match current status, and for
  scheduled/rescheduled events `scheduledStartAt` must equal the
  `scheduleVersion` — a cancelled interview skips its invitation, a
  newer reschedule supersedes the older email. Interviewer emails also
  require the interviewer still assigned.
- Offer decision: offer status still equals the decision.
- Offer withdrawn: offer still `WITHDRAWN`.
- Pre-onboarding doc: document status + `currentVersion` +
  `preOnboarding` parent must match (parent mismatch → `TENANT_MISMATCH`).
- Ready-to-join: pre-onboarding still `READY_TO_JOIN`.
- Every miss marks the delivery `STALE` (category `STALE_STATE`) and
  sends nothing.

## Tenant validation

- Every worker lookup is `{ _id, companyId }` — never bare `findById`.
- The worker validates job name + payload shape before any work;
  payloads are data, never code — nothing in a job can trigger dynamic
  execution.

## Reconciliation

- `npm run email:reconcile` (optionally `--all` to ignore the 60s
  minimum age) — scans `PENDING` orphans, `FAILED_TO_QUEUE`
  deliveries, and **stale `QUEUED`** deliveries (a job can die in
  Redis — e.g. retries exhausted while Mongo was unreachable —
  leaving the record stuck) and re-enqueues them with their original
  deterministic job id. **BullMQ never re-creates an already-used
  job id** (a re-add returns the existing job as a no-op), so before
  adding, reconciliation removes the previous job **if and only if
  it is FAILED**; alive jobs (waiting/active/delayed/completed) are
  left untouched — that is the dedupe, and the 60s min-age skips
  healthy in-flight jobs. It is a developer/ops CLI — there is NO
  unauthenticated (or authenticated) HTTP endpoint for it — and it
  requires Redis + MongoDB configuration.
- There are no Mongo transactions in these services, so the outbox
  pattern (intent-after-commit + reconciliation) is the consistency
  mechanism. Enqueue failure NEVER rolls back business state and there
  is no uncertain synchronous fallback.

## MOCK mode

MOCK mode exercises the full queue path (intent → queue → worker →
mailer → SENT record). `sensitive: true` suppresses link-bearing bodies
in MOCK logs exactly as before.

## Tests

Hermetic (no Redis, no Mongo):

```
cd Backend
npm run test:email            # 15 tests: event keys, payload validation,
                              # secure-key exclusion, classification,
                              # stale predicates, dispatch idempotency,
                              # FAILED_TO_QUEUE, claim re-entrancy,
                              # SENT-clobber guard, cross-tenant,
                              # reconciliation
```

Full regression (all hermetic suites, 170 tests) — run each line:

```
npm run test:candidates
npm run test:pipeline
npm run test:interviews
npm run test:interview-evaluation
npm run test:offers
npm run test:pre-onboarding
npm run test:career
npm run test:conversion
npm run test:phase27-security
npm run test:bullmq
npm run test:redis
npm run test:ats
npm run test:bgv
npm run test:recruitment-analytics
npm run test:resume-parsing
npm run test:requisition-approval
npm run test:requisition-job
```

Live opt-in (developer machine, isolated prefix, exact cleanup — never
FLUSHALL/FLUSHDB): `npm run test:bullmq:live`.

Manual ladder (Redis + Mongo + MOCK mailer):

1. **Application happy path** — submit a public application; response
   returns immediately; `EmailDelivery` row ends `SENT (MOCK)` after
   the worker picks the job up.
2. **STOPPED WORKER (mandatory)** — start API without the worker,
   submit an application → application succeeds, delivery stays
   `QUEUED`; start the worker → it drains. Restart the API with
   `REDIS_ENABLED=false` → application still succeeds, delivery
   `FAILED_TO_QUEUE`.
3. **Duplicate event** — re-trigger the same logical event (same
   eventKey) → no second job, delivery untouched.
4. **Stale interview** — schedule then cancel an interview before the
   worker runs → invitation skipped, delivery `STALE`.
5. **Redis outage + reconciliation** — stop Redis after a submit,
   restart Redis, `npm run email:reconcile` → re-enqueued once;
   re-run → no duplicates.
6. **SMTP failure** — point `SMTP_HOST` at a dead host → retries with
   backoff, then `FAILED/RETRIES_EXHAUSTED`.
7. **Reconciliation re-run** — run the script twice; the second run
   requeues nothing.

## Verification performed

- `node --check` on every changed file
- npm audit: 0 vulnerabilities
- Frontend build: passes (no frontend changes, no BullMQ/Redis dep added)
- Secret scan of all changed files: no REDIS_URL/SMTP credentials/
  secureToken/resetToken/offerToken/setupToken values
- `git status`: `.env` never staged

## Limitations

- At-least-once delivery (documented, not hidden).
- SMTP is the single global Crewly configuration — per-company SMTP
  does not exist yet (would be a 28.4+ item).
- `CANDIDATE_JOINED` has no dedicated email today: the join flow sends
  the synchronous account-setup email (token) + in-app notification +
  timeline entry. Nothing to queue.
- BGV emails are not implemented, so there was nothing to migrate.
- Queue-Redis eviction policy (managed provider) is documented as an
  ops prerequisite, not configurable from the app.

## 28.4 handoff (NOT started — context only)

- **Queue state**: `system` + `email` queues, prefix `crewly:<env>`,
  one worker process, system concurrency `WORKER_CONCURRENCY` (2),
  email concurrency `EMAIL_WORKER_CONCURRENCY` (2, clamped 1–10).
- **Processor entry**: `registerEmailProcessors` in
  `src/workers/emailProcessor.js`; registry dispatch in
  `src/workers/registry.js`.
- **Model**: `EmailDelivery` (statuses + `eventKey` unique above).
- **Event names**: `APPLICATION_RECEIVED`, `PIPELINE_UPDATE`,
  `INTERVIEW_<EVENT>`, `INTERVIEWER_<EVENT>`, `OFFER_DECISION`,
  `OFFER_WITHDRAWN`, `PREONBOARDING_DOC`, `PREONBOARDING_READY`.
- **Migrated callers**: the seven call sites listed in "What was
  implemented".
- **Still synchronous (security)**: the token/password emails in the
  table above — any future queueing of one of them requires Mongo-only
  storage of the encrypted delivery material (spec §7–8), never Redis.
- **Idempotency**: eventKey dedupe + atomic claim + deterministic job
  id — extend the same pattern to any new job.
- **Retry**: `EMAIL_JOB_OPTIONS`; classification in
  `classifyEmailSendFailure` — new failure families must pick a retry
  policy deliberately.
- **Reconciliation**: `scripts/email-reconcile.js` +
  `reconcileStuckEmailDeliveries` (60s minAge, `--all` override,
  scans PENDING + FAILED_TO_QUEUE + stale QUEUED). The worker
  process requires Redis AND MongoDB (fail-fast at startup).
- **Stale-state rules**: per-handler predicates in
  `emailProcessor.js` — new handlers must re-fetch and re-check, never
  trust payload state.
- **Tenant validation**: `{_id, companyId}` lookups + strict payload
  validation are mandatory for any new job.
- **Tests**: `test/emailDelivery.test.js` (hermetic, DI stubs) + the
  manual ladder above; live suite stays opt-in with isolated prefix.
- **Candidate 28.4 ideas** (unconfirmed scope): per-company SMTP
  config, receipt emails (HR-facing) onto the queue, delivery status
  surfaced in candidate timeline UI, alerting on `FAILED_TO_QUEUE`
  accumulation, queue-metrics view in admin.
