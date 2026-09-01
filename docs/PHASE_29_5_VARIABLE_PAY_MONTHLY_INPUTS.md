# Phase 29.5 — Variable Pay & Monthly Payroll Inputs

> Payroll programme: 29.1 Company Payroll Setup → 29.2 Salary Components →
> 29.3 Salary Structures → 29.4 Employee Payroll Profile → **29.5 Variable Pay
> & Monthly Inputs** → 29.6 Payroll Engine.

The **monthly payroll input workspace**: the screen HR opens every month, after
attendance/leave is closed and before the engine (29.6) runs.

```
Attendance + Leave  ──►  Monthly Input Workspace (29.5)  ──►  Payroll Engine (29.6)
   (read only)            variable pay, reimbursements,        (does the maths)
                          deductions, LOP, lock
```

**What this phase deliberately does NOT do (§25 / §26):**

| Not here | Owner |
|---|---|
| Payroll calculation, net salary, PF/ESI/TDS/PT | 29.6 Payroll Engine |
| Payslip generation | 29.6+ |
| Bank transfer file | 29.6+ |
| Payroll approval workflow | 29.6+ |
| Full & final settlement | later phase |
| Salary components / structures | 29.2 / 29.3 (read-only reference) |

Nothing in 29.5 writes to the salary structure, the employee payroll profile,
or the payroll setup. Variable pay is stored **per month**, next to the
employee, and handed to the engine as input.

---

## 1. Spec corrections applied

The pasted 29.5 spec contained a few items that conflict with the architecture
already shipped in 29.1–29.4. The corrections below follow the same standing
rule used in every earlier phase: **the spec is the requirement, the
architecture is the authority.**

| § | Spec said | Built instead | Why |
|---|---|---|---|
| §4 | Role names gate the screen (`HR Manager`, `Payroll Admin`…) | `PAYROLL_INPUT_READ` / `PAYROLL_INPUT_MANAGE` / `PAYROLL_INPUT_LOCK` permissions + the 29.1 payroll scope middleware | The platform has never used role names for access; Company Admin decides who receives the permission (§20). |
| §21 | Cache key `payroll:inputs:{companyId}:{month}` | `buildTenantCacheKey({ namespace: 'payroll-inputs', segments: [month] })` | The project's tenant cache-key helper is the single convention (Phase 28.7). |
| §22 | BullMQ job for Excel import | Pure synchronous parser (`parseImportCsv`) + `MAX_IMPORT_ROWS = 5000`, audit and notifications on the existing seams — **no new queue** | Same call as 29.3/29.4; a sub-second parse does not justify queue infrastructure. |
| §11 | Excel (xlsx) template | CSV template generated in the browser, parsed server-side | No new npm dependency, no file upload pipeline, and CSV is what Excel exports in one click. |
| §14 | LOP from the Leave module | `lopDays = absentDays` with `lopSource: 'ATTENDANCE'`; switches to `'LEAVE'` automatically when a LOP leave type exists | `LEAVE_TYPES` has no LOP type yet. The rule is written so the Leave module takes over the moment it owns one — no migration. |

---

## 2. What was reused (no new infrastructure)

