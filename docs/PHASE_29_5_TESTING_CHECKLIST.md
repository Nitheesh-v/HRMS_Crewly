# Phase 29.5 — What was built and how to test it

Windows PowerShell commands throughout.

---

# PART 1 — What has been implemented

## Monthly Payroll Input Workspace (new)

| Area | Shipped |
|---|---|
| Models | `PayrollPeriod` (company + month) and `EmployeeMonthlyInput` (company + month + employee) |
| Rules | Pure module: period statuses/transitions, 19 entry types, CSV parsing, validation, totals, automatic-import maths |
| Service | Period, list, automatic import, entry CRUD, bulk actions, import preview/confirm, validation, lock/reopen, cache invalidation |
| API | 12 routes at `/api/payroll/inputs` |
| Access | `payrollInputScope` middleware on top of `PAYROLL_INPUT_*` + the 29.1 payroll scope |
| Permissions | `PAYROLL_INPUT_READ` / `_MANAGE` / `_LOCK`; `SYSTEM_PERMISSION_VERSION = 19`; catalogue 202 |
| UI | `/app/payroll/inputs` — month dashboard, KPI cards, input table, employee drawer, bulk import, bulk actions, validation report, lock/reopen |

## Brief corrections applied

| The brief said | What was built |
|---|---|
| Gate on role names | Gate on **permissions** + payroll scope (the 29.1 model) |
| Cache key `payroll:inputs:{companyId}:{month}` | `buildTenantCacheKey({ namespace: 'payroll-inputs', segments: [month] })` |
| BullMQ for the Excel import | Synchronous pure parser with a 5,000-row cap — no new queue (same call as 29.3/29.4) |
| Excel (xlsx) template | CSV template generated in the browser — no new npm dependency |
| LOP from the Leave module | `lopDays = absentDays` with `lopSource: 'ATTENDANCE'`; switches to `'LEAVE'` the moment a LOP leave type exists |

---

# PART 2 — What the automated tests already prove

```powershell
cd Backend
npm run test:monthly-inputs   # 26 tests
npm run test:payroll          # 29.1 + RBAC + 29.2 + 29.3 + 29.4 + 29.5  → 174
node --test test/redisFoundation.test.js test/bullmqFoundation.test.js test/opsQueueOps.test.js   # 104
```

Full hermetic ladder (no MongoDB, no Redis, no network): **278/278 green**.

- period auto-creation, month format, tenant scoping on every query
- illegal period transitions return 400; reopen is the only way out of LOCKED
- automatic import: present / absent / half-day / late / LOP / overtime / night
  and weekend shifts, holidays
- LOP source is `ATTENDANCE` until a LOP leave type appears, then `LEAVE`
- entries: add, edit, remove, duplicate detection, amount > 0, reason required,
  claim date must sit inside the month
- status derivation: locked → LOCKED, issues → ERROR, otherwise READY
- bulk actions add/edit entries per employee and audit once per employee
- CSV: header guard, quote-aware parsing, intra-file duplicates, unknown
  employee codes, 5,000-row cap
- validation blocks locking while any employee has an error; locking freezes
  every row; reopening clears the freeze and audits `PAYROLL_INPUTS_REOPENED`
- scope: a non-null payroll scope narrows the list; an out-of-scope
  single-employee read is refused
- cache key, TTL clamping, invalidation on every write
- permissions: COMPANY_ADMIN all three; HR_MANAGER no LOCK; MANAGER read only;
  TEAM_LEAD/EMPLOYEE nothing

---

# PART 3 — What you must test manually

## 0. One-time setup

```powershell
cd Backend;  npm install; npm run seed; npm run dev     # Terminal 1
cd Frontend; npm install; npm run dev                   # Terminal 2
```

Seed login `admin@crewly.com` / `Admin@123` · UI http://localhost:5173.

Prerequisites from earlier phases:
- Payroll Setup **activated** (29.1).
- An **active** salary structure (29.3) and at least two employees with an
  **active** 29.4 payroll profile.
- Some attendance and leave records in the month you test (otherwise the import
  builds rows with zeros).

```powershell
$body = @{ companyCode="<CODE>"; email="admin@crewly.com"; password="Admin@123" } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri "http://localhost:5000/api/auth/login" -Body $body -ContentType "application/json"
$headers = @{ Authorization = "Bearer $($login.data.token)"; "Content-Type" = "application/json" }
```

## 1. Open the month (§25 dashboard)

1. **Payroll → Monthly Inputs**.
2. Pick the month you seeded attendance for.
3. Empty state: *"No employee inputs for <month>. Import attendance and leave
   to build the month."*
4. **Import attendance & leave** → rows appear with present / absent / LOP /
   paid leave counts, and the period moves to `ATTENDANCE_IMPORTED` →
   `COLLECTING_INPUTS`.
