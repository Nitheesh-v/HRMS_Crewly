# Phase 31.13 — Attendance Notifications & Automation

Reminders nudge; they never act. Every reminder in this phase is a
read-only observer of attendance state: shift-start nudges, missing
punch nudges, break nudges, reviewer nudges, and finalization nudges.
No reminder punches, resolves, approves, or finalizes anything.

## 1. What was reused (no new infrastructure)

| Need | Reused | Notes |
|---|---|---|
| Delayed jobs | `scheduled` queue + `SCHEDULED_JOB_OPTIONS` | Same 3-attempt exp-backoff as 28.5/28.6 |
| Job names | `JOB_NAMES` + `SCHEDULED_JOB_NAMES` | `ATTENDANCE_REMINDER`, `EMAIL_ATTENDANCE_REMINDER` appended |
| Enqueue/cancel | `addScheduledJob` / `cancelScheduledJob` | Never-throw, deterministic ids, slot prep |
| Worker dispatch | `registerScheduledProcessors` + shared registry | Unknown names → CONFIGURATION error (§37) |
| In-app bell | `Notification` + `NotificationPref` + `notifySmart` semantics | Missing pref key = ON (unchanged) |
| Email | 28.3 `requestEmailDelivery` + `EmailDelivery` eventKey | Outbox-backed, claim-then-send |
| Reviewer audience | `resolveNotificationAudience` (permission-based) | REG_REVIEW / OT_REVIEW / FINALIZATION_MANAGE |
| Schedule truth | 31.6 `preloadScheduleMasters` + `resolveEmployeeScheduleFromMasters` | Zone-aware anchors, overnight/DST handled |
| Leave truth | `Leave` + `leaveCoversDate` (31.7) | Approved-only cover check |
| Policy + audit | 31.1 draft → activate + `ATTENDANCE_POLICY_*` audit | Notifications section rides the existing flow |
| Recovery | `npm run scheduled:reconcile` | Attendance runner added (28.6 precedent: CLI, not startup) |

There is deliberately NO new queue, worker, cron, prefs system,
or notification center. No worker-startup reconcile addition (28.6
families are CLI-only too).

## 2. Reminder taxonomy (§3)

Delayed jobs (`ATTENDANCE_REMINDER` + `reminderType`):

| Type | Anchor | Due | Fires only while… |
|---|---|---|---|
| `SHIFT_START` | scheduled start | start − `minutesBefore` (0–180) | not clocked in |
| `MISSING_CLOCK_IN` | scheduled start | start + `minutesAfter` (0–720) | still not clocked in |
| `MISSING_CLOCK_OUT` | scheduled end | end + `minutesAfter` (0–720) | day open (in, not out) |
| `INCOMPLETE_BREAK` | break start | break + `minutesAfter` (15–720) | break still open |

Reconcile-direct (no jobs — §12, no job-per-request spam):

| Kind | Condition | Audience |
|---|---|---|
| `REG_REVIEW` | reg `PENDING` older than 24h | `ATTENDANCE_REGULARIZATION_REVIEW` holders |
| `OT_REVIEW` | OT `PENDING` older than 24h | `ATTENDANCE_OVERTIME_REVIEW` holders |
| `FINALIZATION_PENDING` | period `OPEN`/`REOPENED` after month-end | `ATTENDANCE_FINALIZATION_MANAGE` holders |

All four policy toggles default OFF (no surprise spam on upgrade).
Reviewer/finalization legs are operational (always evaluated, like
28.6 BGV review reminders) — they key off authoritative workflow
state, not invented deadlines.

## 3. Scheduling (§12–§14)

- **Reactive hooks** (fire-and-forget, never-throw, never-awaited):
  - `CLOCK_IN` → cancel shift-start + missing-in jobs (exact ids from the day snapshot).
  - `CLOCK_OUT` → cancel missing-out job + schedule tomorrow's three legs.
  - `BREAK_START` → schedule the break check. `BREAK_END` → cancel it.
  - Shift assignment → schedule a bounded 7-day horizon (explicit users + first 200 active department members).
- **Reconcile** (`runAttendanceReminderReconcile`, CLI): forward window
  today + tomorrow per company tz (≤50 companies, ≤500 employees each);
  reviewer + finalization direct-notify in the same run.
- **No hook on leave approval**: the worker's leave guard is exact, so
  cancel-on-leave would be hygiene only. No policy-change
  mass-reschedule: the worker revalidates policy at execution.

## 4. Payload law (§16) + idempotency (§19)

Scheduled payload keys (exact allowlist, references only):

```
companyId, employeeId, attendanceDate, reminderType, anchorIso, correlationId
```

No bodies, PII, coordinates, money, or reasons — unknown keys fail
closed. The recipient, schedule, attendance state, and policy are
ALL re-fetched from Mongo at execution; cross-tenant payloads fail
closed via the company-match guard.

