# Phase 31.2 — What was built and how to test it

Windows PowerShell commands throughout.

---

# PART 1 — What has been implemented

## Advanced punching (new)

| Area | Shipped |
|---|---|
| Models | `AttendanceEvent` (immutable ledger, 3 indexes, mutation guards); `Attendance` gains additive `liveState/workMode/breakMinutes/eventSeq/policyVersion/policyOutcome/policyExceptions/lastEventAt` + tenant-first index |
| Rules | Pure `attendanceEventRules.js`: transition table, `allowedActions`, legacy adoption, `(seq,at)` ordering, timeline labels, closed/live duration derivations, policy mode allowlist |
| Service | `attendanceEventService.js`: live read, `recordEvent` (policy → idempotency → session → CAS → event → projection), schedule parity, best-effort 31.1 outcome, DI fakes-ready |
| API | `POST /api/attendance/events`, `GET /api/attendance/today/live` (same self-service permissions; perm version stays 27) |
| UI | `/app/attendance` Today card: live badge, mode select, backend-driven buttons, local ticking, timeline, stale-session banner; history untouched |
| Tests | `test/attendanceEvents.test.js`, 35 hermetic tests, registered in `test:all` |

## Untouched (verify still green)

Classic punch-in (byte-identical), punch-out (+ one event-backed guard),
`today/my/company/report` APIs + report page, Shift, Work Schedule,
Leave, Holiday, dashboard widgets, Payroll 29.x/29.5
(`lopSource='ATTENDANCE'` contract), 31.1 policy UI. No migration.

---

# PART 2 — Backend verification

```powershell
cd Backend

$env:MONGO_URI='mongodb://127.0.0.1:27017/crewly_test'
node --test test/attendanceEvents.test.js   # expect: 35 pass, 0 fail
node --test test/attendancePolicy.test.js   # expect: 34 pass, 0 fail
npm run test:all                            # expect: all green (see handoff for count)
```

---

# PART 3 — UI walkthrough (localhost)

```powershell
cd Frontend
npm run dev
```

As an **Employee** on `/app/attendance` (fresh day, no punches yet):

1. Badge shows "Not clocked in" + work-mode dropdown + Clock In.
2. Clock In as OFFICE → badge WORKING, "On duty since", timer ticking.
3. Start Break → ON_BREAK, break timer ticking, work timer frozen.
4. End Break → WORKING resumes, break total kept.
5. Start/end a second break → timeline grows, totals accumulate.
6. Clock Out → COMPLETED summary (in → out, worked h, breaks m).
7. Timeline lists all 6 events in order with correct times.
8. Reload → COMPLETED persists. Extra actions → friendly refusal.
9. As Admin: disable WFH in `/app/attendance/policy`, activate; as
   Employee the mode vanishes; direct API call with WFH → 403.
10. History table + month chips include the new day; report page,
    leaves, shifts, schedules, payroll inputs all load unchanged.
11. No browser geolocation prompt appears at any point.

## Ledger hygiene for retests (read before deleting rows to re-run a day)

The event ledger is append-only: `attendances` (control) + `attendanceevents`
(facts) must always be reset **together**. Deleting only one side orphans
sequence numbers, and the next punch then fails with
`409 Attendance record conflict — please refresh…` while the server log names
the colliding key (`[attendance] event insert conflict (no key match)`).
That 409 is the ledger defending itself, not a product bug.

Clean slate for a retest day (dev database only — never production):

```js
// mongosh "<MONGO_URI>" — deletes TODAY's attendance rows for ALL users
db.attendances.deleteMany({ date: "2026-09-12" });
db.attendanceevents.deleteMany({ date: "2026-09-12" });
```

Then restart the backend (fresh code + fresh data) and retest with single
clicks. If `record conflict` still appears on a clean slate, paste the
backend log line — it names the exact colliding key.
