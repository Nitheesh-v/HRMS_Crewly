import { body, param, query, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';
import {
  HELPDESK_KB_BODY_MAX,
  HELPDESK_KB_CATEGORY_NAME_MAX,
  HELPDESK_KB_CURSOR_MAX,
  HELPDESK_KB_DESCRIPTION_MAX,
  HELPDESK_KB_MESSAGE_ARTICLES_MAX,
  HELPDESK_KB_RELATED_ARTICLES_MAX,
  HELPDESK_KB_SEARCH_MAX,
  HELPDESK_KB_SEARCH_MAX_LIMIT,
  HELPDESK_KB_STATUSES,
  HELPDESK_KB_SUMMARY_MAX,
  HELPDESK_KB_TITLE_MAX,
} from '../services/helpdesk/helpdeskKnowledgeBaseRules.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const allErrors = errors.array();
  const error = ApiError.badRequest(allErrors[0]?.msg || 'Knowledge Base validation failed');
  error.errors = allErrors.map((entry) => ({ field: entry.path, message: entry.msg }));
  return next(error);
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
  'createdBy',
  'updatedBy',
  'publishedBy',
  'archivedBy',
]);

const onlyBodyFields = (allowedFields) => body().custom((_value, { req }) => {
  const payload = req.body || {};
  for (const field of FORBIDDEN_IDENTITY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      throw new Error(`${field} must not be supplied by the client`);
    }
  }
  const unsupported = Object.keys(payload).find((field) => !allowedFields.includes(field));
  if (unsupported) throw new Error(`Unsupported Knowledge Base field: ${unsupported}`);
  return true;
});

const onlyQueryFields = (allowedFields, kind = 'Knowledge Base') => (req, _res, next) => {
  const unsupported = Object.keys(req.query || {}).find((field) => !allowedFields.includes(field));
  if (unsupported) return next(ApiError.badRequest(`Unsupported ${kind} filter: ${unsupported}`));
  return next();
};

const slugRule = (field = 'slug') =>
  param(field)
    .isString()
    .isLength({ min: 2, max: 120 })
    .matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i)
    .withMessage(`${field} is invalid`);

const cursorRule = (builder, field) =>
  builder(field)
    .optional()
    .isString()
    .isLength({ min: 1, max: HELPDESK_KB_CURSOR_MAX })
    .matches(/^[A-Za-z0-9_-]+$/)
    .withMessage(`${field} is invalid`);

const limitRule = (builder, field) =>
  builder(field)
    .optional()
    .matches(/^[0-9]+$/)
    .custom((value) => Number(value) >= 1 && Number(value) <= HELPDESK_KB_SEARCH_MAX_LIMIT)
    .withMessage(`limit must be an integer from 1 to ${HELPDESK_KB_SEARCH_MAX_LIMIT}`);

const categoryIdRule = (builder, field) =>
  builder(field)
    .isMongoId()
    .withMessage(`${field} must be a valid id`);

const articleContentFields = [
  'title',
  'summary',
  'body',
  'categoryId',
  'relatedQueueId',
  'visibility',
  'relatedArticleIds',
];

const articleFieldValidators = () => [
  body('title').optional().isString().isLength({ min: 1, max: HELPDESK_KB_TITLE_MAX }).withMessage(`title must be 1–${HELPDESK_KB_TITLE_MAX} characters`),
  body('summary').optional().isString().isLength({ max: HELPDESK_KB_SUMMARY_MAX }).withMessage(`summary must be at most ${HELPDESK_KB_SUMMARY_MAX} characters`),
  body('body').optional().isString().isLength({ min: 1, max: HELPDESK_KB_BODY_MAX }).withMessage(`body must be 1–${HELPDESK_KB_BODY_MAX} characters`),
  body('categoryId').optional().isMongoId().withMessage('categoryId must be a valid id'),
  body('relatedQueueId').optional({ nullable: true, checkFalsy: true }).isMongoId().withMessage('relatedQueueId must be a valid id'),
  body('visibility').optional().isIn(['employees', 'queue_staff', 'confidential_queue_staff']).withMessage('visibility is not supported'),
  body('relatedArticleIds').optional().isArray({ max: HELPDESK_KB_RELATED_ARTICLES_MAX }).withMessage(`relatedArticleIds must contain at most ${HELPDESK_KB_RELATED_ARTICLES_MAX} ids`),
  body('relatedArticleIds.*').isMongoId().withMessage('relatedArticleIds must contain valid ids'),
];

export const helpdeskKbSearchValidator = [
  onlyQueryFields(['search', 'categoryId', 'queueId', 'cursor', 'limit']),
  query('search').optional().isString().isLength({ min: 2, max: HELPDESK_KB_SEARCH_MAX }).withMessage(`search must be 2–${HELPDESK_KB_SEARCH_MAX} characters`),
  query('categoryId').optional().isMongoId().withMessage('categoryId must be a valid id'),
  query('queueId').optional().isMongoId().withMessage('queueId must be a valid id'),
  cursorRule(query, 'cursor'),
  limitRule(query, 'limit'),
  validate,
];

export const helpdeskKbArticleSlugParamValidator = [
  slugRule('slug'),
  validate,
];

export const helpdeskKbArticleIdParamValidator = [
  param('articleId').isMongoId().withMessage('articleId must be a valid id'),
  validate,
];

export const helpdeskKbCategoryIdParamValidator = [
  param('categoryId').isMongoId().withMessage('categoryId must be a valid id'),
  validate,
];

export const helpdeskKbAdminRevisionListValidator = [
  onlyQueryFields(['cursor', 'limit'], 'Knowledge Base revision'),
  cursorRule(query, 'cursor'),
  limitRule(query, 'limit'),
  validate,
];

