// ─────────────────────────────────────────────────────────────
// Phase 31.11 — pure attendance-finalization rules.
//
// Month state machine, day validation (blockers vs warnings),
// fraction integrity, OT/comp-off mutual exclusion, payroll-gate
// eligibility, snapshot aggregation, auto-input mapping, and the
// deterministic snapshot fingerprint. No Mongo, no req/res, no
// Redis, no payroll money math — the 29.5 auto SHAPE is mirrored
// so the sync boundary is testable here.
//
// Scope law (shared with the service): only applicable days
// STRICTLY BEFORE the company-today are finalizable — the current
// day is still in progress and future days have no facts. Past
// months therefore scope the whole month; the running month scopes
// elapsed complete days ("through Sep 19").
// ─────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';

export const FINALIZATION_STATUS = Object.freeze({
  OPEN: 'OPEN',
  FINALIZING: 'FINALIZING',
  FINALIZED: 'FINALIZED',
  SENT_TO_PAYROLL: 'SENT_TO_PAYROLL',
  REOPENED: 'REOPENED',
});

// ONE transition table. FINALIZING is the transient atomic claim;
// resume re-enters it for the same version, abort returns to the
// pre-claim state, completion lands FINALIZED.
export const FINALIZATION_TRANSITIONS = Object.freeze({
  OPEN: ['FINALIZING'],
  FINALIZING: ['FINALIZING', 'OPEN', 'REOPENED', 'FINALIZED'],
  FINALIZED: ['SENT_TO_PAYROLL', 'REOPENED'],
  SENT_TO_PAYROLL: ['REOPENED'],
  REOPENED: ['FINALIZING'],
});

export const canTransition = (from, to) =>
  (FINALIZATION_TRANSITIONS[from] || []).includes(to);

export const transitionError = (from, to) =>
  `Attendance month cannot move from ${from || '?'} to ${to || '?'}`;

export const nextVersion = (currentVersion) => Math.max(1, Math.trunc(Number(currentVersion) || 0) + 1);

// ── Validation issues ──────────────────────────────────────────

export const ISSUE_SEVERITY = Object.freeze({
  BLOCKER: 'BLOCKER',
  WARNING: 'WARNING',
});

// Day issue codes. BLOCKERs refuse finalization; WARNINGs surface
// in the report and never block.
export const FINALIZATION_ISSUE = Object.freeze({
  // Blockers
  OPEN_SESSION: 'OPEN_SESSION',
  MISSING_PUNCH: 'MISSING_PUNCH',
  REGULARIZATION_PENDING: 'REGULARIZATION_PENDING',
  ATTENDANCE_ON_LEAVE: 'ATTENDANCE_ON_LEAVE',
  PENDING_OT: 'PENDING_OT',
  INVALID_FRACTIONS: 'INVALID_FRACTIONS',
  UNRESOLVED_DAY: 'UNRESOLVED_DAY',
  DOUBLE_BENEFIT: 'DOUBLE_BENEFIT',
  INVALID_PROJECTION: 'INVALID_PROJECTION',
  // Warnings
  LATE_ARRIVAL: 'LATE_ARRIVAL',
  EARLY_EXIT: 'EARLY_EXIT',
  WORKED_HOLIDAY: 'WORKED_HOLIDAY',
  WORKED_WEEKLY_OFF: 'WORKED_WEEKLY_OFF',
  COMP_OFF_EARNED: 'COMP_OFF_EARNED',
});

export const BLOCKER_CODES = new Set([
  FINALIZATION_ISSUE.OPEN_SESSION,
  FINALIZATION_ISSUE.MISSING_PUNCH,
  FINALIZATION_ISSUE.REGULARIZATION_PENDING,
  FINALIZATION_ISSUE.ATTENDANCE_ON_LEAVE,
  FINALIZATION_ISSUE.PENDING_OT,
  FINALIZATION_ISSUE.INVALID_FRACTIONS,
  FINALIZATION_ISSUE.UNRESOLVED_DAY,
  FINALIZATION_ISSUE.DOUBLE_BENEFIT,
  FINALIZATION_ISSUE.INVALID_PROJECTION,
]);

