# Payroll surfaces — Center & Salary Architecture

Two Stitch exports were re-cut onto live payroll responses. No backend code
changed; every block either reads an endpoint or names the one it would need.

| mock | route | file |
| --- | --- | --- |
| `code.html` — Payroll Processing & Payslip Hub | `/app/payroll` | `PayrollPage.jsx` |
| `code (1).html` — Configuration & Salary Architecture | `/app/payroll/components` | `SalaryComponentsPage.jsx` |

Endpoints used: `/payroll/runs/:month` (+ `/results`, `/results/:employeeId`,
`/run`), `/payroll/review/:month`, `/payroll/review/:month/export/:reportKey`,
`/payroll/payments/dashboard`, `/payroll/payments/:batchId/audit`,
`/payroll/payments/:batchId/...`, `/payroll/setup`, `/payroll/components`,
`/payroll/components/defaults`, `/payroll/salary-structures`,
`/payroll/salary-structures/preview`, `/payroll/payslips/mine`,
`/payroll/payslips/mine/:id`, `/payroll/inputs/periods`,
`/attendance/analytics/overview`, `/departments`.

Both pages sit on the `st-` token set and are pinned by
`test/payrollSurfaces.test.js` (14 pins).

---

## 1. Payroll & Compensation Center — `/app/payroll`

Hero + month/cycle strip → four KPIs → filter/export row → the employee
register → payslip summary and disbursement gateway (with the batch audit
trail). A right-hand drawer opens one employee's stored calculation.

| mock block | rendered | why |
| --- | --- | --- |
| `CYCLE OPEN` pill | the monthly-input **period status** (`Inputs locked`, `Collecting inputs`, …) | the period is the thing that actually gates a run |
| `Time & Leave Synced: 242 Present • 18 Absent • 12 Half-days` | `attendance/analytics/overview → totals.dayCounts` for the same month | real reconciliation counts, linked to the attendance page |
| `Biometric Logs Active` | **Punch sources** — `sources.counts` (`OFFICE`, `KIOSK`, `QR`, `IMPORT`, …) | the platform does not know whether a device is "active"; it knows where punches came from |
| `Total Outflow ₹18,45,200` | `Σ totals.netPay + Σ statutory employer lines` | labelled as net + employer statutory |
| `Statutory Pool` (PF / ESI / PT / TDS) | the `STATUTORY` lines inside each result | the engine's own split, never re-derived in the browser |
| `LOP & Absence 5 days` | `Σ attendance.lopDays` + the `LOP` deduction line | both numbers come from the snapshot |
| `Disbursement Status` | `payments/dashboard` → first batch status + transaction counts | the batch is the money movement; the run is the calculation |
| `Safe to re-run · PAID records are locked` | "Each re-run writes a new result version; payment stamps live in their own ledger" | accurate: results version, payments are a separate ledger |
| `Generate & Execute Payroll` | `POST /payroll/runs/:month/run`, gated on `PAYROLL_RUN_EXECUTE` | and it says who holds the permission when you don't |
| Employee table (gross / PF / PT / TDS / LOP / net) | the same columns, read from each row's `deductions[]` codes + `totals` | plus department, designation and engine warnings |
| `Bank .TXT`, `Summary XLSX`, `Form 16 ZIP` | bank file (batch, `PAYROLL_PAYMENT_GENERATE`), salary summary export (`PAYROLL_RUN_REVIEW`), and **Form 16 — not configured** | no Form 16 archive endpoint exists |
| Quick Payslip & Tax Summary | `payslips/mine` latest card + `mine/:id` snapshot lines + archive downloads | self-service only; shows the composition bar from real line amounts |
| `View YTD Computation` | link to the payslip portal | the YTD view lives there |
| Bank Authorization Gateway + `Authenticate & Disburse` | masked bank details from `/payroll/setup`, batch ledger, **Confirm & mark paid** gated on `PAYROLL_PAYMENT_MARK_PAID` / `_CONFIRM` | and a paragraph stating there is no hardware-key or dual-admin token: authorisation is permission + audit |
| `Direct Corporate Disbursement 2-FA / Secure Token Ready` | dropped; the permission model is printed instead | not implemented |
| `Audit Trail Event Log` | `payments/:batchId/audit` entries (action, actor, role, from→to, reason, time) | the real trail, newest first |
| `Balance ₹42,80,000.00`, `CIN/PAN/TAN ✓ Validated` | not rendered on this page | the setup page owns legal identity; no balance endpoint exists |

