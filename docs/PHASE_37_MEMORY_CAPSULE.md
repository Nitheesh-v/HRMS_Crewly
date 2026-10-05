# Phase 37 — Memory Capsule

> The single artifact that survives the unit. Following the
> usefulness of `PHASE_36_MEMORY_CAPSULE.md` (and the 33
> capsule before it). Read this if you are picking Phase 37
> up cold, in any order.

---

## 1. WHAT PHASE 37 IS

Phase 37 is the **Workforce Presence, Availability & Work
Location** suite. It lets employees publish a current
communication availability (Available / Busy / DND / Away /
Offline) and a current work location (Office / WFH / Remote),
and lets authorised managers / HR see the same data as a
read-only team view, approve WFH requests, and configure
company policy.

It is the **soft** part of the workforce stack: it carries
no attendance punches, no payroll, no leave mutation, no
salary / PAN / Aadhaar, no GPS, no productivity score.

## 2. WHAT PHASE 37 DELIBERATELY IS NOT

- Not Attendance. Available does not check in. Away does not
  check out. Offline does not mean HR absence. WFH is not
  attendance proof. (Phase 31 owns attendance.)
- Not Leave. Presence READS approved active Leave to produce
  the `on_leave` fact. It does NOT create, approve, reject,
  cancel, or edit Leave.
- Not Payroll. Presence outages must not become payroll
  outages. There is no paid-hours derivation in this code.
- Not AI. Presence does not call the AI retriever, the
  chatbot service, or the assistant's prompt. The
  `hrContextRetriever` does not list "who is available".
- Not surveillance. There is no activity history, no mouse
  / keystroke / focus timeline, no screenshot, no GPS, no
  last-30-days view.
- Not cross-instance realtime. See §6 below.

## 3. UNITS 37.1 — 37.7

| Unit | What it owns | Backend key files | Frontend key files |
|------|--------------|-------------------|--------------------|
| 37.1 | Foundation, models, settings backend | `services/presence/presenceConfig.js`, `presenceResolver.js`, `presenceService.js`, `presenceTenantConfigService.js`, `models/{UserPresence,PresenceTenantConfig}.js` | `services/presenceService.js`, `redux/slices/{presenceSlice,presenceConstants}.js` |
| 37.2 | Self-service UI (status, status message, work location) | `controllers/presenceController.js` (status / status-message / work-location handlers) | `components/presence/{PresenceIndicator,PresenceMenu,StatusExpirySelector,StatusMessageEditor,WorkLocationSelector,presenceVisual}.jsx` |
| 37.3 | Team availability (read-only) | `services/presence/presenceTeamService.js`, `validators/presence/teamAvailabilityValidator.js` | `pages/team/TeamAvailabilityPage.jsx` |
| 37.4 | Realtime (Socket.IO + Redis) | `socket/{presenceSocket,presenceSocketConfig,presenceSocketHandlers}.js`, `services/presence/{presenceBus,presenceLiveStore,presenceLiveStoreRegistry,presenceLive,presenceEvents}.js` | `services/realtime/{presenceChannel,presenceRuntime}.js` |
| 37.5 | WFH request / approval workflow | `services/presence/workLocationRequestService.js`, `controllers/presence/workLocationRequestController.js`, `routes/presence/workLocationRequestRoutes.js`, `validators/presence/workLocationRequestValidator.js`, `models/WorkLocationRequest.js` | `pages/presence/WorkLocationReviewPage.jsx`, `components/presence/{WorkLocationRequestDialog,WorkLocationRequestHistory}.jsx` |
| 37.6 | Approved Leave + Working Hours derived presence | `services/presence/presenceHrContext.js` (new) + extensions to `presenceResolver.js` / `presenceService.js` / `presenceTeamService.js` | `Empty/EMPTY_PRESENCE` extended, `PresenceMenu.jsx` banner, `TeamAvailabilityPage.jsx` on-leave filter chip + OWH tile + workLocation hidden on on_leave |
| 37.7 | Tenant admin / closeout | (no new backend; settings API already complete) | `pages/settings/presence/PresenceSettingsPage.jsx` (new) + sidebar entry + COMPANY_ADMIN route + redux thunks |

## 4. INVARIANT LAWS

1. **Presence is not Attendance.** No presence code path
   calls `Attendance.create / save / update / delete`.
2. **Available never checks in.**
3. **Away never checks out.**
4. **Offline never means HR absence.** It means the resolver
   could not see a live connection. Use `Unknown` for
   "infrastructure could not determine".
