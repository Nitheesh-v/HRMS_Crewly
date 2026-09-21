# CREWLY — PHASE 32 OPERATIONS RUNBOOKS (authoritative)

Every runbook answers: **DETECT → IMPACT → DO → DO NOT → VERIFY → ESCALATE.** No secrets appear anywhere in this document. Destructive actions are never the default. Load/failure tooling is **never** run against production.

---

## 1. Development startup
**DO:** `cd Backend && npm run dev` (nodemon) · worker: `npm run worker:dev` · frontend: `cd Frontend && npm run dev`. Config pre-flight: `npm run config:check`.
**VERIFY:** `/api/health/live` 200; `/ready` reports Mongo up; frontend proxies `/api` to :5000. **DO NOT:** commit `.env`; point dev at production Mongo/Redis.

## 2. Staging deployment
**DO:** `npm ci` → full test ladder → `npm run config:check` → deploy worker first → API instance → frontend artifact. Synthetic data only; SMTP sandbox expected; billing/BGV test-mode.
**DO NOT:** copy production HR/payroll/BGV data; share Mongo/Redis with production.
**VERIFY:** staging smoke (login, tenant read, worker heartbeat). **ESCALATE:** any isolation doubt — stop.

## 3. Production deployment (manual-approval gate)
**DETECT:** release candidate staged + approved by a human.
**DO:** config:check `--production` → backups verified restorable → §4 rolling order → post-deploy checks (health, error rate, queue depth, one auth + tenant-scoped read + payroll **read**).
**DO NOT:** `npm update`/`audit fix --force` during the window; auto-approve; skip staging rehearsal.
**VERIFY:** all instances ready; queues resumed; frontend loads + authenticates. **ESCALATE:** abort conditions = never-ready instance, 5xx spike, worker failure loop, queue incompatibility → §7 rollback.

## 4. Rolling API deployment
**DO:** deploy one instance → LB health gate (32.2 live/ready) removes it → replace → wait ready → next. Drain window bounded by `GRACEFUL_SHUTDOWN_TIMEOUT_MS`.
**VERIFY:** zero 5xx spike; in-flight requests complete (503 SHUTTING_DOWN only for racing sockets). **DO NOT:** replace all instances at once; merge API+Worker into one process.

## 5. Worker deployment
**DO:** deploy workers accepting old AND new payloads first (expand/contract); start with `node src/workers/index.js`; replica count is a deployment choice.
**VERIFY:** startup logs show queue registration + heartbeat; `npm run queue:check` green. **DO NOT:** flush queues to "clean" state; increase concurrency blindly (§11 runbook).

## 6. Frontend deployment
**DO:** `npm run build` → upload **hashed assets first** → publish `index.html` second → retain previous release's assets (overlap window for open tabs/rollback).
**VERIFY:** deep links load; old tab lazy-navigation still works; no HTML-for-missing-asset (404 stays 404). **DO NOT:** delete old hashed assets immediately; edit built files.

## 7. Rollback
**DO:** API/Worker → redeploy previous artifact (both run against current additive schema); config → revert names via secrets manager, validate with config:check; frontend → restore previous `index.html` (its retained hashed assets still exist).
**DO NOT:** assume DB rollback is routine — additivity exists so data never needs rolling back; destructive reversal = approved, backup-verified incident operation only. Never `git reset` on servers.
**VERIFY:** health green, error rate baseline, representative auth + tenant read OK.
**ESCALATE:** immediate rollback triggers = auth failures, cross-tenant leakage, payroll-correctness regressions.

## 8. Redis failure
**DETECT:** `/ready` reports `cache: down`; DEGRADED logs; queue metrics stall.
**IMPACT:** cache misses (slower), limiter → per-instance degraded buckets, BullMQ paused, SSE tickets unusable (realtime off). **Mongo remains truth; authorization never weakens.**
**DO:** verify Redis process/persistence per provider runbook; restart; workers resume automatically. **DO NOT:** `FLUSHALL`/`FLUSHDB`/broad `crewly:*` deletion; treat cache as truth; bypass auth "temporarily".
**VERIFY:** `/ready` cache up; queues resumed; backlog (§11) draining. **ESCALATE:** persistence corrupt → provider restore procedure before restart.

## 9. Mongo incident
**DETECT:** `/ready` 503 `database_unavailable`; instances keep serving liveness.
**IMPACT:** all business writes/reads stop (safe — no stale-cache mutation fallback exists).
**DO:** provider incident procedure; verify replica/primary; on restore, confirm via app read + one tenant-scoped write in staging-first if possible.
**DO NOT:** casual backup restores without incident analysis; point instances at another env's database.
**VERIFY:** `/ready` 200 on all instances; audit log writes resuming. **ESCALATE:** always — Mongo incidents are engineering incidents.

