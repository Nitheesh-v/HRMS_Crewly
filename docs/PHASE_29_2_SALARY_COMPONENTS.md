# Phase 29.2 — Salary Components

Salary components are the **building blocks** of compensation. This phase defines
what a component is and how it will eventually behave. It does **not** compute a
salary, and it does **not** assign anything to an employee.

```
Salary Component (29.2) → Salary Structure (29.3) → Employee Payroll Profile (29.4)
        → Monthly Inputs (29.5) → Payroll Engine (29.6)
```

---

## What already existed (reused)

| Need | Existing thing | Used for |
|---|---|---|
| Tenant context | `middlewares/tenantMiddleware` → `req.companyId` | every query is company-scoped |
| Permissions | `middlewares/permissionMiddleware` + `utils/permissionRegistry` | `SALARY_COMPONENT_READ/MANAGE/ACTIVATE` |
| Plan gating | `requireFeature('payroll')`, `checkWriteAccess` | subscription enforcement |
| Model conventions | `models/PayrollSetup.js` (29.1) | versioning + tenant index shape |
| Cache | `services/redisCacheService` (`buildTenantCacheKey`, `getOrSetCache`, `deleteCache`) | Phase 28 Redis, no new connection |
| Audit | `utils/securityauditService.recordAudit` | component audit trail |
| Statutory truth | `PayrollSetup.statutory` (29.1) | PF/ESI/PT/TDS applicability |
| UI | `card` / `input` / `label` / `btn-primary` / `btn-ghost`, `components/Modal.jsx` | page design system |

No new Redis connection, no new queue, no new auth system, no new tenant
mechanism.

---

## What was added

| File | Purpose |
|---|---|
| `services/payroll/salaryComponentRules.js` | **Pure** domain rules: categories, calculation types, normalization, validation, dependency graph + cycle detection, display text, statutory-aware defaults, filtering |
| `models/SalaryComponent.js` | Tenant-scoped schema, unique `{companyId, code}`, tenant-first indexes, versioning fields |
| `services/payroll/salaryComponentService.js` | Tenant-safe persistence, cache + invalidation, audit, lifecycle, duplicate, versioning |
| `controllers/salaryComponentController.js` | Thin HTTP layer |
| `validators/salaryComponentValidator.js` | Structural validation only |
| `routes/salaryComponentRoutes.js` | `/api/payroll/components`, permission-gated |
| `test/salaryComponents.test.js` | 24 hermetic tests |
| `Frontend/src/services/salaryComponentService.js` | API client |
| `Frontend/src/pages/payroll/SalaryComponentsPage.jsx` | List, filters, search, dynamic form, preview, detail, lifecycle |

---

## Domain model

| Field | Notes |
|---|---|
| `name` | required, 2–80 chars, unique among **ACTIVE** rows of the company |
| `code` | required, `^[A-Z0-9_]+$`, **unique per company** (two tenants may both own `BONUS`) |
| `category` | `EARNING` · `DEDUCTION` · `EMPLOYER_CONTRIBUTION` |
| `calculationType` | `FIXED_AMOUNT` · `PERCENTAGE` · `FORMULA` |
| `defaultAmount` / `percentage` | reference values only — never forced on an employee |
| `calculationBase` | `BASIC` · `GROSS` · `CTC` · `COMPONENT` |
| `dependsOnCode` | the component a percentage is calculated from |
| `formula` | controlled operation list (whitelisted operators) |
| `taxability` | `TAXABLE` · `NON_TAXABLE` · `PARTIALLY_TAXABLE` · `DEFERRED` |
| `pfApplicable` / `esiApplicable` / `tdsApplicable` / `professionalTaxApplicable` | configuration flags only, no engine |
| `status` | `ACTIVE` · `INACTIVE` |
| `effectiveFrom` / `effectiveTo` / `version` / `isCurrent` / `previousVersionId` | versioning (§23/§24) |

### Employee deduction vs employer contribution (§19)

`EMPLOYER_CONTRIBUTION` is its own category. Employer PF never reduces an
employee's net salary, and it is never modelled as a deduction.

### Indexes (§56)

```
{ companyId: 1, code: 1 }              UNIQUE  — tenant-level code uniqueness
{ companyId: 1, status: 1 }                    — status filter
{ companyId: 1, category: 1 }                  — type filter
{ companyId: 1, name: 1 }                      — search + duplicate detection
{ companyId: 1, isCurrent: 1, version: -1 }    — current version lookup
```

Every index is company-first, so no query can fan out across tenants.

---

## Permissions

| Permission | Who gets it by default |
|---|---|
| `SALARY_COMPONENT_READ` | Company Admin, HR Manager, HR Head, HR Executive, Payroll Admin, Payroll Executive, Finance Manager, Finance Executive |
| `SALARY_COMPONENT_MANAGE` | Company Admin, HR Manager, HR Head, Payroll Admin |
| `SALARY_COMPONENT_ACTIVATE` | Company Admin, Payroll Admin only |

`SYSTEM_PERMISSION_VERSION` is now **16**. Employee, Manager and Team Lead hold
**none** of the three. Activation is a separate permission so a company can let
payroll staff define components without letting them switch components on and
off.

Every route is `protect → tenantContext → checkSubscriptionStatus →
requirePermission → requireFeature('payroll')`.

---

## API

