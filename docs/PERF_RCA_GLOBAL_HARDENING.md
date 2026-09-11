# GLOBAL PERFORMANCE RCA & HARDENING

Cross-application latency RCA on `arena/01a09039-hrms-crewly` (branched from
`main` @ `4f8331d`, Phase 30 close). No load balancer, no blind caching, no
seeding, no rewrites. Security posture unchanged — every fix preserves
`req.companyId` tenant authority, RBAC, scopes, masking, and audit.

Observed locally (Chrome DevTools, Atlas-backed): unread-count ~300–900ms,
salary structures ~1.6s, previews ~1.5s, employee payroll profile ~4.4s
(spike ~8.8s). Redis stopped/disabled did NOT remove the latency.

## 1. Common paths (measured by code inspection)

Frontend sidebar navigation:
`AppRoutes` → `RequireAuth` (Redux-only, no fetch) → `AppLayout`
(mount-once: `fetchMyPermissions` ×1, bell unread-count ×1 + 30s poll,
subscription banner ×1) → page fetches. No global refetch storm; all
shared effects have correct deps + cleanup. `StrictMode` untouched.

Backend authenticated request:
`helmet → cors → body parsers → perfTiming(no-op unless enabled) →
requestSecurity(sync) → morgan → /api → auditTrail/platformUsage
(post-response, fire-and-forget) → protect → tenantContext →
[checkSubscriptionStatus] → requirePermission/requireFeature/scope →
validators → controller`.

## 2. Root causes (ranked)

### CRITICAL — sequential pre-controller Atlas round-trips × high per-query RTT

Pre-controller cost of a guarded payroll-family route (warm caches):

| Step | Queries (sequential) |
|---|---|
| `protect` | `User.findById` + `SecuritySession.findOne` (2) |
| `tenantContext` | `Company.findById` + `populate subscription` (2) |
| `checkSubscriptionStatus` | `Subscription.findOne` + `populate planRef` (2, DUPLICATE of the above) |
| `requirePermission` | `Permission.findOne` uncached (1) + `hasFeature` (in-proc cache) + grants (in-proc cache) |

≈ 7 sequential round-trips before the controller runs. `unread-count`
(`protect` + `countDocuments` = 3 indexed queries) taking 300–900ms
implies **Atlas RTT ≈ 100–300ms per round-trip** on the dev link —
the multiplier behind every multi-second endpoint. Fix = fewer
round-trips, not lower RTT.

### HIGH — `ensureCompanyRoles` cold-miss storm

On every permission-cache miss (5-min TTL, every process restart):
5× (upsert + migrate) = 10 sequential queries PLUS a final
find-all-roles + populate-permissions whose return value the hot caller
(`resolveUserPermissions`) DISCARDED. `/permissions/me` additionally
called it explicitly and then again via `getPermissionPayload` (×2).

### HIGH — dashboard self-view waterfall

5 independent queries (`Leave`, `Task`, `Meeting`, `Payroll`,
`Announcement`) awaited sequentially = 5 RTTs on the landing page.

### MEDIUM — 1.9 MB single-file frontend bundle

134 static page imports → one 1,902 KB JS chunk (421 KB gzip) + Vite
chunk-size warning. Initial-load cost, not XHR cost.

### MEDIUM — full-doc list hydration

`listUsers` hydrated up to 200 full `User` docs per page (minus
password) with 2 populates.

### LOW — missing `Notification` compounds

Only single-field `companyId`/`user` indexes; `unreadCount`,
`markAllRead`, and `myNotifications` (filter + sort) had no exact
compound.

## 3. Ruled OUT (with evidence)

- Redis: `isRedisUsable()` bypasses immediately when disabled/down; no
  timeout wait, no hammering. Matches the observed Redis-off slowness.
- Connection storms: exactly one `mongoose.connect` in the API
  (`config/db.js`), one in the worker process. No per-request connects.
- Notification spam: 30s poll, mount-once, cleanup. Prior spam fix holds.
- Frontend bootstrap refetch: auth/permission/subscription each fetch
  once; route guards are Redux-only.
- External calls in GET paths: audited dashboard/user/system/attendance
  GET controllers — no synchronous SMTP/Cloudinary/Razorpay waits.
- HTTP 304s: Express default weak-ETag conditional GETs — normal,
  not an error. Left alone.

## 4. Fixes made (fix-forward only)

