# Phase 29.3 — Salary Structures

> Payroll programme: **29.1** Company Payroll Setup → **29.2** Salary Components →
> **29.3** Salary Structures → **29.4** Employee Salary (next) → … → 29.14 Reports.

A salary structure is a **reusable template**. It says *how a salary is divided
into the components of Phase 29.2*. It is **never** an employee salary and it
**never** calculates payroll.

```
Salary Component (29.2)  →  Salary Structure (29.3)  →  Employee Salary (29.4)
```

---

## 1. What was reused (no new infrastructure)

| Concern | Reused from |
|---|---|
| Auth / tenant | `protect` + `tenantContext` (`req.companyId`) |
| Authorization | `requirePermission` + the existing permission catalogue |
| Subscription / plan | `checkSubscriptionStatus`, `checkWriteAccess`, `requireFeature('payroll')` |
| Redis cache | Phase 28.7 `redisCacheService` (`getOrSetCache` / `deleteCache` / `buildTenantCacheKey`) |
| Audit | `recordAudit` (synchronous, same as 29.1 / 29.2) |
| Categories + `BASIC` anchor | `services/payroll/salaryComponentRules.js` |
| UI patterns | `SalaryComponentsPage.jsx`, `Modal.jsx`, `usePermission` |

No new queue, no new Redis client, no second authorization system, no
drag-and-drop dependency.

---

## 2. What was added

### Backend

| File | Purpose |
|---|---|
| `src/services/payroll/salaryStructureRules.js` | **Pure** domain rules: statuses, transitions, calculation methods, normalization, validation, §9 preview, filters, cloning. No mongoose, no Redis. |
| `src/models/SalaryStructureTemplate.js` | Tenant-scoped, versioned document (see "Model name" below). |
| `src/services/payroll/salaryStructureService.js` | Persistence + cache + audit; dependency-injected so tests stay hermetic. |
| `src/controllers/salaryStructureController.js` | Thin controller (3-line convention on every handler). |
| `src/validators/salaryStructureValidator.js` | Shape/enum validation only — business rules stay in the rules module. |
| `src/routes/salaryStructureRoutes.js` | `protect → tenantContext → checkSubscriptionStatus → requirePermission → requireFeature`. |
| `test/salaryStructures.test.js` | 34 hermetic tests (no Mongo, no Redis, no network). |

### Model name — why `SalaryStructureTemplate`

`models/SalaryStructure.js` **already existed**: it is the legacy
*per-employee* monthly salary row (`user`, `basic`, `hra`, `allowances`,
`pfPercent`, `professionalTax`) behind `PayrollPage` and
`payrollController` (`GET /api/payroll/structures`,
`PUT /api/payroll/structure/:userId`, payroll generation). Phase 29.3 must not
break existing functionality, so it owns a **separate model and collection**
(`SalaryStructureTemplate`, collection `salarystructuretemplates`) and a
**separate API path** (`/api/payroll/salary-structures`). The legacy file is
byte-for-byte unchanged and a hermetic test enforces it.
The product-facing name stays "Salary Structure".

### Frontend

| File | Purpose |
|---|---|
| `src/services/salaryStructureService.js` | API wrapper. |
| `src/pages/payroll/SalaryStructuresPage.jsx` | List + builder with live preview + detail (usage & versions) + clone + activate. |
| `src/routes/AppRoutes.jsx` | `/app/payroll/structures`. |
| `src/layout/AppLayout.jsx` | Sidebar entry, permission-driven (no role names). |

---

## 3. Domain model

```
SalaryStructure
├── companyId        (tenant, never from the client)
├── name, code       (code is UNIQUE per company)
├── description, departmentId, designation   (optional scoping)
├── items[]          ordered lines
│   ├── componentCode      → a 29.2 component ACTIVE in this company
│   ├── calculationMethod  → structure-level method
│   ├── value              → amount / percentage (null for REMAINING)
│   └── order              → display order for future payslips
├── status           DRAFT → ACTIVE → INACTIVE → ARCHIVED
├── effectiveFrom / effectiveTo
└── version / isCurrent / previousVersionId   ← history safety
```