```
GET    /api/payroll/components                 list (search, filters, pagination)
GET    /api/payroll/components/defaults        suggestions from 29.1 statutory config
POST   /api/payroll/components/defaults        create the missing defaults
GET    /api/payroll/components/:id             detail + usage
POST   /api/payroll/components                 create
PATCH  /api/payroll/components/:id             update (versions itself if history exists)
POST   /api/payroll/components/:id/status      activate / deactivate
POST   /api/payroll/components/:id/duplicate   duplicate
```

No route accepts a `companyId`; tenant always comes from `req.companyId`.

---

## Historical safety (§21 / §24 / §58)

- **Deactivate, never delete.** A used component stays in the database so old
  payslips and structures keep resolving.
- **Versioning on calculation changes.** If a component already has history
  (`version > 1`, or is referenced by a structure/payroll run), updating a
  calculation-affecting field closes the current row (`isCurrent: false`,
  `effectiveTo`) and writes a **new version**. The old percentage is untouched.
- Non-calculation changes (description, status) update in place.

Usage currently reports zero structures because 29.3 does not exist yet — the
UI says so explicitly instead of inventing numbers (§49).

---

## Redis (§39 / §40)

- Key: `buildTenantCacheKey({ companyId, namespace: 'payroll-components', version: 1 })`
- TTL: 300s default, `SALARY_COMPONENT_CACHE_TTL_SECONDS` override.
- Invalidated on create, update, status change and duplicate.
- **Fail-open:** if Redis is down, reads and writes still go to MongoDB. A test
  proves it.

## BullMQ (§41)

Component CRUD stays synchronous. No new queue.

## Audit (§42)

`SALARY_COMPONENT_CREATED`, `_UPDATED`, `_NEW_VERSION`, `_ACTIVATED`,
`_DEACTIVATED`, `_DUPLICATED` — each with the previous and new configuration,
actor and tenant. Audit failures never block a write.

---

## Formula safety (§45)

Formulas are stored as a controlled operation list:

```js
formula: { base: 'GROSS', operations: [{ operator: 'ADD', componentCode: 'BASIC' }] }
```

Operators are whitelisted (`ADD`, `SUBTRACT`, `MULTIPLY_BY`, `PERCENT_OF`) and
anything else is dropped during normalization. There is no `eval()`, no string
expression parser and no user-submitted JavaScript anywhere in the payroll stack.

---

## Integration with Phase 29.1 (§35 / §36)

`suggestDefaultComponents(statutory)` reads the 29.1 statutory configuration:

- PF off → **no** PF deduction and no employer PF contribution is suggested.
- ESI off → no ESI components.
- Professional Tax / TDS follow the same rule.

Defaults are **never created automatically** — an admin clicks *Add defaults*,
which creates only the components the company does not already have.

---

## Frontend

- **Payroll → Salary Components**: enterprise table (name, code, type,
  calculation, taxability, PF, ESI, status, effective, usage, actions).
- Filters: type, status, calculation, taxability + search over name, code and
  description; server-side pagination.
- Create/Edit modal with **dynamic fields** (§29): fixed amount → amount,
  percentage → percentage + base, percentage of component → dependency picker.
- **Live preview** (§30): "40% of Basic Salary".
- Detail drawer with overview, calculation, statutory flags and usage (§48).
- Deactivation confirmation explaining that history is preserved (§33).
- Empty state (§52) and the suggested-defaults hint.
- Unauthorized users see: *"You don't have permission to manage salary
  components. Contact your Company Admin or Payroll Administrator."*

### Navigation fix (29.1 consistency)

`/app/payroll/setup` and `/app/payroll/components` were gated by
`RequireRole roles={['COMPANY_ADMIN', 'HR_MANAGER']}`, which would have locked
out every delegated Payroll/Finance role created through the 29.1 model. Both the
route and the sidebar entry are now **permission-driven**, matching §7/§43. The
pages still show their permission message and the backend still enforces it.

---

## Tests

```
npm run test:salary-components   # 24 tests
npm run test:payroll             # setup + rbac + components
npm run test:all                 # + redis, bullmq, ops
```

Hermetic — no MongoDB, no Redis, no network. The service is instantiated with an
in-memory model, a fake cache and a fake audit writer.

Covered: normalization, validation, percentage bounds, self-dependency,
duplicate codes (same tenant rejected, other tenant allowed), circular
dependency detection (2-hop and 3-hop), calculation preview, formula sanitizing,
statutory-aware defaults, filters/search/pagination, tenant isolation
(list + cross-tenant read by id), Redis-down fail-open, update in place vs new
version, deactivate/reactivate, duplicate, permissions and role templates.

---

## Explicitly NOT implemented (§59)

Salary Structure Builder · Employee Salary Assignment · Payroll calculation ·
Monthly payroll run · Payslip generation · Bank transfer files · PF / ESI / TDS
calculation · Professional tax slabs · Bonus engine · Final settlement ·
Payroll reports.

---

## Phase 29.3 handoff (Salary Structure Builder)

29.3 can reference components by `code` (stable within the tenant) and by `_id`.
The hooks it needs already exist:

- `getUsage()` — fill `structures` from the new `SalaryStructure` model; the
  versioning branch in `updateComponent` then starts protecting components that
  are referenced by a structure, with no further change.
- `listComponents()` — returns every current component for the tenant; use it to
  build the structure editor's component picker.
- `describeCalculation(component, codeToName)` — reuse for previews.
