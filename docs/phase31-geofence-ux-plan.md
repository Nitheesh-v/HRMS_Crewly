# Phase 31 — Geofence UX Improvement — Implementation Plan (ONE-SHOT)

**Repo-first inspection (2026-09-19)**
- Backend model `AttendanceLocation` (companyId, name, code, displayAddress, latitude, longitude, radiusMeters, isActive) — no hooks, tenant-scoped.
- Service `attendanceLocationService` CRUD + `verifyClockInLocation` (injectable model, Haversine, accuracy gating). Backend computes `distanceMeters` & `VERIFIED|OUTSIDE`; frontend cannot send `distance/insideGeofence`.
- Validators `attendanceLocationValidator` structural only; business bounds in `attendanceLocationRules` (lat -90..90, lng -180..180, radius 10..100000 int). No geocoding, no maps.
- Frontend admin UI embedded in `AttendancePolicyPage.jsx` → Office locations section (grid Name/Code/Address/Lat/Lng/Radius + Save). No Use Current Location.
- Employee flow `AttendancePage.jsx` → `readSinglePosition()` → `getCurrentPosition` one-shot, never `watchPosition`; location payload sent only on `CLOCK_IN` and verified backend-side.
- Routes `/api/attendance/locations` protected `ATTENDANCE_LOCATION_MANAGE`.

**Goal**
Make workplace setup simple: Admin taps Use Current Location → coordinates auto-fill, radius reviewed → Save. Keep manual entry for remote config.

**Scope — single frontend change, no backend duplication**
- UPDATED: `Frontend/src/pages/attendance/AttendancePolicyPage.jsx` only. Reuse existing `attendanceLocationService.create/update` + validators.
- No new model/route, no new API, no maps package.

**Admin UX (inside Office locations form)**
1. Fields order: Name → Address → [Use Current Location] → auto-filled lat/lng preview → Radius → Save.
2. Button `Use Current Location` → explicit click → `navigator.geolocation.getCurrentPosition({timeout:10000, maximumAge:0})` one-shot. Never `watchPosition`, never on page load.
3. States: idle → `Getting your location…` (disabled) → success `Location captured` with `Lat 12.971600, Lng 77.594600` + optional `Accuracy: approximately 25 m` (if `accuracy` finite). Errors show inline red card.
4. Error mapping: `code 1` → "Location permission was denied. Allow location access in your browser or enter the office coordinates manually." ; `code 2` → "Location unavailable…"; `code 3` → "Location request timed out…"; `navigator.geolocation` missing or `!isSecureContext` → "Location requires HTTPS or localhost…"; invalid lat/lng → validator messages.
5. After success, lat/lng state updated; Advanced `<details>` collapsed by default contains manual lat/lng inputs with same validation, so Chennai admin can configure Bengaluru remotely.

**Employee flow verification (no code change expected, audit only)**
- `AttendancePage.jsx` already one-shot; confirm no coordinate inputs exposed, backend remains authoritative. If any stray manual coordinate UI exists, hide it.

**Security invariants preserved**
- Haversine + `isInsideGeofence` server-only; tenant ownership enforced; no BullMQ coordinates; no continuous GPS; no WFH home tracking; no cross-tenant.

**Localhost note**
- In `AttendancePolicyPage` help text: "Chrome DevTools → Sensors is only for dev testing of inside/outside. Production employees grant permission once via browser/OS."

**Tests**
- Manual: Use Current Location success → coords populate; deny → denied message + manual fallback; unavailable/timeout → messages; invalid coords refused by existing validator; employee Clock In no manual fields; no `watchPosition` in codebase; `npm run build` + relevant `attendanceLocations.test.js`/`attendancePresence`.

**Handoff files**
- CREATED: none; UPDATED: `AttendancePolicyPage.jsx`; docs plan file; optionally `style.css` tiny tweak if needed.
