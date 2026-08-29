# Phase 28.7 — Redis Analytics + Safe Multi-Tenant Caching

MongoDB remains the single source of truth. Redis is a **disposable,
fail-open, tenant-scoped read cache** for the one most expensive
read-heavy endpoint: the Recruitment Analytics Overview
(`GET /api/recruitment/analytics/overview`, ~17 Mongo aggregations
per request).

- Redis down / disabled / slow → **Mongo, unchanged, no 500**.
- Cache write failure → Mongo result still returned.
- Invalidation → **generation bump** per tenant (one INCR; old keys
  die by their own TTL). No per-key deletion, no `KEYS`, no `SCAN`,
  **no `FLUSHALL`/`FLUSHDB`, ever** (Redis also holds the BullMQ
  queues).
- Namespace `crewly:cache:...` is structurally disjoint from the
  BullMQ prefix (`crewly:<env>` / `BULLMQ_PREFIX`); this code only
  ever GET/SET/DEL/INCR exact keys it built itself.

## Architecture

```
HR → GET /analytics/overview
  → auth → requirePermission('RECRUITMENT_ANALYTICS_READ') → validator
  → recruitmentAnalyticsController (thin, 3 markers intact)
  → getRecruitmentAnalyticsOverview({companyId: req.companyId, query})
       → parseDateRange + resolveScopedFilters  (fresh, cheap, always runs)
       → build tenant-scoped deterministic key
       → getOrSetCache
            ├ HIT  → parse envelope (v:1) → return
            ├ MISS → calculateRecruitmentAnalyticsOverview (unchanged 27.14
            │        aggregations) → size guard → SET with TTL → return
            └ BYPASS (no key / TTL disabled / Redis down) → direct Mongo
```

- **Authorization happens before any cache access** (route middleware
  order is unchanged; the cache lives inside the service).
- The response is company-wide for every holder of the permission
  (no per-user/team scoping exists), so `(companyId + normalized
  filters + generation)` is a safe cache identity.
- `recruitmentAnalyticsService` keeps the aggregations; the cache
  only wraps them. No pipeline was copied.

## Cache key format

```
value:      crewly:cache:company:<companyId>:recruitment:analytics:v1:g<generation>:<filterHash16>
generation: crewly:cache:company:<companyId>:recruitment:analytics:generation   (TTL 24h, refreshed on bump)
```

- `companyId` comes from `req.companyId` (auth middleware) — never
  from query/body. Invalid companyId → no key → bypass.
- `v1` = cache schema version (key + envelope); bump to `v2` if the
  response shape changes.
- `g<generation>` = tenant generation (see below).
- `filterHash16` = first 16 hex of SHA-256 over the **normalized**
  filter object (sorted keys).

### Filter normalization (equivalent requests share ONE entry)

- falsy/undefined dropped; `range`/`source` uppercased;
  `jobId`/`departmentId`/`recruiterId`/`hiringManagerId` lowercased
  (ObjectId-canon); `from`/`to` normalized to the parsed UTC ISO
  instant (so `2026-08-01` ≡ `2026-08-01T00:00:00.000Z`).
- explicit `from`/`to` present → the preset is excluded from the key
  (it is ignored by the query engine too).
- unparseable date → not cacheable → bypass (service validation still
  runs and can 400 as before).

## Invalidation (generation-based, §27)

`bumpRecruitmentAnalyticsGeneration(companyId)` = `INCR` the tenant
generation key + refresh its 24h TTL. **Fire-and-forget, never
throws**, called AFTER the successful Mongo commit at the tail of each
analytics-relevant mutation:

