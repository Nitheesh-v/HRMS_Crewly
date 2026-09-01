# Phase 29.10 — What was built and how to test it

Audience: the developer picking this up on a machine with MongoDB and Redis.
Everything in PART 2 runs anywhere with just Node.

---

# PART 1 — What has been implemented

## Statutory Compliance & Government Reports (new)

**Payroll → Statutory Compliance** (`/app/payroll/statutory`) — nine tabs.

| Tab | What it does | § |
|---|---|---|
| Overview | The consolidated compliance summary + the 12-month compliance register | 13, 16 |
| PF | PF wages, employee PF, employer EPF, employer pension, employer PF, total + filing | 7 |
| ESI | Gross wages, employee ESI, employer ESI, total + filing | 8 |
| PT | State-wise collection (state from Payroll Setup, never hardcoded) | 9 |
| TDS | PAN, regime, taxable income, TDS, annual tax + department summary | 10 |
| LWF | Employee / employer / total — hidden when 29.1 has LWF off | 11 |
| Gratuity | Base, monthly provision, annualised liability — reporting only | 12 |
| Annual | Five FY reports, queued generation + download history | 18 |
| Calendar | Filing deadlines, overdue flags, per-task tick-off, reminders | 19 |

Seven KPI cards: PF, ESI, PT, TDS, LWF payable, filing pending, filing
completed.

## Brief corrections applied

- **§4 roles → permissions.** New verb `PAYROLL_STATUTORY_FILING`; Payroll
  Admin generates, Finance files, HR Manager reads only.
  `SYSTEM_PERMISSION_VERSION` 23 → 24.
- **§5 eight pages → nine tabs** under one sidebar entry.
- **§2/§6** gated on `PayrollPayment.status === 'PAID'`, reusing 29.9's
  predicate.
- **§9** PT state from 29.1; slabs stay in 29.6; the UI hardcodes neither.
- **§19** due dates are data in `FILING_DUE_RULES`, not UI logic.
- **§21** queue payloads carry references only; forbidden keys are rejected.

## The key design decision

**Figures are never stored — the workflow is.** Every rupee is re-derived from
the 29.6 snapshot on every read, so a payroll recalculation cannot leave a
stale statutory number. The stored document holds status, filing reference and
who attested what. A filed return whose figures move is **reopened**, not
silently left "Filed".

## Also fixed along the way

- **29.9 defect:** `payslipService` queried `EmployeePayrollProfile` by
  `userId` instead of `employeeId`, so **every payslip's UAN and PAN were
  blank**. Fixed (and now filters `isCurrent: true`).
- **PDF paise:** `Rs 550.50` was printing as `Rs 551`. Fixed — paise print only
  when they exist.
- **PDF column widths:** a 12-digit UAN wrapped onto a second line. Fixed.

---

# PART 2 — What the automated tests already prove

```powershell
cd Backend
npm run test:statutory          # 35 hermetic tests
npm run test:payroll            # 339 — the whole payroll series
npm run test:all                # 705 — the whole product
```

No MongoDB, Redis, BullMQ or SMTP is needed for any of it.

What the 35 statutory tests pin down:

- **§19** due dates (PF 15th, ESI 15th, TDS 7th, PT 20th), December rolling the
  year, and no date for the internal compliance summary.
- **§18** `monthsOfFinancialYear` with an April **and** a January start.
- **§15** `financialYearOf` follows the company's FY start month.
- **§14** the transition table in both directions; `FILED → READY` refused.
- **§11** LWF and gratuity vanish when 29.1 switches them off.
- **§6** a row is a copy of the snapshot's statutory block, not a calculation.
- **§7–§12** the roll-up — employee and employer never mixed; PT state-wise;
  TDS by department; gratuity annualised.
- **§5** KPI pending/completed counting (gratuity excluded — it is not a
  return).
- **§2/§6** an unpaid month is blocked; a FAILED transfer is excluded while the
  paid employees still report.
- **§6** generation writes one report per applicable type, all starting DRAFT.
- **§14/§20** a FILED return whose figures moved is reopened.
- **§14/§25** filing records who/when plus `previousValue` → `newValue`;
  calendar task auto-completes; the notification fires.
- **§14** illegal transitions refused; filing an ungenerated report refused;
  gratuity is not filable.
- **§15** CSV / XLSX / PDF carry identical figures (`PK` signature, `%PDF-`
  signature).
- **§10 / §16 / §13** TDS department summary; the compliance summary covering
  every block; the 12-month register CSV.
- **§18** annual roll-ups per employee and per month; annual needs an FY,
  monthly needs a month.
- **§18** annualisation credits only the months an employee was paid.
- **§19** calendar content, task completion + audit, reminder targeting,
  overdue detection.
- **§17** the employee view leaks no bank field.
- **§3/§24** another tenant's data is unreachable.
- **§20** the cache is dropped after generation and after a filing update.
- **§21** payloads carrying `rows` / `grossPayroll` are rejected.
- **§15/§26** a real rendered PDF carries the company PAN, the period and the
  "not a filed return" footer.

---

# PART 3 — Manual testing

## Before you start

The statutory workspace only has data after salaries are **paid**:

```
# 1. Run Payroll         -> /app/payroll/run            -> execute the month
# 2. Review Payroll      -> /app/payroll/review         -> lock, submit, approve
# 3. Salary Payment      -> /app/payroll/salary-payment -> batch, file, Mark all paid
```

Then:

```powershell
# Terminal 1 — backend
cd Backend; npm run dev

# Terminal 2 — worker (needed for queued generation and annual reports)
cd Backend; npm run worker:dev

# Terminal 3 — frontend
cd Frontend; npm run dev
```