## 2. Salary Structures & Statutory Configuration — `/app/payroll/components`

Hero + two actions → tab bar (components ↔ statutory/bank setup ↔ structures) →
setup completion strip (four sections) → filtered component catalogue grouped
into earnings / deductions / employer contributions → right rail with the live
CTC builder and the configuration check.

| mock block | rendered | why |
| --- | --- | --- |
| `Compliance Engine Active` / `Karnataka SMR Rev 2024.3` | `Engine active`/`draft` from `/payroll/setup` status, `N statutory rules on`, and an explicit **No rule revision badge** chip | rates live in the engine; no revisioned statutory notice is published |
| `Payroll Setup Completion: 4/4` + `100% Compliant` | `evaluation.completedCount / totalCount` + the saved-section bar | "complete" means valid **and** saved; the word "compliant" is not claimed |
| Legal entity / Statutory / Calendar / Disbursement cards | `config.legal`, `config.statutory`, `config.payrollPolicy`, `config.bankAccount` (masked) | every line is stored configuration, with Configure/Manage → setup |
| `Category 1: Earnings` etc. | components grouped by `category`, active counts, per-card chips for code, tax treatment and PF/ESI/PT/TDS basis | the catalogue response, paginated and filtered server-side |
| `Formula: 50% of Total CTC` | `calculationCopy()` from `calculationType` / `percentage` / `calculationBase` | reads the stored fields |
| `Live CTC Salary Structure Builder` (₹12,00,000, slider) | `POST /payroll/salary-structures/preview` with the selected structure's items and a sample gross | the API prices it; the rail says nothing is stored |
| `92.2% Efficiency` | `netPay ÷ gross` of the preview response | labelled "of sample gross" |
| `Employer contributions… credited separately` | the preview's employer lines + their total | informational, never a deduction |
| `Save as Standard Engineering Structure`, `Assign to 8 Employees` | links into the structures workspace | assignment is audited there; it is not a button on this page |
| `Automatic Compliance Check Passed (Code on Wages 2019)` | **Configuration check** — `evaluation.warnings`, each with its own message | a structural check, explicitly not a legal opinion |

---

## What remains unbacked

Compliance-engine revision stamps, MCA/NSDL/EPFO verification badges, bank
gateway balance, hardware security key or dual-admin 2-FA confirmation, Form 16
archive, confidence percentages, and any claim that "PAID records are locked
against recalculation" (they are not — results are versioned, payments are a
separate ledger). Each is either absent with a stated reason or replaced by the
narrower real fact.

## Verification

`npm test` → 692 passing (14 new pins), `npm run build` green,
`npx eslint src` → 117 problems (103 errors, 14 warnings), below the
121-problem baseline. No browser is available in this environment, so the
surfaces were verified by lint, build and source pins — not pixel comparison.

---

# Payroll navigation — three areas, one tab strip each

Payroll had seventeen routes and fifteen sidebar rows. That is not a section of
an HR product; it is a second product stacked under one word, and it pushed
every other module below the fold. The owner asked for the Settings screen's
pattern instead: a few entries in the rail, and the pages inside an area
presented as a horizontal tab strip at the top of the page.

## What the rail shows now

| row | lands on | tabs inside |
| --- | --- | --- |
| **Payroll** | `/app/payroll` | Payroll center · Monthly inputs · Run payroll · Review & approval · Salary payment · Analytics & reports |
| **Salary architecture** | `/app/payroll/components` | Components & rules · Structures · Statutory & compliance · Company setup |
| **Payslips** | `/app/payroll/payslips` | Payslip workspace · Final settlement · My payslips *(you)* · My settlement *(you)* |

