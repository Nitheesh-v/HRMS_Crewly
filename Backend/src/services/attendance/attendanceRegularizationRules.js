// ─────────────────────────────────────────────────────────────
// Phase 31.5 — regularization pure rules.
//
// Deterministic and side-effect-free: no Mongo, no req/res, no
// Redis, no notifications. Company "today" and timezone arrive as
// injected arguments (Intl day math is deterministic given them).
// ─────────────────────────────────────────────────────────────

export const REG_TYPE = Object.freeze({
  MISSED_CLOCK_IN: 'MISSED_CLOCK_IN',
  MISSED_CLOCK_OUT: 'MISSED_CLOCK_OUT',
  CLOCK_IN_TIME_CORRECTION: 'CLOCK_IN_TIME_CORRECTION',
  CLOCK_OUT_TIME_CORRECTION: 'CLOCK_OUT_TIME_CORRECTION',
  BREAK_CORRECTION: 'BREAK_CORRECTION',
  WORK_MODE_CORRECTION: 'WORK_MODE_CORRECTION',
  LATE_EXPLANATION: 'LATE_EXPLANATION',
  EARLY_EXIT_EXPLANATION: 'EARLY_EXIT_EXPLANATION',
  SHORT_HOURS_EXPLANATION: 'SHORT_HOURS_EXPLANATION',
  GEOFENCE_EXPLANATION: 'GEOFENCE_EXPLANATION',
});

export const REG_KIND = Object.freeze({
  CORRECTION: 'CORRECTION',
  EXPLANATION: 'EXPLANATION',
});

const EXPLANATION_TYPES = new Set([
  REG_TYPE.LATE_EXPLANATION,
  REG_TYPE.EARLY_EXIT_EXPLANATION,
  REG_TYPE.SHORT_HOURS_EXPLANATION,
  REG_TYPE.GEOFENCE_EXPLANATION,
]);

export const kindOf = (type) => (EXPLANATION_TYPES.has(type) ? REG_KIND.EXPLANATION : REG_KIND.CORRECTION);

export const isRegularizationType = (type) => Object.values(REG_TYPE).includes(type);

// Conflict groups: one open/applied correction per group per day.
// Explanations group per-type (same explanation twice = duplicate).
export const conflictGroupOf = (type) => {
  switch (type) {
    case REG_TYPE.MISSED_CLOCK_IN:
    case REG_TYPE.CLOCK_IN_TIME_CORRECTION:
      return 'IN';
    case REG_TYPE.MISSED_CLOCK_OUT:
    case REG_TYPE.CLOCK_OUT_TIME_CORRECTION:
      return 'OUT';
    case REG_TYPE.BREAK_CORRECTION:
      return 'BREAK';
    case REG_TYPE.WORK_MODE_CORRECTION:
      return 'MODE';
    default:
      return `EXPLANATION:${type}`;
  }
};

// 31.1 EXCEPTION_CODE each explanation resolves (recorded, never
// rewriting the factual exception list itself).
export const EXPLANATION_CODE = Object.freeze({
  LATE_EXPLANATION: 'LATE_IN',
  EARLY_EXIT_EXPLANATION: 'EARLY_OUT',
  SHORT_HOURS_EXPLANATION: 'SHORT_HOURS',
  GEOFENCE_EXPLANATION: 'OUTSIDE_GEOFENCE',
});

export const MAX_REASON_LENGTH = 300;
export const MIN_REASON_LENGTH = 1;
export const MIN_REVIEW_REASON_LENGTH = 3;

export const REQUEST_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
});

// ── Day helpers (pure) ─────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isValidDayString = (day) => {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
  const [year, month, date] = day.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === date
  );
};

export const dayKeyInZone = (date, timeZone) => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date instanceof Date ? date : new Date(date));
  } catch {
    return new Date(date).toISOString().slice(0, 10);
  }
};

