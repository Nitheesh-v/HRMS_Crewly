# Phase 29.12 — Payroll Analytics, Reports & Financial Dashboard

Business intelligence over payroll, **not** a second payroll engine.

```
payroll completed → read payroll snapshots → aggregate → analytics
  → department reports → export → schedule → management review
```

§11 is the rule the whole module is built on:

> Do not recalculate old payroll. Use historical snapshots only.

Every rupee on every screen is read from a 29.6 `PayrollResult` snapshot with
`isCurrent: true` and `status: 'CALCULATED'`. Nothing is re-derived, and a
report can therefore never disagree with what was actually paid.

---

## 1. Spec corrections applied

The brief was built as written, with four places where it conflicted with the
architecture already in the repo. Each is called out here rather than silently
resolved.

### 1.1 §4 — roles: two new verbs instead of reusing `PAYROLL_REPORT_*`

§4 lists "Company Admin, Payroll Admin, Finance Manager, HR Manager" against
overlapping capabilities. The repo gates on **permissions**, not role names
(28.x/29.1 discipline), so the conflict was resolved by adding two verbs:

| Verb | Grants | Default roles |
| --- | --- | --- |
| `PAYROLL_REPORT_READ` / `_EXPORT` | every report except CTC | HR, Payroll, Finance, Company Admin (pre-existing) |
| `PAYROLL_ANALYTICS_FINANCIAL` | the §16 cost-to-company report | Company Admin, Finance Manager |
| `PAYROLL_ANALYTICS_SCHEDULE` | §20 standing instructions | Company Admin, Finance Manager |

`SYSTEM_PERMISSION_VERSION` moved **25 → 26**, so existing companies pick the
verbs up on their next permission resolution with no migration step.

**HR Manager deliberately did not get the new verbs.** §16 says the CTC report
is Finance-only and §20 says scheduling belongs to Company Admin and Finance.
HR keeps `PAYROLL_REPORT_READ` / `_EXPORT` and can read and export everything
else.

### 1.2 §4 — Employee: no access

There is **no** `/mine` route in this module and no employee permission grants
one. §4's "Employee — No access" is enforced by absence, which is stronger than
a check that can be forgotten.

### 1.3 §13 — overtime is never recomputed

§13 says "Read data from Attendance and Payroll snapshots. Do not calculate OT
here." Overtime **hours** come from `PayrollResult.attendance.otHours` and the
**cost** from `totals.overtime`. The only arithmetic in the module is
cost ÷ hours, to display a rate.

### 1.4 §14 — the leave-impact rupees are derived, and labelled as such

The engine stores leave in **days**, not rupees. §14 asks for rupees, so they
are derived from the daily rate the snapshot implies (gross ÷ workingDays) and
the payload carries `derived: true`. The UI says so on the screen and the
reason is stated in the export.

### 1.5 §15 / §16 — gratuity sits alongside the liability, never inside it

Gratuity is a **provision**, not a remittable liability. The statutory report
shows it on its own line, outside `totalLiability`, and annualises it
separately. Professional tax and TDS likewise carry **no employer share** —
they are remitted, not matched — and the report shows zero rather than
inventing one.

§15 and §16 reuse 29.10's `buildStatutoryRow` and `summariseStatutoryRows`
verbatim, so analytics and statutory compliance cannot disagree about what "PF
employer" means.

### 1.6 §18 — cost centre and location have no backing data

`User` carries no `costCenter` and no `location` field. The §18 filter list is
implemented for payroll month, financial year, department, designation,
employee and status; cost centre and location are **recorded as a deviation**
and will need a schema change in a later phase.

### 1.7 §26 — ten pages, one sidebar entry

