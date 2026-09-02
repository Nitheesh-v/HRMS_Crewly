# Phase 29.13 — Analytics extensions

> **Numbering.** The brief for this phase was pasted as "29.13", but the
> analytics system it extends is already in the repo and is documented as
> **Phase 29.12** (`docs/PHASE_29_12_PAYROLL_ANALYTICS.md`). Nothing was
> rebuilt. This document is the extension layer on top of 29.12, and every
> §-number below is the brief's, not the repo's. Where the two disagree, the
> repo wins and the disagreement is recorded here.

Six new reports, the five dashboard cards that were missing, period presets,
a "why did the cost move" decomposition, a register that pages on the server,
employee salary history, company-editable salary bands, Super Admin platform
metrics, audit-on-read, export expiry and an aggregation fast path — in that
build order, eight commits.

```
29.6 snapshots ──► analyticsRules  (pure functions — the grammar)
                └─► analyticsService (Mongo: aggregation OR rows)
                └─► analyticsController / routes
                └─► platformAnalyticsService (Super Admin: counts only)
                └─► Frontend pages (Crewly design system, one sidebar entry)
```

---

## 1. The three decisions that override the brief

### 1.1 §29 "never fetch thousands into Node" — both paths, not one

§29 asks for aggregation pipelines. §11 asks for reports that join payroll
payments, payslips and employees. Those are different jobs, and the repo now
does both rather than pretending one fits:

| | Used for | How |
| --- | --- | --- |
| **AGGREGATION** | KPI cards, dashboard, trend series | `$match → $group → $sort` in MongoDB. No documents cross into Node. |
| **ROWS** | Register, variance, earnings, reimbursements, F&F, scoped reads | The existing row loader, with the payment filter applied. |

The route is chosen per request, and the dashboard **reports which one it
used** — a benchmark that cannot see which path ran is not measuring anything.

What was deliberately **not** done: rewriting `isCurrent`, the
superseded-version chain or the PAID-wins payment rule as a `$lookup`
pipeline. Those rules are tested in one place and duplicated business logic
is worse than a slower query. The row path stays the single source of truth
for anything that needs them.

Both paths must agree. `Backend/scripts/analyticsBenchmark.js` prints:

```
Route used for the plain dashboard      AGGREGATION
Route used with a payment filter        ROWS
Same gross either way                   yes
```

Read those two lines first. If the plain dashboard ever says ROWS, every
other number in the run is measured on the wrong thing.

### 1.2 §34 — no new permission, no migration

`SYSTEM_PERMISSION_VERSION` stays **26**. Salary history is gated by the
existing `EMPLOYEE_SALARY_READ` (the analytics verb is the other way in), so
no `PAYROLL_SALARY_HISTORY_VIEW` and no v26 → v27. Editing the salary bands
rides `PAYROLL_ANALYTICS_SCHEDULE`, which already means "configure
analytics", rather than minting a verb for one field.

### 1.3 §38 — a file must not outlive its usefulness

`AnalyticsReportFile` gained `expiresAt` and an `EXPIRED` status. A sweep
flips expired files; `downloadFile` refuses them. A payroll register sitting
on a server forever is a liability, not a convenience.

---

## 2. What was built

### 2.1 Six reports (§11, §12, §13, §18, §20, §21)

All six are **pages over existing rules**. Nothing about how payroll is
calculated moved into the browser, and none of them recalculate a closed
period.

| § | Report | Route | What it answers |
| --- | --- | --- | --- |
| §11 | Earnings | `/payroll/analytics/earnings` | Fixed vs variable vs overtime vs reimbursements, by component and by kind |
| §12 | Deductions | `/payroll/analytics/deductions` | Statutory vs LOP vs other — the split that decides what must be remitted |
| §13 | Employer Contribution | `/payroll/analytics/employer` | PF, ESI, gratuity, LWF — money the company pays on top |
| §18 | Reimbursements | `/payroll/analytics/reimbursement` | Claims by category, employee and month |
| §20 | F&F analytics | `/payroll/analytics/fnf` | The cost of people leaving, read from the **finalised** register |
| §21 | Payroll Variance | `/payroll/analytics/variance` | This period against the one before it, line by line |

