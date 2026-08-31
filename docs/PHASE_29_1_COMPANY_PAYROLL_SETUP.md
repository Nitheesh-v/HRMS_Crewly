# Phase 29.1 — Company Payroll Setup

Foundation / configuration layer of the Payroll module.

> **Business scope (§44).** Three different things must never be mixed:
>
> | Concept | Question it answers | Phase |
> |---|---|---|
> | **Payroll Setup** | *How does this company run payroll?* | **29.1 (this phase)** |
> | Salary Structure | *How is an employee's salary divided?* | later |
> | Payroll Run | *What does the employee actually receive this period?* | later |
>
> Phase 29.1 implements **only** the first row.

---

## RBAC update — payroll is run by HR / Payroll / Finance, not by the Company Admin

> Added after the first release of 29.1. Payroll setup behaviour is unchanged;
> what changed is **who may hold payroll permissions and how their data reach
> is limited**.

### What already existed (reused, not replaced)

| Piece | Where |
|---|---|
| `RESOURCE_ACTION` permission registry | `utils/permissionRegistry.js` |
| Per-company roles (system + custom) | `models/CompanyRole.js` |
| Permission resolution + plan gating | `utils/permissionService.js` |
| Role/permission admin API + audit | `controllers/rolePermissionController.js` |
| Reporting line / team subtree | `User.reportingTo` + `utils/orgHelpers.js` |
| Tenant isolation | `req.companyId` + `tenantContext` |

### What was added

1. **Granular payroll permission catalogue** (39 permissions, 10 resources):
   Setup · Salary Components · Salary Structures · Employee Salary · Salary
   Revision · Payroll Run · Payment · Payslips · Statutory · Reports.
   New action verbs registered: `ACTIVATE, PREPARE, EXECUTE, RECALCULATE,
   REVIEW, LOCK, REOPEN, ASSIGN, GENERATE, CONFIRM, RELEASE, RERELEASE,
   MARK_PAID`. `SYSTEM_PERMISSION_VERSION` **14 → 15**; all new resources map
   to the `payroll` subscription feature.
   **Only `PAYROLL_SETUP_READ / _UPDATE / _ACTIVATE` are enforced today** —
   the rest are declared so companies can configure roles now; each later
   phase just adds `requirePermission(...)` to its routes.

2. **Role templates (opt-in, never seeded)** — `utils/roleTemplates.js`:
   `HR_HEAD`, `HR_EXECUTIVE`, `PAYROLL_ADMIN`, `PAYROLL_EXECUTIVE`,
   `FINANCE_MANAGER`, `FINANCE_EXECUTIVE`. Each is a permission preset with a
   default scope. Nothing is created for a company until an admin picks one in
   **Roles & Permissions → ＋ Template**, which produces an ordinary
   per-company role (`isSystemRole: false`) that stays fully editable.
   Separation of duties is enforced inside the presets: no preset both
   **executes** and **approves** a payroll run. `FINANCE_MANAGER` deliberately
   concentrates approval + payment and **declares that exception** with a
   reason, so the UI can warn instead of hiding it.

3. **Organizational scope** — `utils/payrollScope.js` (pure):
   `SELF · TEAM · DEPARTMENT · ASSIGNED_DEPARTMENTS · COMPANY`.
   Resolution order: per-permission override → role-level default → role-key
   default → `SELF` (least privilege). Team reach reuses the existing
   `orgHelpers.getSubtreeIds` reporting subtree. `canAccessSubject()` refuses
   cross-tenant access first, before scope is even considered.
   Scope overrides are stored on `CompanyRole.payrollScope` and
   `CompanyRole.permissionScopes`.

4. **Enforced today where an employee is the subject** —
   `services/payroll/payrollAccessService.js` applies
   **tenant → role → permission → scope** to payslip access. It is additive:
   the legacy Company Admin / HR Manager allow-list still works, so no
   existing user loses access.

