# Phase 28.5 — Interview + Offer Scheduled (Delayed) Jobs

One-time future execution for the two recruitment time-based flows:
**interview reminders** and **offer expiry (reminder + expiry)**. Both run
on the reserved **SCHEDULED** queue using BullMQ v6.3.1 native delayed
jobs (`queue.add(name, data, { delay })`) — no `QueueScheduler`
(deprecated, and not needed for one-time delays), no per-feature queues,
no cron, no long `setTimeout`.

## Core flow

```
Interview created/rescheduled (interviewService)
  └─ scheduleInterviewReminder()  →  SCHEDULED queue: interview-reminder (delayed)
                                          │ at dispatchAfter (24h → 1h → immediate)
Scheduled worker (5th worker, concurrency SCHEDULED_WORKER_CONCURRENCY)
  └─ re-fetch Interview by {_id, companyId} → status + schedule version +
     reminderDispatch checks → claim (PENDING/FAILED → CLAIMED)
  └─ deliver via the 28.3 email queue (EMAIL_INTERVIEW_CANDIDATE /
     EMAIL_INTERVIEW_INTERVIEWER with eventType REMINDER)
  └─ mark reminderDispatch DELIVERED (or FAILED on dispatch failure → retry)

Offer sent (offerService)
  └─ scheduleOfferJobs()  →  SCHEDULED queue:
        offer-expiry-reminder (delayed, only when expiry − 48h is still future)
        offer-expire        (delayed, at terms.expiryDate; immediate if past)
Scheduled worker
  └─ reminder: re-fetch Offer by {_id, companyId} → SENT/VIEWED + expiry
     version match → EMAIL_OFFER_REMINDER (non-sensitive nudge, 28.3 queue)
  └─ expiry: re-fetch → call the EXISTING atomic expireOfferIfDue service
     (never an inline status write) → history/audit/tokens/pipeline handled
     by that service exactly as before
```

**Intent vs transport** — MongoDB is the scheduling truth
(`Interview.scheduledStartAt` + `reminderDispatch`,
`OfferLetter.terms.expiryDate`). Redis only knows "run at X". If
`queue.add` fails, Redis is lost, or the prefix changes,
`npm run scheduled:reconcile` (also run at worker startup) re-derives
every job from Mongo with deterministic ids. There is no synchronous
reminder fallback, and no job data outside Mongo/Redis.

## Job ids (deterministic, colon-free, Mongo-reconstructable)

```
interview-reminder-<interviewId>-<scheduledStartAtMs>
offer-reminder-<offerId>-<expiryDateMs>
offer-expire-<offerId>-<expiryDateMs>
```

The canonical timestamp **is** the version: reschedule / revised expiry
→ new timestamp → new job id. Superseded jobs are removed
best-effort (waiting/delayed/failed only) at the moment of the business
transition, **and** are validated stale at execution — removal is never
the only protection (remove can race execution).

## Payloads (references only — strictly validated by the worker)

```
interview-reminder: { companyId, interviewId, scheduledStartAtIso, correlationId }
offer-reminder:     { companyId, offerId, expiryDateIso, correlationId }
offer-expire:       { companyId, offerId, expiryDateIso, correlationId }
```

Unknown keys are rejected by the worker validator; names, emails,
meeting links, tokens, and compensation never enter the payload (or any
log line).

## Reminder policies (existing business rules preserved)

- **Interview** — the pre-existing `reminderDispatchAfter` policy: ONE
  reminder per schedule at **24h before**, or **1h before** when 24h is
  already past, or **immediately** when both are past but the interview
  is still upcoming. No new multi-reminder scheme was added.
- **Offer** — ONE nudge at **expiry − 48h**
  (`OFFER_REMINDER_OFFSET_HOURS`, default 48, clamped 1–168). If the
  offer is sent inside that window (expiry < 48h away) **no reminder is
  scheduled** — the offer email itself is the notice (documented
  policy). The lazy read-time expiry sweep stays as an idempotent
  backstop (same atomic transition — no double-fire possible).

## Stale-state protection (defense in depth)

Every worker run re-fetches Mongo by `{_id, companyId}` (tenant-scoped)
and skips with a safe reason (job completes, **no retry spam**):

