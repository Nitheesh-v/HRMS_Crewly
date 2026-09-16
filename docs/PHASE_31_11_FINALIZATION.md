# Phase 31.11 — Monthly Attendance Finalization & Payroll Integration

Payroll-boundary phase: the month gets a controlled lifecycle
(OPEN → FINALIZING → FINALIZED → SENT_TO_PAYROLL, with gated REOPENED),
backend-enforced readiness (BLOCKER vs WARNING, no overrides), immutable
versioned per-employee snapshots, and an explicit send step that syncs
attendance-owned facts into the existing 29.5 `EmployeeMonthlyInput.auto`
without touching HR entries, payroll money, or payroll results.

## Lifecycle & guarantees

- **One lifecycle, no duplicate period**: `AttendancePeriod` tracks the
  attendance month only — it never mirrors or recalculates payroll state.
  It reads `PayrollPeriod` / `PayrollRun` / `PayrollReview` / payment /
  payslip state purely as gates (allowed / refused + reason).
- **Backend-enforced readiness**: `validate` derives blockers
  (open session, missing punch, pending regularization, attendance on
  approved leave, pending OT, double benefit, bad day fractions,
  unresolved day when schedule setup exists) and warnings (late/early,
  worked weekly-off/holiday, comp-off info, OT policy disabled) from live
  31.10 day projections. `finalize` re-derives and revalidates inside the
  claim — the frontend `ready` flag is advisory only. No force flags.
- **Immutable versioned snapshots**: `AttendancePayrollSnapshot`
  (unique company+month+employee+version) is written once via
  `$setOnInsert`; vN never mutates. Exactly one `isCurrent` per employee;
  reopen → correct → finalize mints vN+1 and flips the flag.
- **Fingerprint**: sha256 over canonical employee/employeeId/worked
  facts; stored per version, rechecked before every send. Tampering or a
  changed population fails the send.
- **Concurrency**: Mongo-claim based. OPEN/REOPENED → FINALIZING claims
  `claimedVersion`/`claimedAt`; a fresh claim (< 10 min) rejects a second
  finalizer; a stale claim resumes the same version. No Redis locks, no
  queues, no transactions.
- **Joiners/exits**: per-employee scope starts at `dateOfJoining` and
  ends at the approved resignation's last working day — no false
  absences outside employment. Inactive users are excluded.
- **Leave/OT/comp-off contracts**: LOP syncs as ATTENDANCE LOP
  (absent units), paid-leave units break down by type, only APPROVED OT
  minutes sync, and comp-off days never map into OT fields.
- **Payroll side**: send upserts `auto` only (entries/remarks/status
  preserved), stamps `attendanceSource` + `attendanceImportedAt`, marks
  the period version SENT, invalidates the payroll-inputs cache. The 29.5
  legacy `importAutomatic` refuses once attendance is SENT. Reopen is
  refused after calculation approval / payment batches / payslips /
  irreversible payroll states. Zero salary math anywhere in 31.11.

## API (all under `/attendance/finalization/:month`, tenant from session)

| Method | Path | Permission |
|---|---|---|
| GET | `/status` | ATTENDANCE_FINALIZATION_READ |
| GET | `/validate` | ATTENDANCE_FINALIZATION_READ |
| GET | `/preview` | ATTENDANCE_FINALIZATION_READ |
| POST | `/finalize` | ATTENDANCE_FINALIZATION_MANAGE |
| POST | `/send-to-payroll` | ATTENDANCE_FINALIZATION_MANAGE |
| POST | `/reopen` (reason required) | ATTENDANCE_FINALIZATION_REOPEN |

## UI

- Team Timesheets page gains a **Month finalization** tab (READ-gated):
  status pill + version history, readiness banner, payroll-gate notice,
  aggregate preview cards, blockers table (date/employee/issue/where-to-fix),
  warnings list, and Finalize / Send-to-payroll / Reopen (reasoned) actions.
- Monthly Inputs table shows a `finalized vN` badge on rows whose `auto`
  came from a finalized snapshot.

## Verification

- `test/attendanceFinalization.test.js`: 40/40 hermetic (fake Mongo with
  faithful unique indexes — the concurrency test really collides).
- Regressions: attendanceTimesheet 40/40, monthlyInputs 35/35,
  payrollReview 29/29, frontend `vite build` green.
- `test:all`: only the 11 pre-existing environmental failures
  (analytics/bgv/email/fnf/payslip/phase30 — fail identically on a clean
  tree; they need live infra).

## Localhost handoff

1. `cd Backend && npm run dev`, `cd Frontend && npm run dev`.
2. As HR: Attendance → Team Timesheets → **Month finalization** tab.
3. Pick the current month → review blockers → resolve them in their own
   screens → Finalize → Send to payroll → check Monthly Inputs for the
   `finalized v1` badge and synced auto figures.
4. Try Reopen with a reason, correct a day, finalize v2, resend.
