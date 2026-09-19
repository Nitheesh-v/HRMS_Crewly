# PHASE 32 — PRODUCTION INFRASTRUCTURE, SCALABILITY & PERFORMANCE

# 32.6 — Redis & Multi-Instance Cache Hardening

Status: **32.6 implemented** (awaiting localhost acceptance). MongoDB
remains the sole authority; Redis is coordination. This unit closes the
exact invalidation gap Phase 32.1 deferred to 32.6 (architecture record
§5 items 3–4 / §9): the two PROCESS-LOCAL caches — the subscription
feature gate and the permission caches — now also carry a SHARED Redis
generation as the cross-instance invalidation signal.

## CACHE INVENTORY (audited, A–F classified)

| Cache | Scope / storage | Invalidation | Verdict |
| --- | --- | --- | --- |
| Recruitment analytics | tenant+filterHash, shared Redis (gen-embedded keys, TTL) | shared generation INCR on mutations (6+ sites) | **A** — multi-instance safe |
| Attendance analytics | tenant+scope, shared Redis (same pattern) | shared generation INCR (events, regularization, OT, finalization, leave) | **A** |
| Payroll caches (setup/engine/review/payment/payslip/statutory/salaries/inputs/F&F) | tenant keys, shared Redis, TTL | exact-key DEL after mutations | **A** — shared-Redis DEL is cross-instance; DEL-failure bounded by TTL |
| Attendance policy | tenant key, shared Redis, TTL | exact DEL on activate/update | **A** (stale window = TTL) |
| Subscription gate (`subscriptionGateCache`) | tenant, process-local Map, 5–60s TTL | same-process hooks + **NEW shared generation** | **B → FIXED in 32.6** |
| Permission grants (5-min) + metadata (15s) | process-local Maps | same-process controllers/hooks + **NEW shared generation** | **B → FIXED in 32.6** |

## THE 32.6 CHANGE — shared-generation overlay (`utils/cacheGeneration.js`)

Key: `crewly:cache:company:<companyId>:<namespace>:generation` (same
shape as the 28.7 analytics generations; namespaces `subscription:gate`
and `security:permissions`). Read = fail-open GET, 100ms-tight op bound,
Redis-down short-circuited by the health flag at zero cost:

- shared generation **null** (Redis unusable) → local-TTL behavior
  EXACTLY as pre-32.6 (bounded staleness, documented honestly: while
  Redis is down, invalidation is per-process and staleness is bounded
  only by the local TTL — 60s worst case);
- integer generation → authoritative: a local entry stamped with an
  older generation is reloaded from Mongo; equal = hit.

Bump = `INCR` + refreshed 24h TTL inside the EXISTING invalidation
functions (`invalidateSubscriptionGateCache`,
`invalidatePermissionCache`) — fire-and-forget, never throws, never
blocks or rolls back a valid Mongo write (§12). Invalidation coverage
is unchanged-and-pinned: the same Subscription post-save/delete hooks
and role-controller call sites now emit the cross-instance signal.

## MULTI-INSTANCE SEMANTICS

API #1 mutation → hook → shared generation INCR → API #2's next read
observes the new generation → its old entry is stale → fresh Mongo
read. Proven with TWO independent cache-consumer instances over ONE
injected backend, in both directions, including a simulated
external-process bump (`test/cacheMultiInstance.test.js`, 15 tests).
Tenant generations are tenant-scoped: Company B's bump can never
revoke/validate Company A's entries (test-pinned).

## SINGLE-FLIGHT / STAMPEDE DECISION

**KEEP PROCESS-LOCAL.** Cross-instance duplicate misses are bounded
Mongo-backed loads — a performance duplication, never a correctness
issue; no evidence of synchronized-miss pressure on expensive rebuilds
was found (analytics reads are bounded aggregates; rebuild cost is
modest). The §15 high bar for distributed lock/lease coordination is
NOT met; introducing one would add fragility for no measured benefit.
32.13 load testing may revisit with evidence.

## TTL / STALENESS

Gate TTL 5–60s (env-clamped, default 15s); permission grants 5-min,
metadata 5–60s; analytics value TTLs unchanged; generation counters
carry a refreshed 24h TTL (bounded orphans, no permanent keys). Worst
stale windows: healthy Redis → next request after a mutation; Redis
down → local TTL only.

## NAMESPACE SEPARATION (rate limits / cache / queues)

`crewly:<env>:rl:<family>:` (32.4 limiters) · `crewly:cache:company:…`
(all caches incl. generations) · `crewly:<env>:` BullMQ keyspace —
prefix-disjoint (test-pinned). Cache operations touch only exact
self-built keys: no cache clear can ever reset a limiter, and no
invalidation can touch queue keys. No KEYS/SCAN/FLUSH anywhere; no
generic cache-clear endpoint exists (by design, §53).

## SENSITIVE-DATA POLICY

Cached payloads remain: gate booleans/module lists, permission id-set
summaries, bounded analytics aggregates, payroll config summaries —
field-encrypted values stay encrypted (setup cache stores ciphertext).
Never cached: passwords, raw tokens, resumes/binaries, BGV evidence,
bank details, GPS. 256KB payload guard sits in `setCache` before any
write (test-pinned); corrupt envelopes fail safely to the source.

## CONNECTION ARCHITECTURE

One shared ioredis client for cache + rate limiting + generations
(exact-key commands only); BullMQ keeps its dedicated connections —
no lifecycle merging performed (§27).

