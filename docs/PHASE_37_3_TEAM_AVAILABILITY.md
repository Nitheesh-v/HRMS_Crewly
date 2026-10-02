# Phase 37.3 — Team Availability

> Phase 37 — Presence. Phase 37.1 — durable self-presence + tenant config.
> Phase 37.2 — self-presence UI (header popover). Phase 37.3 — team
> availability read view.

## 1. Scope

A senior role (COMPANY_ADMIN / HR_MANAGER / MANAGER / TEAM_LEAD) opens the
Team Availability page from the sidebar and sees a paginated, filterable
list of their colleagues' effective presence and work location.

Phase 37.3 does NOT introduce a new visibility rule. The page consumes the
existing `utils/scope.js` authority — the same helper the existing
`GET /users` endpoint uses. Phase 37.3 only adds a read window on top of
presence that the server already knows about.

## 2. What ships

- `Backend/src/services/presence/presenceTeamService.js`
- `Backend/src/validators/presence/teamAvailabilityValidator.js`
- `Backend/test/presenceTeamService.test.js` (47 §40 assertions)
- `Frontend/src/pages/team/TeamAvailabilityPage.jsx`
- `Frontend/test/teamAvailability.test.js` (24 §41 assertions)
- extensions to `presenceController.js`, `routes/presence.js`,
  `services/presenceService.js`, `redux/slices/presenceSlice.js`,
  `routes/AppRoutes.jsx`, `layout/AppLayout.jsx`
- controller fix: replace `import presenceServiceFactory from '...'` with
  `import { presenceService } from '...'` (the file's default export is
  the instance, not the factory; the bug crashed localhost on first call).

## 3. The read-only contract

`GET /api/presence/team` accepts:

| Query         | Type   | Notes                                            |
| ------------- | ------ | ----------------------------------------------- |
| `search`      | string | ≤ 60 chars; name / employeeCode / designation   |
| `presence`    | string | `available` / `busy` / `dnd` / `unknown`       |
| `workLocation`| string | `office` / `wfh` / `remote`                     |
| `page`        | int ≥ 1 | default 1                                       |
| `limit`       | 1–100  | default 25                                      |

`companyId` / `userId` / `employeeId` / `company` / `user` / `employee`
in the query are refused by the validator (Phase 37 §19). The page never
sends them.

Response:

```json
{
  "items": [
    {
      "id": "u-abc",
      "name": "Alice",
      "employeeCode": "E001",
      "designation": "Eng",
      "avatarUrl": "...",
      "department": { "id": "d-eng", "name": "Eng" },
      "role": "EMPLOYEE",
      "presence": "busy",
      "workLocation": "wfh",
      "statusMessage": "in deep work",
      ...
    }
  ],
  "summary": {
    "total": 2,
    "byPresence":   { "available": 1, "busy": 1, "dnd": 0, "unknown": 0 },
    "byWorkLocation": { "office": 1, "wfh": 1, "remote": 0 }
  },
  "meta": {
    "page": 1, "pageSize": 25, "pages": 1,
    "totalPages": 1, "totalItems": 2, "total": 2, "limit": 25
  },
  "config": {
    "enabled": true,
    "statusMessagesEnabled": true,
    "workLocationEnabled": true,
    "employeePresenceVisible": true
  }
}
```

No `password` / `email` / `phone` / `salary` / `Aadhaar` / `PAN` / `UAN` /
`bankAccount` / `deductions` ever appears in the response.

## 4. Authorisation

The endpoint reuses `utils/scope.js#getScopedUserIds`:

| Role           | Visibility                                                   |
| --------------- | ----------------------------------------------------------- |
| EMPLOYEE        | [self]                                                      |
| TEAM_LEAD      | self + direct reports                                       |
| MANAGER       | everyone in the manager's department                        |
| COMPANY_ADMIN | every employee in the company                                 |
| HR_MANAGER    | every employee in the company                                 |

The frontend wraps the route in `RequireRole roles={SENIORS}`:

```js
const SENIORS = ["COMPANY_ADMIN", "HR_MANAGER", "MANAGER", "TEAM_LEAD"];
```

A user without ATTENDANCE_READ cannot see the sidebar entry. A user who
hits the API directly with EMPLOYEE credentials gets [self].

## 5. Pipeline

```
scope → user baseFilter (ACTIVE) → search filter (optional)
       → ONE batched UserPresence.find({ companyId, userId: { $in } })
       → resolvePresence for each row (37.1 authority)
       → in-memory filter (presence / workLocation)
       → compute summary counts from the post-filter rowset
       → paginate
       → 200 OK
```

The user list is fetched with explicit DTO projection and
`.populate('department', 'name')`. The presence read is batched — one
`find()` per request. There are NO MongoDB writes.

## 6. UNKNOWN ≠ OFFLINE

When a teammate has no live signal AND no manual status, the resolver
returns `presence: 'unknown'`. The page renders that with the same
"Presence unavailable" copy used elsewhere. Phase 37 §20 is preserved.

## 7. WFH in the team view

WFH appears as a work-location chip and a column in the table. The page
does NOT offer a WFH approval workflow (Phase 37.4 territory). A tenant
with `wfhMode: 'approval_required'` simply shows WFH rows that the
caller's colleagues have self-declared; the page does not refuse WFH.

## 8. What 37.3 does NOT do

- No presence history collection (Phase 37 §28).
- No realtime updates. The page refetches on filter / page changes; it
  does not subscribe to a socket / NATS / SSE / webhook (Phase 37 §29).
- No AI surface changes. The page never imports an AI service, never
  reads from `hrContextRetriever`, never calls a presence-change reasoning.
- No new permission keys. Reuses the ATTENDANCE_READ sidebar gate and
  the SENIORS route gate.
- No localStorage / sessionStorage persistence.
- No mutation endpoints. The page is strictly read.

## 9. Tests

- `Backend/test/presenceTeamService.test.js` — 47 hermetic assertions.
- `Frontend/test/teamAvailability.test.js` — 24 source-pin assertions.
- 37.1 (`presenceFoundation.test.js`) still 58/58 green.

## 10. Run locally

1. Start Mongo.
2. `cd Backend && npm run dev`.
3. `cd Frontend && npm run dev`.
4. Log in as MANAGER / HR_MANAGER / COMPANY_ADMIN / TEAM_LEAD.
5. Open `/app/team/availability`.