# Phase 29.8 — Bank Transfer File & Salary Payment Preparation

> Payroll programme: 29.1 Company Payroll Setup → 29.2 Salary Components →
> 29.3 Salary Structures → 29.4 Employee Payroll Profile → 29.5 Variable Pay &
> Monthly Inputs → 29.6 Payroll Calculation Engine → 29.7 Payroll Review &
> Approval → **29.8 Bank Transfer File & Salary Payment Preparation** →
> 29.9 Payslip Generation & Employee Salary Portal.

Where an approved payroll becomes **a file the company's bank understands**,
and where finance records what the bank actually did:

```
Approved payroll (29.6/29.7)
        │
        ▼
 Payment batch  ──►  validate bank details  ──►  generate CSV / XLSX
        │                    │                          │
        │                    │ invalid employees        │ finance uploads the
        │                    │ are excluded             │ file to their OWN
        │                    ▼                          │ banking portal
        │             validation report                 ▼
        └──────────►  mark paid / mark failed  ◄── bank result, entered by hand
                              │
                              ▼
                     retry batch (only the unpaid)
```

**Crewly prepares — the bank pays.** Nothing in this phase moves money, calls
a bank, or talks to a payment gateway (§25).

**What this phase deliberately does NOT do:**

| Not here | Owner |
|---|---|
| Direct bank API integration | later |
| UPI salary transfer, NEFT/RTGS APIs | later |
| Employee payslips, email payslips | 29.9 |
| Automatic bank reconciliation | later |
| Import Bank Result (§13, marked *future* in the brief) | later |
| Full & final settlement | later |
| **Any salary calculation** | 29.6 — every figure comes from the approved snapshot |

---

## 1. Spec corrections applied

The same three corrections as 29.5–29.7, plus two new ones.

| The brief said | What was built | Why |
|---|---|---|
| Gate on role names (§4) | Gate on **`PAYROLL_PAYMENT_READ` / `_GENERATE` / `_CONFIRM` / `_MARK_PAID`** + `requireFeature('payroll')` + the 29.1 payroll scope | Roles are per-company data; permissions are the contract |
| — | **`HR_MANAGER` gains `PAYROLL_PAYMENT_READ`**; `SYSTEM_PERMISSION_VERSION` 21 → **22** | §4 gives HR view-only access to payment status |
| CSV **or** XLSX (§10) | **Both**, XLSX written by a dependency-free OOXML/ZIP builder in the rules module | No new npm package — the 29.5/29.7 precedent |
| Cache key `payroll:payments:{companyId}:{month}` (§19) | `buildTenantCacheKey({ namespace: 'payroll-payment', version: 1, segments: [month, suffix] })` | 28.7 helper is the single convention in this codebase |
| BullMQ for the file (§20) | A real **`payroll-payment-file`** job on the existing `payroll` queue, references-only payload, worker rebuild, inline fallback when Redis is off; notifications and audit stay synchronous | 29.7 precedent — no new queue |
| Payment reference prefix (§11) | Read from `PayrollSetup.bankAccount.paymentReferencePrefix`, fallback `SAL` | The 29.1 field already exists — no schema change |
| "Import Bank Result (future)" (§13) | **Not built** — manual confirmation only | The brief marks it future |
| Notify employees (§21) | **No employee notifications.** Every notification is addressed to a permission, never to a recipient list | "Do not notify employees yet. Payslip notifications come later." |

---

## 2. The nine payment statuses (§8)

```
DRAFT ──► READY ──► FILE_GENERATED ──► DOWNLOADED ──► PROCESSING ──► PAID
  │         │              │                │              │
  │         │              │                │              ├──► PARTIALLY_PAID
  │         │              │                │              └──► FAILED
  │         │              │                └──► PAID / PARTIALLY_PAID / FAILED
  │         │              └──► READY / CANCELLED
  │         └──► CANCELLED
  └──► CANCELLED
```

`PAID` and `CANCELLED` are terminal. Every change is written to the audit log
with the actor, the from/to status and the reason (§22).

**Two rules the tests forced into the code (§26):**

1. `READY` deliberately reaches **no** payment outcome. The documented flow is
   *generate the file → finance uploads it → finance records the result*; a
   batch that was never turned into a file cannot be confirmed.
2. `assertFileGenerated()` in `payrollPaymentService.js` refuses
   `markAllPaid` / `markEmployee` while the batch is `DRAFT` or `READY`. A
   "Paid" record can therefore never exist without a bank file artefact behind
   it — enforced server-side, not only in the UI.

---

## 3. Backend files

