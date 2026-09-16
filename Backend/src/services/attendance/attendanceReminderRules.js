// ─────────────────────────────────────────────────────────────
// Phase 31.13 — pure attendance reminder rules.
//
// Deterministic and side-effect-free: no Mongo, no req/res, no Redis,
// no queue, no payroll. Intl-based time formatting only (no I/O).
//
// These rules NEVER modify attendance. They compute reminder due
// instants, evaluate eligibility over caller-fetched facts, and build
// deterministic job ids / event keys. All Mongo reads happen in the
// service layer; all delivery happens in the worker.
//
// Time unit: UTC epoch MILLISECONDS for anchors; integer MINUTES for
// policy offsets. Timezone handling stays with the callers (31.6
// anchors are already zone-aware, including overnight/DST).
// ─────────────────────────────────────────────────────────────

// ── Controlled vocabularies ──────────────────────────────────

export const REMINDER_TYPE = Object.freeze({
  SHIFT_START: 'SHIFT_START',
  MISSING_CLOCK_IN: 'MISSING_CLOCK_IN',
  MISSING_CLOCK_OUT: 'MISSING_CLOCK_OUT',
  INCOMPLETE_BREAK: 'INCOMPLETE_BREAK',
});

// Reconcile-direct reminders: these NEVER become delayed jobs
// (§12: no job-per-request spam). Reconcile revalidates Mongo truth
// and notifies at most once per entity (eventKey dedupe).
export const REVIEW_REMINDER_KIND = Object.freeze({
  REG_REVIEW: 'REG_REVIEW',
  OT_REVIEW: 'OT_REVIEW',
  FINALIZATION_PENDING: 'FINALIZATION_PENDING',
});

export const SKIP_REASON = Object.freeze({
  POLICY_DISABLED: 'POLICY_DISABLED',
  NO_POLICY: 'NO_POLICY',
  NOT_A_WORK_DAY: 'NOT_A_WORK_DAY',
  ON_APPROVED_LEAVE: 'ON_APPROVED_LEAVE',
  ANCHOR_CHANGED: 'ANCHOR_CHANGED',
  ALREADY_CLOCKED_IN: 'ALREADY_CLOCKED_IN',
  ALREADY_CLOCKED_OUT: 'ALREADY_CLOCKED_OUT',
  NO_CLOCK_IN: 'NO_CLOCK_IN',
  BREAK_CLOSED: 'BREAK_CLOSED',
  BREAKS_DISABLED: 'BREAKS_DISABLED',
  EMPLOYEE_INACTIVE: 'EMPLOYEE_INACTIVE',
  ALREADY_NOTIFIED: 'ALREADY_NOTIFIED',
  NOT_PENDING_ANYMORE: 'NOT_PENDING_ANYMORE',
  NOT_YET_DUE: 'NOT_YET_DUE',
  PERIOD_FINALIZED: 'PERIOD_FINALIZED',
  MONTH_NOT_ELAPSED: 'MONTH_NOT_ELAPSED',
});

export const NOTIFICATION_CHANNEL = Object.freeze({
  INAPP: 'inapp',
  EMAIL: 'email',
});

// ── Policy bounds (§4: bounded minutes, reasonable maximums) ──

export const NOTIFICATION_BOUNDS = Object.freeze({
  minutesBefore: { min: 0, max: 180 },
  minutesAfter: { min: 0, max: 720 },
  breakMinutesAfter: { min: 15, max: 720 },
});

// Secure defaults: every reminder type is OFF until HR opts in,
// so enabling 31.13 never surprises an existing tenant.
export const NOTIFICATION_DEFAULTS = Object.freeze({
  shiftStart: Object.freeze({ enabled: false, minutesBefore: 30 }),
  missingClockIn: Object.freeze({ enabled: false, minutesAfter: 30 }),
  missingClockOut: Object.freeze({ enabled: false, minutesAfter: 30 }),
  incompleteBreak: Object.freeze({ enabled: false, minutesAfter: 45 }),
});

// Operational thresholds (not policy: no authoritative source
// exists, so constants + documentation instead of invented UI).
export const REVIEW_PENDING_THRESHOLD_MS = 24 * 3600 * 1000; // PENDING older than 24h