Four rows instead of sixteen (the group header plus three areas), and the rail
no longer scrolls to reach Recruitment.

## One definition, two readers

`src/config/payrollNav.js` is the only place a payroll destination is named.
`layout/AppLayout.jsx` derives the sidebar rows from it; `components/payroll/
PayrollSectionTabs.jsx` derives the strip from it. A page therefore cannot be
reachable one way and invisible the other.

Every tab carries the permission array its old sidebar row carried, verbatim —
`SALARY_COMPONENT_READ|MANAGE|ACTIVATE` for Components & rules, and so on — so
the move changed the shape of navigation and nothing about who may go where. An
area appears in the rail only if the person holds at least one permission for
at least one of its tabs; a tab they cannot open is not drawn. The strip stays
hidden until permissions have loaded, so nobody sees the layout reflow.

The strip is wrapped around every payroll route in `AppRoutes.jsx`
(`inPayroll(...)`), which is also why a new payroll page cannot ship without a
way to reach it: the route file and the config are pinned together by
`test/payrollNavigation.test.js`.

## Consequences worth naming

- **The breadcrumb had to learn a new source.** It used to take the page name
  from the sidebar entry that owned the path. Those entries are gone, so
  `utils/breadcrumb.js` now reads `PAYROLL_PAGE_TITLES` — the same words the
  tabs use. Detail views that are not tabs (an employee's payroll record, each
  `/app/payroll/analytics/*` sub-report) are named there explicitly rather than
  falling back to "Payroll".
- **Detail views keep their parent tab lit** (Payroll variance lights Analytics
  & reports; an employee record lights Payroll center). The stripe is a
  position indicator, not a route table.
- **Self-service tabs are marked `you`.** "My payslips" and "My settlement" sit
  in the same strip as company-wide payslips because they belong to the same
  question. The marker is what stops them reading as a company-wide view.
- **The old `/app/payslips` door now forwards.** The role menus carried a
  "My Payslips" row to a thinner standalone list; the Payslips area's *My
  payslips* tab is the same idea with the real portal behind it. Keeping both
  would have put two payslip doors in one sidebar, so `/app/payslips` redirects
  to `/app/payroll/my-payslips` (bookmarks and the dashboard link keep
  working) and the duplicate page is gone. Payroll paths are also removed from
  the role menus — a second "Payroll" row beside the three area rows is exactly
  the duplication this change set out to remove.
- **No backend, schema or permission changed.** Frontend only.

## Verification

`npm test` → 710 passing (9 new pins in `test/payrollNavigation.test.js`;
Time & Leave now uses the same strip — see `docs/AREA_NAVIGATION.md`),
`npm run build` green, `npx eslint src` → 117 problems (103 errors, 14
warnings) — exactly the pre-change baseline. No browser is available here, so
this is verified by lint, build and source pins, not by screenshot.

---

# The three stage surfaces — Inputs · Cockpit · Disbursement

Re-cut to the three supplied exports (`code.html`, `code (1).html`,
`code (3).html`):

| export | route | page |
| --- | --- | --- |
| Monthly Payroll Inputs | `/app/payroll/inputs` | `MonthlyInputsPage.jsx` |
| Payroll Calculation Cockpit | `/app/payroll/run` | `RunPayrollPage.jsx` |
| Direct Salary Disbursement | `/app/payroll/salary-payment` | `SalaryPaymentPage.jsx` |

They are three views of one pipeline, so they share one shell —
`components/payroll/PayrollCockpit.jsx`: the stage band, the four-step cycle
strip, the KPI tiles, the panels and the right-hand rail. Two consequences worth
stating: the same four steps are named the same way on all three pages, and a
change to the tab/card language lands in all three at once.

The wiring did not change. Every figure still comes from the endpoint the page
already called (`monthlyInputService.list`, `payrollRunService.summary` +
`.results`, `payrollPaymentService.dashboard` + `.batch`), and none of the three
computes a salary or a statutory rate in the browser.

## Monthly inputs — what the export drew, what is real

