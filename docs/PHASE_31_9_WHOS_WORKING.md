# Phase 31.9 — Teams-Style "Who's Working" & Live Team Attendance

Live attendance-presence board for managers, team leads and HR. It
answers "who is working now?" from punch facts, schedules, leave and
holidays — the same authorities every Phase 31 surface reads.

**Crewly does not infer employee productivity or computer activity
from attendance presence.** `WORKING` means an attendance session is
open; `ON_BREAK` means a break event is active; `COMPLETED` means the
session closed validly. No keyboard/mouse/browser/app signals exist
anywhere in this feature, and none were added.

## 1. Product purpose

One page, `/app/attendance/team` ("Who's Working"): KPI cards, mode
breakdown, search + filters, employee presence cards with expandable
day details, pagination, and bounded live refresh. It complements —
not duplicates — the static daily register (`/app/attendance/report`
→ "Today" tab, `GET /attendance/company`), which stays untouched:

| Surface | Answers | Nature |
|---|---|---|
| Report → Today tab | who punched in/out, when | static register, any date |
| Who's Working | who is working / on break / late / off **now** | live board, today only |

## 2. Presence derivation (single deterministic layer)

`Backend/src/services/attendance/attendancePresenceRules.js` is the
only place display presence is computed. Pure: no Mongo, no clock
reads (authoritative `now` is passed in), UTC instant comparison.

**Never mutated:** the 31.2 `LIVE_STATE` vocabulary. Every row carries
both `liveState` (underlying fact) and `presence` (display layer).

### Precedence (§7)

1. Open session → `WORKING` / `ON_BREAK` (calendar context kept).
2. Completed session → `COMPLETED` (calendar context kept).
3. Approved leave, no session → `ON_LEAVE`.
4. Holiday, no session → `HOLIDAY`.
5. Weekly off, no session → `WEEKLY_OFF`.
6. Unresolvable schedule → `UNRESOLVED` (neutral, never invented).
7. Before scheduled start (+ grace) → `NOT_IN`.
8. Beyond start + grace, no clock-in → `LATE_NOT_IN`.

Work on leave/holiday/weekly-off shows the working state **plus** the
calendar badge **plus** the conflict flag — 31.7 conflicts are never
hidden. A stored 31.7 calendar projection wins over live contexts
(frozen meaning); rows without one derive from batched facts.

### Late / not-in semantics

Late = `now` strictly beyond `scheduledStartAt +
policy.grace.lateInMinutes` (31.6-verdict parity; `0` when no policy).
Exactly at the gate is not late. Unresolved schedules can never be
late — no fake `09:00–18:00` is ever assumed, and nobody is labelled
absent by the live board (absence stays a reconciliation outcome).

### Overnight handling (§9)

Per-user business date via yesterday's resolved crossing-midnight
interval + `businessDateForInstant` (same rule as `getLiveAttendance`).
At 01:00 a night-shift worker with an open session dated yesterday
shows `WORKING` on that business date with the `22:00–06:00 (+1 day)`
window — the board never queries only the calendar date. Controls are
loaded for `{yesterday, today}` plus any older open session.

### Forgotten clock-outs

An open session older than yesterday surfaces as `WORKING` (matching
`getLiveAttendance` session semantics) **flagged**
`STALE_OPEN_SESSION`, with the row attributed to today. A completed
today + older open session shows `COMPLETED` + the same flag.

### Effective facts

Approved 31.5 corrections win for clock-in/out and work mode (same
rule the report page displays). Pending/rejected corrections change
nothing; a pending request raises `REGULARIZATION_PENDING` (no text).

## 3. Work modes, locations, leave

- Mode (`OFFICE / WFH / FIELD / CLIENT_SITE / BUSINESS_TRAVEL`) is
  orthogonal to presence: `WORKING + WFH`, `ON_BREAK + FIELD`, etc.
- `OFFICE` rows may show the **verified office name** from the day's
  `CLOCK_IN` event (`locationVerification.locationName`) — name only,
  only while the final mode is `OFFICE`. No coordinates, no
  distance/accuracy, no maps, no home locations, ever.
- `ON_LEAVE` shows the leave **type label** only (existing 31.7
  convention for this audience). No reasons, no documents.
- 31.8 state is flags only: `ot.pending / ot.approved /
  ot.compOffApproved`. No minutes, no reasons, no money.

## 4. Exception flags (display codes, never free text)

`LATE_ARRIVAL` (control `lateMinutes > 0`), `EARLY_EXIT` (completed +
`earlyMinutes > 0`), `MISSING_PUNCH` (open session, no clock-in at
all), `REGULARIZATION_PENDING`, `ATTENDANCE_ON_LEAVE` (stored 31.7
conflict, or open/completed session on a leave day without a stored
projection), `STALE_OPEN_SESSION`. The KPI "Need attention" counts
rows with ≥ 1 flag.

## 5. Org scope & RBAC

- Permission: existing **`ATTENDANCE_READ`** (route-level
  `requirePermission` + `RequireRole SENIORS` on the page, mirroring
  the report). **No new permission; `SYSTEM_PERMISSION_VERSION` stays
  31.**
- Scope (backend-derived from `req.user` + `req.companyId`, reusing
  `getSubtreeIds` and the `/company` company-vs-subtree rule, plus
  the actor themself): `COMPANY_ADMIN` / `HR_MANAGER` → whole company;
  everyone else → self + org subtree. Deferred HR roles untouched.
