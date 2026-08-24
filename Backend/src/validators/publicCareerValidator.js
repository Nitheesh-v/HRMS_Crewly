import { param, query, validationResult } from 'express-validator';
import {
  EMPLOYMENT_TYPES,
  JOB_EXPERIENCE_LEVELS,
  JOB_WORK_MODES,
} from '../models/JobPosting.js';
import ApiError from '../utils/ApiError.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);

  if (errors.isEmpty()) return next();

  const normalized = errors.array().map((error) => ({
    field: error.path,
    message: error.msg,
  }));

  throw ApiError.badRequest(
    normalized[0]?.message || 'Invalid career portal request',
    normalized
  );
};

const companySlugRule = param('companySlug')
  .trim()
  .toLowerCase()
  .isLength({ min: 3, max: 63 })
  .withMessage('Invalid career portal address')
  .matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .withMessage('Invalid career portal address');

const clampInteger = ({ minimum, maximum, fallback }) => (value) => {
  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const listQueryRules = [
  query('page')
    .optional()
    .customSanitizer(
      clampInteger({ minimum: 1, maximum: 10000, fallback: 1 })
    ),
  query('limit')
    .optional()
    .customSanitizer(
      clampInteger({ minimum: 1, maximum: 24, fallback: 12 })
    ),
  query('search')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 100 })
    .withMessage('Search must be 100 characters or fewer'),
  query('department')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 80 })
    .withMessage('Department filter is too long'),
  query('location')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 120 })
    .withMessage('Location filter is too long'),
  query('workMode')
    .optional({ values: 'falsy' })
    .isIn(JOB_WORK_MODES)
    .withMessage('Invalid work mode filter'),
  query('employmentType')
    .optional({ values: 'falsy' })
    .isIn(EMPLOYMENT_TYPES)
    .withMessage('Invalid employment type filter'),
  query('experience')
    .optional({ values: 'falsy' })
    .isIn(JOB_EXPERIENCE_LEVELS)
    .withMessage('Invalid experience filter'),
  query('sort')
    .optional({ values: 'falsy' })
    .toUpperCase()
    .isIn(['NEWEST', 'OLDEST', 'TITLE_ASC'])
    .withMessage('Invalid job sort option'),
];

export const careerHeaderRules = [companySlugRule, validate];

export const careerJobListRules = [
  companySlugRule,
  ...listQueryRules,
  validate,
];

export const careerJobDetailRules = [
  companySlugRule,
  param('jobCode')
    .trim()
    .toUpperCase()
    .isLength({ min: 4, max: 30 })
    .withMessage('Invalid job code')
    .matches(/^[A-Z0-9-]+$/)
    .withMessage('Invalid job code'),
  validate,
];

export const careerFilterRules = [companySlugRule, validate];