| export block | rendered | why |
| --- | --- | --- |
| `Cycle Stage 01 of 04 · Locking Required to Advance` | same words, driven by the period status | the four stages are fixed and the period records which one is open |
| `Synced 5 mins ago via BioHub Sync` | dropped; the import button says **Sync attendance & leave** and reports what it wrote | there is no BioHub device feed; attendance arrives from the ledger |
| `01. Monthly Inputs · Active` + three padlocked steps | the same four steps; 02 becomes active only once the month is locked | the engine refuses to run while inputs are open |
| Payroll period / cycle window / working days | `period.month`, `financialYear`, `cycleStart`–`cycleEnd`, `workingDays` | all stored by Company setup |
| `Employees · Ready & Clear · Needs Review · Variable Pay · Claims Total · LOP Days` | the same six, from `meta.summary` | one field per card, no arithmetic beyond a sum the server already did |
| `AI Input Health 98%` ring | **Input readiness** — `ready ÷ employees`, the ring filled to that ratio | nothing scores input health; a ratio of two returned numbers is the honest version |
| `All 12 timecards matched` | `finalizedCount of rows` — rows whose LOP came from a finalized attendance version | that is the only "matched" signal the data carries |
| Pre-lock checklist (`0 this month`, `4.5 Days`, `₹1,45,000`, `3 of 4`) | the same four rows from `summary` (`pending`, `totalLopDays`, `totalBonus`, `claimsPending`) | every line is a count or a sum of the month's own rows |
| Company payroll policy | payroll month, FY, working days, lock stamp | the export's "claims close on the 25th" is a policy nobody configured here |
| Variable Pay Distribution (65/25/10) | the month's entries summed by category (BONUS / INCENTIVE / COMMISSION) | computed from the rows, labelled as this month's entries |
| Biometric Integration (`352 swipe events`) | LOP days, overtime hours and the finalized-attendance count | the ledger knows hours and days, not device events |
| Statutory & Deductions (`Scheduled for Stage 02`) | same, plus the recoveries entered on this page | statutory amounts are the engine's, not this screen's |

## Calculation cockpit — what the export drew, what is real

| export block | rendered | why |
| --- | --- | --- |
| `Snapshot: v1.0 (Locked 10m ago by …)` | `snapshot v{run.version} · calculated {finishedAt}` | both are on the run document |
| `Engine Status: Ready & Synchronized` + `Code on Wages 2019 Compliant` | `engine {status}` from the run itself; no compliance badge | nothing certifies compliance; the run status is a fact |
| Step 1 locked & verified → step 2 active, 3–4 locked | derived from `inputsLocked` and the presence of a snapshot | the same rule the backend applies |
| `Inputs Verified & Formulas Harmonized` | green when locked, amber with a link to inputs when not | the pre-check is real and blocking |
| Six KPIs (scope, compute status, audit validation, gross, net, statutory overhead) | the same six from `run.summary` | one field each, including `employerCost` for overhead |
| `Formula Set 2026.4 Active … EPF @ 12 %` | a link to **Salary architecture**, where the rules actually live | the engine reads the stored rule set; there is no printable "formula set" number |
| Table: paid/total days, LOP docked, base gross, variable, reimb., deductions, net, status | the same columns from the snapshot | PF / ESI / PT / TDS in the deduction line are `deductions[].statutory` |
| `Allocation matrix (net 86.1 % / EPF 8.8 % / TDS 5.1 %)` | the same three bands, summed from the snapshots | percentages are computed from the month's own totals |
| `Statutory Compliance Health Check · All Clear` (EPFO cap, PT slabs, 115BAC, biometric locks) | **Calculation health check** — scope, errors, warnings, lock state, plus "this is not a legal opinion" | the per-rule ticks would be invented verdicts; the counts are not |
| `Proceed to Review & Approval` | the same, plus `← Back to inputs` | the hand-off is what this page is for |

## Disbursement — what the export drew, what is real

