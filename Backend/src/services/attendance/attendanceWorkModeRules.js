// ─────────────────────────────────────────────────────────────
// Phase 31.4 — work-mode request pure rules.
//
// Deterministic and side-effect-free: no Mongo, no req/res, no
// Redis, no notifications. Every function is a total function of
// its arguments (company "today" is an injected day string).
// ─────────────────────────────────────────────────────────────

export const REQUESTABLE_MODES = Object.freeze([
  'WFH',
  'FIELD',
  'CLIENT_SITE',
  'BUSINESS_TRAVEL',
]);

export const REQUEST_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
});

export const DAY_PORTION = Object.freeze({
  FULL_DAY: 'FULL_DAY',
  FIRST_HALF: 'FIRST_HALF',
  SECOND_HALF: 'SECOND_HALF',
});

// Policy workModes keys → WORK_MODE values (mirrors the 31.1 map;
// OFFICE is intentionally absent — it is never requestable).
export const POLICY_MODE_TO_REQUEST_MODE = Object.freeze({
  wfh: 'WFH',
  field: 'FIELD',
  clientSite: 'CLIENT_SITE',
  businessTravel: 'BUSINESS_TRAVEL',
});

export const MAX_RANGE_DAYS = 31;
export const MAX_REASON_LENGTH = 300;
export const MAX_PLACE_LABEL_LENGTH = 120;
export const MIN_REVIEW_REASON_LENGTH = 3;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isRequestableMode = (mode) => REQUESTABLE_MODES.includes(mode);

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

// Inclusive day count for a valid ordered range (pure calendar math).
export const rangeDayCount = (startDate, endDate) => {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86400000) + 1;
};

// Full input validation. Returns an array of human messages (empty
// = valid). `today` is the company-today day string.
export const validateRequestInput = (input = {}, today) => {
  const errors = [];
  const { mode, startDate, endDate = startDate, dayPortion = 'FULL_DAY', reason, placeLabel } = input;

  if (!isRequestableMode(mode)) {
    errors.push('mode must be one of WFH, FIELD, CLIENT_SITE, BUSINESS_TRAVEL');
  }
  if (!isValidDayString(startDate)) errors.push('startDate must be a valid YYYY-MM-DD day');
  if (!isValidDayString(endDate)) errors.push('endDate must be a valid YYYY-MM-DD day');
  if (isValidDayString(startDate) && isValidDayString(endDate)) {
    if (endDate < startDate) {
      errors.push('endDate must be the same as or after startDate');
    } else {
      if (isValidDayString(today) && startDate < today) {
        errors.push('work-mode requests cannot start in the past');
      }
      if (rangeDayCount(startDate, endDate) > MAX_RANGE_DAYS) {
        errors.push(`a request may span at most ${MAX_RANGE_DAYS} days`);
      }
      if (dayPortion !== 'FULL_DAY' && startDate !== endDate) {
        errors.push('half-day portions are allowed for single-day requests only');
      }
    }
  }
  if (!Object.values(DAY_PORTION).includes(dayPortion)) {
    errors.push('dayPortion must be one of FULL_DAY, FIRST_HALF, SECOND_HALF');
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    errors.push('reason is required');
  } else if (reason.trim().length > MAX_REASON_LENGTH) {
    errors.push(`reason must be at most ${MAX_REASON_LENGTH} characters`);
  }
  if (
    placeLabel !== undefined &&
    placeLabel !== null &&
    String(placeLabel).trim() !== '' &&
    String(placeLabel).trim().length > MAX_PLACE_LABEL_LENGTH
  ) {
    errors.push(`placeLabel must be at most ${MAX_PLACE_LABEL_LENGTH} characters`);
  }
  return errors;
};

// Policy gate: is this mode enabled AND (if approval is required
// for it) requestable? Returns null when submittable, else the
// refusal message. Missing approval flags default to REQUIRED
// (secure default for pre-31.4 policies).
export const requestPolicyCheck = (mode, policy) => {
  if (!isRequestableMode(mode)) return 'mode is not a requestable non-office work mode';
  const policyKey = Object.keys(POLICY_MODE_TO_REQUEST_MODE).find(
    (key) => POLICY_MODE_TO_REQUEST_MODE[key] === mode,
  );
  if (!policy || policy.workModes?.[policyKey] !== true) {
    return `${mode} is not enabled by the company attendance policy`;
  }
  return null;
};