export const ISSUE_WORKFLOW = Object.freeze({
  OPEN_SESSION: 'attendance',
  MISSING_PUNCH: 'regularizations',
  REGULARIZATION_PENDING: 'regularizations',
  ATTENDANCE_ON_LEAVE: 'leaves',
  PENDING_OT: 'overtime',
  INVALID_FRACTIONS: 'attendance',
  UNRESOLVED_DAY: 'schedules',
  DOUBLE_BENEFIT: 'overtime',
  INVALID_PROJECTION: 'attendance',
  LATE_ARRIVAL: 'attendance',
  EARLY_EXIT: 'attendance',
  WORKED_HOLIDAY: 'attendance',
  WORKED_WEEKLY_OFF: 'attendance',
  COMP_OFF_EARNED: 'overtime',
});

// 31.7 fraction integrity: each dimension in [0,1], combined day
// units never exceed one full day (float dust tolerated). A
// full-day Present(1) + Leave(1) without conflict shape is the
// canonical violation (sum 2).
export const fractionsValid = (fractions = null) => {
  const dims = [fractions?.worked, fractions?.leave, fractions?.absent];
  if (dims.some((value) => typeof value !== 'number' || Number.isNaN(value))) return false;
  if (dims.some((value) => value < 0 || value > 1)) return false;
  return dims[0] + dims[1] + dims[2] <= 1.001;
};

// Pure single-day validation. Consumes a 31.10 day object plus:
// - applicable: inside the employment window (pre-DOJ/post-LWD
//   days are skipped by the caller, never validated)
// - hasScheduleSetup: false when the company has NO schedule
//   masters at all — unresolved-expectation days then fall back
//   to the legacy absent reading (29.5 parity) instead of
//   blocking every company that never configured shifts.
export const validateDay = ({ day = null, applicable = true, hasScheduleSetup = true } = {}) => {
  if (!applicable) return [];
  if (!day || typeof day !== 'object' || !day.date) {
    return [{ code: FINALIZATION_ISSUE.INVALID_PROJECTION, severity: ISSUE_SEVERITY.BLOCKER }];
  }
  const issues = [];
  const block = (code) => issues.push({ code, severity: ISSUE_SEVERITY.BLOCKER });
  const warn = (code) => issues.push({ code, severity: ISSUE_SEVERITY.WARNING });

  if (!day.bucket) block(FINALIZATION_ISSUE.INVALID_PROJECTION);
  if (!fractionsValid(day.fractions)) block(FINALIZATION_ISSUE.INVALID_FRACTIONS);

  // Same qualifying day must never become payable OT + comp-off.
  if (Number(day.approvedOtMinutes) > 0 && Number(day.compOffDays) > 0) {
    block(FINALIZATION_ISSUE.DOUBLE_BENEFIT);
  }

  if (day.sessionOpen === true) block(FINALIZATION_ISSUE.OPEN_SESSION);

  const flags = Array.isArray(day.exceptions) ? day.exceptions : [];
  if (flags.includes('MISSING_PUNCH')) block(FINALIZATION_ISSUE.MISSING_PUNCH);
  if (flags.includes('REGULARIZATION_PENDING')) block(FINALIZATION_ISSUE.REGULARIZATION_PENDING);
  if (flags.includes('ATTENDANCE_ON_LEAVE')) block(FINALIZATION_ISSUE.ATTENDANCE_ON_LEAVE);
  if (flags.includes('LATE_ARRIVAL')) warn(FINALIZATION_ISSUE.LATE_ARRIVAL);
  if (flags.includes('EARLY_EXIT')) warn(FINALIZATION_ISSUE.EARLY_EXIT);

  if (day.ot?.status === 'PENDING') block(FINALIZATION_ISSUE.PENDING_OT);

  if (day.bucket === 'UNRESOLVED' && hasScheduleSetup) block(FINALIZATION_ISSUE.UNRESOLVED_DAY);

  if (day.hasSession === true && day.calendarPrimary === 'HOLIDAY') {
    warn(FINALIZATION_ISSUE.WORKED_HOLIDAY);
  }
  if (day.hasSession === true && day.calendarPrimary === 'WEEKLY_OFF') {
    warn(FINALIZATION_ISSUE.WORKED_WEEKLY_OFF);
  }
  // Comp-off is a leave/time entitlement, never payroll OT — the
  // warning keeps the exclusion visible in the report.
  if (Number(day.compOffDays) > 0) warn(FINALIZATION_ISSUE.COMP_OFF_EARNED);

  return issues;
};

export const isBlocker = (issue) => BLOCKER_CODES.has(issue?.code);