// Reconcile / hook bounds (bounded fan-out, §12/§13).
export const REMINDER_RECONCILE_BOUNDS = Object.freeze({
  maxCompaniesPerRun: 50,
  maxEmployeesPerCompany: 500,
  forwardWindowDays: 2, // today + tomorrow per company tz
  shiftHookHorizonDays: 7, // reactive scheduling after assignment
  departmentHookMaxUsers: 200,
});

// ── Policy validation (pure; wired into validateAttendancePolicy) ─

const isInt = (value) => Number.isInteger(value);

const checkMinutes = (errors, path, value, { min, max }) => {
  if (value === undefined) return; // absent = default applies
  if (!isInt(value) || value < min || value > max) {
    errors.push(`${path} must be an integer between ${min} and ${max}`);
  }
};

export const validateNotificationsConfig = (notifications) => {
  const errors = [];
  if (notifications === undefined || notifications === null) return errors;
  if (typeof notifications !== 'object' || Array.isArray(notifications)) {
    return ['notifications must be an object'];
  }
  const sections = ['shiftStart', 'missingClockIn', 'missingClockOut', 'incompleteBreak'];
  for (const section of sections) {
    const node = notifications[section];
    if (node === undefined || node === null) continue;
    if (typeof node !== 'object' || Array.isArray(node)) {
      errors.push(`notifications.${section} must be an object`);
      continue;
    }
    if (node.enabled !== undefined && typeof node.enabled !== 'boolean') {
      errors.push(`notifications.${section}.enabled must be a boolean`);
    }
  }
  checkMinutes(
    errors,
    'notifications.shiftStart.minutesBefore',
    notifications.shiftStart?.minutesBefore,
    NOTIFICATION_BOUNDS.minutesBefore
  );
  checkMinutes(
    errors,
    'notifications.missingClockIn.minutesAfter',
    notifications.missingClockIn?.minutesAfter,
    NOTIFICATION_BOUNDS.minutesAfter
  );
  checkMinutes(
    errors,
    'notifications.missingClockOut.minutesAfter',
    notifications.missingClockOut?.minutesAfter,
    NOTIFICATION_BOUNDS.minutesAfter
  );
  checkMinutes(
    errors,
    'notifications.incompleteBreak.minutesAfter',
    notifications.incompleteBreak?.minutesAfter,
    NOTIFICATION_BOUNDS.breakMinutesAfter
  );
  return errors;
};

// Defensive read for policy documents that predate 31.13 (31.8
// precedent): missing sections fall back to secure defaults.
export const normalizeNotificationsConfig = (notifications) => {
  const source = notifications && typeof notifications === 'object' ? notifications : {};
  const pick = (key, minuteKey, fallbackMinutes) => {
    const node = source[key] && typeof source[key] === 'object' ? source[key] : {};
    const minutes = isInt(node[minuteKey]) ? node[minuteKey] : fallbackMinutes;
    return {
      enabled: node.enabled === true,
      [minuteKey]: minutes,
    };
  };
  return {
    shiftStart: pick('shiftStart', 'minutesBefore', NOTIFICATION_DEFAULTS.shiftStart.minutesBefore),
    missingClockIn: pick('missingClockIn', 'minutesAfter', NOTIFICATION_DEFAULTS.missingClockIn.minutesAfter),
    missingClockOut: pick('missingClockOut', 'minutesAfter', NOTIFICATION_DEFAULTS.missingClockOut.minutesAfter),
    incompleteBreak: pick('incompleteBreak', 'minutesAfter', NOTIFICATION_DEFAULTS.incompleteBreak.minutesAfter),
  };
};

export const isReminderEnabled = (notifications, reminderType) => {
  const config = normalizeNotificationsConfig(notifications);
  switch (reminderType) {
    case REMINDER_TYPE.SHIFT_START:
      return config.shiftStart.enabled;
    case REMINDER_TYPE.MISSING_CLOCK_IN:
      return config.missingClockIn.enabled;
    case REMINDER_TYPE.MISSING_CLOCK_OUT:
      return config.missingClockOut.enabled;
    case REMINDER_TYPE.INCOMPLETE_BREAK:
      return config.incompleteBreak.enabled;
    default:
      return false;
  }
};

// ── Due-instant calculators (pure arithmetic on UTC instants) ──

const toFiniteMs = (value) => {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : null;
};