// Does clock-in under `mode` need an approved request? OFFICE never
// does. Enforcement needs an EXPLICIT true flag: pre-31.4 policies
// (and any reader without the field) grandfather existing behavior
// instead of surprise-locking clock-ins or touching the request
// collection. New/updated policies always carry explicit flags
// (schema defaults true), so this only ever exempts legacy reads.
export const modeRequiresApproval = (mode, policy) => {
  if (mode === 'OFFICE') return false;
  if (!isRequestableMode(mode)) return false;
  const policyKey = Object.keys(POLICY_MODE_TO_REQUEST_MODE).find(
    (key) => POLICY_MODE_TO_REQUEST_MODE[key] === mode,
  );
  return policy?.workModeApproval?.[policyKey] === true;
};

// Modes an employee may currently request (policy-enabled subset).
export const requestableModesForPolicy = (policy) => {
  if (!policy) return [];
  return Object.entries(POLICY_MODE_TO_REQUEST_MODE)
    .filter(([policyKey]) => policy.workModes?.[policyKey] === true)
    .map(([, mode]) => mode);
};

// ── Overlap ──────────────────────────────────────────
// Two requests conflict when their day ranges intersect AND
// their portions intersect. FULL_DAY intersects everything;
// halves intersect only the same half.
const portionsIntersect = (left, right) => {
  if (left === DAY_PORTION.FULL_DAY || right === DAY_PORTION.FULL_DAY) return true;
  return left === right;
};

const rangesIntersect = (left, right) =>
  left.startDate <= right.endDate && right.startDate <= left.endDate;

export const requestsOverlap = (left, right) =>
  rangesIntersect(left, right) && portionsIntersect(left.dayPortion, right.dayPortion);

// First conflicting active request, or null. Only PENDING and
// APPROVED authorizations block; REJECTED/CANCELLED are history.
export const findOverlappingRequest = (candidate, existing) =>
  (existing || []).find(
    (row) =>
      (row.status === REQUEST_STATUS.PENDING || row.status === REQUEST_STATUS.APPROVED) &&
      requestsOverlap(candidate, row),
  ) || null;

// ── Authorization match ──────────────────────────────
// An APPROVED request authorizes clock-in under its mode on any
// day within its range. Day portions govern overlap/leave, not
// the punch: attendance has no time-portion concept, so any
// portion authorizes the day (documented 31.4 limitation).
export const findAuthorization = (requests, { mode, date }) =>
  (requests || []).find(
    (row) =>
      row.status === REQUEST_STATUS.APPROVED &&
      row.mode === mode &&
      row.startDate <= date &&
      date <= row.endDate,
  ) || null;

// ── State machine ────────────────────────────────────
const TRANSITIONS = Object.freeze({
  PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['CANCELLED'],
  REJECTED: [],
  CANCELLED: [],
});

export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

// Cancellation eligibility. `context`: { isOwner, isReviewer,
// usedForAttendance, today }. Returns null when allowed, else
// the refusal message.
export const cancelEligibility = (request, context = {}) => {
  const { isOwner = false, isReviewer = false, usedForAttendance = false, today = null } = context;
  if (!request || !canTransition(request.status, REQUEST_STATUS.CANCELLED)) {
    return 'only pending or approved requests can be cancelled';
  }
  if (!isOwner && !isReviewer) return 'not authorized to cancel this request';
  if (request.status === REQUEST_STATUS.APPROVED) {
    if (usedForAttendance) {
      return 'this authorization already permitted attendance and stays as history';
    }
    // Owners may cancel their own approved future authorization;
    // reviewers act within their org scope (checked by caller).
    if (isOwner && !isReviewer && isValidDayString(today) && request.startDate <= today) {
      return 'approved requests starting today or earlier need reviewer cancellation';
    }
  }
  // PENDING: owner cancels own; reviewer-scope may cancel too.
  if (request.status === REQUEST_STATUS.PENDING && !isOwner && !isReviewer) {
    return 'not authorized to cancel this request';
  }
  return null;
};

// Review guard: PENDING-only, never self-reviewed.
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
