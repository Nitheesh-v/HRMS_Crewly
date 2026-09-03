# Phase 30.1.1 — Ops-Only BGV Verifier Workbench (platform portal)

> Supersedes the ACCESS MODEL of Phase 30.1 (`PHASE_30_1_BGV_CHECK_FRAMEWORK.md`).
> The 30.1 framework internals (BgvCheck model, status machine in
> bgvCheckRules.js, evidence storage, SLA/aging, events, audit guards)
> carry over UNCHANGED — only WHO operates them moved.

## Why this phase exists

Management rule: BGV verification is performed EXCLUSIVELY by Crewly's
internal operations team. Tenant companies never verify. Phase 30.1
shipped the workbench tenant-side by mistake; this phase relocates
execution to the super-admin portal and strips the tenant verifier
surface down to a read-only summary.

## Operating model

| Actor | Can do |
| --- | --- |
| Tenant HR (27.15, unchanged) | Start case, collect consent, view case, record final decision (30.7). |
| Tenant (new) | ONE extra read-only feed: `GET /api/bgv/cases/:caseId/checks-summary`. |
| Crewly `BGV_TEAM` user | `bgv:read` + `bgv:verify` — cross-tenant queue, status, evidence, extend SLA. |
| Crewly `PLATFORM_ADMIN` | `bgv:read` + `bgv:verify` + `bgv:assign` — also assign/reopen/seed. |
| Crewly `SUPER_ADMIN` | `*` covers everything above. |

## Permission changes (before → after)

Company (tenant) permission registry — `SYSTEM_PERMISSION_VERSION` 27 → 28:

| Permission | 30.1 (before) | 30.1.1 (after) |
| --- | --- | --- |
| `BGV_CHECK_READ` | granted to COMPANY_ADMIN (+migration) | REVOKED — registry entry retired |
| `BGV_CHECK_ASSIGN` | granted | REVOKED |
| `BGV_CHECK_VERIFY` | granted | REVOKED |
| `BGV_CHECK_MANAGE` | granted | REVOKED |
| `BGV_CHECK_OVERRIDE` | granted | REVOKED |
| `BGV_EVIDENCE_MANAGE` | granted | REVOKED |
| `BGV_VERIFIER` role template | existed | RETIRED (static catalog edit — no DB rows) |

Platform permissions (`superAdminAuth.PLATFORM_PERMISSIONS`, naming
follows `operations:read/manage` style):

| Permission | Gates |
| --- | --- |
| `bgv:read` | list, mine, stats, detail, evidence download |
| `bgv:verify` | status, evidence add, extend-sla |
| `bgv:assign` | assign, reopen, seed-checks, verifier picker |

`bgv:assign` REPLACES the interim `bgv:manage`. There is deliberately
no "own checks only" rule: the Crewly ops pool is small and trusted,
so the permission itself is the gate (documented decision).

`BGV_CHECK_READ` removal from the registry was approved once the
tenant summary endpoint uses only the existing 27.15
`BACKGROUND_VERIFICATION_READ` permission — nothing tenant-side
referenced the six BGV_* keys any more (verified by grep in the tests).

### Migration for existing databases

`npm run migrate:bgv30` (Backend) now REVOKES instead of grants:

1. resolves the six retired `Permission` docs by name (company roles
   store ObjectIds, not strings);
2. atomic `updateMany + $pull` from every `CompanyRole` (system + custom);
3. deactivates the orphaned `Permission` rows (`isActive:false` — kept
   for audit referential history, gone from every picker).

Idempotent; `--dry-run` previews. The version bump 27 → 28 makes the
system-role migration converge on the next role ensure, and because
the registry no longer lists the BGV family the `$addToSet` pass can
never resurrect them.

## Verifier identity model (documented choice)

Platform users live in the SAME `User` collection as tenant users —
the portal is distinguished by `role ∈ PLATFORM_ROLES` plus
`AdminSession` (the Phase 28 pattern), not by a second model. Adding
`assigneeModel` or renaming `assignedVerifierId` → `platformVerifierId`
would require a data migration for zero additional safety. Instead:

- `PLATFORM_ROLES` gained a fifth entry: **`BGV_TEAM`** (source of
  truth moved to `src/utils/constants.js`, re-exported by
  superAdminAuth — so the BGV service can import it without dragging
  the env/JWT chain into hermetic tests).
