# Phase 28.4 — BullMQ Resume Parsing + ATS Processing Pipeline

Status: COMPLETE (resume + ATS moved to dedicated queues/workers; no 28.5 work started — handoff at the end)

## Core flow (after 28.4)

```
Business service (API process)
  apply:   commit Candidate + CandidateResume(parsingStatus=PENDING) to Mongo
           dispatchResumeProcessing()   → deterministic BullMQ job (resume queue)
  reproc:  CandidateResume(RETRY_PENDING)  → dispatchResumeProcessing()
  recalc:  ATSResult(recalculationPending) → dispatchATSMatching()
  parse:   processResumeJob COMPLETED      → dispatchATSMatching() (chain)
        │
        ▼  (BullMQ, crewly:<env>:resume:*  /  crewly:<env>:ats:*)
Resume worker (worker process, concurrency RESUME_WORKER_CONCURRENCY, default 1)
  1. strict payload validation (references only)
  2. processResumeJob: atomic Mongo lease claim (single-flight)
  3. extract (PDF/DOCX, unchanged) → deterministic parser (unchanged)
  4. persist COMPLETED / REVIEW_REQUIRED / FAILED (unchanged)
  5. on COMPLETED → dispatchATSMatching()
        │
        ▼  (BullMQ, crewly:<env>:ats:*)
ATS worker (worker process, concurrency ATS_WORKER_CONCURRENCY, default 2)
  6. strict payload validation (references only)
  7. processATSMatch: reload ALL inputs UNDER companyId, verify
     candidate ↔ job ↔ resume ↔ parseResult relationship
  8. fingerprint skip (unchanged) → upsert ATSResult (unchanged)
  9. transitionCandidateStage → ATS_SCREENING (unchanged; NEVER auto-rejects)
```

The **deterministic parser and the ATS engine are unchanged** — 28.4 is an
execution-architecture migration only. The HTTP application no longer waits
for, or even runs, extraction/parsing/scoring.

## What was implemented

| File | Purpose |
| --- | --- |
| `Backend/src/services/resumeProcessingDispatcher.js` | REWRITTEN: local in-memory queue → BullMQ `resume` enqueue. `buildResumeJobId` (deterministic, colon-free), never-throwing `dispatchResumeProcessing`, Mongo-derived `recoverPendingResumeProcessing` |
| `Backend/src/services/atsDispatcher.js` | REWRITTEN: local in-memory queue → BullMQ `ats` enqueue. `buildATSJobId` (deterministic, colon-free), never-throwing `dispatchATSMatching`, Mongo-derived `recoverPendingATSMatching` |
| `Backend/src/services/resumeProcessingService.js` | `processResumeJob` gains `finalAttempt` + `dispatchATS` (DI). Transient (STORAGE/PERSISTENCE) failures with attempts left → **RETRY_PENDING, no history spam**; terminal only on the final attempt or on permanent content errors |
| `Backend/src/workers/resumeProcessor.js` | NEW thin adapter: `RESUME_PARSE` → `processResumeJob`. RETRY_PENDING → throw (BullMQ backoff+retry); terminal → return. Strict payload validator |
| `Backend/src/workers/atsProcessor.js` | NEW thin adapter: `ATS_PROCESS` → `processATSMatch`. Business mismatch → terminal no-op (no retry); infra error → throw (retry). Strict payload validator |
| `Backend/src/workers/index.js` | 28.2/28.3 worker extended to 4 workers: SYSTEM + EMAIL + RESUME + ATS. On startup, after Mongo+Redis are ready, runs both `recoverPending*` (idempotent) |
| `Backend/src/queues/queueFactory.js` | + generic `prepareJobSlot(queue, jobId)` (clears a dead FAILED job before re-add; live jobs untouched) — reused by email + processing reconciliation |
| `Backend/src/services/emailDeliveryService.js` | `prepareEmailJobSlot` now delegates to the shared `prepareJobSlot` (no behavior change) |
| `Backend/src/config/queueConfig.js` | + `RESUME_PARSE`/`ATS_PROCESS` job names, `PROCESSING_JOB_NAMES`, `RESUME_JOB_OPTIONS`/`ATS_JOB_OPTIONS` (attempts 3, exponential 2s), `parseResumeWorkerConcurrency` (default 1, clamp 1–4), `parseATSWorkerConcurrency` (default 2, clamp 1–10) |
| `Backend/src/server.js` | In-process `recoverPending*` REMOVED (moved to worker startup). `closeAllQueues()` added to graceful shutdown (API opens producer queues for email + processing) |
| `Backend/scripts/processing-reconcile.js` | NEW `npm run processing:reconcile` dev/ops CLI (Redis+Mongo, `--all` to bypass the 60s min-age). NOT exposed over HTTP |
| `Backend/src/controllers/atsController.js` | Recalculation: queue-down no longer 503 — the Mongo intent (`recalculationPending`) is the recovery source, so it responds 202 `MATCHING_PENDING` |
| `Backend/src/controllers/resumeParsingController.js` | Reprocess: async `dispatchResumeProcessing` (never throws), passes `parsingRequestedAt` |
| `Backend/src/services/candidateApplicationService.js` | Apply: async `dispatchResumeProcessing` (never throws), passes `parsingRequestedAt` |
| `Backend/package.json` | + `processing:reconcile`, + `test:processing` |
| `Backend/.env.example` | + `RESUME_WORKER_CONCURRENCY=1`, `ATS_WORKER_CONCURRENCY=2` (comments only, no secrets) |
| `Backend/test/processingQueue.test.js` | NEW hermetic DI-stub suite (13 tests, no Redis/Mongo) |
| `Backend/test/resumeParsing.test.js` | Dispatcher/chain tests updated to the BullMQ contract (injected enqueue / dispatchATS stubs) |
| `Backend/test/atsMatching.test.js` | Dispatcher test updated to the BullMQ contract (injected enqueue stub); chain source-scan updated for the DI dispatch |