- Plain employees hold no `ATTENDANCE_READ`: no board for them (safe
  default, consistent with `/company`); self live view stays
  `/attendance/today/live`. The page also gates internally and shows
  a safe no-access card.
- Filter IDs are validated (`departmentId` must be a well-formed id
  in this tenant's query path) and can only **narrow** the authorized
  scope — foreign ids yield empty, never leak. No `companyId` is ever
  accepted from the client.

## 6. Query / batching strategy (zero N+1)

`attendancePresenceService.getTeamPresence` (injectable, thin
controller): scope ids → users (search/department narrow Mongo-side)
→ **one** batch each for policy, company timezone, controls,
`CLOCK_IN` events, schedule masters (assignments / shifts / schedules
/ holidays via `preloadScheduleMasters`), approved leaves, pending
regularizations, live OT requests, departments → in-memory 31.6-parity
schedule resolution (`resolveEmployeeScheduleFromMasters`, stored
snapshot wins) + holiday scope matching + pure derivation O(N) →
derived-side presence/mode filter → `summarizePresence` counts →
stable (`name, _id`) pagination (default 25, max 100).

≈ 14 bounded, indexed, tenant-scoped queries for **any** team size —
proven by a test asserting identical call counts at 3 and 9 users.
Batch-vs-single schedule parity (all tiers, fallthroughs, holiday
scope/optional-picked/recurring) is locked by hermetic tests.

KPIs reflect the **same filtered set** as the list (pre-pagination):
clear the filters for scope totals. Status buckets are mutually
exclusive; `modes` breaks down `WORKING + ON_BREAK` rows only and
must not be summed with statuses (§26).

## 7. Refresh, cache, jobs

- No Redis, no BullMQ, no WebSocket, no new dependency. Mongo is
  authoritative on every request.
- Client polls every **45s while the tab is visible**, refreshes on
  refocus, pauses while hidden, plus manual refresh. No per-second
  polling. Durations tick client-side from server timestamps.
- Reads create **no audit rows** and send no notifications.

## 8. API

`GET /api/attendance/presence` — one scoped endpoint (no
per-audience variants).

Allowlisted query: `search` (≤ 60 chars, escaped regex over name /
employee code / designation), `departmentId`, `presence` (repeatable,
9 states), `workMode` (repeatable, 5 modes + `NONE`), `page`,
`pageSize`. Anything else is refused with 400. `GET` never mutates
(fakes throw on any write call).

Response: `{ date, timezone, now, scope: { type, total }, counts:
{ total, working, onBreak, completed, notIn, lateNotIn, onLeave,
holiday, weeklyOff, unresolved, exceptions, modes }, rows: [...],
page, pageSize, total, totalPages }`.

Safe serializer allowlist per row: id, name, employee code, avatar,
designation, department id+name; presence, liveState, business date,
work mode, office name; clock in/out, break start, worked/break
minutes; schedule window + names; late facts; calendar
(primary/holiday/leave label); exception codes; needsReview,
regularized; OT flags. Explicitly excluded: email, phone, address,
bank/PAN/UAN, credentials, coordinates, distance/accuracy, leave and
request reasons/proposals/documents, OT minutes, salary/payroll.

## 9. UI

`AttendanceTeamPage.jsx`: title + live indicator + "updated X ago" +
refresh; 7 KPI cards + working-from chips; search/department/status/
mode/page-size filters; responsive presence cards (avatar, badges,
shift, times, ticking durations, office name, exception + OT chips,
expandable day details: shift window, clocks, worked/break, day
context, flags, business date); pagination; loading skeletons; safe
empty/error/denied states; closing non-surveillance footnote. Dark
tokens (`.card .input .label .btn-ghost .badge`), Lucide icons, no
emojis, no `dangerouslySetInnerHTML`. Sidebar: "Who's Working" under
Time & Leave, `ATTENDANCE_READ`-gated.

## 10. Tests

`Backend/test/attendancePresence.test.js` (60 hermetic tests):
rules matrix, precedence, stored-calendar priority, effective-facts
priority, legacy live-state parity, exception flags, count bucketing,
filter matchers; service derivation (working/break/completed,
not-in/late, unresolved, leave/holiday/weekly-off incl. weekend
parity, work-on-holiday, overnight work/break, stale sessions,
regularization + OT flags, snapshot priority, timezone precedence);
scope (manager/HR/employee), tenancy (rows + counts + foreign
filters), filters, search escaping, pagination stability/clamping,
empty scope, context refusal; serialized-JSON privacy sweep; exact
bounded call counts at two team sizes; zero-write proof; source
hygiene (no payroll/mongoose/network in 31.9 code, controller house
comments, route + permission registration); batch-vs-single schedule
parity; holiday scope parity. Registered in `test:all`.

## 11. Limitations

- Live board only: no historical `date` param (the report owns
  history); no `locationId`/`shiftId` filters (presence/mode/
  department/search cover the board's needs).
- KPIs follow the active filters (documented in §6), not fixed
  scope totals.
- Schedule batching mirrors the 31.6 **service** precedence (the
  attendance authority); the legacy engine's `scope`-filtered
  variant differs slightly by pre-existing design.
- Two holidays colliding on one day resolve to the first by
  (date, _id) — deterministic, documented, vanishingly rare.
- `/company`'s per-user `expectedOnDate`/`bestEffortRowDay` N+1 is
  pre-existing and out of fence; the presence endpoint is the
  batched path.
- 31.10+ (timesheets, finalization, ops dashboard, reminders,
  kiosk, analytics, hardening): not started, nothing scaffolded.
