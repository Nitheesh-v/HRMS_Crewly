// ─────────────────────────────────────────────────────────────
// Phase 29.6 — Payroll Engine validators (shape only)
//
// The engine's own rules live in payrollEngineRules.js. These
// checks only reject what is obviously malformed before it reaches
// the service: a bad month, a bad id, a runaway selection.
// ─────────────────────────────────────────────────────────────
import { body, param, query, validationResult } from 'express-validator';

import ApiError from '../utils/ApiError.js';
import { PAYROLL_RESULT_STATUSES } from '../services/payroll/payrollEngineRules.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const first = errors.array()[0];
    return next(ApiError.badRequest(first.msg, { fields: errors.array() }));
  }
  return next();
};

export const payrollMonthParamValidator = [
  param('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  validate,
];

export const payrollResultParamValidator = [
  param('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  param('employeeId').isMongoId().withMessage('Invalid employee'),
  validate,
];

export const payrollResultsQueryValidator = [
  param('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  query('status')
    .optional()
    .isIn(['ALL', ...PAYROLL_RESULT_STATUSES])
    .withMessage('Invalid result status filter'),
  query('search').optional().isString().trim().isLength({ max: 80 }),
  validate,
];

export const payrollSelectionValidator = [
  param('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  body('employeeIds').optional().isArray({ max: 5000 }),
  body('employeeIds.*').optional().isMongoId().withMessage('Invalid employee in the selection'),
  validate,
];

export const payrollCancelValidator = [
  param('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  validate,
];

export default {
  payrollMonthParamValidator,
  payrollResultParamValidator,
  payrollResultsQueryValidator,
  payrollSelectionValidator,
  payrollCancelValidator,
};
