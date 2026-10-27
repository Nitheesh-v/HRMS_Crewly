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