5. **Unknown is not Offline.** Two distinct values. Redis
   failure must not make everyone Offline.
6. **WFH is work location, not Leave.** A WFH request is not
   a leave application and vice versa.
7. **Approved WFH is not attendance proof.** The employee
   must still be marked present by the attendance system.
8. **WFH approval is human.** No code path auto-approves
   WFH on green presence / attendance / shift / role /
   browser activity / AI / notification / realtime event.
9. **Approved active Leave wins workforce presentation.**
   `on_leave` is the highest precedence in the resolver. It
   beats DND / Busy / Available / Away and the workLocation
   display.
10. **Leave reason stays private.** The DTO carries
    `{_id, user, startDate, endDate, status, companyId}` only.
    No `reason`, `medical`, `attachments`, `approver`,
    `balance`, `quota`, `remaining`.
11. **Outside Working Hours is contextual, not attendance.**
    It rides alongside `presence`; it never replaces it.
    `null !== false`.
12. **Client identity is never authority.** `companyId`,
    `userId`, `employeeId` from the body or query are
    refused by every presence validator. The auth handshake
    is identity.
13. **Tenant scoping applies everywhere.** Self, team,
    realtime, config — every read and every write is scoped
    to `req.companyId`.
14. **Realtime failure must not lie.** Redis down → everyone
    reads `Unknown`, not `Offline`. Socket down → the next
    GET is correct.
15. **Presence does not modify Payroll.** No code path
    touches `Payroll*`.
16. **No activity surveillance history.** No `PresenceHistory`,
    no `ActivityHistory`, no `ProductivityScore`, no mouse
    / keystroke / screenshot store.
17. **Phase 37 works without AI.** Presence does not import
    the AI retriever, the chatbot, or the assistant prompt.
    Phase 36 AI settings can be turned off and Phase 37
    keeps working.
18. **No frontend Redis.** No `VITE_REDIS_URL`, no
    frontend Redis client.
19. **No frontend NATS.** No `VITE_NATS_URL`, no NATS
    client in the browser. The `presenceBus.js` is the
    32.11 SSE gateway re-pointed at an in-process bus, not
    NATS.
20. **Presence should not materially slow unrelated Crewly
    workflows.** The `presenceSocket.attach` is opt-in
    (commented out by `db177d9` to prevent the slow-start
    regression). The HTTP `/api/presence/*` REST endpoints
    are what every UI surface reads.

## 5. MODEL / SERVICE MAP

```
                 ┌─────────────────────────────────────┐
                 │  PresenceTenantConfig (1 per tenant)│
                 │  PresenceTenantConfigService        │
                 └──────────────┬──────────────────────┘
                                │ getConfig / putConfig
                                │ (SETTINGS_MANAGE)
                                ▼
   ┌────────────────────────────────────────────────────────────┐
   │                       presenceService                      │
   │   getMyPresence / setMyStatus / setMyStatusMessage /       │
   │   setMyWorkLocation                                        │
   │                                                            │
   │  reads: PresenceTenantConfig + UserPresence (durable)      │
   │        + presenceLiveStore (live) + presenceHrContext      │
   │          (read-only: Leave + WorkingHours)                 │
   └──────────────┬────────────────────────────┬───────────────┘
                  │                            │
                  ▼                            ▼
   ┌──────────────────────────┐   ┌──────────────────────────────┐
   │     presenceResolver      │   │   presenceTeamService        │
   │   pure precedence:        │   │   batched Leave / working-   │
   │   1) on_leave (37.6)      │   │   hours reads, per-user      │
   │   2) manual               │   │   resolveOne, summary        │
   │   3) live automatic       │   └──────────────────────────────┘
   │   4) unknown              │
   └──────────────────────────┘
                  ▲
                  │ pure inputs from:
                  │   - UserPresence (durable prefs)
                  │   - presenceLiveStore (live)
                  │   - presenceHrContext (Leave + OWH)
```

## 6. FINAL PRESENCE PRECEDENCE

In order, **lowest number wins**:

1. Approved active Leave → `presence: 'on_leave', presenceSource: 'leave'`
2. Manual DND / Busy / Available (and not expired) → `presence: <manual>, presenceSource: 'manual'`
3. No manual + no live → `presence: 'unknown', presenceSource: 'none'`
4. No manual + live (connected, recent activity) → `presence: 'available', presenceSource: 'automatic'`
5. No manual + live (connected, recent inactivity past `awayAfterMinutes`) → `presence: 'away', presenceSource: 'automatic'`
6. No manual + live (no connection OR heartbeat older than `offlineAfterMinutes`) → `presence: 'offline', presenceSource: 'automatic'`