- `assignVerifier` loads the target User and REJECTS non-platform or
  non-ACTIVE users with **400** ("tenant accounts cannot verify");
  unknown ids still 404.
- The verifier picker (`GET checks/verifiers`) lists only ACTIVE
  platform users.
- `User.role` enum already contained the platform roles (BGV_TEAM
  added to `ROLES` in constants.js — same enum the User model uses).

## Backend API (all under the platform gate)

Gate order — platform session → platform permission → DB:

1. `protect` (any valid JWT),
2. `superAdminSession`: 403 `Platform administrator access required`
   for `role ∉ PLATFORM_ROLES` BEFORE any `AdminSession` lookup (mirrors
   Phase 28); then resolves `req.platformPermissions` (per-user override
   or role map),
3. per-route `permit(...)` (variadic ANY-of),
4. service loads the BgvCheck by `_id`, reads `companyId` FROM THE
   RECORD and scopes every downstream write by `{ _id, companyId }`.

| Route | Permit |
| --- | --- |
| `GET  /api/super-admin/bgv/checks` | bgv:read |
| `GET  /api/super-admin/bgv/checks/stats` | bgv:read |
| `GET  /api/super-admin/bgv/checks/mine` | bgv:read |
| `GET  /api/super-admin/bgv/checks/verifiers` | bgv:assign |
| `GET  /api/super-admin/bgv/checks/:checkId` | bgv:read |
| `GET  /api/super-admin/bgv/checks/:checkId/evidence/:evidenceId` | bgv:read |
| `POST /api/super-admin/bgv/checks/:checkId/status` | bgv:verify or bgv:assign |
| `POST /api/super-admin/bgv/checks/:checkId/evidence` | bgv:verify or bgv:assign |
| `POST /api/super-admin/bgv/checks/:checkId/extend-sla` | bgv:verify or bgv:assign |
| `POST /api/super-admin/bgv/checks/:checkId/assign` | bgv:assign |
| `POST /api/super-admin/bgv/checks/:checkId/reopen` | bgv:assign |
| `POST /api/super-admin/bgv/cases/:caseId/seed-checks` | bgv:assign |
| `GET  /api/bgv/cases/:caseId/checks-summary` (tenant) | BACKGROUND_VERIFICATION_READ |

Bodies/validators are identical to 30.1 (bgvCheckValidator.js
untouched — same file, now platform-mounted). Evidence upload keeps
the 5 MB multer guard and MIME allowlist.

Unbounded-dump guard: `GET /checks` WITHOUT any of
`companyId`/`status`/`assignedToMe` is hard-capped server-side at 50
rows per page (with narrowing filters the cap is 100); `meta.capped`
+ `meta.notice` tell the client.

Tenant summary response shape — nothing more is ever exposed:

```json
[{ "checkType": "EMPLOYMENT", "status": "IN_PROGRESS", "updatedAt": "..." }]
```

## Audit contract

Every mutation AND the detail read write an audit row:
`action: BGV_CHECK_*`, `actorRole: 'PLATFORM_USER'`,
`metadata.actorType: 'PLATFORM_USER'`, the record's `companyId`, the
platform `actorId`. (recordAudit has no `actorType` column — the
metadata marker is the documented carrier; `actorName`/IP come from
the request context where available.) Safe-metadata rules from 30.1
unchanged: no evidence bodies, phone masked `XXXX-XXXX-9012`, geo
rounded to 3 decimals, raw Aadhaar/PAN/passport numbers in verifier
text are 400s.

## Remediation applied (spec items)

1. `Frontend/src/pages/bgv/*` + `services/bgvCheckService.js` +
   `/app/bgv/*` routes + AppLayout menu + SidebarNav prefix/PATH_ICONS
   entries — all deleted (detail UI action buttons went with them).
2. Tenant verifier routes DELETED (`/api/bgv/checks*` mounts removed;
   other `/api/bgv/*` paths 404 — deletion beats 403 since nothing is
   left to gate). Handlers reuse the SHARED `bgvCheckService.js`
   service layer — the service was NOT forked (spec: reuse).
3. `GET /api/bgv/cases/:caseId/checks-summary` added on the 27.15 case
   read permission with the masked DTO above.
4. Revocation migration + version bump (details above).
5. `assignedVerifierId` → platform-user enforcement (decision above).

## Frontend

