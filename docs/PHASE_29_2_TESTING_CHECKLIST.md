# Phase 29.2 — What was built and how to test it

---

# PART 1 — What has been implemented

## 29.2: Salary Components (new)

| Area | File | What it does |
|---|---|---|
| **Domain rules (pure)** | `Backend/src/services/payroll/salaryComponentRules.js` | Categories, calculation types, normalization, validation, dependency graph + cycle detection, preview text, statutory-aware defaults, filters |
| **Model** | `Backend/src/models/SalaryComponent.js` | Tenant-scoped schema, unique `{companyId, code}`, company-first indexes, versioning fields |
| **Service** | `Backend/src/services/payroll/salaryComponentService.js` | Create, update (with versioning), list/filter/search/paginate, activate/deactivate, duplicate, usage, defaults, Redis cache + invalidation, audit |
| **Controller** | `Backend/src/controllers/salaryComponentController.js` | Thin HTTP layer (8 handlers) |
| **Validator** | `Backend/src/validators/salaryComponentValidator.js` | Structural checks only |
| **Routes** | `Backend/src/routes/salaryComponentRoutes.js` | Mounted at `/api/payroll/components` |
| **Permissions** | `utils/permissionRegistry.js`, `utils/roleTemplates.js` | `SALARY_COMPONENT_READ` / `_MANAGE` / `_ACTIVATE`; version **15 → 16** |
| **Frontend service** | `Frontend/src/services/salaryComponentService.js` | API client |
| **Frontend page** | `Frontend/src/pages/payroll/SalaryComponentsPage.jsx` | Table, filters, search, pagination, dynamic form, live preview, detail drawer, deactivate confirmation, empty state, permission state |
| **Nav + route** | `layout/AppLayout.jsx`, `routes/AppRoutes.jsx` | Permission-driven (see the 29.1 fix below) |
| **Tests** | `Backend/test/salaryComponents.test.js` | 24 hermetic tests |

### Feature checklist against the brief

- Earnings, Deductions **and** Employer Contributions (§5)
- Employee deduction ≠ employer contribution (§19)
- Company-unique codes; two tenants may both own `BONUS` (§8)
- Calculation: Fixed Amount / Percentage (of Basic, Gross, CTC or another component) / Formula (§10, §13)
- **Circular dependency detection** — including 3-hop cycles (§14)
- Taxability, PF, ESI, TDS, Professional Tax flags — configuration only, no engine (§15–§18)
- Activate / Deactivate; **never deleted** (§20, §21, §33, §34)
- Effective dates + **versioning** that protects history (§23, §24, §58)
- Duplicate (§32), usage view (§49), audit (§42)
- Redis via the existing Phase 28 service, fail-open (§39, §40)
- No `eval`, no formula expression parser (§45)

## 29.1 fix shipped with this phase

`/app/payroll/setup` and `/app/payroll/components` were gated by
`RequireRole roles={['COMPANY_ADMIN','HR_MANAGER']}`. That would have locked out
every delegated Payroll/Finance role created through the 29.1 model. Both the
route and the sidebar entry are now **permission-driven**.

---

# PART 2 — What the automated tests already prove

Run these — they need **no MongoDB, no Redis, no network**:

```powershell
cd Backend
npm run test:salary-components   # 24 tests
npm run test:payroll             # setup + rbac + components
npm run test:all                 # everything hermetic (188 tests)
```

Already covered:

| Group | Tests |
|---|---|
| Normalization | trims, upper-cases code, **drops `companyId` from the payload** |
| Validation | missing name, bad code, percentage bounds, self-dependency, duplicate code (same tenant rejected / other tenant allowed) |
| Dependencies | 2-hop cycle, 3-hop cycle, safe chains accepted |
| Preview text | "40% of Basic Salary", "Fixed ₹2,000" |
| Formula safety | non-whitelisted operators dropped, no executable content survives |
| Statutory defaults | PF off → no PF component; ESI on → ESI + employer ESI |
| Filters | type, status, search, pagination |
| **Tenant isolation** | company B list is empty; cross-tenant read by id returns null |
| **Redis down** | reads and writes still succeed |
| Versioning | used component → new version; old row closed, old percentage untouched |
| Lifecycle | deactivate is not a delete; reactivate works |
| Duplicate | fresh version 1, no lineage, duplicate code rejected |
| Permissions | Employee/Manager/Team Lead hold none; activation is separate |

---

# PART 3 — What you must test manually

Automated tests prove the logic. They cannot prove the app works end to end.
These need a real MongoDB (Redis is optional — the code is designed to work
without it).

## 0. One-time setup

```powershell
# Terminal 1 — API
cd Backend
npm install
npm run seed          # creates the Super Admin (admin@crewly.com / Admin@123)
npm run dev

# Terminal 2 — UI
cd Frontend
npm install
npm run dev
```

Then, in the Super Admin portal, create a company (this creates its Company
Admin and the five system roles). **Make sure the company's subscription plan
has the `payroll` feature enabled** — otherwise every component call returns
`403 FEATURE_NOT_AVAILABLE`.

> **Note:** `SYSTEM_PERMISSION_VERSION` is now 16. Existing companies migrate
> their system roles automatically the first time roles are read, so Company
> Admin picks up `SALARY_COMPONENT_*` on its own.

