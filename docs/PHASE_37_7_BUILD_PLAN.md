# Phase 37.7 — Tenant Administration, Operational Hardening & Closeout

> Historical build-plan snapshot. The audit and A–E plan below describe the repository before Phase 37.8; they are not current runtime status. Phase 37.8 later mounted the opt-in namespace before `listen()`, made adapter initialization nonblocking/idempotent with bounded retries, and verified cross-instance Socket.IO Redis-adapter delivery. See [`PHASE_37_4_DISTRIBUTED_REALTIME.md`](./PHASE_37_4_DISTRIBUTED_REALTIME.md) and [`PHASE_37_8_LOCALHOST_ACCEPTANCE.md`](./PHASE_37_8_LOCALHOST_ACCEPTANCE.md).

## A. REPOSITORY FINDINGS

### A.1 37.1–37.6 inventory (audited this turn)
| Unit | Backend | Frontend | Status |
|------|---------|----------|--------|
| 37.1 Foundation | `services/presence/{presenceConfig,presenceErrors,presenceEvents,presenceLive,presenceLiveStore,presenceLiveStoreRegistry,presenceBus,presenceResolver,presenceService,presenceTenantConfigService}.js` + `models/{UserPresence,PresenceTenantConfig}.js` + `controllers/presenceController.js` + `routes/presence.js` + `validators/presence/{presenceValidator,teamAvailabilityValidator}.js` | `services/presenceService.js` + `redux/slices/{presenceSlice,presenceConstants}.js` | OK |
| 37.2 Self UI | `controllers/presenceController.js` (status / status-message / work-location) | `components/presence/{PresenceIndicator,PresenceMenu,StatusExpirySelector,StatusMessageEditor,WorkLocationSelector,presenceVisual}.jsx` | OK wired in `AppLayout` |
| 37.3 Team | `presenceTeamService.js` + `teamAvailabilityValidator.js` | `pages/team/TeamAvailabilityPage.jsx` | OK route `team/availability` SENIORS |
| 37.4 Realtime | `socket/{presenceSocket,presenceSocketConfig,presenceSocketHandlers}.js` + `presenceBus.js` + `presenceLiveStore.js` + `presenceLiveStoreRegistry.js` | `services/realtime/{presenceChannel,presenceRuntime}.js` | Historical at 37.7: attach was disabled by a prior stop-gate; superseded by the opt-in 37.8 lifecycle documented in `PHASE_37_4_DISTRIBUTED_REALTIME.md` |
| 37.5 WFH | `services/presence/workLocationRequestService.js` + `controllers/presence/workLocationRequestController.js` + `routes/presence/workLocationRequestRoutes.js` + `validators/presence/workLocationRequestValidator.js` + `models/WorkLocationRequest.js` | `pages/presence/WorkLocationReviewPage.jsx` + `components/presence/{WorkLocationRequestDialog,WorkLocationRequestHistory}.jsx` | OK route `presence/work-location-requests/review` HR |
| 37.6 Leave + OWH | `services/presence/presenceHrContext.js` (NEW) + extended `presenceResolver.js` + extended `presenceService.js` + extended `presenceTeamService.js` | `Empty/EMPTY_PRESENCE` extended + PresenceMenu banner + TeamAvailabilityPage filter chip + workLocation hidden on on_leave | OK |

### A.2 Critical findings the plan must address
1. **Routes registered, but no admin UI**: `GET/PUT /api/presence/config` exists with `SETTINGS_MANAGE` guard (`Backend/src/routes/presence.js`), but the Frontend has **no** settings page. An admin cannot reach tenant policy except by curling the API.
2. **No navigation entry for any Phase 37 page**: `SidebarNav.jsx` is missing every `presence/*`, `team/availability`, `presence/work-location-requests/review`, and `/app/settings/presence*` path. The pages are reachable only by direct URL.
3. **`workLocationRequestRoutes` mounted under a path the parent router also claims**: confirmed safe via path-prefix matching.
4. **`SETTINGS_MANAGE` permission is in the registry** (`utils/permissionRegistry.js:337`).
5. **No NATS in code or deps** — `grep -rn "NATS\|nats" Backend/src` returns only comments. `package.json` has no `nats`/`nats.ws` dep.
6. **Historical stop-gate finding** — this 37.7 draft observed the attach call commented out. Phase 37.8 supersedes that runtime state: `server.js` now conditionally calls the attachment before the single `server.listen(...)`, with `PRESENCE_SOCKET_ENABLED=false` remaining the safe default.
7. **Frontend presence reuses the existing `presenceService.js`** — no separate `presenceConfigService.js`. The admin page will need new exports there.

