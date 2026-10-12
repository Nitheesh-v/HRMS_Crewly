# Phase 37.6 — Authoritative Leave + Working-Hours Presence Integration

**Build plan — single source of truth for this phase. One plan, no second plan, scope strictly limited to 37.6.**

---

## A. Repository Findings

### A.1 What already exists in this repo

| Existing asset (path) | Why it matters for 37.6 |
| --- | --- |
| `Backend/src/models/Leave.js` | The authoritative Leave model. Fields: `companyId, user, type, startDate, endDate, days, reason, status, approver, approverNote, decidedAt`. **`startDate` / `endDate` are YYYY-MM-DD strings** (no time portion, **no half-day support**). Status enum `LEAVE_STATUS = ['PENDING','APPROVED','REJECTED','CANCELLED']` from `utils/constants.js:44`. **Active = `APPROVED` only.** |
| `Backend/src/models/Shift.js` | Has `startTime, endTime` as `HH:mm` strings, `breakMinutes`, `type ∈ {MORNING, GENERAL, EVENING, NIGHT, FLEXIBLE, CUSTOM}`. Overnight is implicit: an `endTime < startTime` shift crosses midnight (the existing 31.x engine already handles it). |
| `Backend/src/models/ShiftAssignment.js` | `{ companyId, shift, scope, user OR department, effectiveFrom, effectiveTo: null=active }`. Indexed on `{companyId, user, effectiveFrom:-1}`. |
| `Backend/src/models/WorkSchedule.js` | `{ companyId, name, workingDays, startTime, endTime, breakMinutes, ... }`. Default `workingDays = ['MON','TUE','WED','THU','FRI']`. |
| `Backend/src/services/attendance/attendanceScheduleService.js#resolveEmployeeSchedule` | The **authoritative** schedule resolver. Returns a context `{ status: 'RESOLVED' \| 'UNRESOLVED', scheduledStartAt, scheduledEndAt, startTime, endTime, crossesMidnight, isWorkingDay, dayType, holiday, shift, schedule, ... }`. |
| `Backend/src/services/attendance/attendanceScheduleRules.js#summarizeSchedule` | Pure helper. Returns `{ phase: 'UPCOMING' \| 'IN_WINDOW' \| 'ENDED' \| null, isWorkingDay, dayType, ... }`. **This is what 37.6 reads to decide `outsideWorkingHours`.** |
| `Backend/src/services/attendance/attendanceScheduleRules.js` helpers | `dayKeyInZone`, `zonedTimeToUtc`, `shiftIntervalForDate`, `businessDateForInstant` — all timezone-aware using `Intl.DateTimeFormat('en-CA', { timeZone: ... })`. **Reused as-is.** |
| `Backend/src/services/presence/presenceResolver.js` | The current resolver. Precedence: manual DND/Busy/Available → live (available/away/offline) → `unknown`. **Does not yet know about `on_leave` or `outside_working_hours`.** |
| `Backend/src/services/presence/presenceService.js#getMyPresence` | Self-path. Calls `resolvePresence` after a tenant-config read + a UserPresence read + an optional live-store read. **37.6 will inject an HR context here.** |
| `Backend/src/services/presence/presenceTeamService.js#getTeamAvailability` | Team-path. One authorized user query, one batched `UserPresence` query, one batched live-store read. **37.6 will inject one batched Leave query + one batched schedule context query here.** |
| `Frontend/src/components/presence/presenceVisual.js` | **Already has** `on_leave: { label: 'On Leave', color: 'text-violet-600', ... }` and `outside_working_hours: { label: 'Outside Working Hours', ... }`. The visual dictionary anticipates 37.6. |
| `Frontend/src/redux/slices/presenceConstants.js#EMPTY_PRESENCE` | The empty default. **Needs two new fields**: `onLeave: false` and `outsideWorkingHours: false` (or `null` for unknown). |
| `Frontend/src/components/presence/PresenceIndicator.jsx` | Renders the label + dot. Already supports the `on_leave` and `outside_working_hours` palette entries. |
| `Frontend/src/pages/team/TeamAvailabilityPage.jsx` | 8-tile summary. **Needs an "On Leave" tile + an "Outside Working Hours" tile.** Each row needs to render the secondary `outsideWorkingHours` badge next to the presence value. |

