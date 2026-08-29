# Crewly Phase 28 — FINAL Architecture & Operations Reference

Redis + BullMQ infrastructure: complete reference, runbooks, production
recommendations, and the final memory capsule. No credentials appear in
this document. (28.1 → 28.9, closed.)

---

## 1. Architecture diagram

```
Frontend (Vite/React)
   |  (JWT customer session)          (AdminSession platform session)
   v                                   v
Express API (src/app.js, src/server.js)
   |                                   |
   +--> MongoDB Atlas  ================+==  SOURCE OF TRUTH (business data)
   |                                   |
   +--> Redis (28.1 client)            +--> Redis (BullMQ producers,
            |                              per-queue dedicated connections)
            |  cache: crewly:cache:company:<id>:...
            |  heartbeat: crewly:ops:worker:<env>:worker-<uuid>
            v
      BullMQ queues  (prefix crewly:<env>)
            SYSTEM | EMAIL | RESUME | ATS | SCHEDULED | DOCUMENTS | BGV
            |
            v
      Worker process (src/workers/index.js — ONE process, seven workers)
            |   every processor re-fetches Mongo by {_id, companyId}
            |   revalidates status + version, then acts or SKIPs
            v
      MongoDB (business truth updated via domain services)
```

Roles: **MongoDB = source of truth.** Redis holds operational work
(queues), ephemeral state (heartbeats) and disposable cache. Losing
Redis must never lose business data — every domain keeps its intent in
Mongo and can be reconstructed by reconciliation.

## 2. Queues, workers, job types

| Queue | Purpose | Job types | Worker notes |
|---|---|---|---|
| system | Infrastructure | system-health-check, system-retry-test | fail-safe round-trip proofs |
| email | Security-scoped email delivery | email-application-received, email-pipeline-update, email-interview-candidate, email-interview-interviewer, email-offer-decision, email-offer-withdrawn, email-preonboarding-doc-decision, email-offer-reminder, email-preonboarding-reminder, email-bgv-reminder | atomic delivery claim; SMTP classification |
| resume | Resume parsing | resume-parse | CPU-bound; single-flight default; Mongo lease |
| ats | ATS matching | ats-process | light; versioned result upsert |
| scheduled | One-time delayed jobs (native BullMQ delay) | interview-reminder, offer-expiry-reminder, offer-expire, preonboarding-reminder, bgv-reminder | worker revalidates Mongo; stale/terminal → SKIP |
| documents | Stored document processing | document-process | version-scoped lease; security state in Mongo |
| bgv | Background verification | bgv-process-check, bgv-provider-poll, bgv-process-result | submission claim; poll backoff 5→15→30→60m, 7d window |

- One worker process runs all seven (independent ioredis connection each,
  prefix `crewly:<env>`, env-driven concurrency:
  WORKER_CONCURRENCY, EMAIL_WORKER_CONCURRENCY, RESUME_WORKER_CONCURRENCY,
  ATS_WORKER_CONCURRENCY, SCHEDULED_WORKER_CONCURRENCY,
  DOCUMENT_WORKER_CONCURRENCY, BGV_WORKER_CONCURRENCY).
- Retention: removeOnComplete count=100, removeOnFail count=500.
- Dispatch: shared `jobRegistry` Map; unknown job name → safe failure
  ("No processor registered", classified CONFIGURATION, non-retryable in
  ops). No dynamic evaluation, ever.
- The reserved queue name `analytics` is NOT implemented and is excluded
  from the ops allowlist.

## 3. Job payload rules (security contract)

- Payloads are **reference-only**: companyId, entity ids, versions,
  epochs, correlation ids. Validated against strict whitelists per job
  type (unknown keys rejected).
- NEVER in a payload or job id: passwords, raw tokens (offer/reset/setup/
  portal/pre-onboarding/BGV), offer portal URLs, resume text/binary,
  candidate documents, government IDs, bank accounts, SMTP/Redis/provider
  credentials, rendered email HTML.
- Workers **never trust the payload**: they re-fetch the entity by
  `{_id, companyId}` and revalidate status + version. Cross-tenant ids
  → NOT_FOUND (no mutation, no leak).
- Return values: skip-reasons or small operational metadata only.
- Job ids: ObjectId segments + version/epoch slugs, colon-free.
- Logging: no payload logging; safe reason classifiers; redaction helpers
  (redactConnectionSecrets) at every error surface.

## 4. Retries, concurrency, idempotency