| export block | rendered | why |
| --- | --- | --- |
| `Approved by Leadership • Ready for Bank Execution` | the newest batch's status pill | approval is a recorded state, not a slogan |
| `BATCH-CRW-202610-09` card | the newest batch's real `batchNumber` and month | one batch, named once |
| `Create Payment Batch` | same, behind `PAYROLL_PAYMENT_GENERATE` | unchanged |
| `Download Bank Transfer File` | downloads the newest batch's newest file; disabled with the reason when there is none | a file has to be generated first |
| `Authorize Direct API Disbursement (2-FA)` | replaced by a stated badge: **file handoff — no bank gateway connected** | there is no gateway, no OTP and no key custody in this product |
| Six KPIs (`total, paid, pending, bounced, retry, gateway A/C ••••8402 ₹48,50,000`) | the first five from `paymentKpis`; the sixth is **Bank files generated** | a bank float does not exist in the API and must not be printed |
| Batch table (id, scope, net, mode, status, scheduled date) | the same columns from the batch summary | mode is the bank file, the only mode this product has |
| Recipient roster (masked accounts, `Verified`) | the newest batch's payments, `accountNumberLast4` + IFSC | the roster is a real read; the mask is what the API returns |
| `Corporate Banking Node · CONNECTED` + float + `Liquidity Pre-Check Passed` | **Bank connectivity** panel: gateway not connected, file generated?, downloaded? | the connection does not exist; liquidity cannot be known without it |
| `Enterprise Compliance & Security Shield` (TLS envelope, dual-admin quorum, NPCI) | **What is recorded** — audit trail, masked accounts, per-employee outcomes | those three are true; the other three are claims with nothing behind them |
| `Alternate Disbursement Export` (HDFC CMS .txt / ICICI bulk .csv) | the batch's actual generated files, by format and date | bank-specific templates are not shipped; the file carries the shared columns |

## Statutory compliance — what the export drew, what is real

| export block | rendered | why |
| --- | --- | --- |
| `FY 2026–27 … reconciled for October 2026` | `monthLabel` + `financialYearLabel` + paid count + cycle, all from the dashboard | the FY label is stored, not inferred |
| `Download All (.zip)` | **Register** button (the FY register export) + CSV / XLSX / PDF on the filing summary | there is no zip bundle endpoint |
| `Generate Reports · Remind` | the same two actions, behind their own permissions | unchanged |
| Four type cards (`PF`, `ESI`, `PT`, `TDS`) with `Ready to file` / `Filed` / `Draft` | one card per **applicable** scheme — PF, ESI, PT, TDS, LWF and gratuity — each with its payable and the filing status the register holds | `applicability` from Company setup decides which exist; the badge is the recorded status, not a readiness claim |
| `12 members enrolled` · `4 eligible staff` · `State slabs unified` · `Form 24Q Stage` | `<n> employee(s) with PF / under ESI / in a PT slab …` from `summary.<type>.employees` | one field per line; the export's adjectives are not fields |
| `ECR Validated` · `Challan Ready` · `Receipt #9042` | dropped | nothing validates an ECR or issues a challan in this product |
| `Compliance Filing Summary` (component, employee share, employer share, total, due date, action) | the same seven columns, from `summary` + the month calendar, with a **Total obligations** footer that excludes the gratuity provision | PT / TDS have no employer share and the table says `—`; gratuity is a provision, named separately |
| `Payroll Locked` badge | the page's own sentence: figures are read from the locked snapshot | the lock is a real state, but the export's stamp is not a field |
| `October Filing Readiness Checklist · 2 of 3` | **Filing readiness** — reports generated, returns filed, overdue returns, employees paid, gross payroll | five derived states from two responses; no checklist is stored, so the export's three invented rows are gone |
| `Filing Status & Due Dates` timeline (`Due in 10 days`) | the month calendar rail: due date, `daysRemaining` / overdue, filing status, the statutory note | `statutoryDueDate` + `daysUntil` are the server's arithmetic |
| `Statutory Preparedness Index 72%` | dropped | no such index exists; a computed percentage of it would be an invention |
| `Recent Filings Ledger` (3 months, `Challan #PF-8831`) | the newest six months of the register: month total, employees, gratuity, per-type filing pills, per-month CSV download | the register has no challan numbers |
| `Challan complies strictly … EPFO 2026 formats` | a footer stating that filing is a human record entered after the portal, and that no return is claimed as filed by Crewly | the product records attestations; it does not file |
| `Aadhaar & PAN master databases` | dropped | no such validation exists |