5. **Audit** — `utils/payrollPermissionAudit.js` writes
   `Payroll permission granted` / `Payroll permission revoked` rows with the
   previous and new permission state, the role, the actor and the tenant —
   on top of the existing `ROLE_PERMISSIONS_UPDATED` row. Nothing is written
   when no payroll permission changed. Auditing never blocks role admin.

   `utils/payrollActionAudit.js` prepares the §11 hooks for the sensitive
   payroll actions that arrive with the later phases: salary changed, payroll
   prepared / calculated / recalculated / reviewed / approved / rejected /
   locked / reopened, bank file generated, payment confirmed, marked paid,
   payslips generated / released / re-released. Each hook maps to the
   permission that authorises it (a test asserts the permission exists), so
   29.2+ calls one function instead of inventing an audit shape. Bank account
   numbers are masked to the last 4 digits and PAN/UAN/ESI are recorded as
   `[REDACTED]` before anything is written.

### Default payroll posture

| Role | Payroll Setup | Run / prepare | Approve | Payment | Payslips | Scope |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Company Admin | ✅ all | ✅ | ✅ | ✅ | ✅ | COMPANY |
| HR Manager | read + edit | ✅ | ❌ | ❌ | ❌ | COMPANY |
| HR Head *(template)* | read | review | ✅ | ❌ | — | COMPANY |
| HR Executive *(template)* | — | prepare | ❌ | ❌ | — | ASSIGNED_DEPARTMENTS |
| Payroll Admin *(template)* | read + edit | ✅ run/lock | ❌ | generate file | ✅ release | COMPANY |
| Payroll Executive *(template)* | — | ✅ run | ❌ | ❌ | generate | COMPANY |
| Finance Manager *(template)* | — | review | ✅ | ✅ confirm + mark paid | — | COMPANY |
| Finance Executive *(template)* | — | read | ❌ | read/download | — | COMPANY |
| Manager / Team Lead | ❌ | ❌ | ❌ | ❌ | ❌ | TEAM (no payroll perms) |
| Employee | ❌ | ❌ | ❌ | ❌ | own only | SELF |

The Company Admin keeps every payroll permission **by default** — but payroll
operations no longer *depend* on that role: any of the above can be delegated.

### Notes / limits

- Creating a **custom role** requires the `advancedRbac` plan feature
  (Enterprise). Editing permissions of an existing role works on every plan,
  so a Company Admin can grant `PAYROLL_SETUP_ACTIVATE` to **HR Manager**
  without any plan upgrade.
- Manager / Team Lead scope is `TEAM`, but they hold no payroll permissions by
  default; grant one and the team scope applies automatically.
- Nothing in this update implements salary components, structures, payroll
  runs, payslip generation, bank files or statutory calculations.

---

## Purpose

Every Crewly company must configure its payroll environment before payroll can
be processed: the paying legal entity, country/state, payroll cycle, salary
payment date, statutory applicability, the company salary bank account and the
policies the future payroll engine will consume.

The configuration belongs to the tenant. Company A (cycle 1–31, PF+ESI+PT) and
Company B (cycle 26–25, PF+PT) never interfere.

**This phase does not calculate anything.** It decides **what applies** to a
company; later phases decide **how much**.

---

## What was implemented

### Backend

| File | Role |
|---|---|
| `src/models/PayrollSetup.js` | Tenant payroll configuration document (one current per company) |
| `src/services/payroll/payrollSetupRules.js` | **Pure** rules: enums, format validators, conditional statutory requirements, section evaluation, status machine, masking |
| `src/services/payroll/payrollSetupService.js` | Tenant-safe persistence, cache read-through, audit, activation, notifications |
| `src/controllers/payrollSetupController.js` | Thin HTTP layer (response contracts below) |
| `src/routes/payrollSetupRoutes.js` | `/api/payroll/setup/*` — auth → tenant → subscription → permission → feature |
| `src/validators/payrollSetupValidator.js` | Structural validation (shape/enums/sizes) |
| `test/payrollSetup.test.js` | 33 hermetic tests (no MongoDB, no Redis) |

### Modified (integration only — nothing redesigned)

