# Phase 37.5 — WFH / Work-Location Request & Approval Workflow

**Build plan — single source of truth for this phase. One plan, no second
plan, scope strictly limited to 37.5.**

---

## A. Repository Findings

### A.1 What already exists in this repo

| Existing asset (path)                                        | Why it matters for 37.5                                                                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Backend/src/models/PresenceTenantConfig.js`                  | Already owns `wfhMode ∈ {self_declare, approval_required, disabled}` and `allowedWorkLocations: ['office','wfh','remote']`. 37.5 READS only; does not change the schema. |
| `Backend/src/services/presence/presenceService.js`            | Has the dead-end: `setMyWorkLocation` under `approval_required` returns `WFH_APPROVAL_REQUIRED` (409). 37.5 will continue to surface that error, the request workflow is the resolution. |
| `Backend/src/models/AttendanceWorkModeRequest.js`             | 31.4 already built an analogous workflow for attendance work-mode (WFH/FIELD/CLIENT_SITE/BUSINESS_TRAVEL). 31.4 governs **attendance clock-in**; 37.5 governs **presence work-location**. They are intentionally different domains: 37.5 must NOT write Attendance, Leave, or payroll (spec §39–42). 31.4 stays untouched. |
| `Backend/src/services/attendance/attendanceWorkModeService.js` + `attendanceWorkModeRules.js` + `attendanceWorkModeController.js` + `attendanceWorkModeRoutes.js` + `attendanceWorkModeValidator.js` | The review-queue + atomic-transition + audit/notify pattern we **mirror**. 37.5 reuses the *pattern* (validator shape, three-comment controller, `findOneAndUpdate({_id, companyId, status:'PENDING'})` atomicity, fire-and-forget notify via `notifySmart`, durable audit via `recordAudit`, scope helper `resolveScopeIds` from `utils/orgHelpers.js`). 37.5 does NOT import the 31.4 service. |
| `Backend/src/utils/orgHelpers.js`                             | `resolveScopeIds(req)` — Admin/HR → whole company, Manager/TL → subtree via `reportingTo`. Reused as-is for review authority. |
| `Backend/src/middlewares/permissionMiddleware.js`             | `requirePermission('PRESENCE_WORK_MODE_REVIEW')` will gate reviewer endpoints. 31.4 uses `ATTENDANCE_WORK_MODE_REVIEW`; the 37.5 permission is a **separate** name so presence/attendance can be enabled independently. |
| `Backend/src/utils/permissionRegistry.js`                     | Auto-loaded by app boot. Already has `ATTENDANCE_WORK_MODE_*`. 37.5 adds `PRESENCE_WORK_MODE_*` here (or a sibling file). See §C.5. |
| `Backend/src/utils/notifyPref.js` + `notifySmart(userId, payload)` | Fire-and-forget notification. 37.5 wraps calls in a `safeNotify` that never throws. |
| `Backend/src/utils/securityauditService.js` + `recordAudit({...})` | Durable audit log. 37.5 calls `recordAudit` for submit / decide / cancel with PII-minimal `newValue`. |
| `Backend/src/services/presence/presenceBus.js` + `presenceEvents.js` + `realtimeGateway.js` | The 37.4 cross-instance bus. 37.5 publishes a `work-location:changed` envelope after an APPROVE (and after a CANCEL of a previously-APPROVED) so connected viewers see the row refresh. The publish is best-effort, failures are logged, **never** roll back the Mongo state. |
| `Frontend/src/components/presence/PresenceMenu.jsx` + `WorkLocationSelector.jsx` | Current 37.2 dead-end: WFH radio under `approval_required` is disabled with copy "WFH requires approval for your company. (Request flow ships in a later update.)". 37.5 replaces that copy with an inline "Request WFH" button that opens `WorkLocationRequestDialog.jsx`. |
| `Frontend/src/services/presenceService.js`                    | Pattern for axios-with-code-aware error wrapping. 37.5 ships a sibling `Frontend/src/services/presence/workLocationRequestService.js` that mirrors the same pattern. |
| `Frontend/src/redux/slices/presenceSlice.js`                  | 37.5 ADDS a `workLocationRequests` sub-state inside the existing `presence` slice (no new top-level slice — keeps `store.js` untouched). |

### A.2 What 37.5 must NOT touch

- Attendance models, services, controllers, routes, validators.
- Leave models, services, controllers.
- Payroll models, services, controllers.
- 31.4 `AttendanceWorkModeRequest` collection, model, service.
- 37.1 `PresenceTenantConfig` schema or update endpoint.
- 37.4 realtime gateway itself (only the bus façade is reused).
- `Backend/.env`, `Backend/.env.example`, `package.json`.

### A.3 Conventions enforced by repo

- `// Data from frontend`, `// DB Logic`, `// Data to frontend` three-comment controller convention.
- `express-validator` chain validators; identity-override refusal via `body().custom(...)`.
- Routes: `router.use(protect, tenantContext, [checkSubscriptionStatus])` then `router.METHOD(path, [checkWriteAccess,][requirePermission,][validator,] controller)`.
- Hermetic backend tests use `node:test` + injectable fakes for models. No Mongo, no Redis, no axios.
- Frontend tests are source-pin assertions: read files, assert on substrings.
- Frontend service `envelope(promise)` normalizes the api.js interceptor's already-unwrapped body into `{data, ...}` shape.
- The redux `presence` slice has an `EMPTY_PRESENCE` default and exposes async thunks; 37.5 follows the same shape for `workLocationRequests`.