## Job ids (deterministic, colon-free, Mongo-reconstructable)

BullMQ custom ids may not contain `:`. Both ids are rebuilt from MongoDB
state, so reconciliation never needs a stored job id:

```
resume-parse-<resumeId>-<parserVersion>-<parsingRequestedAtMs>
ats-process-<candidateId>-<parseResultId>-<requestEpochMs>
```

- A **new parse request** (apply / reprocess / lease-expiry) sets a new
  `parsingRequestedAt` → a fresh job id, so intentional reprocess is never
  blocked by the old job.
- A **manual ATS recalculation** sets a new `recalculationRequestedAt` → fresh
  id. The automatic chain uses the parse result's `completedAt`.
- The **same logical job** re-delivered (BullMQ retry/redelivery) keeps its id,
  so BullMQ dedupes it. No PII, no file names, no secrets in the id.

## Payloads (references only — validated again by the worker)

```
resume-parse: { companyId, candidateId, resumeId, parserVersion, correlationId }
ats-process:  { companyId, candidateId, jobId, resumeId, parseResultId,
                engineVersion, trigger, actorId?, correlationId }
```

Unknown keys are **rejected** (defense against PII/data smuggling into Redis).
The worker reloads every document under the job's `companyId` and verifies the
relationship, so a tenant mismatch simply makes the claim/loads miss — a
terminal no-op, never a cross-tenant action. No resume binary/text, candidate
PII, job-posting body, or secrets are ever enqueued. Payloads are small
(<512B, asserted in tests).

## Retry + failure classification

| Failure | Resume | ATS |
| --- | --- | --- |
| Transient storage / persistence (Mongo) | **RETRY_PENDING** + BullMQ backoff (attempts 3); terminal FAILED only on the final attempt | throw → BullMQ backoff (attempts 3) |
| Corrupt file / password-protected / unsupported / parser crash | terminal **FAILED/UNSUPPORTED** on first attempt (no retry) | n/a |
| Tenant / relationship mismatch, missing inputs | claim misses → `NOT_PROCESSABLE` | terminal **no-op** (no retry) — a mismatch never resolves by retrying |

- Business attempt accounting (`CandidateResume.parsingAttempts`, max 8) is
  separate from BullMQ attempts and persists across reconciliations.
- A retryable resume failure records **no** `RESUME_PARSE_FAILED` history row
  (retries do not spam the candidate timeline); the failure category is kept on
  the parse result for diagnostics.
- On exhaustion, no extra bookkeeping is needed: the resume business state is
  already terminal (or RETRY_PENDING) and the ATS intent stays in Mongo —
  startup recovery / reconciliation re-derives it (idempotent, slot-prepared).

## Idempotency + crash recovery

- **Mongo is the source of truth** (intent), **Redis is operational state**.
  `queue.add` is best-effort transport; a queue/Redis failure never fails the
  HTTP request and never loses work.
- **Resume intent**: `CandidateResume.parsingStatus` PENDING/RETRY_PENDING.
- **ATS intent**: COMPLETED parse result with (no ATSResult yet |
  `ATSResult.recalculationPending=true`).
- **Crash between parse commit and ATS enqueue** = "COMPLETED parse + no
  ATSResult", which `recoverPendingATSMatching` re-derives.
- **Atomic lease claim** (unchanged `processResumeJob`) is the single-flight
  guarantee: at-least-once deliveries all lose except the claim winner.
- **`prepareJobSlot`** clears a dead FAILED job before a reconciliation re-add
  (BullMQ never re-creates a used jobId); live jobs are left for BullMQ dedupe.

## Worker + recovery