5. The eight KPI cards show employees, ready, pending, errors, variable
   earnings, reimbursements, deductions and LOP days.

## 2. Employee input drawer (§13)

1. **Open drawer** on any employee.
2. The **Automatic inputs** strip is read-only: working days, present, absent,
   LOP, paid leave, late marks, half days, overtime hours, night / weekend /
   holiday shifts.
3. Add a **Performance Bonus** of 5000 with a reason → the row totals update.
4. Add a **Travel Reimbursement** with a claim date outside the month → **400**
   (*claim date must fall inside the month*).
5. Add the same bonus again → rejected as a duplicate.
6. Edit the bonus to 6000, then remove it → the table and KPIs follow.
7. Fixing attendance and re-importing **replaces** the auto figures; manual
   entries survive.

## 3. Bulk import (§11)

1. **Bulk import → Template** → open the CSV in Excel.
2. Add two valid rows and one row with an unknown employee code.
3. **Preview**: 2 accepted, 1 rejected with the line number and reason.
4. **Confirm** → entries land on the right employees; the audit log shows
   `PAYROLL_INPUT_BULK_IMPORT`.
5. Paste 5,001 rows → rejected rows report the cap.
6. A file whose header lacks `employeeCode` is refused.

## 4. Bulk actions (§12)

1. Tick three employees → **Bulk action (3)**.
2. **Add festival bonus**, 5000, reason *Diwali* → every selected employee gets
   the entry, and the audit log has **one** `PAYROLL_INPUT_BULK_ACTION` per
   employee.
3. **Remove imported entries** → only rows with `source: 'IMPORT'` disappear.

## 5. Validation and lock (§19 / §20)

1. Remove an employee's payroll profile (or set them inactive) → **Validation
   report** lists the issue with a **Fix** button.
2. **Lock month** → refused: *"N employee(s) still have validation errors."*
3. Fix the employee, lock again → period `LOCKED`, every row shows **locked**,
   and add/edit/remove/import are disabled with a banner explaining why.
4. `POST /api/payroll/inputs/status` with `LOCKED` twice → 400 (no transition).
5. **Reopen month** → `COLLECTING_INPUTS`, edits work again, and
   `PAYROLL_INPUTS_REOPENED` is in the audit log.

## 6. Permissions (§4 / §24)

| Account | Expectation |
|---|---|
| Company Admin | Everything, including lock/reopen |
| HR Manager | Read + manage; **no** Lock/Reopen button |
| Manager | Read-only; sees only their subtree plus themselves |
| Team Lead / Employee | No Monthly Inputs entry at all |

API check as a manager:
`GET /api/payroll/inputs/employee/<outside-subtree>` → **403 PAYROLL_ACCESS_DENIED**.

## 7. Tenant isolation (do this)

1. Build a month in company A.
2. With company B's token, `GET /api/payroll/inputs?month=<month>` → empty.
3. `GET /api/payroll/inputs/employee/<A-employee-id>` → refused.
4. `POST /api/payroll/inputs/bulk/confirm` with company A employee ids → the
   ids resolve only inside the caller's company.

## 8. Redis (§21)

```powershell
docker exec -it <redis> redis-cli --scan --pattern "*payroll-inputs*"
```

Populated on first list; deleted after every write (import, entry CRUD, bulk
action, validation, status change). Stop Redis → the page still works
(fail-open). TTL honours `PAYROLL_INPUT_CACHE_TTL_SECONDS` (default 300).

## 9. Audit

```powershell
db.securityaudits.find({ action: /PAYROLL_INPUT|PAYROLL_PERIOD|PAYROLL_BONUS|PAYROLL_REIMBURSEMENT|PAYROLL_DEDUCTION/ })
```

Every write has a row; bulk operations write one per employee.

---

# PART 4 — Known-by-design behaviour (not bugs)

| Behaviour | Why |
|---|---|
| Absent days equal LOP days | §14 — the Leave module has no LOP type yet; the moment it does, `lopSource` flips to `LEAVE` |
| Imported figures cannot be edited in the drawer | §13 — attendance/leave is the source of truth; re-import to correct |
| Variable pay never changes the salary structure | §16 — reimbursements are monthly claims, not components |
| Status is not stored | It is derived from issues and the lock flag, so it can never go stale |
| A month with no inputs still exists | `ensurePeriod` creates it on the first write, so HR never faces an empty screen |
| Locking validates first | §20 — a locked month must be correct |
| Reopening is the only way back | §20 — deliberate, and always audited |
| Import is synchronous | §22 — a sub-second parse with a row cap; no queue needed |
| No salary, PF, ESI, TDS or net pay is computed here | §26 — that is the 29.6 engine |

---

# PART 5 — Still to come (29.6+)

Monthly payroll run, payroll engine, payslips, bank transfer files,
PF/ESI/TDS/PT calculations, attendance-based salary calculation, payroll
approval workflow, payroll reports, full & final settlement.