## FOLDER STRUCTURE

Added: `src/utils/cacheGeneration.js` — placed beside its two consumers
(`subscriptionGateCache.js`, `permissionService.js`). Files moved:
none. Deleted: none. Import changes: `subscriptionEngine.js` (2-line
await of the now-async gate read/write). Repo-wide structural debt
(flat `utils/`, `services/` growth) remains documented for **32.18**.

## REDIS FAILURE BEHAVIOR (pinned by tests)

GET-failure → null generation → local-TTL mode (per-process, weaker —
documented) · bump-failure → `false`, business write unaffected ·
SET-failure → source result returned (existing 28.7 contract) · corrupt
value → exact-key delete + source read.

## IMPLEMENTED / TESTED / DEFERRED

- IMPLEMENTED + TESTED: shared-generation overlay, both cache wirings,
  A/B multi-instance suite (15/15), namespace pins, failure pins,
  regressions (full `test:all` 1939/1939 at implementation time).
- DEFERRED: cache-key environment prefixing (`crewly:cache:` is NOT
  env-scoped while queues/RL are — real collision needs two envs
  sharing one Redis AND identical ObjectIds; align when a deployment
  actually does this → **32.15**) · distributed stampede coordination
  (evidence-gated → **32.13**) · broader observability of cache
  behavior (**32.12**; per-process stats already exist, documented
  process-local).

# 32.5 — MongoDB Performance & Index Hardening (Evidence-First)

Status: **32.5 implemented** (awaiting localhost acceptance). Central
rule honored: MEASURE/INSPECT FIRST, CHANGE SECOND. The audit found the
index architecture (built up through phases 27–31) fundamentally sound;
the ONE proven hot-path defect — the BGV verifier work queue — is fixed.
**Zero new indexes, zero removed indexes, zero unique/TTL changes, zero
new env variables, zero new dependencies.**

## GROUND TRUTH (machine-assisted inventory, §47)

`npm run index:check` loads all **124 models with zero DB connections**
and reports: **615 declared indexes across 124/124 collections (unique:
105, TTL: 11, partial: 25, sparse: 3) — zero index-free collections.**
It then evaluates the **hot-query catalog** (18 pinned query families,
each citing file:line) under documented conservative rules (index-prefix
equality; `findOne` point-served when any equality key is UNIQUE-led).
Exit 1 on any GAP. `npm run test:index-coverage` (12 hermetic guards)
pins the verdicts, crown-jewel index definitions, tenant-first law, TTL
housekeeping, and query↔index source shapes.

## THE ONE CODE FIX — BGV verifier work queue (B-class, proven)

BEFORE (`verifierWorkQueue`): read the platform's ENTIRE CURRENT-assignment
table (`find({activeKey:'CURRENT'})`, unbounded §21), filter to the
verifier in memory, then per-row loads — **1 + M + 3M queries** (N+1, §22).
AFTER: the authorization predicate moved INTO the read —
`find({verifier, activeKey:'CURRENT'})` (served by the EXISTING
`{verifier}` index; no new index per §49 write-amplification law) — plus
ONE `$in` read per collection (orders, companies, cases, verifications,
the latter keeping `companyId: {$in}` tenant dimension). **Flat 5-6
queries for any queue size.** Rows are byte-identical; the client never
supplies a verifierId (unchanged law); the queue test pins the exact
collaborator-call list, so the N+1 cannot return. Assignment-as-
authorization is now ALSO enforced at the DB read (strictly narrower).

## INDEXES ADDED / MODIFIED / REMOVED

**None.** Every candidate was evaluated and rejected with reasons:

| Candidate | Verdict | Why |
| --- | --- | --- |
| Attendance `{companyId, liveState}` (Who's-Working OPEN_STATES `$or` branch has no date bound) | MEASURE ONLY → 32.13 | branch is index-bounded per user via `{companyId,user,date}` prefix; partial index not expressible (`$in` unsupported in `partialFilterExpression`); full compound duplicates existing data volume + writes on the morning-critical collection. Decide with `$indexStats` under real load |
| BgvCheckAssignment `{verifier, activeKey}` compound | NOT NEEDED | per-verifier assignment set is tiny; single-field `{verifier}` already serves the scoped read |
| Unused `User` text index (name/email/employeeCode) | KEEP | removal policy (§32): no strong evidence; note recorded for 32.10 |
| BGV ops dashboard whole-collection working sets | DEFER | platform Super-Admin console, 30.x security-reviewed projections (sensitive subdocs excluded); row-count bounding is a 32.13/32.12 concern |

## AUDIT VERDICTS (A — already appropriate, verified not assumed)

- **Attendance (morning-spike priority, §6/§7):** every event/control
  read is `{companyId,user,date}` + `seq` sort → unique compound serves
  filter AND sort; idempotent replay rides the sparse unique
  `{companyId,user,requestId}`; writes append-only via control
  `eventSeq` counter — write amplification unchanged (no new indexes).
- **Who's Working / Operations:** batched `$in` design (31.x) verified
  intact — Promise.all + in-memory maps, no per-user queries.
- **Payroll (§11/§12):** tenant-unique compounds everywhere;
  PayrollResult's 29.13 ESR set (month-window + per-employee history +
  version uniqueness) verified; lists server-paged.
- **Recruitment (§13):** board/stage/source compounds; inbox paged ≤100,
  projected selects, tenant-matched populates; bulk ops re-verify tenant
  counts (cross-tenant guard).
