import { param, query, validationResult } from 'express-validator';
import { CANDIDATE_SOURCES, CANDIDATE_STAGES } from '../models/Candidate.js';
import ApiError from '../utils/ApiError.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);

  if (errors.isEmpty()) return next();

  const normalized = errors.array().map((error) => ({
    field: error.path,
    message: error.msg,
  }));

  throw ApiError.badRequest(
    normalized[0]?.message || 'Invalid candidate request',
    normalized
  );
};

const clampInteger = ({ minimum, maximum, fallback }) => (value) => {
  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const candidateReferenceRule = param('candidateRef')
  .trim()
  .isLength({ min: 10, max: 30 })
  .withMessage('Invalid candidate reference')
  .custom(
    (value) =>
      /^[a-f\d]{24}$/i.test(value) || /^CAN-\d{6,}$/i.test(value)
  )
  .withMessage('Invalid candidate reference');

export const candidateInboxListRules = [
  query('page')
    .optional()
    .customSanitizer(
      clampInteger({ minimum: 1, maximum: 10000, fallback: 1 })
    ),
  query('limit')
    .optional()
    .customSanitizer(
      clampInteger({ minimum: 1, maximum: 100, fallback: 20 })
    ),
  query('search')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 100 })
    .withMessage('Search must be 100 characters or fewer'),
  query('job')
    .optional({ values: 'falsy' })
    .isMongoId()
    .withMessage('Invalid job filter'),
  query('source')
    .optional({ values: 'falsy' })
    .toUpperCase()
    .isIn(CANDIDATE_SOURCES)
    .withMessage('Invalid candidate source'),
  query('stage')
    .optional({ values: 'falsy' })
    .toUpperCase()
    .isIn(CANDIDATE_STAGES)
    .withMessage('Invalid candidate stage'),
  query('dateFrom')
    .optional({ values: 'falsy' })
    .isISO8601({ strict: true })
    .withMessage('Invalid start date')
    .toDate(),
  query('dateTo')
    .optional({ values: 'falsy' })
    .isISO8601({ strict: true })
    .withMessage('Invalid end date')
    .toDate(),
  validate,
];

export const candidateInboxDetailRules = [candidateReferenceRule, validate];
export const candidateResumeAccessRules = [candidateReferenceRule, validate];
