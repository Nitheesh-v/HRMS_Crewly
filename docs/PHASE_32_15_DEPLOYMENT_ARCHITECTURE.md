# Phase 32.15 — Environment & Production Deployment Architecture

**Status:** Implemented (code + tests in repo). Production itself is NOT deployed — this document is the deployment *architecture* and runbook-of-record. No vendor is selected; every external capability is described by what it must do, never by who provides it.
**Scope guard:** This phase adds no Docker/K8s/PM2/CI/migration framework and no deployment SDK. Existing tooling is exactly what ships. Production rollout remains a **manual-approval** human operation.

---

## 0. Vocabulary (used throughout)

| Term | Meaning |
|---|---|
| **API process** | `npm run start` → `node src/server.js`. Stateless HTTP + integrated realtime SSE (32.11). |
| **Worker process** | `npm run worker` → `node src/workers/index.js`. BullMQ consumers + schedulers. |
| **Frontend artifact** | `npm run build` output (`dist/`). Static files + `index.html`; contains **only public** `VITE_*` values. |
| **DEGRADED** | Process up, one Redis-class subsystem unavailable, core CRUD works (32.2 semantics). |
| **FEATURE-UNAVAILABLE** | Optional integration (SMTP, object storage, encrypted-field flows) absent; named features refuse safely. |
| **config:check** | Offline pre-flight: `npm run config:check` (§3). Names + statuses only — **never values**. |
| **Expand/contract** | Backward-compatible change pattern used for all migrations and rollouts (§5). |

---

## 1. Environment topology (DEVELOPMENT / STAGING / PRODUCTION)

Three environments, **three fully separate data planes**:

```
DEVELOPMENT (developer laptop / this repo checkout)
  API:        npm run dev (nodemon)   PORT default 5000
  Worker:     npm run worker          optional locally
  Mongo:      local/dev instance      own database (e.g. crewly_dev)
  Redis:      REDIS_ENABLED=false by default (in-memory fallbacks)
  Frontend:   npm run dev (Vite) or npm run build + preview

STAGING (deployment environment, semantics identical to production)
  API:        node src/server.js      PORT from environment
  Worker:     node src/workers/index.js
  Mongo:      its own database server/cluster — NEVER the production one
  Redis:      its own instance, BULLMQ_PREFIX=crewly:staging:
  Frontend:   npm run build artifact (VITE_API_URL → staging API URL)
  Data:       synthetic only (§8). SMTP sandbox expected (§8).

PRODUCTION
  API:        node src/server.js      PORT from environment; N instances behind a proxy/LB
  Worker:     node src/workers/index.js; replica count chosen at deploy time (not in code)
  Mongo:      dedicated production database server/cluster
  Redis:      dedicated instance, persistence ON, no-eviction (§7)
  Frontend:   npm run build artifact served by static hosting/CDN-class service
```

**Hard isolation laws (verified in `test/deploymentConfig.test.js`):**
- Mongo: three **separate databases/servers**. Tenant isolation (`companyId`) is *within* one environment; it is never a cross-environment boundary.
- Redis/BullMQ/cache/rate-limit/realtime: per-environment instances **and** a per-environment key namespace (`BULLMQ_PREFIX=crewly:<env>:`). A staging worker is structurally unable to consume a production job: different Redis *and* different queue prefix.
- Realtime channels are prefixed with the same environment namespace root — a staging SSE client cannot subscribe to a production channel.
- `NODE_ENV` remains the standard Node value (`development|test|production`). An optional **deployment-environment identifier** may be added later as a separate informational variable; no behavior keys off it today (minimum-config law).

## 2. Process types (exactly three)

The application deploys as **API, Worker, Frontend-build-artifact — nothing else**. Realtime is integrated inside the API process (32.11 decision); there is no fourth process type and no dedicated realtime deployment.

