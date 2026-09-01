# Phase 29.6 — What was built and how to test it

Windows PowerShell commands throughout.

---

# PART 1 — What has been implemented

## Payroll Calculation Engine (new)

| Area | Shipped |
|---|---|
| Rules | Pure module: payable days, LOP, OT, PF/ESI/PT/TDS/gratuity/LWF, pre-checks, pipeline, KPIs |
| Models | `PayrollRun` (control record) and `PayrollResult` (versioned immutable snapshot) |
| Service | Start / process / recalculate / cancel / read, all dependency-injected |
| API | 7 routes at `/api/payroll/runs` |
| Queue | Reserved `payroll` queue + `payroll-run` job + worker processor with live progress |
| Worker | `src/workers/payrollProcessor.js`, registered in the worker process (8th queue) |
| Permissions | Reused `PAYROLL_RUN_READ` / `_EXECUTE` / `_RECALCULATE`; `SYSTEM_PERMISSION_VERSION = 20` |
| UI | `/app/payroll/run` — pre-checks, KPI cards, progress tracker, results table, employee breakdown, error report |

## Brief corrections applied

| The brief said | What was built |
|---|---|
| Gate on role names | Gate on **permissions** + the 29.1 payroll scope |
| Cache key `payroll:summary:{companyId}:{month}` | `buildTenantCacheKey({ namespace: 'payroll-run', segments: [month, …] })` |
| Recalculate = Payroll Admin + Company Admin | `PAYROLL_RUN_RECALCULATE` removed from the default HR Manager matrix |
| PF/ESI/PT/TDS "calculate" | Engine-owned rates/ceilings in one pure table, gated by 29.1 applicability |
| — | BullMQ run **is** implemented (this is the workload that needs it); inline fallback only when Redis is off |

---

# PART 2 — What the automated tests already prove

```powershell
cd Backend
npm run test:payroll-engine   # 27 tests
npm run test:payroll           # 29.1 + RBAC + 29.2 + 29.3 + 29.4 + 29.5 + 29.6  → 207
node --test test/redisFoundation.test.js test/bullmqFoundation.test.js test/opsQueueOps.test.js   # 104
```

Full hermetic ladder (no MongoDB, no Redis, no BullMQ): **311/311 green**.

- payable days, LOP arithmetic and the LOP basis
- overtime: HOURLY (gross ÷ working days ÷ 8 × multiplier), FIXED, disabled
- PF wage ceiling + employer EPS/EPF split; ESI ceiling; PT state slabs;
  gratuity 4.81%; TDS annualised, regime-aware, spread over the months left
  and reduced by TDS already deducted this year
- progressive slab tax, not flat
- rejected claims never reach payroll; bonus/reimbursement/deduction split
- statutory component codes recognised whatever the casing
- the pipeline stores every intermediate value; employer contributions never
  reduce net pay; every deduction carries a name, amount and source
- company pre-checks: inactive setup, missing bank, unlocked month
- employee pre-checks: no profile, draft profile, no structure
- a run calculates every ACTIVE employee, skips inactive ones, reports progress
- a broken employee becomes a persisted **ERROR** row and never stops the run
- a run refuses to start when company pre-checks fail
- recalculation writes v(n+1), leaves v(n) untouched, marks only one current
- single-employee recalculation touches only that employee
- the queue payload carries references only and passes the payload validator
- dashboard summary through the cache seam; results narrowed by payroll scope
- cancelling is audited; run statuses follow §20
- permissions: HR Manager runs but cannot recalculate; Manager/Team
  Lead/Employee hold nothing; Finance is read-only

---

# PART 3 — What you must test manually

## 0. One-time setup

```powershell
cd Backend;  npm install; npm run seed; npm run dev      # Terminal 1
cd Backend;  npm run worker                              # Terminal 2 (needs Redis)
cd Frontend; npm install; npm run dev                    # Terminal 3
```

Seed login `admin@crewly.com` / `Admin@123` · UI http://localhost:5173.

Prerequisites from earlier phases (the engine refuses to run without them):
- Payroll Setup **activated** with a bank account (29.1).
- An **ACTIVE** salary structure with components (29.2 / 29.3).
- At least two employees with an **ACTIVE** payroll profile and gross (29.4).
- Monthly inputs **locked** for the month (29.5) — the engine's §6 pre-check.

```powershell
$body = @{ companyCode="<CODE>"; email="admin@crewly.com"; password="Admin@123" } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri "http://localhost:5000/api/auth/login" -Body $body -ContentType "application/json"
$headers = @{ Authorization = "Bearer $($login.data.token)"; "Content-Type" = "application/json" }
```

## 1. Run payroll (UI)

1. **Payroll → Run Payroll**, pick the locked month.
2. If the month is not locked you see the amber pre-check banner — that is the
   engine refusing politely (§6).
3. **Run payroll** → confirm → the run appears as `Calculating` and the
   progress bar moves (`12 / 300 · 4% · Asha Rao`).
4. When it finishes: status `Calculated`, and the KPI cards fill in
   (employees, calculated, errors, gross, net, employer cost).