### A.3 Current settings backend surface
`Backend/src/services/presence/presenceTenantConfigService.js` exposes:
- `getPresenceTenantConfigOrThrow({companyId, model})` — read, fail-closed
- `updatePresenceTenantConfig({companyId, userId, patch, model})` — write, whitelisted fields
- `PRESENCE_UPDATABLE_FIELDS = [enabled, employeePresenceVisible, statusMessagesEnabled, workLocationEnabled, wfhMode, awayAfterMinutes, offlineAfterMinutes, lastSeenVisible, allowedWorkLocations]`
- `PRESENCE_TENANT_DEFAULTS` in `presenceConfig.js`
- Validation: `wfhMode`, `allowedWorkLocations` (array, no dupes, known values), `awayAfterMinutes > 0`, `offlineAfterMinutes > awayAfterMinutes`, empty allowed list refused unless `workLocationEnabled === false`

### A.4 Test baseline (this turn, before any 37.7 work)
346/346 Phase 37 backend tests passing (185 prior presence + 53 hr-integration + 108 workLocation/attendance).

### A.5 Folder structure (do NOT reorganise)
- `Backend/src/{controllers,routes,services,validators,models,socket,utils}/presence*` — feature-scoped, intact.
- `Frontend/src/{components,pages,redux/slices,services}/presence*` — feature-scoped, intact.

### A.6 Existing settings page style
- AI settings: `Frontend/src/pages/settings/aisettings/AiSettingsPage.jsx`
- AI usage: `Frontend/src/pages/settings/aiusage/AiUsagePage.jsx`
- Notification settings: `/app/notification-settings`
- Company / Billing / Roles: `/app/company`, `/app/billing`, `/app/roles-permissions` — live under the "More → Administration" group.

The Phase 37.7 admin page will live at `/app/settings/presence` and live in `More → Administration` (the same group as `/app/company`, `/app/governance`, `/app/roles-permissions`).

### A.7 Performance stop-gate (historical 37.7 snapshot)
At the time of the 37.7 audit, the socket attach was commented out. Phase 37.8 now mounts it only when enabled, returns from `attach()` without waiting for adapter connection, and preserves one HTTP `listen()`. No NATS or frontend Redis client was added.

## B. SECURITY / DATA BOUNDARIES

### B.1 Identity authority
- `req.companyId` from tenant middleware (the only authoritative source for config scope).
- `req.user._id` from auth middleware (the only authoritative source for `updatedBy`).
- **NEVER** read `companyId` / `userId` / `employeeId` from body or query for config operations.

### B.2 RBAC
- Backend already gates with `requirePermission('SETTINGS_MANAGE')`. This permission is in the registry.
- Frontend page is gated by `RequireRole roles={COMPANY_ADMIN}` to mirror the existing AI admin pages.
- The page will **not** register a new permission.

### B.3 Privacy
- DTO must NOT include `updatedBy` to non-admins. The 37.7 frontend admin page will not display `updatedBy`. Backend keeps it for audit.
- No salary / payroll / leave-reason / medical data appears in any presence config.

### B.4 Mutation boundaries
- Presence does not mutate Attendance, Leave, Shift, Payroll, AI.
- Admin settings can change `wfhMode` from `self_declare` → `approval_required`. This does NOT retroactively cancel approved WFH.

### B.5 Anti-surveillance closeout
- No activity history collection.