### Calculation methods (structure level, §7)

| Method | Value | Meaning |
|---|---|---|
| `FIXED_AMOUNT` | amount | The same rupee figure for everyone on this structure. |
| `PERCENTAGE_OF_GROSS` | % | Share of gross salary. |
| `PERCENTAGE_OF_BASIC` | % | Share of the `BASIC` earning (resolved by code, never hard-coded). |
| `PERCENTAGE_OF_CTC` | % | Share of CTC (gross + employer contributions). |
| `REMAINING` | — | Fills whatever gross is left. **Earnings only, at most one per structure.** |

### Lifecycle (§5 / §14)

```
DRAFT ──► ACTIVE ──► INACTIVE ──► ACTIVE
  │          │            │
  └──────────┴────────────┴──► ARCHIVED   (terminal)
```

Illegal transitions are rejected with `400`. `ARCHIVED` is a one-way door.

### Versioning (§12)

Editing **never rewrites history**. When a structure already has history
(`version > 1`, or previous versions exist) and the **configuration** changes
(items, department, designation), the service:

1. closes the current row (`isCurrent: false`, sets `effectiveTo`);
2. writes a **new** version (`version + 1`, `previousVersionId` set);
3. audits the change as `SALARY_STRUCTURE_NEW_VERSION`.

Cosmetic edits (name, description) or edits to a structure with no history are
applied in place.

### Indexes (§21)

```
{ companyId, code }              UNIQUE   ← tenant-level code uniqueness
{ companyId, status }
{ companyId, departmentId }
{ companyId, isCurrent, version }
```

---

## 4. Permissions (spec correction)

The supplied brief gated the feature on **role names** (Company Admin / Payroll
Admin / HR Manager). Crewly 29.1/29.2 gate on **permissions**, so 29.3 does
the same — a company can hand these duties to any role it creates.

| Permission | Grants |
|---|---|
| `SALARY_STRUCTURE_READ` | View the list, a structure, and the live preview. |
| `SALARY_STRUCTURE_MANAGE` | Create, edit, clone. |
| `SALARY_STRUCTURE_ACTIVATE` | Activate / deactivate / archive (§14 — a separate duty). |

Distribution:

| Role / template | READ | MANAGE | ACTIVATE |
|---|:--:|:--:|:--:|
| COMPANY_ADMIN | yes | yes | yes |
| HR_MANAGER | yes | yes | **no** (mirrors 29.2: HR builds, admin switches on) |
| PAYROLL_ADMIN (template) | yes | yes | **yes** (spec §4: treated like Company Admin here) |
| PAYROLL_EXECUTIVE, HR_EXECUTIVE, FINANCE_* | as granted by the company | | |
| MANAGER, TEAM_LEAD, EMPLOYEE | none by default (grantable) | | |

`SYSTEM_PERMISSION_VERSION` is now **17**.

---

## 5. API