Log in as a **Company Admin** or **Payroll Admin**, then open
**Payroll → Statutory Compliance**.

## A. Generate and read the month

1. Pick the payroll month; confirm the header shows the month, the FY and the
   paid-employee count.
2. **Generate reports.** Expect a banner naming how many reports were written.
3. Check the seven KPI cards. PF payable must equal
   `employee PF + employer PF` for the month.
4. Open the **PF** tab. Every covered employee appears with their UAN; the
   TOTAL row matches the KPI.
5. Open **ESI**. Only employees inside the wage ceiling appear.
6. Open **PT**. The state comes from Payroll Setup — confirm it is *your*
   company's state, not Karnataka-by-default.
7. Open **TDS**. Confirm the department summary totals to the same figure.
8. Open **LWF** and **Gratuity**. Gratuity should show a monthly provision and
   an annualised liability.

## B. Exports (§15)

Per report tab, press **CSV**, **XLSX** and **PDF** in turn:

- CSV opens in Excel with a header row and a TOTAL row.
- XLSX opens without a "file is corrupt" warning.
- PDF shows: company name + address, PAN/TAN/PF/ESI registration numbers, the
  report title and period, a KPI strip, the table, a TOTAL row, and the footer
  *"not a filed government return and requires no signature"*.
- Cross-check one figure across all three: they must be identical.

Then open the **Overview** tab and press **Register** — a 12-row CSV, one row
per month of the FY.

## C. Filing lifecycle (§14)

As **Finance Manager** (or Company Admin):

1. PF tab → select **Reviewed** → Update status. Badge turns to Reviewed.
2. Select **Ready** → Update. Then **Filed**, with a portal reference such as
   `ECR-2026-08-000412`.
3. Try to move Filed PF back to **Ready** — you should get an error. Filed
   returns must be **Reopened** first.
4. Reopen it, then file it again.
5. Open **Gratuity** — there is no filing panel. It is a report, not a return.
6. Confirm the notification "…was marked as filed" reaches Company Admin.

## D. Annual reports (§18)

1. Open the **Annual** tab, set the FY (e.g. `2026-27`).
2. Check the five KPI cards and the month-by-month register.
3. Press **Annual PF Summary** — a row appears under *Generated files* with a
   progress percentage, then **READY**.
4. Press **Download**; the XLSX opens with one row per employee and a
   `Months` column. An employee who joined mid-year must **not** show 12.
5. Repeat for the other four annual reports.

## E. Calendar (§19)

1. Open **Calendar**. Expect one row per applicable type per month, each with a
   due date (PF/ESI 15th, TDS 7th, PT 20th, LWF 15th, Gratuity 31 Mar).
2. Past months show **overdue**; the counters at the top must match.
3. Tick a task off — it flips to *Completed* and is audited.
4. Press **Remind** on the main header — finance holders receive an in-app
   notification for each overdue or due-soon, not-yet-filed return.

## F. Employee statutory view (§17)

As an **employee**:

1. Open **My Payroll**. A "Statutory details" card shows PAN, UAN, ESI number,
   PF member, PT state, tax regime, gratuity eligibility, TDS applicability —
   read-only, with a line for what was deducted this month.
2. There is no edit control anywhere on that card.

As **HR / Payroll**:

1. Open **Payroll → Employees → one employee → Statutory**.
2. Change the month box — the "deducted this month" panel follows it.

## G. Permissions (§4)

| Role | Expect |
|---|---|
| Company Admin | Everything. |
| Payroll Admin | Generate reports; **no** filing panel. |
| Finance Manager | Filing panel and calendar tasks; **no** Generate button. |
| HR Manager | Read-only everywhere; no Generate, no filing panel. |
| Employee | No sidebar entry at all; only the My Payroll statutory card. |

## H. Tenant isolation (§3 / §24)

In a second browser as a user of another company: navigate directly to
`/app/payroll/statutory` with a month that has data in company A. Expect a
"Statutory access required" screen, or an empty month — never company A's
figures.

## I. Audit (§23 / §25)

Check the audit log for the month. Expect, each with `complianceType` and
previous/new status:

`STATUTORY_REPORT_GENERATED` · `STATUTORY_REPORT_DOWNLOADED` ·
`STATUTORY_FILING_STATUS_UPDATED` · `STATUTORY_REPORT_REOPENED` ·
`COMPLIANCE_CALENDAR_TASK_UPDATED` · `COMPLIANCE_REMINDER_SENT`

---

# PART 4 — Known limitations

- **No government integration, by design.** No EPFO/ESIC/income-tax portal, no
  Form 16, no Form 24Q, no digital signature. Crewly prepares; humans file.
- **Compliance reminders are on demand.** There is no cron sweeping every
  company nightly; a user presses **Remind**, or a scheduled job can be wired
  to `dispatchComplianceReminder`.
- **PT slabs are a working approximation** of the states Crewly ships with,
  held in 29.6's `PROFESSIONAL_TAX_SLABS`. Finance should review them when 29.1
  records a state.
- **TDS has no declarations.** 29.4 stores a declaration *status* only, so
  Chapter VI-A deductions are zero — as in 29.6. Declarations are 29.9's fence
  and remain unbuilt.
- **Gratuity is a provision, not a settlement.** The annualised figure is
  `monthly × 12`; there is no per-employee gratuity ledger.
- **Statutory reports are company-wide.** A return is filed for the
  establishment, not for a team, so the 29.1 scope does not narrow these
  totals — access is controlled purely by permission.