### B.6 NATS / cross-instance (historical snapshot, superseded by 37.8)
- 37.7 added **no** NATS. At the time this draft was written, cross-instance delivery had not been verified and the environment default was opt-in/off.
- Current status: `server.js` calls `presenceSocket.attach()` only when `PRESENCE_SOCKET_ENABLED=true`, before `server.listen()`. The existing Socket.IO Redis adapter is now verified by the hermetic 37.8 suite for cross-instance delivery, local forwarding, tenant/user room isolation, and no echo. Adapter setup is nonblocking and retries in the background. See the current 37.4 runtime reconciliation doc; localhost owner acceptance remains pending.

## C. IMPLEMENTATION

### C.1 Backend (minimal — settings backend already exists)
**Nothing new in 37.7 backend.** The settings API at `/api/presence/config` is already complete.

A closeout assertion suite (`test/presenceCloseout.test.js`) will pin these guarantees.

### C.2 Frontend (NEW admin page)
1. **`Frontend/src/services/presenceService.js`** — already has `getTenantConfig` / `updateTenantConfig`.
2. **`Frontend/src/redux/slices/presenceSlice.js`** — extend with `loadPresenceConfig` + `savePresenceConfig` thunks + `config: {data, loading, saving, error}` sub-state.
3. **`Frontend/src/pages/settings/presence/PresenceSettingsPage.jsx`** (NEW) — the admin page.
   - Sections: Presence, Work Location, WFH Policy, Availability Timing
   - **Sticky bottom Save bar**
   - **Initial loading**: spinner, then deterministic `loading=false` regardless of success/failure
   - **Per-field dirty state** using a per-key diff
   - **On success**: reset dirty, show success toast, reload snapshot to canonicalize
   - **On failure**: keep dirty state, show error toast, controls re-enable
   - **No localStorage** of any config
   - **No `companyId`/`userId`/`employeeId`** in the request body
4. **`Frontend/src/routes/AppRoutes.jsx`** — register `/app/settings/presence` lazy route under `RequireRole roles={COMPANY_ADMIN}`.
5. **`Frontend/src/layout/SidebarNav.jsx`** + **`Frontend/src/layout/AppLayout.jsx`** — add the menu entry under Administration.

### C.3 UX invariants enforced in the admin page
- **`workLocationEnabled` toggle**: When `true`, at least one location must remain checked (last box disabled).
- **WFH mode consistency**: `wfhMode=disabled` greys out WFH copy. WFH=disabled + WFH in allowed list is a client-side guard.
- **Away/Offline**: Offline input is `min = Away + 1`.
- **Dirty semantics**: Per-field. No page-wide "did anything change" flag.
- **Unsaved navigation**: `beforeunload` only (NOT React Router `useBlocker`).

### C.4 Operational runbook (`docs/PHASE_37_RUNBOOKS.md`)
Already exists from 37.1-37.6. 37.7 appends the closeout runbook with the 11 incidents and the cross-instance-realtime caveat.

### C.5 Phase 37 memory capsule (`docs/PHASE_37_MEMORY_CAPSULE.md`) (NEW)

### C.6 Final route + realtime event audits
Content in the memory capsule.

## D. TEST PLAN

### D.1 Backend closeout suite (`Backend/test/presenceCloseout.test.js`)
- Settings backend (#1-#16 from §43 of the spec): RBAC, tenant isolation, every field, every invariant.
- Closeout security suite (#17-#30 partial from §44): tenancy, identity, presence, work-location, WFH approval, leave, working hours, boundaries, privacy, performance, realtime.

### D.2 Frontend admin page suite (`Frontend/test/presenceSettings.test.js`)
- 25 source-pin + behavioural tests: page reachable, loading clears, save works, dirty semantics, allowed-locations invariant, Away/Offline invariant, no localStorage, no fake NATS controls, no fake Redis controls, no identity keys in body, etc.

## E. ENVIRONMENT / DEPENDENCIES

- **No new env vars**.
- **No new packages**.
- **No new collections / Mongo fields / indexes**.
- **No NATS**.
- **No `.env` modification**.
- The existing `Backend/.env.example` already documents the relevant variables for Phase 37 (`PRESENCE_SOCKET_ENABLED`, `REDIS_URL`, etc.). 37.7 will not edit it.