| # | Change | Effect |
|---|---|---|
| B1 | `protect`: `User` + `SecuritySession` via `Promise.all` (customer tokens); identical check order + errors; platform tokens still 1 query | 2 seq RTTs → 1 |
| B2 | `tenantContext`: `.lean()` on company + subscription (all consumers read-only — verified) | skips hydration ×2/req |
| B3 | `checkSubscriptionStatus`: reuse `req.company.subscription` when attached + ownership-verified, else fetch as before | −2 RTTs on every guarded router |
| B4 | `getPermissionByName()`: 15s TTL in-process metadata cache (global, deploy-time data; strictly fresher than the existing 5-min grant cache) | −1 RTT per guarded req |
| B5 | `ensureCompanyRoles`: per-role upsert+migrate in `Promise.all`; `{ fetchRoles:false }` for `resolveUserPermissions` (return was discarded) | cold miss ~12 seq RTTs → ~2 |
| B6 | `myPermissions`: drop redundant `ensureCompanyRoles` (payload path already runs it) | cold login −1 migration run |
| B7 | dashboard self-view: 5 independent queries in `Promise.all` | 5 seq RTTs → 1 |
| B8 | `listUsers`: `.lean()` (JSON-identical — no virtuals in payload) | skips hydrating ≤200 docs |
| B9 | `Notification`: `+{ user, readAt }`, `+{ user, createdAt }` compounds | exact filter+sort support |
| F1 | `AppRoutes`: 121 page imports → `React.lazy` + one `Suspense`; layouts/guards eager (all targets verified default-exported) | initial JS 1,903 KB → 345 KB (−82%), gzip 422 KB → 104 KB; chunk warning gone |
| T1 | `middlewares/perfTiming.js` + `PERF_TIMING` flag (default off, zero-cost): per-request `auth/tenant/rbac/sub/scope` marks + Mongoose query counter via count-only debug hook + AsyncLocalStorage attribution. Logs operation + ms only — never bodies/tokens/PII/payloads | local measurement tool |

Warm-cache guarded route: ~7 sequential pre-controller RTTs → ~3
(`protect` 1 + `tenantContext` 1 + cached gates 0–1).

## 5. Before / after (query counts from code analysis; wall-clock needs local runs)

| Endpoint | Before (pre-controller seq RTTs) | After |
|---|---|---|
| `GET /notifications/unread-count` | 2 (`protect`) | 1 (`protect` parallel) |
| `GET /payroll/employees/:id` etc. | ~7 (`protect` 2 + `tenant` 2 + `sub` 2 + `perm` 1) | ~3 (`protect` 1 + `tenant` 1 + cached gates) |
| Cold permission miss (any guarded req) | +~12 (`ensureCompanyRoles` + discarded fetch) | +~2 |
| Self dashboard controller | 5 sequential | 1 (`Promise.all`) |
| Initial JS bundle | 1,903 KB / 422 KB gzip, 1 chunk | 345 KB / 104 KB gzip + on-demand route chunks |
| After wall-clock (Atlas RTT-dependent) | — | LOCAL MEASUREMENT REQUIRED (see §7) |

No timings are fabricated: this sandbox has no Atlas access, so every
millisecond above the query-count level must come from localhost runs.

## 6. Regression results

- Targeted hermetic suites (security hardening, payroll RBAC, gate
  cache, employee payroll, setup, monthly inputs, structures,
  components): 194/194 pass.
- Full `npm run test:all`: **1086/1086 pass, 0 fail** (run with the
  same dummy `MONGO_URI=mongodb://127.0.0.1:27017/crewly_test` every
  suite already self-stubs — satisfies the `config/env.js` import-time
  gate; no live Mongo in sandbox, no secrets involved). Without that
  var, 11 suites exit at import on the BASE commit too (verified via
  `git stash` A/B run: identical 11 failures) — pre-existing sandbox
  environment behavior, not a regression.
- Frontend `npm run build`: green; per-route chunks emitted, Vite
  chunk-size warning gone.

## 7. Localhost acceptance (developer)

Backend (two terminals):

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
# Terminal 1: API with timing on for ONE measurement session
$env:PERF_TIMING = "true"; npm run dev
```

Then use the app normally and read the `[Perf]` lines in the API log:

```text
[Perf] GET /api/payroll/employees/abc -> 200 totalMs=812 mongoQueries=9
marks={"auth":180,"tenant":360,"rbac":370,"sub":365,"scope":540}
collections=users.find=2,companies.find=1,...
```

Reading: marks are cumulative — phase cost = mark minus previous mark;
controller+service = total minus last mark. `mongoQueries` ÷ phases ≈
your Atlas seconds-per-round-trip. Turn the flag off afterwards
(`$env:PERF_TIMING` unset + restart) — it is dev-only noise.

Browser (Chrome DevTools → Network → Fetch/XHR, disable cache, clear
log, visit each page ONCE, wait 10s, record XHR count / duplicates /
slowest API / size; repeat a second time):

Dashboard, People, Attendance, Leave, Payroll (structures + employee
profile + preview — the previously slow trio), Recruitment,
Notifications bell, one BGV route, one Super Admin route.

Also confirm: initial `index-*.js` ≈ 345 KB (was 1.9 MB) and route
chunks load on navigation.

## 8. Residual risks / follow-ups (NOT done — needs measured evidence)

- Atlas region vs dev-machine geography: if one RTT stays ~200ms+,
  that is infrastructure, not application. Do not migrate on hunches.
- `getSubtreeIds` full active-user scan on TEAM-scope payroll reads:
  indexed but uncached per request. Left alone — caching org reach
  risks stale authorization; measure first.
- Recruitment `populate` chains (`requisitionService`, inbox,
  interviews): detail-page cost, tenant-safe; needs per-page numbers.
- `listUsers` still returns full docs (minus password): projection
  needs a frontend field audit to avoid breaking the People page.
- `checkUserCreationLimit` sequential `checkLimit` loop: write path,
  not page latency. Untouched.
- Permission-metadata negative cache: an unknown name 403s from cache
  for ≤15s; consistent with the pre-existing 5-min grant cache.
- `PERF_TIMING=true` in production is only log noise (no PII), but
  keep it dev-only; the Mongoose debug hook is global while enabled.

pit rules locked in 🏁
