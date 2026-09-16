# Phase 31.3 — What was built and how to test it

Windows PowerShell commands throughout.

---

# PART 1 — What has been implemented

## Office locations & geofence (new)

| Area | Shipped |
|---|---|
| Models | `AttendanceLocation` (tenant-scoped, zero middleware); `AttendanceEvent` gains optional `locationVerification` subdoc |
| Rules | Pure `attendanceLocationRules.js`: coordinate/radius bounds, Haversine, inclusive boundary, 3×5 enforcement matrix, snapshot builder |
| Service | `attendanceLocationService.js`: CRUD + `verifyClockInLocation` (refusals throw pre-write); event service gates CLOCK_IN before any write |
| API | `/api/attendance/locations` CRUD + `activate/deactivate` + self-service `/eligible`; events accept `locationId` + `position`, refuse client verdicts |
| RBAC | `ATTENDANCE_LOCATION_READ` / `ATTENDANCE_LOCATION_MANAGE`, catalog v28; HR + Admin grants, employees neither |
| UI | Policy page Office-locations section; My Attendance picker + one-shot verification + employee-safe notes |
| Tests | `test/attendanceLocations.test.js`, 37 hermetic tests, registered in `test:all` |

## Untouched (verify still green)

Classic punch-in shape, punch-out, `today/my/company/report` APIs +
report page, Shift, Work Schedule, Leave, Holiday, dashboard widgets,
Payroll 29.x/29.5 (`lopSource='ATTENDANCE'` contract), 31.1 policy dials,
31.2 suite frozen at 47/47. No migration.

---

# PART 2 — Backend verification

```powershell
cd Backend

$env:MONGO_URI='mongodb://127.0.0.1:27017/crewly_test'
node --test test/attendanceLocations.test.js  # expect: 37 pass, 0 fail
node --test test/attendanceEvents.test.js     # expect: 47 pass, 0 fail (frozen)
node --test test/attendancePolicy.test.js     # expect: 34 pass, 0 fail
npm run test:all                              # expect: 900 pass, 11 env-blocked, 0 real failures
```

The 11 `test:all` failures are the pre-existing MONGO_URI-blocked DB
suites (analytics, bgv×6, emailDelivery, fnf, payslip, phase30Security)
— identical before and after 31.3.

---

# PART 3 — Manual UI verification (localhost)

1. As HR: open the Attendance Policy page → Office locations → add an
   office (name HQ, your coordinates, radius 200) → row appears.
2. Set enforcement REQUIRED, save draft, activate.
3. As the employee (`/app/attendance`): select OFFICE → picker appears →
   Clock In → browser asks for location once → `Verified at HQ`.
4. REQUIRED refusal: pick HQ but deny the browser permission → clear
   error, no clock-in written (card still shows Clock In).
5. Deactivate HQ → employee sees "no active locations"; REQUIRED clock-in
   refused until reactivated.
6. Set enforcement DISABLED → picker disappears; clock-in works exactly
   as in 31.2.
