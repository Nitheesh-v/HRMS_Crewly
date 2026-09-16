# Phase 31.10 — Attendance Calendar & Timesheets

Read-only monthly timesheets: the employee calendar (My Timesheet),
the scoped team summary table with drill-down (Team Timesheets), and
the scoped CSV export. No timesheet writes exist anywhere in this
phase — the only write is the best-effort export-audit row.

Predecessors (all reused, none modified): 31.1 policy/outcome
vocabulary, 31.2 event ledger + business-date anchoring, 31.3
verified-name-only privacy, 31.4 work modes, 31.5 approved-overlay
corrections, 31.6 dated schedule resolution + snapshots, 31.7 daily
reconciliation projections, 31.8 approved-only OT minutes, 31.9
org-scope/subtree derivation + batched patterns.

## Endpoints (all under `/api/attendance`, tenant from `req.companyId`)

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/timesheets/mine?month=YYYY-MM` | `ATTENDANCE_READ_SELF` or `ATTENDANCE_READ` | Own month (identity from `req.user`; no employeeId accepted) |
| GET | `/timesheets/team?month=&search=&departmentId=&hasExceptions=&page=&pageSize=` | `ATTENDANCE_READ` | Scoped summary table (default page 10, max 50) |
| GET | `/timesheets/employee/:id?month=` | `ATTENDANCE_READ` | Scoped drill-down month (403 outside scope) |
| GET | `/timesheets/export?month=&search=&departmentId=&hasExceptions=` | `ATTENDANCE_READ` | Scoped CSV download (page ignored; whole filtered scope) |

No new permission, no RBAC bump (stays v31). Scope: COMPANY_ADMIN /
HR_MANAGER see the company; everyone else sees their org subtree +
self (31.9 `getSubtreeIds` precedent, backend-derived).

## Daily truth precedence (per user × business date)

1. Stored 31.7 `reconciliation` WITH `resolvedAt` wins: outcome,
   calendar, leave, halves, fractions, conflicts are frozen meaning.
2. Minutes ALWAYS come from the live control facts, so a stored
   projection can never disagree with corrected punches.
3. Otherwise pure in-memory live resolution: `attendanceFactsFromControl`
   + `resolveDailyAttendance` over (stored schedule snapshot → batch
   masters ctx), batch leave (APPROVED-only, Mon–Fri charging parity),
   batch holiday matcher, default-pattern weekly-off fallback.
4. Days without punches have no control row (31.7 never fabricates
   attendance) and resolve on read: ABSENT only with a resolved
   expectation, else UNRESOLVED — never a guessed absence.
5. The open current day (today, no control, workday, no leave) reads
   UNRESOLVED — absence is an end-of-day determination.

## Outcome buckets (exactly one per day)

`PRESENT / HALF_DAY / ABSENT / LEAVE / HOLIDAY / WEEKLY_OFF /
UNRESOLVED / FUTURE`. Full-day leave dominates; partial leave counts
as half-day; non-working days split by calendar primary; worked
holidays/offs keep their calendar bucket with separate
`workedOnHolidayDays` / `workedOnWeeklyOffDays` counters plus minutes
in the totals. Future days (company-TZ `today` split) are never
absence and carry no facts. Overnight sessions anchor to
`control.date` (business date), so a Sep night shift with an Oct
clock-out lives in September only.

## Month summary (pure, per employee-month)

Exclusive `dayCounts`, 31.7 fraction `equivalents` (worked/leave/
absent), work-mode day breakdown, worked/break minutes, late / early
/ missing-punch / unresolved / regularized day counts, approved OT
minutes (approved OVERTIME requests only, `control.overtimeMinutes`
preferred), comp-off days earned (approved COMP_OFF only), and days
needing attention. `scheduledWorkingDays` counts the month's expected
working days (resolved ctx, else default pattern), including future
days — it is the schedule, not attendance.

## Exception flags (display codes only — never free text)

`LATE_ARRIVAL` (lateMinutes > 0), `EARLY_EXIT` (earlyMinutes > 0),
`MISSING_PUNCH` (past/today partial session, excluding the
in-progress open session), `REGULARIZATION_PENDING`, and
`ATTENDANCE_ON_LEAVE` (session on a full-leave day). Conflict codes
pass through only when they match the safe vocabulary pattern.

## Privacy (§35)

Day detail shows recorded vs effective times, the recorded timeline
(seq/type/at/mode/office-name-only), schedule, leave label + portion
+ id, holiday name, OT time facts, and correction *status* (pending /
applied + request types). Employee reasons, reviewer notes,
coordinates, distances, and home locations never leave the backend.
Serializer is an exact allowlist; raw docs never serialize. Reads
create no audit rows.

## CSV export (§20–23, §39)

Sync download (statutory `fileResponse` precedent): BOM + CRLF (audit
parity), 21 §20 columns, spreadsheet formula-guard (`'=+-@` prefix,
audit `csvCell` parity, implemented purely and tested). Same scope +
filters as the team table; hostile names sanitize. Audited ONCE per
export via `ATTENDANCE_TIMESHEET_EXPORTED` with safe metadata only
(month/scope/format/employees/rows/filename) — best-effort, never
fails the download. CSV-only: the existing XLSX path is queued job
infrastructure, disproportionate for a bounded monthly export.

