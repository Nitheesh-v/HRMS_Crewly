# Phase 38 — Employee Profile Change Requests

**Status:** implemented, hermetic tests green, **owner localhost acceptance not yet run.**
**Scope:** a reviewable self-service lane for fields an employee must not change alone.

---

## 1. The problem this phase solves

Two different kinds of personal data shared one screen, and both were treated the same way:

| Data | Who could change it before Phase 38 | Risk |
| --- | --- | --- |
| Phone, gender, birthday, address, emergency contact | the employee, instantly | low — a wrong value hurts only them |
| **Bank account, IFSC** | the employee, instantly (`PUT /api/profile/me`) | **high** — the next salary run pays into that account |
| Name, designation, employee code, date of joining | nobody (read-only, HR edits from the Users page) | medium — employment facts, but there was no self-service route at all |

Phase 38 adds one workflow for the second and third rows:

```
Employee edits a field they do not own
        ↓
POST /api/profile/change-requests          (proposal, nothing is written)
        ↓
HR / Company Admin sees it in the queue    GET  /api/profile/change-requests/pending
        ↓
Approve                                    POST /api/profile/change-requests/:id/approve
        ↓
the value is written to the User document  (appliedAt is stamped)
        ↓
employee gets a notification + sees the decided request on My Profile
```

Rejecting records a decision and a reason and **never touches the profile**.

## 2. Files

**Added**

| File | What it is |
| --- | --- |
| `Backend/src/services/profile/profileChangeRules.js` | pure domain rules: field allowlist, per-field validators, masking, state machine, serialization |
| `Backend/src/models/ProfileChangeRequest.js` | the request document + the "one open request per field" unique index |
| `Backend/src/services/profile/profileChangeService.js` | orchestration: submit → verify → claim → apply → compensate |
| `Backend/src/controllers/profileChangeController.js` | eight thin HTTP handlers |
| `Backend/src/routes/profileChangeRoutes.js` | `/api/profile/change-requests`, self-service + reviewer lanes |
| `Backend/src/validators/profileChangeValidator.js` | structural validation + identity-override refusal |
| `Backend/test/profileChangeRequests.test.js` | 31 hermetic tests (rules, service, validators, registry, wiring) |
| `Frontend/src/pages/profile/ProfileChangeRequestsPage.jsx` | the reviewer queue |
| `Frontend/test/profileChangeRequests.test.js` | 6 source pins (service verbs, no bank direct-edit path, permission guard) |
| `docs/PHASE_38_PROFILE_CHANGE_REQUESTS.md` | this document |

**Modified**

| File | Why |
| --- | --- |
| `Backend/src/controllers/profileController.js` | `SELF_EDITABLE` no longer contains `bankAccount` / `ifsc` — the direct door is closed so the workflow is not decorative |
| `Backend/src/utils/permissionRegistry.js` | new resource `PROFILE_CHANGE` + `PROFILE_CHANGE_REVIEW`; granted to `HR_MANAGER` (Company Admin inherits scope-ALL) |
| `Backend/src/utils/permissionService.js` | `SYSTEM_PERMISSION_VERSION` 37 → 38 with the migration-log entry, so existing tenants migrate on deploy |
| `Backend/src/routes/index.js` | mounts `/profile/change-requests` **before** `/profile` |
| `Backend/test/chatModeration.test.js` | the 33.9 version pin is now bound to the live constant (≥ 37, currently 38) instead of a frozen number |
| `Backend/package.json` | `test:profile-changes` script + the file in `test:all` |
| `Frontend/src/services/profileService.js` | six change-request verbs |
| `Frontend/src/pages/profile/MyProfilePage.jsx` | direct vs request lanes; bank + employment fields now read-only with “Request change”; “My Change Requests” list |
| `Frontend/src/routes/AppRoutes.jsx` | `/app/profile/change-requests` behind `RequirePermission any={['PROFILE_CHANGE_REVIEW']}` |
| `Frontend/src/layout/AppLayout.jsx` | menu entry gated on `hasPermission('PROFILE_CHANGE_REVIEW')` |
| `Frontend/src/layout/SidebarNav.jsx` | icon + People-group membership for the new path |

