# Phase 36.2 — HR Context Retriever & Tenant AI Config

**Status:** implemented, hermetic suites green, mutation-checked, full suite
green — **awaiting localhost acceptance.**

36.1 could call a vendor safely. 36.2 answers the next two questions the
chatbot needs answered before a single token is spent:

1. **What is this tenant allowed to use?** A per-tenant kill switch, a
   per-tenant token cap and a per-tenant allowlist of context categories.
2. **What does the AI get to know about the person asking?** Their authorized
   HR data, fetched by the backend, redacted, and formatted as one string.

Owner decision that shapes this unit: **the AI suite has no permission of its
own.** See §6 for why, and for the gap that leaves.

---

## §1 Purpose and scope

**The problem 36.2 solves.** Without a context retriever the chatbot has exactly
two options, and both are broken:

* it is a dumb echo — it knows nothing about the employee, so "what is my leave
  balance" gets a generic answer about how leave works; or
* the **frontend** puts HR data in the request body — which destroys tenant
  isolation (the server can no longer tell whose data it is), puts PII in a
  payload the vendor could see, and makes the client the author of its own
  context.

So the backend fetches, under the caller's own authority, and hands the AI
redacted text (Phase 36 §5.5).

**Read-only, absolutely.** The retriever performs `find`, `findOne` and
`aggregate` and nothing else. No `save`, `create`, `update`, `delete` on any HR
model — pinned by a source test.

**Out of scope (Phase 36 §10):** no HR schema changes, no chat UI, no streaming,
no new npm packages, no `payroll`/`performance` categories, no Redis wildcard
operations, no cross-user or admin "view as" surface, no storing of the
generated context.

---

## §2 `AITenantConfig` model & lifecycle

`Backend/src/models/AITenantConfig.js` — one row per tenant.

| Field | Type | Notes |
| --- | --- | --- |
| `companyId` | ObjectId → Company | required, **unique**, indexed |
| `enabled` | Boolean, default `true` | the per-tenant kill switch |
| `monthlyQuotaTokens` | Number, default `null`, `min: 0` | `null` = use the env default; `0` = **unlimited**; `n` = this tenant's hard cap |
| `allowedCategories` | `[String]`, enum, default all four | **non-empty** by validator |
| `updatedBy` | ObjectId → User, default `null` | who last changed it |
| `createdAt` / `updatedAt` | timestamps | automatic |

**The category enum is closed** to `profile`, `leaves`, `attendance`,
`policies`. `payroll` and `performance` are deliberately absent: reading a
payslip runs the payslipScope authorisation chain and reading an appraisal runs
the appraisal access chain, and a config row must never be able to switch
either on.

**Lifecycle.** The row is created lazily on first read (`findOneAndUpdate` with
`upsert` + `setDefaultsOnInsert`). That last flag matters: without it an upsert
writes a row with the schema defaults **missing**, and the first read of a
brand-new tenant sees `enabled: undefined` — falsy — i.e. silently disabled.
Pinned by a test.

**Privacy by absence.** The model has no field that could hold a prompt, a
response, a transcript or any employee PII. A test walks `schema.paths` and
asserts none of 21 forbidden names exists — not "is unused", **does not exist** —
and a second test asserts the file has no `pre(`/`post(` hook that could write
text around the schema.

---

## §3 Tenant config service + caching strategy

`Backend/src/services/ai/aiTenantConfigService.js`

| Export | Behaviour |
| --- | --- |
| `getTenantConfig(companyId, deps)` | cache → Mongo → defaults. Returns a frozen plain **snapshot**. |
| `updateTenantConfig(companyId, updates, adminUserId, deps)` | narrow allowlist, `$set`, `updatedBy`, then exact-key invalidation. |
| `invalidateTenantConfigCache(companyId, deps)` | DEL the one key. |
| `resolveTenantQuota(companyId, deps)` | tenant cap, or the env default when `null`. |
| `isTenantAIEnabled(companyId, deps)` | the per-tenant kill switch. |

