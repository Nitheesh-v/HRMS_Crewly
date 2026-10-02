# Phase 37 — Workforce Presence, Availability & Work Location

> **Workforce presence** in a Teams-style "who's around" surface that is
> clearly separated from attendance, leave, payroll and AI. Strictly
> HR-presence, not Microsoft Teams / Graph / Azure integration. The
> full overview lives in this folder's larger doc-set; the
> implementation record for each unit is the per-unit file below.

## Unit map (and what's in / out per unit)

| Unit | Scope | In | Out |
|---|---|---|---|
| **37.1** | Foundation | presence config + tenant-config + user-prefs models; self APIs (status / message / work-location); admin config APIs; ONE backend resolver; service / validators / controller; 60+ hermetic tests | realtime · team availability · WFH approval · leave/shift integration · admin UI |
| **37.2** | Self UX | header presence indicator + menu; status / message / work-location popovers; WFH policy UX; responsive + a11y; one frontend service + slice + tests | realtime · team availability · WFH approval · leave/shift integration · admin UI |
| 37.3 | Team availability | team / company views according to existing auth, search + filters, privacy-safe serialisation | realtime · WFH approval · admin UI |
| 37.4 | Realtime | Socket.IO authenticated presence channel · heartbeat / TTL · automatic Away / Offline · tenant-scoped broadcasts · Redis-failure → Unknown | WFH approval · admin UI |
| 37.5 | WFH approval | request → approve / reject · audit · notifications · policy-aware UX | realtime live · admin UI |
| 37.6 | Leave / shift derived | approved active leave → On Leave · shift / working-hours → Outside Working Hours · timezone-correct day boundaries · privacy by minimum | admin UI |
| 37.7 | Admin UI + closeout | presence config admin page · observability · runbooks · accessibility / perf verification | — |

## Standing laws (binding across every Phase 37 unit)

These are the Phase 37 invariants. They are NEVER relaxed by later
units. The implementation record for each unit pins its slice of them.

### Presence is NOT attendance
Available ≠ checked in. Away ≠ checked out. Offline ≠ absent.
WFH ≠ attendance completed. Browser activity ≠ working hours.

### WFH is NOT leave
Selecting WFH MUST NOT touch Leave, Payroll, Attendance, Shift or
any HR-authoritative state.

### Unknown is NOT Offline
Redis-down / realtime-unavailable returns `unknown`. 500 "Offline"
is a lie.

### One tenant authority
`req.companyId` and `req.user._id` only. The validator refuses
`companyId`, `company`, `userId`, `user`, `employeeId`, `employee`
from a request body. No authorization is implied by Mongo ObjectId
possession.

### No surveillance
No PresenceHistory / ActivityHistory / mouse / screenshot / GPS /
keystroke collection. Presence is current state.

### Phase 36 AI is untouched
Phase 37 may not add presence to the AI retriever, AI context
categories, AI prompts or AI languages. None of the Phase 36 AI files
imports any Phase 37 file; the source-grep tests pin this.

### Phase 33 Chat is untouched
Phase 37 must not introduce any of Phase 33's chat files. The
Phase 37 surfaces are their own.

## Reference documents

- **Phase 37 overview**: see this folder for the unit doc the owner
  attached to the Phase 37 prompt — the canonical product spec.
- **37.1 implementation record**: `PHASE_37_1_PRESENCE_FOUNDATION.md`
- **Phase 37 runbooks**: `PHASE_37_RUNBOOKS.md`

## How to verify Phase 37 as a whole

```powershell
cd Backend
npm run test:presence
# plus the per-unit script as each unit lands
node --test test/phase36Closeout.test.js
```

```powershell
cd Frontend
npm test
npm run build
npx eslint src
```