// ─────────────────────────────────────────────────────────────
// Phase 31.1 — pure attendance policy rules.
//
// Deterministic and side-effect-free: no Mongo, no req/res, no Redis,
// no payroll DB calls. Intl-based time math only (no I/O).
//
// Separation of concepts (never one giant status):
//   DAILY_OUTCOME — what the day counts as
//   WORK_MODE     — where/how the person worked (orthogonal to outcome)
//   LIVE_STATE    — future 31.2 live presence contract (vocabulary only)
//   EXCEPTION     — what needs attention (late/early/short/missing/...)
//   EVENT_TYPE / EVENT_SOURCE — future 31.2+ contracts (vocabulary only)
//
// Time unit: integer MINUTES everywhere. Money: never here.
// ─────────────────────────────────────────────────────────────

// ── Controlled vocabularies ──────────────────────────────────

export const DAILY_OUTCOME = Object.freeze({
  PRESENT: 'PRESENT',
  ABSENT: 'ABSENT',
  HALF_DAY: 'HALF_DAY',
  NON_WORKING_DAY: 'NON_WORKING_DAY',
  UNRESOLVED: 'UNRESOLVED',
});

export const WORK_MODE = Object.freeze({
  OFFICE: 'OFFICE',
  WFH: 'WFH',
  FIELD: 'FIELD',
  CLIENT_SITE: 'CLIENT_SITE',
  BUSINESS_TRAVEL: 'BUSINESS_TRAVEL',
});

export const LIVE_STATE = Object.freeze({
  NOT_IN: 'NOT_IN',
  WORKING: 'WORKING',
  ON_BREAK: 'ON_BREAK',
  COMPLETED: 'COMPLETED',
});

export const EXCEPTION_CODE = Object.freeze({
  LATE_IN: 'LATE_IN',
  EARLY_OUT: 'EARLY_OUT',
  SHORT_HOURS: 'SHORT_HOURS',
  MISSED_IN: 'MISSED_IN',
  MISSED_OUT: 'MISSED_OUT',
  INCOMPLETE_BREAK: 'INCOMPLETE_BREAK',
  OUTSIDE_GEOFENCE: 'OUTSIDE_GEOFENCE',
});

export const EVENT_TYPE = Object.freeze({
  CLOCK_IN: 'CLOCK_IN',
  BREAK_START: 'BREAK_START',
  BREAK_END: 'BREAK_END',
  CLOCK_OUT: 'CLOCK_OUT',
});

export const EVENT_SOURCE = Object.freeze({
  WEB: 'WEB',
  KIOSK: 'KIOSK',
  QR: 'QR',
  IMPORT: 'IMPORT',
  DEVICE: 'DEVICE',
  MANUAL: 'MANUAL',
});

// Calendar context supplied EXPLICITLY by the caller (Holiday, Work
// Schedule and Leave remain authoritative — this engine queries nothing).
export const DAY_TYPE = Object.freeze({
  WORK_DAY: 'WORK_DAY',
  WEEKLY_OFF: 'WEEKLY_OFF',
  HOLIDAY: 'HOLIDAY',
});

export const LEAVE_CONTEXT = Object.freeze({
  NONE: 'NONE',
  FULL_DAY: 'FULL_DAY',
  HALF_DAY: 'HALF_DAY',
});

export const LOCATION_ENFORCEMENT_RULE = Object.freeze({
  DISABLED: 'DISABLED',
  OPTIONAL: 'OPTIONAL',
  REQUIRED: 'REQUIRED',
});

// ── Bounds ───────────────────────────────────────────────────

export const MINUTES_PER_DAY = 1440;
export const MAX_GRACE_MINUTES = 120;
export const MAX_REGULARIZATION_WINDOW_DAYS = 31;

const isInt = (value) => Number.isInteger(value);

// ── Timezone helpers (pure) ──────────────────────────────────

