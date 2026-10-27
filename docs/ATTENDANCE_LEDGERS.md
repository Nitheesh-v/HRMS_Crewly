# Attendance ledgers — Analytics, Team Timesheets, Operations, My Timesheet

Four surfaces were re-cut against the Stitch exports in `stitch-attendance/v2`
(`screen.png`, `screen (2).png`, `screen (4).png`, `screen (6).png`). One rule
governed every block: **a figure may only appear if the API returned it**, and a
sum may only speak for the rows it was computed from. Blocks that have no
endpoint keep their place in the layout and say what they lack.

| mock | route | file |
| --- | --- | --- |
| `screen.png` | `/app/attendance/analytics` | `AttendanceAnalyticsPage.jsx` |
| `screen (2).png` | `/app/attendance/team-timesheets` | `AttendanceTeamTimesheetsPage.jsx` |
| `screen (4).png` | `/app/attendance/operations` | `AttendanceOperationsPage.jsx` |
| `screen (6).png` | `/app/attendance/timesheet` | `AttendanceTimesheetPage.jsx` + `TimesheetMonthView.jsx` |

Endpoints used (unchanged, no backend work): `/attendance/analytics/{overview,
trends,employees,mine,payroll-reconciliation,export}`,
`/attendance/timesheets/{mine,team,employee/:id,export}`,
`/attendance/finalization/:month`, `/attendance/operations`.

---

## 1. Attendance Analytics

Overview rebuilt as a ledger front page: hero + provenance pill, five tabs,
labelled filter grid, four headline rates, day-outcome distribution, modality
bars, then the three evidence cards.

| mock block | rendered | why |
| --- | --- | --- |
| `2026-10 LIVE` pill | provenance pill — `Live projection`, or `N finalized` per month | `provenance[]` from the payload |
| `Audit snapshot Today 08:30 UTC` | the time this page *read* the data | the API has no audit-snapshot timestamp; the read time is real |
| `Ledger Rules` button | link to the attendance policy page | the policy owns the math; nothing new was invented |
| `Attendance Rate 92.4% +1.8%` | `attendanceRate.pct` + worked/scheduled units | **the `+1.8%` delta is dropped** — no prior-period comparison is returned |
| `Absence & Leave 7.6% (21 absent units)` | `absenceRate.pct`, absent units, leave/absent day counts | real |
| `Effective Worked 4,218h 40m`, avg/session day | `workedMinutes`, `averageWorkedMinutes`, `sessionDays` | real |
| `Punctuality 4 incidents`, `14m grace excess` | `lateOccurrences`, `lateMinutes`, `earlyOccurrences` | the mock's "grace excess" is not a field; minutes past start are |
| `Day Outcomes` 7 tiles + `340 Total Units` | the seven real buckets, sum computed on screen | real |
| `Confidence index: 99.4%` | dropped; replaced by "missing-punch days · session days" | no confidence metric exists |
| `Work Modes` 5 rows with `%` and counts | `totals.modes` ÷ the sum of modes | real share arithmetic |
| `Hybrid compliance 98.2%` | card kept, **Not configured**, links to policy | no mandated office-day minimum is stored |
| `Capture Telemetry` 4 sources | `sources.counts` / `sources.pcts` | real; labels title-cased from the codes |
| Terminal uptime / gateway heartbeat | stated as not published | no endpoint |
| `Overtime Ledger · NON-PAYROLL` | `overtime.approvedMinutes/approved/pending` + statutory note | real; no money anywhere |
| `Regularizations` submitted/approved/pending | `regularizations.*` | real |
| `Geofence Verification 100% matched` | punch counts per location + share | a "verified" claim is not in the payload; counts are |
| `Snapshot Certified · Ledger Engine v4.2` | statement derived from provenance (finalized vs live) | no engine version is exposed |
| `Executive PDF Audit` | button kept, disabled with a reason | no PDF endpoint |
| `Employees CSV / XLSX / Reconciliation CSV` | the three real exports | real |

Trends, Employees, My summary and Payroll reconciliation keep their previous
data and controls, restyled; the Employees table still defaults to name order
and every other order is an explicit sort, never a ranking.

## 2. Team Timesheets

| mock block | rendered | why |
| --- | --- | --- |
| `AUDIT CYCLE Q4`, `12 of 12 employees • 98.2% System Completion` | month pill + `rows.length of total` | completion % is not a field |
| `Lock & Finalize Period` | switches to the finalization tab (same permission gate) | mutations stay in the panel that owns them |
| `3 Exception Items Flagged` guard | `N exception items flagged` = rows with `exceptionDays > 0` | real, per the rows on screen |
| `2 employees missing swipe logs, 1 unapproved OT` | exception days, unresolved days, late days | the per-cause split is not returned per employee |
| `TOTAL AUDIT SCOPE 12 Staff • 27 Scheduled Days` | `total`, plus scheduled man-days in the footer tiles | real |
| filter strip | search, department, rows-per-page — plus **Isolate rows needing attention** | the mock's shift filter has no backend field; `hasExceptions` is a real API filter |
| matrix columns scheduled/present/half/leave/absent/late/worked/OT | `summary.*` per employee | real; badges only when non-zero |
| `CUSTOMIZE COLUMNS`, `Sync Biometrics` | dropped | no column config, no sync endpoint |
| footer tiles (man-days, hours, avg, compliance) | computed from the rows on screen | labelled "this page" whenever `rows.length !== total` |
| `PAYROLL READINESS CHECKLIST · lock cutoff 31 Oct` | real period status + last snapshot version/date from `/finalization/:month` | the cutoff is not exposed; the period status is |

