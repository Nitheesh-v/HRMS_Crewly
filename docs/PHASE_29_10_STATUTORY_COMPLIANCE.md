# Phase 29.10 — Statutory Compliance & Government Reports

**Status:** complete · **Branch:** `arena/01a05672-hrms-crewly`
**Tests:** 35 hermetic (`npm run test:statutory`) · **Full suite:** 705/705 (`npm run test:all`)
**Frontend:** `vite build` clean.

Crewly **prepares** statutory returns. It never submits them, never talks to a
government portal, and never verifies a filing — a human attests that the
filing happened, and Crewly stores that attestation (§26).

---

## 1. Spec corrections applied

The brief is not authoritative where it conflicts with existing architecture —
the same standing rule that shaped 29.5–29.9.

| § | Brief says | What was built and why |
|---|---|---|
| 2 / 6 | "Salary Paid → Generate" | Gated on `PayrollPayment.status === 'PAID'`, reusing 29.9's predicate (`isPaidForStatutory`) rather than restating the rule. A partially paid month reports every employee who was paid. |
| 4 | Role names (Payroll Admin, Finance Manager, HR Manager) | Permission + 29.1 scope, as in 29.9. The catalogue already declared `PAYROLL_STATUTORY_READ/_GENERATE/_MANAGE` for this phase; **one new verb was added: `PAYROLL_STATUTORY_FILING`**. Separation of duties: Payroll Admin *generates*, Finance *files*, HR Manager **READ only**. `SYSTEM_PERMISSION_VERSION` 23 → 24. |
| 5 / 25 | Eight separate pages | One sidebar entry (**Payroll → Statutory Compliance**) with nine tabs. Standing constraint: full features, small sidebar. |
| 9 | "Don't hardcode one state's rules" | The PT state comes from 29.1 `statutory.professionalTax.state`; the slabs stay in 29.6's `PROFESSIONAL_TAX_SLABS`. The UI prints neither — it shows the state and the collected amount. |
| 11 | LWF | Hidden entirely (nav tab, report, KPI) when 29.1 has it off. Gratuity likewise. |
| 12 | Gratuity | Monthly provision **and** annualised (×12) liability. No settlement — that is 29.11's fence. |
| 19 | Calendar | Due dates are **data** in `FILING_DUE_RULES` (PF 15th, ESI 15th, TDS 7th, PT 20th, LWF 15th of the following month; Gratuity annual 31 Mar), never a component. |
| 21 | "Do not calculate payroll in BullMQ" | Three jobs carry **references only**; `FORBIDDEN_KEYS` rejects any payload smuggling `rows`, `summary`, `pan`, `uan` or a rupee figure. |
| 26 | — | EPFO / ESIC / income-tax portals, Form 16, Form 24Q, digital signatures: **not built**, as instructed. |

### The one design decision worth arguing about

**Figures are never stored. The workflow is.**

A `StatutoryReport` document holds status, filing reference, who filed and
when — but every rupee is re-derived from the immutable 29.6 `PayrollResult`
snapshot on every read. So:

- a payroll recalculation cannot leave a stale statutory figure behind;
- two reports can never disagree with each other or with the payroll;
- there is exactly one source of truth, and it is already immutable.

The stored `summary` is a frozen copy used only to answer *"what did the
reviewer see at the time?"* — and to detect that a **filed** return's numbers
have since moved, which **reopens** it rather than silently leaving it "Filed".

### A defect found in 29.9 while building this

`payslipService.loadGenerationContext` queried `EmployeePayrollProfile` by
`userId`, but the 29.4 model's field is `employeeId`. The lookup never matched,
so **every payslip's UAN and PAN were blank**. Fixed here (and the query now
also filters `isCurrent: true`) because 29.10 depends on the same join.

---

## 2. Backend files

