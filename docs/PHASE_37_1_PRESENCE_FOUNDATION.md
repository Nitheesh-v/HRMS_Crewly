# Phase 37.1 — Presence Foundation

> Read this before touching `Backend/src/services/presence/`,
> `Backend/src/models/{PresenceTenantConfig,UserPresence}.js`,
> `Backend/src/validators/presence/`,
> `Backend/src/controllers/presenceController.js`,
> `Backend/src/routes/presence.js`, or `Backend/test/presenceFoundation.test.js`.

Phase 37.1 is the **backend foundation** of the HR Workforce Presence,
Availability & Work Location system. It introduces a single set of
endpoints that every later Phase 37 unit builds on:

- the per-tenant policy model
- the per-user durable preferences model
- the ONE backend authority for effective presence
- self-service presence / status-message / work-location mutations
- admin tenant-config endpoints

It is **strictly backend + minimal frontend prep**. No widget. No sidebar.
No realtime. No WFH approval workflow. No leave / shift derived state.
No admin settings UI. No AI modifications.

---

## 1. The domain vocabulary

```
PRESENCE_MANUAL_VALUES       available · busy · dnd
PRESENCE_DERIVED_VALUES      away · offline · on_leave · outside_working_hours · unknown
WORK_LOCATION_VALUES         office · wfh · remote
WFH_MODES                    self_declare · approval_required · disabled
STATUS_MESSAGE_MAX_CHARS     160
EXPIRY_MAX_DAYS              7
PRESENCE_TENANT_DEFAULTS     enabled=true, statusMessagesEnabled=true,
                             workLocationEnabled=true, wfhMode=self_declare,
                             awayAfterMinutes=5, offlineAfterMinutes=15,
                             lastSeenVisible=false,
                             allowedWorkLocations=[office,wfh,remote]
```

The single source of truth is `Backend/src/services/presence/presenceConfig.js`.
The model's enum, the validator's chain and the service's policy check all
read from it.

---

## 2. The API surface