export const readinessOf = (issues = []) => {
  const list = Array.isArray(issues) ? issues : [];
  const blockers = list.filter(isBlocker).length;
  return {
    ready: blockers === 0,
    blockers,
    warnings: list.length - blockers,
    total: list.length,
  };
};

// ── Payroll gates (pure; the service supplies live state) ──────
// Three guarded operations share the irreversibility gates; send
// additionally requires a writable payroll period. Every refusal
// carries a human reason for the UI.

const REVIEW_BLOCKING = ['LOCKED', 'PENDING_FINANCE_APPROVAL', 'APPROVED'];
const PAYMENT_OPEN_OK = [null, undefined, '', 'DRAFT', 'FAILED', 'CANCELLED'];

export const payrollGates = ({
  periodStatus = null,
  runStatus = null,
  reviewStatus = null,
  paymentBatchStatus = null,
  anyEmployeePaid = false,
  anyPayslipReleased = false,
} = {}) => {
  const irreversible = [];
  if (periodStatus === 'SENT_TO_PAYROLL') {
    irreversible.push('Payroll inputs are SENT_TO_PAYROLL — payroll must reopen them before attendance can change.');
  }
  if (runStatus === 'CALCULATING') {
    irreversible.push('A payroll run is in progress — retry when it finishes.');
  }
  if (REVIEW_BLOCKING.includes(reviewStatus)) {
    irreversible.push(`Payroll review is ${String(reviewStatus).toLowerCase().replace(/_/g, ' ')} — reopen it in payroll first.`);
  }
  if (!PAYMENT_OPEN_OK.includes(paymentBatchStatus)) {
    irreversible.push('A payroll payment batch already exists for this month — attendance is frozen.');
  }
  if (anyEmployeePaid === true) {
    irreversible.push('Salaries are already paid for this month — attendance cannot be reopened.');
  }
  if (anyPayslipReleased === true) {
    irreversible.push('Payslips are already released for this month — attendance cannot be reopened.');
  }

  const reopen = { allowed: irreversible.length === 0, reasons: [...irreversible] };
  const finalize = { allowed: irreversible.length === 0, reasons: [...irreversible] };

  const sendReasons = [...irreversible];
  if (periodStatus === 'LOCKED') {
    sendReasons.push('Payroll inputs are LOCKED — reopen them in payroll inputs before sending.');
  }
  const send = { allowed: sendReasons.length === 0, reasons: sendReasons };

  return { reopen, finalize, send };
};

// ── Snapshot aggregation (pure) ─────────────────────────────────

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

const LEAVE_BUCKETS = ['CASUAL', 'SICK', 'EARNED'];

// Effective bucket for snapshot/validation: with NO schedule setup
// in the company, an UNRESOLVED past day reads as ABSENT (29.5
// legacy parity — the old import treated every unworked elapsed
// workday as absent). With masters present, UNRESOLVED stays a
// blocker (assignment gap to fix).
export const effectiveBucket = ({ bucket, hasScheduleSetup = true } = {}) =>
  bucket === 'UNRESOLVED' && !hasScheduleSetup ? 'ABSENT' : bucket;

// Compact frozen day row (schema-shaped, no PII).
export const compactDay = (day = {}) => ({
  date: day.date || '',
  bucket: day.bucket || '',
  worked: round2(day.fractions?.worked),
  leave: round2(day.fractions?.leave),
  absent: round2(day.fractions?.absent),
  workMode: day.workMode || null,
  workedMinutes: Math.max(0, Math.trunc(Number(day.workedMinutes) || 0)),
  breakMinutes: Math.max(0, Math.trunc(Number(day.breakMinutes) || 0)),
  lateMinutes: Math.max(0, Math.trunc(Number(day.actual?.lateMinutes) || 0)),
  earlyMinutes: Math.max(0, Math.trunc(Number(day.actual?.earlyMinutes) || 0)),
  exceptions: [...(Array.isArray(day.exceptions) ? day.exceptions : [])].sort(),
  approvedOtMinutes: Math.max(0, Math.trunc(Number(day.approvedOtMinutes) || 0)),
  compOffDays: round2(day.compOffDays),
  leaveType: day.calendar?.leave?.type || null,
  leaveId: day.calendar?.leave?.leaveId || null,
  holiday: day.calendarPrimary === 'HOLIDAY',
  weeklyOff: day.calendarPrimary === 'WEEKLY_OFF',
  regularized: day.regularized === true,
  scheduledWorkingDay: day.scheduledWorkingDay === true,
  overnightScheduled: day.schedule?.crossesMidnight === true,
});