## Executive payroll dashboard — what the export drew, what is real

| export block | rendered | why |
| --- | --- | --- |
| `October 2026 · Finalized` | the period preset label, the month and `period.fromMonth → toMonth` | the window travels with the response |
| `Export PDF · Excel Export` | one `ExportMenu` (CSV / XLSX / PDF / queued) on the `st-` scale | the same exporter the other fourteen reports use |
| `Total Payroll Cost ₹18.45 L · Gross + benefits` | `kpis.totalPayrollCost`, hint = gross + employer contribution | both halves are returned fields |
| `Net Disbursed · 100% Disbursed · 12 Staff Paid` | `kpis.netSalaryPaid` + the paid headcount | "100 % disbursed" is not a field; the count is |
| `Avg Salary / Employee · Monthly median ₹1.28L` | `kpis.averageSalary` + cost per paid head, plus the change vs the previous window | the API returns a mean, never a median, so no median is printed |
| `Statutory Liability ₹2.14 L · Reconciled · Zero Pending` | `kpis.totalStatutoryLiability` + employee / employer split; the filing state lives on the statutory page | "zero pending" is a filing fact, not an analytics field |
| `Department Cost Breakdown` (bars, `6 staff`, `60.7%`) | the same bars from `departments[]`: total cost, share of the shown departments, staff, average salary | share is the only arithmetic, and it is stated as a share of the table |
| `Cost allocation corresponds to verified engineering weights` | dropped | there are no allocation weights |
| `Cost Movement & Variance` (joiner impact, overtime, LOP) | the real decomposition: headcount effect (joiners/leavers), like-for-like (fixed + variable), then a table of bonus / overtime / reimbursement / LOP deltas against `previousSummary` | every line is a `movement` or summary field |
| `Within Safe Budget Target · Projected cap +5.0% · Actual +2.5% · Optimal` | the reconciliation strip: the two effects add up to `movement.total` **or** the page says they do not add up and warns against quoting either | no budget cap is configured, so no verdict is drawn |
| `Quick Statutory Position · All Cleared` | the liability buckets (employee / employer / total), the gratuity provision and its annualised exposure, plus a link to the statutory summary | "all cleared" is a filing state; the buckets are the liability |
| `Key Reports & Downloads` (four download cards) | the fifteen analytics reports as links, each with one honest line of what it contains | the four export cards name reports this product has, under their real routes |
| — | **Other cost lines** strip: overtime, bonus, reimbursements, LOP, deductions, settlements | the export hides nine returned fields; the strip shows them without nine more cards |
| — | **How this page knows**: snapshot path, window, calculated / errored counts, accuracy | a reader can audit the page without leaving it |

## Salary structures — what the export drew, what is real