| Verb | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET`  | `/api/presence/me`                    | any user                    | resolve the caller's normalised state |
| `PUT`  | `/api/presence/me/status`             | any user                    | set manual Available/Busy/DND with optional expiry, or clear |
| `PUT`  | `/api/presence/me/status-message`     | any user                    | set a short plain-text message with optional expiry, or clear |
| `PUT`  | `/api/presence/me/work-location`      | any user                    | set Office/WFH/Remote with optional expiry, or clear |
| `GET`  | `/api/presence/config`                | `SETTINGS_MANAGE`           | read the tenant policy |
| `PUT`  | `/api/presence/config`                | `SETTINGS_MANAGE`           | write the tenant policy |

### Request shapes

`PUT /me/status`
```json
{ "status": "busy", "expiresAt": "2026-06-15T10:00:00.000Z" }
```
`{ "status": null }` is the explicit clear shape; `expiresAt` MUST NOT be
sent alongside it.

`PUT /me/status-message`
```json
{ "message": "Client call until 3 PM", "expiresAt": "2026-06-15T10:00:00.000Z" }
```
`{ "message": "" }` is the clear shape.

`PUT /me/work-location`
```json
{ "location": "office", "expiresAt": "2026-06-15T18:30:00.000Z" }
```
`{ "location": null }` is the clear shape.

### Response shape

```json
{
  "success": true,
  "message": "Presence resolved",
  "data": {
    "presence": "busy",
    "presenceSource": "manual",
    "manualStatus": "busy",
    "manualStatusExpiresAt": "2026-06-15T10:00:00.000Z",
    "statusMessage": "Client call until 3 PM",
    "statusMessageExpiresAt": null,
    "statusMessageEnabled": true,
    "workLocation": "office",
    "workLocationExpiresAt": null,
    "workLocationEnabled": true,
    "allowedWorkLocations": ["office", "wfh", "remote"],
    "wfhMode": "self_declare",
    "livePresenceAvailable": false,
    "config": { ... }
  }
}
```

`livePresenceAvailable` is `false` in 37.1 because Phase 37.4 (realtime)
has not shipped yet. **It is never `true` here.** The UI MUST render
honestly: when manual is absent and `livePresenceAvailable` is `false`,
the user-facing label is "Presence unavailable", not "Offline".

### Error codes (presence-specific, NEVER reuse Phase 36 AI codes)

| Code | Status | Meaning |
| --- | --- | --- |
| `INVALID_PRESENCE_VALUE` | 400 | status wasn't one of available/busy/dnd/null |
| `INVALID_WORK_LOCATION` | 400/403 | not a platform value, or not in tenant allowlist |
| `INVALID_WFH_MODE` | 400 | not in self_declare / approval_required / disabled |
| `INVALID_TIMEOUT_RELATIONSHIP` | 400 | offlineAfterMinutes <= awayAfterMinutes |
| `INVALID_ALLOWED_WORK_LOCATIONS` | 400 | duplicates / empty / wrong values |
| `STATUS_MESSAGE_TOO_LONG` | 400 | message > 160 chars |
| `STATUS_MESSAGE_EMPTY_AFTER_TRIM` | 400 | whitespace-only message |
| `EXPIRY_IN_PAST` | 400 | expiresAt <= now |
| `EXPIRY_TOO_FAR` | 400 | expiresAt more than 7 days from now |
| `PRESENCE_DISABLED` | 403 | tenant presence is off |
| `STATUS_MESSAGES_DISABLED` | 403 | tenant turned off status messages |
| `WORK_LOCATION_DISABLED` | 403 | tenant turned off work location |
| `WFH_DISABLED` | 403 | tenant WFH mode = disabled |
| `WFH_APPROVAL_REQUIRED` | 409 | tenant WFH mode = approval_required (37.5 owns that) |
| `PRESENCE_TENANT_CONFIG_READ_FAILED` | 503 | config read threw |

---

## 3. The ONE resolver

`Backend/src/services/presence/presenceResolver.js` is the only module
allowed to produce an effective-presence value. The precedence added by 37.1
is:

```
manual DND or Busy or Available, not expired -> that value
no manual, no live                           -> unknown
```

`unknown` is **not** `Offline`. Phase 37.4 will add automatic Away /
Offline; Phase 37.6 will add derived On Leave / Outside Working Hours.
Each later unit adds ONE input to the resolver without touching
controllers.

---

## 4. The hard HR boundaries (Phase 37 §13 / §14 / §15)

Pinned by a source-grep test (`presence source guarantees`):

- `presenceResolver.js` MUST NOT import `Attendance`, `AttendanceEvent`,
  `Leave`, `Payroll`, `PayrollResult`, `Payslip`, `ShiftAssignment`,
  `Shift`, or any `services/attendance`, `services/payroll`,
  `services/chat` module.
- `presenceService.js` MUST NOT call attendance / payroll mutation
  functions.
- No `PresenceHistory` / `ActivityHistory` / `EmployeeActivity` model
  exists or may be created. Presence is current state, not a
  surveillance timeline.
- WFH MUST NOT create Leave. Setting `workLocation: 'wfh'` MUST NOT
  call any attendance / payroll / leave mutation service.
- No status mutation may check an employee in or out.

---

## 5. Identity & tenancy

`req.companyId` and `req.user._id` are authoritative. The validator
refuses `companyId`, `company`, `userId`, `user`, `employeeId`,
`employee` from a body OR query. Every service lookup keys on
`companyId + userId` (or `companyId` alone for tenant config). No
authorization is implied by Mongo ObjectId possession.

---

## 6. Caching

Phase 37.1 does not cache. The first read of `PresenceTenantConfig` does
an upsert with `setDefaultsOnInsert: true`, so the defaults appear on
the row the first time without a separate seed migration. Phase 37.4
may add Redis caching for the per-user realtime path; the cache key
namespaces are reserved in `presenceConfig.js` so the same names exist
when 37.4 is implemented.

---

## 7. The 50+ §28 / §29 guarantees

Pinned by `Backend/test/presenceFoundation.test.js`. Every numbered
clause from §28 / §29 maps to one or more `test(...)` blocks. The
source-grep guarantees in §3 / §7 / §21 are pinned by the
`presence source guarantees` suite with comment-stripping so the
test code's own comments don't satisfy the pin.

---

## 8. How to verify

```powershell
cd Backend
npm run test:presence
```

Expected:
```
# tests 58
# suites 6
# pass 58
# fail 0
```

Phase 36 regressions (must still all pass):

```powershell
npm run test:ai-foundation
npm run test:ai-tenant-config
npm run test:ai-context
npm run test:ai-chatbot
npm run test:ai-own-records
node --test test/phase36Closeout.test.js
```

---

## 9. Localhost acceptance

See the companion `docs/PHASE_37_RUNBOOKS.md` section "Phase 37.1
Acceptance" for the exact PowerShell commands.