export const isValidTimeZone = (timeZone) => {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

// 'YYYY-MM-DD' for an instant in an explicit zone. Never server-local.
export const dayKeyInZone = (date, timeZone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(date));

// Minutes since midnight in an explicit zone (0..1439).
export const minutesSinceMidnightInZone = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(date));

  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);

  return hour * 60 + minute;
};

// Overnight-safe end: an end at-or-before start belongs to next day.
// Cross-midnight contract for 31.6: clock-outs past midnight are
// expressed as minutes > 1440 from the clock-in day's midnight.
export const shiftEndMinutes = (startMinutes, endMinutes) =>
  endMinutes <= startMinutes ? endMinutes + MINUTES_PER_DAY : endMinutes;

// Canonical defaults for a fresh company (mirrors the model defaults).
// Draft input is section-granular: each supplied section replaces the
// whole section, missing sections fall back to these defaults.
export const defaultPolicyInput = () => ({
  name: 'Attendance Policy',
  description: '',
  timezone: 'Asia/Kolkata',
  locationEnforcement: 'DISABLED',
  thresholds: { fullDayMinutes: 480, halfDayMinutes: 240 },
  grace: { lateInMinutes: 15, earlyOutMinutes: 15 },
  breaks: { enabled: true, includeInWorkedTime: false, dailyLimitMinutes: null },
  missingPunch: { keepUnresolved: true, allowRegularization: true, regularizationWindowDays: 7 },
  overtime: {
    trackingEnabled: false,
    minimumExtraMinutes: 30,
    approvalRequired: true,
    weekendEligible: false,
    holidayEligible: false,
  },
  weekendHoliday: { allowWorkOnWeeklyOff: true, allowWorkOnHoliday: true },
  workModes: { office: true, wfh: false, field: false, clientSite: false, businessTravel: false },
});

// ── Policy validation (pure) ─────────────────────────────────

export const validateThresholds = (thresholds = {}) => {
  const errors = [];
  const { fullDayMinutes, halfDayMinutes } = thresholds;

  if (!isInt(fullDayMinutes) || fullDayMinutes < 1 || fullDayMinutes > MINUTES_PER_DAY) {
    errors.push('thresholds.fullDayMinutes must be an integer between 1 and 1440');
  }

  if (!isInt(halfDayMinutes) || halfDayMinutes < 0 || halfDayMinutes > MINUTES_PER_DAY) {
    errors.push('thresholds.halfDayMinutes must be an integer between 0 and 1440');
  }

  if (
    errors.length === 0 &&
    !(halfDayMinutes < fullDayMinutes)
  ) {
    errors.push('thresholds.halfDayMinutes must be less than thresholds.fullDayMinutes');
  }

  return errors;
};

export const validateGrace = (grace = {}) => {
  const errors = [];
  const { lateInMinutes, earlyOutMinutes } = grace;

  if (!isInt(lateInMinutes) || lateInMinutes < 0 || lateInMinutes > MAX_GRACE_MINUTES) {
    errors.push(`grace.lateInMinutes must be an integer between 0 and ${MAX_GRACE_MINUTES}`);
  }

  if (!isInt(earlyOutMinutes) || earlyOutMinutes < 0 || earlyOutMinutes > MAX_GRACE_MINUTES) {
    errors.push(`grace.earlyOutMinutes must be an integer between 0 and ${MAX_GRACE_MINUTES}`);
  }

  return errors;
};

export const validateBreaks = (breaks = {}) => {
  const errors = [];

  if (typeof breaks.enabled !== 'boolean') {
    errors.push('breaks.enabled must be a boolean');
  }

  if (typeof breaks.includeInWorkedTime !== 'boolean') {
    errors.push('breaks.includeInWorkedTime must be a boolean');
  }

  const { dailyLimitMinutes } = breaks;

  if (
    dailyLimitMinutes !== null &&
    dailyLimitMinutes !== undefined &&
    (!isInt(dailyLimitMinutes) || dailyLimitMinutes < 0 || dailyLimitMinutes > MINUTES_PER_DAY)
  ) {
    errors.push('breaks.dailyLimitMinutes must be null or an integer between 0 and 1440');
  }

  return errors;
};

