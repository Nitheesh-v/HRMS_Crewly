import { body, param, query, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';
import {
  HELPDESK_PRIORITIES,
  HELPDESK_TICKET_LIST_MAX_LIMIT,
  HELPDESK_TICKET_LIST_MAX_PAGE,
  HELPDESK_TICKET_LIST_QUERY_FIELDS,
  HELPDESK_TICKET_LIST_SEARCH_MAX_LENGTH,
  HELPDESK_TICKET_LIST_SORTS,
  isHelpdeskPriority,
  isHelpdeskStatus,
} from '../services/helpdesk/helpdeskRules.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const allErrors = errors.array();
  const error = ApiError.badRequest(allErrors[0]?.msg || 'Helpdesk validation failed');
  error.errors = allErrors.map((entry) => ({
    field: entry.path,
    message: entry.msg,
  }));
  throw error;
};

const FORBIDDEN_IDENTITY_FIELDS = Object.freeze([
  'companyId',
  'company',
  'userId',
  'user',
  'employeeId',
  'employee',
  'requesterId',
  'requester',
]);

const onlyBodyFields = (allowedFields) => body().custom((_value, { req }) => {
  const payload = req.body || {};
  for (const field of FORBIDDEN_IDENTITY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      throw new Error(`${field} must not be supplied by the client`);
    }
  }
  const unsupported = Object.keys(payload).find((field) => !allowedFields.includes(field));
  if (unsupported) throw new Error(`Unsupported Helpdesk field: ${unsupported}`);
  return true;
});

const configFields = [
  'enabled',
  'allowEmployeeTickets',
  'attachmentsEnabled',
  'confidentialTicketsEnabled',
  'defaultPriority',
];

const queueFields = [
  'name',
  'description',
  'enabled',
  'categories',
  'agents',
  'managers',
  'confidentiality',
];

const ticketNumberParam = param('ticketNumber')
  .isString()
  .withMessage('ticketNumber must be a string')
  .matches(/^HD-\d{6,}$/)
  .withMessage('ticketNumber is invalid');

const onlyTicketListQueryFields = (req, _res, next) => {
  const unsupported = Object.keys(req.query || {}).find(
    (field) => !HELPDESK_TICKET_LIST_QUERY_FIELDS.includes(field),
  );
  if (unsupported) {
    return next(ApiError.badRequest(`Unsupported Helpdesk ticket filter: ${unsupported}`));
  }
  return next();
};

export const helpdeskConfigUpdateValidator = [
  onlyBodyFields(configFields),
  body().custom((_value, { req }) => {
    if (!Object.keys(req.body || {}).length) throw new Error('Supply at least one Helpdesk setting');
    return true;
  }),
  ...['enabled', 'allowEmployeeTickets', 'attachmentsEnabled', 'confidentialTicketsEnabled'].map((field) =>
    body(field).optional().isBoolean().withMessage(`${field} must be a boolean`),
  ),
  body('defaultPriority')
    .optional()
    .custom((value) => isHelpdeskPriority(value))
    .withMessage(`defaultPriority must be one of: ${HELPDESK_PRIORITIES.join(', ')}`),
  validate,
];

export const helpdeskQueueCreateValidator = [
  onlyBodyFields(queueFields),
  body('name').isString().trim().isLength({ min: 2, max: 80 }).withMessage('Queue name must be 2–80 characters'),
  body('description').optional().isString().isLength({ max: 500 }).withMessage('Queue description is too long'),
  body('enabled').optional().isBoolean().withMessage('enabled must be a boolean'),
  body('categories').optional().isArray({ max: 100 }).withMessage('categories must be an array of at most 100 items'),
  body('agents').optional().isArray({ max: 500 }).withMessage('agents must be an array of at most 500 ids'),
  body('managers').optional().isArray({ max: 500 }).withMessage('managers must be an array of at most 500 ids'),
  body('confidentiality').optional().isObject().withMessage('confidentiality must be an object'),
  validate,
];

