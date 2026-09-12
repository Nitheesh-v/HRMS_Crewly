# Phase 31.2 — Advanced Punching & Live Attendance

> Programme index: `PHASE_31_ADVANCED_ATTENDANCE.md`.
> Builds on: 31.1 policy engine (`PHASE_31_1_ATTENDANCE_POLICY_ENGINE.md`).

The employee day becomes event-oriented — `CLOCK_IN → BREAK_START →
BREAK_END → CLOCK_OUT` with multiple breaks — while every existing
consumer (reports, dashboard, payroll 29.x) keeps reading the same
`Attendance` projection it always has.

```
Events (immutable facts) ──► Attendance (derived projection) ──► reports / payroll
   AttendanceEvent              punchIn/punchOut/workMinutes/
                                status/late/early/OT + additive
                                liveState/workMode/breakMinutes/…
```

**What this phase deliberately does NOT do:**

| Not here | Owner |
|---|---|
| Geolocation / geofencing / maps | 31.3 |
| WFH / field / travel approvals | 31.4 |
| Regularization / corrections | 31.5 |
| Shift/roster redesign, overnight engine | 31.6 (31.2 only keeps overnight possible) |
| Leave/holiday reconciliation, OT approval, Who's Working, timesheets, payroll lock, ops dashboard, reminders, kiosk/QR/import/device, analytics | 31.7–31.16 |

## 1. Event architecture

`AttendanceEvent` (`Backend/src/models/AttendanceEvent.js`) stores raw
facts: `companyId, user, date` (session day-key in company/policy tz),
`seq`, `type`, `at` (server time — never client), `workMode` (CLOCK_IN
only), `source` (server-forced `WEB`), `requestId` (opaque idempotency
key), timestamps. Indexes: unique `{companyId,user,date,seq}`, unique
sparse `{companyId,user,requestId}`, `{companyId,user,at}` — each mapped
to one access pattern. No update/delete endpoints; schema hooks throw on
any mutation attempt. There is intentionally no `PATCH /attendance-events/:id`.

## 2. State machine

Pure `attendanceEventRules.js` (zero I/O): NOT_IN → CLOCK_IN → WORKING
⇄ (BREAK_START / BREAK_END) ON_BREAK → CLOCK_OUT → COMPLETED.
ON_BREAK + CLOCK_OUT is rejected (break must end first — no repo
evidence justified auto-close). COMPLETED is terminal. `allowedActions`
is backend-derived; the UI renders it, never invents transitions.

## 3. Durations

Deterministic from facts, ordered by `(seq, at)`, every segment clamped
at zero. Persisted facts are integer minutes (`Math.round`, matching
`scheduleEngine`): `spanMinutes`, `breakMinutes`, `workedMinutes`. The
31.1 break treatment decides included vs excluded; with no active policy
the legacy formula (`span − rule.breakMinutes`) applies. Live seconds
(`workedSecondsSoFar`, `openInterval`) are computed, never persisted —
the UI ticks locally from authoritative timestamps (no per-second
writes, jobs, or Redis traffic).

## 4. Concurrency & idempotency

- The `Attendance` doc is the session control record: transitions commit
  via CAS (`findOneAndUpdate` on `{companyId,user,date,eventSeq}` +
  `$inc`). CLOCK_IN creation is gated by the unique index (11000 →
  replay-or-409). Losers re-read: matching `requestId` replays, else 409.
- The control record is authoritative for state; events are the ledger.
  A crash between CAS and event insert leaves a harmless seq gap, never
  a stuck machine. No transactions (standalone-Mongo risk), no Redis in
  the correctness path.
- Optional client `idempotencyKey` rides the event (`requestId`): same
  key + same action replays (`200` + `meta.idempotentReplay`), same key
  + other action → 409, isolated per tenant + employee by index. No TTL
  needed — the key lives on the permanent fact.

## 5. Daily projection & legacy compatibility

