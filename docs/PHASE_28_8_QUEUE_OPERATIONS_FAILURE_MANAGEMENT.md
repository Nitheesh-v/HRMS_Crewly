# Phase 28.8 — Queue Operations + Failure Management + Operational Visibility

Super Admin tooling to **see** and **safely operate** the seven BullMQ
queues, the worker process, and the 28.7 analytics cache — without ever
exposing job payloads, Redis internals, or credentials.

---

## 1. What was built

| Area | What |
|---|---|
| **Bug fix (28.6 carry-over)** | `src/workers/index.js` imported `recoverPendingDocumentProcessing` / `recoverPendingBgvProcessing`, which do not exist. The worker process **could not start at all**. Fixed to the real exports (`runDocumentReconcile` / `runBgvReconcile`) + a hermetic link-guard test so a missing export can never silently break the worker again. |
| **Ops queue registry** | `src/services/opsQueueRegistry.js` — allowlist of the **7 implemented queues** (`system, email, resume, ats, scheduled, documents, bgv`). The reserved-but-unimplemented `analytics` name and any arbitrary string are rejected. Env-configurable severity thresholds (clamped). Safe failure categories + the **backend-authoritative retry policy**. |
| **Safe job serializer** | `src/services/opsJobSerializer.js` — whitelist-only view: jobId, name, queue, state, timestamps, attempts, safe category, **redacted** message (≤300 chars), correlation ref (entity **type + id only**), redacted company ref. Never `job.data` (except `companyId` for the redacted ref), never `returnvalue`, never raw stacks. Redacts credential URLs, JWT/Bearer/long tokens, `key=value` secrets, file paths. |
| **Ops service** | `src/services/opsQueueService.js` — overview (counts API only; oldest-waiting = exactly ONE FIFO-head job read), failed list (clamped 1–50/page), job detail, retry (FAILED-only, race-safe), bounded batch retry (≤25), remove (FAILED/COMPLETED-only), pause/resume, reconciliation preview + bounded run (≤100), cache status + controlled invalidation. Every function takes a `deps` override (hermetic tests). |
| **Worker heartbeat** | `src/workers/workerHeartbeat.js` — ephemeral key `crewly:ops:worker:<env>:worker-<uuid>` (TTL default 60s, beat every 15s) + member set `crewly:ops:workers:<env>` (no KEYS/SCAN; capped at 200). Statuses: **ONLINE / SHUTTING_DOWN / OFFLINE** (TTL-based, no Mongo). Uses a worker-owned ioredis connection; best-effort (a heartbeat blip never affects job processing); cleared on graceful shutdown; one timer per process. |
| **Routes + RBAC + rate limits** | Under the existing `/api/super-admin` hierarchy (see §3). `operations:read` = SUPER_ADMIN + PLATFORM_ADMIN (view). `operations:manage` = **SUPER_ADMIN only** (retry/remove/pause/reconcile/invalidate). Per-IP rate limits: 60 reads/min, 20 writes/min. |
| **Audit** | Platform-scope `AuditLog` entries (safe metadata only): `QUEUE_JOB_RETRIED`, `QUEUE_JOB_REMOVED`, `QUEUE_PAUSED`, `QUEUE_RESUMED`, `RECONCILIATION_TRIGGERED`, `CACHE_INVALIDATED`. |
| **Frontend** | New Super Admin page **Background Operations** (`/super-admin/background-operations`): Redis/Workers header, queue table (Waiting/Active/Delayed/Failed/Oldest Waiting/Status + human reasons), failed-jobs table (View/Retry/Remove + confirmation modals + batch retry + pagination), Recovery section (preview → bounded run per area), analytics-cache section (status + per-company invalidation). Tailwind + Lucide, no emojis, human ages computed frontend-side. |
| **Cache status** | `redisCacheService.js` gained in-process counters (hits/misses/bypasses/writes/skips/invalidations + last event). `analyticsCacheInvalidation` records invalidations. The ops page shows counts only — **never** keys or payloads. |

## 2. What is deliberately NOT here

- No queue deletion, no `obliterate()`, **no FLUSHALL/FLUSHDB ever**.
- No generic Redis browser, no arbitrary Redis commands, no arbitrary queue names/keys.
- No Bull Board or third-party dashboard (own safe UI, per spec).
- No raw `job.data` / `returnvalue` / stack traces anywhere (serializer enforces).
- No removal of Mongo business data — `remove` touches the queue job only.
- No production autoscaling / Kubernetes concerns (future, out of scope).
- No HR_HEAD or tenant-side operations; Super Admin never routes into `/app`.