| Concern | Reused from |
|---|---|
| Auth / tenant | `protect` + `tenantContext` (`req.companyId`) |
| Authorization | `requirePermission` / `requireAnyPermission` + `requireFeature('payroll')` |
| Who may see whom | `resolvePayrollVisibility` (new thin resolver on top of 29.1's `payrollAccessService`) |
| Working days, weekends, financial year, LOP policy | `PayrollSetup` (29.1) — read, never duplicated |
| Salary structure / profile existence check | `EmployeePayrollProfile` (29.4) — read only |
| Attendance, Leave, Holiday, Shift | Existing models — read only |
| Redis | Phase 28.7 `redisCacheService`, namespace `payroll-inputs`, TTL `PAYROLL_INPUT_CACHE_TTL_SECONDS` (default 300s, clamped 10–3600) |
| Audit | `recordAudit`, synchronous (29.1 → 29.4 discipline) |
| Notifications | `notifySmart` seam |
| Money handling | Whole rupees rounded to 2 decimals at the boundary; no float money is persisted |

---

## 3. What was added

### Backend

| File | Purpose |
|---|---|
| `src/services/payroll/monthlyInputRules.js` | **Pure** rules: period statuses/transitions, entry catalogue, CSV parsing, validation, totals, automatic-import maths. No mongoose, no redis, no `req`. |
| `src/models/PayrollPeriod.js` | One row per company + month (unique). Status, import stamps, lock/reopen/sent stamps. |
| `src/models/EmployeeMonthlyInput.js` | One row per company + month + employee (unique). Embeds `auto` (read-only imported figures) and `entries` (HR variable pay). |
| `src/services/payroll/monthlyInputService.js` | DI factory (`makeMonthlyInputService`) + wired default instance. Period, list, automatic import, CRUD, bulk actions, import preview/confirm, validation, status, cache invalidation. |
| `src/controllers/monthlyInputController.js` | Thin controller (3-line convention) |
| `src/validators/monthlyInputValidator.js` | Shape/enum validation only |
| `src/routes/monthlyInputRoutes.js` | `/api/payroll/inputs` |
| `src/middlewares/payrollInputScope.js` | Narrows every read through the 29.1 payroll scope |
| `test/monthlyInputs.test.js` | 26 hermetic tests (no MongoDB, no Redis) |

### Frontend

| File | Purpose |
|---|---|
| `src/services/monthlyInputService.js` | API wrapper + in-browser CSV template download |
| `src/pages/payroll/MonthlyInputsPage.jsx` | Month dashboard, KPI cards, input table, employee drawer, bulk import, bulk actions, validation report, lock/reopen |
| `layout/AppLayout.jsx`, `routes/AppRoutes.jsx`, `layout/SidebarNav.jsx` | Permission-gated nav entry + `/app/payroll/inputs` route |

### Permission catalogue

Three new permissions: `PAYROLL_INPUT_READ`, `PAYROLL_INPUT_MANAGE`,
`PAYROLL_INPUT_LOCK`. `SYSTEM_PERMISSION_VERSION` → **19**; catalogue size
**202**.

| Role | READ | MANAGE | LOCK |
|---|---|---|---|
| COMPANY_ADMIN | yes | yes | yes |
| HR_MANAGER | yes | yes | no (§20) |
| MANAGER | yes | no | no |
| TEAM_LEAD / EMPLOYEE | no | no | no |
| `ROLE_TEMPLATES.PAYROLL_ADMIN` | yes | yes | yes |

---

## 4. Domain model

### Payroll period (§5, §20)

```
NOT_STARTED → ATTENDANCE_IMPORTED → COLLECTING_INPUTS → VALIDATED → LOCKED → SENT_TO_PAYROLL
                                          ↑                            │
                                          └────── reopen ──────────────┘
```

- Every write auto-creates the period (`ensurePeriod`), so HR never sees an
  empty screen.
- Cycle, working days and financial year are **copied** from 29.1 at creation
  time — the month is a snapshot, not a live join.
- `LOCKED` and `SENT_TO_PAYROLL` reject `importAutomatic`, `addEntry`,
  `updateEntry`, `removeEntry`, `bulkAction` and `confirmImport` with
  `400 … is locked. Reopen it before …`.
- Locking runs validation first and refuses while `withErrors > 0`.
- Reopening (`LOCKED → COLLECTING_INPUTS`) is the only way back and is audited
  as `PAYROLL_INPUTS_REOPENED`.

### Employee monthly input (§13)

```
{
  companyId, month, employeeId,
  auto: {                       // imported, READ ONLY
    workingDays, presentDays, lateMarks, halfDays, absentDays,
    paidLeaveDays, leaveBreakdown: { CASUAL, SICK, EARNED, OTHER },
    lopDays, lopHours, lopSource, lopLeaveIds,
    otMinutes, otHours, otPolicy: { enabled, basis, multiplier },
    nightShiftCount, weekendShiftCount, holidayShiftCount
  },
  entries: [                    // HR's variable pay
    { entryId, type, amount, reason, remarks, effectiveMonth, claimDate,
      claimStatus, approvedBy, approvedAt,
      source: 'MANUAL' | 'BULK_IMPORT' | 'BULK_ACTION' }
  ],
  remarks: '...',               // §10 HR notes, audited
  issues: [...],                // recomputed on every read, never trusted
  status: 'PENDING' | 'READY' | 'ERROR' | 'LOCKED',
  lockedAt
}
```

**Status is derived, never stored**: `locked → LOCKED`, `issues.length →
ERROR`, otherwise `READY`. A row with no variable pay and no issue is `PENDING`
until HR touches it.

### Entry catalogue (§9, §10)

19 types across six categories: `BONUS` (5), `INCENTIVE`, `COMMISSION`,
`OVERTIME`, `REIMBURSEMENT` (6), `DEDUCTION` (4), `RECOVERY`, `ADJUSTMENT`.
The catalogue is returned in the list response (`meta.entryTypes`) so the UI
never hard-codes it.

Reimbursements (§16) are monthly claims, **never** salary components: they do
not touch the structure, they carry a `claimStatus`, and rejected claims are
excluded from totals while remaining visible in the drawer.

### Automatic inputs in detail (§7 / §14 / §15)

- **Leave** is split by type (`CASUAL` / `SICK` / `EARNED` / `OTHER`) beside the
  paid total, so the drawer shows where the days came from. Only `APPROVED`
  leave counts.
- **LOP** keeps the leave record ids behind it (`lopLeaveIds`) when the Leave
  module owns a LOP type; otherwise the figure is attendance absence and
  `lopSource` says `'ATTENDANCE'`. HR cannot edit either — the source module
  owns the number.
- **Overtime** stores `otHours` plus a **preview** of the 29.1 policy
  (`basis`, `multiplier`). No amount is ever produced in 29.5 — §15 asks for a
  rate preview, §26 forbids the calculation.
- **Shifts** count night, weekend and holiday shifts using the company's own
  Shift master (`NIGHT` type, a night allowance, or a start time after the end
  time) and the 29.1 weekend policy.

### Claims and approvals (§16 / §17)

Every reimbursement carries `claimStatus` (`PENDING` / `APPROVED` / `REJECTED`),
`claimDate`, `approvedBy` and `approvedAt`. HR entering a claim **is** the
approval, so the actor is stamped; a pending claim stays visible with no
approver, and rejected claims never enter the totals. Claims can be approved or
rejected inline from the drawer.

---

## 5. Validation (§19)

| Rule | Message |
|---|---|
| Month | `Payroll month must look like 2026-08` |
| Employee | not found in this company / not `ACTIVE` |
| Profile | employee has no 29.4 payroll profile |
| Structure | the profile has no salary structure attached |
| Entry type | unknown entry type |
| Amount | must be greater than zero |
| Reason | required for every entry |
| Claim date | must fall inside the payroll month |
| Duplicate | the same type + amount + reason already exists this month |

Validation is **recomputed on read** — the stored `issues` array is a cache,
not a source of truth, so fixing an attendance record or a profile clears the
error without a repair script.

---

## 6. Bulk import (§11)

1. **Template** — generated in the browser: `employeeCode,type,amount,reason,claimDate,remarks`.
2. **Preview** (`POST /bulk/preview`) — parses the CSV, resolves each
   `employeeCode` to an employee **in this company**, and returns `accepted` /
   `rejected` with line numbers and reasons. Nothing is stored.
3. **Confirm** (`POST /bulk/confirm`) — re-validates every row server-side,
   skips the invalid ones, audits `PAYROLL_INPUT_BULK_IMPORT`.

Guards: header must contain `employeeCode`, `type` and `amount`;
`MAX_IMPORT_ROWS = 5000`; intra-file duplicates are rejected.

---

## 7. Bulk actions (§12)

`ADD_FESTIVAL_BONUS`, `ADD_INTERNET_ALLOWANCE`, `APPLY_MEAL_REIMBURSEMENT`,
`MARK_ZERO_BONUS`, `REMOVE_IMPORTED_ENTRIES`. Each writes **one audit entry per
employee** (`PAYROLL_INPUT_BULK_ACTION`) and invalidates the month cache.

---

## 8. API

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/api/payroll/inputs/periods` | READ | Period history |
| GET | `/api/payroll/inputs?month=&search=&status=` | READ | Table + KPIs + catalogue |
| POST | `/api/payroll/inputs/import` | MANAGE | Attendance/leave/shift import |
| GET | `/api/payroll/inputs/employee/:employeeId?month=` | READ | Drawer payload |
| POST | `/api/payroll/inputs/employee/:employeeId/entries` | MANAGE | Add entry |
| PATCH | `/api/payroll/inputs/employee/:employeeId/entries/:entryId` | MANAGE | Edit entry |
| DELETE | `/api/payroll/inputs/employee/:employeeId/entries/:entryId?month=` | MANAGE | Remove entry |
| POST | `/api/payroll/inputs/bulk/preview` | MANAGE | Parse CSV |
| POST | `/api/payroll/inputs/bulk/confirm` | MANAGE | Store rows |
| POST | `/api/payroll/inputs/bulk/action` | MANAGE | Bulk action |
| POST | `/api/payroll/inputs/validate` | MANAGE/LOCK | §19 report |
| PATCH | `/api/payroll/inputs/employee/:employeeId/remarks` | MANAGE | §10 HR notes |
| POST | `/api/payroll/inputs/status` | MANAGE/LOCK | §20 lock / reopen |

Audit actions emitted: `PAYROLL_PERIOD_CREATED`, `PAYROLL_INPUTS_IMPORTED`,
`PAYROLL_BONUS_ADDED`, `PAYROLL_REIMBURSEMENT_ADDED`,
`PAYROLL_DEDUCTION_ADDED`, `PAYROLL_INPUT_EDITED`,
`PAYROLL_INPUT_BULK_ACTION`, `PAYROLL_INPUT_BULK_IMPORT`,
`PAYROLL_INPUTS_VALIDATED`, `PAYROLL_INPUTS_<STATUS>`,
`PAYROLL_INPUTS_REOPENED`.

---

### §9 table / §25 KPIs

The table is the column list of §9 — employee, department, working days, LOP
(with its source), OT hours, bonus, reimbursement, deduction, status, actions —
and the KPI strip is the §25 list: total employees, ready employees, pending
validation, locked status, total bonus, total reimbursements, total deductions,
plus LOP days. A period strip above them shows the month, financial year,
payroll cycle and working days copied from 29.1 (§6).

## 9. Tenant isolation & RBAC

- Every query is filtered by `companyId` first; no controller ever reads a
  client-supplied company id.
- `payrollInputScope` resolves the actor's payroll visibility: `null` means the
  whole company, otherwise the manager's subtree plus themselves. A
  single-employee request outside that set is rejected with
  `403 PAYROLL_ACCESS_DENIED`.
- Cross-company reads are impossible by construction: `companyId` is part of
  every unique index and every filter.

---

## 10. Tests

```
node --test test/monthlyInputs.test.js   → 32 tests, 32 pass
npm run test:payroll                     → 180 tests, 180 pass
node --test test/redisFoundation.test.js test/bullmqFoundation.test.js test/opsQueueOps.test.js
                                         → 104 tests, 104 pass
```

284/284 green, hermetic (no MongoDB, no Redis, no network).

## 11. What 29.6 gets

A locked month, per employee: attendance/leave counts in `auto`, a clean list
of variable entries with categories, and a validation report that already
passed. The engine reads this document and calculates — it never re-derives
attendance, and it never re-validates HR's input.