New sessions write the **same** `Attendance` fields the classic flow
writes (`punchIn/punchOut/workMinutes/status/lateMinutes/earlyMinutes/
overtimeMinutes/shift/schedule/shiftSource`) using the same
`scheduleEngine` helpers and HALF_DAY rule — reports, dashboard and the
29.5 reader (`date/status/lateMinutes/overtimeMinutes/shift`) are
unaffected. `status` stays schedule-derived; the 31.1 `evaluateDay`
outcome lands in additive `policyOutcome`/`policyExceptions` only.

- Classic `punch-in` is byte-identical. Classic `punch-out` gains one
  guard: event-backed records (`eventSeq > 0`) 409 with "use Clock Out"
  so the legacy formula can't overwrite event-derived minutes.
- Legacy in-progress sessions (punchIn, no punchOut, no events) are
  adopted as WORKING with no fabricated CLOCK_IN; completed legacy days
  stay terminal. No migration, no history rewrite.
- Sessions key on the CLOCK_IN day: clock-outs after midnight stay on
  the session; a new CLOCK_IN is refused while any session is open.
  Classic punch-in while another date is open (pre-existing norm) is
  preserved; the live API then surfaces `otherOpenSession` so the stale
  session can be closed explicitly via the `date` action parameter.

## 6. Policy integration (31.1)

Cached `getCurrentPolicy` per request: work-mode allowlist enforced
server-side (no policy → OFFICE only), break treatment, and — only when
the shift/schedule rule supplies real boundaries — late/early/OT via
`scheduleEngine` plus a best-effort `evaluateDay` outcome (leave always
`NONE`; weekly-off/holiday detected via the established schedule APIs
for derivation only). Policy derivation can never fail a punch: errors
degrade to `null`. Punches on leave/holiday/week-off are preserved as
facts (§20); no Leave/Holiday writes.

## 7. Tenancy, RBAC, audit, boundaries

- Identity from `req.user` / `req.companyId` only; body `companyId` /
  `employeeId` / `user` overrides rejected. Every query company-scoped.
- Reuses `ATTENDANCE_CREATE_SELF` (mutations) and
  `ATTENDANCE_READ_SELF | ATTENDANCE_READ` (live read) — **no new
  permissions, `SYSTEM_PERMISSION_VERSION` stays 27**.
- No per-punch `AuditLog`: the immutable event ledger IS the factual
  history (classic punches never wrote AuditLog either). No salary
  maths, no `PayrollResult` writes, no location collection, no device
  fingerprinting, no new queues, no Redis-dependent correctness.

## 8. APIs

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/api/attendance/events` | `ATTENDANCE_CREATE_SELF` | `{action, workMode?, date?, idempotencyKey?}`; 201, or 200 replay |
| GET | `/api/attendance/today/live` | `ATTENDANCE_READ_SELF \| ATTENDANCE_READ` | state, durations, timeline, `allowedActions`, schedule, modes |

Classic `punch-in / punch-out / today / my / company / report` unchanged.

## 9. Frontend

`/app/attendance` Today card upgraded in place: live badge, work-mode
select (policy modes) at CLOCK_IN, backend-driven action buttons,
local 1s ticking from server timestamps, refetch on focus/action,
compact timeline, schedule line when non-default, `otherOpenSession`
banner, error UX from server messages. Month summary + history table
untouched. Lucide icons, existing `.card/.btn-*` styles, no emojis in
touched areas, no geolocation prompts.

## 10. Tests & limitations

- `Backend/test/attendanceEvents.test.js`: 35 hermetic tests (machine,
  durations, modes, idempotency, CAS races, tenancy, adoption, time,
  validators, payroll/31.1 compat). Registered in `test:all`.
- Known limitations: one session per day (second CLOCK_IN 409s);
  `policyOutcome` needs a real shift/schedule boundary or stays null;
  abandoned open sessions need manual clock-out until 31.5; legacy
  `{user,date}` unique index intentionally untouched (same-user cross-
  company punching is impossible via auth-derived tenancy).