| Concern | API | Worker | Frontend artifact |
|---|---|---|---|
| Start command | `node src/server.js` | `node src/workers/index.js` | served statically |
| Deterministic prod start | yes (no watcher) | yes (no watcher) | n/a |
| Horizontal scale | any N; **stateless** (§4) | replica count is a deployment choice; BullMQ work-stealing is already multi-consumer safe | static; scale at the serving layer |
| Health | `/api/health/live`, `/api/health/ready` (32.2) | liveness = process up + queues resumed; readiness = Redis+Mongo connected | static reachability |
| Sticky sessions | **never** (JWT is self-contained) | n/a | n/a |

API and Worker are **never merged** into one process/container-class unit: different scaling axes, different failure profiles, independent restarts.

## 3. Configuration surface & offline pre-flight (`config:check`)

- Full name inventory lives in **`Backend/.env.example`** (kept drift-pinned by test). ~60 active names; frontend uses **only** `VITE_API_URL` + `VITE_MAX_RESUME_SIZE_MB` (public by design).
- Access patterns: direct `process.env.X` for simple values; strict bounded parsers (`source?.X` style) for Redis, queues, proxy trust, realtime, observability, cache TTLs, concurrency — every parser clamps/refuses instead of accepting nonsense.
- **`npm run config:check`** (Backend) — exits **0** valid, **1** configuration problem, **2** usage/IO error:
  - dev mode: flags hard problems (missing `MONGO_URI`; `REDIS_ENABLED=true` with no `REDIS_URL`; invalid `TRUST_PROXY_MODE`; missing `JWT_SECRET`); reports warnings (missing optional integrations: SMTP, Cloudinary, Razorpay, `FIELD_ENCRYPTION_KEY` → feature-unavailable, verify per deployment).
  - `--production`: additionally enforces the production JWT law (real secret, not the dev default, ≥32 chars) via the same pure validator the server uses.
  - Performs **zero network I/O** (test-pinned: no mongo/redis/HTTP imports).
  - Output discipline: `NAME: configured|missing|invalid(reason)` **only** — never values, lengths, or fingerprints. Secrets are supplied out-of-band; this tool proves presence, not content.
- Run it as the **first** pre-deploy checklist step in every environment.

## 4. Runtime statelessness & startup semantics

- API instances hold **no local authoritative state**: JWT auth (stateless), Mongo = business truth, Redis = cache/queues/rate-limit/realtime transport only. No sticky sessions; any instance can serve any request; instances may be added/removed freely behind the LB.
- Startup tiers (per 32.2, unchanged):
  - **Fail STARTUP (exit 1)** only for impossible-without-it config: `MONGO_URI` (any env); real `JWT_SECRET` in production (`env.js` production gate — the dev default `'dev_secret_change_me'` is refused, <32 chars refused; errors name variables, never values).
  - **DEGRADED**: Redis-class subsystems unavailable (cache, queues, rate-limit persistence, realtime transport) — health `/ready` reports DEGRADED, core CRUD keeps working.
  - **FEATURE-UNAVAILABLE**: SMTP, storage provider, encrypted-field flows — named features refuse safely; server otherwise normal.
- Local disk as BGV evidence storage remains **refused in production** (32.8 law, guard-tested).

## 5. Data evolution: migrations, indexes, backfills

- **Mongo evolves additively.** Mongoose schemas declare indexes; the codebase contains **zero** `syncIndexes()` / `dropIndex` / programmatic `createIndex` calls (test-pinned). Schema-declared indexes are created/updated by the ODM's normal drift repair on connect; **nothing ever auto-drops**.
- **Index rollout procedure** (per new/changed index): (1) deploy the staging build → confirm index creation + `explain()` plan; (2) production: deploy code — new indexes build in the background; **never** run destructive sync in production; (3) verify via `collStats`/slow-query metrics.
- **Unique index introduction**: FIRST run a duplicate-conflict **preview** (read-only aggregation) against production-shaped data; resolve conflicts through product workflow — the system **never auto-dedupes**.
- **TTL index changes are data-deleting** by definition: treated as destructive, require explicit approval, staging rehearsal, and a stated retention intent.
- **Backfills** (none required today; policy): preview query → count → bounded idempotent batches → verify counts. Backfills run as **manual scripts by the operator, with approval** — not at boot, not in request paths.
- **Migration locking**: startup reconciliation is idempotent and may safely re-run. Any future destructive migration requires a deliberate human owner, a written runbook entry, and a pre-declare backup.