**Cache.** Reuses the 28.7 abstraction (`services/redisCacheService.js`), so the
key is `crewly:cache:company:<companyId>:ai-config:v1:`, TTL **600 s**, bounded
500 ms per operation, fail-open, tenant-scoped, exact-key operations only.

Two deliberate choices:

* **Not the prompt's key shape.** The build prompt asked for
  `crewly:<env>:ai:config:<companyId>`. That sits outside the sanctioned
  `crewly:cache:company:…` namespace and inside the BullMQ/rate-limit prefix
  space. Reusing `buildTenantCacheKey` keeps the namespacing law intact and
  costs nothing.
* **`getCache`/`setCache`, not `getOrSetCache`.** `getOrSetCache` logs at **info**
  on every hit and miss, which would emit a cache line per AI request. The
  primitives are quiet and the config's 10-minute TTL makes the lost
  single-flight protection irrelevant.

**Shape determinism.** A cache hit returns JSON; a miss returns a Mongoose
document. Those are not interchangeable (ObjectId vs string), so every read is
normalised to the same frozen snapshot — `updatedBy` is always a string or
`null`, `monthlyQuotaTokens` always a number or `null`. A test asserts a hit and
a miss produce identical key sets and identical values.

**Fail-closed, and fail-soft in the right places.**

| Failure | Behaviour |
| --- | --- |
| Cache GET throws (Redis down) | **degrade to Mongo** — a cache outage is not the tenant's fault |
| Cache SET throws | skip the write, next read hits Mongo |
| Cache DEL throws | the update still succeeds; the entry expires in 600 s |
| Mongo read throws | `AIError` `AI_CONFIG_READ_FAILED`, 503 |
| Unknown update key | **refused** with the offending key named |

That first row is a defect this unit's own tests caught: the original
implementation let a cache exception escape and wrapped it as a config failure,
which would have turned a Redis outage into an AI outage.

---

## §4 HR Context Retriever design

`Backend/src/services/ai/hrContextRetriever.js`

```
getUserHRContext({ companyId, userId, categories, deps })
  1. tenant config -> effective = requested ∩ allowed
  2. four independent builders, in parallel, each individually guarded
  3. assemble in DECLARED category order (not completion order)
  4. redactPII(assembled)          <- the safety net
  5. return { context, categoriesUsed, sections }
```

**The signature is the authorisation.** There is no parameter through which a
different user's context can be requested — no alternate-identity argument of
any kind. A source pin greps for the forbidden names. Every user-scoped query
carries both `companyId` and `user`; company-scoped queries carry `companyId`
only. Missing identity is refused, never defaulted.

### What each section reads

| Category | Reads | Scope |
| --- | --- | --- |
| `profile` | `User`: `name`, `designation`, `department` (populated name), `dateOfJoining`, `email`, `employeeCode` | `{_id, companyId}` |
| `leaves` | balance roll-up (`Leave.aggregate`, yearly) + all-time COMP_OFF roll-up + pending list | `{companyId, user}` |
| `attendance` | today's `Attendance` row, active `ShiftAssignment`, 7-day `workMinutes` sum | `{companyId, user}` |
| `policies` | next 30 active, non-optional `Holiday`s; 5 newest `Announcement` titles | `{companyId}` only |

### Repo-reality adjustments (audit findings)

* **`User.email`, not `workEmail`.** There is no work/personal split in this
  repo. The email **is** included (the AI must know how to reach the employee)
  and is masked by the final redaction pass.
* **No leave-balance model exists.** Balances are computed, exactly as
  `leaveController` computes them. `committedDays()`/`buildBalance()` are not
  exported, so the retriever mirrors that aggregation — and adds the
  `companyId` scope `getMyLeaves` does not have today.
* **`user`, not `userId`**, on `Leave`, `Attendance` and `ShiftAssignment`.
* **String dates.** `Leave.startDate/endDate` and `Attendance.date` are
  `'YYYY-MM-DD'`; only `Holiday.date` is a `Date`. Comparisons are mixed
  accordingly, all against the **company-local** day (`Asia/Kolkata`).
* **COMP_OFF is all-time.** Same rule as `leaveController`: the entitlement
  never expires, so year-scoping would double-count at every January boundary.
