// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 38 — PROFILE CHANGE REQUEST RULES (pure domain logic)
//
//  Pure, side-effect-free, no Mongo, no req/res, no Redis, no notifications.
//  Every function is a total function of its arguments (`today` and the
//  current profile values are injected).
//
//  WHY THIS FILE EXISTS
//    A profile change request is a *proposal* against a field the employee
//    cannot edit directly. The rules below answer, with no database:
//      · WHICH fields may be requested at all        (allowlist)
//      · WHAT a valid value looks like per field     (validate/normalize)
//      · HOW a value is shown back to a human        (display, masked)
//      · WHEN a request may move between statuses    (state machine)
//      · WHO may review or cancel it                 (eligibility)
//
//  SECURITY POSTURE (§ tenant + § audit)
//    · The allowlist is deny-by-default: an unknown field is refused, so a
//      client can never ask the approval workflow to write `role`,
//      `companyId`, `password`, `reportingTo` or any payroll field.
//    · Bank values are `sensitive: true`. They are validated strictly,
//      stored on the request only so the reviewer can decide, and NEVER
//      serialized in the clear — responses and audit rows carry a mask.
// ═══════════════════════════════════════════════════════════════════════════

export const CHANGE_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
});

export const CHANGE_ACTIONS = Object.freeze({
  APPROVE: 'approve',
  REJECT: 'reject',
});

export const MAX_CHANGES_PER_REQUEST = 5;
export const MAX_REASON_LENGTH = 300;
export const MAX_DECISION_NOTE_LENGTH = 300;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const EMPLOYEE_CODE_RE = /^[A-Z0-9][A-Z0-9._/-]{0,19}$/;

// ── Value formatting helpers ───────────────────────────────────

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

export const toDayString = (value) => {
  if (!value) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? ''
      : value.toISOString().slice(0, 10);
  }
  const text = String(value);
  if (isValidDayString(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
};

// Bank accounts and other long numbers are shown tail-only. The full value
// never leaves the document once it is stored (§ audit redaction).
export const maskTail = (value, visible = 4) => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length <= visible) return text;
  return `${'•'.repeat(Math.min(8, text.length - visible))}${text.slice(-visible)}`;
};

// ── Field registry (the allowlist) ─────────────────────────────
//  `sensitive: true`  → masked on the wire and in audit rows.
//  `selfEditable`     → still writable directly through PUT /api/profile/me.
//                       Name/designation/employeeCode/dateOfJoining are
//                       HR-controlled, so requesting is the ONLY self path.
//  `bankAccount`/`ifsc` stay readable in the self profile but moved behind
//  approval in this phase: an unverified bank edit is how salaries get
//  diverted (see docs/PHASE_38_PROFILE_CHANGE_REQUESTS.md §Security).

export const PROFILE_CHANGE_FIELDS = Object.freeze({
  name: {
    field: 'name',
    label: 'Full name',
    group: 'IDENTITY',
    sensitive: false,
    selfEditable: false,
    maxLength: 60,
    normalize: (raw) => String(raw ?? '').trim().replace(/\s+/g, ' '),
    display: (value) => String(value ?? ''),
    validate: (value) => {
      if (!value) return 'name is required';
      if (value.length < 2) return 'name must be at least 2 characters';
      if (value.length > 60) return 'name must be at most 60 characters';
      if (!/\p{L}/u.test(value)) return 'name must contain at least one letter';
      return null;
    },
  },

  designation: {
    field: 'designation',
    label: 'Designation',
    group: 'EMPLOYMENT',
    sensitive: false,
    selfEditable: false,
    maxLength: 80,
    normalize: (raw) => String(raw ?? '').trim().replace(/\s+/g, ' '),
    display: (value) => String(value ?? ''),
    validate: (value) => {
      if (!value) return 'designation is required';
      if (value.length > 80) return 'designation must be at most 80 characters';
      return null;
    },
  },

  employeeCode: {
    field: 'employeeCode',
    label: 'Employee code',
    group: 'EMPLOYMENT',
    sensitive: false,
    selfEditable: false,
    maxLength: 20,
    normalize: (raw) => String(raw ?? '').trim().toUpperCase(),
    display: (value) => String(value ?? ''),
    validate: (value, context = {}) => {
      if (!value) return 'employeeCode is required';
      if (!EMPLOYEE_CODE_RE.test(value)) {
        return 'employeeCode may contain letters, digits, dot, dash, slash or underscore (max 20)';
      }
      // The same code cannot identify two people in one tenant. The unique
      // index is the real guard; this is the early, human answer.
      const taken = Array.isArray(context.takenCodes)
        ? context.takenCodes.map((code) => String(code).toUpperCase())
        : [];
      if (taken.includes(value)) {
        return 'employeeCode is already used by another employee in your company';
      }
      return null;
    },
  },

  dateOfJoining: {
    field: 'dateOfJoining',
    label: 'Date of joining',
    group: 'EMPLOYMENT',
    sensitive: false,
    selfEditable: false,
    maxLength: 10,
    normalize: (raw) => toDayString(raw),
    display: (value) => toDayString(value),
    validate: (value, context = {}) => {
      if (!value) return 'dateOfJoining must be a valid YYYY-MM-DD day';
      if (!isValidDayString(value)) {
        return 'dateOfJoining must be a valid YYYY-MM-DD day';
      }
      if (value < '1970-01-01') return 'dateOfJoining is too far in the past';
      if (isValidDayString(context.today) && value > context.today) {
        return 'dateOfJoining cannot be in the future';
      }
      return null;
    },
  },

  bankAccount: {
    field: 'bankAccount',
    label: 'Bank account number',
    group: 'PAYMENT',
    sensitive: true,
    selfEditable: false,
    maxLength: 18,
    normalize: (raw) => String(raw ?? '').replace(/[\s-]/g, ''),
    display: (value) => maskTail(value),
    validate: (value) => {
      if (!value) return 'bankAccount is required';
      if (!/^\d{9,18}$/.test(value)) {
        return 'bankAccount must be 9 to 18 digits';
      }
      return null;
    },
  },

  ifsc: {
    field: 'ifsc',
    label: 'IFSC code',
    group: 'PAYMENT',
    sensitive: false,
    selfEditable: false,
    maxLength: 11,
    normalize: (raw) => String(raw ?? '').trim().toUpperCase(),
    display: (value) => String(value ?? '').toUpperCase(),
    validate: (value) => {
      if (!value) return 'ifsc is required';
      if (!IFSC_RE.test(value)) {
        return 'ifsc must be 11 characters, like HDFC0001234';
      }
      return null;
    },
  },
});