| File | Role |
|---|---|
| `src/services/payroll/payrollPaymentRules.js` | **Pure** rules — no mongoose, no Redis, no `Date.now()`: statuses, transitions, `FAILURE_REASONS`, IFSC validation, `validateEmployeeForPayment`, batch numbers, payment references, summary, the six KPIs, `statusAfterMarking`, the 8 bank-file columns, `toCsv`, `buildXlsx`, `buildBankFile`, notification copy |
| `src/services/payroll/payrollPaymentService.js` | Tenant-safe orchestration behind a `makePayrollPaymentService({…})` DI factory — cache / audit / notify / audience / dispatch / decrypt / hash are all injected |
| `src/services/payroll/payrollPaymentCache.js` | Namespace `payroll-payment`, version 1, suffixes `dashboard` and `batches` |
| `src/services/payroll/payrollPaymentDispatcher.js` | Payload validation (references only) + `enqueueJob` on the `payroll` queue |
| `src/models/PayrollPaymentBatch.js` | Parent: unique `{companyId, batchNumber}`, attempt counter, `retryOf`, status, summary snapshot |
| `src/models/PayrollPayment.js` | One row per employee: unique `{companyId, paymentReference}`, masked account, **encrypted blob snapshotted into the row** |
| `src/models/PayrollPaymentFile.js` | Append-only generation history: CSV `content` or XLSX `binary`, checksum, row count, `downloadCount`, `lastDownloadedAt`, `jobId` |
| `src/controllers/payrollPaymentController.js` | Thin: parse → service → `ApiResponse` |
| `src/routes/payrollPaymentRoutes.js` | 12 routes |
| `src/validators/payrollPaymentValidator.js` | express-validator chains |
| `src/middlewares/payrollPaymentScope.js` | 29.1 payroll-scope narrowing + `assertEmployeeInPaymentScope` |
| `src/workers/payrollProcessor.js` | `payrollPaymentFileProcessor` registered under `JOB_NAMES.PAYROLL_PAYMENT_FILE` |
| `src/queues/queueConfig.js` | The new job name |

### Route table

| Method | Path | Permission | Section |
|---|---|---|---|
| GET | `/api/payroll/payments/dashboard` | `PAYROLL_PAYMENT_READ` | §17 |
| GET | `/api/payroll/payments` | `PAYROLL_PAYMENT_READ` | §18 |
| GET | `/api/payroll/payments/:batchId` | `PAYROLL_PAYMENT_READ` | §18 |
| GET | `/api/payroll/payments/:batchId/validate` | `PAYROLL_PAYMENT_READ` | §7 |
| GET | `/api/payroll/payments/files/:fileId/download` | `PAYROLL_PAYMENT_READ` | §12 |
| POST | `/api/payroll/payments` | `_GENERATE` + `checkWriteAccess` | §5, §6 |
| POST | `/api/payroll/payments/:batchId/files` | `_GENERATE` + `checkWriteAccess` | §10 |
| POST | `/api/payroll/payments/:batchId/mark-all-paid` | `_CONFIRM` + `checkWriteAccess` | §13 |
| PATCH | `/api/payroll/payments/:batchId/employees/:employeeId` | `_MARK_PAID` + `checkWriteAccess` + employee in scope | §14 |
| POST | `/api/payroll/payments/:batchId/retry` | `_GENERATE` + `checkWriteAccess` | §16 |
| POST | `/api/payroll/payments/:batchId/cancel` | `_GENERATE` + `checkWriteAccess` | §8 |
| POST | `/api/payroll/payments/:batchId/reopen` | `_CONFIRM` + `checkWriteAccess` | §4 |

Every route also passes `requireFeature('payroll')` and, on reads,
`payrollPaymentScope`.

---

## 4. The workflow

1. **Approve the month** in 29.7. A batch can only be created from an
   `APPROVED` payroll — `DRAFT`, `LOCKED` and `REJECTED` months are refused
   (§2, §5).
2. **Create the batch** (§6): `SAL-2026-08-001`. One *original* batch per
   month; retries increment `attempt` and point at `retryOf`.
3. **Validate** (§7): every employee needs a bank name, an account number, a
   valid IFSC (`/^[A-Z]{4}0[A-Z0-9]{6}$/`), an account holder name and a
   positive net salary. Invalid employees are **excluded, never partially
   paid**, and the reason is stored on the batch.
4. **Generate the file** (§10): 8 columns — reference, employee code and name,
   bank, account number, IFSC, amount, narration. CSV or XLSX. Generation
   re-runs validation and refuses to build a file with a broken row.
5. **Finance downloads it** (§12) and uploads it into their own banking
   portal. Every download is counted; files are never overwritten.
6. **Finance records the result** (§13): *Mark all paid*, or mark individual
   failures with one of the five reasons (§14).
