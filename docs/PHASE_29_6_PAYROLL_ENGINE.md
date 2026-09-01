# Phase 29.6 — Payroll Calculation Engine

> Payroll programme: 29.1 Company Payroll Setup → 29.2 Salary Components →
> 29.3 Salary Structures → 29.4 Employee Payroll Profile → 29.5 Variable Pay
> & Monthly Inputs → **29.6 Payroll Calculation Engine** → 29.7 Payroll Review
> & Approval.

The **heart of the payroll system**: it turns configured data into a monthly
salary for every active employee, and stores the result as an immutable
snapshot.

```
Structure (29.3)  ─┐
Profile   (29.4)  ─┼─►  Payroll Engine (29.6)  ─►  Immutable snapshot  ─►  29.7 Review
Monthly inputs ────┘                                                        (approval)
(29.5)
```

**What this phase deliberately does NOT do (§31):**

| Not here | Owner |
|---|---|
| HR review / payroll approval | 29.7 |
| Lock approval | 29.7 |
| Bank transfer file, salary payment | later |
| Payslip PDF, email payslips | later |
| Finance approval | 29.7 |
| Full & final settlement | later |

---

## 1. Spec corrections applied

The pasted 29.6 spec follows the same standing rule as every earlier phase:
**the spec is the requirement, the architecture is the authority.**

| § | Spec said | Built instead | Why |
|---|---|---|---|
| §4 | Role names (`Company Admin`, `Payroll Admin`, `HR Manager`, `Finance`) | Existing permissions `PAYROLL_RUN_READ` / `PAYROLL_RUN_EXECUTE` / `PAYROLL_RUN_RECALCULATE` + the 29.1 payroll scope | The platform has never gated on role names; the 29.1 catalogue already declared these permissions for exactly this phase. No new permissions were needed. |
| §21 | "Only Payroll Admin and Company Admin" recalculate | `PAYROLL_RUN_RECALCULATE` removed from the default HR Manager matrix (they keep READ + EXECUTE) | The rule is enforced by permission, and the Payroll Admin template holds it. |
| §25 | Cache key `payroll:summary:{companyId}:{month}` | `buildTenantCacheKey({ namespace: 'payroll-run', segments: [month, 'summary'\|'results'\|'errors'] })` | The project's tenant cache-key helper is the single convention (Phase 28.7). |
| §26 | BullMQ background job | **Implemented for real**: a reserved `payroll` queue, a `payroll-run` job, a worker processor with `updateProgress`, and deterministic job ids. When Redis is **not** configured the same loop runs inline. | Thousands of employees justify a queue. The inline fallback exists because the API runs without Redis by 28.1 policy — it is declared in the response (`meta.queued`) and the UI says so. |
| §15 | PF / ESI / PT / TDS | Computed by the engine from 29.1 applicability + 29.4 employee flags, with rates/ceilings in one pure module | 29.1's own model says "no rates, ceilings or formulas — the engine decides those later (§10)". |
| §9 | Don't hardcode Basic/HRA | Earnings come from 29.3 `computeStructurePreview` on the profile's gross | The structure is the single source of the rules. |
| §19 | Immutable snapshot | Recalculation writes `version n+1` and marks it current; `n` is never updated or deleted | History is immutable by construction. |

---

## 2. What was reused (no new infrastructure)

| Concern | Reused from |
|---|---|
| Auth / tenant | `protect` + `tenantContext` (`req.companyId`) |
| Authorization | `requirePermission` / `requireAnyPermission` + `requireFeature('payroll')` |
| Who may see whom | `resolvePayrollVisibility` (29.1) via `middlewares/payrollRunScope.js` |
| Earnings rules | `computeStructurePreview` (29.3) — pure, never re-implemented |
| Applicability, LOP basis, OT policy, cycle | `PayrollSetup` (29.1) — read, never duplicated |
| Gross, CTC, tax regime, statutory identity | `EmployeePayrollProfile` (29.4) — read only |
| Attendance/leave figures, bonus, claims, deductions | `EmployeeMonthlyInput` (29.5) — read only, never re-derived |
| Redis | Phase 28.7 `redisCacheService`, namespace `payroll-run`, TTL `PAYROLL_RUN_CACHE_TTL_SECONDS` (default 300s, clamped 10–3600) |
| BullMQ | Phase 28.2 `queueFactory` / `queueConfig` / worker registry (28.2 discipline preserved) |
| Audit | `recordAudit` (synchronous, 29.1 → 29.5 discipline) |
| Notifications | `notifySmart` seam |

---

## 3. What was added

### Backend

