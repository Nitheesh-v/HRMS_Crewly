# Phase 29.13 — Analytics extensions: manual testing checklist

Automated: `npm run test:analytics` (63 tests), `test/platformAnalytics.test.js`
(6 tests), `npm run test:all` (**807 pass / 0 fail**), `npm run analytics:preview`
(54 artefacts). This checklist is what a human still has to look at — the
things a unit test cannot see.

Run the stack first:

```powershell
# terminal 1
cd Backend; npm run dev
# terminal 2
cd Frontend; npm run dev
```

Analytics reads data every earlier phase owns, and 29.13 extends 29.12 rather
than replacing it. If you have not tested 29.12, do that first.

---

## 0. Before you start

- [ ] `npm run test:all` in `Backend` reports **807 pass / 0 fail**.
- [ ] `npm run test:analytics` reports **63 pass / 0 fail**.
- [ ] `node --test test/platformAnalytics.test.js` reports **6 pass / 0 fail**.
- [ ] `npm run analytics:preview` completes and leaves 54 files in
      `Backend/.preview/analytics/`.
- [ ] The preview's bank-number scan says **"none — clean"**.
- [ ] `cd Frontend; npx vite build` completes with no error.
- [ ] Payroll → **Analytics & Reports** is still **one** sidebar entry. Open it
      and confirm the inner nav now lists **fifteen** destinations, not nine.

---

## 1. The six new reports (§11, §12, §13, §18, §20, §21)

Open each page. For all six:

- [ ] The period label in the header matches the month selected.
- [ ] Export → CSV downloads, and the numbers in the CSV match the numbers on
      screen.
- [ ] Selecting a department filter changes the figures **and** the label.

**Earnings** `/payroll/analytics/earnings`

- [ ] Fixed earnings + variable + overtime + reimbursements equals the total
      in the footer. If the reconciliation banner appears, the payroll runs
      have earnings without named lines — that is a data question, not a
      frontend bug; note it.
- [ ] The share percentages in the table add up to roughly 100.

**Deductions** `/payroll/analytics/deductions`

- [ ] Statutory + LOP + other equals total deductions.
- [ ] Search the register for an employee with TDS and confirm the same figure
      appears here.
- [ ] Loss of pay is listed under LOP, **not** under statutory — LOP is salary
      never earned, not a remittance.

**Employer Contribution** `/payroll/analytics/employer`

- [ ] PF employer share and gratuity both appear.
- [ ] Gratuity is shown **alongside** the remittable contributions, with the
      footnote saying it is a provision. It is not inside the remittable total.
- [ ] Nothing on this page appears in any net-pay figure anywhere else.

**Reimbursements** `/payroll/analytics/reimbursement`

- [ ] Categories, employees and month all agree with the total.
- [ ] An employee with no claims does not appear in the "by employee" table.

**F&F analytics** `/payroll/analytics/fnf`

- [ ] Every settlement in the register appears, with its status.
- [ ] A **DRAFT** settlement is listed but is not counted as money — check the
      completed count excludes it.
- [ ] Net settlement on this page equals the net settlement on the 29.11 F&F
      page for the same employee. These must never disagree: this page is
      read-only over 29.11.

**Payroll Variance** `/payroll/analytics/variance`

- [ ] Every line carries a direction word: increasing, decreasing or stable.
- [ ] Employees paid shows a **count** (4, 5) and not a rupee figure.
- [ ] Difference = current − previous on at least three lines, checked with a
      calculator.
- [ ] Switch to **Last 12 months**. Confirm the previous window is also twelve
      months — the comparison is never a year against a month.

---

## 2. Executive dashboard (§3, §4, §5, §9)

- [ ] Thirteen cards render, including the five new ones: Employee
      Deductions, Overtime Cost, Bonus, Reimbursements, LOP Deduction.
- [ ] The LOP card is visually flagged when it is non-zero, and not flagged
      when it is zero.
- [ ] **Period presets:** select Current FY. The subtitle names the window
      (e.g. "Apr 2026 – Mar 2027") and every card changes together.
- [ ] Select **Custom**, set April 2027 → March 2028 (a period with no
      payroll). The page shows zeros, not last year's numbers.
- [ ] Select **Previous Month** and confirm the month dropdown is still
      visible; select **Current FY** and confirm it is replaced by the range.
- [ ] **Why the cost moved:** joiners + stayers + leavers is consistent with
      the headcount you see in the register, and the note says the two effects
      reconcile. If it says they do NOT reconcile, stop and investigate before
      quoting any figure.
- [ ] Press **Refresh**. A banner confirms either "refreshed" or "queued", and
      the cards reload.

---

## 3. Payroll Register (§22)

- [ ] With more than 25 rows, a pager appears below the table.
- [ ] Go to the last page. The footer totals are **unchanged** — they are the
      whole period, not the page.
- [ ] Type a colleague's name in the search box. The list narrows **and**
      returns to page 1.
- [ ] Search for a salary amount, e.g. `62000`. Result: **zero rows**. Payroll
      is not searchable by what someone earns.
- [ ] Search for a department name. It matches.
- [ ] The two money columns are different numbers: **Gross** (total earnings)
      and **Structure Gross** (the PF/ESI wage base). For an employee with
      overtime they must differ; for one with none they may match.
- [ ] **Basic**, **Employer cost**, **Payroll status** and **Designation**
      columns are all populated.
- [ ] **History** link on a row opens that employee's salary history, with
      their name in the header.