// Whole-employee snapshot body from scoped 31.10 days. Returns the
// schema-shaped aggregates + compact days (employee keying and
// versioning are the service's job).
export const deriveEmployeeSnapshot = ({ days = [], hasScheduleSetup = true } = {}) => {
  const list = Array.isArray(days) ? days : [];
  const body = {
    scheduledWorkingDays: 0,
    scopedDays: list.length,
    preJoiningDays: 0,
    postExitDays: 0,
    equivalents: { worked: 0, leave: 0, absent: 0 },
    dayCounts: {
      present: 0, halfDay: 0, absent: 0, leave: 0, holiday: 0, weeklyOff: 0, unresolved: 0,
    },
    leaveUnitsByType: { CASUAL: 0, SICK: 0, EARNED: 0, OTHER: 0 },
    leaveIds: [],
    workedMinutes: 0,
    breakMinutes: 0,
    lateDays: 0,
    earlyExitDays: 0,
    approvedOtMinutes: 0,
    compOffDays: 0,
    workedOnHolidayDays: 0,
    workedOnWeeklyOffDays: 0,
    overnightScheduledDays: 0,
    regularizedDays: 0,
    days: [],
  };
  const seenLeaveIds = new Set();
  for (const day of list) {
    const bucket = effectiveBucket({ bucket: day?.bucket, hasScheduleSetup });
    const row = compactDay({ ...day, bucket });
    body.days.push(row);
    if (row.scheduledWorkingDay) body.scheduledWorkingDays += 1;
    body.equivalents.worked += row.worked;
    body.equivalents.leave += row.leave;
    body.equivalents.absent += row.absent;
    const countKey = {
      PRESENT: 'present', HALF_DAY: 'halfDay', ABSENT: 'absent', LEAVE: 'leave',
      HOLIDAY: 'holiday', WEEKLY_OFF: 'weeklyOff', UNRESOLVED: 'unresolved',
    }[bucket];
    if (countKey) body.dayCounts[countKey] += 1;
    if (row.leave > 0) {
      const type = LEAVE_BUCKETS.includes(row.leaveType) ? row.leaveType : 'OTHER';
      body.leaveUnitsByType[type] = round2(body.leaveUnitsByType[type] + row.leave);
      if (row.leaveId && !seenLeaveIds.has(row.leaveId)) {
        seenLeaveIds.add(row.leaveId);
        body.leaveIds.push(row.leaveId);
      }
    }
    body.workedMinutes += row.workedMinutes;
    body.breakMinutes += row.breakMinutes;
    if (row.lateMinutes > 0) body.lateDays += 1;
    if (row.earlyMinutes > 0) body.earlyExitDays += 1;
    body.approvedOtMinutes += row.approvedOtMinutes;
    body.compOffDays = round2(body.compOffDays + row.compOffDays);
    if (day?.hasSession === true && row.holiday) body.workedOnHolidayDays += 1;
    if (day?.hasSession === true && row.weeklyOff) body.workedOnWeeklyOffDays += 1;
    if (row.overnightScheduled) body.overnightScheduledDays += 1;
    if (row.regularized) body.regularizedDays += 1;
  }
  body.equivalents.worked = round2(body.equivalents.worked);
  body.equivalents.leave = round2(body.equivalents.leave);
  body.equivalents.absent = round2(body.equivalents.absent);
  return body;
};

