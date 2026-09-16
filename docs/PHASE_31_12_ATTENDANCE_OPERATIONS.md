# Phase 31.12 — HR Attendance Operations Dashboard

## Purpose

The operational command center HR uses to understand TODAY'S workforce
attendance and immediately identify issues requiring action: expected
workforce, live attendance, work-mode / department / shift / location
breakdowns, the needs-attention queue, and the pending regularization
and OT review workload.

## Difference from 31.9 / 31.10 / 31.11

- 31.9 (Who's Working) is the manager/team live presence board under
  `ATTENDANCE_READ`. 31.12 CALLS 31.9's `getTeamPresence` and aggregates
  its rows — it never re-derives presence — but is HR-only
  (`ATTENDANCE_OPERATIONS_READ`), company-scoped, and adds KPIs,
  employment applicability, attention severity, groupings and workflow
  workload.
- 31.10 is the historical calendar/timesheet record. 31.12 reuses its
  `employeeTimesheet` API + `TimesheetMonthView` for the drill-down
  drawer only.
- 31.11 owns the month lifecycle and payroll sync. 31.12 reuses its
  `BLOCKER`/`WARNING` severity vocabulary and `ISSUE_WORKFLOW` routing,
  but a BLOCKER here means "would block month-end finalization if still
  open then", never "payroll is blocked".

## KPI definitions (four orthogonal dimensions — never summed)

- Presence (mutually exclusive, applicable rows): Working, On Break,
  Completed, Not Yet In, Late-Not-In, On Leave, Holiday, Weekly Off,
  Unresolved.
- Work mode (working rows only): Office, WFH, Field, Client Site,
  Business Travel.
- Calendar: On Leave, Holiday, Weekly Off (= non-working).
- Attention (overlapping flags): blockers / warnings / info + people
  count. Top cards: Expected Today, Working Now, On Leave, Not Yet In,
  Needs Attention.

## Expected-workforce rules

Applicable = ACTIVE user in authorized scope with no future
`dateOfJoining` and no approved resignation whose `lastWorkingDate`
is before the business date. Expected = applicable minus
ON_LEAVE/HOLIDAY/WEEKLY_OFF presences. Pre-joiners and exited staff
count under `nonApplicable`, never as absent.

## Attention categories / severity

LATE_NOT_IN, LATE_ARRIVAL, EARLY_EXIT, SHORT_HOURS (completed below
scheduled−60m, resolved schedule only), REG_PENDING, OT_PENDING →
WARNING. MISSING_PUNCH, UNRESOLVED_SESSION, INCOMPLETE_BREAK
(stale-open break), RECON_CONFLICT (attendance on approved leave) →
BLOCKER. Plain needs-review reconciliation and worked-day-off →
WARNING / INFO. Every item links to its owner workflow; the
dashboard mutates nothing.

## Manager / HR scope

Route requires `ATTENDANCE_OPERATIONS_READ` (HR Manager + Company
Admin; managers/team leads/employees excluded). Scope reuses 31.9
exactly: HR/Admin see the company; any other permission holder
would see only their org-subtree team view. Filters (incl.
`managerId`) narrow inside scope and can never expand it.

## Batching / query strategy

One `getTeamPresence` call (~14 bounded queries) + four bounded
`$in` reads (employment fields, approved exits, pending
regularizations, pending OT) + two timezone reads only when
`?date=yesterday`. ~18 queries for any headcount; filtering,
grouping and pagination happen in memory over derived rows. No N+1
(asserted by test), no aggregation pipelines, no queues.

## Refresh / cache strategy

No Redis (31.9 precedent; reads are cheap and bounded). Client:
initial load + manual + 45s poll while visible + refocus refetch;
hidden tabs never poll. Reads write no audit logs.

## Privacy

Inherits the 31.9 safe serializer (configured office name only —
never coordinates, distance, accuracy, or home location) plus time
facts (clock times, late/early minutes) and pending counts. No
reasons, no leave attachments, no salary/bank/PAN/UAN. Asserted by
test over the full JSON response.

## APIs

`GET /attendance/operations` (perm `ATTENDANCE_OPERATIONS_READ`).
Allowlisted query: `date` (today|yesterday only), `search`,
`departmentId`, `managerId`, `shift`, `location`, `presence`,
`workMode`, `category`, `page`, `pageSize` (≤100). Response:
`{ date, timezone, refreshedAt, scope, summary, modes,
attentionCounts, departments, shifts, locations, workflows,
attention{items,page,pageSize,total,totalPages} }`.

## UI

Route `/app/attendance/operations` (HR role-guard + permission nav
item under Time & Leave). Header with Today/Yesterday + refresh;
5 KPI cards; work-mode chips + workflow workload links; department
/ shift / location grouping tabs; filter bar; paginated attention
queue with severity pills and workflow links; per-employee drawer
(reuses 31.10 month view). CSS bars/tables only, no chart library.

## Tests

`test/attendanceOperations.test.js` (33 hermetic): pure-rules
matrix (applicability, all 11 categories + severity, summary
reconciliation, groupings, filters, pagination, serializer) and
service/security (real 31.9 derivation over fake Mongo: full-day
aggregation, tenancy ×4 surfaces, manager subtree, yesterday
review, privacy tokens, ≤20-query budget, route/permission
hygiene). Regressions: all 31.x suites + Leave/Shift/RBAC/29.5,
`npm run test:all`, frontend `npm run build`.

## Limitations

- No manager-picker UI (API-ready `managerId` filter only).
- Location groups count office check-ins (users carry no home
  location, so per-location "expected" would be fabricated).
- UNRESOLVED-schedule rows are KPI-only, excluded from attention.
- SHORT_HOURS −60m tolerance is a documented ops heuristic.
- Yesterday review evaluates lateness at 23:59 end of day.

## No productivity scoring

No scores, rankings, top/worst lists, or activity tracking of any
kind. No mouse/keyboard/heartbeat surveillance. No automated
reminders (31.13), kiosk/QR/biometric/import (31.14), or trend
analytics (31.15).