| export block | rendered | why |
| --- | --- | --- |
| `Compliant with Code on Wages (India) 2024` | dropped | no compliance certification exists |
| Tab strip (Components & Rules / Structures / Statutory / Company Setup) | the payroll area rail + in-page nav already carries these destinations | one door per destination; a second strip would duplicate it |
| `Add Indian Standard CTC` | **Add Indian standard CTC** — pre-fills Basic 50 % of the sample gross, HRA 40 % of Basic, special allowance as the remainder, PF and employer PF at 12 %, using only components this company has, and names the ones it skipped | a starting point, not a policy; PT is deliberately not guessed because the slab is state-specific |
| `Create Structure` | **Create structure**, behind `SALARY_STRUCTURE_MANAGE` | unchanged |
| `Active Structures 3 · Templates Ready` | active count + templates on file | both from the list response |
| `Assigned Employees 12 / 12 · 100% Mapped` | assigned / active employees with the coverage share, read from the employee pay profiles (`structureId`) | the structure API's own `usage.employees` is a placeholder, so the assignment is read where it is actually stored |
| `Statutory Compliance 100% · Wage Code Pass` | **Unassigned employees** and **Components available** | there is no per-structure compliance score; these two are real counts |
| Search + `All Statuses (Active)` | the same filters, applied over the one tenant read (the API caps it at 100) | the server's own `filterStructures` rules, restated |
| Structure template card: name, tier band, `Take-Home Efficiency 91.5%`, `CTC Distribution` bars, avatar cluster, `View Assigned Staff (8)` | name / code / version / effective date, take-home share (`netPay ÷ gross`) and employer cost + CTC from the **server preview** at the sample gross, a stacked distribution of the earning lines, the assigned count from the profiles, `Edit` / `Duplicate` / `Activate` and `View staff` | every amount is `computeStructurePreview` output at one stated gross; the export's ₹10–25 L tier band, the avatar cluster and the efficiency verdicts are not on the list response |
| `Low Friction · Tax-optimized HRA` · `Performance · Annualized Bonus` | dropped | marketing labels with nothing behind them |
| `New Salary Structure` modal (tier band, `Basic ≥ 50% CTC`, `Pre-filled Standard India CTC`) | the existing builder: name, code, designation, effective date, component rows with method and value, and a live server preview | the builder is the product's own; the tier band is not a field |
| `Need custom components?` card | a cross-link to **Salary components** | the same destination |
| `Subscription Notice · trial expires in 4 days` | not drawn | plan state belongs to billing, not payroll |

## Full & final settlement — what the export drew, what is real

The export is a dense command centre. This pass keeps its blocks and deliberately
drops the second layer of detail: five counters, one queue, one breakdown, one
clearance checklist.

| export block | rendered | why |
| --- | --- | --- |
| `Cross-functional offboarding clearances, statutory gratuity audits…` | one sentence: every rupee is calculated by the server from the exit record and the frozen snapshot | states the rule, not a promise |
| `Admin Console · Exiting Employee View` | dropped | both are separate destinations; the sidebar already carries them |
| `Register (XLSX) · Initiate New Settlement` | `Register`, `Export XLSX`, `New settlement` (behind `FINAL_SETTLEMENT_CALCULATE`) | unchanged actions |
| Five cards (pending, HR & dept review, finance approval, paid & disbursed, settlement pool incl. escrow) | the same five from `settlementKpis`, minus the escrow line | there is no escrow; `totalSettlementAmount` is what is committed |
| `Active Settlements Queue` (exit timeline, notice status, earned leave, gratuity, workflow state) | name, role/department/code, last working day, clearances `n/4`, net settlement, status, `Open` | the export's per-row gratuity and notice columns need a detail read per row; the queue stays one line per person and the breakdown panel carries the money |
| `Itemized Settlement Audit` (pro-rated salary, leave, gratuity, bonus accrual, PF, TDS, bank route) | **Latest settlement, line by line** — pending salary (with payable days), leave encashment (with days), gratuity (with eligibility), manual payables, total earnings; notice shortfall, itemised recoveries, total recoveries, net payable and the payment stamp | every line is a stored field; the bank route is not on the settlement and is not drawn |
| `Department Clearance Sign-off` (four named people, timestamps) | **Clearances** — the four checklist items with their real done/open state | the checklist stores four booleans, not a person per box |
| `Statutory SLA Window (30 Days from LWD) · Day 4 / 30` | dropped | no SLA window is configured or stored |
| `Escrow allocated` | dropped | no escrow exists |

## Payroll setup — what the export drew, what is real

The export draws a four-step onboarding with a confidence score. This pass keeps
the four steps, the progress bar and the per-step facts; every assurance badge is
gone.

