# Phase 31.1 — What was built and how to test it

Windows PowerShell commands throughout.

---

# PART 1 — What has been implemented

## Attendance Policy engine (new)

| Area | Shipped |
|---|---|
| Model | `AttendancePolicy` (company + DRAFT/ACTIVE/ARCHIVED, version, `configVersion`, 9 config sections) |
| Rules | Pure module: vocabularies, thresholds/grace/work-mode validation, classification bands, late/early/break/OT/missing-punch primitives, `evaluateDay`, lifecycle transitions, tenant-timezone day keys |
| Service | Current (cached), history (uncached), draft save (prefill-from-active, optimistic concurrency), activate (archive + promote), cache invalidation, audit |
| API | 4 routes at `/api/attendance/policy` |
| Permissions | `ATTENDANCE_POLICY_READ` / `_MANAGE` / `_ACTIVATE`; `SYSTEM_PERMISSION_VERSION = 27` |
| UI | `/app/attendance/policy` — status banner, 9-section setup form, activation, version history; read/manage/activate gating inside the page |
| Tests | `test/attendancePolicy.test.js`, 33 hermetic tests, registered in `test:all` |

## Untouched (verify still green)

Punch In–Out flow, `Attendance` model + history, Shift, Work
Schedule, Leave, Holiday, Payroll 29.x/29.5 (incl. the
`lopSource='ATTENDANCE'` contract). No migration shipped.

---

# PART 2 — Backend verification

```powershell
cd Backend

# New suite (hermetic: no Mongo, no Redis needed)
$env:MONGO_URI='mongodb://127.0.0.1:27017/crewly_test'
node --test test/attendancePolicy.test.js

# Full regression
$env:MONGO_URI='mongodb://127.0.0.1:27017/crewly_test'
npm run test:all

# Build-equivalent sanity: every touched file parses
node --check src/models/AttendancePolicy.js
node --check src/services/attendance/attendancePolicyRules.js
node --check src/services/attendance/attendancePolicyService.js
node --check src/validators/attendancePolicyValidator.js
node --check src/controllers/attendancePolicyController.js
node --check src/routes/attendancePolicyRoutes.js
```

Expected: 33/33 in the new suite; full `test:all` green.

---

# PART 3 — UI walkthrough (localhost)

```powershell
cd Frontend
npm run dev
```

1. Log in as **Company Admin** → sidebar shows **Attendance Policy**.
2. First visit: "No active policy" banner → the form is prefilled
   with canonical defaults, not blanks.
3. Tweak thresholds (e.g. half-day 200), **Save draft** → success
   toast, DRAFT badge, version history gains an entry.
4. **Activate policy** → confirm → ACTIVE badge, version 1.
5. Edit again, save, activate → history shows v2 ACTIVE + v1
   ARCHIVED with its original thresholds (no reinterpretation).
6. Log in as **HR Manager**: can view + save drafts, but the
   Activate button is hidden (no `ATTENDANCE_POLICY_ACTIVATE`).
7. Log in as **Employee**: no sidebar entry; direct URL shows the
   access-denied page.
8. Punch In–Out page: behaves exactly as before (no UI change).

---

# PART 4 — API spot checks (optional)

```powershell
# Needs a Company Admin JWT in $env:TOKEN
$h = @{ Authorization = "Bearer $env:TOKEN" }

Invoke-RestMethod http://localhost:5000/api/attendance/policy -Headers $h
Invoke-RestMethod 'http://localhost:5000/api/attendance/policy/history?limit=5' -Headers $h

$draft = @{ name='V1'; thresholds = @{ fullDayMinutes=480; halfDayMinutes=240 } } |
  ConvertTo-Json -Depth 4
Invoke-RestMethod http://localhost:5000/api/attendance/policy/draft -Method Post `
  -Headers ($h + @{'Content-Type'='application/json'}) -Body $draft

Invoke-RestMethod http://localhost:5000/api/attendance/policy/activate -Method Post -Headers $h
```

Stale-write check: save a draft twice with the same
`expectedConfigVersion` — the second returns **409**.
