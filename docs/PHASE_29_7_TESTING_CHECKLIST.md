# Phase 29.7 — What was built and how to test it

Windows PowerShell commands throughout.

---

# PART 1 — What has been implemented

## Payroll Review & Approval (new)

| Area | Shipped |
|---|---|
| Rules | Pure module: statuses + transition table, checklist, §10 error catalogue, KPIs, summary report, difference report, CSV builders |
| Models | `PayrollReview` (one per company + month) and `PayrollExport` (one per generated report) |
| Service | get review / dashboard / employees / errors / differences, checklist, remarks, employee review, bulk actions, lock, reopen, submit, approve, reject, create + process export — all dependency-injected |
| API | 16 routes at `/api/payroll/review` |
| Queue | Reuses the 29.6 `payroll` queue with a `payroll-export` job; worker rebuilds the report from Mongo and falls back inline when Redis is off |
| Permissions | Reused `PAYROLL_RUN_READ` / `_PREPARE` / `_REVIEW` / `_LOCK` / `_REOPEN` / `_APPROVE` / `_REJECT`; **`PAYROLL_RUN_REJECT` added to `FINANCE_MANAGER`**; `SYSTEM_PERMISSION_VERSION = 21` |
| UI | `/app/payroll/review` — KPI cards, checklist, Employees / Errors / Differences / Remarks / Reports tabs, lock · submit · approve · reject · reopen, employee breakdown drawer, CSV export |

## Brief corrections applied