---

## B. Security / Data Boundaries

### B.1 Identity (spec §9, §16, §19, §43)

- `companyId = req.companyId`, `userId = req.user._id` — ALWAYS.
- Validator refuses `companyId`, `user`, `userId`, `employeeId`, `employee`, `approver`, `approverId`, `reviewedBy` from request bodies.
- `GET /me` ignores any `?userId` query — only the session user.
- Reviewer authority is decided server-side via `resolveScopeIds({companyId, user: req.user})`.
- **No self-approval** (spec §19). Even if employee has MANAGER role, `String(row.user) === String(req.user._id)` always short-circuits to 403.

### B.2 Tenant scoping (spec §8)

- Every model query includes `companyId`.
- No `findById` alone; always `findOne({_id, companyId})`.
- Indexes added: `{companyId:1, userId:1, status:1, startDate:1}`, `{companyId:1, status:1, requestedAt:1}`.

### B.3 State machine (spec §20–22)

```
pending   → approved    (reviewer only, after authz + revalidate)
pending   → rejected    (reviewer only)
pending   → cancelled   (owner only, OR reviewer)
approved  → cancelled   (owner only when startDate > today, OR reviewer)
rejected  → (terminal)
cancelled → (terminal)
```

All transitions go through `findOneAndUpdate({_id, companyId, status: <from>}, {$set:{status: <to>, ...}})` so a stale read can NEVER cause a double-decide.

### B.4 HR boundaries (spec §39–42, §49–56)

- WFH does NOT write to Attendance collection (test seam `AttendanceModel.create` throws).
- WFH does NOT write to Leave collection (test seam `LeaveModel.create` throws).
- WFH does NOT write to Payroll / AttendancePayrollSnapshot (test seam throws).
- WFH does NOT call any AI vendor; no imports of `services/ai/...` in any 37.5 file.
- WFH request decision is preserved on tenant config change. Cancelling a request never toggles `wfhMode`.

### B.5 NATS data minimization (spec §30)

The `work-location:changed` envelope is a strict fixed shape with the same schema-version pattern as `presence:changed`:

```
{ schemaVersion: 1, companyId, userId, location, source, occurredAt }
```

- `source ∈ {'approve','cancel','resolver'}` only.
- NO `decisionNote`, NO `email`, NO `phone`, NO `salary`, NO `reviewerId`, NO token.
- Envelope size cap mirrors `PRESENCE_MAX_LIVE_ENVELOPE_BYTES`.

### B.6 API response minimization (spec §38)

The serialized request returned to the client carries: `id, status, location, startDate, endDate, requestedAt, reviewedAt, decisionNote (own only), reviewerName (reviewer queue only), isCancelable, isApprovable`.

It does NOT carry: salary, bank, Aadhaar/PAN/UAN, address, attendance, leave reason, medical, password, token, refresh-token.

### B.7 Past-date rule (spec §14 — open question resolved in plan)