const addDays = (day, delta) => {
  const parsed = new Date(`${day}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + delta);
  return parsed.toISOString().slice(0, 10);
};

export const toDateOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

// Submission window from the 31.1 missingPunch policy: the
// attendance day must lie within [today - windowDays, today].
// Returns null when submittable, else the refusal message.
export const windowCheck = (attendanceDate, today, missingPunch) => {
  if (!isValidDayString(attendanceDate)) return 'attendanceDate must be a valid YYYY-MM-DD day';
  if (!isValidDayString(today)) return 'company today is unavailable';
  if (missingPunch?.allowRegularization === false) {
    return 'regularization is disabled by the company attendance policy';
  }
  const windowDays = Number.isInteger(missingPunch?.regularizationWindowDays)
    ? missingPunch.regularizationWindowDays
    : 7;
  if (attendanceDate > today) return 'regularization cannot target a future day';
  const earliest = addDays(today, -Math.max(0, windowDays));
  if (attendanceDate < earliest) {
    return `regularization is allowed within ${windowDays} day(s) after the attendance day`;
  }
  return null;
};

// ── Proposal validation (pure) ───────────────────────────
// `original`: { firstIn, lastOut, hasControl } recorded facts.
// `proposal`: { correctedIn, correctedOut, breaks, workMode }.
// Returns an array of messages (empty = valid).

const withinDay = (instant, day, timeZone) => dayKeyInZone(instant, timeZone) === day;

export const validateProposal = (type, proposal = {}, original = {}, context = {}) => {
  const errors = [];
  const { attendanceDate, timezone } = context;
  const inAt = toDateOrNull(proposal.correctedIn);
  const outAt = toDateOrNull(proposal.correctedOut);

  if (!isRegularizationType(type)) {
    return ['type must be a supported regularization type'];
  }

  if (kindOf(type) === REG_KIND.EXPLANATION) {
    if (proposal.correctedIn != null || proposal.correctedOut != null || proposal.breaks != null || proposal.workMode != null) {
      errors.push('explanations must not propose corrected timestamps, breaks or work mode');
    }
    return errors;
  }

  switch (type) {
    case REG_TYPE.MISSED_CLOCK_IN: {
      if (original.firstIn) errors.push('a recorded clock-in already exists for this day');
      if (!inAt) errors.push('correctedIn is required');
      else if (!withinDay(inAt, attendanceDate, timezone)) errors.push('correctedIn must fall on the attendance day');
      if (original.lastOut && inAt && inAt >= new Date(original.lastOut)) {
        errors.push('corrected clock-in must be before the recorded clock-out');
      }
      break;
    }
    case REG_TYPE.MISSED_CLOCK_OUT: {
      if (!original.firstIn) errors.push('a missed clock-out needs a recorded clock-in first');
      if (original.lastOut) errors.push('a recorded clock-out already exists for this day');
      if (!outAt) errors.push('correctedOut is required');
      else {
        const day = dayKeyInZone(outAt, timezone);
        if (day !== attendanceDate && day !== addDays(attendanceDate, 1)) {
          errors.push('correctedOut must fall on the attendance day or the next day (overnight)');
        }
        if (outAt <= new Date(original.firstIn)) errors.push('corrected clock-out must be after the clock-in');
      }
      break;
    }
    case REG_TYPE.CLOCK_IN_TIME_CORRECTION: {
      if (!original.firstIn) errors.push('no recorded clock-in exists to correct');
      if (!inAt) errors.push('correctedIn is required');
      else if (!withinDay(inAt, attendanceDate, timezone)) errors.push('correctedIn must fall on the attendance day');
      else {
        const effectiveOut = original.lastOut ? new Date(original.lastOut) : null;
        if (effectiveOut && inAt >= effectiveOut) errors.push('corrected clock-in must be before the clock-out');
        if (inAt.getTime() === new Date(original.firstIn).getTime()) errors.push('corrected clock-in equals the recorded time');
      }
      break;
    }
    case REG_TYPE.CLOCK_OUT_TIME_CORRECTION: {
      if (!original.lastOut) errors.push('no recorded clock-out exists to correct');
      if (!outAt) errors.push('correctedOut is required');
      else {
        const day = dayKeyInZone(outAt, timezone);
        if (day !== attendanceDate && day !== addDays(attendanceDate, 1)) {
          errors.push('correctedOut must fall on the attendance day or the next day (overnight)');
        }
        if (original.firstIn && outAt <= new Date(original.firstIn)) {
          errors.push('corrected clock-out must be after the clock-in');
        }
        if (outAt.getTime() === new Date(original.lastOut).getTime()) errors.push('corrected clock-out equals the recorded time');
      }
      break;
    }
    case REG_TYPE.BREAK_CORRECTION: {
      if (!original.firstIn || !original.lastOut) {
        errors.push('break correction needs a completed day (recorded clock-in and clock-out)');
        break;
      }
      const breaks = Array.isArray(proposal.breaks) ? proposal.breaks : null;
      if (!breaks || breaks.length === 0) {
        errors.push('breaks must propose the full effective break list');
        break;
      }
      const inMs = new Date(original.firstIn).getTime();
      const outMs = new Date(original.lastOut).getTime();
      const parsed = [];
      breaks.forEach((interval, index) => {
        const start = toDateOrNull(interval?.start);
        const end = toDateOrNull(interval?.end);
        if (!start || !end) {
          errors.push(`break ${index + 1} needs a valid start and end`);
          return;
        }
        if (end <= start) errors.push(`break ${index + 1} must end after it starts`);
        if (start.getTime() < inMs || end.getTime() > outMs) {
          errors.push(`break ${index + 1} must lie within clock-in → clock-out`);
        }
        parsed.push({ start: start.getTime(), end: end.getTime() });
      });
      parsed.sort((a, b) => a.start - b.start);
      for (let i = 1; i < parsed.length; i += 1) {
        if (parsed[i].start < parsed[i - 1].end) {
          errors.push('breaks must not overlap');
          break;
        }
      }
      break;
    }
    case REG_TYPE.WORK_MODE_CORRECTION: {
      if (!original.hasControl) errors.push('work-mode correction needs an existing attendance day');
      if (!['OFFICE', 'WFH', 'FIELD', 'CLIENT_SITE', 'BUSINESS_TRAVEL'].includes(proposal.workMode)) {
        errors.push('workMode must be a valid work mode');
      } else if (proposal.workMode === original.workMode) {
        errors.push('proposed work mode equals the recorded mode');
      }
      break;
    }
    default:
      break;
  }
  return errors;
};

// ── Effective timeline (pure overlay) ────────────────────
// original: { firstIn, lastOut, breaks: [{start,end}], workMode }.
// corrections: approved [{ type, proposal }] (single-layer: at most
// one applied correction per conflict group — enforced at approve).
// Returns { clockIn, clockOut, breaks, workMode, resolvedExceptions }.
// Timestamps stay Date|null; breaks are [{start,end}] Dates.

export const buildEffectiveTimeline = (original = {}, corrections = []) => {
  const byGroup = {};
  for (const correction of corrections) {
    byGroup[conflictGroupOf(correction.type)] = correction;
  }
  const inCorrection = byGroup.IN;
  const outCorrection = byGroup.OUT;
  const breakCorrection = byGroup.BREAK;
  const modeCorrection = byGroup.MODE;

  const clockIn = toDateOrNull(inCorrection?.proposal?.correctedIn)
    || toDateOrNull(original.firstIn);
  const clockOut = toDateOrNull(outCorrection?.proposal?.correctedOut)
    || toDateOrNull(original.lastOut);
  const breaks = breakCorrection?.proposal?.breaks
    ? breakCorrection.proposal.breaks.map((interval) => ({
      start: toDateOrNull(interval.start),
      end: toDateOrNull(interval.end),
    }))
    : (original.breaks || []).map((interval) => ({
      start: toDateOrNull(interval.start),
      end: toDateOrNull(interval.end),
    }));
  const workMode = modeCorrection?.proposal?.workMode || original.workMode || 'OFFICE';
  const resolvedExceptions = corrections
    .filter((correction) => kindOf(correction.type) === REG_KIND.EXPLANATION)
    .map((correction) => EXPLANATION_CODE[correction.type])
    .filter(Boolean);

  return { clockIn, clockOut, breaks, workMode, resolvedExceptions };
};

// ── State machine (pure) ─────────────────────────────────

const TRANSITIONS = Object.freeze({
  PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
});

export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

// PENDING-only cancellation (owner or scoped reviewer). APPROVED is
// terminal — the projection was already rebuilt from it.
export const cancelEligibility = (request, context = {}) => {
  const { isOwner = false, isReviewer = false } = context;
  if (!request || request.status !== REQUEST_STATUS.PENDING) {
    return 'only pending requests can be cancelled';
  }
  if (!isOwner && !isReviewer) return 'not authorized to cancel this request';
  return null;
};

export const reviewEligibility = (request, reviewerId) => {
  if (!request) return 'request not found';
  if (request.status !== REQUEST_STATUS.PENDING) {
    return `request is already ${String(request.status).toLowerCase()}`;
  }
  if (String(request.user) === String(reviewerId)) {
    return 'you cannot review your own request';
  }
  return null;
};

export const validateReason = (reason) => {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < MIN_REASON_LENGTH) return 'reason is required';
  if (text.length > MAX_REASON_LENGTH) return `reason must be at most ${MAX_REASON_LENGTH} characters`;
  return null;
};

export const validateReviewReason = (reason, { required }) => {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!required) {
    if (text.length > MAX_REASON_LENGTH) return `reviewReason must be at most ${MAX_REASON_LENGTH} characters`;
    return null;
  }
  if (text.length < MIN_REVIEW_REASON_LENGTH) {
    return `reviewReason needs at least ${MIN_REVIEW_REASON_LENGTH} characters`;
  }
  if (text.length > MAX_REASON_LENGTH) {
    return `reviewReason must be at most ${MAX_REASON_LENGTH} characters`;
  }
  return null;
};