Three things these reports refuse to do:

- **Deductions never hide a mismatch.** If the payroll run recorded more
  deductions than have named lines, the page shows the difference rather
  than folding it into "other".
- **Employer contribution is never net pay.** It is not a deduction and it
  is not part of an employee's earnings; it is shown separate and never
  added to either.
- **A variance window is compared to a window of the same length.** A
  quarter is compared to the quarter before it, never to the single month
  that preceded it.

§20 is **read-only over 29.11**. A draft settlement is listed because it
exists, but only PAID and CLOSED count as money.

### 2.2 Five dashboard cards (§3)

Employee Deductions, Overtime Cost, Bonus, Reimbursements and LOP Deduction.
The data was already in the summary; only the cards were missing. LOP
carries a warning tone when it is non-zero, because it is the one card that
means something went wrong rather than something was spent.

### 2.3 Period presets (§4)

`CURRENT_MONTH`, `PREVIOUS_MONTH`, `CURRENT_FY`, `PREVIOUS_FY`,
`LAST_3_MONTHS`, `LAST_6_MONTHS`, `LAST_12_MONTHS`, `CUSTOM`.

"Custom" takes a `fromMonth` and a `toMonth` — April 2026 → March 2027 is
one selection, not twelve. The window is resolved on the server, so the
label the user sees ("Apr 2026 – Mar 2027") is the window the numbers
describe.

The signature of `payrollAnalyticsService.dashboard()` changed from
`(month)` to `({ month, preset, fromMonth, toMonth })`.

### 2.4 Trend direction (§5)

Every variance line carries **increasing / decreasing / stable**, not just a
difference. Stable means the figure moved by less than half a percent
(`STABLE_THRESHOLD_PERCENT`) — that is rounding, not a movement.

### 2.5 Cost movement (§9)

"Payroll cost is up 8%" is not something anyone can act on. The dashboard
decomposes the change into:

- **joiners / leavers / stayers** — the people
- **headcount effect** — what the joiners cost, less what the leavers cost
- **like-for-like effect** — what changed for the people who were there both
  periods
- **fixed / variable effect** — the part of like-for-like that is fixed
  salary rather than bonus, OT and reimbursements

Headcount effect plus like-for-like effect **equals the movement exactly**,
and the page says so, or says they do not reconcile. An unreconciled
decomposition is worse than no decomposition, so it is flagged rather than
quietly printed.

### 2.6 Monthly OT and LOP trends (§15 / §16)

Alongside the existing department breakdowns, both series are now available
month by month. §13's rule is unchanged: **overtime is never recomputed** —
hours come from `PayrollResult.attendance.otHours`, cost from
`totals.overtime`.

### 2.7 Payroll Register (§22)

The register pages and searches **on the server**. Five thousand employees
is a spreadsheet, not a web page.

- `page`, `limit` and `search` are sent with the request.
- The totals stay true for the **whole period** while only one page is sent —
  turning the page never looks like the payroll shrank.
- Out-of-range pages clamp to the last page.
- `search` matches employee code, name, department and designation. It
  returns **zero rows for a salary amount** — payroll is not searchable by
  what someone earns.
- New columns: Basic, Total Earnings, **Structure Gross**, Employer
  Contribution, Payroll Status, Designation.

> **Structure Gross is not a duplicate.** 29.12 established that the engine
> stores two "gross" figures and analytics reports the wider one:
> `totals.gross` is the structure earnings (the PF/ESI wage base, the LOP
> daily rate) and `totals.totalEarnings` is structure + variable + overtime.
> Analytics reports `totalEarnings` as gross. Printing the same number twice
> under two names is a lie of omission, so the second column is the
> structure figure and is labelled as such. `fixedGross` now travels on both
> the aggregation and the row path's summaries — two code paths that can
> disagree are worse than one slow path.

