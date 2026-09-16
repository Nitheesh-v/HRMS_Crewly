# Phase 31.3 — Office Locations & Geofenced Attendance

CLOCK_IN-only OFFICE geofence on top of the 31.1 policy engine and the
31.2 immutable event ledger. Strict REQUIRED refusal, no continuous
tracking, no stored employee coordinates.

---

## 1. Goal

Let a company define office premises (name + coordinates + radius) so an
OFFICE clock-in can be **verified** against the chosen office. Everything
else stays exactly as it was: WFH/Field/Client-site/Travel clock-ins,
breaks, clock-out, history, policy UI and Payroll 29.x/29.5 are untouched.

## 2. Scope (binding)

- Geofence binds **CLOCK_IN + OFFICE only**. The 31.1 `locationEnforcement`
  dial (`DISABLED` / `OPTIONAL` / `REQUIRED`) is the only policy surface;
  no new policy fields.
- `REQUIRED` + missing/outside/inactive/foreign location ⇒ clock-in is
  **refused** (400/403/404, nothing written). There is no
  proceed-unverified variant under REQUIRED.
- `OPTIONAL` never blocks: verifies when a valid pick + position is
  supplied, records `OUTSIDE` when outside, no snapshot when omitted.
- `DISABLED` (31.1 default) discards any supplied facts — the 31.2
  byte-shape is preserved.
- No surveillance: one-shot `getCurrentPosition` inside the explicit
  Clock-In click only; no `watchPosition`, no idle scoring, no tracking.
- Raw employee coordinates are measured and **discarded**: they appear in
  no document, no log, no audit, no Redis key. The snapshot stores rule
  facts (`locationId/name`, `radiusMeters`, `distanceMeters`, `result`,
  `accuracyMeters`, `verifiedAt`) only.

## 3. Data model

- New `AttendanceLocation` (tenant-scoped, `{ companyId: 1, isActive: 1 }`,
  **zero middleware**): `name`, `code?`, `displayAddress?`, `latitude`
  (±90), `longitude` (±180), `radiusMeters` (int 10…100000), `isActive`.
- `AttendanceEvent` gains an additive optional `locationVerification`
  subdoc (same six snapshot fields). 31.2 immutability hooks unchanged.
- No DELETE endpoint: locations are deactivated so history stays
  interpretable. Outside radius is stored as compact `result: 'OUTSIDE'`.

## 4. Backend

- `attendanceLocationRules.js` (pure): coordinate/radius/accuracy bounds,
  Haversine (integer meters, backend-computed — client distance is never
  trusted), inclusive `distance ≤ radius`, the 3×5 enforcement matrix,
  snapshot builder.
- `attendanceLocationService.js` (CRUD + `verifyClockInLocation`):
  tenant-scoped everywhere, foreign/inactive lookups by store id throw
  (never silently ignored), audited CREATED/UPDATED/ACTIVATED/DEACTIVATED.
  No cache, no BullMQ, no new dependencies. Injectable model + audit.
- `attendanceEventService.js`: the gate runs inside `clockIn` **after**
  work-mode checks, **before** any `Attendance` read/create — a refusal
  writes nothing. Serialization carries `event.location` (or `null`) plus
  `snapshot.locationEnforcement` for the employee UI.
- RBAC: `ATTENDANCE_LOCATION_READ` + `ATTENDANCE_LOCATION_MANAGE`
  (HR_MANAGER/Company Admin/Super Admin default grants; employees get
  neither). Permission catalog **v27 → v28**.
- API (mounted `/api/attendance/locations`, before the generic router):
  `GET /`, `POST /`, `GET /eligible` (self-service picker fields only:
  `id/name/code/displayAddress`), `GET /:locationId`, `PUT /:locationId`,
  `POST /:locationId/activate|deactivate`. Client `location` object,
  `insideGeofence` and `distanceMeters` verdicts are refused by the event
  validator.

## 5. Frontend

- `attendanceLocationService.js`: thin wrapper, same envelope pattern.
- Policy page gains an **Office locations** section (MapPin): list with
  radius + active state, create/edit form, activate/deactivate, and a
  REQUIRED-with-zero-active warning banner. The `(future)` label on the
  enforcement dial is retired.
- My Attendance: when enforcement is REQUIRED/OPTIONAL and OFFICE is
  selected, a location picker appears; Clock In samples the browser
  position one-shot inside the busy-guarded click. REQUIRED gaps abort
  with employee-safe copy and post nothing; OPTIONAL degrades to
  unverified. Server verdicts surface as `Verified at X` / `Outside the
  X radius` / `Clocked in without location verification`.

## 6. Tests

`Backend/test/attendanceLocations.test.js` — 37 hermetic tests (no
Mongo/Redis/network): 10 pure rules, 8 location service, 1 RBAC, 15
CLOCK_IN integration (incl. refusal-writes-nothing, snapshot replay,
no-coordinate-retention, independence of backend measurement), 3 event
validator. Registered in `test:all`. The 31.2 suite is frozen (47/47).