// Month aggregates over employee snapshot bodies (history summary
// + preview KPIs). Counts only — no PII.
export const aggregateMonth = (snapshots = []) => {
  const total = {
    employees: snapshots.length,
    scheduledWorkingDays: 0,
    scopedDays: 0,
    workedUnits: 0,
    leaveUnits: 0,
    absentUnits: 0,
    presentDays: 0,
    halfDays: 0,
    absentDays: 0,
    leaveDays: 0,
    holidayDays: 0,
    weeklyOffDays: 0,
    unresolvedDays: 0,
    workedMinutes: 0,
    lateDays: 0,
    approvedOtMinutes: 0,
    compOffDays: 0,
  };
  for (const snap of snapshots) {
    total.scheduledWorkingDays += Number(snap?.scheduledWorkingDays) || 0;
    total.scopedDays += Number(snap?.scopedDays) || 0;
    total.workedUnits = round2(total.workedUnits + (Number(snap?.equivalents?.worked) || 0));
    total.leaveUnits = round2(total.leaveUnits + (Number(snap?.equivalents?.leave) || 0));
    total.absentUnits = round2(total.absentUnits + (Number(snap?.equivalents?.absent) || 0));
    total.presentDays += Number(snap?.dayCounts?.present) || 0;
    total.halfDays += Number(snap?.dayCounts?.halfDay) || 0;
    total.absentDays += Number(snap?.dayCounts?.absent) || 0;
    total.leaveDays += Number(snap?.dayCounts?.leave) || 0;
    total.holidayDays += Number(snap?.dayCounts?.holiday) || 0;
    total.weeklyOffDays += Number(snap?.dayCounts?.weeklyOff) || 0;
    total.unresolvedDays += Number(snap?.dayCounts?.unresolved) || 0;
    total.workedMinutes += Number(snap?.workedMinutes) || 0;
    total.lateDays += Number(snap?.lateDays) || 0;
    total.approvedOtMinutes += Number(snap?.approvedOtMinutes) || 0;
    total.compOffDays = round2(total.compOffDays + (Number(snap?.compOffDays) || 0));
  }
  return total;
};

// ── 29.5 auto mapping (pure; the sync boundary, testable) ──────
// Maps a frozen snapshot body onto the EmployeeMonthlyInput.auto
// shape. DELIBERATE contract correction (§R.1): absentDays/lopDays
// are leave-aware (equivalents.absent), where 29.5's legacy import
// formula (working − counted) silently charged leave days as LOP.
// The engine reads lopDays only, so payroll money gets the truth.
//
// Comp-off NEVER maps to OT (mutual exclusion is validated above).
// lopSource stays ATTENDANCE — the repo has no LOP leave type.
export const buildAutoFromSnapshot = ({ snapshot = {}, otPolicy = null } = {}) => ({
  workingDays: Number(snapshot.scheduledWorkingDays) || 0,
  presentDays: round2(snapshot.equivalents?.worked),
  absentDays: round2(snapshot.equivalents?.absent),
  lateMarks: Number(snapshot.lateDays) || 0,
  halfDays: Number(snapshot.dayCounts?.halfDay) || 0,
  paidLeaveDays: round2(snapshot.equivalents?.leave),
  leaveBreakdown: {
    CASUAL: round2(snapshot.leaveUnitsByType?.CASUAL),
    SICK: round2(snapshot.leaveUnitsByType?.SICK),
    EARNED: round2(snapshot.leaveUnitsByType?.EARNED),
    OTHER: round2(snapshot.leaveUnitsByType?.OTHER),
  },
  lopDays: round2(snapshot.equivalents?.absent),
  lopHours: 0,
  lopSource: 'ATTENDANCE',
  lopLeaveIds: [],
  otMinutes: Math.max(0, Math.trunc(Number(snapshot.approvedOtMinutes) || 0)),
  otHours: round2((Number(snapshot.approvedOtMinutes) || 0) / 60),
  otPolicy: {
    enabled: Boolean(otPolicy?.enabled),
    basis: otPolicy?.basis || 'HOURLY',
    multiplier: Number(otPolicy?.multiplier) || 1,
  },
  nightShiftCount: Number(snapshot.overnightScheduledDays) || 0,
  weekendShiftCount: Number(snapshot.workedOnWeeklyOffDays) || 0,
  holidayShiftCount: Number(snapshot.workedOnHolidayDays) || 0,
});

// ── Fingerprint (deterministic integrity hash) ───────────────────
// Canonical JSON over sorted employee facts — ids only, no PII, no
// names. Same facts ⇒ same hash; any tampering or partial write ⇒
// mismatch at send time.

export const canonicalFacts = (entries = []) => {
  const sorted = [...entries]
    .map((entry) => ({
      employeeId: String(entry?.employeeId || ''),
      body: entry?.body || {},
    }))
    .sort((a, b) => (a.employeeId < b.employeeId ? -1 : 1));
  return JSON.stringify(sorted);
};

export const fingerprintOf = (entries = []) =>
  createHash('sha256').update(canonicalFacts(entries), 'utf8').digest('hex');