### 2.8 Employee Salary History (§23)

Two things, kept apart on purpose:

- **What they were paid** — one row per month, from the 29.6 snapshots.
  Actuals: what actually hit the bank.
- **What they were promised** — the 29.4 profile's version chain: every
  revision with the date it took effect, `annualCtc`, `structureId`, and
  which version is current. Nothing is overwritten, so a revision made three
  years ago is still readable.

The scope check is on the server (§25). A manager scoped to two departments
cannot read a third department's history by typing an employee id; the page
shows the refusal. `/mine` is pinned to `req.user._id`.

### 2.9 Filters (§24)

Employment status (`User.status`) and salary structure (the snapshot carries
`structureId`) were added, because both have backing data.

**Not added:** pay group, location and cost centre. No collection in the
repo carries them, and a filter that always answers "nothing" is worse than
no filter. They remain fenced, not invented.

### 2.10 Salary bands (§8)

Configurable per company. `normaliseSalaryBands()` validates and the bands
are stored on the company's payroll settings;

- the **top band has no ceiling** — a twelve-lakh salary must still be
  counted
- bands **may not overlap** — an employee counted twice is worse than a band
  fewer
- the editor requires `PAYROLL_ANALYTICS_SCHEDULE`

Two bugs worth remembering, because both were silent: `Number(null)` is `0`
(not `NaN`), and the open-ended top band was being deleted by the
normaliser. Both are now covered by tests.

### 2.11 Super Admin platform metrics (§2)

`GET /api/super-admin/dashboard/payroll-analytics` returns counts only:
companies using payroll, payroll processing usage, job stats, module
adoption.

```json
{ "generatedAt": "...", "window": {...}, "adoption": {...},
  "processing": {...}, "jobs": {...},
  "privacy": { "includesPayrollAmounts": false } }
```

**Never a rupee of customer payroll data, never an employee name.** The
privacy block is in the payload so the guarantee is checkable, not just
claimed.

### 2.12 Audit on read (§32)

Report viewed, register downloaded, salary history accessed — each carrying
the **filters that were applied**. No salary figures are written to the
audit trail. An audit log that records what someone was paid is a second
copy of the payroll system with weaker access control.

---

## 3. Performance (§29 / §44)

`npm run analytics:benchmark` seeds 1,000 then 10,000 employees × 12 months
(120,000 snapshots) **plus one PAID payment per snapshot** — the row path
filters on payment status, and a harness that forgets the payments compares
a full company against an empty one.

Raise the ceiling first:

```powershell
$env:PAYROLL_SNAPSHOT_SCAN_LIMIT = "200000"
```

Then:

```powershell
MONGO_URI="mongodb://localhost:27017/crewly_bench" npm run analytics:benchmark
```

**Measured in this sandbox (fake mode — Mongo was unreachable, so these
measure Node only, with no I/O, no index and no BSON. Do NOT quote them as
database performance):**

| | 1,000 employees | 10,000 employees |
| --- | ---: | ---: |
| Dashboard, one month (AGGREGATION) | 366 ms | 2,935 ms |
| Dashboard, LAST_12_MONTHS (AGGREGATION) | 723 ms | 8,368 ms |
| Row path (payment filter) | 143 ms | 3,510 ms |
| Register, page 1 of 50 | 71 ms | 2,749 ms |
| Variance, 12 months | 142 ms | 2,236 ms |
| Earnings | 59 ms | 2,667 ms |

Both runs: `Route used for the plain dashboard AGGREGATION`, `Route used
with a payment filter ROWS`, `Same gross either way yes`.

With a real `MONGO_URI` the script uses the real models, `insertMany` in
batches of 5,000, and deletes its `companyId` from results, payments and
users afterwards. Re-run it against real Mongo before quoting any number.

**Indexes.** `PayrollResult` carries five: company+month, company+month+
status+isCurrent, company+employee+month, company+month+department, and
company+month+structure.

---

## 4. What is deliberately not built

