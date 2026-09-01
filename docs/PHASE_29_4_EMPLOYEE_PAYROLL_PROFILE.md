# Phase 29.4 — Employee Payroll Profile

> Payroll programme: 29.1 Company Payroll Setup → 29.2 Salary Components →
> 29.3 Salary Structures → **29.4 Employee Payroll Profile** → 29.5 Variable
> Pay & Monthly Inputs.

The bridge between **HR** and **Payroll**. It stores *what an employee is paid
and how they are paid*. It is **not** a monthly payroll run and **not** a
payslip (§25).

```
Salary Structure (29.3) → Employee Payroll Profile (29.4) → Variable Pay (29.5)
```

---

## 1. What was reused (no new infrastructure)

| Concern | Reused from |
|---|---|
| Auth / tenant | `protect` + `tenantContext` (`req.companyId`) |
| Authorization | `requirePermission` / `requireAnyPermission` + the 29.1 permission catalogue |
| Who may see whose salary | `payrollAccessService.canReadEmployeePayroll` (29.1) wrapped in `middlewares/payrollProfileAccess.js` |
| Statutory applicability | `PayrollSetup.statutory` (29.1) — read, never duplicated |
| Live breakup | `computeStructurePreview` (29.3) — pure, never the engine |
| Bank encryption | `utils/fieldEncryption` (29.1) — AES-256-GCM + `select: false` + masked mirror |
| Redis | Phase 28.7 `redisCacheService`, namespace `payroll-employee` |
| Audit | `recordAudit`, synchronous (29.1 / 29.2 / 29.3 discipline) |
| Notifications | `notifySmart` seam (the 29.1 activation pattern) — no new queue |

---

## 2. What was added

### Backend

| File | Purpose |
|---|---|
| `src/services/payroll/employeePayrollRules.js` | **Pure** rules: statuses + transitions, formats (IFSC/PAN/UAN/ESI/Aadhaar), masking, normalization, validation, §9 preview, revision detection |
| `src/models/EmployeePayrollProfile.js` | Tenant-scoped, versioned, encrypted bank sub-document |
| `src/services/payroll/employeePayrollService.js` | Injected models/cache/audit/notify; create, revise, status, preview, list, `createFromOffer` |
| `src/middlewares/payrollProfileAccess.js` | Per-employee access: tenant → self → permission → payroll scope |
| `src/controllers/employeePayrollController.js` | Thin controller (3-line convention) |
| `src/validators/employeePayrollValidator.js` | Shape/enum validation only |
| `src/routes/employeePayrollRoutes.js` | `/api/payroll/employees` |
| `test/employeePayroll.test.js` | 24 hermetic tests |

### Frontend

| File | Purpose |
|---|---|
| `src/services/employeePayrollService.js` | API wrapper |
| `src/pages/payroll/EmployeePayrollPage.jsx` | §17 list with filters + "employees without a profile" |
| `src/pages/payroll/EmployeePayrollDetailPage.jsx` | §18 tabs (Overview / Bank / Statutory / Tax / Salary History) + editor with §9 live preview |
| `ConvertToEmployeePage.jsx` | §19 — a link straight to the draft profile after conversion |

---

## 3. Domain model

```
EmployeePayrollProfile
├── companyId + employeeId      (tenant; partial unique on isCurrent)
├── structureId, structureName  ← an ACTIVE 29.3 structure
├── annualCtc, monthlyGross, designation
├── employmentType, payGroup   (§13 — MONTHLY / WEEKLY / EXECUTIVE)
├── payrollStatus              DRAFT → ACTIVE → ON_HOLD ⇄ ACTIVE → SUSPENDED
├── bank                       bankName, accountHolderName, accountNumber (ENCRYPTED, select:false),
│                              accountNumberLast4, accountNumberMasked, ifsc, branch,
│                              accountType, paymentMethod
├── statutory                  pan, aadhaar, uan, esiNumber, pfMember, gratuityEligible
├── tax                        regime, tdsApplicable, panVerified, declarationStatus,
│                              residentialStatus
├── breakdown                  snapshot of the §9 preview (display only)
└── version / isCurrent / previousVersionId / effectiveFrom / effectiveTo
```

**Indexes:** `{companyId, employeeId}` unique where `isCurrent: true` ·
`{companyId, payrollStatus}` · `{companyId, structureId}` ·
`{companyId, employeeId, version: -1}`.

---

## 4. Permissions (spec correction)

The brief gated §4 on role names. Crewly gates on **permissions** plus the
29.1 payroll scope, so a company can hand these duties to any role it creates.

| Permission | Grants |
|---|---|
| `EMPLOYEE_SALARY_MANAGE` | Create, edit, revise salary, change status |
| `EMPLOYEE_SALARY_READ` | View anyone inside the actor's payroll scope |
| `EMPLOYEE_SALARY_READ_SELF` | View **only your own** profile |

| Role / template | READ | MANAGE | READ_SELF |
|---|:--:|:--:|:--:|
| COMPANY_ADMIN | yes | yes | — (READ covers it) |
| HR_MANAGER | yes | yes | — |
| PAYROLL_ADMIN (template) | yes | **yes** (added in 29.4) | — |
| EMPLOYEE | — | — | **yes** |
| MANAGER / TEAM_LEAD | **none** | **none** | **none** |

