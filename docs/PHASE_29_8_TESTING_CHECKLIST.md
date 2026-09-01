# Phase 29.8 — What was built and how to test it

Windows PowerShell commands throughout.

---

# PART 1 — What has been implemented

## Bank Transfer File & Salary Payment Preparation (new)

| Area | Shipped |
|---|---|
| Rules | Pure module: 9 statuses + transition table, 5 failure reasons, IFSC validation, bank-detail validation, batch numbers, payment references, summary, the 6 KPIs, the 8-column file builder, CSV **and** XLSX |
| Models | `PayrollPaymentBatch`, `PayrollPayment`, `PayrollPaymentFile` |
| Service | dashboard, list, detail, validate, create, generate file, process file, download, mark all paid, mark one employee, retry, cancel, reopen — all dependency-injected |
| API | 12 routes at `/api/payroll/payments` |
| Queue | Reuses the 29.6 `payroll` queue with a `payroll-payment-file` job; references-only payload, worker rebuilds from Mongo, inline fallback when Redis is off |
| Permissions | Reused `PAYROLL_PAYMENT_READ` / `_GENERATE` / `_CONFIRM` / `_MARK_PAID`; **`HR_MANAGER` gains `PAYROLL_PAYMENT_READ`**; `SYSTEM_PERMISSION_VERSION = 22` |
| Notifications | §21 — addressed by **permission**, actor excluded, a throwing notifier never rolls back a payment, and no employee is ever notified |
| Cache | `services/payroll/payrollPaymentCache.js` — namespace `payroll-payment`, version 1 |
| UI | `/app/payroll/salary-payment` — KPI cards, batch list, batch detail with Employees / Failed / Validation / Downloads tabs |

## Brief corrections applied

| The brief said | What was built |
|---|---|
| Gate on role names (§4) | Gate on **permissions** + `requireFeature('payroll')` + the 29.1 payroll scope |
| CSV **or** XLSX (§10) | **Both** — XLSX comes from a dependency-free OOXML/ZIP writer, no new npm package |
| Cache key `payroll:payments:{companyId}:{month}` | `buildTenantCacheKey({ namespace: 'payroll-payment', version: 1, segments: [month, suffix] })` |
| New BullMQ queue (§20) | The existing `payroll` queue with a `payroll-payment-file` job, inline fallback, synchronous notifications |
| Payment reference prefix (§11) | `PayrollSetup.bankAccount.paymentReferencePrefix`, fallback `SAL` |
| "Import Bank Result (future)" (§13) | **Not built** — manual confirmation only |
| Notify employees (§21) | **No** — notifications go to permissions, never to employees |

---

# PART 2 — What the automated tests already prove

```powershell
cd Backend
npm run test:payroll-payment   # 29 tests  (new, hermetic)
npm run test:payroll           # 29.1 → 29.8   → 267
npm run test:all
```

Hermetic ladder (no MongoDB, no Redis, no BullMQ).

- §8 statuses and transitions, including that `PAID` and `CANCELLED` are
  terminal
- §13/§15 `statusAfterMarking`: all paid → `PAID`, some failed →
  `PARTIALLY_PAID`, all failed → `FAILED`
- §7 bank validation and every `FAILURE_REASONS` path, plus the IFSC pattern
- §6 batch numbers `SAL-2026-08-001` and §11 references `<PREFIX>-2026-08-0001`
- §2/§5 the approved-payroll gate: a batch cannot be built from a month that
  is not `APPROVED`
- batch creation pricing, the exclusion of invalid employees, and one original
  batch per month
- §9/§23 masking: the plaintext account number `123456789012` never appears in
  any serialized response
- §10 CSV columns and the XLSX `PK` magic bytes
- §20 the queue payload carries references only, and the worker rebuilds the
  file from Mongo
- §13/§14/§15/§16 confirm, fail, retry, and **never pay the same employee
  twice** — references stay unique across the original batch and the retry
- cancel and reopen
- §18/§22 the batch audit read is tenant-scoped and limited to the batch, its
  payment rows and its files; the actor, action and status change are mapped
  back out of the audit log, and a foreign company's batch is never read
- §21 notifications addressed by permission, skipping the actor, never
  blocking on a failure
- §3 narrowed scope
- §19 cache read plus invalidation on the five listed events
- §17 KPIs, including `retryRequired`
- §4 permission matrix — `FINANCE_EXECUTIVE` holds **only**
  `PAYROLL_PAYMENT_READ`

Three defects the tests caught and that are now fixed in the source:

1. A batch could be confirmed `PAID` with no bank file behind it →
   `assertFileGenerated()`.
2. `FILE_GENERATED` could not reach any payment outcome until a download →
   the transition table was widened, with `READY` still deliberately blocked.
3. `downloadFile` returned the pre-increment download count → it re-reads the
   row after the update.

---

# PART 3 — Manual testing

## Before you start