| Job | Skip when |
| --- | --- |
| interview-reminder | not found (incl. cross-tenant id) · status CANCELLED/COMPLETED/NO_SHOW/IN_PROGRESS (terminal for reminders) · `scheduledStartAt` ≠ job version (reschedule) · interview already started · `reminderDispatch` DELIVERED · claim lost to a terminal state |
| offer-reminder | not found · status not SENT/VIEWED (ACCEPTED/REJECTED/WITHDRAWN/EXPIRED…) · `terms.expiryDate` ≠ job version (revised) · already expired |
| offer-expire | not found · expiry version mismatch (revised) · `expireOfferIfDue` no-op → ALREADY_EXPIRED / TERMINAL_STATE (ACCEPTED never expires) / NOT_DUE |

Transient Mongo/Redis or email-dispatch failures **throw** → BullMQ
retries (3 attempts, 2s exponential). Stale/terminal states never
consume retries.

## Offer expiry — atomic service only

The worker calls the existing `expireOfferIfDue({ offer,
requestContext: null })` — status guard + conditional
`findOneAndUpdate` (two racing firings → one transition) + pipeline
OFFER→SELECTED (rollback) + token revocation (restore) + offer history +
audit `OFFER_EXPIRED` + owner notification. The worker writes no offer
status directly. `ACCEPTED` never expires; `REJECTED`/`WITHDRAWN` skip.

## Token-safe email behavior (§31 — chosen behavior)

- **No raw token in SCHEDULED or EMAIL jobs**, ever.
- The offer **SEND** email is intentionally **synchronous** (pre-existing
  28.3 decision): its portal URL carries the raw secure token, which
  28.3 policy forbids in the email queue. Unchanged.
- The offer **REMINDER** email is a **non-sensitive nudge**
  (`sensitive: false`): company, role, offer reference, expiry date, and
  "use the secure link from your original offer email" — **no portal
  URL, no token, no compensation**.
- Interview reminder emails reuse the 28.3 interview email jobs with
  `eventType: REMINDER` (new template variant; `isInterviewEventStale`
  allows REMINDER only for SCHEDULED/RESCHEDULED with a matching
  schedule version). EventKey idempotency (`buildEventKey`) makes each
  reminder one-shot per schedule even across crash/replay boundaries.

## Worker + reconciliation

- 5th BullMQ worker in the existing `npm run worker` process
  (system, email, resume, ats, **scheduled** — one dedicated ioredis
  connection each). `SCHEDULED_WORKER_CONCURRENCY` default 4, clamped
  1–10 (jobs are light: Mongo validation + email-intent dispatch / one
  atomic transition).
- `npm run scheduled:reconcile` — bounded scans (interviews: next 14
  days, reminderDispatch PENDING/FAILED/CLAIMED; offers: next 90 days,
  SENT/VIEWED), deterministic ids, slot-prep clears dead FAILED jobs,
  idempotent, **not** exposed over HTTP. Also runs (non-fatally) at
  worker startup.
- No public scheduler HTTP API; no audit spam (no "job queued" rows —
  delivery audit lives on EmailDelivery; `OFFER_EXPIRED` keeps its
  existing history/audit/timeline).
- Existing timers reviewed: the `meetingController` 60s interval (Meeting
  domain) and subscription lifecycle/watchdog are separate features —
  kept, nothing retired. Legacy `utils/emailQueue.js` drain (used only
  by the legacy `notifyPref` helper) is superseded by 28.3 — unchanged.

## Verification

Hermetic (`npm run test:scheduled`, 37 tests, no Redis/Mongo):
job-id builders (deterministic/colon-free/version-aware/malformed),
delay calc + past-timestamp policy, eligibility (interview statuses,
offer statuses), never-throw scheduling, all worker skip paths
(STALE_SCHEDULE, TERMINAL_STATE, INTERVIEW_STARTED, ALREADY_REMINDED,
IN_FLIGHT_OR_DONE, NOT_FOUND, STALE_EXPIRY, EXPIRED, ALREADY_EXPIRED,
NOT_DUE), retry propagation (deliver/dispatch failure → throw),
claim/DELIVERED/FAILED lifecycle, email-queue guards
(`isInterviewEventStale` REMINDER, `EMAIL_OFFER_REMINDER` payload
validation), reconcile selection + bounded windows + idempotent ids,
config clamps.

Regression (all green after 28.5): redis 12 · bullmq 16 · email 16 ·
processing 13 · resume-parsing 9 · ats 12 · career 11 · candidates 13 ·
pipeline 9 · interviews 9 · interview-evaluation 10 · offers 10 ·
pre-onboarding 10 · conversion 5 · recruitment-analytics 3 · bgv 4 ·
phase27-security 9 · requisition-approval 6 · requisition-job 7.
Frontend: **no frontend changes** in 28.5 (worker/API phase).