* **No `ABSENT` exists.** The `Attendance` status enum is
  `PRESENT`/`LATE`/`HALF_DAY`; there is no stored absent row. A day with no
  record renders `NO_RECORD`, never an invented `ABSENT`.
* **Shift resolution** walks employee-scoped assignment → department-scoped
  assignment → the shift already recorded on today's attendance row.
* **`Announcement` has no `visibility`/`publishedAt`.** Every announcement in a
  tenant is already company-wide, so the filter is `{companyId}` ordered
  pinned-first then newest.
* **`Holiday` has no `locationId`.** Filtered by `isActive` and `isOptional`
  (an optional holiday is a choice the employee may not have made), bounded to
  30 days / 10 rows.
* **Leave `reason` is never selected.** It is employee free text with no
  redaction-safe rendering, so it is simply not fetched.

### Partial > nothing

One failing section renders `(leaves unavailable)` and the rest still arrives,
so an employee asking about leave still gets their shift if the announcement
query timed out. Failures are logged metadata-only (category + driver error
**code**, never a Mongo message, which can name collections and hosts).

**The tenant config is the exception:** if the allowlist cannot be read, the
error propagates. Guessing the allowlist would hand the AI data the tenant never
permitted.

### The redaction safety net

Field selection keeps PII out at the query level, but free text cannot be
trusted — an announcement title, a holiday name, a leave reason are all typed by
a human. The assembled string therefore goes through `redactPII()` before it is
returned. Pinned with a PAN, a `+91` mobile and a `Rs 45,000` amount planted in
free text.

---

## §5 Seam integration with aiProvider and aiUsageTracker

**`aiProvider.js` — two default resolvers swapped, nothing else touched.**

```js
isTenantEnabled = async ({ companyId }) => isTenantAIEnabled(companyId),
resolveQuota    = async ({ companyId }) => resolveTenantQuota(companyId),
```

The guard-ladder **order is unchanged** (pinned by a test that proves a disabled
tenant is refused *before* the limiter is charged), the injection seam survives,
and every 36.1 error code is unchanged.

**One deviation from the build prompt, and why.** §7.1 asked for a resolver that
throws to return `503 AI_UNAVAILABLE` with the tenant-disabled sentence. 36.1
pinned a throwing resolver to plain `AI_UNAVAILABLE`, and Phase 36 §10 forbids
changing a shipped code. So:

| Condition | Code | Sentence |
| --- | --- | --- |
| `isTenantAIEnabled` returns `false` | `AI_UNAVAILABLE` (503) | "AI features are disabled for your organization." |
| Resolver throws | `AI_UNAVAILABLE` (503) | generic temporary-unavailable sentence |
| `resolveTenantQuota` throws | `AI_CONFIG_READ_FAILED` (503) | "AI settings could not be read right now…" |

The distinct sentence is delivered without touching the frozen code set, by an
optional 4th `AIError` argument that `sendAIError` prefers when present. Every
36.1 factory leaves it `null`, so **every 36.1 reply is byte-identical to
before** — verified by the 66-test 36.1 suite still passing untouched.

`AI_CONFIG_READ_FAILED` is a **new, additive** code and a genuinely reachable
contract: it surfaces through the quota path and through the admin endpoints.

**`aiUsageTracker.js` — one new function, `getMonthUsage`.** The admin config
screen needs to show what the quota is measured against, and the only honest
source is the same rows `checkQuota` sums. It returns **zeros** rather than
throwing on failure: this is a display number, and a broken dashboard must not
become a broken AI call the way a broken quota read must. No existing function
was modified.

---

## §6 REST endpoints & validators

| Route | Middleware | Purpose |
| --- | --- | --- |
| `POST /api/ai/chat` | `protect`, `tenantContext`, `aiChatValidator` | unchanged from 36.1 |
| `GET /api/ai/config` | + `requirePermission('SETTINGS_MANAGE')` | config + month-to-date spend |
| `PUT /api/ai/config` | + `requirePermission('SETTINGS_MANAGE')`, `updateConfigValidator` | kill switch / quota / allowlist |
| `GET /api/ai/context/preview` | `protect`, `tenantContext`, `previewContextValidator` | the caller's own redacted context |