The ten reports are reached from inside the Executive Dashboard, so the payroll
menu keeps a single "Analytics & Reports" entry ("all features, but sidebars
small"). §9 (headcount), §14 (leave impact) and §16 (CTC) have no page of their
own in §26's list, so they live on the Executive Dashboard and the Payroll
Overview page.

---

## 2. Backend files

New:

| File | What it holds |
| --- | --- |
| `src/services/payroll/analyticsRules.js` | 39 pure functions: the §5–§19 maths, `reportTable`, `nextRunAt`, `applyFilters`, `recentMonths`, `FINANCE_ONLY_REPORTS` |
| `src/services/payroll/analyticsCache.js` | §21 cache keys and invalidation |
| `src/services/payroll/analyticsService.js` | the orchestration layer (the only thing the controller talks to) |
| `src/services/payroll/analyticsDispatcher.js` | payload validation + three dispatchers |
| `src/models/AnalyticsReportFile.js` | §19 artefact: format, filters, binary, status, downloads |
| `src/models/ScheduledReport.js` | §20 standing instruction |
| `src/utils/analyticsPdf.js` | one PDF renderer for every report |
| `src/middlewares/analyticsScope.js` | §3 row scoping |
| `src/validators/analyticsValidator.js` | §24 input validation |
| `src/controllers/analyticsController.js` | thin controller |
| `src/routes/analyticsRoutes.js` | mounted at `/api/payroll/analytics` |

Touched: `queueConfig.js` (three job names), `permissionRegistry.js` +
`permissionService.js` + `roleTemplates.js` (two verbs, version 26),
`routes/index.js`, `workers/payrollProcessor.js` (three processors),
`workers/index.js` (startup re-arm), and the four services that must drop the
analytics cache when payroll changes.

### One reader

`loadRows()` is the **only** place that queries `PayrollResult`. Dashboard,
department report, trend and every export call it, so no two screens can
disagree about the same month. Row scoping (§3) is applied there too, which is
why no report can forget it.

---

## 3. The reports

| Key | Section | Shape |
| --- | --- | --- |
| `OVERVIEW` | §6 | summary + by-department table |
| `DEPARTMENT` | §7 | sorted by highest payroll cost |
| `DESIGNATION` | §8 | count, average, highest, lowest, total cost |
| `HEADCOUNT` | §9 | active / joined / exited / cost per head |
| `SALARY_BANDS` | §10 | five bands, employee count and payroll each |
| `TREND` | §11 | monthly / quarterly / yearly buckets |
| `BONUS` | §12 | only employees who drew variable pay |
| `OVERTIME` | §13 | hours and cost, by employee and by department |
| `LEAVE` | §14 | LOP days and cost, flagged `derived` |
| `STATUTORY` | §15 | PF / ESI / PT / TDS / LWF buckets + gratuity |
| `CTC` | §16 | Finance only |
| `REGISTER` | §17 | the master record, with payment date and status |

Salary bands are **data** (`SALARY_BANDS`), not a switch in a component, and
the top band is open-ended so no employee is ever dropped from the chart.

The register reads its payment date and status from `PayrollPayment`. A month
can hold several payment rows for one employee (a failed transfer and a
successful retry); the **PAID** one wins and the employee appears **once**.

---

## 4. Exports (§19)

`GET /export/:reportKey` builds CSV, XLSX or PDF inline.
`POST /export/:reportKey` queues a large one through BullMQ and returns a file
row that the page polls.

The requester's **row scope is stored on the file** (`scopeEmployeeIds`) at
request time, so a background worker can never widen what the person who asked
for it was allowed to see.

Filenames put the month before the period (`payroll-department-2026-08.csv`),
because `...-monthly.csv` is ambiguous the moment two months exist.

---

## 5. Scheduled reports (§20)

A schedule is a MongoDB document with a persisted `nextRunAt`. BullMQ's native
`delay` fires the job; MongoDB remembers when it is next due, so a Redis
restart cannot silently stop a CFO's monthly report. On worker startup
`runDueSchedules()` sweeps anything that is already due, runs it, and re-arms
it — no cron, no `src/jobs`.

Two decisions worth stating:

- **The next run is counted from the run that just happened**, never from
  "now". A schedule executed by hand on the 20th still fires on the 3rd of next
  month instead of repeating the 3rd of this one.
- **The audience is a permission, not a list of people.** `notifyPermission` is
  resolved at run time, so leavers stop being notified and joiners start
  without anyone editing the schedule.
- A schedule that **fails still arms its next run** — one bad month must not
  stop a report forever.

A monthly schedule that fires on the Nth reports on the month that has just
closed, not the month that has barely started.

---

### Notifications (§23)

| Event | Title | Audience |
| --- | --- | --- |
| A queued export finishes | "Payroll report ready" | the person who asked for it |
| A scheduled report is generated | "Scheduled report generated" | everyone who currently holds the schedule's `notifyPermission` |
| The executive dashboard is refreshed | "Executive dashboard updated" | Company Admin and Finance |

The refresh notification has a caveat worth stating: there is no
Company-Admin-only verb, so §23's "Executive Dashboard Updated → Company
Admin" goes to the management audience the brief actually defines — the two
roles holding `PAYROLL_ANALYTICS_FINANCIAL`. It fires from the **worker** (a
background refresh); an inline refresh in a deployment with no Redis is
already on screen, so it does not notify.

## 6. Caching (§21) and background work (§22)

Redis namespace `payroll-analytics` v1, suffixes `dashboard | department |
trend | headcount`. Invalidated by payroll completion, recalculation, final
settlement and statutory update — each through the cache seam those services
already had. MongoDB remains the source of truth; the cache is fail-open.

Three jobs on the **existing** `payroll` queue (no new queue):

| Job | jobId |
| --- | --- |
| `analytics-export` | `analytics-export-{fileId}` |
| `analytics-schedule` | `analytics-schedule-{scheduleId}` |
| `analytics-refresh` | `analytics-refresh-{companyId}-{month}` |

Payloads are references only. `FORBIDDEN_KEYS` rejects any payload carrying a
row, a figure, an employee name or a bank detail — the worker re-reads
everything from Mongo.

---

## 7. Security (§3 / §25)

- `companyId` is never read from the browser; it comes from `req.companyId`.
- `analyticsScope` narrows rows to the actor's 29.1 payroll visibility, inside
  the one reader.
- The CTC report is refused **server-side** without
  `PAYROLL_ANALYTICS_FINANCIAL` — the server is the gate, the hidden UI is only
  a courtesy.
- Every generate, export, schedule and refresh is audited with the company, the
  user, the report key, the timestamp and the format.

---

## 8. Tests — 35 hermetic (`npm run test:analytics`)

No MongoDB, no Redis, no BullMQ. Fake models, a fake cache, and fake
audit / notify / dispatch seams.

Coverage: snapshots-only reads, superseded and errored runs excluded, the eight
KPI cards, department sorting, designation analytics, salary bands, quarterly
buckets, bonus filtering, overtime, derived leave figures, PT/TDS having no
employer share, CTC reconciliation, register payment de-duplication, §18
filters, all three export formats, queued export scope, schedule arming and
re-arming (including re-arming after a failure), cache invalidation,
references-only payloads, the validator chains, tenant isolation and the
Finance-only gate.

`npm run test:all` → **777 pass / 0 fail**.

---

## 9. Seeing it without a database

```powershell
cd Backend
npm run analytics:preview
```

Writes 36 artefacts to `Backend/.preview/analytics/`: every report in CSV, XLSX
and PDF. It also prints the dashboard KPIs, the trend, a scheduled-report run,
the audit trail and two security checks (CTC without financial access, and a
cross-tenant read).

The preview generator found three defects the unit tests had passed straight
over:

1. the register printed `Sat Sep 05` instead of the payment date
2. a schedule created on the 2nd to run on the 3rd armed itself five weeks out
   instead of tomorrow
3. a trend over a year showed a single month, because the fake model's
   `.sort()` was a no-op — which is also a warning about trusting a fake

---

## 10. Fences (§27) — deliberately not built

AI salary prediction, market salary benchmark API, Power BI integration,
government BI portal integration, external accounting sync.
