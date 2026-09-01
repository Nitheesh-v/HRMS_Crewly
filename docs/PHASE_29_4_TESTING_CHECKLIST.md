# Phase 29.4 — What was built and how to test it

Windows PowerShell commands throughout.

---

# PART 1 — What has been implemented

## Employee Payroll Profile (new)

| Area | Shipped |
|---|---|
| Model | `EmployeePayrollProfile` — tenant-scoped, versioned, encrypted bank, one current profile per employee |
| Rules | Pure module: statuses/transitions, IFSC/PAN/UAN/ESI/Aadhaar formats, masking, CTC↔gross, statutory-follows-29.1, revision dates |
| Service | Create / read / revise / status / preview / list / `createFromOffer` |
| API | 5 routes at `/api/payroll/employees` |
| Access | `payrollProfileAccess` middleware on top of `EMPLOYEE_SALARY_*` + the 29.1 payroll scope |
| Permissions | `EMPLOYEE_SALARY_READ` / `_MANAGE` / new `_READ_SELF`; `SYSTEM_PERMISSION_VERSION = 18` |
| UI | `/app/payroll/employees` (list) and `/app/payroll/employees/:employeeId` (5 tabs + editor with live breakup) |
| Recruitment | Conversion seeds a DRAFT profile from the offered CTC (§19) |

## Brief corrections applied

| The brief said | What was built |
|---|---|
| Gate on role names | Gate on **permissions** + payroll scope (the 29.1 model) |
| Cache key `payroll:employee:{employeeId}` | `buildTenantCacheKey({ namespace: 'payroll-employee' })` |
| BullMQ for audit / notifications | Synchronous `recordAudit` + the `notifySmart` seam — no new queue |
| "Gross must align with CTC" | Enforced as `CTC = 12 × (gross + employer cost)` from the assigned structure |
| Employee "view own" | `EMPLOYEE_SALARY_READ_SELF`, granted to EMPLOYEE only (Manager/Team Lead get nothing) |

---

# PART 2 — What the automated tests already prove

```powershell
cd Backend
npm run test:employee-payroll   # 24 tests
npm run test:payroll            # 29.1 + RBAC + 29.2 + 29.3 + 29.4
```

Full hermetic ladder (no MongoDB, no Redis, no network): **252/252 green**.

- formats: IFSC / PAN / UAN / ESI / Aadhaar / account number
- masking: `XXXX XXXX 9012`; audit writes `[REDACTED]`
- normalization drops client tenant and lineage fields
- CTC must align with gross + employer contributions
- only an ACTIVE structure of this company can be assigned
- UAN required to go ACTIVE only when 29.1 has PF on; ESI the same
- a revision cannot start before the salary it replaces, nor on a used date
- §9 preview splits gross, fills Remaining, annualises CTC
- create stores a masked mirror and audits `EMPLOYEE_PAYROLL_CREATED`
- a CTC change writes v2 and freezes v1 (isCurrent false, effectiveTo set)
- status transitions; illegal ones return 400
- activating without the statutory identity the company requires → 400
- tenant isolation: another company cannot read or save the profile
- `createFromOffer` is idempotent and does nothing without a CTC
- permissions: Manager/Team Lead hold nothing; Employee holds READ_SELF only
- ESM-only sources, `select: false` on the encrypted field, no role-name checks

---

# PART 3 — What you must test manually

## 0. One-time setup

```powershell
cd Backend;  npm install; npm run seed; npm run dev     # Terminal 1
cd Frontend; npm install; npm run dev                   # Terminal 2
```

Seed login `admin@crewly.com` / `Admin@123` · UI http://localhost:5173.

Prerequisites from earlier phases:
- Payroll Setup **activated** (29.1) with PF on, ESI on (so the statutory rules are visible).
- Salary Components **active** (29.2) — use **Add defaults**.
- A salary structure **ACTIVE** (29.3).

```powershell
db.subscriptions.updateOne({}, { $set: { plan: "ENTERPRISE" } })   # if the Payroll menu is missing
```

```powershell
$body = @{ companyCode="<CODE>"; email="admin@crewly.com"; password="Admin@123" } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri "http://localhost:5000/api/auth/login" -Body $body -ContentType "application/json"
$headers = @{ Authorization = "Bearer $($login.data.token)"; "Content-Type" = "application/json" }
```

## 1. Create a profile (UI)