export const validateMissingPunch = (missingPunch = {}) => {
  const errors = [];

  if (typeof missingPunch.keepUnresolved !== 'boolean') {
    errors.push('missingPunch.keepUnresolved must be a boolean');
  }

  if (typeof missingPunch.allowRegularization !== 'boolean') {
    errors.push('missingPunch.allowRegularization must be a boolean');
  }

  const { regularizationWindowDays } = missingPunch;

  if (
    !isInt(regularizationWindowDays) ||
    regularizationWindowDays < 0 ||
    regularizationWindowDays > MAX_REGULARIZATION_WINDOW_DAYS
  ) {
    errors.push(
      `missingPunch.regularizationWindowDays must be an integer between 0 and ${MAX_REGULARIZATION_WINDOW_DAYS}`,
    );
  }

  return errors;
};

export const validateOvertime = (overtime = {}) => {
  const errors = [];

  if (typeof overtime.trackingEnabled !== 'boolean') {
    errors.push('overtime.trackingEnabled must be a boolean');
  }

  if (
    !isInt(overtime.minimumExtraMinutes) ||
    overtime.minimumExtraMinutes < 0 ||
    overtime.minimumExtraMinutes > MINUTES_PER_DAY
  ) {
    errors.push('overtime.minimumExtraMinutes must be an integer between 0 and 1440');
  }

  if (typeof overtime.approvalRequired !== 'boolean') {
    errors.push('overtime.approvalRequired must be a boolean');
  }

  if (typeof overtime.weekendEligible !== 'boolean') {
    errors.push('overtime.weekendEligible must be a boolean');
  }

  if (typeof overtime.holidayEligible !== 'boolean') {
    errors.push('overtime.holidayEligible must be a boolean');
  }

  return errors;
};

export const validateWeekendHoliday = (weekendHoliday = {}) => {
  const errors = [];

  if (typeof weekendHoliday.allowWorkOnWeeklyOff !== 'boolean') {
    errors.push('weekendHoliday.allowWorkOnWeeklyOff must be a boolean');
  }

  if (typeof weekendHoliday.allowWorkOnHoliday !== 'boolean') {
    errors.push('weekendHoliday.allowWorkOnHoliday must be a boolean');
  }

  return errors;
};

const WORK_MODE_KEYS = ['office', 'wfh', 'field', 'clientSite', 'businessTravel'];

export const validateWorkModes = (workModes = {}) => {
  const errors = [];

  WORK_MODE_KEYS.forEach((key) => {
    if (typeof workModes[key] !== 'boolean') {
      errors.push(`workModes.${key} must be a boolean`);
    }
  });

  if (errors.length > 0) return errors;

  // OFFICE stays available in 31.1 (31.4 owns remote-work workflows).
  if (workModes.office !== true) {
    errors.push('workModes.office must remain enabled');
  }

  return errors;
};

export const validatePolicy = (policy = {}) => {
  const errors = [];

  if (!policy || typeof policy !== 'object') {
    return { valid: false, errors: ['policy must be an object'] };
  }

  if (!policy.name || typeof policy.name !== 'string' || !policy.name.trim()) {
    errors.push('name is required');
  }

  if (policy.name && policy.name.trim().length > 80) {
    errors.push('name must be 80 characters or fewer');
  }

  if (!policy.timezone || typeof policy.timezone !== 'string' || !isValidTimeZone(policy.timezone)) {
    errors.push('timezone must be a valid IANA timezone');
  }

  if (
    policy.locationEnforcement !== undefined &&
    !Object.values(LOCATION_ENFORCEMENT_RULE).includes(policy.locationEnforcement)
  ) {
    errors.push('locationEnforcement must be DISABLED, OPTIONAL, or REQUIRED');
  }

  errors.push(
    ...validateThresholds(policy.thresholds),
    ...validateGrace(policy.grace),
    ...validateBreaks(policy.breaks),
    ...validateMissingPunch(policy.missingPunch),
    ...validateOvertime(policy.overtime),
    ...validateWeekendHoliday(policy.weekendHoliday),
    ...validateWorkModes(policy.workModes),
  );

  return { valid: errors.length === 0, errors };
};