5. Leave the page mid-run and come back: it keeps going — that is the worker.

## 2. Employee breakdown (§24)

1. **View breakdown** on any employee.
2. Gross / net / deductions / employer cost at the top, then attendance
   (working, paid, present, LOP, paid leave, OT hours).
3. Sections in order: Earnings → Variable earnings → Overtime (hours × rate) →
   Reimbursements (approved) → Deductions → Employer contributions.
4. Every deduction shows its **source**: `STATUTORY`, `STRUCTURE`,
   `ATTENDANCE` (LOP) or `MONTHLY_INPUT`.
5. Everything is read-only.

## 3. The numbers (spot-check one employee)

With gross 50,000, basic 25,000, 22 working days, 2 LOP, 5 OT hours at ×2:

| Line | Expected |
|---|---|
| LOP deduction | 50,000 × 2/22 = 4,545.45 |
| Overtime | 50,000 ÷ (22 × 8) = 284.09/h × 2 × 5h = 2,840.90 |
| PF employee | 15,000 ceiling × 12% = 1,800 |
| PF employer | 1,800 (EPS 1,249.50 + EPF 550.50) |
| ESI | 0 — gross is above the 21,000 ceiling |
| Professional Tax (Karnataka) | 200 |
| Net | earnings + bonus + OT + reimbursements − deductions |

## 4. Recalculation (§21)

1. Change a bonus in **Monthly Inputs** (reopen the month, edit, re-lock).
2. **Recalculate month** → the table shows snapshot **v2**, and the affected
   employee's numbers change.
3. `db.payrollresults.find({ month: "2026-08" })` → both v1 and v2 exist; only
   v2 has `isCurrent: true`. v1's amounts are byte-for-byte what they were.
4. Recalculate one employee from the drawer → only that employee gets a v3.
5. As an **HR Manager** the Recalculate buttons are gone (§21).

## 5. Error report (§22)

1. Set an employee's payroll profile to Draft (or remove their structure).
2. Run payroll → the run completes, that employee is an **ERROR** row, and the
   error report names the reason ("Employee payroll profile is draft").
3. The other employees are still calculated — nothing silently disappears.

## 6. Permissions (§4)

| Account | Expectation |
|---|---|
| Company Admin | Run, recalculate, cancel, view everything |
| Payroll Admin (template) | Same |
| HR Manager | Run + view; **no** Recalculate |
| Finance Manager (template) | View only — no Run button |
| Manager / Team Lead / Employee | No Run Payroll entry at all |

API check as an employee: `GET /api/payroll/runs/2026-08` → **403**.

## 7. Tenant isolation (do this)

1. Run payroll in company A.
2. With company B's token, `GET /api/payroll/runs/2026-08` → empty run.
3. `GET /api/payroll/runs/2026-08/results` → empty.
4. `GET /api/payroll/runs/2026-08/results/<A-employee-id>` → 403/404.

## 8. Redis (§25)

```powershell
docker exec -it <redis> redis-cli --scan --pattern "*payroll-run*"
```

Populated by the dashboard; deleted after every run, recalculation and status
change. Stop Redis → the dashboard still works **and payroll still runs**
(inline, `meta.queued: false`).

## 9. BullMQ (§26 / §27)

```powershell
docker exec -it <redis> redis-cli keys "*payroll*"
```

- One job per run, id `payroll-run-<companyId>-<month>-<runId>`.
- Press Run twice quickly → the second submit is de-duplicated by the job id.
- Stop the worker mid-run → the run stays `CALCULATING`; restarting the worker
  with `npm run worker` resumes nothing on its own (by design: re-run writes a
  new version).
- Super Admin → Background Operations now lists the **payroll** queue.

## 10. Audit

```powershell
db.securityaudits.find({ action: /PAYROLL_RUN|PAYROLL_RECALCULATED|PAYROLL_EMPLOYEE_RECALCULATED/ })
```

---

# PART 4 — Known-by-design behaviour (not bugs)

| Behaviour | Why |
|---|---|
| Payroll refuses to run while the month is unlocked | §6 / §29 — monthly inputs must be final |
| A run with any error still finishes | §22 — errors are per-employee, never fatal |
| Recalculating writes a new version instead of editing | §19 — historical payroll is immutable |
| Without Redis the run is synchronous | The API runs without Redis (28.1); the response says `queued: false` |
| PF/ESI stop at the statutory ceiling | The law — a flat structure amount would not |
| TDS uses no investment declarations | 29.4 stores a declaration **status** only, so Chapter VI-A defaults to zero |
| Professional tax slabs are approximations | State law varies; the table is data in one file, reviewed by finance |
| Overtime rate is a preview read of 29.1 | §12 — the engine prices it, but the policy comes from configuration |
| HR Manager cannot recalculate | §21 |

---

# PART 5 — Still to come (29.7+)

Payroll review & approval, payroll lock approval, bank transfer file, salary
payment, payslip PDF, email payslips, finance approval, payroll reports,
final settlement.
