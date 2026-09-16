# Phase 31.8 — Overtime, Weekend/Holiday Work & Comp-Off

Turns the attendance facts established by Phases 31.1–31.7 into
controlled HUMAN-APPROVED overtime and compensatory-off eligibility.

```
ATTENDANCE EVENTS + APPROVED REGULARIZATIONS + SHIFT/SCHEDULE
+ LEAVE/HOLIDAY/WEEKLY-OFF RECONCILIATION + ATTENDANCE POLICY
        ↓
OT / NON-WORKING-DAY ELIGIBILITY
        ↓
EMPLOYEE REQUEST OR SYSTEM CANDIDATE
        ↓
MANAGER/HR REVIEW
        ↓
APPROVED TIME ENTITLEMENT
        ↓
PAYROLL TIME FACT / COMP-OFF ENTITLEMENT
```

ATTENDANCE HANDLES TIME. PAYROLL HANDLES MONEY. Phase 31.8 never
calculates an overtime salary amount.

## 1. Terminology (three separate concepts)

- **Recorded extra time** — the employee actually worked beyond
  schedule (e.g. 75 minutes). A fact, never a benefit.
- **Eligible OT time** — policy says the extra time qualifies for
  review (31.1 minimum gate, weekend/holiday flags, benefit
  disposition). Still not a benefit.
- **Approved OT time** — a human reviewer accepted a specific
  duration. Only this reaches payroll (as minutes) or leave (as
  days). No automatic OT payment ever: a late clock-out alone
  creates recorded time, never approved time.

## 2. Threshold semantics (31.1, reused verbatim)

`minimumExtraMinutes` is a MINIMUM GATE, not a deduction:
extra ≥ minimum ⇒ ALL extra minutes become eligible
(75 extra / 30 minimum ⇒ 75 eligible; 29 ⇒ 0; 30 ⇒ 30).
`deriveEligibleMinutes` delegates to 31.1's
`deriveOTEligibleMinutes`, so the semantics cannot drift.

## 3. Eligibility inputs (all authoritative, all re-fetched)

- Effective worked minutes: `Attendance.workMinutes` (the
  post-31.5-rebuild figure; approved corrections move it, pending /
  rejected corrections never do).
- Schedule: the stored `scheduleSnapshot.scheduledMinutes` wins;
  otherwise dated re-resolution. A WORK_DAY with no resolved
  schedule yields no candidate — 31.6 never guesses.
- Calendar/conflicts/outcome: a fresh 31.7 `resolveDay`
  (WEEKLY_OFF / HOLIDAY primary, `nonWorkingDayWorked`, both
  conflict codes, UNRESOLVED outcome).
- Policy: the current 31.1 policy + the 31.8 benefit extension.

Recorded extra: WORK_DAY ⇒ `max(0, worked − scheduled)` (worked
minutes already exclude breaks, so excluded breaks can never
inflate OT); WEEKLY_OFF / HOLIDAY ⇒ all worked minutes.

These block a candidate: no control, no worked time, tracking
disabled, UNRESOLVED day (missing punch), any 31.7 conflict,
unresolved schedule (work days), below-threshold extra, benefit
NONE, comp-off below one day, an existing live request, and (for
OVERTIME only) a locked payroll month.

## 4. Normal-day extra work

09:00–18:00 scheduled, effective 09:00–19:15, 30-minute minimum:
75 recorded ⇒ 75 eligible ⇒ employee may request up to 75;
the reviewer may approve any 1–75. Partial approval is allowed;
the remainder is forfeited (one disposition per block, §7).

## 5. Weekly-off / holiday work

31.7 identifies the context (`calendar.primary`,
`nonWorkingDayWorked`); 31.8 maps it through the policy benefit:

- `weeklyOffBenefit` / `holidayBenefit` ∈ NONE / OVERTIME / COMP_OFF
- gated by the existing `weekendEligible` / `holidayEligible` flags
- `normalDayBenefit` ∈ OVERTIME / NONE

Old policy documents predate the benefit fields: the rules default
them on read (eligible ⇒ OVERTIME, ineligible ⇒ NONE), preserving
the 31.1 meaning. The Weekly-Off / Holiday context is snapshotted
on the request and stays visible in the UI after approval.

## 6. State machine

`PENDING → APPROVED | REJECTED | CANCELLED`. Submit creates
PENDING; the owner (or a scoped reviewer) cancels PENDING; the
reviewer approves/rejects PENDING. No self-review, no
auto-approval. Transitions are status-filtered atomic updates, so
a lost decision race fails cleanly instead of double-deciding.

## 7. OT vs comp-off (no double benefit)

One benefit disposition per approved qualifying block (day).
BOTH does not exist. The day's policy benefit fixes the request
type; a mismatched type is refused.

## 8. Duplicate / double-claim protection

- Partial unique index
  `{ companyId, user, attendanceDate }` where status ∈
  PENDING/APPROVED: at most one live request per day. Concurrent
  submits race in Mongo (duplicate key ⇒ conflict), never Redis.
- Approval revalidates eligibility from current records; stale
  numbers (e.g. a 31.5 correction shrank the day) are refused with
  a resubmission message — never silently adjusted.
