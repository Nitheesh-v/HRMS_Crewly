// ─────────────────────────────────────────────────────────────
// Phase 31.8 — overtime / comp-off pure rules.
//
// Recorded extra time, eligible time, and approved time are THREE
// separate concepts; this module never confuses them and never
// touches money (rates/amounts are exclusively payroll's).
//
// Threshold semantics are 31.1's verbatim: minimumExtraMinutes is
// a MINIMUM GATE — extra >= minimum makes ALL extra eligible
// (deriveOTEligibleMinutes: 45 extra / 30 minimum => 45 eligible).
// 31.8 reuses that function instead of re-implementing it.
//
// Pure: no Mongo, no req/res, no Redis, no payroll, no wall clock.
// ─────────────────────────────────────────────────────────────
import {
  DAY_TYPE,
  deriveOTEligibleMinutes,
} from './attendancePolicyRules.js';
import { RECONCILIATION_CONFLICT } from './attendanceReconciliationRules.js';

export { DAY_TYPE };

// Controlled request types (§13). Never free text.
export const OVERTIME_TYPE = Object.freeze({
  OVERTIME: 'OVERTIME',
  COMP_OFF: 'COMP_OFF',
});

// Lifecycle (§14): PENDING → APPROVED | REJECTED | CANCELLED.
export const OVERTIME_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
});

// Policy benefit disposition per calendar context (§10–§11).
// BOTH is deliberately absent: one benefit disposition per
// approved qualifying block (day).
export const OT_BENEFIT = Object.freeze({
  NONE: 'NONE',
  OVERTIME: 'OVERTIME',
  COMP_OFF: 'COMP_OFF',
});

export const DEFAULT_COMP_OFF_MINUTES_PER_DAY = 480;
export const MAX_MINUTES_PER_DAY = 1440;
export const ELIGIBILITY_RANGE_CAP_DAYS = 93;

const toNonNegativeInt = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
};

// Comp-off conversion divisor. Old policy documents predate the
// field, so an absent/invalid value falls back to the default —
// never to zero (division) and never to a guess per-request.
export const compOffMinutesPerDay = (overtime = {}) => {
  const raw = Number(overtime?.compOffMinutesPerDay);
  if (!Number.isFinite(raw)) return DEFAULT_COMP_OFF_MINUTES_PER_DAY;
  const clamped = Math.trunc(raw);
  if (clamped < 1 || clamped > MAX_MINUTES_PER_DAY) return DEFAULT_COMP_OFF_MINUTES_PER_DAY;
  return clamped;
};

// Benefit disposition for one calendar context (§11).
//
// Old policy documents predate the benefit fields: when the 31.1
// enable flag is on, the 31.1 meaning (OT-eligible) is preserved
// by defaulting to OVERTIME; when the flag is off, NONE wins no
// matter what the benefit field says.
export const resolveBenefit = ({ calendarPrimary, overtime = {} } = {}) => {
  if (!overtime?.trackingEnabled) return OT_BENEFIT.NONE;
  if (calendarPrimary === DAY_TYPE.WORK_DAY) {
    const benefit = overtime.normalDayBenefit ?? OT_BENEFIT.OVERTIME;
    return benefit === OT_BENEFIT.OVERTIME ? OT_BENEFIT.OVERTIME : OT_BENEFIT.NONE;
  }
  if (calendarPrimary === DAY_TYPE.WEEKLY_OFF) {
    if (!overtime.weekendEligible) return OT_BENEFIT.NONE;
    const benefit = overtime.weeklyOffBenefit ?? OT_BENEFIT.OVERTIME;
    return Object.values(OT_BENEFIT).includes(benefit) ? benefit : OT_BENEFIT.NONE;
  }
  if (calendarPrimary === DAY_TYPE.HOLIDAY) {
    if (!overtime.holidayEligible) return OT_BENEFIT.NONE;
    const benefit = overtime.holidayBenefit ?? OT_BENEFIT.OVERTIME;
    return Object.values(OT_BENEFIT).includes(benefit) ? benefit : OT_BENEFIT.NONE;
  }
  return OT_BENEFIT.NONE;
};

// Recorded extra time (§5–§6).
//
// WORK_DAY: schedule-relative WORKED minutes (worked − scheduled),
// so excluded breaks can never inflate OT. The caller supplies the
// authoritative effective worked figure (post-31.5 rebuild); this
// function only frames it against the schedule.
// WEEKLY_OFF / HOLIDAY: no schedule applies — all worked time is
// extra (the threshold gate still applies downstream).
// WORK_DAY without a resolved schedule: { extra: 0,
// scheduleResolved: false } — 31.6 never guesses a schedule.
export const recordedExtraMinutes = ({
  calendarPrimary,
  workedMinutes = 0,
  scheduledMinutes = null,
} = {}) => {
  const worked = toNonNegativeInt(workedMinutes);
  if (calendarPrimary === DAY_TYPE.WEEKLY_OFF || calendarPrimary === DAY_TYPE.HOLIDAY) {
    return { extraMinutes: worked, scheduleResolved: true };
  }
  if (calendarPrimary !== DAY_TYPE.WORK_DAY) {
    return { extraMinutes: 0, scheduleResolved: false };
  }
  // Explicit null check first: Number(null) is 0, which would
  // silently treat "no schedule" as a zero-minute schedule.
  if (scheduledMinutes === null || scheduledMinutes === undefined) {
    return { extraMinutes: 0, scheduleResolved: false };
  }
  const scheduled = Number(scheduledMinutes);
  if (!Number.isFinite(scheduled) || scheduled < 0) {
    return { extraMinutes: 0, scheduleResolved: false };
  }
  return { extraMinutes: Math.max(0, worked - Math.trunc(scheduled)), scheduleResolved: true };
};

