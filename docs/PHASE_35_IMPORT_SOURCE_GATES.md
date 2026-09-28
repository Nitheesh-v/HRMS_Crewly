# Phase 35.8 — Live-punch gates must not apply to an imported row

**Status:** 35.8 implemented and verified locally — **awaiting localhost acceptance.**

35.7 made the import survivable: the 156-row file now runs to completion and reports every row.
The report that came back was therefore *informative*, not a lock:

> **Import result — 0 imported, 0 skipped, 156 rejected**
> every CLOCK_IN: *"Attendance location verification is required by company policy"*
> every CLOCK_OUT: *"No attendance session for that date"*

Two failures, one cause: **a CSV row cannot satisfy a live-punch gate.**

---

## 1. What was wrong

`clockIn` applies two gates that protect the *moment* of punching:

| Gate | Requires | A CSV row has |
| --- | --- | --- |
| **Geofence** (`locationEnforcement: REQUIRED`, OFFICE) | a position (latitude/longitude) from the device | nothing — a file export has no GPS |
| **Work-mode approval** (WFH/FIELD/… when the policy requires it) | an APPROVED request covering that day | nothing — the day is historical |

So with geofencing on, **every imported OFFICE clock-in was refused** — and because the clock-in is
what opens the session, every clock-out that followed failed too with *"No attendance session for
that date"*. That cascade is why the counts read 156 rejected: one gate, two messages.

## 2. The fix: the fact records the honest absence

An IMPORT row is exempt from both gates, and **nothing is faked in its place**:

```js
const importedRow = ingest?.source === EVENT_SOURCE.IMPORT;

const authorization = importedRow ? null : await findClockInAuthorization({ ... });
const verification  = importedRow ? { snapshot: null } : await verifyClockInLocation({ ... });
```

* `locationVerification` and `authorization` stay **absent** from the event — the engine never
  claims "VERIFIED" for something that was not verified;
* `provenance` still names the batch and the row's `sourceReference`, and the batch confirmation is
  audited, so the origin of every imported fact is traceable;
* the ingest context is **server-assembled** — a WEB punch cannot claim to be an import (pinned);
* **everything else still applies to imported rows**: the work mode must be enabled by policy
  (refused per row at preview), the day must be free, the month must not be finalized, and the
  session state machine decides every transition.

**Why this is not a policy hole.** The gate exists to stop an employee clocking in from anywhere;
it is not a statement about an HR admin backfilling a device export, which is the same class of
action as regularization (the documented correction path). Reaching the import endpoint already
requires `ATTENDANCE_CAPTURE_MANAGE`, and the import **cannot contradict recorded history**: the
planner refuses conflicting days and the per-row outcomes say exactly what was and was not accepted.

## 3. Files changed

* `Backend/src/services/attendance/attendanceEventService.js` — `importedRow` exemption for the
  geofence and work-mode-approval gates (documented in place).
* `Backend/test/attendanceImportIngest.test.js` — 4 new pins (21 total).
* this document.

## 4. Pins (and proof they bite)

* an imported OFFICE clock-in under a **REQUIRED** geofence policy is imported, and its event has
  **no** `locationVerification` key;
* an imported **WFH** clock-in under a policy that requires approval is imported, and its event has
  **no** `authorization` key;
* the same policy still **refuses** a self-service punch: OFFICE without a position
  (*"Attendance location verification is required by company policy"*) and WFH without an approved
  request (*"… request required for …"*), writing nothing;
* a punch that merely claims `source: 'WEB'` is not exempt (invalid ingest context).

**Bite check:** with the exemption reverted, pins 4 and 5 fail (the two imported cases) and the
live-path pins keep passing.

## 5. Real results

* `test:attendance-import-ingest` → **21/21**; the attendance engine and policy suites together
  (import, locations, work-mode requests, kiosk, QR, events, closeout) → **236/236**.
* `test:all` → **2693 tests / 98 suites / 0 fail**.
* Frontend build **✓ 1.41 s**; no frontend file changed this unit (eslint baseline 127 unchanged).

## 6. Limitations (honest)

* Imported punches carry **no location verification** and **no work-mode authorization**. If a
  company needs location evidence for a historical day, that data has to come from a source that
  has it (a kiosk bound to an office) or be corrected through regularization. This is a deliberate
  trade: the alternative is that no company with geofencing enabled can ever import its own device
  exports.
* The exemption is keyed on the **server-decided** `ingest.source === 'IMPORT'`. Kiosk and QR
  punches keep their own rules untouched.
* Nothing else about the import changed: rows are still validated per row (unknown/inactive
  employee, 12-month window, future timestamps, disabled work mode, finalized month, conflicts with
  recorded history), and the chunked/resumable behaviour from 35.7 is unchanged.

## 7. Localhost verification (PowerShell)

**Restart the backend** (the running process has the old code):

```powershell
cd Backend
npm run dev
```

```powershell
cd Frontend
npm run dev
```

1. Open **Attendance → Attendance Import**, choose `attendance-august-2026-emp001-emp003.csv`,
   **Preview** → 156 valid / 0 rejected.
2. Press **Confirm — import 156 rows**. The progress line counts up, and the result must now read
   **156 imported · 0 skipped · 0 rejected** — with the history row filled in place (it is the same
   batch, retried from scratch because it recorded nothing).
3. Open the **employee's August 2026** attendance / timesheet for EMP001, EMP002 and EMP003: every
   clock-in and clock-out from the file must be there, day by day.
4. Sanity check that the live gates are untouched: as an **employee**, try to clock in from the
   Attendance page with geofencing on and no position — it must still refuse with *"Attendance
   location verification is required by company policy"*.
5. Sanity check the honesty of the imported facts: the imported events show **no location
   verification** (they came from a file). That is intended and documented — not a missing step.

Sign-off line for the unit: **Phase 35.8 awaiting localhost acceptance.**
