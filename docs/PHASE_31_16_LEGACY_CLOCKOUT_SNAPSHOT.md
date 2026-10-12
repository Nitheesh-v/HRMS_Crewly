# Phase 31.16 — Legacy CLOCK_OUT re-resolves the live snapshot

## 1. The bug

A user had a forgotten CLOCK_IN from `2026-08-13` (legacy, no
CLOCK_OUT). On `2026-10-03`, `/app/attendance` showed:

> Showing your open session from 2026-08-13 — close it to start a new day.

The user clicked the Clock Out button (no date — the legacy
`control` is the only open session). The event committed (10:14 am
row in the timeline) but the banner stayed stuck. The user had no
actionable buttons because:

- `live.isToday` was still `false` (the just-closed doc's `date` is
  `2026-08-13`, not today).
- `live.liveState` was now `COMPLETED`, which has no transitions in
  the state machine — so the `can('CLOCK_OUT')` and `can('CLOCK_IN')`
  buttons both hid.

The user was stuck on a "you have a closed session you cannot act
on" screen, with no path forward.

## 2. Root cause

`recordEvent` built the response snapshot from the just-patched
`updated` control doc. For a CLOCK_OUT on a non-today date:

- `updated.date` is the legacy date (`2026-08-13`).
- `updated.liveState` is now `COMPLETED`.
- `buildSnapshot({control: updated, ...})` returns
  `{date: '2026-08-13', isToday: false, liveState: 'COMPLETED', ...}`.

That snapshot is technically accurate ("this is what you just did")
but operationally wrong for the live state. The user's interactive
state is "today, NOT_IN" — they should immediately see the Clock In
button. The just-closed session is no longer the user's live
context; it is history.

## 3. The fix

In `Backend/src/services/attendance/attendanceEventService.js`,
`recordEvent` now re-resolves the live snapshot when the action was
`CLOCK_OUT` and the just-closed doc is on a non-today date:

```js
if (
  action === EVENT_TYPE.CLOCK_OUT &&
  updated.liveState === LIVE_STATE.COMPLETED &&
  updated.date !== todayKey
) {
  snapshot = await getLiveAttendance({ companyId, userId, deps: full });
} else {
  snapshot = await buildSnapshot({
    control: updated,
    events: [...events, ...created],
    policy,
    timezone,
    todayKey,
    schedule,
    now: at,
  });
}
```

`getLiveAttendance` runs the same probe the `/today/live` GET runs
(today first, then `findOpenSession`). After the close:

- If no other open session exists: snapshot is for today, NOT_IN.
  Clock In button reappears.
- If another legacy session is still open: snapshot is for that
  other legacy date, with `otherOpenSession` still null (the
  "main" `control.date` is the other open session; today has no
  doc; the probe does not look further for a third).
- If a today session exists: snapshot is for today, WORKING.
  `otherOpenSession` is null (because the close removed the legacy
  one and no other is open).

The "today" case is the common case the user hit and the one
covered by the new test
`service: closing the ONLY open session (no today session) lands on
today NOT_IN`.

## 4. Why the previous behaviour existed

The old code returned the snapshot of the just-modified doc. That
made sense for CLOCK_IN and BREAK_*, where the just-modified doc IS
the user's current interactive state (today's session). For
CLOCK_OUT on a non-today date, the just-modified doc is NOT the
user's current state — it is now closed history.

## 5. What this fix does NOT do

- Does NOT change the close action itself. The control doc still
  gets `punchOut: <now>` and `liveState: COMPLETED`.
- Does NOT change the event log. The CLOCK_OUT fact still has the
  legacy `date` so reconciliation + payroll match the day that
  was actually worked.
- Does NOT change `otherOpenSession` semantics. That probe only
  runs when the main `control.date === todayKey` (a today session
  exists), so a "legacy while-today" pair is still surfaced.

## 6. Tests touched

- `test/attendanceEvents.test.js`:
  - `time: cross-midnight sessions stay on the clock-in day` —
    snapshot after CLOCK_OUT is now `NOT_IN` (today), not
    `COMPLETED` (closed). Close itself is verified via
    `ctx.AttendanceModel.rows[0].punchOut`.
  - `time: explicit date targets only real open sessions` — same
    shape.
  - `service: legacy-interleaved double-open sessions stay
    resolvable` — closing the 2026-09-11 doc while the 2026-09-12
    one is open now returns a snapshot for 2026-09-12 (today) with
    `otherOpenSession: null`, not a snapshot for the closed date.
  - **NEW** `service: closing the ONLY open session (no today
    session) lands on today NOT_IN` — exact user repro: legacy
    2026-08-13 open, today 2026-10-03, CLOCK_OUT without a date,
    snapshot is `{date: '2026-10-03', isToday: true, liveState:
    'NOT_IN', allowedActions: ['CLOCK_IN']}`.

## 7. Rollout note

`recordEvent` re-resolving the snapshot adds one extra `getLive`
call per legacy CLOCK_OUT. The probe is bounded (`findOne` +
`findOpenSession` which itself is a single `findOne`); cost is a
few ms. Safe to ship.
