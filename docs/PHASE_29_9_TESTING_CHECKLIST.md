# Phase 29.9 — What was built and how to test it

Windows PowerShell commands throughout.

---

# PART 1 — What has been implemented

## Payslip Generation & Employee Salary Portal (new)

| Area | Shipped |
|---|---|
| Rules | Pure module: §21 statuses + transitions, §7 payslip numbers, the §6 snapshot builder, §15 filters, §27 counters, §18 file names, §19/§20 copy |
| Models | `Payslip` (one per company + employee + month; the PDF is stored with it) and `PayslipFile` (bulk archives with progress) |
| Service | dashboard, list, mine, detail, viewed, generate, run (worker), regenerate, download, email one, email month, bulk download request/run/download — all dependency-injected |
| API | 14 routes at `/api/payroll/payslips`, including the `/mine/*` employee portal |
| PDF | The existing PDFKit module extended with a snapshot-driven `buildPayslipPdf()`; the legacy `streamPayslipPdf()` untouched |
| Queue | `payslip-generate` / `payslip-zip` / `payslip-email` on the existing `payroll` queue — and **the payroll worker itself, which had never been started** |
| Permissions | The 29.1 `PAYSLIP_*` catalogue; `HR_MANAGER`, `FINANCE_MANAGER` and `FINANCE_EXECUTIVE` gain `PAYSLIP_READ`; `SYSTEM_PERMISSION_VERSION = 23` |
| Email | The existing `utils/mailer.js` `sendMail()` gains an optional `attachments` argument |
| UI | `/app/payroll/payslips` (admin) and `/app/payroll/my-payslips` (employee), sharing one on-screen payslip component |

## Brief corrections applied

| The brief said | What was built |
|---|---|
| Gate on role names (§4) | Gate on **permissions** + `requireFeature('payroll')` + the 29.1 payroll scope |
| "Payroll Status = Paid" (§1) | Gate on the 29.8 **payment row**: payslips for `PAID` employees, so a partially paid month is not blocked |
| A new PDF layout (§8) | Extends the existing PDFKit module — no new dependency, legacy renderer untouched |
| ZIP needs a library (§18) | The 29.8 writer, extracted to `utils/minimalZip.js` and shared |
| `payroll:payslips:{employeeId}` (§23) | `buildTenantCacheKey({ namespace: 'payroll-payslips', version: 1, … })` |
| New BullMQ queue (§24) | The existing `payroll` queue with three new job names, inline fallback |
| Another email system (§19) | The existing mailer, extended with attachments |
| — | Legacy `/api/payroll/:id/payslip` and `/app/payslips` left untouched, guarded by a test |

## Also fixed along the way

The payroll queue had **no consumer**. `registerPayrollProcessors()` was
written in 29.6 but never called, so every payroll job since then was handled
by the API's inline fallback. `src/workers/index.js` now starts a payroll
worker with its own connection and `PAYROLL_WORKER_CONCURRENCY`.

---

# PART 2 — What the automated tests already prove

```powershell
cd Backend
npm run test:payslip    # 28 tests  (new, hermetic)
npm run test:payroll    # 29.1 → 29.9   → 298
npm run test:all        # 664
```

Hermetic ladder (no MongoDB, no Redis, no BullMQ, no SMTP, no PDF renderer).

- §6 the snapshot freezes company, employee, salary, attendance and payment
- §9/§10 every earning and deduction stays separate, never merged
- §11 employer contributions are reported but never reduce the net
- §13/§26 the plaintext account number never appears in a payslip
- §1/§15 payslips only for PAID salaries; a partially paid month payslips the
  142 who were paid instead of blocking on the 3 who failed
- §7 payslip numbers are unique inside the company
- §17 generation is queued with references only, and payloads carrying salary,
  bank or PDF data are rejected
- §22 regeneration cannot move a rupee, even when the payroll data changes
  underneath it
- §3/§26 an employee reaches only their own payslip; another company's is a 404
- downloads count, move the status and are audited
- §19 the email carries the PDF; an employee with no email is recorded, not
  silently skipped
- §18 the ZIP is a real archive, a department scope holds only that
  department, and a queued archive cannot be downloaded early
- §15 filters by month, year, financial year and search
- §23 both reads go through the cache and every change invalidates it
- §25 all five audited actions are recorded
- the legacy payslip route and renderer still exist, untouched