| File | Change |
|---|---|
| `src/utils/permissionRegistry.js` | New `PAYROLL_SETUP` resource → `PAYROLL_SETUP_READ / _UPDATE / _ACTIVATE` |
| `src/utils/permissionService.js` | `SYSTEM_PERMISSION_VERSION` 13 → 14; `PAYROLL_SETUP` → `payroll` plan feature |
| `src/routes/index.js` | Mount `/api/payroll/setup` |
| `.env.example` | `PAYROLL_SETUP_CACHE_TTL_SECONDS` placeholder |
| `package.json` | `test:payroll-setup` script; suite added to `test:all` |

### Frontend

| File | Role |
|---|---|
| `src/pages/payroll/PayrollSetupPage.jsx` | Wizard (4 steps + review), autosave, settings dashboard, activation & suspension |
| `src/services/payrollSetupService.js` | API client |
| `src/routes/AppRoutes.jsx` | `/app/payroll/setup` (Company Admin + HR Manager) |
| `src/layout/AppLayout.jsx` | Sidebar entry "Payroll Setup" |

---

## Data model

One **current** document per company, enforced by a partial unique index:

```js
payrollSetupSchema.index({ companyId: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true } });
```

```
companyId                     // tenant — always from req.companyId
status                        // DRAFT | CONFIGURED | ACTIVE | SUSPENDED
                              // (NOT_CONFIGURED = no document yet)
legal                         // legalName, pan, tan, gst, cin, address*, state, country
statutory
  pf                          // applicable, establishmentNumber
  esi                         // applicable, registrationNumber
  professionalTax             // applicable, state
  labourWelfareFund           // applicable, state
  gratuity                    // applicable
  tds                         // applicable
payrollPolicy
  frequency                   // MONTHLY | WEEKLY | BIWEEKLY | SEMIMONTHLY (model-forward)
  cycleType / cycleStartDay / cycleEndDay
  paymentDateType             // SPECIFIC_DAY | LAST_WORKING_DAY | CUSTOM
  paymentDayOfMonth / paymentMonthOffset   // 0 = same month, 1 = following month
  currency / financialYearStartMonth
  weekendPolicy               // SAT_SUN | SUN_ONLY | CUSTOM (+ customWorkingDays)
  lopPolicy.basis             // PER_DAY | PER_HOUR | PAYABLE_WORKING_DAYS
  overtimePolicy              // enabled, basis, multiplier
  processingDeadlineDay / lockRequiresReopen
bankAccount
  bankName, accountHolderName, ifsc, branch, accountType
  accountNumber               // ENCRYPTED (AES-256-GCM) + select:false
  accountNumberLast4 / accountNumberMasked
  paymentReferencePrefix
setup                         // currentStep, completedSections, savedSections, lastSavedAt
activation                    // activatedAt/By, suspendedAt/By, suspendReason
configVersion                 // optimistic concurrency + versioning readiness
effectiveFrom / effectiveTo / isCurrent
createdBy / updatedBy
```

### Versioning readiness (§23)

Phase 29.1 keeps **one** current document and bumps `configVersion` on every
change. The document already carries `effectiveFrom`, `effectiveTo` and
`isCurrent`, and the unique index only constrains `isCurrent: true`. A future
phase can therefore start writing effective-dated rows (close the previous row
with `effectiveTo` + `isCurrent: false`, insert the new one) **without a
redesign** and without destroying historical settings.

### One current configuration per company (§36)

Enforced twice: by the partial unique index, and by `startPayrollSetup`
(duplicate-key race → re-read the winner instead of failing).

---

## Setup status flow (§4)

```
Company registered        → NOT_CONFIGURED   (no document)
Admin starts setup        → DRAFT
All four sections saved
and valid                 → CONFIGURED
Activate                  → ACTIVE
Suspend                   → SUSPENDED  (→ reactivate, or edit back to DRAFT/CONFIGURED)
```

`DRAFT ⇄ CONFIGURED` follows completeness automatically on every section save.
`ACTIVE` is **never** silently downgraded — only an explicit suspend changes it.

---

## Validation rules (§7–§16)

All rules live **once** in `payrollSetupRules.js` (pure) and are executed by the
service, so jobs, scripts and tests share them.