- Retried approvals find no PENDING row and change nothing; the
  payroll republish recomputes the day total from Mongo, so retries
  converge instead of accumulating.

## 9. Comp-off entitlement (Leave integration)

The Leave module has no credit/ledger concept, so the APPROVED
COMP_OFF request row IS the entitlement — no second ledger was
created. `days = floor(approvedMinutes / compOffMinutesPerDay)`
(default 480), enforced ≥ 1 at submit and approve. Whole days
only: Leave balances cannot represent fractions.

- New `COMP_OFF` leave type (yearly quota 0 — availability is
  entitlement-driven: earned − used − pending, all-time scoped so
  year boundaries cannot double-count).
- Earning never creates a leave: taking the days later goes through
  the normal Leave apply/decide flow (which counts COMP_OFF as paid
  via the existing OTHER bucket — no payroll change).
- No expiry (none exists in Leave); never encashed (FNF encashes
  EARNED only); comp-off taken later reconciles as leave via 31.7
  automatically.

## 10. Attendance conflict behavior

Any 31.7 conflict (attendance-on-approved-leave, leave-half
mismatch, or any future code — unknown codes fail closed) and any
UNRESOLVED outcome block the candidate and the approval. Leave is
never altered; a resolved day recalculates on the next read.

## 11. Regularization interaction

Approved 31.5 corrections move eligibility through the rebuilt
`workMinutes`; pending/rejected corrections are invisible to 31.8
(the service never reads regularization rows — pinned by a static
test). Raw events are never referenced, let alone written.

## 12. Payroll time-fact integration (no payroll changes)

- `Attendance.overtimeMinutes` is APPROVED-ONLY as of 31.8. Punch,
  regularization, and legacy punch-out paths no longer write
  eligible/unapproved minutes (that auto-pay flow is closed); the
  31.8 approval republishes the day's approved total. Zero payroll
  files changed: 29.5 keeps summing the field, 29.6 keeps pricing
  it with the 29.1 policy.
- OVERTIME submit/approve for a LOCKED / SENT_TO_PAYROLL month is
  refused (31.5 precedent) so approvals cannot silently miss a
  frozen payroll. COMP_OFF is leave-side and stays available.
- `PayrollResult` is never touched. Approvals that land after a
  payroll run surface on the next import/reopen; 31.11 owns the
  finalization sync.

## 13. RBAC / org scope

- `ATTENDANCE_OVERTIME_REQUEST` (self-service, every employee) and
  `ATTENDANCE_OVERTIME_REVIEW` (MANAGER + HR_MANAGER scoped queue,
  ADMIN everywhere). `SYSTEM_PERMISSION_VERSION` 30 → 31 with the
  existing atomic `$addToSet` migration.
- Tenant authority is `req.companyId` only; reviewers are scoped by
  `resolveScopeIds`; identity/eligibility overrides in payloads are
  refused at the validator.

## 14. Notifications / audit

Fire-and-forget `notifySmart` (submit ⇒ reviewers, decide ⇒
employee, comp-off credit ⇒ employee with a Leaves link); failure
never rolls back a committed decision. `recordAudit` on submit /
approve / reject / cancel / entitlement-created with time-only
metadata (minutes, type, calendar — never money).

## 15. APIs / UI

- `GET /api/attendance/overtime/eligibility?from&to` (read-only,
  ≤ 93 days), `POST /`, `GET /mine`, `GET /pending`,
  `GET /:requestId`, `POST /:requestId/cancel|approve|reject`.
- `/app/attendance/overtime`: My overtime (eligibility table +
  request form + my requests) and the permission-gated Review
  queue (partial approve ≤ asked/eligible, reject with reason).
- Attendance day detail keeps Holiday / Weekly-Off / Leave visible
  and adds OT candidate / OT pending / OT approved / Comp-off
  pending / Comp-off earned badges, plus a deep link into the
  request form. The policy page edits the benefit disposition.
  Comp-off balances ride the existing Leave balance cards.

## 16. Tests

`Backend/test/attendanceOvertime.test.js` (65 hermetic tests):
threshold gate/boundaries, break exclusion, regularization seam,
weekly-off/holiday matrices, request/approval validation, stale
revalidation, double-claim races, idempotent republish, comp-off
single-credit/no-auto-leave, conflict blocking, tenancy, org scope,
payroll-seam totals, model contract, and static guards (no payroll
computation, no leave/period/event writes, no money terms, pure
rules, controller comment convention). Full `test:all` + frontend
build results are in the phase handoff.

## 17. Limitations

- One request per day: a partially approved day cannot reclaim the
  remainder; a changed day needs cancel + resubmit.
- Post-payroll-run approvals surface on next import (31.11 owns
  sync); no attendance finalization/lock exists yet.
- No comp-off expiry, no partial-day comp-off, no BOTH benefit.
- Payslip / dashboard leave balances exclude comp-off (they mirror
  the fixed quotas); the Leaves page is the comp-off surface.
- No 31.9+ features (no Who's Working board, timesheet redesign,
  operations dashboard, reminders, kiosk, or analytics).