---

# PART 3 — Manual testing

## Before you start

Payslips need a month that has been run, approved **and paid**:

```powershell
# 1. Run Payroll         -> /app/payroll/run      -> execute the month
# 2. Review Payroll      -> /app/payroll/review   -> lock, submit, approve
# 3. Salary Payment      -> /app/payroll/salary-payment
#                          -> create batch, generate CSV, Mark all paid
```

```powershell
# Terminal 1 — backend
cd Backend
npm run dev

# Terminal 2 — worker (needed for queued generation, ZIP and email)
cd Backend
npm run worker

# Terminal 3 — frontend
cd Frontend
npm run dev
```

## A. Generate payslips

1. **Payroll → Payslips**, pick the paid month → **Generate payslips**.
2. With the worker running the response says *queued* and the list fills in as
   the job progresses. With the worker stopped it completes inline.
3. Try it on a month that has **not** been paid → refused with the §1 message.
4. Fail three payments in 29.8, confirm the rest as paid, then generate →
   three employees are skipped, the other 142 get payslips.

## B. The PDF

1. Download one PDF and open it. Check every §8 section is present: header,
   employee details, attendance, earnings, reimbursements, deductions,
   **Company Contributions**, summary, payment info, footer.
2. Confirm the account number is masked (`XXXX4589`), never full.
3. Check the totals: gross − deductions = net, and employer contributions are
   **not** subtracted from the net.

## C. Regenerate (§22)

1. Change the company address in **Company Profile**.
2. **Regenerate** one payslip → the address on the PDF changes, the numbers do
   not. The UI reports *values unchanged*.

## D. Employee portal

1. Sign in as an employee → **Payroll → My Payroll**.
2. The list shows month, gross, net, payment date, status, download.
3. Open a month → preview every section → **Download PDF** and **Print**.
4. Filter by financial year, year and search.
5. As that employee, try another employee's payslip id in the URL → 404.
6. Check the notification: *"Your August 2026 payslip is now available."*

## E. Email (§19)

1. **Email** one payslip → the employee receives it with the PDF attached.
2. With SMTP unset, the backend logs a MOCK email including the attachment
   name and size — nothing is really sent.
3. **Email month** sends the whole month in the background.

## F. Bulk download (§18)

1. **Build ZIP** for the company → the row shows progress, then *ready*.
2. Download and open it: one PDF per employee, named
   `2026-08/EMP001-2026-08.pdf`.
3. Build a **department** ZIP → only that department's employees are inside.
4. Try to download while it is still *preparing* → refused.

## G. Permissions

1. `PAYSLIP_READ` only → everything visible, generate/email/regenerate refuse.
2. `PAYSLIP_GENERATE` → can generate, cannot email or regenerate.
3. `PAYSLIP_RELEASE` → can email.
4. `PAYSLIP_RERELEASE` → can regenerate.
5. An employee with only `PAYSLIP_READ_SELF` → `/app/payroll/payslips` is
   denied, `/app/payroll/my-payslips` works.

## H. Tenant isolation

1. Sign in to company B and request company A's payslip id → 404.
2. Change `companyId` in any request body or query — it is ignored; the tenant
   comes from the token.

## I. Audit

1. Every action above writes `PAYSLIP_GENERATED`, `PAYSLIP_DOWNLOADED`,
   `PAYSLIP_EMAILED`, `PAYSLIP_REGENERATED` or `PAYSLIP_VIEWED`, with company,
   employee, month, actor and timestamp.

---

# PART 4 — Known limitations

- **No bank or government integration** — payslips are documents, not filings
  (§28).
- The company **logo is not embedded**; the header uses an initials badge like
  the legacy slip. Embedding a remote logo would make PDF generation depend on
  the network.
- XLSX/ZIP use hand-written writers: valid, dependency-free, STORED (no
  compression). PDFs are already compressed internally, so archives stay small.
- Emails are sent through the existing mailer; bulk email is backgrounded but
  delivery is at-least-once (no provider message-id tracking yet — a known
  28.x backlog item).
- Payslip PDFs are stored on the record. Very large companies should watch
  document size; the field is `select: false` so list reads never pay for it.
- The audit log has a 180-day TTL, so payslip *activity* history ages out even
  though the payslips themselves do not.
