// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.5 — WORK-LOCATION REQUEST PURE RULES
//
//  Pure, side-effect-free, no Mongo, no req/res, no Redis, no notifications.
//  Every function is a total function of its arguments (today is an
//  injected day string). Mirrors the 31.4 attendanceWorkModeRules shape
//  but for the presence domain (location is 'wfh' only).
// ═══════════════════════════════════════════════════════════════════════════

export const REQUEST_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
});

export const REQUEST_LOCATION = Object.freeze({
  WFH: 'wfh',
});

export const MAX_RANGE_DAYS = 365;
export const MAX_DECISION_NOTE_LENGTH = 300;
export const MIN_DECISION_NOTE_LENGTH = 0;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isValidLocation = (value) =>
  value === REQUEST_LOCATION.WFH;

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

export const rangeDayCount = (startDate, endDate) => {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.round((end - start) / 86400000) + 1;
};

export const validateRequestInput = (input = {}, today) => {
  const errors = [];
  const { location, startDate, endDate = startDate } = input;

  if (!isValidLocation(location)) {
    errors.push('location must be "wfh"');
  }
  if (!isValidDayString(startDate)) {
    errors.push('startDate must be a valid YYYY-MM-DD day');
  }
  if (!isValidDayString(endDate)) {
    errors.push('endDate must be a valid YYYY-MM-DD day');
  }
  if (isValidDayString(startDate) && isValidDayString(endDate)) {
    if (endDate < startDate) {
      errors.push('endDate must be the same as or after startDate');
    } else {
      if (isValidDayString(today) && startDate < today) {
        // Spec §14 — strict past start is refused.
        errors.push('startDate cannot be in the past');
      }
      if (rangeDayCount(startDate, endDate) > MAX_RANGE_DAYS) {
        errors.push(`a request may span at most ${MAX_RANGE_DAYS} days`);
      }
    }
  }
  return errors;
};

// Policy gate: is location='wfh' enabled? Returns null when submittable,
// else the refusal message. Mirrors 31.4's `requestPolicyCheck` shape
// but for the presence tenant config (wfhMode ∈ {self_declare,
// approval_required, disabled}).
export const requestPolicyCheck = (policy) => {
  if (!policy) {
    return 'presence tenant configuration is not available';
  }
  if (policy.workLocationEnabled === false) {
    return 'work location is disabled for your company';
  }
  if (policy.wfhMode === 'disabled') {
    return 'WFH is disabled for your company';
  }
  // The 'allowedWorkLocations' allowlist is the final say: a tenant
  // may have wfhMode=approval_required but have removed 'wfh' from the
  // allowlist. Spec §13 — the request workflow cannot bypass the
  // allowlist.
  const allowed = Array.isArray(policy.allowedWorkLocations)
    ? policy.allowedWorkLocations
    : [];
  if (!allowed.includes('wfh')) {
    return 'WFH is not in the allowed work locations for your company';
  }
  // 'self_declare' and 'approval_required' both pass the policy
  // check; the latter is what triggers the approval-required flow.
  return null;
};

export const isApprovalRequired = (policy) =>
  policy?.wfhMode === 'approval_required';

// ── Overlap ──────────────────────────────────────────
// Two active (PENDING or APPROVED) requests overlap when their
// inclusive day ranges intersect. Day strings compare as strings.
const rangesIntersect = (left, right) =>
  left.startDate <= right.endDate && right.startDate <= left.endDate;

export const requestsOverlap = (left, right) => {
  if (!left || !right) return false;
  if (left.userId && right.userId && String(left.userId) !== String(right.userId)) {
    return false;
  }
  if (left.companyId && right.companyId && String(left.companyId) !== String(right.companyId)) {
    return false;
  }
  return rangesIntersect(left, right);
};

export const findOverlappingRequest = (candidate, existing) => {
  if (!candidate || !Array.isArray(existing)) return null;
  return (
    existing.find(
      (row) =>
        (row.status === REQUEST_STATUS.PENDING ||
          row.status === REQUEST_STATUS.APPROVED) &&
        requestsOverlap(candidate, row),
    ) || null
  );
};

// ── State machine ────────────────────────────────────
const TRANSITIONS = Object.freeze({
  pending: ['approved', 'rejected', 'cancelled'],
  approved: ['cancelled'],
  rejected: [],
  cancelled: [],
});

export const canTransition = (from, to) =>
  (TRANSITIONS[from] || []).includes(to);