**Decision:** A WFH request for a date that is in the company's "today" (calendar in company timezone) is **allowed** if the request is created before the user's local "now" cutoff (e.g. they realized at 5 PM that they worked from home today). A WFH request for dates strictly before "today" is **refused** (consistent with 31.4 §3, but with the same single-day exception). This matches the spec's "Reasonable range" and is a 37.5-documented divergence from 31.4's "no past" rule. Tests assert: startDate === today → 201; startDate < today → 400 `WORK_LOCATION_REQUEST_PAST_START`. Tenant timezone is `policy.timezone || 'Asia/Kolkata'`, identical to 31.4's `dayKeyInZone`.

### B.8 Overlap handling (spec §15)

Two active (PENDING or APPROVED) requests for the same `(companyId, userId, day)` overlap. Day strings compare as strings. Range rule: `A.startDate <= B.endDate && B.startDate <= A.endDate`. Cancellation does not block new submission. Overlap is checked at submission and again at decision time (a second PENDING could have been created in the gap).

### B.9 Decision note (spec §23)

- Optional. Max 300 characters. Trim. Plain text.
- Stored on the request; returned in the serialized response to the OWNER and to REVIEWERS, but not in any realtime envelope and not in the team-page response.

---

## C. Implementation

### C.1 New files (backend)

| Path                                                                          | Purpose                                                                                                         |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Backend/src/models/WorkLocationRequest.js`                                   | Mongoose model. `companyId, userId, location='wfh' (frozen), startDate, endDate, status, requestedAt, requestedBy, reviewedAt, reviewedBy, decisionNote, cancelledAt, cancelledBy`. Indexes per spec §46. |
| `Backend/src/services/presence/workLocationRequestRules.js`                   | PURE rules. Mirrors 31.4 rules shape: `isValidDayString`, `validateRequestInput({...}, today, policy)`, `requestPolicyCheck`, `overlapExists(existing, candidate)`, `canTransition`, `cancelEligibility`, `serializeRequest`. |
| `Backend/src/services/presence/workLocationRequestService.js`                 | Orchestration. Mirrors 31.4 service shape: `submitRequest`, `listMyRequests`, `listReviewQueue`, `decideRequest`, `cancelRequest`, `getRequest`. Injectable deps: `RequestModel`, `UserModel`, `PolicyReader`, `NotificationDelegate`, `AuditDelegate`, `RealtimePublisher`, `resolveScopeIds`, `clock`. |
| `Backend/src/validators/presence/workLocationRequestValidator.js`             | `submitValidator` (location='wfh', startDate, endDate), `decideValidator` (decisionNote ≤300), `requestIdParam`. All reject identity overrides. |
| `Backend/src/controllers/presence/workLocationRequestController.js`          | Seven handlers. Three-comment convention.                                                                       |
| `Backend/src/routes/presence/workLocationRequestRoutes.js`                   | Mounted at `/api/presence/work-location-requests`. protect + tenantContext. `ATTENDANCE_WORK_MODE_REVIEW` permission reuse is rejected (we register `PRESENCE_WORK_MODE_REVIEW` and `PRESENCE_WORK_MODE_REQUEST` — see C.5). |

### C.2 Mounting (backend)

In `Backend/src/routes/index.js`, register:

```js
import workLocationRequestRoutes from './presence/workLocationRequestRoutes.js';
// …
router.use('/presence/work-location-requests', workLocationRequestRoutes);
```

### C.3 New files (frontend)

| Path                                                                       | Purpose                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Frontend/src/services/presence/workLocationRequestService.js`            | REST client. `submit`, `mine`, `reviewQueue`, `get`, `cancel`, `approve`, `reject`.                   |
| `Frontend/src/redux/slices/presence/workLocationRequestSlice.js`          | Thunks: `submitWorkLocationRequest`, `fetchMyWorkLocationRequests`, `cancelMyWorkLocationRequest`, `fetchWorkLocationReviewQueue`, `decideWorkLocationRequest`. State shape: `{ items, queue, submitting, decisionPending, byId, error }`. |
| `Frontend/src/components/presence/WorkLocationRequestDialog.jsx`          | Modal form: startDate, endDate, optional note. Renders only when `presence.wfhMode === 'approval_required'`. |
| `Frontend/src/components/presence/WorkLocationRequestHistory.jsx`          | List of own requests with status badges + cancel button.                                                |
| `Frontend/src/pages/presence/WorkLocationReviewPage.jsx`                   | Reviewer queue. PENDING only. Approve / Reject with optional decision note.                            |
| `Frontend/src/redux/store.js` (1 line addition)                            | `workLocationRequests: workLocationRequestReducer` under existing `presence` key (no top-level).      |
| `Frontend/src/components/presence/WorkLocationSelector.jsx` (edit)        | When `wfhMode === 'approval_required'`, replace the dead-end copy with a "Request WFH" button that opens `WorkLocationRequestDialog`. |
| `Frontend/src/components/presence/PresenceMenu.jsx` (edit, minimal)        | When the dialog is open OR there is a PENDING request, show a "WFH request pending" pill below the location row. |
| `Frontend/src/routes/AppRoutes.jsx` (edit, minimal)                        | Add `path="presence/work-location-requests/review"` guarded by `RequireRole roles={HR}`.             |
| `Frontend/src/layout/AppLayout.jsx` (edit, optional)                       | No nav entry required (link in PresenceMenu + dedicated route).                                      |