| The brief said | What was built |
|---|---|
| Gate on role names (Company Admin / Payroll Admin / HR Manager / Finance Manager) | Gate on **permissions** + `requireFeature('payroll')` + the 29.1 payroll scope |
| "Monthly inputs become read-only" on lock | Lock sets the 29.5 `PayrollPeriod` to `SENT_TO_PAYROLL`; reopen returns it to `LOCKED` — one state machine, not two |
| Excel / XLSX reports | **CSV** (same decision as 29.5's import template): no new npm dependency |
| Cache key `payroll:review:{companyId}:{month}` | `buildTenantCacheKey({ namespace: 'payroll-review', version: 1, segments: [month, …] })` |
| — | BullMQ export **is** implemented on the existing queue; inline fallback only when Redis is off, and the UI says which path ran |

---

# PART 2 — What the automated tests already prove

```powershell
cd Backend
npm run test:payroll-review   # 23 tests  (new, hermetic)
npm run test:payroll          # 29.1 → 29.7   → 230
npm run test:phase28          # redis + bullmq + queues + cache → 242
npm run test:payroll-rbac     # permission matrix → 27
```

Hermetic ladder (no MongoDB, no Redis, no BullMQ): **498 green**.

- the cache seam is called with the house contract
  (`{ ttlSeconds, version, loader }`, never positional args) — the bug that
  would have made every 29.6 dashboard read throw `loader is not a function`
- the transition table, including that `CALCULATED` cannot jump straight to
  `LOCKED`, and that `LOCKED` / `PENDING_FINANCE_APPROVAL` / `APPROVED` are
  read-only
- the checklist gate: locking is refused until every box is ticked
- every §10 error code with its severity — missing bank account, missing PAN,
  missing structure, negative net, duplicate record, and the attendance warning
- KPI cards and the summary report read the 29.6 snapshots
- CSV exports: payroll register, salary summary, department payroll, deduction
  report, employer contribution report, error list
- the difference report: previous / current / difference per component and per
  net salary
- lock → submit → approve, and approve-before-submit is refused
- reject, and the reasons: no reason is refused; a rejected month cannot be
  approved without reopening
- reopen needs a reason, clears the approval stamps, and unfreezes the inputs
- remarks are append-only and keep author, role, channel and time
- bulk actions never change a salary figure, and honour a narrowed scope
- export dispatch: a references-only payload (no salary figures), valid ObjectIds,
  and the worker rebuilds the report from Mongo rather than from the payload
- §4 permissions: Company Admin locks/reopens/approves/rejects; HR Manager
  reviews but never locks or approves; Finance Manager approves and rejects;
  Manager, Team Lead and Employee never read payroll

---

# PART 3 — Manual testing

## Before you start

```powershell
# Terminal 1 — backend
cd Backend
npm install
npm run dev

# Terminal 2 — worker (needed for queued reports)
cd Backend
npm run worker

# Terminal 3 — frontend
cd Frontend
npm install
npm run dev
```

You need a company where 29.1–29.6 are done: a payroll setup, at least one
salary structure, employee payroll profiles, a locked month with inputs, and a
completed payroll run for that month.

## A. The review page opens

1. Log in as a Payroll Admin (or Company Admin).
2. Sidebar → **Payroll** → **Review Payroll**.
3. Pick the month you ran in 29.6.

Expect: the KPI cards show the same figures as **Run Payroll** (total
employees, gross, net, employer cost); the status badge reads *Calculated*; the
checklist is empty except **Error count is zero**, which is marked *auto*.

## B. Errors and the lock gate

1. Open the **Errors** tab. Expect one row per issue with a severity pill.
2. Try **Lock payroll** with an incomplete checklist → the button is disabled
   and the hint on the right says why.
3. Tick every box. If a critical error remains, the button stays disabled.
4. Fix the underlying profile (Employee Payroll → bank account / PAN),
   recalculate in **Run Payroll**, come back — the error is gone.

## C. Employee review

1. **Employees** tab → **Review breakdown** on any row.
2. Read the breakdown (earnings, variable pay, reimbursements, deductions,
   employer contributions, attendance). Add a review note → **Mark reviewed**.
3. Back in the table the row reads *reviewed*.
4. Select several rows → **Mark reviewed** / **Verify bank** / **Verify PAN**.
5. Compare the net-pay column before and after: **nothing changed**. Review
   never touches a figure.

## D. Lock, submit, approve

1. **Lock payroll** (the optional note is stored as a remark).
2. **Monthly Inputs** for that month now shows the period as sent to payroll —
   the inputs are frozen.
3. **Submit to finance** → status *Pending finance approval*.
4. Log in as a Finance Manager → **Approve** → status *Approved*.
5. Every edit control on the page is now disabled.

## E. Reject and reopen

1. Re-run the flow, then as Finance Manager press **Reject** with no reason →
   refused. Add a reason → status *Rejected*, and HR sees the reason in a red
   banner on the page.
2. As Company Admin press **Reopen**, give a reason → status *Reopened*, the
   monthly inputs are editable again, and the approval stamps are cleared.
3. **Audit Logs** shows one entry per action with the reason.

## F. Differences

1. In **Run Payroll**, recalculate the month (or change an input and
   recalculate a single employee).
2. **Review Payroll** → **Differences** tab: one row per changed component with
   previous, current and difference, plus net before and net after.

## G. Remarks

1. **Remarks** tab → add a note as HR, then as Finance. Both appear in order
   with author, role, channel and time. Nothing can be edited or deleted.

## H. Reports

1. **Reports** tab → **Payroll register**. With Redis + the worker running,
   the UI says the report is queued; a moment later it is ready. Without Redis
   the CSV downloads straight away.
2. Repeat for the salary summary, department payroll, deduction report,
   employer contribution report and error list.
3. Open a CSV in Excel — the figures match the page.

## I. Permissions

| Account | Expect |
|---|---|
| Employee / Manager / Team Lead | **Review Payroll** never appears in the sidebar; calling the API directly returns 403 |
| HR Executive | Sees the page; can review employees; **Lock** is disabled |
| Payroll Admin | Everything except **Approve** / **Reject** |
| Finance Manager | Read-only, plus **Approve** / **Reject** on a submitted month |
| Company Admin | Everything, including **Lock** and **Reopen** |

## J. Tenant isolation

1. Two companies, same month. Run payroll in each.
2. In company A's review page, no employee, figure or report from company B
   appears.
3. Copy an export id from company B and call
   `GET /api/payroll/review/exports/{id}` with company A's token → not found.

## K. Read-only months

1. Lock a month, then try `PATCH /api/payroll/review/{month}/checklist/ATTENDANCE_VERIFIED`
   with a Payroll Admin token → 400 "This payroll is locked".
2. Reopen, and the same call succeeds.

---

# PART 4 — Known limitations

* Reports are CSV, not XLSX — deliberate (no new dependency, §19 correction).
* The export job is not retried with a backoff policy beyond the shared queue
  defaults; a failed export is marked `FAILED` and can be requested again.
* Payslips are not generated or emailed here — later phases.
* Payment, bank file and settlement remain out of scope (§26) until 29.8+.
