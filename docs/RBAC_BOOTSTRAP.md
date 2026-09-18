# RBAC Bootstrap — Global Catalogue, Tenant Provisioning, Upgrades

Definitive lifecycle for how Crewly bootstraps Role-Based Access Control.
Source of truth is always the repository; this document reflects the tree
that introduced `SYSTEM_PERMISSION_VERSION = 36`.

---

## Current facts (repository truth)

| Item | Value |
| --- | --- |
| `SYSTEM_PERMISSION_VERSION` | **36** |
| Permission catalogue (`DEFAULT_PERMISSIONS`) | **231** permissions, unique names |
| Default active tenant roles (`SYSTEM_COMPANY_ROLES`) | `COMPANY_ADMIN`, `HR_MANAGER`, `MANAGER`, `TEAM_LEAD`, `EMPLOYEE` |
| Authoritative catalogue + role matrix | `Backend/src/utils/permissionRegistry.js` (ONE catalogue — never build a second list) |
| Version owner / migration engine | `Backend/src/utils/permissionService.js` |
| Optional opt-in role templates (data only, never auto-created) | `Backend/src/utils/roleTemplates.js` (e.g. HR Head, Finance Manager) |

`COMPANY_ADMIN` authority = **every** scope-`ALL` permission in the catalogue
plus the full self-service block (`DEFAULT_ROLE_MATRIX.COMPANY_ADMIN`) — the
complete tenant-admin set across Payroll, Recruitment, Attendance, Company
Settings/Branding and all earlier modules. Platform Super Admin permissions
are a separate RBAC universe and are never granted to tenant roles.

---

## 1. GLOBAL BOOTSTRAP (empty database → API ready)

`Backend/src/server.js` (`startServer`) runs a deterministic sequence and
only then starts listening:

```
connect Mongo
→ ensurePermissions()          ← RBAC catalogue (this fix)
→ initializeRedis()
→ ensureDefaultPlans()
→ ensureCareerPortalIdentifiers()
→ ensureCandidateIdentifiers()
→ ensureCandidatePipelineStages()
→ app.listen()
```

`ensurePermissions()` upserts the catalogue with `bulkWrite` `$setOnInsert`
(`ordered: false`), then **re-reads** the live collection and clears the
permission-metadata cache. A fresh deployment therefore has every system
permission registered before the first request is accepted; the first guarded
request can never 403 with "Permission X is not registered.".

Failure semantics: if the bootstrap throws, startup aborts — the API never
listens half-bootstrapped. No sleeps, no retries-with-delays.

## 2. TENANT PROVISIONING (company registration)

`authController.registerCompany()`:

1. Transaction: `Company` + `Subscription` (trial) + founder `User`
   (`role = COMPANY_ADMIN`) — committed atomically.
2. **After commit, before any session/token is issued:**
   `await ensureCompanyRoles(company._id, admin._id)`.
3. Only then is the founder's session created and the registration returned
   as success.

`ensureCompanyRoles` (idempotent, atomic per role):

- ensures the global catalogue exists,
- reads the **current live** catalogue (`_id`/`name` projection — never a
  cached snapshot),
- upserts all five default roles with their matrix permissions
  (unique `{companyId, code}` — concurrent upserts converge via E11000),
- attributes the roles to the founder (`createdBy`).

If provisioning throws, **no token is issued** — registration never reports
success with unusable founder RBAC. The committed company/user are kept;
the founder signs in again and the idempotent ensure completes.

## 3. PERMISSION RESOLUTION (per request)

`requirePermission` → `hasPermission` → `resolveUserPermissions`:

- process-local 5-minute grant cache per `{companyId, userId}` (invalidated
  on every role migration / role edit),
- `ensureCompanyRoles` self-heal runs on every cache miss, so a company that
  somehow lacks default roles is repaired in-request,
- **bootstrap self-repair:** a system role that was never admin-edited
  (`updatedBy === null`) and resolves to fewer live permissions than its
  authoritative matrix is repaired additively (`$addToSet` with fresh ids).
  This heals roles poisoned by dangling references (e.g. a database that was
  dropped and recreated under a live API process). Custom roles and
  admin-tuned system roles are never rewritten.

## 4. UPGRADE (version N → N+1)

Bump `SYSTEM_PERMISSION_VERSION` **only** when the catalogue or the default
role matrices change; log the change in the migration comment block.
On the next `ensureCompanyRoles` run for each company, system roles with
`permissionVersion < N+1` receive the new defaults once via atomic
`$addToSet: { permissions: { $each } }` + version set — no `role.save()`
loops, no stale `__v` conflicts, custom permissions preserved, custom roles
(not `isSystemRole`) untouched. Existing tenants must not restart to receive
version grants: the migration runs in-request on first permission resolution.

## 5. MULTI-INSTANCE SAFETY

- Catalogue ensure: idempotent `$setOnInsert` upserts; concurrent instances
  racing the unique `name` index converge — duplicate-key write errors are
  treated as convergence, any other error fails startup loudly.
- Tenant provisioning: unique `{companyId, code}` upserts, E11000 → re-read.
- No process-local `initialized` flag is ever the correctness mechanism;
  Mongo state is the only truth (process memos are performance only).

## 6. CACHE BEHAVIOR

| Cache | TTL | Guard |
| --- | --- | --- |
| `permissionMetaCache` (Permission doc metadata) | 5–60 s (env `PERMISSION_METADATA_CACHE_TTL_MS`) | cleared after every successful catalogue ensure; stale nulls cannot outlive a bootstrap |
| `permissionCache` (resolved user grants) | 5 min | invalidated after every role migration/repair and role edit |
| subscription gate cache | short TTL | exact invalidation via Subscription hooks (unchanged) |

Mongo is always the source of truth; caches only speed up reads and never
repair missing RBAC.

## 7. OPERATIONAL BOUNDARY (read before dropping a database)

Dropping/recreating the database **requires restarting the API (and worker)**
so every startup ensure and process cache re-runs against the new database.
A live process whose database was replaced underneath it is an unsupported
state for ANY subsystem (plans, subscriptions, RBAC); RBAC additionally
self-repairs the role damage it can detect (see §3), but prevention is the
restart.

---

## Regression coverage

`Backend/test/rbacBootstrap.test.js` (hermetic, `npm run test:rbac-bootstrap`,
part of `npm run test:all`): empty-DB catalogue bootstrap, the original
founder-403 regression, dangling-reference self-repair, admin-tuned role
protection, employee no-overgrant, tenant isolation, newer-module grants,
concurrent/multi-instance convergence, idempotency, custom-role upgrade
safety, stale-cache behavior, and the catalogue↔matrix drift guard.
