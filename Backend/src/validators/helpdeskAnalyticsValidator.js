import { param, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';
import { normalizeHelpdeskAnalyticsQuery } from '../services/helpdesk/helpdeskAnalyticsRules.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const error = ApiError.badRequest(errors.array()[0]?.msg || 'Helpdesk analytics validation failed.');
  error.errors = errors.array().map((entry) => ({ field: entry.path, message: entry.msg }));
  return next(error);
};

export const helpdeskAnalyticsQueryValidator = [
  (req, _res, next) => {
    try {
      normalizeHelpdeskAnalyticsQuery(req.query || {});
      return next();
    } catch (error) {
      return next(error);
    }
  },
];

export const helpdeskAnalyticsQueueIdValidator = [
  param('queueId').isMongoId().withMessage('queueId is invalid'),
  validate,
];
