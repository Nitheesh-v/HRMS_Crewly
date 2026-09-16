# Phase 31.6 — Shift / Roster Intelligence

Attendance stops guessing schedules. Every 31.x evaluation now resolves the
employee's roster for the business date (Shift assignment → department
assignment → shift doc → Work Schedule chain), frames the verdict on that
window with true wall-clock math, and versions the meaning onto the record —
so later Shift edits can never rewrite a closed day.

## 1. Goal

- One authoritative attendance-facing resolver (`resolveEmployeeSchedule`)
  that is DATED: each business date gets the assignment effective on it.
- Overnight correctness: a 00:30 arrival inside yesterday's 22:00–06:00
  window anchors to yesterday (the shift START date) at clock-in, on the
  today card, and in history.
- A payroll verdict from schedule + policy grace that replaces the
  UTC-anchored `evaluatePunch` in the 31.x path (the old quirk read a 09:05
  IST arrival as on-time and an on-time 18:00 out-punch as 330 early
  minutes — 31.6 corrects both).
- Honest UNRESOLVED: no roster, no fabrication — schedule-dependent flags
  stay neutral (PRESENT, zeros) instead of inventing a 09:00–18:00 day.

## 2. New modules (additive)

- `Backend/src/services/attendance/attendanceScheduleRules.js` — PURE:
  Intl-based `zonedTimeToUtc` (DST-aware, no fixed offsets),
  `shiftIntervalForDate` (overnight spans), `businessDateForInstant`
  (strict inclusive window, no invented grace), `deriveScheduleVerdict`
  (reuses the 31.1 `detectLate` / `detectEarlyOut` /
  `deriveOTEligibleMinutes` — zero duplicated math), `summarizeSchedule`.
  No models, no mongoose, no wall clock (static-guarded in tests).
- `Backend/src/services/attendance/attendanceScheduleService.js` —
  `resolveEmployeeSchedule` (dated chain with tenant re-checks on every
  followed pointer), `resolveStoredSchedule` (snapshot revival),
  `buildScheduleSnapshot` (persistence shape), `verdictInputsFromRule`
  (legacy rule framing), `deriveAttendanceVerdict` (the ONE verdict fn
  shared by live clock-in, live clock-out, and the 31.5 rebuild).
- `Backend/test/attendanceSchedule.test.js` — 26 hermetic tests.

## 3. Resolution order (engine parity, dated)

Employee assignment (window contains the date) → department assignment →
shift doc directly listing the employee/department → Work Schedule chain
(employee → department → branch → name:/general/i → oldest active).
Dead pointers (inactive / foreign-tenant / deleted targets) fall through
instead of resolving. The roster page and attendance now agree because
they walk the same order; 31.6 only adds dated correctness.

## 4. Business-date anchoring

Clock-in resolves the today + yesterday pair once and picks via the pure
`businessDateForInstant`: inside yesterday's overnight window → yesterday,
else the calendar day. The control, the event, the merge path, and the
31.4 authorization check all use the business date. An explicit `date`
param still bypasses attribution. `findOpenSession` continuity is
unchanged. The today card resolves the same pair for display, so at 01:00
it shows yesterday's window (`22:00 – 06:00 (+1 day)`).

## 5. Verdict (replaces `evaluatePunch` in the 31.x path)

`deriveAttendanceVerdict`: resolved context → evaluate against its
interval; legacy bare rule → frame on the business date; unresolved or
policy-less → neutral `{PRESENT, 0, 0, 0}`. `lateMinutes` stores the FULL
arrival delay (fact); `lateBeyondGrace` carries the policy excess for
display. Status: open day → LATE/PRESENT; closed day → HALF_DAY when
worked < minimum, else LATE/PRESENT. OT frames the 31.1 candidate only
(minimum + eligibility); approval/payability stays a later phase's job.
Clock-out recomputes the verdict, so a mid-day policy change applies at
each evaluation point instead of half the day going stale.

## 6. Snapshot versioning

Clock-in persists `scheduleSnapshot` + `scheduleStatus` on the Attendance
control (new additive fields; legacy rows stay snapshot-less and keep
evaluating through the legacy path). Clock-out and the 31.5 rebuild
prefer the stored snapshot over re-resolution; the rebuild versions a
snapshot-less control on first 31.6 evaluation but never overwrites an
existing one. `snapshot.schedule` gains the additive 31.6 context
(shift/schedule names, window label, instants, day type, holiday) —
legacy base fields are byte-identical otherwise.

## 7. Compatibility seams

- Classic punch controller + `/shifts/evaluate` untouched (still on
  `evaluatePunch`).
- Legacy-injected engines (anything but the real scheduleEngine fn, i.e.
  the 31.x hermetic suites' stubs) take the legacy engine seam: exact old
  resolver behavior including the `DEFAULT` fabrication — the only change
  they see is the verdict's UTC→day framing correction.
- No new RBAC, no new routes, no payroll/leave writes (static-guarded).

## 8. UI

- Today card: resolved roster line (shift name · overnight-aware window ·
  weekly-off/holiday note) before clock-in; compact `Shift …` line while
  working; `Scheduled …` line on completion.
- History: new `Scheduled` column from the versioned snapshot (`—` for
  legacy rows), shift name on hover.

## 9. Tests

26 new hermetic tests (pure rules incl. a DST proof, dated-chain beats
recency, tenant isolation, dead-pointer fall-through, round-trip
snapshots, live anchoring/verdict/snapshot-preference/neutrality/cover
re-check, 31.5 rebuild interplay, static guards). Two 31.5 assertions
updated to the corrected verdict (missed clock-out: PRESENT/0/330 →
LATE/5/0; override path: PRESENT/0 → LATE/5). Full backend suite green.

## 10. Limitations

- Schedules are still read-only inputs: no rotation engine, no
  auto-assignment, no conflict detection (later phases).
- `minimumMinutes` keeps the established net-vs-gross semantic from the
  legacy HALF_DAY rule (a full 9–6 day with a 60-minute break nets 475
  against a 480 minimum) — mirrored, not redesigned.
- Mid-day Shift edits apply to the NEXT evaluation, never retroactively
  (by design — the snapshot is the day's frozen meaning).
