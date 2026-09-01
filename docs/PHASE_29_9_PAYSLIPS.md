# Phase 29.9 — Payslip Generation & Employee Salary Portal

> Payroll programme: 29.1 Company Payroll Setup → 29.2 Salary Components →
> 29.3 Salary Structures → 29.4 Employee Payroll Profile → 29.5 Variable Pay &
> Monthly Inputs → 29.6 Payroll Calculation Engine → 29.7 Payroll Review &
> Approval → 29.8 Bank Transfer File & Salary Payment → **29.9 Payslip
> Generation & Employee Salary Portal** → 29.10 Statutory Compliance &
> Government Reports.

Where an approved, paid month becomes **the employee's own document**:

```
Payroll approved (29.7)  ─►  Salary paid (29.8)  ─►  Payslip snapshot
                                                          │
                                          ┌───────────────┴───────────────┐
                                          ▼                               ▼
                                    PDF rendered                   Employee notified
                                    and stored                            │
                                          │                               ▼
                                          └──────────►  My Payroll → Payslips → download
```

**Crewly produces the document; it never recalculates the salary.** Every
figure on a payslip is a copy of the frozen 29.6 snapshot.

**What this phase deliberately does NOT do (§28):**

| Not here | Owner |
|---|---|
| Income tax declaration | later |
| Form 16 | later |
| PF / ESI filing | later |
| Government portal integration | later |
| Final settlement payslip | later |
| Loan statements | later |
| **Any salary calculation** | 29.6 — every figure is copied, never computed |

---

## 1. Spec corrections applied

The same three corrections as 29.5–29.8, plus three new ones.

| The brief said | What was built | Why |
|---|---|---|
| Gate on role names (§4) | Gate on **`PAYSLIP_READ` / `_GENERATE` / `_RELEASE` / `_RERELEASE`** + `PAYSLIP_READ_SELF` + `requireFeature('payroll')` + the 29.1 payroll scope | Roles are per-company data; permissions are the contract |
| — | **`HR_MANAGER` and the finance templates gain `PAYSLIP_READ`**; `SYSTEM_PERMISSION_VERSION` 22 → **23** | §4: HR and Finance view/download |
| "Payroll Status = Paid" (§1) | Gate on the **29.8 payment row**: payslips are cut for employees whose `PayrollPayment` status is `PAID` | A `PARTIALLY_PAID` month then payslips the 142 who were paid instead of blocking on the 3 who failed |
| PDF layout (§8) | Extends the **existing** `utils/payslipPdf.js` (PDFKit is already a dependency); the legacy `streamPayslipPdf()` is untouched | No new dependency, nothing breaks |
| ZIP (§18) | The 29.8 ZIP writer, extracted to `utils/minimalZip.js` and shared | No new npm package |
| `payroll:payslips:{employeeId}` (§23) | `buildTenantCacheKey({ namespace: 'payroll-payslips', version: 1, … })` | 28.7 helper is the single convention |
| BullMQ (§24) | `payslip-generate` / `payslip-zip` / `payslip-email` on the **existing** `payroll` queue; inline fallback | 29.6–29.8 precedent, no new queue |
| Email (§19) | The existing `utils/mailer.js` `sendMail()` gains an optional `attachments` argument | "Do not build another email system" |
| Legacy payslips | `/api/payroll/:id/payslip` and `models/Payroll.js` untouched; a hermetic test guards them | The 29.3 precedent |

### Audit pass — four gaps closed against the re-pasted spec

| § | Gap | Fix |
|---|---|---|
| §6 / §8 | The snapshot stored `logoUrl` but the PDF always drew the initials badge | `utils/companyLogo.js` resolves the bytes (3 s timeout, 2 MB cap, images only, 10-minute cache) and `buildPayslipPdf(snapshot, { logo })` embeds them; no logo, slow host or bad content still draws the badge |
| §4 | "Download payroll register" for the Company Admin was never built | `GET /api/payroll/payslips/register` — a CSV with one row per payslip (gross, earnings, deductions, employer contributions, attendance, masked account, reference, status), written with the same dependency-free CSV builder as the bank file |
| §23 | "Recent Payslip" was not cached | A third cache suffix (`recent`) plus `getMyRecentPayslip()`; the employee portal opens on a "Latest payslip" card |
| §12 | The attendance summary did not show the payroll cycle | The block now leads with `Attendance summary — payroll cycle: MONTHLY`, in the PDF and on screen |

Also wired: the requester now receives a `PAYSLIPS_GENERATED` summary when an
inline generation finishes (the constant existed but nothing sent it).

### A gap this phase found and fixed: the payroll queue had no worker

`registerPayrollProcessors()` existed since 29.6 but **nothing ever called
it**. Every payroll job — 29.6 runs, 29.7 exports, 29.8 bank files — was
enqueued and then silently handled by the API's inline fallback, because no
process consumed `QUEUE_NAMES.PAYROLL`. `parsePayrollWorkerConcurrency()` and
`PAYROLL_WORKER_CONCURRENCY` were written for it and never used.

