# Phase 31.5 — Attendance Regularization & Exception Center

Controlled correction of attendance facts on top of the 31.1 policy
engine, the 31.2 event ledger, the 31.3 location evidence and the
31.4 approval patterns. CORE LAW: `AttendanceEvent`s are NEVER
edited — an APPROVED request writes an effective-facts overlay onto
the daily projection, leaving recorded punches intact and visible.

---

## 1. Goal

Employees file CORRECTION requests (missed/wrong punch times,
breaks, work mode) or EXPLANATION requests (late arrival, early
exit, short hours, location note) for a past day inside the policy
window; a scoped reviewer approves or rejects. Approval rebuilds
the day from raw events + approved corrections through the SAME
derivation the live clock-out uses — a regularized day matches a
day that was punched correctly.

## 2. Model

`AttendanceRegularization` (tenant-scoped): `user`, `attendanceDate`
day string, `type` (10-value allowlist), `reason` (≤300), `proposal`
(`correctedIn/correctedOut/breaks[]/workMode` — only the fields the
type needs), `originalSnapshot` (recorded facts at submit: first
in/out, breaks, mode, minutes, status, event ids, policy
exceptions), `status`, `approver`, `reviewReason`, `decidedAt`,
`cancelledBy/cancelledAt`, `appliedAt` (overlay landed),
`authorizationOverride` (HR/Admin mode grant without 31.4 cover).
Indexes `{companyId:1,status:1,createdAt:1}` (queue) and
`{companyId:1,user:1,attendanceDate:1}` (mine/conflict/rebuild).
Zero middleware. `Attendance` gains additive `regularized` +
`regularization{correctedIn,correctedOut,correctedBreakMinutes,
correctedWorkMode,resolvedExceptions[],appliedRequestIds[],
appliedAt}`. `AttendanceEvent` is untouched — no new fields.

## 3. Request classes & conflict groups

Six CORRECTIONS (`MISSED_CLOCK_IN/OUT`, `CLOCK_IN/OUT_TIME_
CORRECTION`, `BREAK_CORRECTION`, `WORK_MODE_CORRECTION`) and four
EXPLANATIONS (`LATE/EARLY_EXIT/SHORT_HOURS/GEOFENCE_EXPLANATION`).
One open-or-applied request per conflict group per day
(IN / OUT / BREAK / MODE / per-type explanations): the second
same-fact request is refused at submit AND at approve
(exclude-self). Explanations must not propose times or modes.

## 4. State machine

`PENDING → APPROVED | REJECTED | CANCELLED` (owner + scoped
reviewer); APPROVED is terminal — the projection was already
rebuilt from it, so there is no approved-cancel and no rollback in
this phase. Double-decide loses a CAS race and returns 409. No
edit-in-place (cancel + resubmit).

## 5. Submission window & boundaries

- Window: 31.1 `missingPunch.allowRegularization` + `windowDays`
  (default 7, max 31); future days refused. Revalidated at approve.
- Leave: APPROVED leave covering the day blocks submit and approve
  (read-only check). Pending leave is not a boundary. No
  holiday/weekly-off gating (31.7 owns it).
- Payroll: a `PayrollPeriod` in LOCKED/SENT_TO_PAYROLL for the
  day's month blocks submit and approve; a missing period means
  open. Read-only — payroll computation is never touched.
- Proposal preconditions pin each type to recorded facts (e.g.
  missed-out needs a recorded in and no recorded out; break
  correction needs a completed day and the FULL effective list).

## 6. Overlay & rebuild

`buildEffectiveTimeline` (pure) composes recorded facts with the
single-layer corrections: IN → OUT → BREAK → MODE, explanations
contributing `resolvedExceptions` only. On approve, the service
re-derives the day: synthetic closed-event stream → shared
`deriveClosedDurations` → stored-or-resolved rule → shared
`evaluatePunch` → status math → shared `derivePolicyOutcome`.
Recorded `punchIn/punchOut` are derivation inputs only — never
persistence targets (static-guarded). Explanation-only approvals
overlay words and set `regularized`, never derived facts.

## 7. Crash safety

Truth first: CAS to APPROVED, then rebuild, then `appliedAt`.
Rebuild is a pure function of (events + approvals), so a crashed
approval completes on a scoped re-approve instead of 409ing
(audited `APPLIED … completed: retry`). A missed clock-in with no
record opens a WORKING day the employee can clock out of live —
live durations seed from the effective clock-in (one-line
`sessionOpenedAt` fallback; no-op for unregularized days) while
live derivation stays recorded-facts-only.

## 8. Mode guard & org scope

`WORK_MODE_CORRECTION` to an approval-required mode needs a
covering APPROVED 31.4 request; without cover, subtree reviewers
get 403 and only COMPANY_ADMIN/HR_MANAGER may approve with
`authorizationOverride: true` (audited). Reviewers resolve via
reused `resolveScopeIds`; self-review forbidden; client
`approverId`/`userId` refused. Notifications mirror 31.4 (manager
else Admin+HR, fire-and-forget, category ATTENDANCE).

## 9. RBAC

`ATTENDANCE_REGULARIZATION_REQUEST` (self-service: own requests
only) and `ATTENDANCE_REGULARIZATION_REVIEW` (scoped exception
queue). Grants: every employee REQUEST; MANAGER + HR_MANAGER
REVIEW; Company Admin via all-permissions. Catalog **v29 → v30**
(atomic `$addToSet` migration, no role loops).

## 10. API

`/api/attendance/regularizations` (mounted before the generic
router): `POST /`, `GET /mine`, `GET /pending`, `GET /:requestId`
(owner-or-scoped-reviewer), `POST /:requestId/cancel`,
`POST /:requestId/approve|reject`. GET never mutates. Rejection
requires a reason (min 3 chars); approval note optional.

## 11. UI

One surface `/app/attendance/regularizations` (single sidebar
item): My requests tab (list + grouped create form with
type-driven proposal fields + cancel) and Exception center tab
(team-only cards with recorded-vs-proposed comparison,
Approve/Reject-with-reason). History and the manager report show
effective times with a `*` (recorded one hover away) plus a
Regularized badge; every history row links into a date-prefilled
request form.

## 12. Tests

`test/attendanceRegularization.test.js` — 48 hermetic tests: pure
rules (types/groups/window/proposals/overlay/transitions), submit
boundaries (window/payroll-lock/leave/conflicts/tenancy),
approve/rebuild math (recorded-immutable, lateness recompute,
missed-in-live-clock-out end-to-end, multi-group compose,
break-inclusive + legacy controls, HALF_DAY), mode guard incl.
override, crash-completion, cancel/lists/get scoping,
validator/RBAC/static guards (no payroll/leave/request/event
writes, punches never persisted), live 31.2 regression slice.
31.1–31.4 suites frozen (165/165).

## 13. Limitations

- No APPROVED cancel/rollback; no multi-layer correction of the
  same fact; no request edit.
- No holiday/weekly-off gating and no leave-overlap reconciliation
  (31.7); no payroll finalization interplay beyond the lock read.
- Live clock-out after a missed-in correction keeps policy
  derivation recorded-facts-only by design (the in-punch IS
  missing from the ledger; the correction lives in the overlay).
- Proposals are validated against company-tz day membership;
  overnight outs may land on the next day.