## 3. API surface (all under `/api/super-admin`)

| Method + path | Permission | Notes |
|---|---|---|
| `GET /operations/queues` | `operations:read` | Redis state + workers + 7-queue table (degraded safe shape when Redis down: `{redis:{state}, queues:"unavailable"}`) |
| `GET /operations/queues/:queueName/failed?page=&limit=` | `operations:read` | limit clamped 1–**50** (hard max); page ≥ 1 |
| `GET /operations/queues/:queueName/jobs/:jobId` | `operations:read` | safe serializer output |
| `POST /operations/queues/:queueName/jobs/:jobId/retry` | `operations:manage` | FAILED only; policy-checked; BullMQ `job.retry()` (same job, no reconstruction); 409 on race; 422 + safe reason when not retryable |
| `POST /operations/queues/:queueName/retry-failed` `{jobIds:[]}` | `operations:manage` | max **25**; per-job results; per-job audit |
| `DELETE /operations/queues/:queueName/jobs/:jobId` | `operations:manage` | FAILED/COMPLETED only; 409 if state changed; queue-only |
| `POST /operations/queues/:queueName/pause` / `/resume` | `operations:manage` | documented risk: stops/picks up processing; nothing is cancelled |
| `GET /operations/reconcile/preview` | `operations:read` | per-area counts (mirrors of the existing runner eligibility; ATS is a flagged upper-bound estimate) |
| `POST /operations/reconcile` `{area, limit}` | `operations:manage` | limit clamped 1–**100**; calls the **existing** 28.3–28.6 runners (idempotent via deterministic job ids) |
| `GET /operations/cache` | `operations:read` | analytics cache status + per-process counters |
| `POST /operations/cache/invalidate` `{companyId}` | `operations:manage` | validates ObjectId; bumps the 28.7 generation (one controlled admin action) |

## 4. Retry policy (backend-authoritative — no force/skipValidation exists)

| Safe category | Source signals | Retryable |
|---|---|---|
| `REDIS_UNAVAILABLE` | ECONNREFUSED/ECONNRESET/ETIMEDOUT/EHOSTUNREACH/EPIPE, "redis", "connection closed/lost/refused", "socket hang up" | **Yes** (transient) |
| `PROCESSOR_ERROR` | default for processor failures | **Yes** (transient) |
| `MALFORMED_PAYLOAD` | malformed/invalid payload, missing field, payload validation | **No** — "will fail the same way" |
| `SECURITY_REJECTION` | tenant/company mismatch, forbidden/denied/unauthorized, expired token | **No** — "not safe to retry" |
| `CONFIGURATION` | "No processor registered" | **No** — fix the deployment |
| `RETRIES_EXHAUSTED` | attempts exhausted | **No** |
| `UNKNOWN` | empty/unclassifiable reason | **No** — inspect first |

Plus: `attemptsMade >= maxAttempts` blocks retry regardless of category.
Race safety: state is re-checked immediately before `job.retry()`; if two
admins click at once, the loser gets 409 and the job is retried exactly once.

## 5. Queue health (HEALTHY / WARNING / CRITICAL + human reasons)

Thresholds (env, clamped): waiting ≥ `OPS_QUEUE_WAITING_WARN` (100) warn /
≥ `OPS_QUEUE_WAITING_CRITICAL` (1000) critical; oldest waiting ≥
`OPS_OLDEST_WAITING_WARN_MS` (5 min) warn / ≥ `OPS_OLDEST_WAITING_CRITICAL_MS`
(30 min) critical → reason e.g. *"Oldest waiting job is 12 minutes old"*;
recent failures (last `OPS_FAILED_RECENT_MINUTES` = 15 min, tail probe ≤50);
queue paused; no online workers. **Delayed jobs are never an incident**
(one-time scheduled work) — explicitly never flagged.

## 6. Heartbeat protocol

- Key `crewly:ops:worker:<env>:<workerId>`, value `{"state":"online"|"shutting_down","ts":…}`,
  TTL `OPS_WORKER_HEARTBEAT_TTL_SECONDS` (60, clamped 15–300).
- Beat every `OPS_WORKER_HEARTBEAT_INTERVAL_MS` (15s, clamped 5–60s) — keep TTL ≥ 3× interval.
- `workerId` = `worker-<randomUUID>` — **no hostnames/pids/usernames** in Redis or UI.
- Graceful shutdown: marks `shutting_down` (10s TTL), then deletes the key +
  removes the member on stop. Crash = key expires → OFFLINE.