### 4.1 Loans and advances

Out of scope for this phase — "there is no loan process in this payroll, we
can add it in future". This reverses the roadmap item still recorded in
`docs/PROJECT_MEMORY_CAPSULE.md`.

**Consequence, documented not fixed:** 29.11 F&F has `ADVANCE_SALARY` and
`LOAN_EMI` recovery lines with **no ledger behind them**. They are typed by
hand and appear in settlements as whatever was entered. A future loan module
is the fix; analytics reports them as it finds them.

### 4.2 Pay group, location, cost centre

No backing data. Fenced, not invented. See §2.9.

### 4.3 A `$lookup` rewrite of the business rules

See §1.1.

---

## 5. API surface

Sixteen analytics routes, in mount order:

```
GET    /dashboard
POST   /refresh
GET    /files
GET    /files/:fileId
GET    /employee-history/mine
GET    /employee-history/:employeeId
GET    /settings
PATCH  /settings/bands
GET    /schedules
POST   /schedules
PATCH  /schedules/:scheduleId
DELETE /schedules/:scheduleId
GET    /export/:reportKey
POST   /export/:reportKey
GET    /:reportKey
```

Plus `GET /api/super-admin/dashboard/payroll-analytics` (§2).

---

## 6. Verification

| Check | Command | Result |
| --- | --- | --- |
| Analytics rules | `npm run test:analytics` | **63 pass / 0 fail** |
| Platform metrics | `node --test test/platformAnalytics.test.js` | **6 pass / 0 fail** |
| Whole backend | `npm run test:all` | **807 pass / 0 fail** |
| Preview artefacts | `npm run analytics:preview` | 54 files in `Backend/.preview/analytics/` |
| Benchmark | `npm run analytics:benchmark` | see §3 |
| Frontend build | `cd Frontend && npx vite build` | clean, 2,063 modules |

`npm run analytics:preview` is the one to trust for figures: it writes real
CSVs, XLSX files and PDFs and then scans its own artefacts for bank-like
numbers.

---

## 7. Files

**Backend**

- `src/services/payroll/analyticsRules.js` — the six new report builders,
  `directionOf`, `costMovement`, `normaliseSalaryBands`
- `src/services/payroll/analyticsService.js` — aggregation fast path, period
  resolution, paging, filters, expiry sweep, audit on read
- `src/services/payroll/platformAnalyticsService.js` — §2 counts only
- `src/models/AnalyticsReportFile.js` — `expiresAt`, `EXPIRED`
- `src/models/PayrollResult.js` — five indexes
- `src/utils/analyticsPdf.js` — money vs count columns
- `scripts/analyticsBenchmark.js` — §29/§44
- `scripts/analyticsPreview.js` — extended
- `test/analytics.test.js`, `test/platformAnalytics.test.js`,
  `test/helpers/fakeAggregate.js`

**Frontend**

- `src/pages/payroll/analytics/` — six new pages + `SalaryHistoryPage`
- `ExecutiveDashboardPage.jsx` — presets, five cards, cost movement
- `PayrollRegisterPage.jsx` — paging, search, new columns
- `SalaryDistributionPage.jsx` — the band editor
- `analyticsShared.js` / `.jsx` — `PeriodSelect`, `Pagination`, `SearchBox`
- `src/services/payrollAnalyticsService.js` — new signatures
- `src/routes/AppRoutes.jsx` — seven new routes

---

## 8. Handover

29.13 is complete: the six reports, the cards, the presets, the
decomposition, the paging register, salary history, editable bands, platform
metrics, audit on read, export expiry and the aggregation fast path.

The one thing that still needs a real database is §3. The benchmark ran
against in-memory fakes here because Mongo was not reachable in the sandbox,
so the numbers are Node-only. Run
`MONGO_URI="mongodb://localhost:27017/crewly_bench" npm run analytics:benchmark`
on a machine with Mongo before treating any timing as fact.

Loans and advances, and pay group / location / cost centre, are the two open
items — both recorded above rather than built.
