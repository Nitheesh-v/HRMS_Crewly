# Phase 35.4 — The permission payload the app never asked for

**Status:** 35.4 implemented and verified locally — **awaiting localhost acceptance.**

Reported with a screenshot of **Roles & Permissions → Company Admin** reading *"227 permissions
selected"*, every box ticked:

> "227 permissions selected for admin, all are selected but not coming inside — and the pages are
> not opening."

The Roles screen was telling the truth. The **app** was never asking what the signed-in person may
do. This was not a roles-engine bug, not a counting bug and not a storage bug: the frontend was
skipping the request entirely.

---

## 1. The root cause, in five lines

`Frontend/src/redux/slices/PermissionSlices.js`, before this unit:

```js
async (_, { getState, rejectWithValue }) => {
  const { user, token } = getState().auth;

  if (!user || !token) {                 // ← for every COMPANY user this was TRUE
    return { ...emptyPermissionData, loadedUserId: null };
  }
```

Since **Phase 33.14** the customer session lives in an **HttpOnly cookie**, and a JS-visible token
is deliberately absent — the frontend says so in two places:

* `AuthSlices.js` — *"a null token is what keeps api.js from attaching a header at all"*,
* `useAuth.jsx` — *"`token` is only ever set for the PLATFORM portal (super-admin), so requiring it
  here would sign every customer out on reload while their cookie was perfectly alive"*,

and `LoginPage.jsx` calls `login(data.user)` — one argument, no token.

So for **every company user**, `token` was `null`, the thunk returned an empty permission set
without ever calling the API, and the whole app believed the person had **zero** permissions —
while the Company Admin role really did carry all 227. The Roles screen (the one screen with no
permission guard) rendered the matrix perfectly; every gated page answered *"Your account cannot
open this page yet"*. That is exactly "all are selected, but not coming inside".

### The fix

The cookie *is* the session and axios already sends it (`withCredentials: true`); a missing or
expired cookie comes back as a 401 that this thunk already reports through its fail-closed path.
The only reason left to skip the request is a missing USER:

```js
const { user } = getState().auth;

if (!user) {
  return { ...emptyPermissionData, loadedUserId: null };
}
```

The duplicate-request `condition` carried the same trap (`if (!user || !token) return true;` — it
let every dispatch through). It is now keyed on the user, which is what the payload is about.

Nothing else changed: the platform-role carve-out (provider RBAC) and the fail-closed rejected
path (`permissions: []`, `loaded: true`, `error: <reason>`) are untouched, so the 35.2 guard still
distinguishes "we could not check" from "you are not allowed".

## 2. Why this was invisible to everything else

* **The backend was always right** — `GET /permissions/me` needs only `protect` + `tenantContext`
  and returned the correct 227 permissions whenever it was asked. It was never asked.
* **The guard was being honest** — it renders *"Permission required"* for a resolved check that
  says no. An empty payload *is* a resolved check, so nothing looked broken: no error toast, no
  failed request, no console noise. Fail-closed behaviour hid a fail-wrong.
* **The 35.2 responsiveness work didn't touch it** — that unit was about cost and error
  reporting, and this request now costs the documented 2 reads cold / 0 warm.

## 3. What was measured while chasing this (kept for the record)

Across `Frontend/src` and `Backend/src/routes`:

| Check | Result |
| --- | --- |
| Permission gates in the frontend (`hasPermission`, `hasAnyPermission`, `<Can>`) | **180** |
| Route guards (`<RequirePermission>`) / role guards (`<RequireRole>`) | **16** / **22** |
| Permission-guarded backend routes (`requirePermission` / `requireAnyPermission`) | **157** / **68** |
| Guards a COMPANY_ADMIN could not satisfy **of those 225** | **1** |
| Frontend gates a COMPANY_ADMIN could not satisfy | **1** |