1. **Payroll → Employee Payroll**.
2. Under *Employees without a payroll profile*, click a name.
3. Pick the **active** structure, type **Monthly Gross 100000**, and copy the
   CTC the live preview suggests (gross + employer cost, × 12).
4. Fill bank: name, holder, `123456789012` (12 digits), IFSC `HDFC0001234`.
5. Fill PAN `ABCDE1234F`, UAN `100123456789`, tick PF Member.
6. Save → the row appears as **Draft**.

## 2. Live breakup (§9)

With gross 100000 on the Standard structure: Basic 50000, HRA 20000,
Special 30000 (Remaining), PF 1800, Gratuity 2400, net 98200,
annual CTC 12,28,800. Enter a different CTC → **400** explaining the mismatch.

## 3. Salary revision (§15 / §16)

1. Open the profile → **Edit** → change gross to 120000 and the date to a later
   month → Save → toast says *"Salary revision saved"*.
2. **Salary History** shows v1 (frozen, with an Effective To) and v2 (current).
3. v1's annual CTC is unchanged — history is never rewritten.

## 4. Status (§14)

Draft → **Activate Payroll** → Active. Then **Put On Hold**, **Reactivate**,
**Suspend**. Backend rejects anything outside the table with 400.

## 5. Statutory follows 29.1 (§11)

1. Remove the UAN, put the profile in Draft, then try **Activate Payroll** →
   blocked: *"UAN is required because PF applies to this company"*.
2. Turn PF off in **Payroll Setup**, repeat → activation succeeds.
3. Turn ESI on → the ESI number becomes required the same way.

## 6. Bank security (§10 / §24)

- The list and detail always show `XXXX XXXX 9012` — never the full number.
- `db.employeepayrollprofiles.findOne({}, { bank: 1 })` → the stored
  `accountNumber` is an encrypted `v1.…` string (it is `select: false`, so you
  must ask for it explicitly).
- `db.securityaudits.find({ action: /EMPLOYEE_PAYROLL|EMPLOYEE_SALARY/ })` →
  identity numbers are `[REDACTED]`.

## 7. Permissions (§4 / §24)

| Account | Expectation |
|---|---|
| Company Admin | Everything |
| HR Manager | Create, edit, revise, change status |
| Payroll Admin (template) | Same as HR Manager here |
| Employee | `/app/payroll/employees` shows **only their own** row; no Edit/Activate buttons |
| Manager / Team Lead | No Employee Payroll entry at all |

API check as an employee:
`GET /api/payroll/employees/<someone-else-id>` → **403 PAYROLL_ACCESS_DENIED**.

## 8. Tenant isolation (do this)

1. Create a profile in company A.
2. With company B's token, `GET /api/payroll/employees` → empty.
3. `GET /api/payroll/employees/<A-employee-id>` → **404** (not in your company).
4. Structure assignment from company B → 400 (structures are tenant-scoped).

## 9. Redis

```powershell
docker exec -it <redis> redis-cli --scan --pattern "*payroll-employee*"
```

Populated on first list; deleted on every save/status change. Stop Redis → the
page still works (fail-open).

## 10. Recruitment integration (§19 / §26)

1. Recruitment → a candidate with an accepted offer → **Convert to Employee**.
2. After conversion the success panel shows **Open payroll profile**.
3. The profile already carries the offered CTC, monthly gross = CTC ÷ 12,
   designation and joining date, and is **Draft**.
4. Converting again does not create a second profile (idempotent).
5. Complete structure + bank + statutory + tax → **Activate Payroll** → the
   employee is ready for monthly payroll.

---

# PART 4 — Known-by-design behaviour (not bugs)

| Behaviour | Why |
|---|---|
| CTC is rejected when it does not match gross + employer cost | §23 — the structure defines the relationship |
| Editing CTC creates a new version | §15 — salary history is never overwritten |
| UAN/ESI required only when 29.1 enables them | §11 — company configuration is the single source |
| Employees see only their own profile | §4 / §24 |
| Manager / Team Lead see nothing | §4 — grantable later, never by default |
| Tax is stored, never calculated | §12 / §25 |
| The account number is never returned by the API | §24 — masked mirror only |
| `SUSPENDED` only returns to `DRAFT` | §14 — re-activation must be deliberate |

---

# PART 5 — Still to come (29.5+)

Variable pay & monthly inputs, monthly payroll run, payroll engine, payslips,
bank transfer files, PF/ESI/TDS/PT calculations, attendance-based salary,
bonus processing, final settlement, payroll reports.
