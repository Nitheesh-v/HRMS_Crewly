# Phase 28.2 — BullMQ Queue + Worker Foundation

Status: COMPLETE (infrastructure only — no business workflow uses BullMQ yet)

## What was implemented

| File | Purpose |
| --- | --- |
| `Backend/src/config/queueConfig.js` | Central constants (queue/job names), prefix derivation, concurrency parsing, default job options, `buildJobId`, `redactConnectionSecrets` |
| `Backend/src/queues/queueFactory.js` | `getQueue` / `enqueueJob` / `closeAllQueues` / `getQueueStatus` — the only Queue creation path |
| `Backend/src/workers/registry.js` | Job name → processor registry + `systemHealthProcessor` + controlled `systemRetryTestProcessor` |
| `Backend/src/workers/index.js` | Separate worker process (`npm run worker` / `worker:dev`) |
| `Backend/scripts/queue-check.js` | `npm run queue:check` (+ `--retry-test`, `--duplicate-test`, `--timeout`) |
| `Backend/test/bullmqFoundation.test.js` | Hermetic unit tests (no Redis) |
| `Backend/test/bullmqLive.test.js` | Opt-in live integration (`npm run test:bullmq:live`), isolated random prefix |

Dependency: `bullmq@^6.3.1` (Node ≥14.17; ioredis is an optional peer
`>=5.0.0` — our `ioredis@5.11.1` is the single client family).

## Architecture

```
Terminal 1                    Terminal 2
npm run dev                   npm run worker:dev
  Express API                   BullMQ Worker (system queue)
  │                             │
  └─ (28.3+: enqueueJob) ──────┐│
                               ▼▼
                        Managed Redis Cloud
                 (crewly:development:system:* keys)
```

- **Separate process on purpose.** The API serves HTTP; the worker
  processes background jobs. They scale independently; a worker crash
  never takes down the API; a busy worker never blocks HTTP.
- **API keeps 28.1 degraded mode** (no business workflow needs
  BullMQ yet). **A worker REQUIRES Redis**: if Redis is disabled,
  misconfigured, or unreachable at startup, the worker fails fast
  with a safe error (never pretends to run).
- Environment isolation via key prefix:
  `crewly:development` / `crewly:test` / `crewly:production`
  (from `NODE_ENV`, overridable with `BULLMQ_PREFIX`). A dev worker
  can never consume another environment's jobs even on a shared
  Redis. Prefix is additional protection — separate Redis instances
  per environment remain the ideal in production.

## Connection ownership (verified in BullMQ 6.3.1 source)

- BullMQ's ESM build cannot `require('ioredis')` for options-only
  connections → **we pass constructed ioredis instances** (created
  from `REDIS_URL` + `createRedisOptions('bullmq-producer' |
  'bullmq-worker')`, both of which set `maxRetriesPerRequest: null`
  as BullMQ requires).
- A passed instance is treated as **shared**: BullMQ will not close
  it. The worker's dedicated blocking connection is a `duplicate()`
  of our instance — BullMQ closes that one.
- Therefore: **the queue factory and the worker process create each
  instance and close it explicitly** after `queue.close()` /
  `worker.close()`. The 28.1 general API client is never touched.
- BullMQ rejects ioredis `keyPrefix` (throws) — we use BullMQ's own
  `prefix` option. Keys: `crewly:development:system:wait`, `...:id`,
  `...:active`, etc.

## Defaults

- Job: `attempts: 3`, `backoff: { type: 'exponential', delay: 1000 }`,
  `removeOnComplete: { count: 100 }`, `removeOnFail: { count: 500 }`
  (bounded retention — dev Redis Cloud is small; business history
  stays in MongoDB/Audit, never in queue retention).
- Worker concurrency: `WORKER_CONCURRENCY` (default 2, clamped 1–50).
  Future CPU-heavy workers (resume parsing) get their OWN variables.
- Stalled jobs: BullMQ built-ins (lock 30s, stalled check 30s,
  `maxStalledCount: 1`). If a worker dies mid-job, the job is
  re-queued after its lock expires — no custom detection needed.

## Delivery semantics — at-least-once, workers must be idempotent

BullMQ does NOT guarantee exactly-once. From 28.3 onward every
business processor must be safe to run more than once:
email → idempotency record per event; resume parse → upsert by
resume+parser version; ATS → upsert by candidate+engine version;
offer expiry → atomic state transition; BGV → provider request id.

## Job ID / idempotency convention

