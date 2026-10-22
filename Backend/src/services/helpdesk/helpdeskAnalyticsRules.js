import ApiError from '../../utils/ApiError.js';

export const HELPDESK_ANALYTICS_DEFAULT_DAYS = 30;
export const HELPDESK_ANALYTICS_MAX_DAYS = 366;
export const HELPDESK_ANALYTICS_DEFAULT_LIMIT = 50;
export const HELPDESK_ANALYTICS_MAX_LIMIT = 100;
export const HELPDESK_ANALYTICS_MAX_PAGE = 1000;
export const HELPDESK_ANALYTICS_MAX_QUEUES = 200;
export const HELPDESK_ANALYTICS_MAX_TIME_MS = 8000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i;
const ALLOWED_QUERY_FIELDS = Object.freeze(['from', 'to', 'page', 'limit']);

const parseDate = (value, field) => {
  if (typeof value !== 'string' || value.length > 40) {
    throw ApiError.badRequest(`${field} must be a valid ISO date or timestamp.`);
  }
  if (!DATE_ONLY.test(value) && !ISO_TIMESTAMP.test(value)) {
    throw ApiError.badRequest(`${field} must be YYYY-MM-DD or an ISO timestamp with a timezone.`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw ApiError.badRequest(`${field} must be a valid ISO date or timestamp.`);
  }
  if (DATE_ONLY.test(value) && date.toISOString().slice(0, 10) !== value) {
    throw ApiError.badRequest(`${field} must be a real calendar date.`);
  }
  return date;
};

const normalizePageNumber = (value, field, fallback, maximum) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw ApiError.badRequest(`${field} must be an integer.`);
  }
  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    throw ApiError.badRequest(`${field} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw ApiError.badRequest(`${field} must be between 1 and ${maximum}.`);
  }
  return parsed;
};

export const normalizeHelpdeskAnalyticsQuery = (query = {}, { now = new Date() } = {}) => {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw ApiError.badRequest('Helpdesk analytics filters must be an object.');
  }
  const unsupported = Object.keys(query).find((field) => !ALLOWED_QUERY_FIELDS.includes(field));
  if (unsupported) {
    throw ApiError.badRequest(`Unsupported Helpdesk analytics filter: ${unsupported}`);
  }

  const hasFrom = query.from !== undefined;
  const hasTo = query.to !== undefined;
  if (hasFrom !== hasTo) {
    throw ApiError.badRequest('Supply both from and to for a Helpdesk analytics period.');
  }

  const current = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(current.getTime())) {
    throw ApiError.unavailable('A trusted Helpdesk analytics timestamp is unavailable.');
  }
  const to = hasTo ? parseDate(query.to, 'to') : current;
  const from = hasFrom
    ? parseDate(query.from, 'from')
    : new Date(to.getTime() - HELPDESK_ANALYTICS_DEFAULT_DAYS * 24 * 60 * 60 * 1000);

  if (from.getTime() >= to.getTime()) {
    throw ApiError.badRequest('from must be earlier than to.');
  }
  if (to.getTime() - from.getTime() > HELPDESK_ANALYTICS_MAX_DAYS * 24 * 60 * 60 * 1000) {
    throw ApiError.badRequest(`Helpdesk analytics periods cannot exceed ${HELPDESK_ANALYTICS_MAX_DAYS} days.`);
  }

  const page = normalizePageNumber(
    query.page,
    'page',
    1,
    HELPDESK_ANALYTICS_MAX_PAGE,
  );
  const limit = normalizePageNumber(
    query.limit,
    'limit',
    HELPDESK_ANALYTICS_DEFAULT_LIMIT,
    HELPDESK_ANALYTICS_MAX_LIMIT,
  );

  return { from, to, page, limit };
};

export const _helpdeskAnalyticsRulesTest = {
  parseDate,
  normalizePageNumber,
};