// ── Classification primitives (pure) ─────────────────────────

// worked >= full → PRESENT; >= half → HALF_DAY; else SHORT (the caller
// maps SHORT to ABSENT + SHORT_HOURS per policy semantics).
export const classifyWorkedMinutes = (workedMinutes, thresholds) => {
  const worked = Math.max(0, Math.trunc(Number(workedMinutes) || 0));

  if (worked >= thresholds.fullDayMinutes) {
    return { band: DAILY_OUTCOME.PRESENT, shortfallMinutes: 0 };
  }

  if (worked >= thresholds.halfDayMinutes) {
    return {
      band: DAILY_OUTCOME.HALF_DAY,
      shortfallMinutes: thresholds.fullDayMinutes - worked,
    };
  }

  return {
    band: 'SHORT',
    shortfallMinutes: thresholds.halfDayMinutes - worked,
  };
};

// delay = arrival minutes past scheduled start (>= 0). Late only when the
// delay EXCEEDS grace; lateMinutes reported raw (facts, not charges).
export const detectLate = (arrivalDelayMinutes, lateGraceMinutes) => {
  const delay = Math.max(0, Math.trunc(Number(arrivalDelayMinutes) || 0));
  const grace = Math.max(0, Math.trunc(Number(lateGraceMinutes) || 0));

  return { isLate: delay > grace, lateMinutes: delay };
};

// earlyDeparture = minutes left before scheduled end (>= 0).
export const detectEarlyOut = (earlyDepartureMinutes, earlyGraceMinutes) => {
  const early = Math.max(0, Math.trunc(Number(earlyDepartureMinutes) || 0));
  const grace = Math.max(0, Math.trunc(Number(earlyGraceMinutes) || 0));

  return { isEarly: early > grace, earlyMinutes: early };
};

// Break treatment. excluded (default) = break time does not count as
// work; included = counted up to the daily cap (null = uncapped).
export const applyBreakTreatment = ({ grossMinutes, breakMinutes, breaks }) => {
  const gross = Math.max(0, Math.trunc(Number(grossMinutes) || 0));
  const taken = Math.max(0, Math.trunc(Number(breakMinutes) || 0));

  if (!breaks?.enabled) {
    return { workedMinutes: gross, countedBreakMinutes: 0, cappedBreakMinutes: 0 };
  }

  if (breaks.includeInWorkedTime) {
    const limit = breaks.dailyLimitMinutes ?? null;
    const counted = limit === null ? taken : Math.min(taken, limit);

    return {
      workedMinutes: gross - taken + counted,
      countedBreakMinutes: counted,
      cappedBreakMinutes: taken - counted,
    };
  }

  return {
    workedMinutes: Math.max(0, gross - taken),
    countedBreakMinutes: 0,
    cappedBreakMinutes: 0,
  };
};

// Missing punches are reported, never invented. null/undefined clock
// facts (not zeros) mean "no punch recorded".
export const deriveMissingPunchExceptions = ({ clockIn, clockOut }) => {
  const exceptions = [];

  if (clockIn === null || clockIn === undefined) {
    exceptions.push(EXCEPTION_CODE.MISSED_IN);
  }

  if (clockOut === null || clockOut === undefined) {
    exceptions.push(EXCEPTION_CODE.MISSED_OUT);
  }

  return exceptions;
};