export const REQUESTABLE_FIELDS = Object.freeze(
  Object.keys(PROFILE_CHANGE_FIELDS),
);

export const isRequestableField = (field) =>
  Object.prototype.hasOwnProperty.call(PROFILE_CHANGE_FIELDS, String(field));

export const fieldLabel = (field) =>
  PROFILE_CHANGE_FIELDS[field]?.label || String(field || '');

export const isSensitiveField = (field) =>
  PROFILE_CHANGE_FIELDS[field]?.sensitive === true;

export const normalizeChangeValue = (field, raw) =>
  isRequestableField(field)
    ? PROFILE_CHANGE_FIELDS[field].normalize(raw)
    : String(raw ?? '').trim();

export const displayChangeValue = (field, value) => {
  if (!isRequestableField(field)) return maskTail(value);
  return PROFILE_CHANGE_FIELDS[field].display(value);
};

// ── Input validation ───────────────────────────────────────────

/**
 * Validate one submitted request body.
 *
 * @param {object} input   `{ changes: { field: value }, reason?: string }`
 * @param {object} context `{ today, currentProfile, takenCodes }`
 * @returns {{ errors: string[], changes: Array<{field,value,label,sensitive}> }}
 */
export const validateChangeRequestInput = (input = {}, context = {}) => {
  const errors = [];
  const changes = [];

  const raw = input.changes && typeof input.changes === 'object' ? input.changes : null;
  if (!raw) {
    return { errors: ['changes must be an object of field → new value'], changes };
  }

  const fields = Object.keys(raw).filter((field) => raw[field] !== undefined);
  if (fields.length === 0) {
    return { errors: ['at least one change is required'], changes };
  }
  if (fields.length > MAX_CHANGES_PER_REQUEST) {
    return {
      errors: [`a request may contain at most ${MAX_CHANGES_PER_REQUEST} fields`],
      changes,
    };
  }

  const seen = new Set();
  fields.forEach((field) => {
    if (!isRequestableField(field)) {
      errors.push(`${field} cannot be changed through a profile change request`);
      return;
    }
    if (seen.has(field)) {
      errors.push(`${field} was sent twice`);
      return;
    }
    seen.add(field);

    const rule = PROFILE_CHANGE_FIELDS[field];
    const value = rule.normalize(raw[field]);
    const fieldError = rule.validate(value, context);
    if (fieldError) {
      errors.push(fieldError);
      return;
    }

    const current = context.currentProfile
      ? normalizeChangeValue(field, context.currentProfile[field])
      : undefined;

    // A request that changes nothing is noise for the reviewer — refuse it
    // with the same answer the UI shows, instead of queueing a no-op.
    if (current !== undefined && String(current) === String(value)) {
      errors.push(`${rule.label} already has this value`);
      return;
    }

    changes.push({
      field,
      value,
      label: rule.label,
      sensitive: rule.sensitive,
    });
  });

  const reason = input.reason === undefined || input.reason === null ? '' : String(input.reason).trim();
  if (reason.length > MAX_REASON_LENGTH) {
    errors.push(`reason must be at most ${MAX_REASON_LENGTH} characters`);
  }

  return { errors, changes };
};