- **BGV (§14):** verifier queue fixed above; tenant admin paths and
  verifier paths remain separate reads; nothing widened.
- **Workers (§43):** atomic `_id`+`companyId` claims; reconciler sweeps
  have purpose-built indexes (`EmailDelivery{status,createdAt}`,
  `AnalyticsReportFile{status,expiresAt}` — documented in-model).
- **Users/org (§15):** login, employee-code (partial unique), role,
  activity compounds verified.
- **Pagination (§20/§45):** caps verified server-side (careers 24,
  interviews 50, inbox 100, ops reconcile 100). Exports unchanged.

## CONNECTION-POOL STRATEGY (§29/§30)

Current: Mongoose 9 driver defaults + `serverSelectionTimeoutMS: 10000`.
Default `maxPoolSize` (100/instance) is a CEILING, not preallocation.
Budget principle: **N API instances × pool + W workers × pool** potential
connections (e.g. 3×100 + 2×100 = up to ~500) — document, don't tune:
no workload evidence justifies new tuning env vars today; sizing
integration belongs to **32.15** with real deployment numbers.

## EVIDENCE LIMITATIONS (§37, honest)

The sandbox has no `mongod`: live `explain("executionStats")` /
`$indexStats` baselines run on developer localhost / staging — recipes
below. Structural evidence (shape ↔ index-prefix match) is complete;
timing claims are deliberately NOT made. Capacity claims belong to
**32.13**.

## OPERATOR RECIPES (developer localhost only — read-only)

```js
// mongosh — winning plan for the pinned session-validation path:
db.securitysessions.explain("executionStats").findOne(
  { sessionId: "<id>", user: ObjectId("…"),
    companyId: ObjectId("…"), revokedAt: null,
    expiresAt: { $gt: new Date() } })
// expect: IXSCAN sessionId_unique, totalDocsExamined ≤ 1

// Which indexes real traffic uses (run over a busy day):
db.attendanceevents.aggregate([{ $indexStats: {} }])
```

No destructive commands are part of acceptance: never `dropIndex`/
`syncIndexes` casually — Mongoose autoIndex (default ON) creates
declared-only indexes at startup; production rollout planning → **32.15**.

## IMPLEMENTED / TESTED / DEFERRED

- IMPLEMENTED + TESTED: verifier-queue scoped+batched rewrite (14/14 in
  `test/bgvAssignment.test.js` incl. exact query-count pin), inventory
  auditor + hot-query catalog (`npm run index:check`, 18 entries, exit
  code contract), 12 hermetic index/shape guards, docs.
- DEFERRED: OPEN_STATES branch measurement → 32.13 ($indexStats); BGV
  ops working-set bounding → 32.13/32.12; pool sizing → 32.15; response
  payload tuning → 32.10; production index rollout strategy → 32.15.

# 32.4 — Distributed Rate Limiting & Abuse Protection

Status: **32.4 implemented** (awaiting localhost acceptance). Phase 32.3
made limiter identity honest; 32.4 makes security-sensitive limits keep
their intended MEANING when traffic is spread across API #1/#2/#N. This
is a security-correctness concern: 3 instances × 5 login attempts must
never mean 15 attempts.

## LIMITER INVENTORY & CLASSIFICATION (repository truth after 32.3)

All limiters were process-local `Map`s in `securityRateLimit.js` (one
module-level map) plus the Super Admin guard's own map.