## 3. Security decisions (the parts that matter)

1. **The allowlist is deny-by-default.** `PROFILE_CHANGE_FIELDS` lists exactly
   `name`, `designation`, `employeeCode`, `dateOfJoining`, `bankAccount`, `ifsc`.
   A client that sends `role`, `companyId`, `status`, `reportingTo` or `password`
   gets a 400 and **no document is created** (pinned by test).
2. **Identity is server-derived.** `companyId`, `employeeId`, `reviewedBy` come
   from `protect` / `tenantContext`; the validator refuses them in the body.
3. **Bank values are masked on the wire.** The request stores the raw value it
   needs to apply, but `serializeChangeRequest()` derives `from`/`to` from
   `maskTail()` (last four digits) and never spreads the raw columns. Audit rows
   carry field names and notes, never account numbers.
4. **Drift is refused, not overwritten.** Approving re-reads the employee record
   and compares the current value with the snapshot taken at submission; a
   mismatch is a 409 and the request is put back in the queue.
5. **Two reviewers cannot both win.** The decision is claimed with
   `findOneAndUpdate({ status: 'pending' })`.
6. **One open request per field is a database guarantee**, not a hopeful
   read-then-write: partial unique index `{ companyId, employeeId, pendingFields }`
   filtered on `status: 'pending'`.
7. **Reviewing is a separate duty.** `PROFILE_CHANGE_REVIEW` is not in any
   self-service block, is granted to `HR_MANAGER` explicitly, and the default
   scope resolver returns `[]` for an ordinary employee — a resolver may not
   quietly promote a requester into a reviewer.
8. **No transaction theatre.** MongoDB transactions need a replica set, so the
   approve path is claim → apply → compensate, and the worst case (crash between
   apply and stamp) leaves `appliedAt: null` — visible, never a silent lie.

## 4. Data model

`ProfileChangeRequest` (tenant-scoped, one document per proposal)

```
companyId      → Company       (required, indexed; every query filters on it first)
employeeId     → User          (required, indexed)
employeeName   → String        (display snapshot for the queue; no join needed)
employeeCode   → String
changes[]      → { field, label, from, to, _fromRaw, _toRaw }
pendingFields  → [String]      (index key only)
status         → pending | approved | rejected | cancelled
reason         → String ≤300   (employee text)
decisionNote   → String ≤300   (reviewer text; required to reject)
requestedAt/By, reviewedAt/By, appliedAt, cancelledAt/By
```

Indexes: `{companyId, employeeId, status, requestedAt:-1}` (mine),
`{companyId, status, requestedAt:1}` (queue), and the partial unique index above.

## 5. API surface

| Method | Path | Gate |
| --- | --- | --- |
| POST | `/api/profile/change-requests` | `protect` + `tenantContext` + `checkWriteAccess` + `PROFILE_UPDATE_SELF` |
| GET | `/api/profile/change-requests/me` | none (service scopes to `req.user._id`) |
| GET | `/api/profile/change-requests/pending` | `PROFILE_CHANGE_REVIEW` |
| GET | `/api/profile/change-requests/history?status=approved\|rejected` | `PROFILE_CHANGE_REVIEW` |
| GET | `/api/profile/change-requests/:requestId` | owner or scoped reviewer |
| POST | `…/:requestId/approve` | `PROFILE_CHANGE_REVIEW` + org scope |
| POST | `…/:requestId/reject` | `PROFILE_CHANGE_REVIEW` + org scope + non-empty reason |
| POST | `…/:requestId/cancel` | owner or scoped reviewer, pending only |

Status codes: 400 (validation / blank rejection reason), 403 (not your request,
out of scope, self-review), 404 (unknown id, wrong tenant), 409 (duplicate open
request, already decided, profile drifted, employee code taken).

## 6. Test evidence

```
Backend   npm run test:all   → 3307 tests / 173 suites / 0 fail
Backend   npm run test:profile-changes → 31 tests / 0 fail
Frontend  npm test           → 384 tests / 0 fail
```