- `src/services/superAdminBgvService.js` — platform API client.
- `src/pages/admin/SuperAdminBgvWorkbenchPage.jsx` — cross-tenant
  queue: Tenant / Candidate / Check / Assignee / Status / SLA pill
  (red-amber-green) / Last update columns; tenant dropdown (from the
  companies API), checkType, status, aging, candidate search, My
  assignments; stat cards Open / Due 48h / Overdue / Awaiting
  response; "Assign to me" for admins; capped-notice line.
- `src/pages/admin/SuperAdminBgvCheckDetailPage.jsx` — the 30.1 panel
  set (entries, evidence with uploads, follow-up, human-only status
  machine) PLUS a tenant-context strip naming the company (links to
  the super-admin company detail). NO HR decision panel (that stays
  tenant-side, 30.7). Assign/reopen buttons render only for
  SUPER_ADMIN/PLATFORM_ADMIN; the picker lists Crewly users only.
- Routes: `/super-admin/bgv` + `/super-admin/bgv/checks/:checkId`
  inside the RequireRole(PLATFORM_ROLES) portal layout; nav item
  "BGV Verification" with Lucide `ShieldCheck` (layout now supports a
  `Lucide` entry on MENU items — existing emoji icons untouched).
- Tenant case page gained `CrewlyChecksSummary`: read-only chips from
  the summary endpoint; renders nothing while loading and never
  blocks the case view.

## Testing

`npm run test:bgv-ops` (Backend) — hermetic, no Mongo/Redis/network:
27 tests covering seeding (incl. platform repair seed where the CASE
decides ownership), cross-tenant listing + unfiltered hard cap,
audit-on-read stamping, assign accepts platform user / rejects tenant
User with 400 / unknown 404 / non-assign actor 403, verifier picker
platform-only, verify actor acting on any check without the own-only
rule, cross-tenant write isolation (sibling row untouched), raw-doc
rejection, evidence masking (audit `XXXX-XXXX-3210`, note bodies
absent), file download round-trip + audit, SLA once-per-check 409,
reopen bgv:assign-gated terminal-only with reason, stats card keys,
tenant summary shape (`Object.keys` deep-equals the three, absence of
notes/assignee/contact), and the static wiring block: tenant mount is
summary-only with no verifier paths, execution router NOT tenant-
mounted, session-gate line precedes the `/bgv` mount, route permits
use read/verify/assign, superAdminSession 403s before any
AdminSession lookup, retired permission names absent from
permissionRegistry + role templates, `SYSTEM_PERMISSION_VERSION = 28`
with changelog, migration script uses `$pull` + `Permission.updateMany`
and never `$addToSet`.

`test:bgv-checks` (rules, 8) and `test:all` (845) stay green; old
stale `bgvCheckService.test.js` was replaced by this suite.

## Manual verification (PowerShell)

```powershell
cd Backend
npm run test:bgv-ops
npm run test:bgv-checks
npm run test:all
npm run migrate:bgv30 -- --dry-run
npm run migrate:bgv30
cd ..\Frontend
npm run build
```

Functional: log in to `/super-admin/login` as a platform user (or
create a `BGV_TEAM` user), open **BGV Verification** in the sidebar →
queue with Tenant column → open a check → assign to a Crewly user →
add a note/screenshot evidence → change status → see the audit
actions carry `PLATFORM_USER`. If a started case shows no checks, a
PLATFORM_ADMIN can re-seed it:
`POST /api/super-admin/bgv/cases/:caseId/seed-checks`
(PowerShell: `Invoke-RestMethod -Method Post -Uri https://<api>/api/super-admin/bgv/cases/<caseId>/seed-checks -Headers @{Authorization="Bearer <platformJwt>"}`).
Then a tenant HR login: the case detail
shows only progress chips; `/app/bgv/workbench` no longer exists;
`Invoke-RestMethod https://<api>/api/bgv/checks -Headers @{Authorization="Bearer <tenantJwt>"}`
→ 404 (route deleted); the same call against
`/api/super-admin/bgv/checks` → 403.

## What deliberately did NOT change

- 27.15 contracts, pipeline transitions, 27.13 conversion gate.
- BgvCheck schema fields and indexes (only doc comments added).
- Evidence storage private-disk layout, MIME/size guards.
- "Crewly never auto-rejects" — every case still ends in a human
  decision; entry rollups set UTV/flags only.
- No queue jobs added (Redis/BullMq infra untouched).