- Discovery via the small member set (SADD/SREM) — **no KEYS/SCAN**.

## 7. Reconciliation ops (preview → bounded run)

Six areas, each calling the **existing** service (no re-implementation):

| area | runner (existing) |
|---|---|
| email | `reconcileStuckEmailDeliveries` (28.3) |
| resume | `recoverPendingResumeProcessing` (28.4) |
| ats | `recoverPendingATSMatching` (28.4) |
| scheduled | `runScheduledReconcile` (28.5) |
| documents | `runDocumentReconcile` (28.6) |
| bgv | `runBgvReconcile` (28.6) |

Preview counts mirror the runners' eligibility (ATS = flagged upper bound).
Runs are clamped to 100 on the backend; idempotency comes from the
runners' deterministic job ids (a second run never duplicates work —
proven by the live ladder).

## 8. Tests

- **Hermetic** `test/opsQueueOps.test.js` (69 tests, no Redis/Mongo):
  worker link guard, allowlist, categories, retry policy, serializer
  (PII/redaction/entity refs), severity calc (delayed never flagged),
  degraded overview, paging limits, retry/remove/pause/batch policy
  (404/409/422/500/502 paths), reconcile preview + bounded run + safe
  error surfacing, cache validation + invalidation, heartbeat (key shape,
  stop, best-effort), permission matrix, **AdminSession tenant denial**
  (tenant roles 403 before any DB access).
- **Opt-in live ladder** `test/opsQueueOpsLive.test.js`
  (`npm run test:ops:live` — needs live Redis + Mongo in Backend/.env,
  isolated `crewly:test:live-<random>` prefix, scoped `obliterate` on its
  own queues only, never FLUSHALL/FLUSHDB):
  1. heartbeat ONLINE → crash-sim OFFLINE → graceful stop OFFLINE while all 7 queues stay visible
  2. controlled FAILED job → ops retry → COMPLETED (real queue + worker)
  3. tenant-mismatch FAILED job → 422 non-retryable, NOT retried, then removable
  4. overview reflects live failed counts + health
  5. reconciliation: 1 stuck delivery → requeued 1 → second run creates **no duplicate**
- Regression: 24 non-live suites / **359 green** (was 290 before 28.8);
  npm audit 0; secrets scan clean; frontend `vite build` passes.

## 9. Live ladder (developer, Windows PowerShell)

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
# Redis + Mongo must be configured in Backend/.env (REDIS_ENABLED=true,
# REDIS_URL, MONGO_URI) — the worker needs both.
npm run worker:dev        # Terminal 1: worker (now starts! emits heartbeat)
npm run test:ops:live     # Terminal 2: the ladder
```

Expected: heartbeat ONLINE; controlled retry job completes after the ops
retry; tenant-mismatch job 422s and is never retried; reconcile run 1
requeues 1 and run 2 creates no duplicate. Stop the worker with Ctrl+C —
its heartbeat disappears (OFFLINE) within the TTL while queues stay visible.

## 10. Limitations (honest list)

- **Multi-instance API**: cache counters are per-process (a 2-instance
  deploy shows its own slice). Queue/worker views are shared (Redis).
- **Oldest-waiting** reads the FIFO head of `wait` (prioritized jobs, if
  ever used, are counted in `waiting` but not aged separately).
- **ATS preview** is an upper-bound estimate (the runner's extra
  "missing result / recalculation pending" predicate can't be expressed
  in a count).
- **Paused queue** state is per-queue on Redis; pausing is a deliberate,
  audited, Super-Admin-only action (documented risk: jobs simply wait).
- **Worker heartbeat** is one key per worker *process* (the process runs
  all seven queues) — it answers "is a worker alive", not per-queue
  concurrency detail.
- **Recent-failed** probe inspects the newest ≤50 failed jobs (retention
  caps the list at 500).

## 11. 28.9 handoff

Candidate next phase: **public career portal cache** (best secondary
cache — stable, low-frequency data, big read traffic) reusing the 28.7
`redisCacheService` primitives + generation invalidation on
career-relevant mutations; or **multi-instance stampede hardening**
(single-flight is in-process today) or **load testing** of the queue
pipeline. The 28.8 ops page already shows queue health/worker state, so
28.9 load tests have a built-in observation point.