export const shiftStartDueMs = (anchorMs, notifications) => {
  const anchor = toFiniteMs(anchorMs);
  if (anchor === null) return null;
  const { minutesBefore } = normalizeNotificationsConfig(notifications).shiftStart;
  return anchor - minutesBefore * 60000;
};

export const missingClockInDueMs = (anchorMs, notifications) => {
  const anchor = toFiniteMs(anchorMs);
  if (anchor === null) return null;
  const { minutesAfter } = normalizeNotificationsConfig(notifications).missingClockIn;
  return anchor + minutesAfter * 60000;
};

export const missingClockOutDueMs = (endAnchorMs, notifications) => {
  const anchor = toFiniteMs(endAnchorMs);
  if (anchor === null) return null;
  const { minutesAfter } = normalizeNotificationsConfig(notifications).missingClockOut;
  return anchor + minutesAfter * 60000;
};

export const incompleteBreakDueMs = (breakStartMs, notifications) => {
  const anchor = toFiniteMs(breakStartMs);
  if (anchor === null) return null;
  const { minutesAfter } = normalizeNotificationsConfig(notifications).incompleteBreak;
  return anchor + minutesAfter * 60000;
};

// ── Eligibility over caller-fetched facts (pure) ─────────────
// Each evaluator receives plain facts (already resolved by the
// service/worker from Mongo) and returns { eligible, reason }.
// reason is null when eligible, else a SKIP_REASON.

export const evaluateShiftStartEligibility = (facts = {}) => {
  if (!facts.policyEnabled) return { eligible: false, reason: SKIP_REASON.POLICY_DISABLED };
  if (!facts.isWorkDay) return { eligible: false, reason: SKIP_REASON.NOT_A_WORK_DAY };
  if (facts.onApprovedLeave) return { eligible: false, reason: SKIP_REASON.ON_APPROVED_LEAVE };
  if (facts.anchorChanged) return { eligible: false, reason: SKIP_REASON.ANCHOR_CHANGED };
  if (facts.hasClockedIn) return { eligible: false, reason: SKIP_REASON.ALREADY_CLOCKED_IN };
  return { eligible: true, reason: null };
};

export const evaluateMissingClockInEligibility = (facts = {}) => {
  if (!facts.policyEnabled) return { eligible: false, reason: SKIP_REASON.POLICY_DISABLED };
  if (!facts.isWorkDay) return { eligible: false, reason: SKIP_REASON.NOT_A_WORK_DAY };
  if (facts.onApprovedLeave) return { eligible: false, reason: SKIP_REASON.ON_APPROVED_LEAVE };
  if (facts.anchorChanged) return { eligible: false, reason: SKIP_REASON.ANCHOR_CHANGED };
  if (facts.hasClockedIn) return { eligible: false, reason: SKIP_REASON.ALREADY_CLOCKED_IN };
  return { eligible: true, reason: null };
};

export const evaluateMissingClockOutEligibility = (facts = {}) => {
  if (!facts.policyEnabled) return { eligible: false, reason: SKIP_REASON.POLICY_DISABLED };
  if (!facts.isWorkDay) return { eligible: false, reason: SKIP_REASON.NOT_A_WORK_DAY };
  if (facts.onApprovedLeave) return { eligible: false, reason: SKIP_REASON.ON_APPROVED_LEAVE };
  if (facts.anchorChanged) return { eligible: false, reason: SKIP_REASON.ANCHOR_CHANGED };
  if (!facts.hasClockedIn) return { eligible: false, reason: SKIP_REASON.NO_CLOCK_IN };
  if (facts.hasClockedOut) return { eligible: false, reason: SKIP_REASON.ALREADY_CLOCKED_OUT };
  return { eligible: true, reason: null };
};

export const evaluateIncompleteBreakEligibility = (facts = {}) => {
  if (!facts.policyEnabled) return { eligible: false, reason: SKIP_REASON.POLICY_DISABLED };
  if (!facts.breaksEnabled) return { eligible: false, reason: SKIP_REASON.BREAKS_DISABLED };
  // Closed-before-stale: a finished break reports BREAK_CLOSED (the
  // accurate business reason), not an anchor mismatch.
  if (!facts.breakStillOpen) return { eligible: false, reason: SKIP_REASON.BREAK_CLOSED };
  if (facts.anchorChanged) return { eligible: false, reason: SKIP_REASON.ANCHOR_CHANGED };
  return { eligible: true, reason: null };
};