Both single failures are the same story: the default **COMPANY_ADMIN matrix is missing 6 catalogue
permissions** — `EMPLOYEE_SALARY_READ_SELF`, `REQUISITION_READ_SELF`, `REQUISITION_UPDATE_SELF`,
`REQUISITION_SUBMIT_SELF`, `EMPLOYEE_READ_DEPARTMENT`, `EMPLOYEE_READ_TEAM` — and
`GET /statutory/mine` requires `EMPLOYEE_SALARY_READ_SELF` outright (the My Payslips statutory card
skips itself politely). It is a separate defect (it needs a `SYSTEM_PERMISSION_VERSION` bump so
existing tenants are migrated) and is **not** touched in this unit: one unit at a time. It is the
first candidate for the next one.

Note the matrix lists 234 entries with 7 duplicates — 227 distinct — which is where the "227
permissions selected" on the screenshot comes from.

## 4. Files changed

* `Frontend/src/redux/slices/PermissionSlices.js` — thunk guard + dedupe condition (the fix).
* `Backend/test/frontendPermissionBootstrap.test.js` — NEW source pins (11).
* `Backend/test/frontendPermissionPayload.test.js` — NEW behavioural pins (8).
* `Backend/package.json` — `test:permission-bootstrap`, `test:permission-payload`; the source pin
  joined `test:all`.
* this document.

## 5. Pins (and proof they bite)

`Backend/test/frontendPermissionPayload.test.js` runs the **real slice and store** in Node with the
frontend service module mocked:

* `token === null` still fetches, and the payload reaches the state every screen reads
  (`permissions`, `deniedPermissions`, `role`, `loaded`, `loadedUserId`);
* a signed-out user and a platform account make **no** request;
* a failed load rejects with the reason and leaves `permissions: []` + `error` (fail-closed —
  what the 35.2 guard needs to say "we could not check your permissions");
* a repeated dispatch does not re-hit the API, while `invalidatePermissions()` allows exactly one
  refresh.

**Against the old guard (temporarily restored to check the pin bites): 6 of these 8 fail.**
They pass with the fix.

`Backend/test/frontendPermissionBootstrap.test.js` (part of `test:all`, no experimental flag) pins
the sources: the slice contains no `!token` guard, the condition does not read the token, the
platform carve-out and fail-closed path survive, `/permissions/me` requires no permission of its
own (no deadlock), and the three files that documented the cookie contract still say what they say.

## 6. Limitations (honest)

* The behavioural pin needs `--experimental-test-module-mocks`, so it runs from its own script
  (`npm run test:permission-payload`) rather than inside `test:all`, which keeps the source pins.
* The permissions are still cached in-process for 5 minutes; a role change is visible on the next
  request because every write invalidates that entry (35.3 covers the read path).
* A 401 (expired cookie) now surfaces as *"We could not check your permissions"* with **Retry** —
  correct, but if the session is genuinely gone the app's normal refresh/expiry handling takes over.
* No new dependency, no change to the backend session model, no token added back into JavaScript.

## 7. Localhost verification (PowerShell)

```powershell
cd Backend
npm run dev
```

```powershell
cd Frontend
npm run dev
```

1. Hard-refresh the app (**Ctrl+Shift+R**), sign in as the company admin, and open the browser's
   **Network** tab. Reload: you must now see a request to **`/api/permissions/me`** returning
   **200** with a `permissions` array (it was never sent before this unit).
2. Open **Attendance**, **User Management**, **Payroll**, **Recruitment** — they must open, and the
   sidebar must show its permission-gated entries (Candidates, Offers, Payroll Setup, My Timesheet,
   Attendance Policy, …). Under a COMPANY_ADMIN those are all expected.
3. Open **Roles & Permissions** and confirm **Company Admin** still reads **"1 user(s) hold this
   role"** (35.3) and the matrix still shows the same ticks — this unit changes nothing about what
   is stored, only whether the app asks.
4. Sanity check the refusal path: create a test user with the **Employee** role and sign in as
   them; pages outside their permissions must still say *"Permission required"* (a refusal), while
   a stopped backend must say *"We could not check your permissions"* with **Retry** (35.2).
5. Optional: open **My Payslips** as the admin — the statutory card is expected to be absent
   (documented finding in §3), and that is the next unit's candidate.

Sign-off line for the unit: **Phase 35.4 awaiting localhost acceptance.**