| File | Purpose |
|---|---|
| `src/services/payroll/payrollEngineRules.js` | **Pure** engine: payable days, LOP, OT, PF/ESI/PT/TDS/gratuity/LWF, pre-checks, the pipeline, KPIs. No mongoose, no redis, no `req`. |
| `src/models/PayrollRun.js` | One control record per company + month: status, live progress, summary, cycle copy, run counter |
| `src/models/PayrollResult.js` | The §18/§19 snapshot per company + month + employee + version |
| `src/services/payroll/payrollEngineService.js` | DI factory + wired default: start, process, recalculate, cancel, read, cache |
| `src/services/payroll/payrollRunDispatcher.js` | Payload validation + `payroll-run` job on the `payroll` queue (references only) |
| `src/workers/payrollProcessor.js` | Worker processor: revalidates Mongo state, runs the loop, reports progress |
| `src/controllers/payrollEngineController.js`, `validators/payrollEngineValidator.js`, `routes/payrollEngineRoutes.js` | `/api/payroll/runs` (7 routes) |
| `src/middlewares/payrollRunScope.js` | Narrows reads through the 29.1 payroll scope; out-of-scope single reads → 403 |
| `test/payrollEngine.test.js` | 27 hermetic tests |

### Wiring changes

| File | Change |
|---|---|
| `src/config/queueConfig.js` | `QUEUE_NAMES.PAYROLL`, `JOB_NAMES.PAYROLL_RUN`, `PAYROLL_JOB_OPTIONS` (1 attempt — a re-run is safer than a duplicate), `parsePayrollWorkerConcurrency` |
| `src/workers/index.js` | Registers the payroll processor and starts the `payroll` worker |
| `src/services/opsQueueRegistry.js` | The payroll queue is exposed to the 28.8 operations tooling (8 queues now) |
| `src/utils/permissionRegistry.js` | HR Manager loses `PAYROLL_RUN_RECALCULATE` (§21) |
| `src/utils/permissionService.js` | `SYSTEM_PERMISSION_VERSION` → **20** |
| `Backend/.env.example` | `PAYROLL_RUN_CACHE_TTL_SECONDS`, `PAYROLL_WORKER_CONCURRENCY` |

### Frontend

| File | Purpose |
|---|---|
| `src/services/payrollRunService.js` | API wrapper |
| `src/pages/payroll/RunPayrollPage.jsx` | Month + pre-checks, KPI cards, live progress tracker, results table, employee breakdown drawer, error report |
| `layout/AppLayout.jsx`, `routes/AppRoutes.jsx`, `layout/SidebarNav.jsx` | Permission-gated **Run Payroll** entry + `/app/payroll/run` |

---

## 4. The calculation pipeline (§8 / §17)

For every active employee, in this order:

1. **Earnings** — `computeStructurePreview` (29.3) on the profile's monthly
   gross. Basic, HRA, special allowance, conveyance… whatever the company
   configured. The engine invents no percentages.
2. **Attendance → payable days** — `payableDays = workingDays − lopDays`,
   using the LOP basis from 29.1 (`PER_DAY` / `PER_HOUR` /
   `PAYABLE_WORKING_DAYS`). Attendance is read-only (§10).
3. **LOP deduction** — `earnings × lopDays ÷ workingDays`, stored as its own
   deduction line with source `ATTENDANCE` (§11). Never a silent haircut.
4. **Overtime** — 29.1 policy: `HOURLY`/`CUSTOM` = an hour of monthly gross ×
   multiplier; `FIXED` = the multiplier as a rupee rate (§12).
5. **Variable earnings** — bonus, incentive, commission from 29.5, each kept
   separate (§13). Never merged into Basic.
6. **Reimbursements** — approved claims only; rejected claims stay visible but
   never reach payroll (§14 / §16).
7. **Statutory deductions** — PF (12% on PF wages, ₹15,000 ceiling, employer
   split into EPS 8.33% + EPF), ESI (0.75% / 3.25%, ₹21,000 ceiling, no
   coverage above it), Professional Tax (state slab table), TDS (annualised,
   regime-aware, standard deduction, §87A rebate, 4% cess, spread over the
   months left in the financial year minus TDS already deducted), LWF.
8. **Other deductions** — the structure's own (non-statutory) deduction lines
   plus every 29.5 deduction/recovery entry.
9. **Employer contributions** — employer PF, employer ESI, gratuity (4.81% of
   basic), employer LWF, plus any non-statutory `EMPLOYER_CONTRIBUTION`
   component. They **do not** reduce net salary (§16).
10. **Totals** — `totalEarnings = earnings + variable + OT`;
    `netPay = totalEarnings + reimbursements − deductions`;
    `employerCost` and `ctc` are reported alongside.

Every one of those numbers is stored on the snapshot. Nothing is recomputed
after the fact (§17 / §19).

### Statutory rules are data

`STATUTORY_RULES` and `PROFESSIONAL_TAX_SLABS` live at the top of
`payrollEngineRules.js` — one place, pure data, no logic. When the law changes,
that table changes; the engine does not.

---

## 5. Pre-checks and error handling (§6 / §22 / §29)

**Before the run** (company level, hard stop — nothing is calculated):

