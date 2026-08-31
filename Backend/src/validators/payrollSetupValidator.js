// ─────────────────────────────────────────────────────────────
// Phase 29.1 — Company Payroll Setup validators
//
// Structural checks only (shape, enums, sizes). Business/format rules
// (PAN / TAN / IFSC / conditional statutory fields) live once in
// services/payroll/payrollSetupRules.js and run in the service, so the
// same rules protect every future caller (jobs, scripts, tests).
// ─────────────────────────────────────────────────────────────
import { body, param, validationResult } from 'express-validator';

import ApiError from '../utils/ApiError.js';
import { PAYROLL_SETUP_SECTION_KEYS } from '../services/payroll/payrollSetupRules.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((e) => ({ field: e.path, message: e.msg }));
  throw err;
};

export const payrollSetupSectionValidator = [
  param('section')
    .isIn([...PAYROLL_SETUP_SECTION_KEYS])
    .withMessage('Unknown payroll setup section'),
  body().isObject().withMessage('Request body must be an object'),
  body('configVersion')
    .optional({ values: 'falsy' })
    .isInt({ min: 1 })
    .withMessage('configVersion must be a positive integer'),
  body('cycleStartDay').optional({ values: 'falsy' }).isInt({ min: 1, max: 31 }),
  body('cycleEndDay').optional({ values: 'falsy' }).isInt({ min: 1, max: 31 }),
  body('paymentDayOfMonth').optional({ values: 'falsy' }).isInt({ min: 1, max: 31 }),
  body('paymentMonthOffset').optional({ values: 'falsy' }).isInt({ min: 0, max: 1 }),
  body('financialYearStartMonth').optional({ values: 'falsy' }).isInt({ min: 1, max: 12 }),
  body('processingDeadlineDay').optional({ values: 'falsy' }).isInt({ min: 1, max: 31 }),
  body('accountNumber')
    .optional({ values: 'falsy' })
    .isString()
    .withMessage('Account number must be a string')
    .isLength({ min: 8, max: 24 })
    .withMessage('Account number must be 8–24 characters'),
  validate,
];

export const payrollSetupActivateValidator = [
  body('configVersion')
    .optional({ values: 'falsy' })
    .isInt({ min: 1 })
    .withMessage('configVersion must be a positive integer'),
  validate,
];

export const payrollSetupSuspendValidator = [
  body('reason')
    .optional({ values: 'falsy' })
    .isString()
    .withMessage('Reason must be text')
    .isLength({ max: 300 })
    .withMessage('Reason must be 300 characters or fewer'),
  validate,
];