| Service / function | Event |
|---|---|
| `candidateApplicationService.submitCandidateApplication` | application created |
| `candidatePipelineService.transitionCandidateStage` / `bulkCandidateAction` | stage change(s) |
| `candidateDecisionService.startCandidateFinalReview` / `recordCandidateFinalDecision` | review + final decision |
| `interviewService.schedule/reschedule/cancel/updateStatus Interview` | interview lifecycle |
| `interviewFeedbackService.saveOwnInterviewFeedback` | feedback (interview metrics) |
| `offerService.updateOffer` / `expireOfferIfDue` | offer status (the latter also covers the 28.5 expiry **worker**) |
| `publicOfferService.decision` (accept/reject) | candidate offer decision |
| `preOnboardingService.start / upload / verify / reject / markReady` | pre-onboarding lifecycle |
| `candidateConversionService.convertCandidateToEmployee` | joined |
| `requisitionService.createJobFromRequisition` + legacy `recruitmentController.createJob/updateJob` | job created/edited (open-jobs KPI) |
| `atsMatchingService.processATSMatch` | ATS result (covers the 28.4 ATS **worker** + manual reprocess) |

**Not hooked (intentional):** BGV, document, and resume workers —
the cached response contains no BGV/resume/document metrics, so
invalidating would be needless (§57).

**Edge case (§62, carried to 28.9):** if Redis is down during a
mutation, the INCR is skipped; when Redis returns, a pre-existing
entry can theoretically serve up to one TTL (60s) of stale data.
Bounded by the short TTL; no distributed event invalidation in 28.7.

## TTL + config

- `RECRUITMENT_ANALYTICS_CACHE_TTL_SECONDS` (new, only new env var):
  default **60**, clamped 10–3600, `0` disables caching entirely.
  Range presets are `now`-anchored, so a short TTL is the freshness
  model — no Mongo cache-version fields were added (§63).
- Cache operation timeout `REDIS_CACHE_OP_TIMEOUT_MS` (optional,
  default 500ms, clamped 100–2000): a slow cache never delays the
  Mongo read (§74). When 28.1 reports the connection
  down/disabled, Redis is bypassed entirely (no hammering a dead
  Redis; retries resume when it recovers — §75).
- Max value size 256 KB: oversized responses skip the cache write and
  still return the Mongo result (§42). No compression dependency.

## Hit/miss semantics (§71)

HIT and MISS return **identical** HTTP status + response shape: the
service's shaped plain object is cached as an envelope
`{v: 1, at, payload}` and parsed back; `res.json()` serialization is
the same either way (Dates → ISO strings on both paths). Malformed or
wrong-version entries are deleted by exact key and treated as a MISS.

**Stampede (§24/§61):** in-process single-flight (`Map<key, Promise>`,
cleared in `finally`, error-safe) — one Mongo computation per
process per cold key. Multi-instance stampede is NOT solved in 28.7
(documented limitation for 28.9); the 60s TTL bounds its window. No
Redis locks introduced.

**Debugging (§34/§80):** structured log lines only
(`[Cache] recruitment hit/miss/stored durationMs=...`) — no response
header, no keys or tenant ids in log labels, no cached content logged.
A dev-only `X-Crewly-Cache` header was deliberately NOT added (keep
the response surface identical).

## Security exclusions (§5/§48)

Not cached / not migrated / not touched: auth tokens, sessions,
refresh tokens, resumes, documents, BGV evidence, bank/tax data,
offer secure tokens, password reset tokens, interview feedback text,
offer compensation, report builder, payroll, attendance, public
career, permission resolution, company reference data, HR_HEAD roles.
The bounded "attention" rows inside the analytics response carry
candidate **names + codes only** (≤50 entries, no emails/IDs/
compensation) — already rendered to every authorized HR user; the
cache adds no new exposure surface (same trust boundary, internal
Redis). No `Cache-Control: public` anywhere; the endpoint keeps the
existing API caching policy.

## Tests

- **`test/analyticsCache.test.js` (16, hermetic, no live Redis)**:
  key building + tenant separation, unsafe-segment rejection,
  filter-hash equivalence (property order, omitted undefineds,
  case canonicalization, equivalent date strings, preset exclusion),
  cross-department non-collision, TTL parse/clamp/opt-out,
  HIT/MISS/BYPASS with a fake client (DI), corrupt + wrong-version
  recovery (exact-key delete), single-flight coalescing + error
  cleanup, tenant-A-never-reads-tenant-B, generation key format +
  fail-open bump, Redis-down fallback with the real module, op-timeout
  clamp, envelope validation.