| Field | Rule |
|---|---|
| PAN | `ABCDE1234F` (5 letters, 4 digits, 1 letter) |
| TAN | `ABCD12345E` (4 letters, 5 digits, 1 letter) |
| GST | 15-char GSTIN pattern (optional) |
| CIN | 21-char CIN pattern (optional) |
| IFSC | `HDFC0001234` (4 letters, `0`, 6 alphanumerics) |
| Account number | 8–18 digits |
| Legal name / state / country | required for activation |
| PF establishment number | required **only when PF is applicable** |
| ESI registration number | required **only when ESI is applicable** |
| PT / LWF state | required **only when that component is applicable** |
| PAN | additionally required **when TDS is applicable** (cross-section rule) |
| Payroll cycle | start/end 1–31, start ≠ end (1→31 and 26→25 both valid) |
| Payment date | `SPECIFIC_DAY`/`CUSTOM` need a day; `LAST_WORKING_DAY` does not |
| Frequency | only `MONTHLY` can be activated in this phase |
| Overtime multiplier | 1–5 when overtime is enabled |

**Draft semantics (§32):** autosave validates **format only**. Missing required
fields are allowed while drafting and reported as an incomplete section; the
activation gate is the only place completeness is enforced.

---

## API surface

Mounted at `/api/payroll/setup`. Every route: `protect → tenantContext →
checkSubscriptionStatus → requirePermission → requireFeature('payroll')`
(writes also pass `checkWriteAccess`).

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/` | `PAYROLL_SETUP_READ` | Config + section evaluation + summary + cache state |
| POST | `/start` | `PAYROLL_SETUP_UPDATE` | `NOT_CONFIGURED → DRAFT` (idempotent, seeds from the Company document) |
| PATCH | `/:section` | `PAYROLL_SETUP_UPDATE` | Draft autosave for `LEGAL`, `STATUTORY`, `POLICY`, `BANK` |
| POST | `/activate` | `PAYROLL_SETUP_ACTIVATE` | Validate → `ACTIVE`, audit, notify |
| POST | `/suspend` | `PAYROLL_SETUP_ACTIVATE` | `ACTIVE → SUSPENDED` with a reason |

Response contracts (the frontend depends on them):

```
GET    → data: { config, evaluation, summary, cache }   cache: HIT | MISS | BYPASS
POST   /start  → data: { config, evaluation, started }
PATCH  → data: { config, evaluation, summary }
POST   /activate | /suspend → data: { config, evaluation, summary }
```

`evaluation` = `{ sections: [{ key, label, step, complete, errors[] }],
completedCount, totalCount, allComplete, errors, warnings[] }`.

### Optimistic concurrency (§35)

Every read returns `config.configVersion`. Sending `configVersion` with a
`PATCH` / `activate` makes the write conditional:

```jsonc
{ "configVersion": 7, "legalName": "Acme Technologies Pvt Ltd" }
```

A stale version → **409** `This payroll setup was updated by someone else.
Reload and try again.` The write itself is a guarded
`findOneAndUpdate({ _id, companyId, configVersion })` — two simultaneous
approvals cannot both succeed.

---

## Multi-tenancy (§2)

- Tenant identity comes **only** from `req.companyId`.
- No route, service or validator accepts a client-supplied `companyId`.
- Every query is filtered by `{ companyId, isCurrent: true }`.
- A request without tenant context (platform staff) is rejected with **403** —
  Super Admin never gets a shortcut into a customer's payroll configuration.
- Cache keys are tenant-scoped by construction.

---

## RBAC (§3)

New resource `PAYROLL_SETUP` with three permissions. `SYSTEM_PERMISSION_VERSION`
was bumped **13 → 14**, so existing system roles are migrated once with the
existing atomic `$addToSet` migration (custom permissions preserved).

| Role | READ | UPDATE | ACTIVATE |
|---|:--:|:--:|:--:|
| Company Admin | ✅ | ✅ | ✅ |
| HR Manager | ✅ | ✅ | — (deliberate: activation is high-impact) |
| Manager / Team Lead / Employee | — | — | — |
| Super Admin | platform only, no tenant bypass | | |

These routes check **permissions, not role names** — grant
`PAYROLL_SETUP_ACTIVATE` to any role (or create a Payroll Admin role from a
template) and that role can activate. See the **RBAC update** section at the
top of this document for the full payroll permission model.

Payroll setup is additionally gated by the `payroll` subscription feature
(`requireFeature('payroll')` + the `PAYROLL_SETUP → payroll` plan mapping).
The free plan has `payroll: false`.

---

## Redis (§25 / §26)

Reuses **Phase 28.7** `redisCacheService` — no second client, no second key
convention, no `KEYS`/`SCAN`/`FLUSH`:

```
crewly:cache:company:<companyId>:payroll-setup:v1:current
```

- Read-through with in-process single-flight (`getOrSetCache`).
- Every write invalidates that **exact** key (`deleteCache`).
- Fail-open: a dead Redis degrades to "read from MongoDB"; invalidation returns
  `false` and never throws.
- TTL `PAYROLL_SETUP_CACHE_TTL_SECONDS` (default 300, clamped 10–3600).
- **MongoDB remains the source of truth.** Redis is only a cache.

---

## BullMQ (§27 / §28)

Nothing here was rebuilt:

- Setup save, validation and activation are **synchronous** — the user never
  waits on a queue job to save a setting (§28).
- Only the activation side effect is background: `notifySmart` (existing,
  preference-aware) → existing email queue.
- **No new queue, no new job name, no change to the Phase 28 queue registry.**
  `notifyPayrollSetupActivated()` in the service is the single seam a later
  phase can point at the BullMQ email outbox if a payroll email job is added.

---

## Security (§17 / §42)

- `bankAccount.accountNumber` is stored **encrypted** (`fieldEncryption`,
  AES-256-GCM, `FIELD_ENCRYPTION_KEY`) and declared `select: false`.
- The API **never** returns the account number — only `maskedAccountNumber`
  (`XXXX XXXX 4589`) and `accountNumberLast4`.
- Audit records for bank changes store `[MASKED]`, never the number.
- Bank details are never logged; logs carry counts and section names only.
- All input is validated server-side; section updates use strict allow-lists
  (unknown keys are dropped, never spread into the document).
- Tenant isolation, RBAC and audit on every mutation.

---

## Audit (§24)

`securityauditService.recordAudit` (existing) with `resource: 'PAYROLL_SETUP'`:

`Payroll setup started` · `Payroll legal information updated` ·
`Payroll statutory configuration updated` · `Payroll policy updated` ·
`Payroll bank details updated` · `Payroll activated` · `Payroll suspended`

Each record carries company, actor (id/name/role), action, timestamp, section,
previous value and new value (bank values masked). Activation and suspension are
written with `critical: true` so they complete before the response.

History is readable through the existing `/api/audit` surface
(`targetType = 'PAYROLL_SETUP'`).

---

## Frontend

- **NOT_CONFIGURED** → "Payroll Setup Required" + `0 / 4 Sections Completed` + **Start Payroll Setup**.
- **DRAFT / CONFIGURED** → wizard: left stepper (done / current / pending),
  4 data steps + Review, autosave 1.8 s after the last change with a "Draft
  saved" flash, `Save & Continue`, unsaved-changes indicator.
  The account number is deliberately **excluded from autosave** and only saved
  on an explicit save (§32).
- **ACTIVE / SUSPENDED** → settings dashboard (§34): status badge, four summary
  cards, `View / Edit` per section, last-updated, Suspend / Reactivate.
- **Review** (§20): full summary of all four sections, warnings
  (`NO_STATUTORY_COMPONENTS`, `TDS_WITHOUT_PAN`, `OVERTIME_WITHOUT_BASIS`,
  `NO_PAYMENT_REFERENCE`), per-section errors, **Activate Payroll** behind a
  confirmation modal (§21).
- Statutory fields appear only when their component is switched on, each with a
  short "why this exists" hint (§9).
- Existing design system only: `card`, `badge`, `btn-primary`, `btn-ghost`,
  `input`, `label`, `Modal`, Tailwind `crewly-*` palette. Responsive
  (desktop → tablet).

---

## Testing

```
npm run test:payroll        # both payroll suites (hermetic)
npm run test:payroll-setup  # 33 tests — company payroll setup
npm run test:payroll-rbac   # 27 tests — permissions, templates, scope, audit
```

**60 hermetic tests** (no MongoDB, no Redis, no network). Both are included in
`npm run test:all`.

Coverage: PAN/TAN/GST/CIN/IFSC/account/currency/prefix validation · conditional
statutory requirements · cycle/payment/FY/weekend/LOP/overtime policies ·
bank validation · section progress + activation gate · review warnings · status
machine · account masking · **serialization never leaks the account number** ·
**tenant isolation** (query filters recorded and asserted; company B cannot read
company A; no-tenant → rejected) · cache key convention and TTL clamping ·
cache HIT/MISS/invalidate · **MongoDB source of truth with Redis down** ·
corrupt cache entry falls through · draft autosave · DRAFT → CONFIGURED ·
**409 on stale `configVersion`** · activation gate · activation audit +
notification · guarded activation filter · suspend rules · **bank masked in
audit** · permission matrix (least privilege) · permission version bump · plan
feature mapping.

### Running the full suite

```powershell
cd C:\Users\megal\Desktop\HRMS\HRMS_Crewly\Backend
npm run test:payroll-setup     # this phase — hermetic
npm run test:all               # full suite (needs local MongoDB)
```

The Mongo-backed suites need the local MongoDB the other suites already use
(`MONGO_URI=mongodb://127.0.0.1:27017/crewly_test`). The 29.1 suite does not.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Payroll setup has not been started" | Click **Start Payroll Setup** first |
| 403 on every setup route | Role lacks `PAYROLL_SETUP_*`, or the plan has `payroll: false` |
| 409 "updated by someone else" | Reload the page and re-apply the change (optimistic concurrency) |
| Section never turns "Configured" | Save it at least once — completion = **valid AND saved** |
| "Only monthly payroll can be activated" | Set frequency to Monthly (weekly/bi-weekly arrive later) |
| Payslip/bank shows `XXXX XXXX …` | Expected — full account numbers are never returned |
| Setup changes not visible immediately | Cache TTL (default 300 s). Every write invalidates the key; a stale read means Redis was unavailable and Mongo served the response |