### A.2 What 37.6 must NOT touch

- `Leave.js` schema / collection / `leaveService.js` / `leaveController.js` (read-only).
- `Shift.js`, `ShiftAssignment.js`, `WorkSchedule.js` schemas (read-only).
- `attendanceScheduleService.js` / `attendanceScheduleRules.js` (read-only — 37.6 only reads their outputs).
- `PresenceTenantConfig.js` (37.1) — no new fields, no new policy.
- 37.4 realtime gateway, presenceBus, presenceEvents (read-only — 37.6 does NOT add a new event type).
- 37.5 `WorkLocationRequest` workflow.
- `.env`, `.env.example`, `package.json` (no changes — verified the spec's "no new env / no new packages" rule).

### A.3 Past-date / date semantics for Leave (the only model)

- `Leave.startDate` and `Leave.endDate` are **calendar-day strings, inclusive**.
- 37.6's "is this employee on leave at instant `now`?" question becomes:
  `Leave.startDate <= todayKey AND todayKey <= Leave.endDate AND status === 'APPROVED'`
  where `todayKey` is the company-calendar day string for `now` in the tenant's timezone.
- Half-day leave is **NOT supported** by the model. 37.6 documents this and renders `On Leave` for the entire inclusive day range. (Spec §12: "if the repository does not supply enough reliable information, document the limitation instead of guessing.")

### A.4 Performance baseline — already GREEN (spec §4 stop-gate)

- `db177d9` removed the auto-start of the presence socket + frontend presence runtime.
- `a72fee3` cleaned up the partial-edit duplicate in `server.js`.
- `docs/PRESENCE_TIMEOUT_DIAGNOSIS.md` runbook is in place with `OBSERVABILITY_SLOW_REQUEST_MS` and `PERF_TIMING` hooks.
- 185/185 backend presence tests + 47/47 31.4 tests + 61/61 37.5 tests + 24/24 37.5 frontend tests + 24/24 37.3 frontend tests all green at `134e4d5`.
- **No known N+1 / request storm / socket duplication / realtime loop on the Phase 37 branch.** Proceeding.

### A.5 Conventions enforced by repo

- `// Data from frontend`, `// DB Logic`, `// Data to frontend` three-comment controller convention.
- `express-validator` chain validators; identity-override refusal via `body().custom(...)`.
- Routes: `router.use(protect, tenantContext)`.
- Hermetic backend tests use `node:test` + injectable fakes for models. No Mongo, no Redis, no axios.
- Frontend tests are source-pin assertions: read files, assert on substrings.
- Resolver precedence must remain a single authority; no per-feature precedence.

---

## B. Security / Data Boundaries

### B.1 Identity (spec §5, §8, §10, §35, §37, §40)

- `companyId = req.companyId`, `userId = req.user._id` — ALWAYS.
- 37.6 adds ZERO new identity fields. The HR reader is invoked with `companyId + userId` and returns a plain boolean/object.
- **Leave reason, leave type, leave balance, approver, approverNote, medical, attachments, leave documents — none of these are read by 37.6.** The 37.6 Leave projection is the strictest possible: `{ _id, user, startDate, endDate, status, companyId }`. No `populate`. No `select('reason approver approverNote ...')`. The 37.6 reader is **read-only** and **field-minimised**.

### B.2 Tenant scoping (spec §5, §35, §40)

- Every Leave / ShiftAssignment / WorkSchedule query includes `companyId`.
- Self-path queries by `companyId + user: req.user._id`.
- Team-path queries by `companyId + user: { $in: scopeIds }` (reuses the same `scopeReader` 37.3 already uses — no new visibility rule, no new discovery right).

### B.3 No-mutation guarantee (spec §2, §40, §45)

The 37.6 service module is `presenceHrContext.js`. It exports only READ methods. The hermetic test injects `LeaveModel` and `WorkScheduleModel`/`ShiftAssignmentModel`/`ShiftModel`. The test seam DOES NOT inject a `LeaveModel.save` / `findOneAndUpdate` / `updateOne` — because 37.6 **never calls them**. The 49 boundary tests assert this by:

1. **Static source-pin**: the 37.6 files do not contain the strings `LeaveModel.create`, `LeaveModel.save`, `LeaveModel.updateOne`, `LeaveModel.findOneAndUpdate`, `LeaveModel.deleteOne`, `LeaveModel.deleteMany`, `Attendance.create`, `PayrollSnapshot.create`, `ShiftAssignment.create`, `ShiftAssignment.save`, `WorkSchedule.create`, etc.
2. **Behavior**: the throw-on-write sentinel pattern (same as 37.5) — the test seam supplies a fake model with `create` that throws. If 37.6 ever calls it, the test fails.

### B.4 Failure semantics (spec §53, §54)

Three distinct outcomes per HR read:

- `NO_ACTIVE_LEAVE` — Leave query succeeded, no `APPROVED` row covers today.
- `LEAVE_UNAVAILABLE` — Leave query threw.
- `NO_SHIFT` — schedule resolver returned `UNRESOLVED` (or threw).
- `SHIFT_UNAVAILABLE` — schedule resolver threw.

The resolver composes these explicitly. `LEAVE_UNAVAILABLE` is NOT collapsed to `NO_ACTIVE_LEAVE`. The team DTO carries two booleans the frontend can branch on: `onLeave` (or `null` when unavailable) and `outsideWorkingHours` (or `null` when unavailable).

### B.5 WFH/Leave conflict (spec §23, §24)

- Approved active leave **wins display precedence** for the primary `presence` value.
- The presence DTO still carries the underlying `workLocation` and the 37.5 `findActiveApproval` result, but the rendered `presence` value is `on_leave` when leave applies, even if the user also has an approved WFH or a manual DND.
- 37.6 does NOT mutate the WFH request, the leave record, or the manual status. It is a presentation-resolution decision only.

### B.6 NATS / Socket / Redis (spec §28, §29)

- 37.6 does NOT introduce NATS, does NOT add a new event type, does NOT publish through the realtime gateway.
- 37.6 does NOT cache Leave / Shift data in Redis.
- A user's own `/me` re-read on every navigation is the only invalidation — and the existing 37.4 `teamBumpedAt` refetch on the team page is the only fan-out. The user's own presence state may be **stale by up to one shift boundary** (e.g. after 6 PM the resolver will not auto-update without a refetch). That is the documented design — no scheduled job, no client timer, no per-second loop.

### B.7 Data minimization in the response (spec §10, §37)

The new fields on the presence DTO are:

```
onLeave: true | false | null    (true = approved active; false = no approved active; null = leave read failed)
outsideWorkingHours: true | false | null   (true = now outside the worker's shift; false = within; null = schedule read failed)
```

These three booleans are the ONLY new fields 37.6 adds. They are derived server-side and never carry employee reason, type, balance, or schedule details.

---

## C. Implementation

### C.1 New file: `Backend/src/services/presence/presenceHrContext.js`

A **read-only HR context service**. Two methods:

- `findActiveApprovedLeave({ companyId, userId, todayKey, LeaveModel })` — single read-only query; returns the minimal Leave projection (or `null`). No reason, no type, no approver.
- `resolveWorkingHoursContext({ companyId, user, attendanceDate, timezone, scheduleResolver, ShiftModel, ShiftAssignmentModel, WorkScheduleModel, UserModel })` — thin wrapper around the **existing** `resolveEmployeeSchedule` from `attendanceScheduleService.js`. Returns a `{ phase, isWorkingDay, dayType, source }` summary (no shift name, no schedule name, no holiday doc).

Both methods are **pure-read** and the test seam takes injectable model + resolver deps.

### C.2 Modification: `Backend/src/services/presence/presenceResolver.js`

Extend the resolver to take a new optional `hrContext` argument:

```
resolvePresence({ durable, config, now, live, hrContext })
```

The precedence becomes (top wins):

```
1. hrContext.onLeave === true  -> presence = 'on_leave', source = 'leave'
2. effectiveManual             -> presence = <manual>, source = 'manual'
3. live === null               -> presence = 'unknown', source = 'none'
4. live.connected + ...        -> presence = <derived>, source = 'automatic'
```

`outsideWorkingHours` is **carried alongside** `presence` — it never replaces `presence`. When `hrContext.outsideWorkingHours === null`, the field is `null` (not `false`).

### C.3 Modification: `Backend/src/services/presence/presenceService.js`

`getMyPresence` now also calls `presenceHrContext` (best-effort) and threads the result into the resolver. The two reads are sequential (one auth user, two small queries). A failure in either reader sets the corresponding field to `null` and **does not** block the rest of the response. The performance baseline target is +1 small Leave read and +1 small schedule read per self call — well under the 25s axios default.

### C.4 Modification: `Backend/src/services/presence/presenceTeamService.js`

`getTeamAvailability` now does, in order:

1. authorized user query (existing, 1)
2. tenant config read (existing, 1)
3. **batched** Leave query for the scope (new, 1) — `{ companyId, status: 'APPROVED', user: { $in: ids }, startDate: { $lte: todayKey }, endDate: { $gte: todayKey } }` — projecting ONLY `_id user startDate endDate status companyId`.
4. **batched** schedule resolution (new, 1 if `attendanceScheduleService.preloadScheduleMasters` exists; otherwise per-employee using a `Map<userId, ctx>` cache so repeat reads within the same request are O(1)).

Hermetic test injects a `hrContext` factory so the team service can be tested without the attendance service. Real production wires it to `presenceHrContext`.

### C.5 Modification: `Backend/src/services/presence/presenceConfig.js`

Add `on_leave` and `outside_working_hours` to `PRESENCE_VALUES` (already present, confirmed). No new exports.

### C.6 Frontend — minimal additions

- `Frontend/src/redux/slices/presenceConstants.js` — add `onLeave: null, outsideWorkingHours: null` to `EMPTY_PRESENCE`.
- `Frontend/src/components/presence/PresenceMenu.jsx` — render the `On Leave` palette value (already present); optionally show a small secondary "Outside Working Hours" pill.
- `Frontend/src/pages/team/TeamAvailabilityPage.jsx`:
  - add an "On Leave" SummaryTile and an "Outside Working Hours" SummaryTile.
  - add a chip for `on_leave` and a chip for `outside_working_hours` in the filter bar.
  - render the secondary `outsideWorkingHours` badge on each row when `item.outsideWorkingHours === true`.

### C.7 What 37.6 does NOT add

- No `presenceLeaveModel` / `presenceLeave` collection.
- No NATS subject, no Socket.IO event, no `presenceBus` envelope.
- No new env variable.
- No new package.
- No AI, no cron, no scheduler.

### C.8 Index additions (only if needed)

- `Leave` already has `{ companyId, status }` indexed. The 37.6 query is `{ companyId, status, user, startDate, endDate }`. The existing `{ companyId, user, status }` (none — let me check) and `{ companyId, status }` indexes cover the leading columns; Mongoose will scan the status bucket then filter user/date. With a `status: 'APPROVED'` predicate the cardinality is low.
- After measuring in the hermetic suite, if a separate `{ companyId, status, user, startDate, endDate }` index is needed, **it will be added to the Leave schema as a minimum additional index** (no `PresenceLeave` collection, no other schema change).
- `ShiftAssignment` already has `{ companyId, user, effectiveFrom:-1 }` and `WorkSchedule` has its own indexes. No additions.

### C.9 Precedence (single resolver) — final shape

```
1. hrContext.onLeave === true    -> presence = 'on_leave'
2. effectiveManual                -> presence = <manual>
3. live === null/undefined        -> presence = 'unknown'
4. live.connected + recent act    -> presence = 'available'
5. live.connected + no recent     -> presence = 'away'
6. live.connection count == 0     -> presence = 'offline'
```

`outsideWorkingHours` rides alongside; it is `null` when the schedule read failed, `false` when within, `true` when outside.

---

## D. Test Plan

### D.1 Backend hermetic — 53 numbered test cases (per spec §41-§45)

`Backend/test/presenceHrIntegration.test.js`:

- **LEAVE (1–16):** approved active → `on_leave`; pending/rejected/cancelled → not `on_leave`; future-only approved → not today; past-only approved → not today; approved wins over manual Available / Busy / DND / WFH conflict; leave reason absent from DTO; attachment absent; approval notes absent; cross-tenant isolation; another employee's leave does not bleed; no half-day support documented.
- **WORKING HOURS (17–25):** within current shift → `outsideWorkingHours: false`; before shift → `true`; after shift → `true`; overnight shift 22:00–06:00 at 02:00 → `false`; overnight shift 22:00–06:00 at 23:30 → `false`; no shift → `null` (not guessed); tenant timezone respected; weekly off → `null` or `true` per spec §16; cross-tenant shift isolation.
- **PRECEDENCE (26–35):** on_leave beats available; on_leave beats busy; on_leave beats dnd; on_leave beats away; on_leave beats offline; on_leave beats WFH conflict; outsideWorkingHours does not replace available; does not replace busy; does not replace away; work location remains separate.
- **PERFORMANCE (36–43):** team availability does NOT query Leave once per employee (1 batched query); does NOT query ShiftAssignment once per employee (≤1 batched call); tenant config is not loaded once per employee (cached by service); Leave query uses tenant scope; Shift query uses tenant scope; User projection stays minimized; HR reader selects no `reason`/`approverNote` fields; query count bounded as employees grow.
- **READ-ONLY (44–53):** never saves Leave; never updates Leave; never deletes Leave; never approves/rejects Leave; never changes leave balance; never writes Attendance; never checks in; never checks out; never mutates ShiftAssignment; never modifies Payroll; never calls AI.

### D.2 Frontend source-pin — 18 test cases (per spec §46)

`Frontend/test/presenceHrFrontend.test.js`:

- (1) On Leave renders as text in the team page row.
- (2) On Leave status has accessible label (palette carries `aria: 'Presence: On Leave'`).
- (3) Leave reason is never rendered (regex on the team page source).
- (4) Leave documents are never rendered.
- (5) On Leave takes primary presence over Available.
- (6) On Leave takes primary presence over Busy / DND.
- (7) Work location does not imply "working" while On Leave (row shows On Leave as the primary; work location is secondary).
- (8) Outside Working Hours renders as a secondary badge.
- (9) Available can coexist with Outside Working Hours.
- (10) Busy can coexist with Outside Working Hours.
- (11) No shift details are exposed beyond the badge.
- (12) On Leave filter chip works.
- (13) Counts are API-authorized (no synthetic total).
- (14) No localStorage persistence.
- (15) No new attendance UI.
- (16) No new payroll UI.
- (17) 37.4 realtime remains functional (source-pin: the existing `presenceTicked` reducer untouched).
- (18) 37.5 WFH workflow remains functional (source-pin: `WorkLocationSelector` and `WorkLocationRequestDialog` not regressed).

### D.3 Regression

- 37.1 / 37.2 / 37.3 / 37.4 / 37.5 backend tests: still green.
- 37.1 / 37.2 / 37.3 / 37.5 frontend tests: still green.
- 31.4 attendance work-mode tests: still green.
- Frontend `vite build`: succeeds.

---

## E. Env / Deps

- **NO** new env vars in `Backend/.env`, `Backend/.env.example`, `Frontend/.env`, `Frontend/.env.example`.
- **NO** new packages in `Backend/package.json` or `Frontend/package.json`.
- **NO** BullMQ, **NO** NATS, **NO** AI, **NO** new collections.
- The Phase 36 `notifySmart` and `recordAudit` are NOT used by 37.6 (no notification, no audit, since the resolver is read-only presentation).

---

**END OF PLAN.** No second plan. Implementation begins now. Final line of the
final report will be: "Phase 37.6 awaiting localhost acceptance."