## 6. Deployment ordering (expand/contract)

Rollouts are **backward-compatible first** so both old and new processes can run simultaneously:

1. **Queue payloads**: when a job payload shape changes, deploy **workers that accept old AND new payloads first**; new API producers go second. (Old workers + new payloads must also be survivable → producers keep fields additive.)
2. **DB fields**: when workers need new DB fields, **API-first** (writes the new fields), workers second.
3. Standard sequence per release: `config:check` → deploy Worker (compatible subset) → deploy API instances **one at a time** behind the LB health checks (32.2 live/ready gates instance removal) → deploy frontend artifact last (it is versioned-static and tolerates old APIs via additive contracts).
4. **Never** flush/delete queues or cache to "clean up" a deploy. Queues carry real user work; in-flight jobs complete or retry across deploys (32.14 at-least-once semantics, exactly-once commit points verified by test).

## 7. Infrastructure capability expectations (vendor-neutral)

The deployment environment must provide — described as capabilities, **no provider named or configured**:

- **Managed relational-free document store** (Mongo-compatible): automated backups + point-in-time restore expectation, monitoring, TLS endpoint. Business truth lives here.
- **Managed Redis with persistence (AOF/RDB-class) and a no-eviction or volatile-noeviction-class policy** for the BullMQ deployment: queues must survive instance restarts; silent key eviction would corrupt job state. Cache-only Redis may degrade; queue Redis may not. Mongo remains business truth — queues are durable work transport, not records of account state.
- **Secret management**: any mechanism where secrets are injected at runtime (env injection from a secrets store). Secrets are **never committed**, never baked into images/artifacts, never logged. `FIELD_ENCRYPTION_KEY` backup is **critical**: losing it permanently loses encrypted-field data; rotation is documented as a future, purpose-built operation — **not implemented** (never "generate another one" casually).
- **TLS**: required for all internet-facing endpoints, terminated at the proxy/LB or the process, never disabled; `NODE_TLS_REJECT_UNAUTHORIZED=0` / `rejectUnauthorized:false` is forbidden repo-wide.
- **Reverse proxy**: `TRUST_PROXY_MODE` configured to the real topology (default `direct` trusts nothing); `config/proxyTrust.js` is the sole trust point. CORS stays an explicit origin allowlist (`CLIENT_URL`) — **never `*`**.
- **Logs → stdout/stderr**; the deployment layer captures, ships, retains. No file-based log management in-process.
- **Runtime baseline**: the currently **tested** runtime is the one documented at acceptance time (Node version printed by `node --version` on the validating machine). No `engines` field is declared until a support baseline is actually chosen — do not guess.
- **`npm ci` vs `npm install`**: deployments use `npm ci` (lockfile-exact). `npm install` is for local development lockfile changes. `npm update` and `npm audit fix` are **forbidden during a deployment window** (dependency drift = untested deploy).

## 8. Staging environment policy

- **Semantic/config parity** with production (same code path, same process types, same config names), **smaller scale**, single API + single worker replica is acceptable.
- **Synthetic data only.** No copies of production HR/payroll/BGV data, ever (privacy + the payroll-fabrication laws).
- **Email**: staging uses an SMTP **sandbox** (messages captured, not delivered to real recipients). No recipient-rewriting logic in business code — the sandbox is infrastructure, not a code branch.
- **Billing & BGV**: test-mode keys/gateways only. No bypass flags exist; `PaymentStatus` is never manually set to `PAID` — verification callbacks only (standing law).
- Staging runs the **full test ladder** and the pre-deploy checklist before any production approval.

## 9. CI/CD (conceptual stages only) & the manual gate

No CI system exists in this repo and none is added. The **conceptual** pipeline any future automation must implement:

```
[stage 1] install (npm ci) → lint → full test ladder (hermetic)
[stage 2] backend config:check --production  (offline)
[stage 3] frontend npm run build (artifact = deployment candidate)
[stage 4] deploy to STAGING → smoke + rehearsal (§10 ordering)
[stage 5] MANUAL APPROVAL — a human runs the production checklist
[stage 6] production rollout per §6, monitored (§11)
```

Stage 5 is a hard, human gate. Automation may prepare everything; **it never executes stage 6 unattended**.

## 10. Pre-deploy / deploy / post-deploy checklists (values-free)

**Pre-deploy (per environment)**
- [ ] `npm ci` clean install on the deploy artifact/checkout
- [ ] Full test ladder green (hermetic; recorded totals in the release note)
- [ ] `npm run config:check` (‑-production in prod) → exit 0
- [ ] Staging rehearsal of the SAME build completed (§5 index steps for any index change; §6 ordering)
- [ ] Backups verified restorable (§7 expectation) before any schema/index-affecting release
- [ ] Rollback target identified: previous artifact version + previous frontend build retained
- [ ] **No secret values anywhere in tickets, checklists, or logs**

**Deploy**
- [ ] Rollout ordering per §6 (worker-compat → API rolling → frontend)
- [ ] API replaced instance-by-instance behind live/ready health checks
- [ ] Abort conditions watched: config-check failure, never-ready instances, 5xx spike vs baseline, worker failure loop, queue incompatibility errors, migration error

**Post-deploy**
- [ ] `/api/health/live` + `/ready` = HEALTHY on all instances; worker queues resumed
- [ ] Error-rate and queue-failed-count back to baseline
- [ ] One representative auth + tenant-scoped read + payroll **read** path verified
- [ ] Frontend smoke against the new API; release note totals recorded

**Rollback triggers (immediate)**: auth failures across tenants, cross-tenant data leakage, payroll-calculation correctness regressions. **Recoverable-condition triggers**: elevated 5xx, queue backlog growth, DEGRADED flapping — triage forward vs back within the error budget of the incident.

**Rollback strategy**: application = redeploy previous artifact (frontend: previous static build; API/Worker: previous version, both able to run against the current schema because **§5 keeps migrations backward-compatible**). Config rollback = revert changed env names via the secrets manager (config:check validates before restart). **Database rollback is NOT assumed easy** — additivity exists precisely so data never needs rolling back; if a release proves bad, the app rolls back, the data stays forward-compatible. Destructive migration reversal is an explicit, approved, backup-verified operation — never routine.

## 11. Health, observability & load/failure tooling boundary

- LB/proxy health checks use **only** `/api/health/live` and `/api/health/ready` (32.2) — never business endpoints. Legacy `GET /api/health` remains always-200 for compatibility.
- Logging = stdout JSON (existing logger); process diagnostics sampler = existing 32.12 coarse sampler. **No APM/logging vendor, no npm telemetry package** (32.12 standing law).
- Load-testing (`npm run ops:load-check`) and failure-injection (32.14 harness) are **development/staging-only tooling with built-in guards** (`REFUSED: NODE_ENV=production`). Production docs must never instruct running them against production, and the guards stay — no exceptions.

## 12. What Phase 32.15 does NOT do

Does not provision infrastructure, choose a vendor, deploy production, change DNS/CORS, connect to any production data plane, apply production indexes, upload secrets, add Docker/K8s/PM2/CI, implement key rotation, or move files (restructuring belongs to 32.18). It defines **how** Crewly is configured, validated, deployed, and rolled back — evidence-backed by `test/deploymentConfig.test.js` and the offline `config:check` CLI.

## 13. Localhost validation

The PowerShell walkthrough for validating this phase on a developer machine (config:check demo, safe missing-config demo, dev start, prod-style start, worker lifecycle, two-API no-sticky re-verify, frontend build, env-prefix check, 10-step rollout rehearsal) lives in **`docs/PHASE_32_15_LOCALHOST_ACCEPTANCE_GUIDE.md`**.