// Eligible OT minutes: 31.1's gate, reused verbatim (§4–§5).
// calendarPrimary shares DAY_TYPE's vocabulary, so it maps 1:1.
export const deriveEligibleMinutes = ({ recordedExtra = 0, calendarPrimary, overtime = {} } = {}) =>
  deriveOTEligibleMinutes({
    extraMinutes: toNonNegativeInt(recordedExtra),
    overtime,
    dayType: Object.values(DAY_TYPE).includes(calendarPrimary) ? calendarPrimary : DAY_TYPE.WORK_DAY,
  });

// Whole comp-off days from approved minutes (§20). Leave balances
// can only represent whole working days, so this is a floor —
// leftover minutes are forfeited with the block (one disposition
// per approved qualifying block, §10).
export const compOffDaysFor = ({ approvedMinutes = 0, overtime = {} } = {}) => {
  const approved = toNonNegativeInt(approvedMinutes);
  const perDay = compOffMinutesPerDay(overtime);
  return Math.floor(approved / perDay);
};

// 31.7 conflicts that block unsafe entitlement (§24). Both known
// codes are critical: attendance overlapping approved leave, and
// a leave-half that does not match the worked half. Unknown codes
// fail closed (block) — a future conflict must not silently pass.
export const blockingConflicts = (conflicts = []) =>
  (Array.isArray(conflicts) ? conflicts : []).filter(
    (code) =>
      code === RECONCILIATION_CONFLICT.ATTENDANCE_ON_APPROVED_LEAVE ||
      code === RECONCILIATION_CONFLICT.LEAVE_HALF_MISMATCH ||
      !Object.values(RECONCILIATION_CONFLICT).includes(code),
  );

// State machine guard (§14). Returns null when the transition is
// legal, else the human-readable refusal reason (31.5 convention).
export const transitionError = (status, action) => {
  const target = String(action || '').toUpperCase();
  if (status !== OVERTIME_STATUS.PENDING) {
    return `This request is already ${String(status || 'unknown').toLowerCase()} — only pending requests can be decided`;
  }
  if (!['APPROVE', 'REJECT', 'CANCEL'].includes(target)) {
    return 'Unknown decision — expected approve, reject, or cancel';
  }
  return null;
};

// Requested minutes (§15–§16). The backend recomputes eligible;
// the client figure is validated against it, never trusted.
export const validateRequestedMinutes = ({
  requestedMinutes,
  eligibleMinutes = 0,
  type,
  overtime = {},
} = {}) => {
  const requested = Number(requestedMinutes);
  if (!Number.isInteger(requested) || requested < 1) {
    return 'Requested minutes must be a whole number of at least 1';
  }
  if (requested > MAX_MINUTES_PER_DAY) {
    return `Requested minutes cannot exceed ${MAX_MINUTES_PER_DAY} for one day`;
  }
  const eligible = toNonNegativeInt(eligibleMinutes);
  if (requested > eligible) {
    return `You can request at most ${eligible} eligible minute(s) for this day`;
  }
  if (type === OVERTIME_TYPE.COMP_OFF) {
    const perDay = compOffMinutesPerDay(overtime);
    if (requested < perDay) {
      return `A comp-off request needs at least ${perDay} minutes (1 day)`;
    }
  }
  return null;
};

// Approved minutes: the reviewer may approve less than requested
// (partial approval), never more than requested or eligible, and
// a comp-off approval must still convert to at least 1 day.
export const validateApprovedMinutes = ({
  approvedMinutes,
  requestedMinutes,
  eligibleMinutes = 0,
  type,
  overtime = {},
} = {}) => {
  const approved = Number(approvedMinutes);
  if (!Number.isInteger(approved) || approved < 1) {
    return 'Approved minutes must be a whole number of at least 1';
  }
  const requested = toNonNegativeInt(requestedMinutes);
  if (approved > requested) {
    return `You can approve at most the requested ${requested} minute(s)`;
  }
  const eligible = toNonNegativeInt(eligibleMinutes);
  if (approved > eligible) {
    return `You can approve at most ${eligible} eligible minute(s) — the day changed, ask for a resubmission`;
  }
  if (type === OVERTIME_TYPE.COMP_OFF) {
    const perDay = compOffMinutesPerDay(overtime);
    if (approved < perDay) {
      return `A comp-off approval needs at least ${perDay} minutes (1 day)`;
    }
  }
  return null;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isValidDayString = (value) =>
  typeof value === 'string' && DAY_RE.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());

export const monthOf = (dayString) =>
  isValidDayString(dayString) ? dayString.slice(0, 7) : null;

// Bounded eligibility range (GET never mutates; the cap keeps a
// range read cheap). Returns { from, to } or { error }.
export const validateDayRange = ({ from, to, capDays = ELIGIBILITY_RANGE_CAP_DAYS } = {}) => {
  if (!isValidDayString(from) || !isValidDayString(to)) {
    return { error: 'from and to must be YYYY-MM-DD day strings' };
  }
  if (from > to) {
    return { error: 'from cannot be after to' };
  }
  const days =
    Math.round(
      (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000,
    ) + 1;
  if (days > capDays) {
    return { error: `Date range cannot exceed ${capDays} days` };
  }
  return { from, to };
};

export const eachDayInRange = (from, to) => {
  const days = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
};

export const validateReason = (reason, { field = 'reason', max = 300 } = {}) => {
  if (typeof reason !== 'string' || !reason.trim()) {
    return `${field} is required`;
  }
  if (reason.trim().length > max) {
    return `${field} cannot exceed ${max} characters`;
  }
  return null;
};
