# Phase 35.2 — Responsiveness ("the app must respond")

**Status:** 35.2 implemented and verified locally — **awaiting localhost acceptance**.

Reported after 35.1: *"page loads very slowly, selected pages are not opening, i think that are not storing."*
This unit is about the first two. Nothing here changes what the app stores.

---

## 1. What was actually slow (measured, not guessed)

A hermetic probe (injected fake models — the repo's own seam) counted the DATABASE
OPERATIONS of one permission resolution on the server:

| Path | Before 35.2 | After 35.2 |
| --- | --- | --- |
| `ensureCompanyRoles()` — an established tenant | **13 ops** (1 `bulkWrite`, 2 `Permission.find`, 5 `findOneAndUpdate`, 5 `updateOne`) | **1 op** (1 indexed read) |
| `resolveUserPermissions()` — cold cache | **12–13 ops** | **2 ops** (`CompanyRole.find`, `CompanyRole.findOne`) |
| `resolveUserPermissions()` — warm cache (5 min) | 0 ops | 0 ops |

The provisioning migration ran **unconditionally**: five "does this role exist?" upserts
plus five version-gated updates on every call, for every tenant, forever — even for a
company whose five system roles had not changed since the day it was created. It ran on
every permission-cache miss, again after every role edit (that invalidates the cache),
and again on every API instance.

One page open could trigger several of those, on top of `protect` (two more reads) and the
page's own five requests. On a remote database this is what "the page does not open" looks
like; the browser timings the report came with (`/api/roles/templates` 14.2 s / 5.9 s,
`/api/users` 17.8 s) are consistent with it.

### The fix: a read gate, not a rewrite

`ensureCompanyRoles` now asks one question first — *which of the five system roles already
exist for this tenant, and at what version?* — and only writes when there is something to
do. The write path itself (atomic upserts, version-gated `$addToSet` migration, E11000
convergence) is **untouched**, so the guarantees do not change:

* a missing role is created (same `$setOnInsert`, same defaults, same unique index);
* a role whose `permissionVersion` is behind is migrated immediately;
* the whole function stays idempotent and multi-instance safe;
* `rbacBootstrap.test.js` and `cacheMultiInstance.test.js` pass unchanged
  (the only test edit is teaching one fake to answer a bare `.lean()`, which real Mongo does).

No new process state, no Redis dependency, no TTL, nothing that can go stale: the gate
reads the same database the writes would have written.

## 2. Why pages looked like they "were not opening" (client)

Three separate mechanisms, all now fixed:

| Mechanism | Before | After |
| --- | --- | --- |
| **No request timeout.** axios defaults to waiting forever, so a stalled call never resolved and never failed: the spinner stayed, the page stayed empty, and nothing was reported. | hang forever | 25 s bound (`REQUEST_TIMEOUT_MS`), on the app client and the refresh client. A timeout is a normal failure: the 35.1 layer already words it ("The server took too long to respond.") and every page's catch block can offer Retry. |
| **A FAILED permission check was rendered as a REFUSAL.** The route guard showed "Your account cannot open this page yet — restart the local backend and sign in again" whenever permissions were empty — including when the request had simply failed. That is why "selected pages are not opening": the guard was denying pages that had never been checked. | misleading refusal | the guard now separates the two: a failure says **"We could not check your permissions"** with the reason and a **Retry** button that re-runs the check; only a resolved check may deny. |
| **The roles page opened with four requests**, the heaviest being `/users?limit=500` — a 200-row, two-join payload for a tab nobody had opened yet. The server caps list reads at 200 anyway, so 500 was never honoured. | 4 requests on open, one of them the heaviest | one parallel batch (roles + permission catalogue + templates); the user list loads when the **User Assignments** tab is first opened, and asks for the 200 rows the API actually returns. |

## 3. Files changed

* `Backend/src/utils/permissionService.js` — the 35.2 read gate in `ensureCompanyRoles`.
* `Frontend/src/services/api.js` — `REQUEST_TIMEOUT_MS = 25000` on both axios clients.
* `Frontend/src/routes/RequirePermission.jsx` — three states: checking / check failed (Retry) / refused.
* `Frontend/src/pages/settings/RolesPermissionsPage.jsx` — one parallel batch; user list on demand.
* `Frontend/src/services/permissionService.js` — `users()` asks for 200, the server's real cap.
* `Backend/test/rbacBootstrap.test.js` — one fake extended to answer a bare `.lean()` (Mongo does).
* `Backend/test/permissionBootstrapCost.test.js` — NEW pins (this unit).
* this document.

## 4. Pins (hermetic)

`Backend/test/permissionBootstrapCost.test.js` asserts, against injected fake models:

* an up-to-date tenant costs **one read** to ensure its roles — **zero** writes;
* a cold resolution of an established tenant costs **at most two reads**;
* a tenant that was never provisioned still gets all five upserts **and** all five migrations;
* a single stale role is migrated while the current ones are left alone;
* both axios clients carry a bounded timeout;
* the guard separates "check failed" (with Retry) from "refused", and the refusal card never
  sees the error state;
* the roles page defers the user list to its tab and batches what it does need;
* `users()` no longer asks for 500 rows.

## 5. Limitations (honest)

* The gate does not make a cold FIRST bootstrap cheaper (still five upserts + five migrations):
  that work is genuinely required, and it happens once per tenant.
* A permission-cache miss still costs two reads. The 5-minute in-process cache is what makes
  the steady state zero; a role edit deliberately invalidates it.
* The timeout is 25 s per request. A legitimately slower query (a very large payroll run)
  will now fail at 25 s instead of hanging — retry, and it is reported rather than silent.
* `protect` still costs two reads per request (`User.findById` + live session). That is a
  security check, not overhead to trim here.
* Numbers above are database-operation COUNTS on a local, hermetic harness. The wall-clock
  gain depends on the database's latency; that is what the counts remove.

## 6. Localhost verification (PowerShell)

```powershell
cd Backend
npm run dev
```

```powershell
cd Frontend
npm run dev
```

1. Open **Roles & Permissions**. The page should appear without the long stall, and the
   browser network tab should show **three** requests on open (permissions/me, roles,
   permissions) — the user list is **not** among them.
2. Click **User Assignments** — the user list request appears only now.
3. Stop the backend (`Ctrl+C`) and open any permission-gated page. You should see
   **"We could not check your permissions"** with a **Retry** button — *not*
   "Your account cannot open this page yet".
4. Start the backend again and press **Retry** — the page opens.
5. Watch the server log for slow requests; the roles page should no longer trigger a burst
   of role upserts on every visit (the migration only runs when something is actually stale).

Sign-off line for the unit: **Phase 35.2 awaiting localhost acceptance.**