- Per-queue job options define attempts/backoff. Email SMTP:
  auth failure = NON-retryable; connection/timeout = retryable.
  Corrupt resume = terminal on attempt 1 (no retry burn). Scanned /
  image-only resume → REVIEW_REQUIRED (no fabricated ATS).
- Ops retry (28.8): FAILED state only + backend-authoritative policy;
  malformed / security / config / retries-exhausted / attempts-capped are
  NOT retryable (safe reasons, no force flag).
- Concurrency is bounded per queue; provider-facing queues (email, bgv)
  keep modest defaults so SMTP/providers are not overwhelmed.
- Idempotency (at-least-once safe):
  - email: eventKey dedupe + atomic `claimEmailDelivery` (ALREADY_FINAL)
  - resume: lease claim + versioned id → one parse result/version
  - ats: versioned result upsert → one authoritative result
  - offer expiry: atomic conditional `findOneAndUpdate` (ACCEPTED never expires)
  - bgv: atomic set-if-empty provider submission claim
  - documents: version-scoped lease; stale version skips
  - reconciliation: `prepareJobSlot` clears only FAILED slots
- Honest boundary: SMTP "accepted but crashed before marking SENT" is
  at-least-once — documented, not falsely claimed exactly-once.

## 5. Scheduled jobs (28.5/28.6)

One-time future execution via native BullMQ `delay` (no QueueScheduler).
The worker revalidates Mongo before acting: rescheduled interview →
STALE_SCHEDULE skip; cancelled → TERMINAL_STATE skip; accepted offer →
expiry no-op; stale document version → version-mismatch skip; stale BGV
poll → skip. Attempted removal on reschedule/cancel/accept/withdraw, with
worker validation as the real guard (removal can race).

## 6. Caching (28.7)

- Value keys: `crewly:cache:company:<companyId>:recruitment:analytics:v1:g<generation>:<hash16>`
  (tenant-scoped, filter-hash; cross-tenant separation proven by test).
- Invalidation: per-company generation key (INCR + 24h TTL) bumped after
  every analytics-relevant mutation (24 call sites, 13 files) — old
  generation keys become unreachable and die by their own short TTL.
- Envelope {v, at, payload}; malformed/wrong-version → exact-key delete +
  MISS; >256KB write skipped; in-process single-flight (process-local —
  documented multi-instance limitation).
- Fail-open: Redis down/disabled → direct Mongo, identical semantics,
  no 500, no cache ever used for authorization.
- Ops: status (enabled/TTL/counters) + controlled per-company
  invalidation (Super Admin, audited).

## 7. Worker heartbeat + operations (28.8)

- Key `crewly:ops:worker:<env>:worker-<uuid>` TTL 60s, beat 15s
  (env-tunable), member set for discovery (no KEYS/SCAN), no hostnames.
  ONLINE / SHUTTING_DOWN / OFFLINE (TTL-based). Best-effort; cleared on
  graceful shutdown; error logs throttled (30s worker / 5min heartbeat).
- Ops API: `/api/super-admin/operations/*` (12 routes) — allowlisted
  queues only, counts API, safe serializer (whitelist + redaction),
  retry/remove/pause policies, reconciliation preview + bounded run
  (≤100 per domain), cache status/invalidate. `operations:read`
  (SUPER_ADMIN + PLATFORM_ADMIN) / `operations:manage` (SUPER_ADMIN only),
  per-IP rate limits (60 reads / 20 writes per minute), platform-scope
  audit for every mutation.
- Ops UI: Super Admin "Background Operations" page (queues, workers,
  failed jobs with View/Retry/Remove, Recovery incl. "Run all (bounded)",
  cache section). Tenant /app is never touched.

## 8. Reconciliation (Mongo → queue reconstruction)

Six bounded, idempotent runners (28.3–28.6): email stuck deliveries,
resume pending, ATS missing, scheduled reminders/expiries, document
processing, BGV checks/polls. Run at worker startup, via npm scripts
(email:reconcile / processing:reconcile / scheduled:reconcile /
queue:reconcile), and via the ops API (per-area + master coordinator
`reconcileBackgroundWork` for the runbook). All use deterministic job ids
+ `prepareJobSlot` → a second run never duplicates work. No Redis scans,
no FLUSH, backend-clamped limits (UI cannot send limit=1000000).

## 9. Failure behavior summary

