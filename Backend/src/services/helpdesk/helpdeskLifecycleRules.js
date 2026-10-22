import ApiError from '../../utils/ApiError.js';
import { hasVisibleText } from '../../utils/chatTextRules.js';

export const HELPDESK_REOPEN_WINDOW_DEFAULT_HOURS = 72;
export const HELPDESK_REOPEN_WINDOW_MIN_HOURS = 1;
export const HELPDESK_REOPEN_WINDOW_MAX_HOURS = 720;
export const HELPDESK_AUTO_CLOSE_DELAY_DEFAULT_HOURS = 72;
export const HELPDESK_AUTO_CLOSE_DELAY_MIN_HOURS = 1;
export const HELPDESK_AUTO_CLOSE_DELAY_MAX_HOURS = 720;
export const HELPDESK_REOPEN_REASON_MAX = 500;
export const HELPDESK_FEEDBACK_COMMENT_MAX = 1000;
export const HELPDESK_AUTO_CLOSE_BATCH_MAX = 100;

export const HELPDESK_LIFECYCLE_EVENT_TYPES = Object.freeze([
  'RESOLVED',
  'REQUESTER_CONFIRMED_RESOLUTION',
  'REQUESTER_REOPENED',
  'STAFF_REOPENED',
  'STAFF_CLOSED',
  'AUTO_CLOSED',
  'FEEDBACK_SUBMITTED',
]);

const stripUnsafeControls = (value) => String(value)
  .replace(/\r\n?/g, '\n')
  .replace(/<\/?[A-Za-z][^>]*>/g, '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

export const normalizeHelpdeskReopenReason = (value) => {
  if (typeof value !== 'string') throw ApiError.badRequest('A reopen reason is required.');
  const reason = stripUnsafeControls(value).trim();
  if (!hasVisibleText(reason)) throw ApiError.badRequest('A reopen reason is required.');
  if (reason.length > HELPDESK_REOPEN_REASON_MAX) {
    throw ApiError.badRequest(`Reopen reason must be ${HELPDESK_REOPEN_REASON_MAX} characters or fewer.`);
  }
  return reason;
};

export const normalizeHelpdeskFeedback = ({ rating, comment } = {}) => {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw ApiError.badRequest('rating must be an integer from 1 to 5.');
  }
  if (comment !== undefined && comment !== null && typeof comment !== 'string') {
    throw ApiError.badRequest('comment must be plain text.');
  }
  const normalizedComment = comment === undefined || comment === null
    ? null
    : stripUnsafeControls(comment).trim();
  if (normalizedComment && normalizedComment.length > HELPDESK_FEEDBACK_COMMENT_MAX) {
    throw ApiError.badRequest(`comment must be ${HELPDESK_FEEDBACK_COMMENT_MAX} characters or fewer.`);
  }
  if (normalizedComment && !hasVisibleText(normalizedComment)) {
    throw ApiError.badRequest('comment must contain visible text.');
  }
  return { rating, comment: normalizedComment || null };
};

const isoOrNull = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const clockSnapshot = (rawClock = {}) => {
  const clock = rawClock && typeof rawClock === 'object' ? rawClock : {};
  return {
    state: clock.state || null,
    targetMinutes: Number.isFinite(Number(clock.targetMinutes)) ? Number(clock.targetMinutes) : null,
    activeElapsedMs: Number.isFinite(Number(clock.activeElapsedMs)) ? Number(clock.activeElapsedMs) : 0,
    startedAt: isoOrNull(clock.startedAt),
    resumedAt: isoOrNull(clock.resumedAt),
    pausedAt: isoOrNull(clock.pausedAt),
    dueAt: isoOrNull(clock.dueAt),
    warningAt: isoOrNull(clock.warningAt),
    warningEligibleAt: isoOrNull(clock.warningEligibleAt),
    completedAt: isoOrNull(clock.completedAt),
    lastCompletedAt: isoOrNull(clock.lastCompletedAt),
    firstResponseAt: isoOrNull(clock.firstResponseAt),
    breachedAt: isoOrNull(clock.breachedAt),
    stoppedAt: isoOrNull(clock.stoppedAt),
  };
};

/** Capture the compact SLA state for this lifecycle cycle before later transitions mutate the active clock. */
export const snapshotHelpdeskSla = (rawSla) => {
  if (!rawSla) return null;
  const sla = typeof rawSla.toObject === 'function' ? rawSla.toObject() : rawSla;
  return {
    version: Number(sla.version) || 1,
    policyQueueId: sla.policyQueueId ?? null,
    policyVersion: Number(sla.policyVersion) || 1,
    appliedPriority: sla.appliedPriority || null,
    clockMode: sla.clockMode || null,
    timeZone: sla.timeZone || null,
    updatedAt: isoOrNull(sla.updatedAt),
    firstResponse: clockSnapshot(sla.firstResponse),
    resolution: clockSnapshot(sla.resolution),
    escalation: {
      state: sla.escalation?.state || 'NONE',
      queueId: sla.escalation?.queueId ?? null,
      eligibleAt: isoOrNull(sla.escalation?.eligibleAt),
      triggers: [...(sla.escalation?.triggers || [])],
    },
  };
};

export const serializeHelpdeskFeedback = (feedback) => {
  if (!feedback) return null;
  return {
    rating: Number(feedback.rating),
    comment: typeof feedback.comment === 'string' ? feedback.comment : null,
    submittedAt: isoOrNull(feedback.submittedAt),
  };
};

export const lifecycleCounterFilter = (value) => {
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : { $in: [0, null] };
};

export const _test = { clockSnapshot, isoOrNull, stripUnsafeControls };