| File | Role |
|---|---|
| `src/services/payroll/statutoryRules.js` | Pure: statuses, transitions, due dates, FY maths, row building, the one roll-up, every export table, calendar, annualisation. |
| `src/services/payroll/statutoryService.js` | Orchestration. Injected models/cache/audit/notify/dispatch/pdf/writers, so the phase is testable with no MongoDB, Redis, BullMQ or SMTP. |
| `src/services/payroll/statutoryCache.js` | `payroll-compliance` namespace, version 1 (§20). Seven suffixes so a month-scoped change also drops the cross-month keys. |
| `src/services/payroll/statutoryDispatcher.js` | Three jobs on the **existing** `payroll` queue, references-only payloads, deterministic job ids. |
| `src/models/StatutoryReport.js` | One row per company + month + type — the filing record. |
| `src/models/StatutoryExport.js` | Queued export files (annual / large Excel / PDF). `binary` is `select: false`. |
| `src/models/ComplianceCalendarTask.js` | The calendar's own tick-box; derived `dueDate`, never client-supplied. |
| `src/utils/statutoryPdf.js` | PDF renderer — draws only, shares the payslip PDF's design language. |
| `src/controllers/statutoryController.js`, `src/routes/statutoryRoutes.js`, `src/validators/statutoryValidator.js`, `src/middlewares/statutoryScope.js` | HTTP layer. |
| `src/workers/payrollProcessor.js` | Three new processors registered on the payroll worker. |
| `src/config/queueConfig.js` | `STATUTORY_GENERATE`, `STATUTORY_EXPORT`, `COMPLIANCE_REMINDER` + `PAYROLL_JOB_NAMES`. |
| `scripts/statutoryPreview.js` | `npm run statutory:preview` — real artefacts, no database. |

### Route table — 16 routes at `/api/payroll/statutory`

| Method | Path | Gate | § |
|---|---|---|---|
| GET | `/mine` | `EMPLOYEE_SALARY_READ_SELF` | 17 |
| GET | `/employees/:employeeId` | read | 17 |
| GET | `/dashboard` | read | 5 |
| POST | `/generate` | `PAYROLL_STATUTORY_GENERATE` | 6, 21 |
| GET | `/export` | read | 15 |
| GET | `/register` | read | 13 |
| GET | `/history` | read | 13 |
| GET | `/annual` | read | 18 |
| POST | `/annual/export` | `PAYROLL_STATUTORY_GENERATE` | 18, 21 |
| GET | `/exports` | read | 18 |
| GET | `/exports/:exportId` | read | 18 |
| GET | `/calendar` | read | 19 |
| POST | `/calendar/tasks` | `PAYROLL_STATUTORY_FILING` | 19 |
| POST | `/calendar/reminders` | `PAYROLL_STATUTORY_GENERATE` | 19, 22 |
| GET | `/reports/:type` | read | 7–12, 16 |
| PATCH | `/reports/:type/status` | `PAYROLL_STATUTORY_FILING` | 14 |

`read` = any of `PAYROLL_STATUTORY_READ / _GENERATE / _MANAGE / _FILING` +
`requireFeature('payroll')` + statutory scope.

### Filing lifecycle (§14)

```
DRAFT ──▶ REVIEWED ──▶ READY ──▶ FILED ──▶ REOPENED ──┐
  └──────────────────────┘         ▲                   │
                                   └───────────────────┘
```

`FILED → READY` is refused: a filed return must be reopened first. Gratuity and
the compliance summary are **reports, not returns** — filing them is a 400.

---

## 3. Reports

| Report | Source | Employee columns |
|---|---|---|
| PF (§7) | `statutory.pf` | code, name, **UAN**, PF wages, employee PF, employer EPF, employer pension, employer PF, total |
| ESI (§8) | `statutory.esi` | code, name, **ESI number**, gross wages, employee ESI, employer ESI, total |
| PT (§9) | `statutory.professionalTax` | state-wise: state, employees, collected |
| TDS (§10) | `statutory.tds` | code, name, **PAN**, department, regime, taxable income, TDS, annual tax + department summary |
| LWF (§11) | `statutory.lwf` | code, name, employee LWF, employer LWF, total |
| Gratuity (§12) | `statutory.gratuity` | code, name, department, base, monthly provision, annualised liability |
| Compliance summary (§16) | the roll-up | payroll summary, PF, ESI, PT, TDS, LWF, gratuity |

Annual (§18): Annual PF, Annual TDS, Annual Payroll Register, Annual Employer
Contribution, Department-wise Payroll — all rolled up from the same monthly
rows, with `months` counting only the months an employee was actually paid.

Exports: **CSV** and **XLSX** via 29.8's dependency-free writers (no new npm
package), **PDF** via `utils/statutoryPdf.js`. All three share one header set
and one row builder per report, so they cannot diverge.

---

## 4. Frontend

