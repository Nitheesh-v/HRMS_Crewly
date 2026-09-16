# Phase 31.7 — Leave, Holiday & Weekly-Off Reconciliation

ONE deterministic daily resolution layer combining effective attendance
(recorded events + approved regularization overlay) with the 31.6
schedule context, APPROVED leave, and the applicable holiday — without
copying any of them into Attendance and without touching payroll.

## 1. Authority boundaries

| Domain | Owner | 31.7 relationship |
|---|---|---|
| Attendance events | 31.2 (`AttendanceEvent`) | read effective facts, never invent |
| Regularization overlay | 31.5 | read corrected times, never invent |
| Schedule / working days | Shift / Work Schedule + 31.6 | read context/snapshot |
| Leave | Leave module | read APPROVED cover + ref, never mutate |
| Holiday | Holiday module + scheduleEngine | read applicability, never mutate |
| Daily resolution | 31.7 (this phase) | derived, stored as projection |
| Money | Payroll 29.x | untouched (no reads, no writes) |

No fake punches, no fake events, no leave/holiday copies: the
projection stores refs and small display snapshots only.

## 2. Architecture

- `services/attendance/attendanceReconciliationRules.js` — PURE
  combiner. Work facts arrive pre-computed (31.1 band / 31.6 verdict);
  the rules resolve outcome + calendar + leave + fractions +
  conflicts. No Mongo, no clock, no payroll (static-guarded).
- `services/attendance/attendanceReconciliationService.js` —
  injectable resolvers (`resolveLeaveForDay`, `resolveHolidayForDay`,
  `resolveWeeklyOff`, `resolveDay`, `refreshDayProjection`,
  `refreshRangeForLeave`). Injection-only: a missing model/engine
  degrades to null fast (never hangs, never guesses).
- `Attendance.reconciliation` — additive projection subdocument
  (outcome, calendar, leave ref, halves, fractions, exceptions,
  conflicts, flags, schedule display, notes, resolvedAt/By).

## 3. Resolution / precedence table

Dimensions stay separate: `outcome` (existing `DAILY_OUTCOME` — 31.1
intentionally has no LEAVE, and 31.7 adds none), `calendar`
(`WORK_DAY / WEEKLY_OFF / HOLIDAY`), `leave`
(`NONE / FULL_DAY / FIRST_HALF / SECOND_HALF` + ref).

| Facts | Outcome | Fractions (worked/leave/absent) | Notes |
|---|---|---|---|
| Workday, full work | PRESENT / HALF_DAY / ABSENT (band) | 1 / 0 / 0 (0.5 or absent per band) | 31.1/31.6 band reused |
| Workday, no work, no leave | ABSENT | 0 / 0 / 1 | |
| Workday, partial punches | UNRESOLVED | 0 / 0 / 0 | missing-punch flow owns it |
| Full-day leave, no work | NON_WORKING_DAY | 0 / 1 / 0 | leave dimension carries LEAVE |
| Full-day leave + work | band (or UNRESOLVED if partial) | work-claim + leave 1 | `ATTENDANCE_ON_APPROVED_LEAVE`, review |
| Half leave + working-half work | HALF_DAY | 0.5 / 0.5 / 0 | halves display |
| Half leave + no work | ABSENT | 0 / 0.5 / 0.5 | unworked half is absence |
| Half leave + short work | ABSENT | 0 / 0.5 / 0.5 | + SHORT_HOURS |
| Work inside leave half | band | work-claim + leave 0.5 | `LEAVE_HALF_MISMATCH`, leave never moves |
| Weekly off / holiday, no work | NON_WORKING_DAY | 0 / 0 / 0 | never absent |
| Weekly off / holiday + work | NON_WORKING_DAY | 0 / 0 / 0 | `nonWorkingDayWorked` + worked flags/minutes |
| Holiday + weekly off | calendar HOLIDAY + `alsoWeeklyOff` | per above | date-specific beats pattern; nothing lost |
| Leave over holiday | NON_WORKING_DAY + both dims | 0 / 1 / 0 | Leave charges holidays (its rule) |
| Pending / rejected / cancelled leave | ignored (leave NONE) | per no-leave row | requests are not approvals |

## 4. Calendar contexts

`WORK_DAY`, `WEEKLY_OFF` (schedule pattern), `HOLIDAY`
(engine-applicable: company/public + picked optional + department +
branch + explicit employee; recurring projected). Overlap rule (§3):
primary HOLIDAY, `alsoWeeklyOff: true`.

## 5. Full-day leave

APPROVED + in-range + Leave-counted day (Mon–Fri parity with
`countWorkingDays`: Sat/Sun inside a range consume no balance, so
they are not leave). Covers the day; punches under it conflict
instead of guessing.