`src/workers/index.js` now registers the payroll processors and starts a
payroll worker with its own connection. 29.9 needs it: §17 says "avoid
generating hundreds of PDFs synchronously", which only holds if something is
there to do the work.

---

## 2. The snapshot (§6) — written once, never recomputed

```js
{
  company:  { name, address, pan, tan, logoUrl },
  employee: { employeeId, employeeCode, name, department, designation,
              joiningDate, bankName, accountNumberMasked, uan, pan },
  payroll:  { month, monthLabel, cycle, paymentDate, payslipNumber },
  salary:   { grossSalary, totalEarnings, totalReimbursements,
              totalDeductions, netSalary, totalEmployerContributions },
  earnings: [...], variableEarnings: [...], reimbursements: [...],
  deductions: [...], employerContributions: [...],
  attendance:{ workingDays, presentDays, paidDays, lopDays, overtimeHours },
  payment:  { paymentDate, method, bankName, accountNumberMasked, reference },
  generatedAt, snapshotVersion
}
```

Sources, in order: `PayrollResult` (29.6, `isCurrent` snapshot) →
`EmployeePayrollProfile` (29.4, masked bank) → `PayrollPayment` (29.8) →
`PayrollSetup` legal info + `Company` (29.1).

**§22 — regeneration re-renders the stored snapshot.** It never re-reads
payroll data. If the company moves office, changes its logo or re-runs the
month, a regenerated payslip shows the *new* logo on the *old* numbers. The
service computes a `valuesUnchanged` fingerprint and the UI surfaces it.

---

## 3. Backend files

| File | Role |
|---|---|
| `src/services/payroll/payslipRules.js` | **Pure** rules: statuses + transitions, payslip numbers, the snapshot builder, the values fingerprint, filters, dashboard counters, file names, email and notification copy |
| `src/services/payroll/payslipService.js` | Tenant-safe orchestration behind a DI factory (cache / audit / notify / mail / dispatch / pdf / zip / hash all injected) |
| `src/services/payroll/payslipCache.js` | Namespace `payroll-payslips`, version 1, suffixes `employee` and `dashboard` |
| `src/services/payroll/payslipDispatcher.js` | Three payload validators + dispatchers; salary, bank, PDF and ZIP keys are **rejected** |
| `src/models/Payslip.js` | Unique `{companyId, employeeId, month}` and `{companyId, payslipNumber}`; the PDF is stored with the record |
| `src/models/PayslipFile.js` | Bulk archive artefacts: status, progress, processed/total, binary |
| `src/utils/payslipPdf.js` | Existing PDFKit module, **extended** with `buildPayslipPdf(snapshot)`; the legacy `streamPayslipPdf()` is untouched |
| `src/utils/minimalZip.js` | The 29.8 ZIP writer, extracted and shared |
| `src/controllers/payslipController.js`, `src/routes/payslipRoutes.js`, `src/validators/payslipValidator.js`, `src/middlewares/payslipScope.js` | Thin controller, 14 routes, server-side validation, 29.1 scope |
| `src/workers/payrollProcessor.js` | `payslipGenerateProcessor`, `payslipZipProcessor`, `payslipEmailProcessor` |
| `src/workers/index.js` | Now starts the payroll worker (see §1) |

### Route table — 15 routes at `/api/payroll/payslips`

| Method | Path | Permission | Section |
|---|---|---|---|
| GET | `/register` | `PAYSLIP_READ` | §4 |
| GET | `/mine` | `PAYSLIP_READ_SELF` | §14 |
| GET | `/mine/:payslipId` | `PAYSLIP_READ_SELF` | §16, §25 |
| GET | `/mine/:payslipId/pdf` | `PAYSLIP_READ_SELF` | §16 |
| GET | `/dashboard` | `PAYSLIP_READ` | §27 |
| GET | `/` | `PAYSLIP_READ` | §15, §27 |
| POST | `/generate` | `_GENERATE` + `checkWriteAccess` | §17 |
| POST | `/email` | `_RELEASE` + `checkWriteAccess` | §19 |
| POST | `/bulk-download` | `PAYSLIP_READ` + `checkWriteAccess` | §18 |
| GET | `/bulk-download` | `PAYSLIP_READ` | §18 |
| GET | `/bulk-download/:fileId` | `PAYSLIP_READ` | §18 |
| POST | `/:payslipId/email` | `_RELEASE` + `checkWriteAccess` | §19 |
| POST | `/:payslipId/regenerate` | `_RERELEASE` + `checkWriteAccess` | §22 |
| GET | `/:payslipId/pdf` | `PAYSLIP_READ` | §16 |
| GET | `/:payslipId` | `PAYSLIP_READ` | §16 |