`outsideWorkingHours: true | false | null` rides ALONGSIDE
`presence`. It is contextual. `null` is distinct from `false`.

## 7. WORK-LOCATION SEMANTICS

`workLocation: 'office' | 'wfh' | 'remote'` is a SEPARATE
field from `presence`. WFH:

- Requires `wfhMode !== 'disabled'`.
- Requires `'wfh' in allowedWorkLocations`.
- Under `wfhMode='self_declare'`, the employee can set it
  directly via `PUT /api/presence/me/work-location`.
- Under `wfhMode='approval_required'`, the employee submits
  a `WorkLocationRequest` and an authorised human
  (`PRESENCE_WORK_MODE_REVIEW`) decides. Pending does NOT
  apply.
- Under `wfhMode='disabled'`, neither path is available.

Approved WFH is presentation-only. It does NOT check the
employee in.

## 8. WFH WORKFLOW

```
Employee A           WorkLocationRequest         Manager / HR
─────────            ───────────────────         ─────────────
PUT /me/work-location (wfh)
  if wfhMode=approval_required:
    -> 400 WORK_LOCATION_REQUIRES_APPROVAL
  if wfhMode=disabled:
    -> 400 WFH_DISABLED
POST /work-location-requests
  -> status: PENDING
  -> notification: reviewer (in-app, NOT email)
                                          GET /work-location-requests/pending
                                          POST /work-location-requests/:id/approve
                                            -> status: APPROVED
                                            -> effective on applicableDate
                                          POST /work-location-requests/:id/reject
                                            -> status: REJECTED
                                            -> decisionNote
```

Auto-approval is forbidden. No code path in 37.5 / 37.7
approves a WFH based on green presence, attendance, shift,
role, browser activity, AI, notification, or realtime event.

## 9. LEAVE PRIVACY

The presence integration reads ONLY:

```js
{
  _id, user, startDate, endDate, status, companyId
}
```

It deliberately does NOT read `reason`, `type`, `medical`,
`attachments`, `document`, `approver`, `approverNote`,
`decidedAt`, `balance`, `quota`, `remaining`, `used`, or
`accrued`. The projection is hard-coded in
`services/presence/presenceHrContext.js`. A test source-pin
asserts the absence of every forbidden word in that file.

## 10. REDIS / REALTIME BEHAVIOR

- The live store uses Redis (when `REDIS_ENABLED=true`):
  - `crewly:<env>:presence:conn:<companyId>:<userId>` — SADD/SREM/SISMEMBER
  - `crewly:<env>:presence:live:<companyId>:<userId>` — hash with `lastHeartbeatAt`, `lastActivityAt`
  - `crewly:<env>:presence:bus` — pub/sub channel for cross-instance fan-out
- The Socket.IO namespace is `/presence`. CORS / origin rules
  are the same as the chat socket.
- The `attach(server)` line in `server.js` is **deliberately
  commented out** by `db177d9` to prevent the slow-start
  regression. The HTTP REST endpoints do not depend on it.
- When `REDIS_ENABLED=false` or Redis is unreachable, the
  resolver returns `Unknown`, not `Offline`.

## 11. OFFLINE vs UNKNOWN

| Value | Meaning | When |
|-------|---------|------|
| `offline` | The live infrastructure established NO qualifying live connection. | `connectionCount === 0` AND no recent heartbeat. |
| `unknown` | The live infrastructure could not RELIABLY determine state. | Redis down, or no live source provided to the resolver. |

A Redis outage must NOT cascade to `offline` for every user.
Test #28 (closeout) pins the resolver output shape.

## 12. PERFORMANCE LESSONS (actually incurred)

- **`db177d9`** — the `presenceSocket.attach(server)` line
  was the cause of the slow-start on the user's local dev
  machine. Fix: keep the line commented out; require an
  operator to opt in via `PRESENCE_SOCKET_ENABLED=true`.
- **`a72fee3`** — a duplicate `server.listen(` was left in
  place by an over-aggressive edit. Lesson: when an edit has
  BOTH a removal AND an insertion, the removal must be
  precise; verify with `grep -n server.listen src/server.js`.
- **37.2** — the `topbar PresenceMenu` does NOT start the
  socket on auth. It reads on demand. This keeps the
  authenticated home page cheap.