7. **Retry the failures** (§16): a fresh batch containing only unpaid
   employees, with fresh references.

### §17 KPI cards

Total payroll · Paid employees · Failed payments · Pending payments · Total
amount paid · **Retry required** (how many batches of the month still have
unresolved failures).

### §21 notifications

Addressed by **permission**, not role name, via `resolveAudience`; the actor
is never notified of their own action, and a throwing notifier never rolls
back a payment.

| Event | Reaches |
|---|---|
| `PAYMENT_BATCH_CREATED` | `PAYMENT_CONFIRM`, `PAYMENT_GENERATE` |
| `PAYMENT_FILE_READY` | `PAYMENT_GENERATE`, `PAYMENT_READ` |
| `PAYMENT_CONFIRMED` | `PAYMENT_READ`, `PAYROLL_RUN_READ` |
| `PAYMENT_FAILED` | `PAYMENT_GENERATE`, `PAYMENT_CONFIRM` |
| `PAYMENT_RETRY_CREATED` | `PAYMENT_CONFIRM`, `PAYMENT_GENERATE` |
| `PAYMENT_CANCELLED` | `PAYMENT_READ`, `PAYMENT_GENERATE` |

---

## 5. Frontend

`/app/payroll/salary-payment` — sidebar entry **Payroll → Salary Payment**,
shown to anyone holding a `PAYROLL_PAYMENT_*` permission (§24).

- Month picker + *Create payment batch*
- The six §17 KPI cards
- Batch list: number, month, employees, total, paid/failed, payment date,
  status
- Batch detail: summary strip, then four tabs
  - **Employees** (§9) — masked account numbers only, per-row *Mark paid* /
    *Mark failed*
  - **Failed** (§14) — reason, amount, reference, remark, retry
  - **Validation** (§7) — live re-check plus the employees excluded when the
    batch was created
  - **Downloads** (§12) — generated at, format, rows, who, download count,
    last downloaded at
- Actions: generate CSV/XLSX, validate, mark all paid, retry, cancel, reopen

New file: `src/services/payrollPaymentService.js`.

---

## 6. Security, tenancy and performance

- **Tenant isolation** (§3): every query carries `companyId`; the scope
  middleware narrows a scoped user to their own employees.
- **Account numbers** (§9, §23): the full number exists **only** in the
  encrypted blob and inside the generated file. `toPublicPayment` strips the
  blob, `listPayments` needs an explicit `withSecret: true` to select it, and
  `buildFileContent` is the single decrypt site.
- **Queue payload** (§20): the dispatcher *rejects* any payload carrying
  `payments`, `accountNumber`, `netSalary`, `content`, `rows` or `binary`.
  Only ids travel through Redis; the worker rebuilds from Mongo.
- **Immutable history**: the encrypted bank blob is copied into each payment
  row, so editing an employee's profile later cannot rewrite what a past
  batch paid.
- **No double pay** (§15, §16): a retry batch unions the PAID employee ids
  across *every* batch of the month and skips them.
- **Cache** (§19): `payroll-payment` namespace, invalidated on batch created,
  file generated, payment confirmed, payment failed and batch cancelled.
- **Indexes**: `{companyId, month}`, `{companyId, batchNumber}`,
  `{companyId, paymentReference}`, `{companyId, batchId, status}`.

---

## 7. Tests

```powershell
cd Backend
npm run test:payroll-payment   # 29 tests  (new, hermetic)
npm run test:payroll           # 29.1 → 29.8   → 267
npm run test:all
```

Hermetic: fake models plus fake cache / audit / notify / audience / dispatch /
decrypt seams — no MongoDB, no Redis, no BullMQ.

Two **genuine product defects** were found by the tests and fixed in the
source, not in the tests:

1. A batch could be marked `PAID` with no bank file ever generated — a payment
   claim with no artefact. Fixed by `assertFileGenerated()`.
2. `PAYMENT_TRANSITIONS` was too narrow: from `FILE_GENERATED` no payment
   outcome was reachable until someone downloaded the file. Widened, while
   `READY` still cannot reach one.

A third, smaller one: `downloadFile` returned the file row read *before* the
download counter was incremented, so the UI showed the previous count. It now
re-reads after the update.

---

## 8. What 29.9 gets

- One approved, **paid** payroll per month, with per-employee payment
  references and a recorded payment status.
- `PayrollPayment` rows carry net salary, deductions and the payment outcome —
  everything a payslip needs except the payslip itself.
- Employee notification is a single `notifySmart` call away: the audience
  resolver already walks permission → role → user.
- **Explicitly left open:** payslip PDF generation, the employee salary
  portal, release/re-release, and emailing payslips.