`EMPLOYEE_SALARY_READ_SELF` is deliberately **not** part of
`SELF_SERVICE_PERMISSIONS` (that list is granted to Manager/Team Lead too, and
§4 gives them no salary access). `SYSTEM_PERMISSION_VERSION` is now **18**.

On top of permissions, `payrollProfileAccess` enforces, per employee:
tenant → self-service → role+permission → **payroll scope** (COMPANY / TEAM / SELF).

---

## 5. API

| Method | Path | Access |
|---|---|---|
| `GET` | `/api/payroll/employees` | READ or READ_SELF |
| `POST` | `/api/payroll/employees/preview` | READ or READ_SELF |
| `GET` | `/api/payroll/employees/:employeeId` | + `payrollProfileAccess` |
| `PUT` | `/api/payroll/employees/:employeeId` | MANAGE + `payrollProfileAccess` |
| `POST` | `/api/payroll/employees/:employeeId/status` | MANAGE + `payrollProfileAccess` |

`GET /` returns `data` (profiles) and `meta` with `structures`, `employees` and
`withoutProfile` so the UI can start a profile without a second round trip.
The full account number is **never** returned — only `accountNumberMasked`.

---

## 6. Rules that matter

- **§23 CTC ↔ gross:** `CTC = 12 × (gross + employer contributions)` from the
  assigned structure, with a rounding tolerance of `max(12, 0.5% of CTC)`.
- **§23 structure:** only an **ACTIVE** structure of this company.
- **§23 one active profile per employee:** partial unique index.
- **§23 no overlapping revisions:** a revision cannot start before the salary
  it replaces, nor on the same date as another revision.
- **§11 statutory:** when the company enabled PF/ESI in 29.1, UAN / ESI number
  are required to go **ACTIVE** (never to save a draft). When 29.1 has them
  off, they stay optional.
- **§14 status:** `DRAFT→ACTIVE`, `ACTIVE⇄ON_HOLD`, `*→SUSPENDED`,
  `SUSPENDED→DRAFT`. Anything else is a `400`.
- **§15/§16 revisions:** a change to CTC, gross, structure or effective date
  writes a **new version** and freezes the previous row (`isCurrent: false`,
  `effectiveTo` set). Cosmetic edits stay in place.
- **§24:** bank account encrypted at rest, masked in every response, never
  logged; PAN/UAN/ESI/Aadhaar are written as `[REDACTED]` in audit records.

---

## 7. Redis / BullMQ

- Cache: `crewly:cache:company:<id>:payroll-employee:v1`, TTL
  `EMPLOYEE_PAYROLL_CACHE_TTL_SECONDS` (default 300s, clamped 10–3600),
  invalidated on every write. Fail-open: MongoDB stays the source of truth.
- No new queue. Audit is synchronous; the salary-revision and activation
  notifications use `notifySmart`.

---

## 8. Recruitment integration (§19)

`candidateConversionService` calls `createFromOffer` right after the employee
row is created: it seeds a **DRAFT** profile from
`offer.compensationSnapshot.annualCTC` (monthly gross = CTC ÷ 12), with the
pay group defaulted from the company's 29.1 payroll cycle. It is idempotent
(never duplicates a profile) and **strictly best-effort** — onboarding never
fails because of payroll. `ConvertToEmployeePage` then links straight to
"Open payroll profile".

---

## 9. Tests

```
npm run test:employee-payroll   # 24 tests
npm run test:payroll            # 29.1 + RBAC + 29.2 + 29.3 + 29.4
```

24/24 green; the full hermetic ladder is **252/252**.

Coverage: catalogues and transitions, formats and masking, normalization
(client tenant/lineage dropped), CTC↔gross alignment, active-structure rule,
statutory-follows-29.1 (on and off), revision date rules, per-field bank
errors, §9 preview arithmetic + annualisation, revision detection, create with
masked bank + audit, revision freezing history, status transitions and
activation re-validation, tenant isolation, `createFromOffer` idempotency,
permission distribution, and source conventions (ESM, tenant-scoped, no
role-name checks, `select: false` on the encrypted field).

---

## 10. Explicitly NOT implemented (§25)

Monthly payroll, payroll engine, payslips, bank transfer files, PF/ESI/TDS/PT
calculations, attendance-based salary, bonus processing, final settlement.
Tax is only **stored** (§12) — never calculated.

---

## 11. Phase 29.5 handoff (Variable Pay & Monthly Inputs)

1. `MonthlyPayrollInput` model: `companyId`, `employeeId`, `month`,
   `payrollProfileVersionId` (point at a **version**, never "current"),
   variable earnings/deductions, LOP days, overtime, one-off payments.
2. The engine reads the revision **effective for that month** — the version
   chain in 29.4 already makes that possible.
3. `payGroup` (§13) is the hook for running weekly/executive groups separately.
4. Keep all arithmetic in a **pure** rules module; the §9 preview is a
   visualisation and must never become the engine.
5. When the first payroll runs, flip `hasProcessedPayroll`-style guards so
   29.2 components and 29.3 structures become history-protected for real.