// Eligible OT minutes (TIME only — never money). extraMinutes = worked
// beyond the scheduled span (computed by the caller).
export const deriveOTEligibleMinutes = ({ extraMinutes, overtime, dayType }) => {
  const extra = Math.max(0, Math.trunc(Number(extraMinutes) || 0));

  if (!overtime?.trackingEnabled) {
    return { eligibleMinutes: 0, requiresApproval: Boolean(overtime?.approvalRequired) };
  }

  if (dayType === DAY_TYPE.WEEKLY_OFF && !overtime.weekendEligible) {
    return { eligibleMinutes: 0, requiresApproval: Boolean(overtime.approvalRequired) };
  }

  if (dayType === DAY_TYPE.HOLIDAY && !overtime.holidayEligible) {
    return { eligibleMinutes: 0, requiresApproval: Boolean(overtime.approvalRequired) };
  }

  const minimum = Math.max(0, Math.trunc(Number(overtime.minimumExtraMinutes) || 0));

  if (extra < minimum) {
    return { eligibleMinutes: 0, requiresApproval: Boolean(overtime.approvalRequired) };
  }

  return { eligibleMinutes: extra, requiresApproval: Boolean(overtime.approvalRequired) };
};

// ── Evaluation input validation (pure) ───────────────────────

export const validateEvaluationInput = (input = {}) => {
  const errors = [];
  const { policy, clockIn, clockOut, breakMinutes, workMode, dayType, leave } = input;

  const policyCheck = validatePolicy(policy);

  if (!policyCheck.valid) {
    errors.push(...policyCheck.errors.map((error) => `policy: ${error}`));
  }

  if (!Object.values(DAY_TYPE).includes(dayType)) {
    errors.push('dayType must be WORK_DAY, WEEKLY_OFF, or HOLIDAY');
  }

  const leaveValue = leave ?? LEAVE_CONTEXT.NONE;

  if (!Object.values(LEAVE_CONTEXT).includes(leaveValue)) {
    errors.push('leave must be NONE, FULL_DAY, or HALF_DAY');
  }

  const hasIn = clockIn !== null && clockIn !== undefined;
  const hasOut = clockOut !== null && clockOut !== undefined;

  if (hasIn && (!Number.isFinite(clockIn) || clockIn < 0 || clockIn >= MINUTES_PER_DAY)) {
    errors.push('clockIn must be minutes since midnight (0..1439) or null');
  }

  // clockOut may exceed 1440 for overnight spans (31.6 contract).
  if (hasOut && (!Number.isFinite(clockOut) || clockOut < 0 || clockOut > 2 * MINUTES_PER_DAY)) {
    errors.push('clockOut must be minutes since clock-in midnight (0..2880) or null');
  }

  if (hasIn && hasOut && clockOut < clockIn) {
    errors.push('clockOut must not be before clockIn (express overnight as minutes past 1440)');
  }

  if (breakMinutes !== null && breakMinutes !== undefined) {
    if (!Number.isFinite(breakMinutes) || breakMinutes < 0 || breakMinutes > MINUTES_PER_DAY) {
      errors.push('breakMinutes must be between 0 and 1440 or null');
    }
  }

  if (workMode !== null && workMode !== undefined) {
    if (!Object.values(WORK_MODE).includes(workMode)) {
      errors.push('workMode must be a controlled work mode or null');
    } else if (policy?.workModes) {
      const key = { OFFICE: 'office', WFH: 'wfh', FIELD: 'field', CLIENT_SITE: 'clientSite', BUSINESS_TRAVEL: 'businessTravel' }[workMode];

      if (policy.workModes[key] !== true) {
        errors.push(`workMode ${workMode} is not enabled by the policy`);
      }
    }
  }

  const { scheduledStart, scheduledEnd } = input;

  if (
    (scheduledStart === null || scheduledStart === undefined) !==
    (scheduledEnd === null || scheduledEnd === undefined)
  ) {
    errors.push('scheduledStart and scheduledEnd must both be set or both be null');
  }

  [scheduledStart, scheduledEnd].forEach((value) => {
    if (value !== null && value !== undefined && (!Number.isFinite(value) || value < 0 || value >= MINUTES_PER_DAY)) {
      errors.push('scheduledStart/scheduledEnd must be minutes since midnight (0..1439) or null');
    }
  });

  return { valid: errors.length === 0, errors };
};