The `/mine/*` routes take **no employee id at all** — the controller reads
`req.user._id`. That is the strongest form of the §26 rule: the value a
caller could tamper with simply is not part of the request.

---

## 4. The PDF (§8)

`buildPayslipPdf(snapshot)` returns a `Buffer`. Sections, in order:

1. **Header** — company badge/name, address, PAN/TAN, "Payslip — August 2026",
   cycle, payslip number
2. **Employee details** — code, name, department, designation, joining date,
   UAN, PAN, bank, **masked** account, payment mode
3. **Attendance** — led by the payroll cycle, then working days, present
   days, paid days, LOP, OT hours (§12)
4. **Earnings** — every component separately, then Total Earnings (§9)
5. **Reimbursements** — only when present
6. **Deductions** — every component separately, then Total Deductions (§10)
7. **Company Contributions** — employer PF, ESI, gratuity, labelled
   "do NOT reduce your Net Pay" (§11)
8. **Salary summary** — gross, deductions, net
9. **Payment information** — date, mode, bank, masked account, reference (§13)
10. **Footer** — payslip number, generated date, "System generated — no
    signature required"

**Company logo (§6 / §8).** The snapshot stores the URL; the bytes are
resolved by `utils/companyLogo.js` at render time and passed in as an option,
so the PDF module stays a pure function of its inputs. The resolver is
fail-open (timeout/cap/type checks), caches for ten minutes — a bulk run of
5,000 payslips fetches the logo once — and never touches the network when the
company has no logo. Without a logo the header falls back to the initials
badge, exactly as the legacy slip does.

---

## 5. Frontend

| Page | Path | Audience |
|---|---|---|
| `PayslipsPage.jsx` | `/app/payroll/payslips` | Payroll / HR / Finance — dashboard, generate, list, preview, email, regenerate, bulk download |
| `MyPayslipsPortalPage.jsx` | `/app/payroll/my-payslips` | Employee — history, filters, preview, download, print |
| `PayslipDocument.jsx` | shared | The on-screen payslip: print styles, download, all §16 sections |

Sidebar: **Payroll → Payslips** (any `PAYSLIP_*` permission) and
**Payroll → My Payroll** (`PAYSLIP_READ_SELF`).

The legacy **My Payslips** entry (`/app/payslips`, pre-29.9 `models/Payroll`
records) is left exactly where it is — same decision 29.3 made for the legacy
salary structure API.

---

## 6. Security (§26)

- **Tenant isolation** — every query carries `companyId`; a foreign company's
  payslip is a 404, and no audit read is even issued.
- **Employee isolation** — `PAYSLIP_READ_SELF` routes carry no employee id;
  the scoped admin routes narrow by the 29.1 payroll scope.
- **Masked accounts** — `buildPayslipSnapshot` copies only
  `accountNumberMasked`; the encrypted number is never selected into a payslip
  (a test asserts the plaintext never appears in the serialized snapshot).
- **Queue payloads** — the dispatcher rejects any payload carrying `payslips`,
  `snapshot`, `earnings`, `deductions`, `netSalary`, `accountNumber`, `pdf`,
  `binary` or `attachments`. PDFs are rendered *inside the worker*.
- **Immutability** — regeneration re-renders the stored snapshot and reports
  `valuesUnchanged`; the audit log records every regeneration.

---

## 7. Tests

```powershell
cd Backend
npm run test:payslip    # 28 tests  (new, hermetic)
npm run test:payroll    # 29.1 → 29.9   → 298
npm run test:all        # 664
```

Hermetic: fake models plus fake cache / audit / notify / mail / dispatch /
pdf seams — no MongoDB, no Redis, no BullMQ, no SMTP, no PDF renderer.

What the suite proves:

- the snapshot freezes company, employee, salary, attendance and payment
- every earning and deduction stays separate (§9, §10) and employer
  contributions never reduce the net (§11)
- the plaintext account number never reaches a payslip
- payslips are only cut for PAID salaries, and a partially paid month payslips
  only those who were paid (§15)
- payslip numbers are unique inside the company (§7)
- generation is queued with a references-only payload
- regeneration cannot move a rupee, even when payroll data changes underneath
- an employee sees only their own payslip; another company sees nothing
- downloads count and are audited
- the email carries the PDF and records failures instead of skipping silently
- the ZIP is a real archive (`PK`) and a department scope holds only that
  department; a queued archive cannot be downloaded early
- filters work by month, year, financial year and search
- every one of the five audited actions is recorded

---

## 8. What 29.10 gets

- A permanent, per-employee, per-month salary record with the full
  earnings/deductions/employer-contribution breakdown — the exact input a
  statutory report needs.
- Company PAN/TAN and employee UAN/PAN already on the snapshot.
- Payment references and payment dates, ready for reconciliation.
- **Explicitly left open:** Form 16, tax declarations, PF/ESI filing,
  government portals and settlement payslips.
