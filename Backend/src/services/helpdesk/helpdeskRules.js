import ApiError from '../../utils/ApiError.js';
import { hasVisibleText } from '../../utils/chatTextRules.js';

export const HELPDESK_MESSAGE_TYPES = Object.freeze(['PUBLIC', 'INTERNAL']);
export const HELPDESK_MESSAGE_VISIBILITIES = Object.freeze(['public', 'internal']);
export const HELPDESK_MESSAGE_BODY_MAX = 4000;
export const HELPDESK_MESSAGE_HISTORY_DEFAULT_LIMIT = 20;
export const HELPDESK_MESSAGE_HISTORY_MAX_LIMIT = 100;
export const HELPDESK_MESSAGE_ACTIVE_STATUSES = Object.freeze([
  'open',
  'assigned',
  'in_progress',
  'waiting_for_employee',
  'waiting_for_department',
]);

export const normalizeHelpdeskMessageType = (value = 'public') => {
  const normalized = String(value || 'public').trim().toUpperCase();
  if (!HELPDESK_MESSAGE_TYPES.includes(normalized)) {
    throw ApiError.badRequest('messageType must be public or internal');
  }
  return normalized;
};

export const normalizeHelpdeskMessageBody = (value, { allowEmpty = false } = {}) => {
  if (value === undefined || value === null) {
    if (allowEmpty) return null;
    throw ApiError.badRequest('A message body is required.');
  }
  if (typeof value !== 'string') {
    throw ApiError.badRequest('Message body must be plain text.');
  }

  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (normalized.length > HELPDESK_MESSAGE_BODY_MAX) {
    throw ApiError.badRequest(`Message body must be ${HELPDESK_MESSAGE_BODY_MAX} characters or fewer.`);
  }
  if (!hasVisibleText(normalized)) {
    if (allowEmpty) return null;
    throw ApiError.badRequest('Message body must contain visible text.');
  }
  return normalized;
};

export const encodeHelpdeskMessageCursor = (sequence) => {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new ApiError(500, 'Cannot encode an invalid Helpdesk message cursor');
  }
  return Buffer.from(JSON.stringify({ v: 1, s: sequence }), 'utf8').toString('base64url');
};

export const decodeHelpdeskMessageCursor = (cursor) => {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (
    typeof cursor !== 'string'
    || cursor.length > 128
    || !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw ApiError.badRequest('Helpdesk message cursor is invalid.');
  }

  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const value = JSON.parse(decoded);
    if (
      Buffer.from(decoded, 'utf8').toString('base64url') !== cursor
      || !value
      || value.v !== 1
      || !Number.isSafeInteger(value.s)
      || value.s < 1
      || Object.keys(value).sort().join(',') !== 's,v'
    ) {
      throw new Error('invalid cursor');
    }
    return value.s;
  } catch {
    throw ApiError.badRequest('Helpdesk message cursor is invalid.');
  }
};

export const normalizeHelpdeskMessageHistoryQuery = (query = {}) => {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw ApiError.badRequest('Helpdesk message filters must be an object.');
  }
  const unsupported = Object.keys(query).find((field) => !['cursor', 'limit'].includes(field));
  if (unsupported) throw ApiError.badRequest(`Unsupported Helpdesk message filter: ${unsupported}`);

  return {
    cursorSequence: decodeHelpdeskMessageCursor(query.cursor),
    limit: parsePositiveListInteger(
      query.limit,
      'limit',
      HELPDESK_MESSAGE_HISTORY_DEFAULT_LIMIT,
      HELPDESK_MESSAGE_HISTORY_MAX_LIMIT,
    ),
  };
};

export const HELPDESK_TICKET_STATUSES = Object.freeze([
  'open',
  'assigned',
  'in_progress',
  'waiting_for_employee',
  'waiting_for_department',
  'resolved',
  'closed',
  'cancelled',
]);

export const HELPDESK_PRIORITIES = Object.freeze([
  'low',
  'normal',
  'high',
  'urgent',
]);

export const HELPDESK_TICKET_LIST_SORTS = Object.freeze([
  'newest',
  'oldest',
  'recently_updated',
]);
export const HELPDESK_TICKET_LIST_SEARCH_MAX_LENGTH = 60;
export const HELPDESK_TICKET_LIST_DEFAULT_LIMIT = 20;
export const HELPDESK_TICKET_LIST_MAX_LIMIT = 100;
export const HELPDESK_TICKET_LIST_MAX_PAGE = 10000;

