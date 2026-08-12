import { body, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((e) => ({ field: e.path, message: e.msg }));
  throw err;
};

export const resignRules = [
  body('reason').trim().notEmpty().withMessage('Reason is required').isLength({ min: 10, max: 500 }).withMessage('Reason must be 10–500 characters'),
  body('lastWorkingDate').notEmpty().withMessage('Last working date is required').isISO8601().withMessage('Last working date must be a valid date'),
  validate,
];

export const decideRules = [
  body('action').isIn(['APPROVE', 'REJECT']).withMessage('Action must be APPROVE or REJECT'),
  body('note').optional({ values: 'falsy' }).trim().isLength({ max: 300 }),
  validate,
];