- Job ids: `attendance-reminder-<employee>-<type>-<yyyymmdd>-<anchorMs>`
  (deterministic → BullMQ dedupes re-runs; schedule edits change the
  anchor → old jobs skip as `STALE`/`ANCHOR_CHANGED`).
- In-app dedupe: new sparse-unique `Notification.eventKey`
  (`{companyId, eventKey}` partial index; legacy null-key docs untouched).
- Email dedupe: 28.3 `EmailDelivery.eventKey` (same key stem).
- Reviewer keys are per-recipient (`…:<request>:<reviewer>`) so
  co-reviewers never starve each other (delivery keys are
  company-unique).

## 5. Worker semantics (§17–§20, §37)

- Invalid payload → throw (28.6 poison semantics — surfaces, never swallowed).
- Business ineligibility → `{ skipped, reason }` (`POLICY_DISABLED`,
  `NOT_A_WORK_DAY`, `ON_APPROVED_LEAVE`, `ANCHOR_CHANGED`,
  `ALREADY_CLOCKED_IN/OUT`, `NO_CLOCK_IN`, `BREAK_CLOSED`,
  `BREAKS_DISABLED`, `EMPLOYEE_INACTIVE`, `ALREADY_NOTIFIED`, …).
- Infra failure → propagates → BullMQ retries (attempts=3, exp backoff);
  effects stay exactly-once via the two eventKeys (at-least-once delivery).
- The email handler revalidates staleness belt-and-braces (the email
  queue can lag the scheduled worker by seconds): resolved punches,
  closed breaks, decided requests, and finalized periods skip as
  `STALE_STATE` instead of sending.
- Precedence (§20): approved leave beats everything; a post-schedule
  punch beats the job; a changed anchor beats the payload.

## 6. Redis-degraded operation (§18)

Scheduling returns `{ scheduled: false, reason: 'QUEUE_UNAVAILABLE' }`
and logs — punches, assignments, and the API never feel it. Recovery
is the 28.5 runbook: restore Redis, start workers,
`npm run scheduled:reconcile`. In-flight jobs whose Redis entries die
are re-derived by the next reconcile; already-delivered reminders
stay delivered (eventKeys), never duplicated.

## 7. Copy (neutral, §30)

- Shift: "Your shift starts at {time} — please punch in on time."
- Missing-in: "You have not clocked in yet. Please punch in or regularize the day."
- Missing-out: "You have not clocked out yet. Please punch out before you leave."
- Break: "Your break has been open for over {n} minutes. Please end it when you are back."
- Reg/OT: "A … request has been pending for over 24 hours and needs your review."
- Finalization: "Attendance for {month} is still {state} after month-end. Please finalize it for payroll."

Links: `/app/attendance`, `/app/attendance/regularizations`,
`/app/attendance/overtime`, `/app/attendance/finalization`. No
reasons, locations, money, or scores in any copy.

## 8. Files

Created: `attendanceReminderRules.js` (pure, zero imports),
`attendanceReminderService.js` (read-only vs attendance),
`test/attendanceReminders.test.js` (94 hermetic tests), this doc.
Modified: `AttendancePolicy` model/rules/service (`notifications`
section + serialize/validate/create), `queueConfig`
(`ATTENDANCE_REMINDER`, `EMAIL_ATTENDANCE_REMINDER`),
`Notification` (`eventKey` + partial-unique index),
`NotificationPref` (`ATTENDANCE` category), `scheduledProcessor`
(validator + processor + registration), `emailProcessor`
(allowlist + staleness check + handler + registration),
`attendanceEventService` + `shiftController` (hooks),
`scripts/scheduled-reconcile.js` (runner), `AttendancePolicyPage`
(Notifications section), `NotificationSettingsPage` (`ATTENDANCE`
label), `package.json` (`test:attendance-reminders` + `test:all`).

## 9. Localhost checklist (acceptance)

1. `npm install` in `Backend/` (if fresh).
2. `npm run test:attendance-reminders` → 94/94.
3. `npm run test:all` → totals match the pre-existing baseline
   (1298-file set + 94 new; only the 11 known env failures).
4. `npm run build` in `Frontend/` → green.
5. Policy page → Notifications section renders, saves via draft →
   activate, audit entry written.
6. Notify Settings → ⏰ Attendance row toggles in-app/email.
7. Worker + Redis up → assign a shift → BullMQ `scheduled` board
   shows `attendance-reminder-*` delayed jobs.
8. Punch in → shift/missing-in jobs removed (best-effort cancel).
9. Let a missing-in job fire → bell + (if email on) email arrive once;
   re-run reconcile → no duplicates.
10. Stop Redis → punch still works; restore → `scheduled:reconcile` → jobs return.