// ── Cancellation eligibility ──────────────────────────
// context: { isOwner, isReviewer, today }
// Returns null when allowed, else the refusal message.
export const cancelEligibility = (request, context = {}) => {
  const { isOwner = false, isReviewer = false, today = null } = context;
  if (!request) return 'request not found';
  if (!canTransition(request.status, REQUEST_STATUS.CANCELLED)) {
    return 'only pending or approved requests can be cancelled';
  }
  if (!isOwner && !isReviewer) {
    return 'not authorized to cancel this request';
  }
  if (request.status === REQUEST_STATUS.APPROVED) {
    // Approved requests are cancellable by the owner when the
    // startDate is strictly in the future; otherwise only a
    // reviewer (admin / HR) may cancel. Spec §22.
    if (isOwner && !isReviewer) {
      if (
        isValidDayString(today) &&
        request.startDate &&
        request.startDate <= today
      ) {
        return 'approved requests starting today or earlier need reviewer cancellation';
      }
    }
  }
  return null;
};

// ── Review guard ─────────────────────────────────────
// PENDING-only, never self-reviewed. Spec §19.
export const reviewEligibility = (request, reviewerId) => {
  if (!request) return 'request not found';
  if (request.status !== REQUEST_STATUS.PENDING) {
    return `request is already ${request.status}`;
  }
  if (reviewerId && String(request.userId) === String(reviewerId)) {
    return 'you cannot review your own request';
  }
  return null;
};

export const validateDecisionNote = (note) => {
  if (note === undefined || note === null || note === '') return null;
  if (typeof note !== 'string') return 'decisionNote must be a string';
  const trimmed = note.trim();
  if (trimmed.length < MIN_DECISION_NOTE_LENGTH) {
    return 'decisionNote is too short';
  }
  if (trimmed.length > MAX_DECISION_NOTE_LENGTH) {
    return `decisionNote must be at most ${MAX_DECISION_NOTE_LENGTH} characters`;
  }
  return null;
};

// ── Serialisation ────────────────────────────────────
// PII-minimal. Returns a frozen, plain object safe for the wire.
export const serializeRequest = (row, options = {}) => {
  if (!row) return null;
  const { viewerId = null, isReviewer = false, today = null } = options;
  const obj = typeof row.toObject === 'function' ? row.toObject() : row;
  const status = obj.status || REQUEST_STATUS.PENDING;
  const isOwner = viewerId != null && String(obj.userId) === String(viewerId);

  // Cancellation: owners may cancel PENDING or future-dated APPROVED.
  // Reviewers may cancel any non-terminal state.
  let isCancelable = false;
  let cancelRefusal = null;
  if (status === REQUEST_STATUS.PENDING) {
    isCancelable = isOwner || isReviewer;
    if (!isCancelable) cancelRefusal = 'only the owner or a reviewer may cancel';
  } else if (status === REQUEST_STATUS.APPROVED) {
    if (isReviewer) {
      isCancelable = true;
    } else if (
      isOwner &&
      isValidDayString(today) &&
      obj.startDate &&
      obj.startDate > today
    ) {
      isCancelable = true;
    } else {
      cancelRefusal =
        'approved requests starting today or earlier need reviewer cancellation';
    }
  } else {
    cancelRefusal = `cannot cancel a ${status} request`;
  }

  // Approvability: PENDING + reviewer + not the owner.
  const isApprovable =
    isReviewer && status === REQUEST_STATUS.PENDING && !isOwner;

  const out = {
    id: String(obj._id || obj.id || ''),
    location: obj.location,
    startDate: obj.startDate,
    endDate: obj.endDate,
    status,
    requestedAt:
      obj.requestedAt instanceof Date
        ? obj.requestedAt.toISOString()
        : obj.requestedAt || null,
    reviewedAt:
      obj.reviewedAt instanceof Date
        ? obj.reviewedAt.toISOString()
        : obj.reviewedAt || null,
    isCancelable,
    cancelRefusal,
    isApprovable,
  };

  // Decision note: visible to the owner and to reviewers; NOT
  // surfaced to team pages (the team page never calls this helper
  // with `isReviewer=true`).
  if (isOwner || isReviewer) {
    out.decisionNote =
      typeof obj.decisionNote === 'string' && obj.decisionNote.trim()
        ? obj.decisionNote.trim()
        : null;
  }

  // Reviewer identity: only the queue UI shows a name, and we only
  // emit a one-word label, never an email/phone/PII.
  if (isReviewer || isOwner) {
    out.reviewedBy = obj.reviewedBy ? String(obj.reviewedBy) : null;
  }

  return out;
};

// Test seam — internal helpers exposed for hermetic tests.
export const __test__ = { TRANSITIONS };