### Why `SETTINGS_MANAGE` and not `ai:admin`

**`ai:admin` does not exist.** The permission registry has no AI entry at all.
Adding one means a registry change, a `SYSTEM_PERMISSION_VERSION` bump (37 → 38)
and a migration that has to run against every existing tenant — a large,
consequential change for a route that already has a perfectly good owner.
`SETTINGS_MANAGE` has scope `ALL`, so `COMPANY_ADMIN` inherits it today, and the
change is zero-migration.

### The super-admin gap (recorded, not fixed here)

`requirePermission` **refuses `SUPER_ADMIN` by design** — "Platform roles cannot
use customer-company permissions." So a platform super-admin still has **no route
to manage a tenant's AI config**. The build prompt's §2 motivation names this
gap; deliverable A–E as specified does not close it, and building a super-admin
surface means the `superAdminAuth` chain plus a tenant-selection mechanism, which
is 36.3/36.4 work. Flagged in §8.

### The preview endpoint is throttled harder than the chat

It returns a whole HR context string, which makes it a data-dump tool. It gets
its **own** 32.4 store (`ai-context-preview`, 10/min, key
`crewly:<env>:rl:ai-context-preview:<companyId>:<userId>`) enforced in **exactly
one place** — the controller. A second check in the service would double-count
one request, which is the 36.1 lesson.

### Validators

`updateConfigValidator` checks each field individually so a payload mixing a
valid `enabled` with a nonsense `monthlyQuotaTokens` is refused as a whole rather
than half-applied; `null` quota is a real value (reset to the env default), and a
payload with none of the three fields is refused as a no-op.
`previewContextValidator` takes an optional CSV and treats `?categories=` (what a
browser sends for a blank field) as "everything allowed".

Both chains refuse `companyId`/`userId`/`user`/`feature` in body **and** query —
a query string is as much client input as a body.

---

## §7 Test coverage summary

| Suite | Tests | Focus |
| --- | --- | --- |
| `test/aiTenantConfig.test.js` | **45** | model privacy & vocabularies · read-through caching · key shape & TTL · Redis-down degradation · shape determinism · update allowlist & exact-key invalidation · quota resolution · kill switch · the `aiChat` seam (order, fail-closed, per-tenant cap) · source pins |
| `test/hrContextRetriever.test.js` | **47** | category filtering · profile field selection · leave balances & COMP_OFF · attendance & NO_RECORD · policies bounds & scoping · PII safety net (PAN/mobile/amount in free text) · authorization scoping · partial failure · tenant-config integration · source pins |
| `test/aiProviderFoundation.test.js` | **66** | unchanged from 36.1, still green |

**Totals:** `npm run test:all` → **2851 tests / 124 suites / 0 fail**
(before 36.2: 2759 / 106 / 0 → **+92 tests, +18 suites**).

**Mutation check — 16 mutations, 16 caught.**

| Mutation | Caught by |
| --- | --- |
| identity guard removed | 1 test |
| final PII safety net removed | 4 tests |
| profile query selects sensitive fields | 1 test |
| tenant allowlist ignored | 1 test |
| failed section silently dropped | 3 tests |
| clock no longer injectable | 2 tests |
| tenant config cache disabled | 5 tests |
| per-tenant quota ignored | 2 tests |
| per-tenant kill switch ignored | 1 test |
| unknown config fields accepted | 2 tests |
| tenant resolver reverted to the 36.1 no-op | 1 test |
| tenant quota resolver reverted to env default | 1 test |
| negative quota no longer refused | 1 test |
| empty allowlist no longer refused | 1 test |
| holiday window unbounded | 1 test |
| day-string boundaries inconsistent | 1 test |

Two of these (cache-degrade and the holiday day boundary) were **defects this
unit's own tests found and fixed**, not hypotheticals.

---

## §8 Known limitations & 36.3 handoff notes

1. **No super-admin route to a tenant's AI config.** `requirePermission` refuses
   `SUPER_ADMIN` by design. Closing this needs the `superAdminAuth` chain plus a
   tenant-selection mechanism — 36.3/36.4.