export const evaluateReviewEligibility = ({ status, pendingSinceMs, nowMs = Date.now() } = {}) => {
  if (status !== 'PENDING') return { eligible: false, reason: SKIP_REASON.NOT_PENDING_ANYMORE };
  const since = toFiniteMs(pendingSinceMs);
  if (since === null) return { eligible: false, reason: SKIP_REASON.NOT_PENDING_ANYMORE };
  if (nowMs - since < REVIEW_PENDING_THRESHOLD_MS) {
    return { eligible: false, reason: SKIP_REASON.NOT_YET_DUE };
  }
  return { eligible: true, reason: null };
};

export const evaluateFinalizationEligibility = ({ periodStatus, monthElapsed } = {}) => {
  if (!['OPEN', 'REOPENED'].includes(periodStatus)) {
    return { eligible: false, reason: SKIP_REASON.PERIOD_FINALIZED };
  }
  if (!monthElapsed) return { eligible: false, reason: SKIP_REASON.MONTH_NOT_ELAPSED };
  return { eligible: true, reason: null };
};

// ── Deterministic ids + event keys ───────────────────────────

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export const safeIdSegment = (value) =>
  OBJECT_ID_RE.test(String(value || '')) ? String(value).toLowerCase() : '';

export const toDayCompact = (day) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  return match ? `${match[1]}${match[2]}${match[3]}` : '';
};

export const buildAttendanceReminderJobId = (employeeId, reminderType, day, anchorMs) => {
  const employee = safeIdSegment(employeeId);
  const compact = toDayCompact(day);
  const anchor = toFiniteMs(anchorMs);
  if (!employee || !Object.values(REMINDER_TYPE).includes(reminderType) || !compact || anchor === null) {
    return null;
  }
  return `attendance-reminder-${employee}-${reminderType.toLowerCase()}-${compact}-${anchor}`;
};

// In-app + email share the key stem; each channel owns its own
// durable record (Notification / EmailDelivery).
export const buildAttendanceReminderEventKey = (companyId, reminderType, employeeId, day, anchorMs) => {
  const company = safeIdSegment(companyId);
  const employee = safeIdSegment(employeeId);
  const compact = toDayCompact(day);
  const anchor = toFiniteMs(anchorMs);
  if (!company || !Object.values(REMINDER_TYPE).includes(reminderType) || !employee || !compact || anchor === null) {
    return null;
  }
  return `attendance:${reminderType.toLowerCase()}:${company}:${employee}:${compact}:${anchor}`;
};

// Reviewer keys are per-recipient: one durable record per reviewer
// per request. EmailDelivery eventKeys are company-unique, so a
// shared key would email only the first reviewer.
export const buildReviewEventKey = (companyId, kind, entityId, recipientId) => {
  const company = safeIdSegment(companyId);
  const entity = safeIdSegment(entityId);
  const recipient = safeIdSegment(recipientId);
  if (!company || !Object.values(REVIEW_REMINDER_KIND).includes(kind) || !entity || !recipient) return null;
  return `attendance:${kind.toLowerCase()}:${company}:${entity}:${recipient}`;
};

export const buildFinalizationEventKey = (companyId, month, recipientId) => {
  const company = safeIdSegment(companyId);
  const recipient = safeIdSegment(recipientId);
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''));
  if (!company || !validMonth || !recipient) return null;
  return `attendance:finalization_pending:${company}:${month}:${recipient}`;
};

// ── Payload shape (pure check; the worker wraps it) ──────────
// Exact-keys allowlist: references only (ids, day, type, instants).
// Notification bodies, PII, coordinates, money, and reasons can
// never ride the payload — unknown keys fail closed.

export const ATTENDANCE_REMINDER_JOB_KEYS = Object.freeze([
  'companyId',
  'employeeId',
  'attendanceDate',
  'reminderType',
  'anchorIso',
  'correlationId',
]);