export const helpdeskQueueUpdateValidator = [
  onlyBodyFields(queueFields),
  body().custom((_value, { req }) => {
    if (!Object.keys(req.body || {}).length) throw new Error('Supply at least one queue setting');
    return true;
  }),
  body('name').optional().isString().trim().isLength({ min: 2, max: 80 }).withMessage('Queue name must be 2–80 characters'),
  body('description').optional().isString().isLength({ max: 500 }).withMessage('Queue description is too long'),
  body('enabled').optional().isBoolean().withMessage('enabled must be a boolean'),
  body('categories').optional().isArray({ max: 100 }).withMessage('categories must be an array of at most 100 items'),
  body('agents').optional().isArray({ max: 500 }).withMessage('agents must be an array of at most 500 ids'),
  body('managers').optional().isArray({ max: 500 }).withMessage('managers must be an array of at most 500 ids'),
  body('confidentiality').optional().isObject().withMessage('confidentiality must be an object'),
  param('queueId').isMongoId().withMessage('queueId is invalid'),
  validate,
];

export const helpdeskQueueIdParamValidator = [
  param('queueId').isMongoId().withMessage('queueId is invalid'),
  validate,
];

export const helpdeskTicketCreateValidator = [
  onlyBodyFields([
    'queueId',
    'categoryId',
    'subject',
    'description',
    'confidential',
    'requestedPriority',
  ]),
  body('queueId').isMongoId().withMessage('queueId is invalid'),
  body('categoryId').isMongoId().withMessage('categoryId is invalid'),
  body('subject').isString().trim().isLength({ min: 2, max: 120 }).withMessage('subject must be 2–120 characters'),
  body('description').isString().trim().isLength({ min: 1, max: 5000 }).withMessage('description must be 1–5000 characters'),
  body('confidential').optional().isBoolean().withMessage('confidential must be a boolean'),
  body('requestedPriority')
    .optional({ nullable: true })
    .custom((value) => isHelpdeskPriority(value))
    .withMessage('requestedPriority is invalid'),
  validate,
];

export const helpdeskTicketReadParamValidator = [ticketNumberParam, validate];

export const helpdeskTicketStatusValidator = [
  ticketNumberParam,
  onlyBodyFields(['status']),
  body('status').isString().custom((value) => isHelpdeskStatus(value)).withMessage('status is invalid'),
  validate,
];

export const helpdeskTicketPriorityValidator = [
  ticketNumberParam,
  onlyBodyFields(['priority']),
  body('priority').isString().custom((value) => isHelpdeskPriority(value)).withMessage('priority is invalid'),
  validate,
];

export const helpdeskTicketAssignmentValidator = [
  ticketNumberParam,
  onlyBodyFields(['assigneeId']),
  body('assigneeId').isMongoId().withMessage('assigneeId is invalid'),
  validate,
];

export const helpdeskTicketCancelValidator = [
  ticketNumberParam,
  onlyBodyFields([]),
  validate,
];

export const helpdeskTicketListQueryValidator = [
  onlyTicketListQueryFields,
  query('status')
    .optional()
    .isString()
    .bail()
    .custom((value) => isHelpdeskStatus(value))
    .withMessage('status is not supported'),
  query('priority')
    .optional()
    .isString()
    .bail()
    .custom((value) => isHelpdeskPriority(value))
    .withMessage('priority is not supported'),
  query('queueId').optional().isMongoId().withMessage('queueId is invalid'),
  query('search')
    .optional()
    .isString()
    .trim()
    .isLength({ max: HELPDESK_TICKET_LIST_SEARCH_MAX_LENGTH })
    .withMessage(`search must be at most ${HELPDESK_TICKET_LIST_SEARCH_MAX_LENGTH} characters`),
  query('sort')
    .optional()
    .isString()
    .bail()
    .custom((value) => HELPDESK_TICKET_LIST_SORTS.includes(value.trim().toLowerCase()))
    .withMessage('sort is not supported'),
  query('page')
    .optional()
    .matches(/^[0-9]+$/)
    .isInt({ min: 1, max: HELPDESK_TICKET_LIST_MAX_PAGE })
    .withMessage(`page must be between 1 and ${HELPDESK_TICKET_LIST_MAX_PAGE}`),
  query('limit')
    .optional()
    .matches(/^[0-9]+$/)
    .isInt({ min: 1, max: HELPDESK_TICKET_LIST_MAX_LIMIT })
    .withMessage(`limit must be between 1 and ${HELPDESK_TICKET_LIST_MAX_LIMIT}`),
  validate,
];

export const helpdeskLimitValidator = [
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
  validate,
];