2. **No `ai:admin` permission.** The config endpoints reuse `SETTINGS_MANAGE`. If
   the owner wants a dedicated permission, that is a registry + version-bump +
   migration change and should be its own decision.
3. **The context string is not injected into any prompt yet.** 36.2 builds and
   redacts it; 36.3 is what actually passes it to the model. Nothing calls
   `getUserHRContext` in the chat path.
4. **No chat UI, no streaming, no conversation state** — all 36.3.
5. **Token counts come from the vendor's `usage` block.** If a provider omits it
   the row records zeros rather than an estimate.
6. **The quota window is a UTC calendar month**, not a rolling 30 days.
7. **`AI_MONTHLY_QUOTA_TOKENS=0` in the tenant row means unlimited.** A tenant
   with no configured allowance is not locked out.
8. **The redactor matches identifier shapes.** "twelve lakhs a year" and
   unusually grouped mobiles are not guaranteed. Known false positive: a
   10-digit business number starting 6–9 is masked as a mobile.
9. **The preview endpoint is a debug surface.** It is not called from any
   production UI, and it is throttled at 10/min.
10. **Hermetic tests use fake models.** No assertion here runs against a real
    Mongo collection, a real Leave balance or a real attendance history. The
    owner must verify the rendered context against real data via
    `GET /api/ai/context/preview`.

## §9 Localhost verification

**Restart the backend first** — `npm run dev` uses nodemon, which watches `.js`
files and will **not** restart for a model or service change it did not see:

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run dev
```

**1. Config truth (no new env keys in this unit):**

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run config:check
```

Expect the same AI block as 36.1 and `✓ Configuration valid`.

**2. The 36.2 pins:**

```powershell
npm run test:ai-tenant-config
npm run test:ai-context
npm run test:all
```

Expect 45 / 47 / 2851 tests, 0 fail.

**3. The live surface.** Log into `http://localhost:5173`, press **F12 →
Console**, and paste (replace the cookie with your own — the easiest way is to
run it on the logged-in page so `credentials: 'include'` picks up the session):

```javascript
const r = await fetch('/api/ai/context/preview', {
  credentials: 'include',
  headers: { 'X-Requested-With': 'XMLHttpRequest' },
}).then((x) => x.json());
console.log(r);
```

You should get `categoriesUsed: ["profile","leaves","attendance","policies"]`
and a `context` string with `=== EMPLOYEE HR CONTEXT ===` at the top. **Check it
with your own eyes**: your email must read `[EMAIL_REDACTED]` and your mobile
must not appear anywhere.

**4. PowerShell equivalent** (needs your access cookie):

```powershell
curl.exe -X GET "http://localhost:5000/api/ai/context/preview" `
  -H "X-Requested-With: XMLHttpRequest" `
  -H "Cookie: crewly_access=<paste-your-access-cookie>"
```

**5. The per-tenant kill switch, end to end:**

```powershell
curl.exe -X PUT http://localhost:5000/api/ai/config `
  -H "Content-Type: application/json" `
  -H "X-Requested-With: XMLHttpRequest" `
  -H "Cookie: crewly_access=<paste-your-access-cookie>" `
  -d "{\"enabled\":false}"
```

Then `POST /api/ai/chat` must answer **503** with
`"AI features are disabled for your organization."` — the sentence that says it
was your organisation's decision, not an outage. Re-enable with
`-d "{\"enabled\":true}"`.

**6. A tenant-specific quota:**

```powershell
curl.exe -X PUT http://localhost:5000/api/ai/config `
  -H "Content-Type: application/json" `
  -H "X-Requested-With: XMLHttpRequest" `
  -H "Cookie: crewly_access=<paste-your-access-cookie>" `
  -d "{\"monthlyQuotaTokens\":1000}"
```

`GET /api/ai/config` must then report `monthlyQuotaTokens: 1000` and the
month-to-date token total. Send `{"monthlyQuotaTokens":null}` to go back to the
platform default.

Sign-off line for the unit: **Phase 36.2 HR Context Retriever — pit rules locked in 🏁**