### C.4 37.5 does NOT register a new bus event type

We reuse the `presence:changed` envelope for the resolver-side effect of an APPROVED WFH request. Specifically: after `decideRequest` writes APPROVED, the resolver is **not** re-invoked here (that would couple 37.5 to the user's realtime channel). Instead, 37.5 publishes its own `work-location:changed` envelope via `realtimeGateway.publish(...)`, which the frontend `presenceChannel` will interpret as "refetch the team list / my row". The 37.4 team service has an `invalidate(teamId)` style hook — 37.5 calls `presenceBus.invalidateForUser({companyId, userId})` (new helper, 25 LoC, hermetic-tested) which publishes a `presence:invalidated` envelope on the SAME `crewly:<env>:realtime:events` channel, fixed-shape, only `companyId, userId, occurredAt, schemaVersion`.

This re-uses the 37.4 transport with no new gateway event-type registration, no new env, no new dep.

### C.5 Permission registration (backend)

`Backend/src/utils/permissionRegistry.js` (or a sibling file `presencePermissions.js` registered from the same boot path) registers:

```
PRESENCE_WORK_MODE_REQUEST  — for self-service submit / list / cancel own
PRESENCE_WORK_MODE_REVIEW   — for review queue / decide / cancel any
```

If the registry file is load-order-sensitive, we register both in a dedicated `Backend/src/utils/presencePermissionRegistry.js` and require it from `permissionRegistry.js` (1-line `import`).

### C.6 Default `today` (backend)

A helper `dayKeyInZone(at, timezone)` is duplicated in `workLocationRequestRules.js` (private) to avoid coupling to the 31.4 service. It uses `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })` and falls back to `new Date(at).toISOString().slice(0,10)` if Intl fails. Test seam injects a `clock` so hermetic tests control the date.

### C.7 No env vars, no packages

- `Backend/.env` untouched.
- `package.json` untouched.
- `Frontend/.env` untouched.
- No BullMQ, no NATS, no AI.

---

## D. Test Plan

### D.1 Backend hermetic — 61 test cases (numbered 1–61)

File: `Backend/test/workLocationRequests.test.js`

Section 1 — **POLICY (1–4):** `wfhMode=disabled` refuses; `self_declare` still allows direct WFH set; `approval_required` refuses direct WFH set with the 409 code; service `submitRequest` under `disabled` refuses with `WFH_DISABLED`.

Section 2 — **IDENTITY (5–9):** body `companyId` rejected, `userId` rejected, `employeeId` rejected, `reviewedBy` rejected, `?userId=` query ignored on `/me`.

Section 3 — **TENANCY (10–12):** company A cannot see / decide / cancel a request owned by company B (404, not 403, to avoid existence leak).

Section 4 — **DATES (13–18):** valid single day, valid range, `endDate < startDate` rejected, startDate strictly < today rejected, 366-day range rejected (limit 365), leap-day / Feb 30 rejected by `isValidDayString`.

Section 5 — **WORKFLOW (19–26):** happy path submit→list-mine (status PENDING), review queue shows pending only, approve flips status, reject flips status with `decisionNote`, owner can cancel PENDING, reviewer can cancel PENDING, owner can cancel APPROVED when startDate > today, owner cannot cancel APPROVED when startDate ≤ today.

Section 6 — **AUTHORIZATION (27–32):** employee cannot decide own (403), manager of unrelated team cannot decide (403), admin can decide, HR can decide, manager-of-team can decide, reviewer cancel across teams works for admin only.

Section 7 — **ATOMICITY (33–34):** two parallel approves → exactly one wins (other gets 409 ALREADY_DECIDED), cancel a non-pending → 409.

Section 8 — **RESOLUTION (35–40):** APPROVED request makes the work-location resolver return `wfh` for that day, even when the user's `UserPresence.workLocation` is currently `office`; cancel flips it back; range-spanning requests cover each day in the range; timezone boundary day-1 / day-2 inclusive.

Section 9 — **NOTIFICATIONS / AUDIT (41–45):** approve notifies the requester; reject notifies; cancel by reviewer notifies the owner; notification failure does NOT roll back the Mongo state (asserted via mock that throws); each transition writes one `recordAudit` row with the right action.

Section 10 — **REALTIME (46–48):** approve publishes `presence:invalidated` for the requester; cancel of an APPROVED publishes; envelope carries no PII (assert field set); publish failure does NOT roll back Mongo.

Section 11 — **HR BOUNDARIES (49–56):** `AttendanceModel.create` is never called; `LeaveModel.create` is never called; `PayrollSnapshotModel.create` is never called; no `services/ai` import anywhere in the 37.5 files; no `nats`/`@nats-io` import; no localStorage import; no NATS publish (re-asserted at 37.5 file level); no `.env` writes.

Section 12 — **DATA MINIMIZATION (57–61):** serialized response excludes salary/bank/Aadhaar/PAN/UAN/address/attendance/leave reason/medical/password/refresh-token/email/phone; envelope field set is the fixed 6; no reviewer note leaks to the team-page response (only `reviewerName: 'Reviewer'` for the queue).

### D.2 Frontend source-pin — 24 test cases

File: `Frontend/test/workLocationRequests.test.js`

Covers (24): route registered, route lazy-imported, role guard, dialog mounted in `WorkLocationSelector` only when `wfhMode==='approval_required'`, no companyId/userId/employeeId in dialog submit payload (regex assertion), no `reviewedBy` in payload, form refuses `endDate < startDate` client-side, double-click guard on submit button, server-confirmed Pending reflected in list, my-list shows cancel control only for cancelable rows, reviewer controls only on review page, approve POSTs to the right endpoint, reject POSTs with `decisionNote`, no NATS in source, no attendance/payroll/leave mentions in source, no new env vars, no new top-level redux slice, etc.

### D.3 Regression scope (post-implementation)

- 37.1/37.2/37.3/37.4 backend presence tests: 185/185 still green.
- 31.4 work-mode tests: still green.
- Frontend 305+ source-pin tests: still green.
- Lint: `npx eslint Backend/src/services/presence/workLocationRequest* Backend/src/controllers/presence/workLocationRequest* Backend/src/routes/presence/workLocationRequest* Backend/src/validators/presence/workLocationRequest* Backend/src/models/WorkLocationRequest.js` returns 0.
- Frontend build: `npm run build` succeeds.

---

## E. Env / Deps

- **NO** new env vars in `Backend/.env`, `Backend/.env.example`, `Frontend/.env`, `Frontend/.env.example`.
- **NO** new packages in `Backend/package.json` or `Frontend/package.json`.
- **NO** BullMQ.
- **NO** NATS / JetStream.
- The Phase 32.11 `realtimeGateway` Redis pub/sub on `crewly:<env>:realtime:events` is the only transport, and only its `publish({type, companyId, userId, payload})` surface is touched.
- The 37.4 `presenceBus` is reused; we add one internal helper `invalidateForUser` to it (no new event type registration; the envelope is `type: 'presence:invalidated'` with a frozen shape).
- The Phase 36 `notifySmart` and `recordAudit` are reused.
- The Phase 31.4 `resolveScopeIds` from `utils/orgHelpers.js` is reused.

---

**END OF PLAN.** No second plan. Implementation begins now. Final line of the
final report will be: "Phase 37.5 awaiting localhost acceptance."
