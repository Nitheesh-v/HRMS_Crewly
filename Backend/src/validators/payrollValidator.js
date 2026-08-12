import { body, query, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((e) => ({ field: e.path, message: e.msg }));
  throw err;
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_MSG = 'Month must be in YYYY-MM format';

export const upsertStructureValidator = [
  body('basic').isFloat({ min: 0 }).withMessage('Basic must be 0 or more'),
  body('hra').isFloat({ min: 0 }).withMessage('HRA must be 0 or more'),
  body('allowances').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Allowances must be 0 or more'),
  body('pfPercent').optional({ values: 'falsy' }).isFloat({ min: 0, max: 12 }).withMessage('PF percent must be between 0 and 12'),
  body('professionalTax').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Professional tax must be 0 or more'),
  validate,
];

export const generatePayrollValidator = [
  body('month').matches(MONTH_RE).withMessage(MONTH_MSG),
  validate,
];

export const monthQueryValidator = [
  query('month').optional({ values: 'falsy' }).matches(MONTH_RE).withMessage(MONTH_MSG),
  validate,
];