| export block | rendered | why |
| --- | --- | --- |
| `Offboarding … Onboarding Engine · Auto-save active · 2 mins ago` | nothing; saving is stated on the wizard where it happens | there is no autosave heartbeat to display |
| `Setup Progress 3 / 4 Done` ring | `evaluation.completedCount / totalCount` as a percentage, in the band | the evaluator is the server's own completeness check |
| `Compliance Confidence 92%` · `8% pending bank handshake` | dropped | no such score is computed anywhere |
| `Step 01 · Company & Legal Entity · Configured & Verified` with CIN / PAN / GSTIN / registered base | the same step card with legal name, PAN / TAN and city / state | those are the legal fields the configuration stores; CIN and GSTIN are only shown when configured |
| `KYC Verified against NSDL & MCA Portal` | dropped | no registry lookup exists |
| `Step 02 · Statutory Regulations & Acts` (EPF ceiling, ESI rates, PT slabs, gratuity formula) | schemes switched on, the PF establishment number and the PT state, from the saved statutory block | the rates live in the statutory engine, not on this page |
| `Step 03 · Payroll Policy & Biometric Cut-off` (14 devices online) | frequency, cycle and salary date | there is no device fleet; the cut-off is a policy field |
| `Step 04 · Disbursement Bank Account · Connect Bank Account` (HDFC / ICICI CMS, tokenised maker-checker, ISO-27001) | bank name, masked account and IFSC, plus `View / edit` | Crewly generates a bank file; it does not connect to a bank |
| `Audit readiness · Estimated Go-Live 15 minutes · 148 active records` | **Section checklist** (four real states) and **Company on record** | both are reads; the estimates were never stored |
| Bottom bar `Run Test Calculation · Finalize & Launch Payroll` | the existing activate / suspend actions, with their permission gates | activation is a real state change, so it keeps the real button |
| `Subscription Notice · trial expires in 4 days` | not drawn | plan state belongs to billing |

## Payslips — what the export drew, what is real

The export is a studio with a ZIP workshop, a delivery scoreboard and a
self-service preview. This pass keeps the counters, the list and one archive
strip: five numbers, one row per person, one ZIP.

| export block | rendered | why |
| --- | --- | --- |
| `Cycle Closed & Reconciled · Batch #CRW-PAY-202610-A` | the month and the generated / total count | a payslip batch is derived from the payment batch; the page states what it holds |
| `Email All Statements · Generate Payslips · Export Register` | `Generate payslips`, `Email month`, `Register`, with their permission gates | unchanged |
| Five counters (net disbursed, generated, emailed, downloaded, delivery failures) | the same five from `summary` | the export's `100% cleared via RTGS`, `Bounce Rate 0.0%` and `SMTP Verified` lines are not fields |
| `Bulk ZIP Generation & Packaging Studio` (`AES-256 Enabled`, `Password Protected`, `3.4 MB`, previous bundles) | **Bulk archive** — scope selector, `Build ZIP`, the newest archive with its payslip count and stamp, and a count of older ones | the archive endpoint returns a file and a status, not encryption or a byte size |
| `Disbursement & Payslip Matrix` (gross, deductions, net, status per employee) | one row per person: name / code / department, net with gross and payment date, status pill, `PDF` (and `Email` / re-render where permitted) | the deductions column is inside the payslip itself, so the list stays scannable |
| `Self-Service Experience` panel with a full payslip preview | the existing payslip modal (`PayslipDocument`) opens from the row | one preview, on demand, instead of a second copy on the page |
| `Copy Staff Self-Service Direct Link` | dropped | no such link is issued |
| `Statutory Compliance Check (Form 12A, ESIC, cryptographic timestamp)` | dropped | the snapshot is the record; nothing certifies those formats |
| `Process Initialized · Consolidated archive queued` toast | the existing inline "archive is being prepared" strip | one status line, where the archive lives |

## Verification

`npm test` → **744 passing**, including 12 new pins in
`test/payrollOffboardingStudio.test.js`: all three pages use the shared kit, the
settlement counters and queue read the dashboard, the breakdown is the same
`fnfService.get` read the detail tab uses, setup progress is the evaluated
section count with masked bank details, payslip rows carry the frozen net and
the archive panel shows one archive instead of a table — and none of the three
prints escrow, NSDL, AES-256, SMTP, bounce-rate or compliance-confidence claims.
`npm run build` green. `npx eslint src` → **109 problems (98 errors, 11
warnings)**, seven fewer than the previous checkpoint because the replaced dense
blocks carried their own unused code.

No browser is available in this environment: verified by lint, build and source
pins, not by pixel comparison.