- [ ] Filter by **Employment** → Inactive. Only inactive employees appear.
- [ ] Filter by **Salary structure**. Only employees on that structure appear.
- [ ] Confirm there is **no** pay-group, location or cost-centre filter. That
      is deliberate: no collection carries them.

---

## 4. Employee Salary History (§23)

- [ ] "What they were paid" shows one row per month, newest first.
- [ ] "What they were contracted to be paid" shows the version chain, newest
      first, with **v1 still present** — a revision never overwrites the one
      before it.
- [ ] Exactly one version is marked **Current**.
- [ ] The CTC change between first and latest matches the difference between
      the two versions' annual CTC.
- [ ] Log in as a manager scoped to two departments and open the history of an
      employee in a third. The page shows the access-denied card and the
      network tab shows a **403**, not an empty table.
- [ ] The audit log records "Employee salary history viewed" with the employee
      id — and **no salary figures**.

---

## 5. Salary bands (§8)

- [ ] Open Salary Distribution. **Edit bands** is visible with
      `PAYROLL_ANALYTICS_SCHEDULE` and hidden without it.
- [ ] Change the top band's floor and save. The distribution re-renders using
      the new ranges immediately.
- [ ] Try to give the **last** band a ceiling. The field is disabled — the top
      band is always open-ended, so nobody above the scale is left uncounted.
- [ ] Try to save two overlapping bands. The save is **refused with a
      message**, not silently accepted.
- [ ] Try to delete bands until only one remains. The remove button disables
      at two.
- [ ] Log in as a second company. Its bands are **unchanged** — they are per
      company, not global.
- [ ] The total headcount across all bands still equals the headcount on the
      dashboard.

---

## 6. Super Admin platform metrics (§2)

- [ ] As Super Admin, open
      `GET /api/super-admin/dashboard/payroll-analytics`.
- [ ] The payload has `generatedAt`, `window`, `adoption`, `processing`,
      `jobs` and `privacy`.
- [ ] `privacy.includesPayrollAmounts` is **false**.
- [ ] Read the whole payload top to bottom: there is **no employee name and no
      rupee figure** anywhere in it.
- [ ] As a **company** admin, the same URL returns 403.
- [ ] Companies using payroll is a count of companies, not of employees.

---

## 7. Export expiry (§38)

- [ ] Generate a register export. It appears under Generated files.
- [ ] Read the file's `expiresAt` — it is set, not empty.
- [ ] Wait for the sweep (or run it) and confirm the file's status becomes
      **EXPIRED**.
- [ ] Click Download on the expired file. It is **refused**, and the refusal
      says why.
- [ ] A file that has not expired still downloads and opens.

---

## 8. Permissions (§34)

- [ ] `SYSTEM_PERMISSION_VERSION` is still **26**. No migration ran, and no
      new permission appears in Settings → Roles & Permissions.
- [ ] An **HR Manager** (no `PAYROLL_ANALYTICS_FINANCIAL`) can open every
      report except CTC.
- [ ] Salary history is reachable by a role holding
      `EMPLOYEE_SALARY_READ` **or** `PAYROLL_REPORT_READ`.
- [ ] An employee opening `/app/payroll/analytics/salary-history/:someoneElse`
      gets 403.
- [ ] An employee opening `/app/payroll/analytics/employee-history/mine` — if
      exposed in the UI — sees only their own history.

---

## 9. Performance (§29 / §44)

On a machine with MongoDB:

```powershell
$env:PAYROLL_SNAPSHOT_SCAN_LIMIT = "200000"
MONGO_URI="mongodb://localhost:27017/crewly_bench" npm run analytics:benchmark
```

- [ ] The run does **not** print "Database: NOT REACHABLE". If it does, the
      numbers are Node-only and must not be quoted.
- [ ] `Route used for the plain dashboard` is **AGGREGATION**.
- [ ] `Route used with a payment filter` is **ROWS**.
- [ ] `Same gross either way` is **yes**. If it says NO, the two paths
      disagree — that is a bug in the product, not in the harness, this time.
- [ ] Record the 1,000 and 10,000-employee timings in
      `docs/PHASE_29_13_ANALYTICS_EXTENSIONS.md` §3, replacing the fake-mode
      table.
- [ ] Confirm the benchmark cleaned up after itself: no bench company left in
      `payrollresults`, `payrollpayments` or `users`.

---

## 10. Cross-format agreement

- [ ] Generate the **register** as CSV, XLSX and PDF. Open all three. The
      gross, deduction and net figures are identical across formats.
- [ ] In the PDF, the headcount is a **number**, not a rupee figure. (This was
      a real bug in 29.13: every column was being formatted as money. A new
      count column must be named once in `isMoneyColumn` / `COUNT_HEADERS`,
      or it silently becomes currency.)
- [ ] The PDF carries the company name, the report title, a repeating table
      header across pages and a row count in the footer.
- [ ] Check the six new reports in PDF too — not just CSV.

---

## 11. Known gaps — do not file as bugs

- **No loan or advance ledger.** 29.11 F&F `ADVANCE_SALARY` and `LOAN_EMI`
  recovery lines are typed by hand with nothing behind them. Out of scope for
  this phase ("there is no loan process in this payroll"); a future loan
  module is the fix.
- **No pay-group, location or cost-centre filter.** No collection carries
  them. Fenced, not invented.
- **The benchmark's fake mode is not a prediction of Mongo.** It prints
  "Database: NOT REACHABLE" for a reason.