| Failure | Behavior |
|---|---|
| Redis down (API) | degraded: cache→Mongo, enqueue reject→outbox recoverable, no unhandled rejection, no credential logs, bounded reconnect, state-change logging |
| Redis down (worker) | bounded ioredis reconnect; jobs wait; heartbeat expires → OFFLINE visible; no log storm (throttled) |
| Redis restart | API health UP → RECONNECTING → UP; queued jobs continue (managed Redis persistence); no business state lost |
| Worker crash mid-job | BullMQ lock/stall recovery + Mongo lease expiry → reconciliation re-derives; no false SENT/COMPLETED; no permanent PROCESSING deadlock |
| Worker outage | jobs wait in Redis; ops UI OFFLINE; restart → drains backlog; no job loss |
| Mongo down (worker) | retryable throw → BullMQ retry; no success marking; intent persists |
| SMTP fail | safe classification; retry only connection/timeout; exhausted → EmailDelivery FAILED; business op intact; no SMTP credential leaks |
| Storage fail | retryable processing failure; no false COMPLETED; reconciliation re-queues after restore |
| BGV provider down / never completes | backoff within 7d window → UNABLE_TO_VERIFY / REVIEW_REQUIRED; human HR decides; NEVER auto-reject; no provider key leaks |
| Cache down / stale / malformed | Mongo fallback / generation bump / exact-delete+MISS |
| Duplicate jobs | domain idempotency (claims/leases/versioned ids) — no duplicate irreversible business action |
| Stale jobs | SKIP with safe reason (never wrong email, never wrong state) |
| Cross-tenant job | NOT_FOUND / TENANT_MISMATCH — no mutation, no leak |
| Malformed / unknown job | strict whitelist rejection / CONFIGURATION non-retryable — no arbitrary execution |

## 10. Recovery runbooks

### After Redis loss (catastrophic)
1. Restore Redis availability (provider side).
2. Confirm API Redis health (ops page → Redis chip UP; health endpoint).
3. Start the worker process (`npm run worker`).
4. Confirm heartbeats ONLINE (ops page → Workers).
5. Preview reconciliation (ops page → Recovery, or "Run all" after
   checking the per-domain counts).
6. Run reconciliation: email, then resume/ATS, then scheduled, then
   documents/BGV — or "Run all (bounded)" (limit ≤100 per domain).
7. Verify queue backlog drains (ops page → Waiting/Oldest Waiting).
8. Monitor failures (ops page → Failed jobs); retry only retryable ones.
9. Let the cache repopulate naturally (disposable).
No FLUSH at any step. No direct Mongo edits (exceptional procedure only).

### After worker outage
1. Check Redis (ops page). 2. Check worker heartbeat (OFFLINE expected).
3. Restart worker. 4. Watch waiting jobs drain. 5. Inspect failures.
6. Run reconciliation if anything looks lost.

### After SMTP outage
1. Check failed/pending EmailDelivery (ops page, email queue failures).
2. Fix provider/config externally (rotate credentials if leaked).
3. Retry bounded failed jobs/deliveries — auth failures are NOT
   retryable; connection/timeout failures are. Never blindly resend all
   historical email (claim + eventKey prevent duplicates).

### After storage outage
1. Restore storage. 2. Retry only retryable resume/document failures.
3. Permanent corrupt/unsupported files stay in manual/review state.

## 11. Deployment ordering & versioning

- **Deploy workers first, API second** when job payloads/schemas change:
  new workers must understand any old delayed jobs that exist; old APIs
  only stop producing old jobs after the new deploy.
- Job schema versioning: versioned ids (parserVersion /
  processingVersion / epoch slugs) + strict payload whitelists. Unknown
  future version → safe failure (non-retryable), never silent
  misinterpretation. Old delayed jobs survive deploys because processors
  revalidate Mongo (the payload is a hint, not truth).
- Queue names are NOT renamed casually. A breaking change would
  introduce a new queue name + migration of outstanding work via
  reconciliation — not in place.

## 12. Production topology recommendation

**Minimum viable (recommended start):**
- API: 1 instance (2 for zero-downtime deploys) behind the existing
  process manager (systemd/pm2) with SIGTERM handling.
- Worker: 1 instance (all seven queues) — same host or separate; must
  never co-die with the API.
- Redis: one managed Redis instance (Redis Cloud or equivalent) with
  persistence enabled and **no/allkeys-eviction disabled for the queue
  keys** — cache shares the instance but cache keys are disposable;
  BullMQ keys must never be evicted. Verify the provider's eviction
  policy before go-live; separate instances (queues vs cache) is the
  stronger option if the provider cannot scope eviction.