export const validateAttendanceReminderPayload = (data) => {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['payload must be an object'] };
  }
  const keys = Object.keys(data);
  const extra = keys.filter((key) => !ATTENDANCE_REMINDER_JOB_KEYS.includes(key));
  if (extra.length) errors.push(`unexpected keys: ${extra.join(',')}`);
  for (const key of ATTENDANCE_REMINDER_JOB_KEYS) {
    if (data[key] === undefined || data[key] === null || data[key] === '') {
      errors.push(`missing: ${key}`);
    }
  }
  if (data.companyId !== undefined && !safeIdSegment(data.companyId)) {
    errors.push('companyId must be an ObjectId string');
  }
  if (data.employeeId !== undefined && !safeIdSegment(data.employeeId)) {
    errors.push('employeeId must be an ObjectId string');
  }
  if (data.attendanceDate !== undefined && !toDayCompact(data.attendanceDate)) {
    errors.push('attendanceDate must be YYYY-MM-DD');
  }
  if (data.reminderType !== undefined && !Object.values(REMINDER_TYPE).includes(data.reminderType)) {
    errors.push('reminderType must be a known reminder type');
  }
  if (data.anchorIso !== undefined && toFiniteMs(data.anchorIso) === null) {
    errors.push('anchorIso must be a valid instant');
  }
  return { valid: errors.length === 0, errors };
};

// ── Copy (pure; time labels formatted in the company zone) ───

export const REMINDER_LINKS = Object.freeze({
  SHIFT_START: '/app/attendance',
  MISSING_CLOCK_IN: '/app/attendance',
  MISSING_CLOCK_OUT: '/app/attendance',
  INCOMPLETE_BREAK: '/app/attendance',
  REG_REVIEW: '/app/attendance/regularizations',
  OT_REVIEW: '/app/attendance/overtime',
  FINALIZATION_PENDING: '/app/attendance/finalization',
});

export const formatTimeInZone = (instantMs, timeZone) => {
  const ms = toFiniteMs(instantMs);
  if (ms === null) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timeZone || 'UTC',
    }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC',
    }).format(new Date(ms));
  }
};

// Neutral copy only: schedule times and operational facts the
// recipient already owns. No reasons, no locations, no money.
export const buildReminderCopy = (reminderType, facts = {}) => {
  switch (reminderType) {
    case REMINDER_TYPE.SHIFT_START:
      return {
        title: 'Shift starting soon',
        message: facts.timeLabel
          ? `Your shift starts at ${facts.timeLabel} — please punch in on time.`
          : 'Your shift starts soon — please punch in on time.',
        link: REMINDER_LINKS.SHIFT_START,
      };
    case REMINDER_TYPE.MISSING_CLOCK_IN:
      return {
        title: 'Missing clock-in',
        message: 'You have not clocked in yet. Please punch in or regularize the day.',
        link: REMINDER_LINKS.MISSING_CLOCK_IN,
      };
    case REMINDER_TYPE.MISSING_CLOCK_OUT:
      return {
        title: 'Missing clock-out',
        message: 'You have not clocked out yet. Please punch out before you leave.',
        link: REMINDER_LINKS.MISSING_CLOCK_OUT,
      };
    case REMINDER_TYPE.INCOMPLETE_BREAK:
      return {
        title: 'Break still open',
        message: facts.minutesOpen
          ? `Your break has been open for over ${facts.minutesOpen} minutes. Please end it when you are back.`
          : 'Your break is still open. Please end it when you are back.',
        link: REMINDER_LINKS.INCOMPLETE_BREAK,
      };
    case REVIEW_REMINDER_KIND.REG_REVIEW:
      return {
        title: 'Regularization awaiting review',
        message: 'A regularization request has been pending for over 24 hours and needs your review.',
        link: REMINDER_LINKS.REG_REVIEW,
      };
    case REVIEW_REMINDER_KIND.OT_REVIEW:
      return {
        title: 'Overtime awaiting review',
        message: 'An overtime request has been pending for over 24 hours and needs your review.',
        link: REMINDER_LINKS.OT_REVIEW,
      };
    case REVIEW_REMINDER_KIND.FINALIZATION_PENDING:
      return {
        title: 'Attendance finalization pending',
        message: facts.month
          ? `Attendance for ${facts.month} is still ${facts.periodStatus || 'open'} after month-end. Please finalize it for payroll.`
          : 'A past attendance month is still open. Please finalize it for payroll.',
        link: REMINDER_LINKS.FINALIZATION_PENDING,
      };
    default:
      return { title: 'Attendance reminder', message: 'You have an attendance reminder.', link: '/app/attendance' };
  }
};