export const HELPDESK_TICKET_TRANSITIONS = Object.freeze({
  open: Object.freeze(['assigned', 'in_progress', 'cancelled']),
  assigned: Object.freeze(['open', 'in_progress', 'cancelled']),
  in_progress: Object.freeze([
    'waiting_for_employee',
    'waiting_for_department',
    'resolved',
  ]),
  waiting_for_employee: Object.freeze([
    'in_progress',
    'resolved',
    'cancelled',
  ]),
  waiting_for_department: Object.freeze(['in_progress', 'resolved']),
  resolved: Object.freeze(['in_progress', 'closed']),
  closed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export const normalizeHelpdeskName = (value) =>
  String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');

export const helpdeskNameKey = (value) =>
  normalizeHelpdeskName(value).toLocaleLowerCase('en-US');

export const isHelpdeskPriority = (value) =>
  HELPDESK_PRIORITIES.includes(String(value || '').trim().toLowerCase());

export const isHelpdeskStatus = (value) =>
  HELPDESK_TICKET_STATUSES.includes(String(value || '').trim().toLowerCase());

export const canTransitionHelpdeskTicket = (from, to) =>
  HELPDESK_TICKET_TRANSITIONS[String(from || '').toLowerCase()]?.includes(
    String(to || '').toLowerCase(),
  ) === true;

export const HELPDESK_TICKET_LIST_QUERY_FIELDS = Object.freeze([
  'status',
  'priority',
  'queueId',
  'search',
  'sort',
  'page',
  'limit',
]);

export const HELPDESK_QUEUE_TICKET_LIST_QUERY_FIELDS = Object.freeze([
  'status',
  'priority',
  'search',
  'sort',
  'page',
  'limit',
]);

export const isHelpdeskTerminalStatus = (status) =>
  HELPDESK_TICKET_TRANSITIONS[String(status || '').toLowerCase()]?.length === 0;

const parsePositiveListInteger = (value, field, defaultValue, maximum) => {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw ApiError.badRequest(`${field} must be a positive integer`);
  }
  const normalized = String(value).trim();
  if (!/^[0-9]+$/.test(normalized)) {
    throw ApiError.badRequest(`${field} must be a positive integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw ApiError.badRequest(`${field} must be between 1 and ${maximum}`);
  }
  return parsed;
};

export const normalizeHelpdeskTicketListQuery = (query = {}) => {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw ApiError.badRequest('Helpdesk ticket filters must be an object');
  }

  const unsupportedField = Object.keys(query).find(
    (field) => !HELPDESK_TICKET_LIST_QUERY_FIELDS.includes(field),
  );
  if (unsupportedField) {
    throw ApiError.badRequest(`Unsupported Helpdesk ticket filter: ${unsupportedField}`);
  }

  let status;
  if (query.status !== undefined) {
    if (typeof query.status !== 'string' || !isHelpdeskStatus(query.status)) {
      throw ApiError.badRequest('status is not supported');
    }
    status = query.status.trim().toLowerCase();
  }

  let priority;
  if (query.priority !== undefined) {
    if (typeof query.priority !== 'string' || !isHelpdeskPriority(query.priority)) {
      throw ApiError.badRequest('priority is not supported');
    }
    priority = query.priority.trim().toLowerCase();
  }

  let queueId;
  if (query.queueId !== undefined) {
    if (typeof query.queueId !== 'string' || !/^[a-f0-9]{24}$/i.test(query.queueId.trim())) {
      throw ApiError.badRequest('queueId must be a valid identifier');
    }
    queueId = query.queueId.trim();
  }

  let search = '';
  if (query.search !== undefined) {
    if (typeof query.search !== 'string') {
      throw ApiError.badRequest('search must be a string');
    }
    search = query.search.trim();
    if (search.length > HELPDESK_TICKET_LIST_SEARCH_MAX_LENGTH) {
      throw ApiError.badRequest(
        `search must be at most ${HELPDESK_TICKET_LIST_SEARCH_MAX_LENGTH} characters`,
      );
    }
  }

  let sort = 'newest';
  if (query.sort !== undefined) {
    if (typeof query.sort !== 'string') {
      throw ApiError.badRequest('sort is not supported');
    }
    sort = query.sort.trim().toLowerCase();
    if (!HELPDESK_TICKET_LIST_SORTS.includes(sort)) {
      throw ApiError.badRequest('sort is not supported');
    }
  }

  return {
    status,
    priority,
    queueId,
    search,
    sort,
    page: parsePositiveListInteger(query.page, 'page', 1, HELPDESK_TICKET_LIST_MAX_PAGE),
    limit: parsePositiveListInteger(query.limit, 'limit', HELPDESK_TICKET_LIST_DEFAULT_LIMIT, HELPDESK_TICKET_LIST_MAX_LIMIT),
  };
};

export const normalizeHelpdeskQueueTicketListQuery = (query = {}) => {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw ApiError.badRequest('Helpdesk ticket filters must be an object');
  }

  const unsupportedField = Object.keys(query).find(
    (field) => !HELPDESK_QUEUE_TICKET_LIST_QUERY_FIELDS.includes(field),
  );
  if (unsupportedField) {
    throw ApiError.badRequest(`Unsupported Helpdesk queue ticket filter: ${unsupportedField}`);
  }

  const options = normalizeHelpdeskTicketListQuery(query);
  return {
    status: options.status,
    priority: options.priority,
    search: options.search,
    sort: options.sort,
    page: options.page,
    limit: options.limit,
  };
};

export const validateHelpdeskTransferInput = (input = {}) => {
  assertNoClientIdentity(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw ApiError.badRequest('Transfer details must be an object');
  }

  const allowedFields = ['queueId', 'categoryId', 'assigneeId'];
  const unsupportedField = Object.keys(input).find((field) => !allowedFields.includes(field));
  if (unsupportedField) {
    throw ApiError.badRequest(`Unsupported transfer field: ${unsupportedField}`);
  }

  if (typeof input.queueId !== 'string') {
    throw ApiError.badRequest('queueId must be a string identifier');
  }
  if (typeof input.categoryId !== 'string') {
    throw ApiError.badRequest('categoryId must be a string identifier');
  }
  if (input.assigneeId !== undefined && typeof input.assigneeId !== 'string') {
    throw ApiError.badRequest('assigneeId must be a string identifier');
  }
  const queueId = input.queueId.trim();
  const categoryId = input.categoryId.trim();
  const assigneeId = input.assigneeId === undefined ? null : input.assigneeId.trim();
  if (!/^[a-f\d]{24}$/i.test(queueId)) {
    throw ApiError.badRequest('queueId must be a valid identifier');
  }
  if (!/^[a-f\d]{24}$/i.test(categoryId)) {
    throw ApiError.badRequest('categoryId must be a valid identifier');
  }
  if (assigneeId !== null && !/^[a-f\d]{24}$/i.test(assigneeId)) {
    throw ApiError.badRequest('assigneeId must be a valid identifier');
  }

  return { queueId, categoryId, assigneeId };
};

export const assertNoClientIdentity = (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw ApiError.badRequest('Request body must be an object');
  }

  const forbidden = [
    'companyId',
    'company',
    'userId',
    'user',
    'employeeId',
    'employee',
    'requesterId',
    'requester',
  ];

  for (const field of forbidden) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw ApiError.badRequest(`${field} must not be supplied by the client`);
    }
  }
};

export const validateHelpdeskTicketCreateInput = (input = {}) => {
  assertNoClientIdentity(input);
  const allowedFields = [
    'queueId',
    'categoryId',
    'subject',
    'description',
    'confidential',
    'requestedPriority',
  ];
  const unsupportedField = Object.keys(input).find((field) => !allowedFields.includes(field));
  if (unsupportedField) {
    throw ApiError.badRequest(`Unsupported ticket field: ${unsupportedField}`);
  }

  if (typeof input.subject !== 'string') {
    throw ApiError.badRequest('subject must be a string');
  }
  if (typeof input.description !== 'string') {
    throw ApiError.badRequest('description must be a string');
  }

  const subject = normalizeHelpdeskName(input.subject);
  const description = input.description.trim();
  const queueId = String(input.queueId || '').trim();
  const categoryId = String(input.categoryId || '').trim();
  const confidential = input.confidential === undefined ? false : input.confidential;
  const requestedPriority = input.requestedPriority === undefined
    ? null
    : String(input.requestedPriority).trim().toLowerCase();

  if (subject.length < 2 || subject.length > 120) {
    throw ApiError.badRequest('subject must be between 2 and 120 characters');
  }
  if (description.length < 1 || description.length > 5000) {
    throw ApiError.badRequest('description must be between 1 and 5000 characters');
  }
  if (!/^[a-f\d]{24}$/i.test(queueId)) {
    throw ApiError.badRequest('queueId must be a valid identifier');
  }
  if (!/^[a-f\d]{24}$/i.test(categoryId)) {
    throw ApiError.badRequest('categoryId must be a valid identifier');
  }
  if (typeof confidential !== 'boolean') {
    throw ApiError.badRequest('confidential must be a boolean');
  }
  if (requestedPriority !== null && !isHelpdeskPriority(requestedPriority)) {
    throw ApiError.badRequest('requestedPriority is not supported');
  }

  return {
    queueId,
    categoryId,
    subject,
    description,
    confidential,
    requestedPriority,
  };
};

export const validateHelpdeskPriority = (priority) => {
  const normalized = String(priority || '').trim().toLowerCase();
  if (!isHelpdeskPriority(normalized)) {
    throw ApiError.badRequest('priority is not supported');
  }
  return normalized;
};

export const validateHelpdeskStatusTransition = ({ currentStatus, nextStatus }) => {
  const normalized = String(nextStatus || '').trim().toLowerCase();
  if (!isHelpdeskStatus(normalized)) {
    throw ApiError.badRequest('status is not supported');
  }
  if (!canTransitionHelpdeskTicket(currentStatus, normalized)) {
    throw ApiError.conflict('The ticket cannot move to that status');
  }
  return normalized;
};