`buildJobId('resume-parse', resumeId, parserVersion)` →
`resume-parse:res_123:v1`. Rules: colon-joined, non-empty parts, no
spaces/control chars, ≤128 chars, never secrets/tokens/PII.
BullMQ semantics: adding a job with an existing `jobId` returns the
existing job (no duplicate) — verified with `queue:check
--duplicate-test`.

## Payload security

Payloads carry **references only** (`companyId`, `candidateId`,
`resumeId`, timestamps, correlation ids) — never resume binaries,
candidate objects, passwords, SMTP credentials, raw secure tokens,
bank data, or government IDs. Workers re-fetch authoritative state
from MongoDB. Log lines carry queue/job name, job id, attempt, safe
error category — never full `job.data` (a redactor also strips URL
userinfo from any error text).

## Commands

```powershell
cd Backend
npm install
npm run test:redis          # 28.1 regression
npm run test:bullmq         # hermetic 28.2 unit tests
npm run redis:check         # 28.1 PING -> PONG
npm run worker:dev          # terminal 2: system worker
npm run queue:check         # terminal 3: health round-trip
npm run queue:check:retry   # controlled fail-once retry proof
npm run queue:check:duplicate # duplicate job id collapse proof
npm run test:bullmq:live    # opt-in live integration (isolated prefix)
```

NOTE: use the dedicated `queue:check:*` scripts (NOT
`npm run queue:check -- --retry-test`). Some npm versions silently
strip `--flag` arguments after `--` (keeps only bare values), which
made the flag-based form run as a plain health check. Running
`node scripts/queue-check.js --retry-test [--timeout 20000]`
directly always works too.

Expected: `queue:check` prints the prefix, `SYSTEM_HEALTH_CHECK
enqueued (id=...)`, then `SYSTEM_HEALTH_CHECK COMPLETED (id=...,
attempts=1)` + safe result JSON. (`attempts` = how many times the
worker actually ran the processor; BullMQ's separate `attemptsMade`
counter includes the successful attempt, so it is not printed.) With the worker
stopped it times out safely (15s) and prints: "the system worker is
not running. Start it in a separate terminal: npm run worker:dev".

## Failure behavior (documented)

- Worker, Redis down at startup → safe error, exit 1 (no credentials).
- Worker running, Redis drops → ioredis reconnects with its bounded
  strategy; jobs pause and resume; `stalled` jobs re-queue after
  lock expiry. No crash (worker `error` handler logs safely).
- API unaffected by any Redis/queue state (28.1 policy).
- Duplicate `jobId` → single job (BullMQ returns the existing one).

## Production Redis notes (documentation only — no auto-reconfig)

Queue Redis is not cache Redis: do not allow arbitrary eviction of
BullMQ keys (persistence/`noeviction`-style policy appropriate for
queue workloads), authentication, TLS, private networking,
monitoring/alerts, HA per requirements, separate instances per
environment.

## Explicit non-goals (28.2)

No email/resume/ATS/interview/offer/pre-onboarding/BGV/analytics
migration. No rate-limit/session/auth migration. No public queue
HTTP API. No dashboard (28.8). No `FLUSHALL`/`FLUSHDB` anywhere.
No Frontend changes.

## Phase 28.3 handoff (EMAIL queue)

- Add `createQueue(QUEUE_NAMES.EMAIL)` via `getQueue('email')` — the
  factory already handles it; no foundation changes needed.
- Register `email` processors in `src/workers/registry.js`
  (`registerProcessor(JOB_NAMES.EMAIL_..., fn)`) — or a dedicated
  email worker process copying `src/workers/index.js` with its own
  `WORKER_EMAIL_CONCURRENCY`.
- Producer call shape: `enqueueJob(QUEUE_NAMES.EMAIL,
  'ACCOUNT_SETUP_EMAIL', { companyId, employeeId, correlationId })`
  — references only; the email worker resolves the recipient and
  templates from MongoDB at processing time (idempotency record per
  event to survive at-least-once delivery).
- Reuse `getDefaultJobOptions()` (3 attempts, exponential 1s) —
  email sends are retryable.

## Phase 28.4/28.5 handoff (sketch)

- 28.4: `RESUME_PARSE` jobs on `QUEUE_NAMES.RESUME`, resume worker
  with its own concurrency var; on success upsert
  `ResumeParseResult` then `enqueueJob(ATS, 'ats-process',
  { candidateId, resumeId, engineVersion })`.
- 28.5: delayed jobs via `queue.add(name, refs, { delay: ms })`
  (verified BullMQ v6 `JobsOptions.delay: number`).