## 1. Get a token (PowerShell)

```powershell
$body = @{ companyCode = "acme"; email = "admin@acme.com"; password = "Secret@123" } | ConvertTo-Json
$login = Invoke-RestMethod -Uri "http://localhost:5000/api/auth/login" -Method Post -Body $body -ContentType "application/json"
$token = $login.data.token
$headers = @{ Authorization = "Bearer $token" }
```

## 2. Test scenarios

| # | What to do | Expected |
|---|---|---|
| 1 | `GET /api/payroll/components` | `200`, empty list, `meta.total = 0` |
| 2 | `GET /api/payroll/components/defaults` | Suggestions follow **your** Payroll Setup: PF off → no PF component |
| 3 | `POST /api/payroll/components` `{name:"Basic Salary", code:"BASIC", category:"EARNING", calculationType:"FIXED_AMOUNT", defaultAmount:30000}` | `201`, "created successfully" |
| 4 | Repeat step 3 with the same code | `400` — *"This component code is already in use. Please choose another code."* |
| 5 | Create HRA: `PERCENTAGE`, `percentage:40`, `calculationBase:"COMPONENT"`, `dependsOnCode:"BASIC"` | `201`; list shows **"40% of Basic Salary"** |
| 6 | Create HRA again with `dependsOnCode:"HRA"` | `400` — *"This component cannot depend on itself"* |
| 7 | **PATCH** Basic to depend on HRA (HRA already depends on Basic) | `400` — *"This configuration creates a circular salary dependency."* |
| 8 | `POST /api/payroll/components/defaults` | Creates the missing statutory defaults only; PF/ESI respect Payroll Setup |
| 9 | `POST /api/payroll/components/{id}/status` `{status:"INACTIVE"}` | `200`; row still exists (deactivated, **not** deleted) |
| 10 | `POST /api/payroll/components/{id}/duplicate` | New component, `version: 1`, no history |
| 11 | `GET /api/payroll/components?search=hra&status=ACTIVE&page=1` | Filtered + paginated |
| 12 | `GET /api/payroll/components/{id}` | Detail with `usage` and `calculationLabel` |

## 3. Permission tests (the point of the whole phase)

| Do this | Expected |
|---|---|
| Roles & Permissions → **＋ Template** → *Payroll Executive* → assign to a user → log in as them | Sidebar shows **Salary Components** (they hold `SALARY_COMPONENT_READ`) |
| As Payroll Executive: `POST /api/payroll/components` | `403` — they have READ only, not MANAGE |
| As Payroll Executive: status change | `403` — they lack `SALARY_COMPONENT_ACTIVATE` |
| Roles & Permissions → **＋ Template** → *Payroll Admin* → assign → log in | Can create, edit **and** activate |
| Log in as an **Employee** | No payroll components link; `GET /api/payroll/components` → `403` |
| Log in as **Manager** / **Team Lead** | `403` |

## 4. Tenant isolation (do this — it is the highest-risk area)

1. Create **two companies** from the Super Admin portal.
2. In company A, create components `BASIC` and `HRA`.
3. In company B, create `BASIC` too — **this must succeed** (codes are unique per company, not globally).
4. Log in to company B and list components — **only company B's rows appear**.
5. Copy a component `_id` from company A and call company B's
   `GET /api/payroll/components/{thatId}` → **404**, never 200.

## 5. Redis behaviour

- With Redis running: create a component, then list — the new row appears (cache invalidated).
- **Stop Redis** and repeat: create and list still work. The app must not fail
  just because the cache is down.

## 6. Audit

Inspect the `auditlogs` collection for the company and confirm rows exist for:
`SALARY_COMPONENT_CREATED`, `_UPDATED`, `_ACTIVATED`, `_DEACTIVATED`,
`_DUPLICATED` — each with previous state, new state, actor and company.

## 7. UI checks in the browser

- Table shows all required columns (name, code, type, calculation, taxability, PF, ESI, status, effective, usage, actions).
- Filters + search work; pagination appears past 25 rows.
- Create form **adapts**: Fixed → amount field; Percentage → percentage + base; Percentage of Component → dependency picker.
- **Live preview** updates as you type.
- Deactivate shows the confirmation explaining history is preserved.
- Empty state appears before the first component.
- Log in as an Employee → the page shows *"You don't have permission to manage salary components…"*.

---

# PART 4 — Known-by-design behaviour (not bugs)

| Symptom | Why |
|---|---|
| Usage always shows **0 structures** | Phase 29.3 (Salary Structure Builder) does not exist yet. The UI states this instead of inventing numbers (§49). |
| `403 FEATURE_NOT_AVAILABLE` on every call | The company's subscription plan does not include the `payroll` feature. |
| Only Company Admin / HR Manager see the links at first | Correct — other roles get them only when someone grants the permission (that is the 29.1 model). |
| Editing a component with history creates a new version | Intended (§58). The response says so. |
| No formula calculator | Formulas are stored as a controlled operation list only (§45, §11). |

---

# PART 5 — Still to come (29.3+)

Salary Structure Builder, employee salary assignment, payroll calculation,
monthly runs, payslips, bank files, PF/ESI/TDS engines, payroll reports.
`salaryComponentService.getUsage()` is the single hook 29.3 fills in — once it
reports structures, history protection activates with no further change.