## Manual live ladder (developer's machine — Windows PowerShell)

```powershell
# Terminal 1 — API
cd C:\Users\megal\Desktop\HRMS\Backend
npm run dev

# Terminal 2 — worker (now 5 workers: system, email, resume, ats, scheduled)
npm run worker:dev
```

1. **Startup** — worker logs `scheduled concurrency=4`, `SCHEDULED
   processors ready`, `Scheduled reconcile: interviews queued=0/0,
   offer reminders=0, expiries=0`, then `Workers online`.
2. **Immediate interview reminder** — via the API, create an interview
   starting **~15 minutes from now** (both 24h and 1h offsets are past
   → the existing policy fires immediately). Worker: `interview-reminder`
   active → completed; email worker: `email-interview-candidate`
   (eventType REMINDER) → MOCK completed; `Interview.reminderDispatch`
   = DELIVERED.
3. **Reschedule** — reschedule that interview to a new time. Old job id
   removed (log `removed-delayed`/`absent`), new PENDING intent with a
   new id; the old job — if it had fired — would skip STALE_SCHEDULE.
4. **Cancel / complete** — cancel or complete the interview before the
   reminder fires → job skips TERMINAL_STATE (or was removed).
5. **Offer expiry (real transition)** — create + send an offer with
   expiry **~5 minutes from now** (validation allows any future date
   within the cap). Worker fires `offer-expire` at expiry → offer
   EXPIRED, history `OFFER_EXPIRED`, pipeline OFFER→SELECTED, secure
   tokens revoked.
6. **ACCEPTED never expires** — accept another live offer via the
   candidate portal before its expiry → its `offer-expire` job fires
   later and skips TERMINAL_STATE; the offer stays ACCEPTED.
7. **Withdraw** — withdraw a sent offer → jobs removed; the expiry job
   (if fired) skips.
8. **Redis outage** — stop the worker, run
   `npm run scheduled:reconcile` → jobs re-derived from Mongo with the
   same ids (idempotent).
9. **No PII in Redis** — inspect any SCHEDULED job payload: ids +
   companyId + ISO timestamp + correlationId only.

## Security model

- Multi-tenant: every worker re-load is `{_id, companyId}` (interview,
  offer, candidate, interviewers); a cross-tenant id is NOT_FOUND, never
  acted on. Tenant ids live in job payloads, never in the queue prefix.
- No tokens/PII/links in SCHEDULED payloads or logs; the token-bearing
  offer-SEND email stays synchronous by design (28.3 policy).
- Expiry is only ever the existing atomic service — no new write path,
  no status written inline, no race window.
- No new public endpoints (scheduler is internal + CLI only).
- Retries are bounded; stale/terminal states complete as SKIPPED.

## Known operational notes

- Redis Cloud dev database is `volatile-lru`: under memory pressure
  BullMQ keys could evict. Pre-prod ops item (documented since 28.1):
  switch to `noeviction` — we never reconfigure the managed provider.
- The lazy offer-expiry read sweep (`getOfferOptions` / public portal
  pre-access check) remains as a backstop; it is idempotent with the
  scheduled job (same atomic conditional update).
- `reminderDispatch.attempts`/`lastError` give per-interview retry
  visibility; FAILED intents are reconcile targets.

## 28.6 handoff (Pre-Onboarding + BGV processing)

Carry-over candidates for the next phase (NOT built in 28.5):

1. **Pre-onboarding** — `preOnboardingService` document-review work and
   the `EMAIL_PREONBOARDING_DOC_DECISION` emails already run through
   28.3; if document *verification* becomes async (scanner/OCR), reuse
   the 28.4 RESUME-queue pattern (deterministic versioned ids, lease
   recovery, reconcile CLI) on a new reserved queue — do not add ad-hoc
   timers.
2. **BGV** — `bgvService` status transitions are synchronous today; if
   vendor polling is introduced, follow the SCHEDULED pattern for any
   delayed follow-ups (delayed one-time job + Mongo intent + reconcile),
   keeping vendor credentials out of job payloads.
3. **Watch items** — keep the 5-worker process healthy (one ioredis per
   worker); if queue count grows, split workers per phase with the same
   connection-ownership rules as 28.2.