| Surface | Window/Max | Key dimensions | Class |
| --- | --- | --- | --- |
| customer login (`/api/auth/login`, `/register-company`) | 60s/5 | effective IP + url + email digest | **A — distributed required** |
| password forgot/reset (`resetRateLimit`) | 15m/5 | effective IP + url + email digest | **A** |
| token refresh | 60s/30 | effective IP | **A** |
| password change | 15m/5 | effective IP + userId | **A** |
| Super Admin login guard | 5 fails/15m block | effective IP + email digest | **A** |
| kiosk session (station sign-in) | 60s/5 | effective IP + stationId | **A** |
| kiosk identify (PIN guess, per-code) | 10m/10 | IP + companyId + stationId + code digest | **A** |
| kiosk PIN management (staff) | 60s/10 | IP + companyId + userId | **A** |
| BGV verifier login / recovery | 15m/10 & 5 | effective IP | **A** |
| BGV verifier work | 10m/240 | verifierId / IP | **A** |
| BGV consent read/decision | 15m/80 & 10 | IP + token hash | **A** |
| BGV collection read/write/upload/submit | 15m/80/40/20/10 | IP + token hash | **A** |
| candidate offer read/decision | 15m/80 & 10 | IP + token hash | **A** |
| pre-onboarding read/upload | 15m/80 & 20 | IP + token hash | **A** |
| careers application submit | 15m/5 | IP + slug + jobCode | **A** |
| careers portal read | 60s/60 | effective IP | **B — shared preferred** |
| kiosk punch (burst) | 60s/120 | IP + stationId | **B** |
| recruitment ×5 (resume/ATS reprocess, pipeline bulk, interview/evaluation writes) | 15m/5–20 | companyId + userId + ref | **C — local acceptable** (authenticated load-shedding) |
| Super Admin ops read/mutate | 60s/60 & 20 | effective IP | **C — local** (RBAC'd ops) |
| QR challenge/redeem | none exists | — | **D — no change** (atomic single-use + hash-only already; supplementary limiter deferred) |
| health probes | limiter-free by design | — | untouched (LB polling never throttled) |

## DISTRIBUTED ARCHITECTURE

- **Store (the ONE):** `utils/rateLimitStore.js` —
  `createRateLimitStore({ sharedName, windowMs, io? })` →
  `hit(identity, maximum) → { limited, count, remaining, resetAt, tier }`,
  `peek`, `clear`. Default backend is the repository's own ioredis
  client (`getRedisClient()`); tests inject an in-memory IO. No new
  packages, no `redis` client, no second Redis architecture.
- **Window/atomicity:** fixed window via one atomic `INCR` (never
  GET-then-SET). `EXPIRE NX` on the window's first hit (Redis ≥ 7);
  pre-Redis-7 servers fall back to plain `EXPIRE` on `count === 1`.
  TTL = window → no permanent key accumulation. Existing
  thresholds/windows are byte-preserved (§16: storage change only).
- **Namespace:** `crewly:<env>:rl:<family>:<identity>` via
  `getQueuePrefix()` — isolated from caches/queues/heartbeats/other
  envs. Exact keys only; **no KEYS/SCAN/FLUSH** anywhere (test-pinned).
- **Effective IP:** every key dimension is 32.3's trust-aware `req.ip`
  — no limiter parses `X-Forwarded-For` (test-pinned); under `direct`
  mode a client cannot choose its bucket by injecting headers.
- **Tenant scoping:** pre-auth routes key only server-known dimensions
  (effective IP, hashed secure token, stationId, slug); authenticated
  keys keep `req.companyId`/`req.user._id`. `req.companyId` remains the
  only tenant authority; frontend-supplied ids are never trusted into
  keys. Cross-tenant isolation is test-pinned.
- **Secret/PII keying (§12/§13):** secure tokens were ALREADY hashed in
  keys (`hashToken`, sha256) — unchanged. NEW: emails (login/reset/
  Super Admin guard) and kiosk employee codes are digested
  (`sha256`, 16-hex slice) so no raw PII enters Redis or logs. Honest
  caveat: hashing low-entropy data is not encryption — this prevents
  raw exposure in operational keys, not guessing.

## REDIS FAILURE POLICY (explicit, per §18)

| State | Behavior |
| --- | --- |
| `REDIS_ENABLED` false (strict parser, §20) | quiet **local buckets** — documented deployment shape, identical to pre-32.4; no warnings, no circuit |
| Redis down / erroring / op > 250 ms | **bounded local fallback** + 30 s process-local circuit; ONE warn per open naming only the family (no keys, no identities); requests NEVER fail |
| circuit cooldown elapsed | shared tier resumes automatically |

Policy choice: degraded-local for every shared family (never
fail-closed — a limiter outage must not take down platform login;
never silently weaker — the fallback still enforces the same
contract per process, and docs state plainly that with Redis down
AND multiple instances, protection is per-process, i.e. weaker than
the shared budget).

## RESPONSE SEMANTICS

429 + frozen body (`statusCode, success:false, code:'RATE_LIMITED'`,
route message) + existing `X-RateLimit-Limit/-Remaining/-Reset`
headers — byte-identical in both tiers. **Additive:** shared-tier 429s
carry exact `Retry-After` (TTL-derived seconds). No Redis state, key
material, topology, or account existence is ever exposed; sensitive
routes keep their generic messages (enumeration safety untouched).
Super Admin guard 429 body unchanged.

## MULTI-INSTANCE BEHAVIOR (the 32.4 acceptance property)

API #1 and API #2 enforce ONE counter per family: a client alternating
instances cannot multiply its allowance. Proven by tests against TWO
independent middleware/store instances on one backend, including a
10-concurrent race vs max 5 → exactly 5 pass (atomic INCR — no race
overage). Not a claim against botnet-scale distributed abuse (§64).

## HEALTH ENDPOINTS

Probes (32.2) are mounted before limiter surfaces and remain
limiter-free — infrastructure polling can never be throttled.

## NOT AUTHENTICATION

Distributed rate limiting is abuse protection only. It does not
authenticate, authorize, or replace session validation, RBAC, kiosk
station validation, QR single-use claims, or any Mongo-authoritative
security state.

## TESTS

`npm run test:rate-limit` — 13 hermetic tests: shared budget across two
instances, 429 semantics + Retry-After, concurrency race, namespace/
family isolation, secret-safety (runtime key inspection), identity
scoping, disabled-vs-down, circuit + recovery, window expiry/reset,
Super Admin shared block/clear + key digest, wiring pins (A/B shared,
C local), safety pins (no KEYS/SCAN/FLUSH, bounded fallback constants,
frozen contracts, 32.3 identity law).

## IMPLEMENTED / TESTED / DEFERRED

- IMPLEMENTED + TESTED: store, dual-tier middleware, Super Admin
  factory, 19 route wirings + 4 exported + guard, degradation ladder,
  PII digesting, hermetic suite.
- DEFERRED: QR supplementary limiter (D-class finding → candidate for
  a later security unit); sliding-window/token-bucket upgrade (fixed
  window is the preserved semantics); Redis-side atomic Lua script
  (INCR+EXPIRE NX is already atomic enough — single INCR decides);
  per-account global quotas; CAPTCHA/WAF/edge defenses (§37 — never in
  32.4); detailed observability (→ 32.12).

# 32.3 — Load Balancer & Reverse Proxy Readiness

Status: **32.3 implemented** (awaiting localhost acceptance). No load
balancer is deployed — 32.3 makes the application behave CORRECTLY and
SECURELY behind one, vendor-neutral.

## TRUST MODEL (the one authoritative boundary)

`Backend/src/config/proxyTrust.js` — Express `trust proxy` is configured
ONLY here, driven by `TRUST_PROXY_MODE` (strict parsing; bad config fails
startup):

| Mode | trust value | Use case |
| --- | --- | --- |
| `direct` (DEFAULT) | `false` | direct/localhost exposure. `req.ip` = socket address; **X-Forwarded-For / X-Forwarded-Proto from clients are INERT** — identity spoofing is impossible |
| `loopback` | `'loopback'` | local proxy simulation (nginx on 127.0.0.1, tunnels) |
| `hop` | clamped int `TRUST_PROXY_HOPS` (1–10) | exactly N proxies between client and API, counting the proxy attached to the API's socket first (Render/nginx single proxy → 1; CDN+LB → 2). `req.ip` = Nth XFF entry from the right (proxies append the address they received from) |
| `cidr` | validated `TRUST_PROXY_CIDRS` (IPv4/IPv6/CIDR, or named `loopback\|linklocal\|uniquelocal`) | SAFEST production declaration — trust only the LB/CDN network boundary; safe for multi-hop chains |

Historical note: the previous hard-coded `trust proxy 1` made a direct
client's forged `X-Forwarded-For` become `req.ip` — the v-fix removes that
by default; deployments behind proxies MUST declare the boundary
(deployment configuration is 32.15; `.env.example` carries commented
operator recipes).

## CLIENT IP DESIGN

`getRequestIp()` now returns `req.ip` (socket fallback only) — hand-parsed
X-Forwarded-For is removed, so every consumer (login/reset SecurityEvents,
AuditLog, SecuritySession records, ALL rate limiters, kiosk/BGV/Super-Admin
limiters) derives identity through the ONE trust boundary. No other module
reads forwarded headers (pinned by test).

## PROTOCOL / HTTPS TERMINATION

No production code reads `req.protocol`/`req.secure` today. Express
semantics apply when they do: forwarded proto is honored ONLY from within
the declared trusted boundary (TEST E/F prove forged-proto is inert in
direct mode). Refresh-cookie flags are NODE_ENV-based, not req.secure-based
(reviewed; revisit in 32.17).

## CORS / ORIGIN

Unchanged and pinned by tests: allowlist from `CLIENT_URL`
(+ dev-only e2b preview regex), `credentials: true`, narrow
methods/headers; disallowed origins get NO permissive CORS headers and
403 preflight. Origin ≠ client IP — never derived from each other.

## HEALTH BEHIND A PROXY

`/api/health/live` and `/api/health/ready` are public, cheap, unthrottled
— a load balancer polling frequently can never lock itself out. Response
bodies unchanged (secret-free).

## NO STICKY SESSIONS

Normal JWT traffic remains stateless (32.1 proof + 32.3 integration tests
run the real app fresh per request). Realtime (32.11) may decide
differently — nothing here presumes it.

## DEPLOYMENT ASSUMPTION (for 32.15)

When a trust boundary is declared, the API must NOT be directly reachable
from the internet bypassing the trusted proxy path; application config
cannot compensate for network-topology mistakes.

## 32.3 — IMPLEMENTED / TESTED / DEFERRED

- **Implemented:** proxyTrust config (4 modes, fail-fast), app.js wiring,
  trust-aware `getRequestIp`, `.env.example` names, full test matrix.
- **Tested:** `npm run test:proxy-readiness` (16 hermetic tests — matrix
  A–K: direct/forged-IP/forged-proto, loopback/hop/cidr trust, multi-hop,
  getRequestIp boundary, real-app health+CORS, config determinism, wiring
  pins).
- **Deferred:** distributed rate-limit *storage* → **32.4**; Mongo perf →
  **32.5**; cache → **32.6**; worker scale → **32.7**; realtime proxy
  behavior (upgrades, sticky decisions) → **32.11**; observability →
  **32.12**; deployment/network topology + proxy timeouts → **32.15**;
  header/cookie hardening (HSTS etc.) → **32.17**.

---

# 32.2 — Health, Readiness & Graceful Lifecycle


Status: **32.2 implemented** (awaiting localhost acceptance). This section
extends the 32.1 architecture record. IMPLEMENTED / TESTED / DEFERRED are
labeled explicitly. No load balancer integration exists yet — 32.2 only
provides the signals infrastructure will consume.

## LIVENESS — `GET /api/health/live`

"Is this process alive?" Always **200** `{"success":true,"status":"ok"}`
while the process can respond. **Never checks dependencies** — Mongo,
Redis, SMTP or storage outages must not cause orchestrator restart storms.
No I/O (safe to poll frequently).

## READINESS — `GET /api/health/ready`

"Should THIS instance receive new traffic?" **200** `{"status":"ready",
"dependencies":{"database":"up","cache":"up|degraded|disabled"}}` only when
the process lifecycle is `READY` **and** MongoDB is connected
(`readyState === 1`, cached state — no query). **503** `{"status":
"unready","reason":...}` during `STARTING`, Mongo outage, or `DRAINING`.
Redis **never** flips readiness (fail-open/degraded architecture); it is
reported as the `cache` label only. SMTP/storage are never readiness inputs.

### Dependency policy (authoritative)

| Dependency | Liveness | API readiness | Rationale |
| --- | --- | --- | --- |
| MongoDB | never | **required** | sole authoritative business state |
| Redis | never | never (label only: `up`/`down`/`disabled`) | optimization/coordination; degraded mode is by design |
| BullMQ producers | never | never | outbox/reconciliation recovery exists |
| SMTP / object storage | never | never | subsystem-scoped failures only |

## LEGACY `GET /api/health` (Phase 28 contract preserved exactly)

Identical to Phase 28: **always HTTP 200**, the body `status` field
(`ok|degraded|unhealthy`) is the signal — pinned by the Phase 28
`redisFoundation` suite. Infrastructure routing decisions MUST use
`/api/health/ready` (proper 503 semantics); the legacy probe is for
existing dashboards/scripts and humans only.

## WORKER HEALTH (semantics; no new endpoints)

The worker's health signal is the existing 28.8 ops heartbeat:
`ONLINE` (beat ≤ TTL 60 s), `SHUTTING_DOWN` (graceful close window, 10 s
TTL), `OFFLINE` (key expired — crash or clean exit). Classification is
pinned by hermetic tests (`classifyWorkerState`). Workers require Redis +
Mongo at startup (fail-fast) — API readiness semantics deliberately do NOT
apply to workers. Worker horizontal scaling remains 32.7.

## PROCESS LIFECYCLE (API)

```
STARTING ──listen──▶ READY ──SIGTERM/SIGINT──▶ DRAINING ──resources closed──▶ STOPPED
                     ▲ markReady()              ▲ beginDrain():                exit 0
                     (readiness 200)            readiness 503 + drain gate     (timeout → exit 1)
```

- Process-local by design (32.1 law): API #1 draining never affects API #2.
- Graceful sequence (`utils/gracefulShutdown.js`, idempotent, bounded):
  drain flag → `server.close()` → `closeIdleConnections()` (guarded,
  Node ≥ 18.2) → BullMQ producers → Redis → Mongo → `markStopped` → exit 0.
  Hard-stop timer forces `exit(1)` at `GRACEFUL_SHUTDOWN_TIMEOUT_MS`
  (name-only env; default 10000 ms; clamped 1000–60000; commented optional
  in `.env.example`). Repeated signals are logged and ignored; the bound
  governs. `unhandledRejection` uses the same bounded path (exit 1).
- Drain gate (app-level): while draining, every non-health route answers
  **503 `SHUTTING_DOWN`** — clean retry-elsewhere for keep-alive races.

## STATUS CODE SEMANTICS

Liveness healthy = 200. Readiness ready = 200. Readiness not-ready = 503.
Legacy combined probe: always 200 (Phase 28 contract). Load balancers/
orchestrators poll `/api/health/ready` for routing and `/api/health/live`
for restart decisions (standard HTTP semantics on the routing probe).

## ROLLING DEPLOYMENT LIFECYCLE (conceptual; no LB built yet)

start new instance → it turns READY → infrastructure routes to it →
SIGTERM old instance → old instance turns unready (503) → drains bounded →
exits → repeat. Worker replacement is identical via SIGTERM +
SHUTTING_DOWN heartbeat → OFFLINE.

## PROBES: security & performance rules

Public, unauthenticated, mounted before the audit trail (no per-probe
writes), no business queries, no Redis I/O (cached state), read-only.
Bodies contain status labels and safe reason words only — never URIs,
hosts, database names, worker ids, stack traces or credentials.

## 32.2 — IMPLEMENTED / TESTED / DEFERRED

- **Implemented:** lifecycle FSM, `/live`, `/ready`, drain gate, extracted bounded shutdown (+ timeout env),
  `markReady` on listen, unhandledRejection cleanup, worker heartbeat
  test pins. Tests: `npm run test:health-lifecycle` (hermetic).
- **Deferred:** reverse-proxy/trust-proxy hardening → **32.3**;
  distributed rate limiting → **32.4**; cache hardening → **32.6**;
  multi-worker scaling program → **32.7**; observability/correlation →
  **32.12**; failure injection (Mongo/Redis outage drills) → **32.14**;
  deployment architecture/rollout → **32.15**.

---

# 32.1 — Production Architecture & Multi-Instance Readiness

Status: **32.1 implemented** (awaiting localhost acceptance). This document is
the authoritative Phase 32 architecture record required by the 32.1 build
brief. Repository truth wins over this document at all times — numbers and
references below were verified against the checkout that introduced them.

Hosting provider is **NOT selected**. Everything in Phase 32 is
vendor-neutral: no AWS/Azure/GCP/Render/Railway/Fly/Cloudflare/Kubernetes/
nginx/HAProxy/Traefik decision has been made, and no provider-specific
configuration exists in the repository.

---

## 1. CURRENT API TOPOLOGY (verified)

- **Express app** (`Backend/src/app.js`): pure application — helmet, CORS
  allowlist, 10 kB JSON body limits, `trust proxy 1`, request logging with
  candidate-token redaction. It **never binds a port**; `app.listen` lives
  only in the server entry point. This makes the app independently
  instantiable (tests, additional instances).
- **Server entry** (`Backend/src/server.js`): deterministic startup —
  `loadEnv → connectDB → ensurePermissions (RBAC catalogue, v36) →
  initializeRedis → ensureDefaultPlans → career/candidate/pipeline ensures →
  app.listen → startSubscriptionLifecycle → bounded SIGTERM shutdown`.
  Startup aborts on failure; the API never serves a half-bootstrapped state.
- **Independent worker** (`Backend/src/workers/index.js`): requires MongoDB
  AND Redis (fails fast otherwise), runs per-queue BullMQ workers via a
  shared job registry, executes idempotent Mongo-authoritative startup
  reconciles (resume/ATS/scheduled/documents/BGV), publishes an ops
  heartbeat, sweeps its own local temp files hourly, and drains bounded on
  SIGTERM. The API never addresses a specific worker — all work flows
  through shared queues.

## 2. CURRENT WORKER TOPOLOGY (verified)

One worker process per machine today; all job state lives in shared Redis
(BullMQ) + MongoDB. Worker-local state is: its own BullMQ connection
instances (intentionally process-owned), its heartbeat identity
(`crewly:ops:worker:<env>:worker-<uuid>`), and its local temp-file sweep.
No business truth lives in the worker process. Startup reconciles are
idempotent (`updateMany` recovery + lease/claim semantics), so overlapping
worker startups are safe; deep multi-worker scaling verification is **32.7**.

## 3. SHARED DEPENDENCIES

| Dependency | Role | Truth? |
| --- | --- | --- |
| MongoDB | All business state (companies, users, roles, attendance events, payroll, subscriptions, SecuritySessions, AdminSessions, payslip/payment file bytes) | **YES — sole authority** |
| Redis (ioredis) | BullMQ queues, caches with generation invalidation, worker heartbeat/ops signals | No — optimization/coordination only |
| Object storage (Cloudinary) | Private durable files (resumes, offers, pre-onboarding, BGV evidence, branding) | Reference data; keys in Mongo |

## 4. STATELESS JWT ASSESSMENT (central 32.1 question)

**Customer authentication is stateless-JWT with shared Mongo session
validation.** `protect` verifies the Bearer token, then validates the
session id/user/tokenVersion against `SecuritySession` in MongoDB on every
request. No API process keeps sessions, tokens, or business state in
memory (`authMiddleware.js` and `tokenService.js` contain no module-level
session maps — pinned by test). Therefore:

- Request A → API #1, Request B → API #2 works without sticky sessions.
- Any instance can die without losing authoritative state.
- Refresh/logout/lockout state is shared Mongo state, visible to all
  instances immediately.

Kiosk devices use stateless device JWTs + Mongo station validation — same
conclusion. Platform/Super Admin uses Mongo `AdminSession` (shared) —
also multi-instance safe; its process-local login-attempt guard is a
rate-limiting concern only (→ 32.4), not an authentication-truth concern.

**Verified multi-instance validation:** see the localhost procedure — two
API instances on :5000/:5001 sharing one Mongo/Redis, one token used
interchangeably.

## 5. PROCESS-LOCAL STATE INVENTORY + CLASSIFICATION

Classification: **A** = safe process-local · **B** = multi-instance unsafe ·
**C** = intentionally process-owned · **D** = defer to a later 32.x unit.

| # | State | File(s) | Class | Notes |
| --- | --- | --- | --- | --- |
| 1 | Subscription lifecycle scheduler (10 s + daily, in every API instance) | `utils/subscriptionLifecycle.js` | was B → **fixed in 32.1** | Status transitions are now atomic CAS claims (`findOneAndUpdate` + state guards) — concurrent instances converge to exactly one winner per transition; no duplicate history/notifications/SystemEvents. Reminders were already `eventKey`-deduped (unique sparse index). Hermetic tests: `test/multiInstanceBaseline.test.js`. |
| 2 | Startup ensures (permissions v36, plans, career/candidate/pipeline identifiers) | `server.js` + utils | A | Idempotent upserts; concurrent instance starts converge (duplicate-key tolerant). |
| 3 | Permission caches (resolved grants 5 min; permission metadata 15 s) | `utils/permissionService.js` | D→32.6 | Exact invalidation is same-process; cross-instance staleness is TTL-bounded; Mongo stays truth. |
| 4 | Subscription gate cache (5–60 s TTL) | `utils/subscriptionGateCache.js` | D→32.6 | Same-process exact invalidation via Subscription post-save hooks; TTL-bounded cross-instance staleness. |
| 5 | Rate-limit buckets (`Map`) — login/reset/refresh/password-change, kiosk, public careers/offers | `middlewares/securityRateLimit.js` | D→32.4 | Process-local: effective limits multiply by instance count; store is unbounded. Includes `superAdminAuth.js` login-attempt map. |
| 6 | Cache single-flight (`inFlight` Map) + per-process cache stats | `services/redisCacheService.js` | A | Documented multi-instance limitation; duplicate loads are safe (Mongo-backed loaders); correctness never depends on it. |
| 7 | Queue producer registry, per-process BullMQ connections | `queues/queueFactory.js`, `config/redis.js` | C | Shared Redis holds the actual queue state. |
| 8 | Worker heartbeat identity, local temp-file sweep, worker startup reconciles | `workers/index.js`, `workers/workerHeartbeat.js` | C | Process-owned by design; reconciles are idempotent. |
| 9 | Request-scoped Maps in controllers/services | various | A | Per-request computation, no cross-request meaning. |
| 10 | `global.__crewlyPhase20Lifecycle` double-start guard | `utils/subscriptionLifecycle.js` | C | Correctness never relies on it across instances — the lifecycle is safe to run in every instance (CAS). |

**Process-memory-is-never-business-truth check (32.1 law §17):** tenant
identity, permissions, payroll results, attendance events, BGV/recruitment
decisions, payment state, file ownership and security-token validity are all
Mongo-backed. The only in-memory authorization-adjacent caches (3, 4) are
TTL-bounded read-through caches, never the authority. No sticky sessions are
required or permitted to mask anything.

## 6. FILESYSTEM INVENTORY SUMMARY (full program → 32.8)

| Data | Primary | Fallback | Multi-instance note |
| --- | --- | --- | --- |
| Resumes, offers, pre-onboarding docs, BGV evidence, company branding | Cloudinary (private/authenticated) | per-machine private local dir (0700/0600) | Local fallback is instance-local — production multi-instance requires the shared provider (or a future shared object store). Development fallback remains valid. |
| Payslip PDFs | Stored in MongoDB with the record (`select:false`) | — | Already shared ✔ |
| Payroll payment files (CSV/XLSX + checksum) | Stored in MongoDB (`content`/`binary`) | — | Already shared ✔ |
| Worker temp processing files | local disk, hourly sweep | — | Per-process by design ✔ |
| Frontend static assets | Vite build output, served externally | — | CDN/edge design → 32.16 |

## 7. SCHEDULER / STARTUP / RECONCILIATION INVENTORY

| Mechanism | Process | Concurrency safety |
| --- | --- | --- |
| `startSubscriptionLifecycle` (10 s + daily) | every API instance | **Atomic CAS transitions (fixed in 32.1)**; reminders eventKey-deduped |
| `ensurePermissions` / plans / identifiers ensures | every API instance at boot | Idempotent upserts, duplicate-key tolerant |
| Worker startup reconciles (resume/ATS/scheduled/documents/BGV) | every worker at boot | Idempotent `updateMany` recovery + lease claims; re-verification under many workers → 32.7 |
| Ops heartbeat (15 s beat, 60 s TTL) | worker | Process-owned identity; safe |
| Subscription/queue TTL reaping (Mongo TTL indexes) | MongoDB | Server-side, safe |

## 8. RATE LIMITER ASSESSMENT (record for 32.4)

Existing limits (all process-local bucket maps today): login 5/min
(ip+url+email), password reset 5/15 min, refresh 30/min (ip),
password-change 5/15 min (ip+user), kiosk session/punch/identify,
public careers/applications, candidate offer routes, Super Admin login
guard. 32.4 must decide per-limit: shared Redis coordination, key scope,
tenant behavior, degraded/fail-open behavior, store eviction, and prevention
of account-existence oracles. No work done in 32.1 beyond this inventory.

## 9. CACHE ASSESSMENT (record for 32.6)

28.7 `getOrSetCache`: Redis read-through, tenant-scoped keys, generation
INCR invalidation, short TTLs, fail-open to Mongo, **in-process
single-flight** (concurrent same-key misses share one loader per process;
different instances may load concurrently — safe, Mongo-backed). Cross-instance
invalidation gaps for the TTL caches (items 3–4 above) are bounded by TTL
and must be hardened in 32.6 (e.g., shared generation counters for these
namespaces), only if measured to matter.

## 10. WORKER SCALING FINDINGS (record for 32.7)

API and worker are separate deployables; queues live in shared Redis;
handlers re-fetch and revalidate Mongo state; delivery is at-least-once
with idempotent outcomes (email eventKey dedupe, payroll one-attempt runs +
immutable snapshots, atomic claims). Multi-worker consumption is expected
to be safe; 32.7 must verify concurrency limits, backpressure, and
duplicate-execution safety per job family with tests.

## 11. FINDINGS DEFERRED TO LATER 32.x UNITS

- **32.2** Health/readiness endpoints, drain semantics (current shutdowns
  are already bounded and graceful; readiness differentiation is missing).
- **32.3** `trust proxy` value review, forwarded-header hardening, req.ip
  correctness behind real proxies/LBs.
- **32.4** Distributed rate limiting (item 5 above).
- **32.5** Mongo index/query performance campaign (evidence-first).
- **32.6** Cross-instance cache invalidation hardening (items 3–4),
  distributed stampede protection if justified.
- **32.7** Multi-worker scaling verification + concurrency/backpressure.
- **32.8** Object-storage hardening/migration decisions (item: local
  fallback boundaries).
- **32.11** Realtime connection state, pub/sub fan-out design (foundation
  only — no Chat, no employee Presence, no AI).
- **32.12** Request/correlation IDs, structured diagnostics (request logger
  has token redaction but no correlation id yet).
- **32.13/32.14** Load and failure campaigns.
- **32.15/32.16/32.17/32.18** Environments, CDN/edge, security hardening,
  close-out runbooks.

## 12. TARGET PRODUCTION TOPOLOGY (conceptual, vendor-neutral)

```
                 INTERNET → DNS/CDN/EDGE → LOAD BALANCER
                 /            |            \
             API #1        API #2 …      API #N      (stateless JWT, no affinity)
                 \            |            /
                  +-----+-----+-----+-----+
                        |           |
                    MongoDB       Redis (+ BullMQ)         Object storage
                        |           |
                 Worker #1 … Worker #N
```

Realtime (future, 32.11+, foundation only): separate connection gateway
instances + shared Redis pub/sub; sticky-session requirements to be decided
there — nothing in 32.x presumes them.

## 13. VERIFICATION (this unit)

- `npm run test:multi-instance` — 11/11 (concurrency convergence,
  idempotency, eventKey dedupe, entrypoint separation, no-memory-session
  pins, CAS/double-start-guard pins).
- Full ladder + build results are reported in the 32.1 handoff message.
