# Phase 35.3 — The count that said 0, and the save that "did not stick"

**Status:** 35.3 implemented and verified locally — **awaiting localhost acceptance.**

Two findings from the same report, both in Roles & Permissions:

1. **"0 user(s) hold this role"** for Company Admin, on a company whose only user *is* the
   Company Admin.
2. **"I think they are not storing"** — a change that saved successfully and then appeared
   to be gone.

They turned out to be two different bugs, and the second one was not a storage bug at all.

---

## 1. The count said 0 because membership was counted one way out of two

`permissionService.resolveUserPermissions` — the code that decides what a person may do —
accepts **two** ways of holding a role (`findUserRole`):

| Way | How it is resolved |
| --- | --- |
| `user.roleRef` | the modern link, looked up first |
| `user.role` (the legacy string) | the fallback: `CompanyRole.systemRoleKey === user.role` |

Membership was counted on **`roleRef` alone**:

```js
// before 35.3 — roleMemberCounts / getRole / updateRolePermissions
User.countDocuments({ companyId, roleRef: role._id, status: 'ACTIVE' })
```

The company founder is created with `role: COMPANY_ADMIN` and **no `roleRef`**
(`authController`), and every user an admin adds through the legacy `CREATION_RIGHTS` path
gets the same shape (`roleController.assignUserRole`-free creation: `role` set, `roleRef`
`null`). So the one person who unambiguously held Company Admin was invisible to the count,
and the screen honestly reported zero.

### The fix: one definition of "holds this role"

```js
const roleHoldersQuery = (role) => ({
  $or: [
    { roleRef: role._id },
    ...(role.systemRoleKey ? [{ roleRef: null, role: role.systemRoleKey }] : []),
  ],
});
```

* It mirrors the runtime fallback **exactly**: the legacy arm exists only when the role has a
  `systemRoleKey`, which is the only key `findUserRole` honours. A custom role
  (`systemRoleKey: ''`) can never collect phantom members from a role string.
* Users with a `roleRef` are excluded from the legacy arm, so nobody is counted twice.
* `status: 'ACTIVE'` is unchanged — an inactive user still must not block housekeeping.
* Tenant scoping is unchanged (the `companyId` filter is on every query).

Cost: **one extra aggregation per role list** (all legacy holders resolved in a single group),
and a single combined `countDocuments` for a single role. The list screen, the role detail
screen and the role-save response now all use the same helper, so the number shown and the
number returned by the save can no longer drift apart.

`deactivateRole` deliberately stays `roleRef`-only: system roles are refused before any
counting, and a custom role has no legacy holders to reassign — the ref-only count is already
exact there, and counting otherwise would promise to move users the code does not move.

## 2. The save that "did not stick" was a read, not a write

All four write paths were audited, and **all four write correctly**:

| Write | Verdict |
| --- | --- |
| `PUT /roles/:roleId/permissions` | atomic `$set`, `new: true`, invalidates the tenant cache — correct |
| `PATCH /roles/:roleId` (name/description) | saved, cache invalidated — correct |
| `PATCH /users/:userId/role` | writes `role` **and** `roleRef` together, invalidates the user's cache — correct |
| `PUT /users/:userId/permissions` (overrides) | saves the override list, invalidates the user's cache — correct |

The **read** was the broken half. `protect` hands `resolveUserPermissions()` a plain User
document, where `permissionOverrides.permission` is an **ObjectId**, not a populated
Permission document. The resolution loop asked for `override.permission?.name`, got
`undefined`, and skipped every override **in silence**:

```js
// before 35.3 — permissionService
(user.permissionOverrides || []).forEach((override) => {
  const name = override.permission?.name;   // undefined on the request path
  if (!name) return;                         // ...so every override was dropped
```

An administrator granted (or denied) a permission, the API answered *saved*, the audit log
recorded it — and the affected person's own screens did not change, because
`GET /my-permissions` and every route guard resolve permissions from `req.user`.
The admin tab (`GET /users/:userId/permissions`) populates the overrides, so *that* screen
faithfully showed the saved state. Two screens disagreeing about one saved change is exactly
what "it did not stick" looks like from the outside.

### The fix: resolve names, once, only when needed

```js
const overrideNames = await resolveOverrideNames(user.permissionOverrides, PermissionModel);
...
const name = override.permission?.name
  || overrideNames.get(String(override.permission?._id || override.permission));
```

* The populated fast path is kept: `GET /users/:userId/permissions` still costs **zero** extra
  reads.