You need a month that has been run (29.6) **and approved** (29.7). If you have
not done that yet:

```powershell
# 1. Payroll Setup must be activated (29.1)
# 2. Run Payroll  -> /app/payroll/run   -> execute for the month
# 3. Review       -> /app/payroll/review -> lock, submit, approve
```

```powershell
# Terminal 1 — backend
cd Backend
npm run dev

# Terminal 2 — worker (needed for queued file generation)
cd Backend
npm run worker

# Terminal 3 — frontend
cd Frontend
npm run dev
```

Sign in as a Company Admin (or the finance template user) and open
**Payroll → Salary Payment**.

## A. The page opens

1. The six KPI cards show zeros for a month with no batch.
2. Paste a token holding only `PAYROLL_PAYMENT_READ` and confirm the create /
   generate / confirm buttons are disabled but the data is visible.
3. An employee with no payroll permission gets the "Payment access required"
   screen.

## B. Create a batch

1. Choose the approved month → **Create payment batch**.
2. The batch number is `SAL-<YYYY-MM>-001`.
3. Create it again → the API refuses (one original batch per month).
4. Try it on a month that is `LOCKED` or `DRAFT` → refused with the §5 message.

## C. Validation

1. In the batch detail, **Validate bank details**.
2. Break an employee first (clear the IFSC in Employee Payroll Profile) and
   confirm they appear as excluded with a readable reason.
3. Generate a file while a row is invalid → refused; the file cannot contain a
   broken bank instruction.

## D. Generate and download

1. **Generate bank file** as CSV → the Downloads tab shows a new row, 0
   downloads.
2. Download it → the count becomes 1, *last downloaded at* is filled, and the
   batch moves to `DOWNLOADED`.
3. Download again → 2. The first file is **not** replaced or overwritten.
4. Generate an XLSX → open it in Excel/LibreOffice; the account column holds
   the full number while the screen only ever showed the mask.
5. Restart the backend with Redis stopped → generation still succeeds inline.

## E. Confirm, fail, retry

1. On a `DRAFT`/`READY` batch the **Mark all paid** button is disabled; call
   the API directly and it refuses (§26).
2. After generating a file: **Mark all paid** → every employee `PAID`, batch
   `PAID`, KPI "Paid employees" and "Total amount paid" update.
3. Fail one employee → the batch becomes `PARTIALLY_PAID`, the Failure tab
   lists the reason.
4. **Retry failed** → a new batch `SAL-<YYYY-MM>-002` with `attempt 2`
   containing only the unpaid employee, with a fresh reference. The employee
   already paid is **not** in it.
5. Fail everyone → batch `FAILED` → **Reopen** returns it to `READY`.

## F. Cancel

1. Cancel a batch with a reason → status `CANCELLED`, the reason is in the
   audit log, and no further file can be generated from it.

## G. Permissions

1. `PAYROLL_PAYMENT_READ` only → everything readable, nothing writable
   (writes return 403).
2. `PAYROLL_PAYMENT_GENERATE` → can create, generate, retry, cancel, but not
   confirm.
3. `PAYROLL_PAYMENT_CONFIRM` → can mark all paid and reopen.
4. `PAYROLL_PAYMENT_MARK_PAID` → can set one employee's outcome.

## H. Tenant isolation

1. Sign in to company B and request company A's batch id → 404.
2. A user with department scope only sees their own employees; a per-employee
   `PATCH` outside their scope is refused.

## I. Audit

1. Open a batch → **Audit** tab → every action appears newest first, with the
   actor, the role, and `from → to` for status changes.
2. Search the audit by action or actor name; the box filters whichever table
   is open (employees, failures, downloads, audit).
3. Every action above writes one of `PAYMENT_BATCH_CREATED`,
   `PAYMENT_FILE_GENERATED`, `PAYMENT_FILE_DOWNLOADED`,
   `PAYMENT_EMPLOYEE_PAID`, `PAYMENT_EMPLOYEE_FAILED`, `PAYMENT_CONFIRMED`,
   `PAYMENT_FAILED`, `PAYMENT_RETRY_CREATED`, `PAYMENT_BATCH_REOPENED` or
   `PAYMENT_CANCELLED`, with the actor and the from/to status.

---

# PART 4 — Known limitations

- **No bank integration.** Crewly produces the file; uploading it and reading
  the result are manual, by design (§25).
- **Import Bank Result** (§13) is not implemented — it is marked *future* in
  the brief.
- **Employees are not notified.** Payslip notifications come with 29.9.
- XLSX is a minimal but valid OOXML workbook (one sheet, inline strings, no
  styling, no formulas). If a bank demands a richer template, extend
  `buildXlsx` rather than adding a dependency.
- Queued generation needs Redis + the worker; without them the request builds
  the file inline, which is fine for a few thousand rows but not for tens of
  thousands.
- No automatic reconciliation: the payment status is whatever finance recorded
  by hand.