- One worker process runs 4 BullMQ workers (SYSTEM, EMAIL, RESUME, ATS), each
  with its own dedicated ioredis connection (never the API's 28.1 client).
- Worker REQUIRES Redis + Mongo (fail-fast at startup).
- **Startup recovery** (after Mongo+Redis ready): `recoverPendingResumeProcessing`
  (normalize legacy/lease-expired, re-enqueue stuck) + `recoverPendingATSMatching`.
  A recovery failure is non-fatal and logged; the same recovery runs on the next
  startup and via `npm run processing:reconcile`.
- `closeAllQueues()` is called on worker shutdown (recovery opens producer
  queues) and on API graceful shutdown.

## Verification

- **Hermetic (no Redis/Mongo)**: `npm run test:processing` (13) plus the updated
  `test:resume-parsing` (9) and `test:ats` (12) and the full 28.x regression
  (all green, 184 tests).
- **`npm audit`**: 0 vulnerabilities (no `--force`, no new dependencies).
- **`node --check`** on every changed/new file: clean.
- **Frontend build**: clean (no frontend change — the existing 2.5s polling of
  `parsedResume`/`atsResult` in `CandidateDetailPage` already stops on terminal
  states and cleans up on unmount).
- **Secrets**: `.env` untouched; no URL/credential/token in code, tests, docs,
  or `.env.example` (comments only).

## Manual E2E (developer's machine — Windows PowerShell)

Prereq: `Backend/.env` has `REDIS_ENABLED=true`, a valid `REDIS_URL`, and
`MONGO_URI`. Run the API and the worker in two terminals.

```powershell
# Terminal 1 — API
cd C:\Users\megal\Desktop\HRMS\Backend
npm run dev

# Terminal 2 — worker (system + email + resume + ats)
cd C:\Users\megal\Desktop\HRMS\Backend
npm run worker
```

Happy path (worker running):
1. Public career portal → apply with a **real text-based PDF** (or DOCX) resume.
2. Watch Terminal 2: `[Worker] active: resume-parse ...`, then `completed`,
   then `active: ats-process ...`, then `completed`.
3. Candidate detail: parsed resume goes PENDING → **COMPLETED**, ATS goes
   MATCHING_PENDING → **COMPLETED** with an explainable score; candidate stage
   moves to **ATS_SCREENING**. No auto-reject/shortlist.

Edge cases:
- **Corrupt/unsupported file** → parsingStatus FAILED/UNSUPPORTED, no retry,
  one RESUME_PARSE_FAILED history row.
- **Scanned / image-only PDF** → parsingStatus REVIEW_REQUIRED, no ATS.
- **Worker OFF during apply** → job waits in the `resume` queue; starting the
  worker later drains it. If the queue itself is unavailable at apply time, the
  HTTP request still succeeds (Mongo PENDING intent) and recovery delivers it.
- **Redis outage mid-flight** → `npm run processing:reconcile` (and/or restarting
  the worker) re-derives stuck resume/ATS intents from Mongo and re-enqueues
  them (idempotent; live jobs deduped, dead FAILED jobs cleared).
- **HR reprocess / ATS recalculate** → new deterministic job id, async, 202 with
  an accurate PENDING status; frontend polls and updates on completion.

## Security model

- Tenant authority from `req.companyId` only; every worker reload is scoped
  `{ _id, companyId }` and relationship-checked.
- Strict payload validation (known keys only) on both processors — unknown keys
  (incl. any PII/data) are rejected.
- Deterministic job ids + payloads carry references only; no file names, PII,
  secrets, or connection strings in Redis.
- No new public HTTP endpoint; reconciliation is a local CLI only.

## Known operational notes

- Queue Redis must not evict BullMQ keys (`maxmemory-policy noeviction`); the
  managed provider is **not** reconfigured by this phase — document only.
- Delivery is at-least-once (never claimed exactly-once); idempotency comes from
  the Mongo claim/upserts, not the queue.

## 28.5 handoff (Interview + Offer processing queues)

The 28.4 pattern now established is the template for 28.5:
- Reserved queues already exist in `QUEUE_NAMES` (`scheduled`, `documents`,
  `bgv`, `analytics`, …). Add `INTERVIEW_*` / `OFFER_*` job names to
  `JOB_NAMES` + a `PROCESSING`-style name group.
- Mirror `resumeProcessor.js`/`atsProcessor.js`: thin adapter, strict
  references-only validator, DI seam, terminal-vs-retryable mapping.
- Mongo intent for each new flow (an outbox row or a status flag), a
  deterministic colon-free job id rebuildable from Mongo, and a
  `recoverPending*` the worker runs at startup + a reconcile CLI.
- Reuse `prepareJobSlot`, `enqueueJob`, the 4-worker `workers/index.js`, and
  the `PROCESSING_JOB_NAMES`-style registry registration. Do NOT add a second
  queue factory or reuse the shared 28.1 Redis client.
- Reuse the exact DoD: worker-OFF waits, Redis-outage recoverable, duplicate
  idempotent, crash-recoverable, tenant mismatch rejected, no PII in Redis,
  full regression (incl. 28.3 email + 28.4 resume/ATS), frontend build,
  `npm audit` (no `--force`), `node --check`, secrets scan.

STOP after 28.5.
