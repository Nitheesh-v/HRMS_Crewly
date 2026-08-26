import { query, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed'));
  }
  return next();
};

export const recruitmentAnalyticsOverviewRules = [
  query('range')
    .optional({ nullable: true, checkFalsy: true })
    .isIn([
      'LAST_7_DAYS',
      'LAST_30_DAYS',
      'LAST_90_DAYS',
      'THIS_MONTH',
      'THIS_QUARTER',
      'THIS_YEAR',
    ])
    .withMessage('Choose a valid range preset'),
  query('from')
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage('from must be a valid date'),
  query('to')
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage('to must be a valid date'),
  query('jobId')
    .optional({ nullable: true, checkFalsy: true })
    .isMongoId()
    .withMessage('Choose a valid job'),
  query('departmentId')
    .optional({ nullable: true, checkFalsy: true })
    .isMongoId()
    .withMessage('Choose a valid department'),
  query('recruiterId')
    .optional({ nullable: true, checkFalsy: true })
    .isMongoId()
    .withMessage('Choose a valid recruiter'),
  query('hiringManagerId')
    .optional({ nullable: true, checkFalsy: true })
    .isMongoId()
    .withMessage('Choose a valid hiring manager'),
  query('source')
    .optional({ nullable: true, checkFalsy: true })
    .isIn(['INTERNAL', 'CAREER_PAGE'])
    .withMessage('Choose a valid source'),
  validate,
];