## 6. Half-day leave

The Leave module has NO portions (verified by grep, backend +
frontend), so nothing supplies halves today. The midpoint rule is
exact and live: split = scheduled window `start + span/2` from the
31.6 interval (overnight-aware); no resolved schedule → halves
unresolved (never a 12:00 split). Pure rules + tests cover
FIRST_HALF/SECOND_HALF via injected contexts; the service resolves
FULL_DAY only until Leave gains portions.

## 7. Attendance-on-leave conflict

`ATTENDANCE_ON_APPROVED_LEAVE` (+ `LEAVE_HALF_MISMATCH` for halves):
both facts preserved, `needsReview: true`, fractions carry both
claims. Fixes happen in the owner modules (Leave / 31.5) — 31.7
auto-mutates nothing and issues no comp-off / OT approval (31.8).

## 8. Weekly off / holiday behavior

No work → `NON_WORKING_DAY`, never absent, nothing fabricated. Work
→ facts + minutes kept, `nonWorkingDayWorked: true`,
`holidayWorked` / `weeklyOffWorked` flags. No comp-off, no OT
approval, no money.

## 9. Overnight business-date behavior

Reconciliation anchors to the business date it is given (31.6 owns
attribution): night-shift facts resolve on the shift START date;
leave/holiday lookups use that same `YYYY-MM-DD` string. Tested.

## 10. LOP ownership / Phase 29.5

FROZEN. `lopSource` stays `ATTENDANCE` (no LOP leave type exists in
`LEAVE_TYPES`, and 31.7 invents none). `computeAutomaticSummary`
untouched; `Attendance.status` vocabulary untouched (ABSENT still
derived, never stored). Reconciliation fractions are informational
and mirror what 29.5 derives — payroll consumes nothing new.

## 11. Payroll boundary (interim)

31.7 writes no payroll input, snapshot, or money field. A later
reconciliation (e.g. late leave approval) refreshes the attendance
projection only; immutable `PayrollResult`s are never rewritten.
Finalization/locking is 31.11's job.

## 12. Projection / rebuild strategy

- Live clock-in/out persist `reconciliation` on the touched day
  (best-effort; a failed lookup never breaks a punch).
- 31.5 rebuild re-resolves approved days (best-effort; never fails
  an approval).
- Leave APPROVED refreshes every in-range control row (bounded 370
  days, idempotent, per-date isolated, fire-and-forget); CANCELLED
  carries the same seam (no-op today — cancel is PENDING-only).
- Reads (`/attendance/my`, `/attendance/company`, today-live) serve
  the stored projection, else resolve live (never write on read).
- Holiday edits apply going-forward: stored projections keep their
  holiday snapshot; no mass rewrites (31.11 strengthens locking).

Consistency model: Mongo is truth; the projection is a cache of a
pure function — any miss or staleness self-heals on the next
write-triggered refresh or read-time resolution.

## 13. APIs / UI

- No new routes, no new permissions, no audit noise. Extended:
  `GET /attendance/my` (+ per-row `reconciliation`, + display-only
  `derived: 'LEAVE'` rows for approved-leave days without punches —
  summary math untouched), `GET /attendance/company` (+ per-row
  `reconciliation`, so record-less users show leave/holiday/off),
  `GET /attendance/today/live` (+ `reconciliation` for the card).
- Employee history: separate badges (Leave / halves `1st · 2nd` /
  Worked on holiday / Worked on weekly off / Needs review); derived
  leave rows render without punch times. Today card: leave, holiday,
  and conflict notices. Manager report: ON LEAVE / HOLIDAY /
  WEEKLY OFF replace NOT PUNCHED where derived; NEEDS REVIEW and
  off-day-work badges on top.

## 14. Tests

`test/attendanceReconciliation.test.js` — 28 hermetic tests: parity
primitives, workday matrix, full-day leave + conflicts, half-day
matrix (injected portions), off/holiday matrix + overlap, leave-on-
holiday, service resolution end-to-end, overnight anchoring,
tenancy, refresh persist/skip, bounded idempotent range refresh,
and static guards (no payroll/money/comp-off/OT-approval, pure
rules, no leave writes). Regression: 31.x + monthlyInputs +
scheduledJobs green; `test:all` + frontend build reported at
handoff with current counts.

## 15. Limitations

- History shows leave-day rows but no absent/off/holiday-no-work
  rows (full day-grid is 31.10 territory); the summary counts
  already cover absence.
- Half-day leave activates only if the Leave module gains portions.
- Write-path resolution uses id-only user context (department/
  branch-scoped holidays degrade); read paths with full user docs
  resolve completely.
- Monthly report aggregates and the 29.5 weekendPolicy-vs-schedule
  basis divergence are explicitly untouched.