// ── Daily evaluation contract (pure) ─────────────────────────
//
// Inputs are explicit facts + calendar/leave CONTEXT (never queried).
// This is the 31.1 engine foundation — it is NOT the production
// attendance writer and MUST NOT rewrite history or payroll.
export const evaluateDay = (input = {}) => {
  const check = validateEvaluationInput(input);

  if (!check.valid) {
    throw new Error(`Invalid evaluation input: ${check.errors.join('; ')}`);
  }

  const {
    policy,
    scheduledStart = null,
    scheduledEnd = null,
    clockIn = null,
    clockOut = null,
    breakMinutes = 0,
    dayType,
    leave = LEAVE_CONTEXT.NONE,
  } = input;

  const hasIn = clockIn !== null && clockIn !== undefined;
  const hasOut = clockOut !== null && clockOut !== undefined;
  const notes = [];

  // ── No punches at all: leave/holiday/week-off/absent resolution ──
  if (!hasIn && !hasOut) {
    if (leave === LEAVE_CONTEXT.FULL_DAY) {
      return emptyResult({ outcome: DAILY_OUTCOME.NON_WORKING_DAY, notes });
    }

    if (dayType !== DAY_TYPE.WORK_DAY) {
      return emptyResult({ outcome: DAILY_OUTCOME.NON_WORKING_DAY, notes });
    }

    // WORK_DAY with no punches: absent (a half-day leave excuses only
    // half the day — the unworked remainder is absence).
    if (leave === LEAVE_CONTEXT.HALF_DAY) {
      notes.push('half-day leave with no punches: unexcused remainder is absence');
    }

    return emptyResult({ outcome: DAILY_OUTCOME.ABSENT, notes });
  }

  // ── Partial punches: identifiable exception, never invented ──
  if (!hasIn || !hasOut) {
    return {
      ...emptyResult({ outcome: DAILY_OUTCOME.UNRESOLVED, notes }),
      exceptions: deriveMissingPunchExceptions({ clockIn, clockOut }),
    };
  }

  // ── Full punches: facts first ──
  if (leave === LEAVE_CONTEXT.FULL_DAY) {
    // Overlap refinement belongs to 31.7; 31.1 evaluates the worked
    // facts and notes the overlap instead of hiding either side.
    notes.push('punches overlap approved full-day leave: work facts evaluated, reconciliation deferred to 31.7');
  }

  const gross = Math.trunc(clockOut - clockIn);
  const treated = applyBreakTreatment({ grossMinutes: gross, breakMinutes, breaks: policy.breaks });
  const { workedMinutes } = treated;

  const exceptions = [];
  let lateMinutes = 0;
  let earlyMinutes = 0;

  if (scheduledStart !== null && scheduledEnd !== null) {
    const late = detectLate(clockIn - scheduledStart, policy.grace.lateInMinutes);

    if (late.isLate) {
      exceptions.push(EXCEPTION_CODE.LATE_IN);
      lateMinutes = late.lateMinutes;
    }

    const end = shiftEndMinutes(scheduledStart, scheduledEnd);
    const early = detectEarlyOut(end - clockOut, policy.grace.earlyOutMinutes);

    if (early.isEarly) {
      exceptions.push(EXCEPTION_CODE.EARLY_OUT);
      earlyMinutes = early.earlyMinutes;
    }
  }

  // ── Non-working days ──
  if (dayType !== DAY_TYPE.WORK_DAY) {
    const allowed =
      dayType === DAY_TYPE.WEEKLY_OFF
        ? policy.weekendHoliday.allowWorkOnWeeklyOff
        : policy.weekendHoliday.allowWorkOnHoliday;

    if (!allowed) {
      notes.push(`work on ${dayType.toLowerCase()} is not accepted by policy: facts kept, outcome stays non-working`);

      return {
        outcome: DAILY_OUTCOME.NON_WORKING_DAY,
        workedMinutes,
        breakMinutes: treated.countedBreakMinutes,
        lateMinutes,
        earlyMinutes,
        eligibleOtMinutes: 0,
        otApprovalRequired: Boolean(policy.overtime.approvalRequired),
        exceptions,
        holidayWorked: dayType === DAY_TYPE.HOLIDAY && workedMinutes > 0,
        weeklyOffWorked: dayType === DAY_TYPE.WEEKLY_OFF && workedMinutes > 0,
        notes,
      };
    }

    const extra = extraBeyondSchedule({ workedMinutes, scheduledStart, scheduledEnd, fallback: policy.thresholds.fullDayMinutes });
    const ot = deriveOTEligibleMinutes({ extraMinutes: extra, overtime: policy.overtime, dayType });

    return {
      outcome: DAILY_OUTCOME.NON_WORKING_DAY,
      workedMinutes,
      breakMinutes: treated.countedBreakMinutes,
      lateMinutes,
      earlyMinutes,
      eligibleOtMinutes: ot.eligibleMinutes,
      otApprovalRequired: ot.requiresApproval,
      exceptions,
      holidayWorked: dayType === DAY_TYPE.HOLIDAY && workedMinutes > 0,
      weeklyOffWorked: dayType === DAY_TYPE.WEEKLY_OFF && workedMinutes > 0,
      notes,
    };
  }

  // ── Working day: threshold classification ──
  const band = classifyWorkedMinutes(workedMinutes, policy.thresholds);

  if (band.band === 'SHORT') {
    exceptions.push(EXCEPTION_CODE.SHORT_HOURS);

    return {
      outcome: DAILY_OUTCOME.ABSENT,
      workedMinutes,
      breakMinutes: treated.countedBreakMinutes,
      lateMinutes,
      earlyMinutes,
      eligibleOtMinutes: 0,
      otApprovalRequired: Boolean(policy.overtime.approvalRequired),
      exceptions,
      holidayWorked: false,
      weeklyOffWorked: false,
      shortfallMinutes: band.shortfallMinutes,
      notes,
    };
  }

  const extra = extraBeyondSchedule({ workedMinutes, scheduledStart, scheduledEnd, fallback: policy.thresholds.fullDayMinutes });
  const ot = deriveOTEligibleMinutes({ extraMinutes: extra, overtime: policy.overtime, dayType });

  return {
    outcome: band.band,
    workedMinutes,
    breakMinutes: treated.countedBreakMinutes,
    lateMinutes,
    earlyMinutes,
    eligibleOtMinutes: ot.eligibleMinutes,
    otApprovalRequired: ot.requiresApproval,
    exceptions,
    holidayWorked: false,
    weeklyOffWorked: false,
    shortfallMinutes: band.shortfallMinutes,
    notes,
  };
};

const emptyResult = ({ outcome, notes }) => ({
  outcome,
  workedMinutes: 0,
  breakMinutes: 0,
  lateMinutes: 0,
  earlyMinutes: 0,
  eligibleOtMinutes: 0,
  otApprovalRequired: false,
  exceptions: [],
  holidayWorked: false,
  weeklyOffWorked: false,
  notes,
});

// Extra time beyond the scheduled span; without a schedule, beyond the
// full-day threshold (flexible-day fallback).
const extraBeyondSchedule = ({ workedMinutes, scheduledStart, scheduledEnd, fallback }) => {
  if (scheduledStart === null || scheduledStart === undefined) {
    return Math.max(0, workedMinutes - fallback);
  }

  const scheduled = shiftEndMinutes(scheduledStart, scheduledEnd) - scheduledStart;

  return Math.max(0, workedMinutes - scheduled);
};

// ── Lifecycle transitions (pure) ─────────────────────────────

export const POLICY_TRANSITIONS = Object.freeze({
  DRAFT: ['ACTIVE'],
  ACTIVE: ['ARCHIVED'],
  ARCHIVED: [],
});

export const canTransitionPolicy = (from, to) =>
  (POLICY_TRANSITIONS[from] || []).includes(to);