## Performance (§24–26)

~12 bounded reads per request (policy, timezone, users, masters
4-in-1, controls-range, events-range, leaves-overlap, regs-range,
OTs-range, departments) + O(users×days) in-memory derivation. No
per-day or per-user queries (call-count test at two team sizes).
`hasExceptions` cannot be a Mongo predicate, so that filter derives
all scoped months in memory (CPU-only) before paginating; without it,
users paginate in Mongo and only the visible page derives. No Redis,
no BullMQ, no new cache.

## Payroll boundary (§27–33)

Facts only: absence/leave equivalents, approved OT minutes, comp-off
days. Zero money, zero LOP math, `lopSource` untouched, no
lock/finalize vocabulary anywhere. 31.11 owns finalization; this
phase builds nothing for it.

## Files

- `Backend/src/services/attendance/attendanceTimesheetRules.js` —
  pure month math, buckets, summaries, CSV builders (no Mongo/req).
- `Backend/src/services/attendance/attendanceTimesheetService.js` —
  scope, batch derivation, serialization, export + audit.
- `Backend/src/controllers/attendanceTimesheetController.js` — thin,
  comment-convention compliant.
- `Backend/src/routes/attendanceRoutes.js` — four GETs (extended, the
  31.9 precedent; no new routes file).
- `Backend/test/attendanceTimesheet.test.js` — 40 hermetic tests,
  registered in `test:all`.
- `Frontend/src/components/attendance/TimesheetMonthView.jsx` —
  shared calendar + summary + day drawer (Modal reuse).
- `Frontend/src/pages/attendance/AttendanceTimesheetPage.jsx` —
  `/app/attendance/timesheet` (all employees).
- `Frontend/src/pages/attendance/AttendanceTeamTimesheetsPage.jsx` —
  `/app/attendance/team-timesheets` (SENIORS).
- `Frontend/src/services/attendanceService.js` — four clients incl.
  the blob-download export.
- `AppRoutes.jsx` / `AppLayout.jsx` / `SidebarNav.jsx` — routes, menu
  items (permission-gated), icons.

## Frontend notes

Monday-first calendar grid; outcome dot + flags per cell; click any
day for the full drawer (schedule/actual/timeline/corrections/OT +
links into Regularizations, Work Modes, Overtime, Leaves). Team page:
month picker, search, department filter, "only needing attention"
toggle, sortable-free summary table (§14 columns), pagination, CSV
export of the current filter set, inline per-employee drill-down.

## Localhost guide

1. Pull the branch, `npm install` (backend + frontend) if needed.
2. Start backend + frontend; log in as an employee with punches.
3. My Timesheet (`/app/attendance/timesheet`): current month renders;
   prev/next + month picker navigate; past months stay readable.
4. Click any day: drawer shows schedule/actual/timeline/corrections.
5. As MANAGER/TEAM_LEAD: Team Timesheets shows subtree only; search /
   department / attention filters narrow; row click drills down.
6. As HR_MANAGER/COMPANY_ADMIN: whole company; Export CSV downloads
   `crewly-timesheet-{month}.csv` (BOM + CRLF; open in Excel/Sheets).
7. As an outsider to a scope: drill-down returns 403; export omits
   out-of-scope rows.
8. `node --test test/attendanceTimesheet.test.js` → 40/40.

## Non-goals (explicit)

No 31-column team calendar grid (quality table + drill-down instead),
no XLSX/queued exports, no new permission, no audit-on-read, no
Redis/BullMQ/cache, no finalization/lock, no 31.12–31.16, no
computer-presence of any kind, no Event/Leave/OT workflow changes, no
report/history page changes.

## Risks / discrepancies (all documented + tested)

1. Stored-vs-live resolution duality (precedence above; frozen
   projection wins, live minutes).
2. Unresolved-schedule weekly-off falls back to the default pattern.
3. Future months return all-`FUTURE` days with a zero summary.
4. Export volume = scope × days with no artificial cap (sync O(rows)
   string build).
5. Outcome-bucket taxonomy is 31.10's read-model definition; payroll
   owns all money meaning.