- **37.6** — the team path does a SINGLE batched Leave read
  + a `whCache` map for per-user working-hours context.
  No N+1.
- **37.7** — the admin page sends a per-field diff to
  `PUT /api/presence/config`, not the full form. This
  prevents the Phase 36 "save one field, overwrite the
  rest" bug.

## 13. FOLDER STRUCTURE (do NOT reorganise)

- `Backend/src/services/presence/`
- `Backend/src/controllers/presence/`
- `Backend/src/routes/presence/`
- `Backend/src/validators/presence/`
- `Backend/src/models/{UserPresence,PresenceTenantConfig,WorkLocationRequest}.js`
- `Backend/src/socket/{presenceSocket,presenceSocketConfig,presenceSocketHandlers}.js`
- `Backend/src/utils/presenceKeys.js`
- `Frontend/src/components/presence/`
- `Frontend/src/pages/presence/`
- `Frontend/src/pages/team/`
- `Frontend/src/pages/settings/presence/`
- `Frontend/src/redux/slices/{presenceSlice,presenceConstants}.js`
- `Frontend/src/services/presence/`
- `Frontend/src/services/presenceService.js`
- `Frontend/src/services/realtime/{presenceChannel,presenceRuntime}.js`

## 14. ENVIRONMENT REQUIREMENTS

**37.7 introduces no new env vars.** The existing Phase 37
infra that re-uses env vars:

- `REDIS_URL` — the live store. When unset / disabled, the
  resolver returns `Unknown`.
- `REDIS_ENABLED` — master switch for the Redis-dependent
  realtime path.
- `PRESENCE_SOCKET_ENABLED` — opt-in for the Socket.IO
  namespace attach. When `true`, `REDIS_ENABLED=true` and
  `REDIS_URL` must be set. When `false` (default), the
  socket is never attached and the HTTP REST endpoints are
  the only path.

The repo's `.env.example` already documents these.

## 15. TESTS

- `Backend/test/presenceFoundation.test.js` — 58 cases
- `Backend/test/presenceBoundaries.test.js` — 65 cases
- `Backend/test/presenceBus.test.js` — 15 cases
- `Backend/test/presenceLiveStore.test.js` — 25 cases
- `Backend/test/presenceRealtime.test.js` — 20 cases
- `Backend/test/presenceSocket.test.js` — 11 cases
- `Backend/test/presenceTeamService.test.js` — 49 cases
- `Backend/test/presenceHrIntegration.test.js` — 53 cases
- `Backend/test/workLocationRequests.test.js` — 24 cases
- `Backend/test/attendanceWorkModeRequests.test.js` — 26 cases
- `Backend/test/presenceCloseout.test.js` — 30 cases (37.7)
- `Frontend/test/presenceHrFrontend.test.js` — 18 cases (37.6)
- `Frontend/test/presenceSettings.test.js` — 25 cases (37.7)

(Totals at 37.7 closeout: **376/376 backend Phase 37**, **68/68
frontend Phase 37**.)

## 16. OPERATIONAL PITFALLS (actually encountered)

- **Phase 36 paid for a "loading=true that never clears" bug.**
  37.7's admin page replicates the FIX (load() owns the
  loading flag, mount effect calls load() not read()), and
  pins the pattern in `presenceSettings.test.js #21`.
- **Phase 36 paid for a "save one field, overwrite the rest"
  bug.** 37.7's admin page sends a per-field diff. Pinned in
  test #18.
- **Phase 36 paid for a `useBlocker` that silently fails
  under BrowserRouter.** 37.7 uses `beforeunload` only.
  Pinned in test #20.
- **37.4 paid for the slow-start on the user's machine.**
  37.7 keeps the `attach` line commented out. Pinned in
  Incident 2 of the runbook.
- **37.6 paid for a "NATS has been added" assumption that
  was NOT in the repo.** 37.6 + 37.7 keep the no-NATS
  invariant. Pinned in the source-pin tests.

---

## NEXT UNIT (separately approved)

**Phase 37.8 — Multi-Instance Realtime Hardening**

Scope: ensure that a presence event on instance X is
delivered to a tab on instance Y without an HTTP refresh.
This requires either (a) the existing Socket.IO Redis
adapter wired and the `attach` line un-commented by
default, OR (b) a separately approved cross-instance
transport (e.g. NATS). Whichever path is chosen, the perf
stop-gate from `db177d9` must remain green.

NOT IMPLEMENTED IN 37.7.