## 3. Attendance Operations Center

| mock block | rendered | why |
| --- | --- | --- |
| `2026-10-27 • Whole Company • 28 staff • Live stream` | date, scope type, `scope.total`, live sync age | real |
| `Today / Yesterday` + refresh | same, 45 s visible-tab polling retained | real |
| Regularizations / OT pending / Needs attention chips | `workflows.*.total`, `attentionCounts.items` | real |
| 5 KPI cards | `summary.expected/working/onLeave/(notIn+lateNotIn)` and `attentionCounts.people` | real; bars are shares of `expected` |
| filter bar incl. mode chips | mode chip counts are `modes.*`; nothing is a client mask | real |
| `Department Presence Matrix` + Departments/Shifts/Campuses | `departments[]`, `shifts[]`, `locations[]` | real; campuses only count located punches |
| `Dept lead · 3 Squads`, `100% In` | **dropped** (no lead or per-dept qualifier in the payload); status chip is `N flagged` / `Complete` / `Nominal` | derived only from the group's own counters |
| `Recent Bio-metric Sync — terminal #02, 18 punches in 20m` | card kept, **Not configured** | no gateway heartbeat |
| `Campus Geofence & Device Network · 3 APs · 0 latency spikes` | card kept, **Not configured** | no device telemetry; the board shows presence, never coordinates |
| `Legacy Baseline Reference (Operational Spec)` | dropped | it is a screenshot of a legacy screen, not data |
| `Operational Exceptions (4)` rail | `attention.items` with severity, since, minutes, in/out, mode, location | real; pagination is the API's |
| `Review & Fix`, `Dismiss`, `Call`, `WhatsApp Nudge`, `Mark Absent` | **Open month** (employee timesheet drill-down in a modal) + the workflow link that owns the decision | none of those mutations exist on this read-only API |
| `Resolve All Warnings` | link to the regularization exception centre | bulk approval is not an endpoint |
| `Auto-Regularization Policy Active · escalates at 12:00 PM` | strip kept: pending counts + link to the policy page | no escalation runtime state is exposed |

## 4. My Timesheet

| mock block | rendered | why |
| --- | --- | --- |
| `SYNC REALTIME` pill | "Synced HH:mm" from the last completed read | a fixed verdict would be a lie |
| month stepper + Today | real `?month=` control | real |
| `Request Bulk Regularization` | "Request a correction" → `/app/attendance/regularizations` | bulk creation is not an endpoint |
| `Download Statement (PDF)` | stated as unwired in the footer | no personal PDF endpoint |
| 8 KPI tiles | `summary.dayCounts`, `workedMinutes`, `lateDays`, `approvedOtMinutes`, `exceptionDays` | real |
| legend + `95.4% Expected Hours Met` | worked minutes ÷ the scheduled minutes of elapsed days, named in the tooltip | arithmetic over `day.schedule` |
| calendar grid (hours, in-time, dots, flags, today ring) | `days[]` — `bucket`, `actual`, `workMode`, `exceptions` | real |
| day drawer → right rail | the selected day's breakdown, punch timeline, break, late/early, correction state, OT | better than the mock's modal: the calendar stays visible |
| `Gross Tracked 9h07m / Unpaid Lunch −0h45m / Net 8h22m` | worked minutes, breaks recorded, corrected days, worked holidays | the payload does not split gross/net; relabelled rather than guessed |
| `Request Regularization/Correction`, `Add Note/Compensatory Proof` | link to regularizations; link to overtime & comp-off | real workflows |
| `Assigned Shift Policy SH-DAY-01` + weekly roster | the month's actual shift windows by frequency, plus unresolved/no-roster day counts | the mock's weekly-off pattern is not returned |
| `Legacy Punch Audit Log` | card kept, **Not configured**, shows the month's recorded event count | archive export does not exist |

---

## Verification

- `npm test` **660/660** — including the new `test/attendanceLedgers.test.js`
  (10 pins) which holds the live-data rules: page-local sums name their rows,
  hardware/compliance/PDF blocks stay unconfigured, no currency or ranking, no
  legacy `.card` surfaces.
- `npm run build` ✓ 1.40 s.
- `npx eslint src` **105 errors / 16 warnings** — identical to the pre-change
  baseline; the 8 `set-state-in-effect` errors across these files are the same
  load-in-effect pattern every fetch page in this repo has.
- **No screenshots.** There is still no browser in this sandbox: these pages are
  verified by build, tests, token checks and the API contract, not by pixels.