- **Full backend sweep: 24 suites / 290 tests green** (the 27.14
  analytics test's "no Redis in service" guard was updated to its
  real intent: no direct BullMQ/ioredis usage in the service; the
  centralized cache abstraction is the only allowed dependency).
- `node --check` on all changed files; `npm audit` 0 (no `--force`);
  diff secrets-scan clean; `.env` untouched; **zero frontend changes**
  (dashboard looks identical, responds faster).

## Manual live ladder (developer's machine — Windows PowerShell)

Terminal 1: `npm run dev` · Terminal 2: `npm run worker:dev`

1. **MISS → HIT (§52):** open the Recruitment Dashboard (or call the
   endpoint twice). Console shows `recruitment miss — loading from
   source` then `recruitment stored`; the second call (same filters)
   shows `recruitment hit` and is faster. Compare both JSON
   responses — identical.
2. **Tenant separation (§50):** log in as two companies with identical
   filters (e.g. both default 30-day view). Each sees only its own
   numbers; the `crewly:cache:company:<their-id>:...` keys differ.
3. **Filter separation (§51):** filter Development, then HR —
   different data, different cache entries; same filter again → HIT.
4. **TTL (§53):** `RECRUITMENT_ANALYTICS_CACHE_TTL_SECONDS=10` (the
   clamp floor) → miss, hit, wait 11s → miss again. Restore 60.
5. **Invalidation (§54):** warm the cache → create/advance a
   candidate (any hooked mutation) → next request is a MISS that
   reflects the change → next request HITs again.
6. **Worker invalidation (§55/§56):** warm the cache → let the ATS
   worker finish a pending candidate (or wait for a scheduled offer
   expiry) → next request reflects the new ATS/offer counts.
7. **Redis down (§58):** stop the Redis service safely → analytics
   still returns Mongo data (console: safe bypass/miss lines, no 500)
   → mutations still succeed (INCR skipped safely) → restore Redis →
   caching resumes.
8. **Opt-out:** `RECRUITMENT_ANALYTICS_CACHE_TTL_SECONDS=0` → every
   request reads Mongo (BYPASS path).

## 28.8 handoff (Queue Operations + Failure Management)

- **Cache client/service:** `services/redisCacheService.js`
  (buildTenantCacheKey, get/set/delete/getRaw/incrementWithTtl,
  getOrSetCache with single-flight + `io` DI seam, envelope, size
  guard, bounded op timeout, fail-open everywhere).
- **Key structure / version / TTL:**
  `crewly:cache:company:<id>:<ns>:v1:<segments>`, generation keys
  `...:generation` (24h), analytics TTL env (default 60s, 0 disables).
- **Generation invalidation:** `services/analyticsCacheInvalidation.js`
  — 14 mutation entry points + 2 worker paths hooked (see table).
- **Redis-down fallback:** health-gated bypass + 500ms op timeout +
  exact-key deletes only.
- **Single-flight:** in-process only; multi-instance stampede remains
  a documented limitation.
- **Secondary caches:** public career, permission, company reference —
  all DEFERRED (permission explicitly, §39). Public career was
  inspected and is a good 28.8/28.9 candidate (`resolveCareerTenant`
  already provides trusted slug→companyId).
- **Known limitations:** multi-instance stampede; Redis-down-mutation
  staleness ≤ 1 TTL; size-guard skip is log-only; no compression.
- **Ops watch for 28.8:** cache key counts/size (all TTL-bounded,
  small), `[Cache]` log lines as the observability baseline, and the
  production note — queue Redis should not evict (BullMQ) while cache
  entries are disposable; a separate `REDIS_CACHE_URL` can be added
  later without business-code changes (the abstraction already
  isolates the client).