export const helpdeskKbRevisionParamValidator = [
  param('articleId').isMongoId().withMessage('articleId must be a valid id'),
  param('revision').matches(/^[0-9]+$/).custom((value) => Number(value) >= 1 && Number(value) <= 1_000_000_000)
    .withMessage('revision must be a positive integer'),
  validate,
];

export const helpdeskKbAdminArticleListValidator = [
  onlyQueryFields(['status', 'categoryId', 'cursor', 'limit'], 'Knowledge Base article'),
  query('status').optional().isIn(HELPDESK_KB_STATUSES).withMessage('status is not supported'),
  query('categoryId').optional().isMongoId().withMessage('categoryId must be a valid id'),
  cursorRule(query, 'cursor'),
  limitRule(query, 'limit'),
  validate,
];

export const helpdeskKbArticleCreateValidator = [
  onlyBodyFields(['slug', ...articleContentFields]),
  body('slug').isString().trim().isLength({ min: 2, max: 120 }).matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i).withMessage('slug is invalid'),
  body('title').isString().isLength({ min: 1, max: HELPDESK_KB_TITLE_MAX }).withMessage(`title must be 1–${HELPDESK_KB_TITLE_MAX} characters`),
  body('summary').optional().isString().isLength({ max: HELPDESK_KB_SUMMARY_MAX }).withMessage(`summary must be at most ${HELPDESK_KB_SUMMARY_MAX} characters`),
  body('body').isString().isLength({ min: 1, max: HELPDESK_KB_BODY_MAX }).withMessage(`body must be 1–${HELPDESK_KB_BODY_MAX} characters`),
  body('categoryId').isMongoId().withMessage('categoryId must be a valid id'),
  body('relatedQueueId').optional({ nullable: true, checkFalsy: true }).isMongoId().withMessage('relatedQueueId must be a valid id'),
  body('visibility').isIn(['employees', 'queue_staff', 'confidential_queue_staff']).withMessage('visibility is required and must be supported'),
  body('relatedArticleIds').optional().isArray({ max: HELPDESK_KB_RELATED_ARTICLES_MAX }).withMessage(`relatedArticleIds must contain at most ${HELPDESK_KB_RELATED_ARTICLES_MAX} ids`),
  body('relatedArticleIds.*').isMongoId().withMessage('relatedArticleIds must contain valid ids'),
  validate,
];

export const helpdeskKbArticleUpdateValidator = [
  onlyBodyFields(['expectedVersion', ...articleContentFields]),
  body().custom((_value, { req }) => {
    if (!articleContentFields.some((field) => Object.prototype.hasOwnProperty.call(req.body || {}, field))) {
      throw new Error('Supply at least one article field');
    }
    return true;
  }),
  body('expectedVersion').isInt({ min: 1, max: 1_000_000_000 }).withMessage('expectedVersion must be a positive integer'),
  ...articleFieldValidators(),
  validate,
];

export const helpdeskKbArticleTransitionValidator = [
  onlyBodyFields(['expectedVersion']),
  body('expectedVersion').isInt({ min: 1, max: 1_000_000_000 }).withMessage('expectedVersion must be a positive integer'),
  validate,
];

export const helpdeskKbCategoryCreateValidator = [
  onlyBodyFields(['name', 'slug', 'description', 'sortOrder']),
  body('name').isString().isLength({ min: 2, max: HELPDESK_KB_CATEGORY_NAME_MAX }).withMessage(`name must be 2–${HELPDESK_KB_CATEGORY_NAME_MAX} characters`),
  body('slug').isString().trim().isLength({ min: 2, max: 120 }).matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i).withMessage('slug is invalid'),
  body('description').optional().isString().isLength({ max: HELPDESK_KB_DESCRIPTION_MAX }).withMessage(`description must be at most ${HELPDESK_KB_DESCRIPTION_MAX} characters`),
  body('sortOrder').optional().isInt({ min: 0, max: 10_000 }).toInt().withMessage('sortOrder must be an integer from 0 to 10000'),
  validate,
];

export const helpdeskKbCategoryUpdateValidator = [
  onlyBodyFields(['expectedVersion', 'name', 'description', 'sortOrder']),
  body().custom((_value, { req }) => {
    if (!['name', 'description', 'sortOrder'].some((field) => Object.prototype.hasOwnProperty.call(req.body || {}, field))) {
      throw new Error('Supply at least one category setting');
    }
    return true;
  }),
  body('expectedVersion').isInt({ min: 1, max: 1_000_000_000 }).withMessage('expectedVersion must be a positive integer'),
  body('name').optional().isString().isLength({ min: 2, max: HELPDESK_KB_CATEGORY_NAME_MAX }).withMessage(`name must be 2–${HELPDESK_KB_CATEGORY_NAME_MAX} characters`),
  body('description').optional().isString().isLength({ max: HELPDESK_KB_DESCRIPTION_MAX }).withMessage(`description must be at most ${HELPDESK_KB_DESCRIPTION_MAX} characters`),
  body('sortOrder').optional().isInt({ min: 0, max: 10_000 }).toInt().withMessage('sortOrder must be an integer from 0 to 10000'),
  validate,
];

export const helpdeskKbTicketArticleIdsValidator = [
  body('relatedArticleIds').optional().isArray({ max: HELPDESK_KB_MESSAGE_ARTICLES_MAX }).withMessage(`relatedArticleIds must contain at most ${HELPDESK_KB_MESSAGE_ARTICLES_MAX} ids`),
  body('relatedArticleIds.*').isMongoId().withMessage('relatedArticleIds must contain valid ids'),
];

export const _helpdeskKnowledgeBaseValidatorTest = {
  FORBIDDEN_IDENTITY_FIELDS,
  articleContentFields,
};