- MongoDB Atlas: existing (source of truth).
- Environments: dev / staging / production on **separate Redis
  instances** (at minimum separate `crewly:<env>` prefixes); tests use
  isolated `crewly:test:*` prefixes and never FLUSH.

**Scale-up path (only when measured):** split the worker process by
workload (email | processing | scheduled | documents/bgv) by
configuring which queues a worker instance registers; then per-queue
concurrency tuning; then queue-vs-cache Redis split; auto-scaling only
with load evidence (28.9 load tool first).

**Production checklist (no secret values):**
REDIS_ENABLED=true · REDIS_URL secret in env only (rediss:// TLS) ·
Redis network access from API+worker only, no public exposure ·
persistence/HA per provider durability SLA · eviction policy verified
(no queue-key eviction) · memory limit + alert below provider ceiling ·
queue prefix `crewly:production` · separate env per stage · SMTP
credentials in env only · storage (Cloudinary) keys in env only · BGV
provider keys in env only · worker deployed independently with
SIGTERM · graceful shutdown verified in deploy test · monitoring below.

**Monitoring / alerts (from the 28.8 ops data):** Redis state down ·
no worker heartbeat (OFFLINE) · waiting-job age above warn/critical
thresholds · failed-jobs spike (recent window) · email failure spike ·
resume processing backlog (oldest waiting) · BGV provider failures ·
memory usage vs provider threshold. No external alert vendor is
implemented — the ops page + provider dashboards are the first line.

## 13. Known limitations (honest list)

- Email is **at-least-once**: the "SMTP accepted, crashed before SENT"
  window cannot be closed without provider message-id/outbox tracking
  (future hardening, documented).
- Cache single-flight is **process-local**: multi-instance API can
  stampede once per TTL window (bounded by 60s TTL + short generation).
- No external BGV provider integrated (internal provider model only).
- No OCR (scanned resumes → REVIEW_REQUIRED, human handles).
- No auto-scaling / Kubernetes (single worker process by design at this
  scale).
- Managed free-tier dev Redis is **not** a production capacity
  benchmark (28.9 load tool measures dev behavior only).
- Cache counters are per-process (multi-instance shows its own slice).
- Oldest-waiting ages the FIFO head of `wait` (prioritized jobs, if ever
  used, count but are not aged separately).
- ATS reconcile preview is a flagged upper-bound estimate.

## 14. Testing commands (developer)

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend

# Hermetic (default — no Redis/Mongo needed)
npm run test:all          # everything non-live (24 suites, 366 tests)
npm run test:phase28      # the Phase 28 suites
npm run test:redis        # 28.1        npm run test:bullmq   # 28.2
npm run test:email        # 28.3        npm run test:processing  # 28.4
npm run test:scheduled    # 28.5        npm run test:background-jobs  # 28.6
npm run test:cache        # 28.7        npm run test:operations   # 28.8
npm run test:ops          # alias of test:operations

# Opt-in live (explicit; isolated prefixes; never FLUSH)
npm run test:bullmq:live  # 28.2 ladder (needs live Redis)
npm run test:ops:live     # 28.8 ladder (needs live Redis + Mongo)

# Controlled load / backpressure (dev only, isolated prefix)
npm run ops:load-check -- --jobs 100 --concurrency 4

# Connectivity / cycle checks
npm run redis:check       # 28.1
npm run queue:check       # 28.2 round-trip (+ :retry, :duplicate)
```

## 15. CREWLY PHASE 28 — FINAL MEMORY CAPSULE

- **Redis**: 28.1 provider-neutral client; REDIS_ENABLED (explicit
  parser) + private REDIS_URL (redis:// or rediss://, TLS verification
  always ON, never logged/returned/embedded); bounded exponential
  reconnect (capped); state UP/DOWN/RECONNECTING/CLOSED; degraded API
  mode; safe reason classifier.
- **BullMQ**: v6.3.1; 7 implemented queues (system, email, resume, ats,
  scheduled, documents, bgv) + reserved `analytics` (unimplemented,
  allowlist-excluded); prefix `crewly:<env>`; lazy pooled per-queue
  connections (producer + worker purposes, `maxRetriesPerRequest: null`);
  retention completed=100 / failed=500.
- **Workers**: one process, seven workers, shared jobRegistry dispatch,
  strict payload whitelists, Mongo re-fetch `{_id, companyId}` +
  revalidation, skip-reasons for stale/terminal, small-metadata returns,
  startup reconciliation of all six domains, graceful SIGTERM (10s
  hard stop), heartbeat, throttled error logging.
- **Job types**: 2 system + 10 email + 1 resume + 1 ats + 5 scheduled +
  1 document + 3 bgv = 23 job names; deterministic colon-free ids
  (ObjectId + version + epoch); reference-only payloads (no
  tokens/PII/credentials, verified by audit).
- **Retries**: per-queue attempts/backoff; email SMTP classification
  (auth non-retryable); terminal parser failures on attempt 1; BGV poll
  ladder 5→15→30→60m / 7d window → UNABLE_TO_VERIFY; ops retry policy
  backend-authoritative (no force).
- **Concurrency**: per-queue env concurrency; email/BGV modest by
  design; 28.9 load tool for observation.
- **Idempotency**: claims/leases/versioned ids/atomic transitions per
  domain; prepareJobSlot clears only FAILED; reconcile re-runs never
  duplicate; email at-least-once boundary documented.
- **Payload security**: whitelists, tenant re-fetch, redaction helpers,
  no payload logging, safe job serializer in ops.
- **Scheduled jobs**: native delay; no QueueScheduler; worker revalidates
  (stale/terminal → SKIP); attempted removal + validation guard.
- **Email architecture**: outbox EmailDelivery + eventKey dedupe +
  atomic claim; token-bearing send emails stay synchronous by policy;
  jobs carry ids only; SMTP mock/real via env; no "email sent" claims in
  HTTP responses.
- **Resume/ATS chain**: upload → PENDING lease → resume-parse (versioned)
  → COMPLETED → ats-process (versioned upsert) → pipeline; recovery via
  lease expiry + reconciliation; no fake scores; REVIEW_REQUIRED for
  unparseable.
- **Document/BGV chain**: upload → stored bytes (storage) →
  document-process (security state, version-scoped) → HR verification;
  BGV case → consent → provider submit (atomic claim) → poll ladder →
  result mapping (VERIFIED / DISCREPANCY / UNABLE_TO_VERIFY) → NEVER
  auto-reject; reminders via scheduled queue.
- **Caching**: tenant-scoped generation-based analytics cache; 24
  invalidation hooks; fail-open; envelope + 256KB guard + single-flight;
  ops status + controlled invalidation.
- **Heartbeat/ops**: worker-<uuid> TTL keys + member set; 12 allowlisted
  ops routes (read vs manage RBAC, rate limits, platform audit);
  Background Operations page (queues/workers/failed jobs/recovery/cache);
  master reconciliation coordinator (dryRun + bounded "run all").
- **Reconciliation**: six existing runners + coordinator; bounded,
  idempotent, Mongo-authoritative; startup + CLI + ops API.
- **Failure recovery**: runbooks for Redis loss / worker outage / SMTP
  outage / storage outage (section 10); Mongo stays source of truth
  through every scenario.
- **Environment variables (Phase 28)**: REDIS_ENABLED, REDIS_URL
  (private), REDIS_CONNECT_TIMEOUT_MS, RECRUITMENT_ANALYTICS_CACHE_TTL_
  SECONDS, OPS_QUEUE_WAITING_WARN/CRITICAL, OPS_OLDEST_WAITING_WARN_
  MS/CRITICAL_MS, OPS_FAILED_RECENT_MINUTES,
  OPS_WORKER_HEARTBEAT_INTERVAL_MS/TTL_SECONDS, per-queue
  *_WORKER_CONCURRENCY. All clamped in code; defaults sane; nothing
  secret in .env.example.
- **Testing**: 26 files; 24 non-live suites / 366 hermetic tests;
  2 opt-in live ladders (isolated prefix, scoped obliterate, never
  FLUSH, exact-only Mongo fixture cleanup); load check script; commands
  in section 14.
- **Production**: minimum viable topology + scale-up path + checklist +
  monitoring (section 12); deployment order workers-first; queue-name
  versioning policy; limitations (section 13).
- **Closed with**: 24 non-live suites green, npm audit 0/0, frontend
  build passing, secrets scan clean, no FLUSH/KEYS/arbitrary-command
  surface anywhere, tenant tokens denied at the platform gate (tested).

**PHASE 28 — COMPLETE.**