- Payroll Setup must be `ACTIVE`
- A payroll cycle must exist
- A company bank account must be configured
- The monthly inputs for the month must be `LOCKED` or `SENT_TO_PAYROLL`

**Per employee** (the run continues; the employee becomes an `ERROR` result
with human-readable reasons):

- Employee not found / not `ACTIVE`
- No payroll profile, or the profile is not `ACTIVE`
- No structure assigned, or the structure is missing / not `ACTIVE`
- No effective monthly gross

Failed employees are **persisted** as `PayrollResult` documents with
`status: 'ERROR'` and their `issues[]`, so the error report is a query rather
than a reconstruction of the last run.

---

## 6. Snapshots, versions, recalculation (§19 / §21)

```
v1  calculated  ─►  isCurrent: true
                     │
recalculate  ────────┴─►  v1 isCurrent: false (never modified, never deleted)
                          v2 isCurrent: true
```

- A recalculation of the whole month writes `v(n+1)` for every employee.
- A single-employee recalculation writes `v(n+1)` for that employee only.
- `isCurrent` is what the dashboard and the table read.
- The run keeps `runCount` and flips to `RECALCULATED` after the first run.

---

## 7. Background processing (§26 / §27)

```
POST /api/payroll/runs/:month/run
   │
   ├─ Mongo intent: PayrollRun (status DRAFT, cycle copy, actor)
   ├─ enqueue `payroll-run` on the `payroll` queue
   │     jobId = payroll-run-<companyId>-<month>-<runId>   (deterministic)
   │     payload = { companyId, month, runId, actorId, trigger, employeeIds }
   │               references only — no salary figures, no PII
   └─ worker: re-reads everything from Mongo, calculates, updates progress
```

- **Progress** is written to the run document after every employee **and**
  pushed to BullMQ (`job.updateProgress`), so the UI shows
  `260 / 300 · 86% · Asha Rao · calculating`.
- **HR can leave the page** — the worker owns execution. The UI polls the run
  every 3 seconds while the status is `CALCULATING`.
- **One attempt, no automatic retry**: a partial run is recoverable by running
  again (the version system makes that safe), whereas a duplicate run would
  double-write snapshots. The job id is deterministic, so BullMQ itself
  de-duplicates a double submit.
- **No Redis**: the API runs the identical loop inline and the response says so
  (`meta.queued: false`). Payroll is never blocked by infrastructure.

---

## 8. API

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/payroll/runs` | READ | Run history |
| GET | `/api/payroll/runs/:month` | READ | Run + live progress + KPIs (cached) |
| GET | `/api/payroll/runs/:month/results` | READ | Employee results (`status`, `search`) |
| GET | `/api/payroll/runs/:month/results/:employeeId` | READ | One snapshot (§24) |
| POST | `/api/payroll/runs/:month/run` | EXECUTE | Start the run |
| POST | `/api/payroll/runs/:month/recalculate` | RECALCULATE | Month or selection |
| POST | `/api/payroll/runs/:month/cancel` | EXECUTE | Cancel a queued run |

Permission mapping (§4):

| Role | READ | EXECUTE | RECALCULATE |
|---|---|---|---|
| Company Admin | yes | yes | yes |
| Payroll Admin (template) | yes | yes | yes |
| Payroll Executive (template) | yes | yes | yes |
| HR Manager | yes | yes | **no** (§21) |
| Finance Manager (template) | yes | no | no |
| Manager / Team Lead / Employee | no | no | no |

Audit actions: `PAYROLL_RUN_STARTED`, `PAYROLL_RUN_COMPLETED`,
`PAYROLL_RUN_FAILED`, `PAYROLL_RUN_CANCELLED`, `PAYROLL_RECALCULATED`,
`PAYROLL_EMPLOYEE_RECALCULATED`.

---

## 9. Tenant isolation & security (§30)

- Every query is `companyId`-first; no route accepts a company id from the
  client.
- `payrollRunScope` resolves the actor's payroll visibility: `null` = whole
  company, otherwise the manager's subtree plus themselves. An out-of-scope
  single-employee read is `403`.
- Queue payloads carry references only — never salary figures, never PII — and
  are validated again by the worker before use.
- Snapshots are immutable after the fact; only a new version can supersede
  them.

---

## 10. Tests

```
node --test test/payrollEngine.test.js    → 27 tests, 27 pass
npm run test:payroll                      → 207 tests, 207 pass
node --test test/redisFoundation.test.js test/bullmqFoundation.test.js test/opsQueueOps.test.js
                                          → 104 tests, 104 pass
```

311/311 green, hermetic (no MongoDB, no Redis, no BullMQ).

Two existing 28.8 tests were updated (7 → 8 queues) and one 29.1 RBAC test now
asserts the §21 recalculation rule.

## 11. What 29.7 gets

A completed, versioned, immutable snapshot per employee with every
intermediate value — ready for review, approval, and (later) payment. 29.7
adds the human decision on top; it does not recalculate anything.