## 10. Worker offline
**DETECT:** heartbeat missing; queue depth growing (§11); `npm run worker-scale-check`.
**IMPACT:** email/BGV/export/processing jobs wait (at-least-once keeps them safe in Redis).
**DO:** restart worker; add a replica if sustained load. **DO NOT:** manually inject jobs; lower retries to "clear" failures.
**VERIFY:** heartbeat resumes; oldest job age decreasing.

## 11. Queue backlog
**DETECT:** `npm run queue:check` (counts + failure rate); alert on oldest-job age.
**DO:** identify bottleneck (Mongo/Redis/external API) first; add worker capacity where safe; ensure idempotent processors handle re-runs.
**DO NOT:** flush queues; raise concurrency blindly; delete "stuck" jobs without classification (RETRYABLE vs TERMINAL).
**VERIFY:** depth trending to baseline; failure rate flat.

## 12. SMTP failure
**DETECT:** emailDelivery logs; bounce/timeout errors.
**IMPACT:** FEATURE-UNAVAILABLE — emails queue/flag truthfully; no business state lies ("queued" is never faked).
**DO:** provider status → credentials/limits → restart; backlog sends after recovery. **DO NOT:** disable verification flows to "unblock" users.
**VERIFY:** test send via staging path.

## 13. Object storage failure
**DETECT:** upload/download 5xx; provider errors in logs.
**IMPACT:** private file features refuse safely (production has NO local-disk fallback by law).
**DO:** provider incident procedure; check pending multipart/temp cleanup after recovery.
**DO NOT:** enable the dev local-disk fallback in production; make any object public.
**VERIFY:** one authorized upload + download round-trip per resource type.

## 14. Realtime (SSE) failure
**DETECT:** clients stop receiving events; ticket 503s; Redis pub/sub down (see §8).
**IMPACT:** ephemeral event delivery pauses; core CRUD unaffected. Reconnect is client-bounded (`retry: 5000`).
**DO:** restore Redis (§8); check proxy buffering config (`X-Accel-Buffering: no` must survive); per-process stream cap (503) → scale API replicas if persistently saturated.
**DO NOT:** raise caps infinitely; add polling as a "fix" without product decision.

## 15. Cache degraded mode
**DETECT:** `cache: down` + DEGRADED status.
**IMPACT:** per-request DB reads (slower); tenant-scoped caches cold. Correctness unaffected (cache never authorizes).
**DO:** nothing heroic — recover Redis (§8). **DO NOT:** bypass tenant scoping to "reduce load"; add stale-cache reads.

## 16. Rate limiter degraded mode
**DETECT:** limiter logs reporting local-bucket mode.
**IMPACT:** limits become per-instance (N instances ⇒ up to N× local budget) — documented availability trade-off, security posture unchanged.
**DO:** restore Redis; keep abusive-IP blocklists at the edge if available. **DO NOT:** disable limiters; claim global correctness while degraded.

## 17. Index rollout
**DO:** staging rehearsal of the schema change → deploy code (ODM creates indexes additively) → verify plans/slow-query metrics.
**DO NOT:** `syncIndexes()`/`dropIndex` in production; auto-dedupe before a new unique index (conflict **preview** first); change TTL semantics casually (data-deleting).
**VERIFY:** `npm run index:check`; explain() uses the index.

## 18. Config validation
**DO:** `npm run config:check` (names/statuses only) — first step of every deploy; `--production` enforces the real-JWT-secret law. Misconfigurations fail startup with name-only errors by design.
**DO NOT:** paste values into tickets/logs; "fix" a fail-fast by weakening the guard.

## 19. Load test — NON-PRODUCTION ONLY
**DO:** `npm run ops:load-check` then `npm run load:api` / `load:realtime` against localhost/staging with synthetic data; isolated prefix; run-scoped cleanup.
**DO NOT:** production (the tool refuses `NODE_ENV=production` — keep the guard); claiming "supports N users" from loopback numbers.

## 20. Failure test — NON-PRODUCTION ONLY
**DO:** hermetic suites (`npm run test:phase32` includes failureRecovery) / isolated dev injection only.
**DO NOT:** any remote/HTTP chaos trigger (none exists — pinned), production env failure toggles (none exist — pinned), disabling retries to dodge duplicate-detection tests.
