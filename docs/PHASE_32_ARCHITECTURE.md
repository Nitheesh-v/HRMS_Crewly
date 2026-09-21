# CREWLY — FINAL PHASE 32 PRODUCTION ARCHITECTURE

**Status:** Phase 32.18 close-out · Application **production-architecture ready** (this is NOT a production deployment — §110 of the close-out rules). Provider-neutral throughout: no hosting/CDN vendor is selected.

---

## 1. Topology (as actually implemented)

```
                         INTERNET
                             |
                             v
                  DNS → CDN / EDGE  (NOT SELECTED — 32.16 contract)
                             |
                             v
                     LOAD BALANCER  (TLS termination; 32.3 proxy trust)
                    /       |       \
                   v        v        v
               API #1    API #2    API #N     ← node src/server.js (stateless;
                   \        |        /            JWT auth; no sticky sessions)
                     +------+------+------------------+
                     |      |                         |
                     v      v                         v
                  MongoDB  Redis                Object Storage
                (business   (32.6 cache · 32.4 rate     (32.8 private;
                 TRUTH)      limits · BullMQ · SSE        public static ≠ private)
                             pub/sub · SSE tickets)
                             |
                           BullMQ  (at-least-once; env-prefixed queues)
                    /      |       \
                   v       v        v
              Worker #1 Worker #2 Worker #N   ← node src/workers/index.js

  Realtime: 32.11 SSE — integrated INSIDE each API process (no 4th process
  type): POST /ticket → GET /stream?ticket=… (one-time 30s ticket, Redis-
  backed, tenant-scoped channels, X-Accel-Buffering: no).
```

## 2. Phase 32 status matrix (verified at close-out, HEAD `cadb09e`+32.18)

| Unit | Scope | Status |
|---|---|---|
| 32.1 | Architecture & multi-instance readiness | IMPLEMENTED · TESTED |
| 32.2 | Health, readiness, graceful lifecycle | IMPLEMENTED · TESTED (`healthLifecycle`) |
| 32.3 | LB / reverse-proxy trust | IMPLEMENTED · TESTED (`proxyReadiness`, adversarial forged-XFF pins) |
| 32.4 | Distributed rate limiting | IMPLEMENTED · TESTED (`distributedRateLimit`) |
| 32.5 | Mongo performance & index policy | IMPLEMENTED · TESTED (`indexCoverage`, `apiPerformanceBounds`) |
| 32.6 | Redis cache hardening | IMPLEMENTED · TESTED (`cacheMultiInstance`, `redisFoundation`) |
| 32.7 | BullMQ & worker scaling | IMPLEMENTED · TESTED (`bullmqFoundation`, `multiWorkerSafety`) |
| 32.8 | Object storage & uploads | IMPLEMENTED · TESTED (`privateStorageServices`, `privateFileAccess`) |
| 32.9 | Frontend performance | IMPLEMENTED · TESTED (route-level lazy chunks; build verified) |
| 32.10 | API performance | IMPLEMENTED · TESTED (`apiPerformanceBounds`) |
| 32.11 | Realtime foundation | IMPLEMENTED · TESTED (`realtimeFoundation`) — Chat/Presence NOT built |
| 32.12 | Observability | IMPLEMENTED · TESTED (`observabilityFoundation`) |
| 32.13 | Load tooling | IMPLEMENTED · TESTED (`loadTooling`) — sandbox results runner-only, non-production |
| 32.14 | Failure & recovery | IMPLEMENTED · TESTED (`failureRecovery` 23 tests) |
| 32.15 | Deployment architecture | IMPLEMENTED · TESTED (`deploymentConfig`) |
| 32.16 | CDN / static delivery contract | IMPLEMENTED · TESTED (`staticDelivery`) — provider NOT selected |
| 32.17 | Security hardening | IMPLEMENTED · TESTED (`phase32SecurityAdversarial`) — defect register empty |
| 32.18 | Audit, runbooks, structure, close-out | THIS UNIT |

## 3. Multi-instance truth

API processes hold **no authoritative local state**: JWT stateless auth; Mongo = business truth; Redis = cache/limiter/queues/pubsub/tickets (never truth); rate-limit identity = trusted effective IP (32.3 sole trust point); sessions are DB-backed; SSE tickets live in Redis so any instance can serve a stream; graceful drain is process-local by design. Remaining process-local state (safe, documented): in-memory degraded-mode limiter buckets (32.4 documented degraded mode), cache single-flight coalescing, drain flag, coarse process diagnostics sampler.

## 4. Data layers

- **Mongo (authoritative):** 124 flat models (intentionally flat — high import cost, §79); hot paths covered by schema-declared indexes verified by `indexCoverage` (no runtime `syncIndexes`/`dropIndex` anywhere); bounded queries + pagination pinned by `apiPerformanceBounds`; per-instance pool default with deployment connection budgeting documented in runbooks; index rollout = staging rehearsal, never destructive sync in production.
- **Redis roles:** cache (tenant-scoped, generation-invalidated, TTL-bounded), distributed limiter tier, BullMQ broker, realtime pub/sub + one-time SSE tickets, worker ops keys. Namespace root `crewly:<env>:` everywhere — environments can never collide. Degraded mode: cache falls back per-request, limiters run documented local buckets, queues pause (Mongo truth unaffected). Never `FLUSHALL/FLUSHDB/KEYS/SCAN`.
- **Object storage (32.8):** private durable storage for resumes/offer docs/BGV evidence/payslips with authorization-gated delivery (`private, no-store`), size/type caps, traversal-refusing keys, dev-only inline fallback (production-refused), scanner status truthful (never fake-CLEAN). Public static (frontend build) and private storage are permanently separate classes.