All routes: authenticated, tenant-scoped, subscription-checked.

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/payroll/salary-structures` | READ |
| `POST` | `/api/payroll/salary-structures/preview` | READ |
| `GET` | `/api/payroll/salary-structures/:structureId` | READ |
| `POST` | `/api/payroll/salary-structures` | MANAGE |
| `PATCH` | `/api/payroll/salary-structures/:structureId` | MANAGE |
| `POST` | `/api/payroll/salary-structures/:structureId/clone` | MANAGE |
| `POST` | `/api/payroll/salary-structures/:structureId/status` | ACTIVATE |

> `/api/payroll/structures` (no `salary-` prefix) stays reserved for the legacy
> per-employee endpoint that `PayrollPage` uses.

`GET /` returns `{ data: [...], meta: { …pagination, components: [...] } }` —
the company's **active** components ride along so the UI can name and
categorise every line without a second call (§7).

`POST /preview` returns the §9 breakdown only. **Nothing is stored.**

---

## 6. Redis (§18)

```
key        crewly:cache:company:<id>:payroll-structures:v1:list
ttl        SALARY_STRUCTURE_CACHE_TTL_SECONDS (default 300s, clamped 10–3600)
invalidate on every write
fail-open  a Redis outage only skips the cache; MongoDB stays the source
```

The key uses the project's `buildTenantCacheKey` convention — never the
hand-rolled `payroll:structures:{companyId}` string from the brief.

## 7. BullMQ (§19)

None. The brief asked for a queue **and** said not to create new queues; 29.1
and 29.2 audit synchronously through `recordAudit`, so 29.3 stays consistent.

## 8. Audit

One row per write: `SALARY_STRUCTURE_CREATED`, `_UPDATED`, `_NEW_VERSION`,
`_ACTIVE`, `_INACTIVE`, `_ARCHIVED`, `_CLONED`. Each row stores the previous
and new snapshot (items, status, version, effective dates — never bank data).

---

## 9. Feedback loop back into 29.2

`salaryComponentService.getUsage()` now reports the **real** number of current
structures that reference a component (`structureUsage` is injected, so 29.2's
tests stay hermetic). A component inside a structure is therefore
history-protected from destructive edits, exactly as §22 intended.

---

## 10. Frontend

- **List** — name (opens detail), code, component split, status, version,
  effective date, "Employees Using" (0, with the honest tooltip), actions.
- **Builder** (modal, two columns)
  - left: name / code / description / designation / effective date + the
    component list with add, remove and **up/down** ordering (§11);
  - right: **live preview** (§9) driven by a sample gross figure the user
    types — earnings, deductions, employer contributions, then
    gross → deductions → net pay → employer cost → CTC.
- **Detail** — usage, version history, component breakdown.
- **Clone** — copies configuration only; the copy is a fresh `DRAFT` v1.
- The whole page is permission-driven: buttons simply disappear when the
  permission is missing.

---

## 11. Tests

```
npm run test:salary-structures   # 32 tests
npm run test:payroll             # 29.1 + RBAC + 29.2 + 29.3
```

34/34 green; the full hermetic ladder (29.1 + RBAC + 29.2 + 29.3 + Redis +
BullMQ + ops) is **225/225**.

Coverage: catalogues, normalization (client tenant/lineage fields dropped),
validation (duplicates, unknown/inactive components, one `REMAINING`,
percentage bounds, at least one earning, per-tenant code uniqueness, gross
over-allocation), preview arithmetic, lifecycle transitions, cloning,
filtering, create/update/versioning, cache invalidation, audit rows, tenant
isolation, the 29.2→29.3 usage loop, permission distribution, and source
conventions (ESM only, tenant-scoped, no hard-coded role names, no persistence
in the preview path).

---

## 12. Explicitly NOT implemented (§22 scope fence)

Employee salary, employee CTC, payroll engine, payslips, bank transfer files,
PF/ESI/TDS/professional-tax engines, monthly payroll runs, final settlement,
payroll reports, and drag-and-drop ordering (up/down controls instead).
Statutory applicability is still read from 29.1 — 29.3 never makes PF or ESI
mandatory.

---

## 13. Phase 29.4 handoff (Employee Salary)

1. `EmployeeSalary` model: `companyId`, `employeeId`, `structureId`,
   `structureVersionId`, `effectiveFrom`, `ctcBreakdown`, `status`.
2. Point the assignment at a **specific version**, never at "the current one" —
   that is what makes history safe.
3. Fill `salaryStructureService.getUsage().employees` with a real count; the
   field and the UI already exist and currently report an honest `0`.
4. Permission to add: `SALARY_STRUCTURE_ASSIGN` (already declared in the
   catalogue since 29.1) plus `EMPLOYEE_SALARY_READ` / `_MANAGE`.
5. CTC → gross → component amounts: keep the arithmetic in a **pure** rules
   module, then hand it to the payroll engine in 29.6. The §9 preview is a
   visualisation and must never become the engine.