| File | Role |
|---|---|
| `src/pages/payroll/StatutoryCompliancePage.jsx` | Nine tabs: Overview, PF, ESI, PT, TDS, LWF, Gratuity, Annual, Calendar. |
| `src/services/statutoryService.js` | API client. No salary figure is ever sent from the browser. |
| `src/routes/AppRoutes.jsx`, `src/layout/AppLayout.jsx` | `/app/payroll/statutory` + a permission-driven nav entry. |
| `src/pages/payroll/MyPayslipsPortalPage.jsx` | §17 employee self-service statutory card (PAN, UAN, ESI, PF member, PT state, regime + what was deducted). |
| `src/pages/payroll/EmployeePayrollDetailPage.jsx` | §17 statutory tab gains PT state, regime and a "deducted this month" panel per month. |

Buttons are permission-gated in the UI *and* re-checked server-side: Finance
sees "Filing status is updated by Finance" where HR sees the control, and HR
sees the read-only view.

---

## 5. Security (§24 / §26)

- **Tenant isolation** — `companyId` from the tenant context only; every query
  is company-first; the unique index is `{companyId, month, type}`.
- **RBAC** — three verbs, 29.1 scope resolution, `requireFeature('payroll')`.
- **Immutable snapshots** — no report recalculates anything.
- **Queue payloads** — references only; `FORBIDDEN_KEYS` rejects a payload
  carrying `rows`, `summary`, `pan`, `uan`, `grossPayroll`, `binary`…
- **No bank data** — the compliance layer never reads an account number at all;
  the employee statutory view is asserted to contain no `account`/`ifsc` field.
- **Audit (§23/§25)** — generated, downloaded, filing updated, reopened,
  reminder sent, calendar task updated — each with `complianceType`,
  `previousValue` and `newValue`.
- **Cache (§20)** — invalidated on generate, filing update, calendar change and
  export; Redis stays fail-open and MongoDB stays the source of truth.
- **PDF footer** — states in print that the document is *not* a filed return
  and requires no signature.

---

## 6. Tests — 35 hermetic

`npm run test:statutory` (included in `test:payroll` and `test:all`).

Coverage: due dates and year rollover; FY maths with a company-specific start
month; the transition table in both directions; applicability hiding LWF and
gratuity; row building from the snapshot; the roll-up (employee vs employer
never mixed); KPI pending/completed counting; the payment gate; generation
writing one report per applicable type; **a filed return whose figures moved is
reopened**; filing audit with previous/new status; illegal transitions;
CSV/XLSX/PDF parity on the same figures; state-wise PT; department TDS; the
compliance summary; the 12-month register; annual roll-ups; annualisation
counting only paid months; the calendar; task completion; reminder targeting;
employee view leaking no bank data; **cross-tenant denial**; cache
invalidation; **queue payload rejection**; a real PDF's rendered text; and the
history/register row shape.

---

## 7. Seeing it without a database

```powershell
cd Backend
npm run statutory:preview
```

Real rules, real CSV/XLSX/PDF writers, fake in-memory models — no MongoDB,
Redis, SMTP or worker. Writes to `Backend/.preview/statutory/` (gitignored):

- seven monthly reports as CSV **and** XLSX
- the compliance summary and the PF register as **PDF**
- the 12-month compliance register CSV
- five annual reports as XLSX

…then prints the KPI cards, the filing lifecycle, the calendar, the annual
roll-up, the audit tally, and a bank-detail sweep over every artefact plus a
cross-tenant read check.

**Run it after any change to a statutory report.** In 29.9 the equivalent
script caught two defects that all 34 unit tests passed straight over.

### Two defects it caught here

1. **Paise were being dropped.** Employer EPF of `550.50` printed as `Rs 551`
   — on a return finance reconciles to the rupee. `inr()` now prints paise only
   when they exist, so `1,800` still reads as `1,800`.
2. **The UAN column wrapped.** A 12-digit UAN broke across two lines in the PDF
   register. Column weights are now driven by the header name.

---

## 8. What 29.11 gets

Statutory reports are complete, so **Phase 29.11 — Loans, Advances & Employee
Recovery Management** can build on:
the paid-salary gate, the snapshot-as-source-of-truth pattern, the
`StatutoryExport` queued-file shape, the three-verb RBAC split, and the
`payroll-compliance` cache namespace.

Still fenced and **not** built: EPFO/ESIC/income-tax integration, Form 16,
Form 24Q, digital signatures, bank reconciliation, final settlement.