## 5. Frontend delivery (32.9 + 32.16)

React SPA, Vite, route-level lazy chunks, root-relative build, **no source maps**, no service worker. Delivery contract (provider-neutral): hashed `assets/*` → `public, max-age=31536000, immutable`; `index.html` → `no-cache`; public non-versioned assets → short revalidate; **every `/api/*` response → `private, no-store, max-age=0`** (default-deny middleware); SSE → never cached/buffered; deploy assets BEFORE HTML; retain previous-release assets for rollback/open tabs; SPA fallback never serves HTML for missing assets; `/api/*` bypasses static routing. Auth UI redesign (developer-directed, post-32.17, commit `cadb09e`) is presentation-only on unchanged auth flows.

## 6. Security posture (32.17 + close-out re-verification)

Threat matrix S-01…S-25 all PASS; defect register **empty**. Behavioral pins: forged X-Forwarded-* inert without declared trust; limiter identity cannot be multiplied by forged headers; health bodies label-only; redaction strips query strings/Bearer/JWT/URIs/token-paths and neutralizes log injection; unknown jobs fail loudly; GET never finalizes decisions; no static mounts/cookie writes/chaos toggles/innerHTML; helmet headers (nosniff, SAMEORIGIN + frame-ancestors, `referrer-policy: no-referrer` — token-URL-safe, HSTS without preload; frontend CSP = documented static-host template). Statement limited to what tests support: the documented adversarial matrix passes; security remains ongoing; **no claim of "completely secure"**.

## 7. Capacity & failure (honest)

- **Load (32.13):** measured in a **sandbox loopback mock** environment, runner-only — throughput/latency tables live in `docs/PHASE_32_13_*` with explicit environment disclaimers. **No "supports N users" claim exists or is valid.** Production capacity = measuring again in a real deployment.
- **Failure (32.14):** at-least-once queues (never exactly-once); idempotent financial commit points (duplicate job ≠ duplicate money); API hard-death mid-response bounded by client retry; worker death mid-job → BullMQ retry with stalled-job reconciliation; Redis loss → DEGRADED (never bypasses authorization); Mongo loss → not-ready (no stale-cache mutation fallback); SMTP/storage/realtime failures → feature-unavailable/refused safely, all classification-vocabulary truthful. Load/failure tooling is CLI-only and production-refusing.

## 8. Deployment (32.15)

DEVELOPMENT / STAGING / PRODUCTION with separate Mongo databases and per-env Redis namespaces (staging can never consume production jobs). Process types: API / Worker / Frontend artifact. Startup tiers: fail-fast (Mongo always; real JWT_SECRET in production — dev default refused), DEGRADED (Redis-class), FEATURE-UNAVAILABLE (SMTP/storage). `npm run config:check` (offline, `--production` law) is pre-flight step #1. Rollout: config → worker (compatible) → API rolling behind health probes → frontend artifact; assets-before-HTML; rollback = previous artifacts + retained hashed assets; DB stays forward-compatible (additive evolution). Production deploy remains a **manual-approval** operation. **CDN provider: NOT SELECTED** — provider work (DNS/TLS/origins/cache rules/HSTS final/CSP-on-HTML) is a separate future authorized task.

## 9. Known limitations (explicit)

No CDN/hosting vendor selected (edge WAF, final HSTS/CSP, purge, log redaction = provider work) · localhost load results are not production guarantees · client geolocation is spoofable (no biometric proof) · queues at-least-once · realtime delivery is ephemeral (no offline replay; transport heartbeat ≠ employee presence) · no Chat, no Presence, no AI · process-local single-flight/degraded limiter modes are per-instance by design · local dev storage fallback is dev-only · frontend lint carries 113 pre-existing errors (documented, cosmetic-cleanup deferred).

## 10. Deferred / future roadmap (PROPOSED — NOT AUTHORIZED)

Tenant Custom Roles & Advanced RBAC · Crewly Chat Hub · Teams-like Presence & Availability · Crewly AI Assistant · controllers/routes/validators domain-nesting (dedicated structure phase) · provider-specific deployment task after vendor selection. No code or scaffolding exists for any of these.

## 11. Project structure (final state)

Backend: `src/{config,controllers(99 flat·intentional),routes(55),services(attendance/bgv/payroll subdirs + flat domain services),validators(49),middlewares(29),models(124 flat·intentional),utils(56),infrastructure/{observability,realtime,storage},workers}` · `scripts/` grouped: `load/` + `preview/` (32.18 move) + flat ops CLIs · `test/` 196 files flat (explicit-path npm scripts). Frontend: `src/{pages(≈25 domain dirs),components,services,routes,layout,hooks,utils,assets}`. Verified: route imports resolve, `worker`/`config:check`/`ops:load-check`/`load:*`/`preview:*` scripts resolve, no legacy `bull`, no stale import paths.

## 12. Current test totals (this checkout, this close-out)

- **Full backend ladder:** 2167 tests · 2167 pass · 0 fail (two consecutive green runs; one earlier run had a single timing flake that did not reproduce).
- **Targeted Phase 32 (`npm run test:phase32`, new in 32.18):** 17 suites · 312 tests · 312 pass.
- **Frontend:** lint 132 problems (113 errors, 19 warnings — pre-existing baseline, zero from Phase 32/auth-UI work); production build ✓ (hashed assets, no maps, secret-scan of 276 dist files: clean).