---

## Non-goals (§39) — explicitly NOT implemented

Salary components · salary structures · employee salary assignment · payroll
calculation · monthly payroll processing · attendance calculation · LOP engine ·
overtime engine · bonus · TDS/PF/ESI calculation engines · payslip generation ·
bank file generation · direct bank transfer / bank APIs · employee loans · final
settlement · payroll reports.

Statutory *rates, ceilings and formulas* are **not** stored here either (§10):
29.1 records what applies; the engine decides how much.

---

## Phase 29.2 handoff (Salary Components)

29.2 can create `SALARY_COMPONENT_*` routes and gate them with
`requirePermission('SALARY_COMPONENT_MANAGE')` + `resolvePayrollScope()`. No
new RBAC plumbing is needed: the permissions, scopes, templates and audit
hooks all already exist. When 29.2 writes a sensitive action, call:

```js
await payrollActionAudit({
  audit: writeAuditLog,
  req,
  action: 'SALARY_CHANGED',
  targetId: employeeId,
  period: '2026-08',
  context: { previousCTC, newCTC },
});
```

---

## Phase 29.2 handoff (Salary Components)

The engine-ready seams left in place:

1. `payrollSetupRules.js` is pure and importable by any future calculator —
   add formula modules beside it, never inside it.
2. `statutory.*.applicable` is the switch the statutory engine will read.
3. `payrollPolicy` (cycle, payment date, weekend → working days, LOP basis,
   overtime) is the input contract for the payroll run.
4. `weekendPolicyToWorkingDays()` already speaks the attendance/shift
   vocabulary (`scheduleEngine.DAY_KEYS`) — no duplicate weekly-off logic.
5. `bankAccount` (encrypted number + payment reference prefix) is the input for
   the later bank transfer file phase.
6. `configVersion` + `effectiveFrom/effectiveTo/isCurrent` make effective-dated
   configuration a data change, not a redesign.