export const validateDecisionNote = (note) => {
  if (note === undefined || note === null || note === '') return null;
  if (typeof note !== 'string') return 'decisionNote must be a string';
  const trimmed = note.trim();
  if (trimmed.length > MAX_DECISION_NOTE_LENGTH) {
    return `decisionNote must be at most ${MAX_DECISION_NOTE_LENGTH} characters`;
  }
  // A rejection without a reason tells the employee nothing actionable.
  if (trimmed.length === 0) return 'decisionNote must not be blank';
  return null;
};

// ── State machine ──────────────────────────────────────────────
//  pending ─┬─▶ approved   (reviewer, applied to the profile)
//           ├─▶ rejected   (reviewer, profile untouched)
//           └─▶ cancelled  (owner or reviewer)
//  approved / rejected / cancelled are terminal — a new request is the way
//  to ask again, so the decision history is never rewritten.

const TRANSITIONS = Object.freeze({
  [CHANGE_STATUS.PENDING]: [
    CHANGE_STATUS.APPROVED,
    CHANGE_STATUS.REJECTED,
    CHANGE_STATUS.CANCELLED,
  ],
  [CHANGE_STATUS.APPROVED]: [],
  [CHANGE_STATUS.REJECTED]: [],
  [CHANGE_STATUS.CANCELLED]: [],
});

export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

export const isTerminal = (status) =>
  [CHANGE_STATUS.APPROVED, CHANGE_STATUS.REJECTED, CHANGE_STATUS.CANCELLED]
    .includes(status);

export const reviewEligibility = (request, reviewerId) => {
  if (!request) return 'request not found';
  if (request.status !== CHANGE_STATUS.PENDING) {
    return `request is already ${request.status}`;
  }
  if (reviewerId && String(request.employeeId) === String(reviewerId)) {
    return 'you cannot review your own request';
  }
  return null;
};

export const cancelEligibility = (request, context = {}) => {
  const { isOwner = false, isReviewer = false } = context;
  if (!request) return 'request not found';
  if (!canTransition(request.status, CHANGE_STATUS.CANCELLED)) {
    return `a ${request.status} request cannot be cancelled`;
  }
  if (!isOwner && !isReviewer) {
    return 'not authorized to cancel this request';
  }
  return null;
};

// ── Serialization ──────────────────────────────────────────────
//  Whitelisted shape only: the raw requested values (`_fromRaw` / `_toRaw`)
//  are structurally excluded, and sensitive fields are masked. This is the
//  single door between the document and the wire.

export const serializeChangeRequest = (row, options = {}) => {
  if (!row) return null;
  const obj = typeof row.toObject === 'function' ? row.toObject() : row;
  const { viewerId = null, isReviewer = false } = options;
  const status = obj.status || CHANGE_STATUS.PENDING;
  const isOwner = viewerId != null && String(obj.employeeId) === String(viewerId);

  // The stored `from`/`to` columns are ALREADY display-safe. The raw copies
  // are only used to re-derive the display when the caller serializes a
  // freshly-built document (one that never went through the model).
  const show = (change, which) => {
    const raw = which === 'from' ? change._fromRaw : change._toRaw;
    const stored = change[which];
    if (raw === undefined || raw === null) return String(stored ?? '');
    return isSensitiveField(change.field)
      ? maskTail(raw)
      : displayChangeValue(change.field, raw);
  };

  const changes = (Array.isArray(obj.changes) ? obj.changes : []).map((change) => ({
    field: change.field,
    label: change.label || fieldLabel(change.field),
    from: show(change, 'from'),
    to: show(change, 'to'),
    sensitive: isSensitiveField(change.field),
  }));

  return {
    id: String(obj._id || ''),
    status,
    employeeId: String(obj.employeeId || ''),
    employeeName: obj.employeeName || '',
    employeeCode: obj.employeeCode || '',
    changes,
    reason: obj.reason || '',
    decisionNote: obj.decisionNote || '',
    requestedAt: obj.requestedAt || obj.createdAt || null,
    reviewedAt: obj.reviewedAt || null,
    reviewedBy: obj.reviewedBy ? String(obj.reviewedBy) : null,
    cancelledAt: obj.cancelledAt || null,
    appliedAt: obj.appliedAt || null,
    canCancel: status === CHANGE_STATUS.PENDING && (isOwner || isReviewer),
    canReview: status === CHANGE_STATUS.PENDING && isReviewer && !isOwner,
    isMine: isOwner,
  };
};

// ── Diff helper (used by the service before writing) ───────────

export const changesPlan = (changes) =>
  (changes || []).map((change) => ({
    field: change.field,
    label: change.label || fieldLabel(change.field),
    value: change.value,
    sensitive: change.sensitive === true || isSensitiveField(change.field),
  }));

export const PROFILE_CHANGE_FIELD_NAMES = REQUESTABLE_FIELDS;

export default {
  CHANGE_STATUS,
  PROFILE_CHANGE_FIELDS,
  REQUESTABLE_FIELDS,
  validateChangeRequestInput,
  serializeChangeRequest,
};
