import { body, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';

// Runs after the rules — collects errors into our standard format.
// We attach .errors AFTER creating the error, so it works with any
// ApiError constructor signature.
export const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((e) => ({ field: e.path, message: e.msg }));
  throw err;
};

export const updateCompanyValidator = [
  body('name').optional({ values: 'falsy' }).trim().isLength({ min: 2, max: 120 }).withMessage('Company name must be 2–120 characters'),
  body('address.line').optional({ values: 'falsy' }).trim().isLength({ max: 160 }).withMessage('Address line is too long'),
  body('address.city').optional({ values: 'falsy' }).trim().isLength({ max: 60 }).withMessage('City is too long'),
  body('address.state').optional({ values: 'falsy' }).trim().isLength({ max: 60 }).withMessage('State is too long'),
  body('address.pincode').optional({ values: 'falsy' }).trim().matches(/^[1-9][0-9]{5}$/).withMessage('Enter a valid 6-digit PIN code'),
  validate,
];