Hermetic only: no MongoDB, no Redis, no network. The suite injects the two
models, the scope resolver, notifications, audit and the clock, and passes
throwing sentinels for Attendance / Leave / Payroll so any cross-domain write
fails the build.

## 7. Localhost acceptance (Windows PowerShell)

Use a **dedicated local** MongoDB (and, if presence is enabled, a local Redis).
Do not point these steps at shared staging.

```powershell
# 0 — dedicated local database
$env:MONGO_URI = 'mongodb://127.0.0.1:27017/crewly_phase38_test'

# 1 — backend
Set-Location .\Backend
npm install --no-audit --no-fund     # first run only
npm run dev
# expect: "API listening" and the readiness probe below returns 200

# 2 — readiness (new terminal)
Invoke-RestMethod -Uri 'http://localhost:5000/api/health/ready'

# 3 — frontend (new terminal)
Set-Location .\Frontend
npm install --no-audit --no-fund     # first run only
npm run dev -- --host 127.0.0.1      # open http://127.0.0.1:5173
```

Acceptance scenarios (test company: **Infolexus**; users **HRinfo** = HR_MANAGER,
**manikandan** = EMPLOYEE):

1. **A — direct lane still works.** As `manikandan` → My Profile → change Phone /
   Emergency Contact → Save Profile → value persists after a refresh.
2. **B — bank is now approval-only.** My Profile → Bank Details has **no** editable
   inputs. DevTools → try `PUT /api/profile/me` with `{ "bankAccount": "123456789012" }`
   → the value is **not** saved (only the self-service fields are accepted).
3. **C — submit.** Click “Request change” → Bank account number → enter a new
   number → “Send for approval”. The card appears under **My Change Requests** as
   `pending`, the profile value is unchanged, and HRinfo gets a notification.
4. **D — duplicate guard.** Try a second request for the same field → the API
   answers 409 (“You already have an open request…”), and the modal warns before
   you send.
5. **E — review queue.** As HRinfo → People → **Profile Change Requests** → the row
   shows `«old» → «new»` with the account masked (last four digits). `/pending`
   returns 200; as `manikandan` the same call returns 403.
6. **F — approve applies.** Approve with a note → the employee’s bank value is
   updated (`GET /api/users/:id` as HR shows the new value), `appliedAt` is set,
   the employee sees `approved` and gets a notification.
7. **G — reject never writes.** Submit a designation change → reject with a reason
   → profile unchanged, request shows `rejected`, and the employee can submit
   again for the same field.
8. **H — drift.** Submit a name change, change the name from the **Users** page as
   HR, then approve the request → 409 “changed after this request was submitted”
   and the request is back in the queue.
9. **I — ownership.** As `manikandan`, open HRinfo’s request id via
   `GET /api/profile/change-requests/<id>` → 403. Cancel your own pending request
   → `cancelled`, then approve it → 409.
10. **J — tenant isolation.** With a second company (Agrihub) in the same database,
    its HR account sees an **empty** queue and gets 404 for an Infolexus request id.
11. **K — no side effects.** Before/after each step, `Attendance`, `Leave` and
    payroll collections for the test employee are unchanged, and `AuditLog` has
    `PROFILE_CHANGE_REQUEST_SUBMITTED / _APPROVED / _REJECTED / _CANCELLED` rows
    with **no** bank numbers in `newValue`.

Sign-off is the owner running A–K on localhost. The automated suites do **not**
establish live behaviour of a real MongoDB deployment.

## 8. Deliberate limits (not bugs)

* Managers holding `PROFILE_CHANGE_REVIEW` see their reporting subtree only; the
  default grant is HR + Company Admin.
* A request carries at most 5 fields, and only one open request per field.
* Changing `employeeCode` to a code another employee already uses is a 409 at
  approval time (the tenant-unique index is the guard; it is also checked early).
* No payroll-profile write, no Attendance write, no productivity/history feature:
  Phase 38 only decides whether an employee-record edit is allowed.