* The lookup runs only when an override is present and unpopulated, and it is **one** read for
  all of them.
* An override whose permission has been deleted from the catalogue is still skipped — never
  guessed, never granted by accident.
* Explicit `DENY` still wins over everything.

## 3. Files changed

* `Backend/src/controllers/rolePermissionController.js` — `roleHoldersQuery`,
  `roleMemberCounts` (roles in, legacy arm), `roleMemberCount`, `membersOfRole` now share one
  definition of membership; `listRoles`, `getRole` and `updateRolePermissions` wired to it.
* `Backend/src/utils/permissionService.js` — `resolveOverrideNames` + the override loop.
* `Backend/test/roleMemberCount.test.js` — NEW pins (this unit).
* `Backend/test/permissionOverrideResolution.test.js` — NEW pins (this unit).
* `Backend/package.json` — `test:role-membership`, `test:permission-overrides`; both files
  added to `test:all`.
* this document.

## 4. Pins (hermetic)

`Backend/test/roleMemberCount.test.js` — the User model is an injected fake:

* a founder (`role: COMPANY_ADMIN`, no `roleRef`) **counts as a holder** — the reported bug;
* the legacy pass matches `roleRef: null` + `status: 'ACTIVE'` + the `systemRoleKey`, scoped to
  the tenant;
* `roleRef` holders and legacy holders **add up**;
* a custom role can never gain phantom members and never even runs the second query;
* all legacy holders are resolved in **one** aggregation, not one query per role;
* `getRole`'s count, `getRole`'s member list and the save response all use the shared helpers
  (source-pinned), and `deactivateRole`'s ref-only count stays ref-only on purpose;
* the runtime fallback the count mirrors (`systemRoleKey: user.role`) still exists.

`Backend/test/permissionOverrideResolution.test.js`:

* an `ALLOW` override carried as an **ObjectId** (the real request path) is honoured;
* a `DENY` override is honoured;
* populated overrides still cost **zero** extra reads, and a user without overrides pays
  nothing;
* an override for a deleted permission is skipped, never guessed;
* the write endpoint still invalidates that user's cached decision.

## 5. Limitations (honest)

* Legacy holders are **counted**, not migrated. No `roleRef` is back-filled: an admin-driven
  reassignment links them up when it happens, but a founder stays `role`-only until then.
* A legacy holder is listed by name/e-mail in the role detail's member preview (first 10) —
  same projection as everyone else, no extra data exposed.
* The count fix changes **numbers only**; it grants and revokes nothing. Permission behaviour
  for a legacy holder was already what `findUserRole` says it is.
* Overrides are cached for the 5-minute window, as before — every write path invalidates that
  entry, so the saved state is visible on the next request, not after a TTL.
* The reported "did not stick" is attributed to the override read path with certainty as a
  **defect fixed**, but the exact screen the report came from was not reproduced: if what was
  actually lost was a role name/description or an attendance field, tell me which screen and
  which field and it becomes the next unit.
* `GET /api/users` and `GET /api/roles/templates` slowness are 35.2's subject; 35.2 shipped a
  timeout and a request-count reduction, and this unit removed one more query from the roles
  page's role list (all legacy holders in one aggregation instead of none at all).

## 6. Localhost verification (PowerShell)

```powershell
cd Backend
npm run dev
```

```powershell
cd Frontend
npm run dev
```

1. Open **Roles & Permissions** and select **Company Admin**. On the company you registered
   with, the line under the role name must now read **"1 user(s) hold this role"** (your own
   account) instead of 0. The same number is what the deactivation confirm/dialog uses.
2. Add a user normally (Users page). Their role should count the same way — the number on the
   roles list and the number inside the role must match.
3. Open a user's **Permissions** (User Assignments tab), grant them one extra permission
   (for example `reports.view`), and save. You should see the success toast.
4. Sign in as that user in a private window (or press **Refresh permissions** in the app) and
   open the page that permission gates. The granted access must now be there — this is the fix
   for "it did not stick". Before 35.3 the grant was written to the database but silently
   ignored by the user's own permission check.
5. Now switch that same override to **DENY** and save. The affected user must lose the access
   after their next permission check — an explicit deny is never ignored.
6. Sanity check the negative case: a **custom** role (no system key) with nobody assigned must
   still read **0** — it must never inherit members from the legacy role string.

Sign-off line for the unit: **Phase 35.3 awaiting localhost acceptance.**
