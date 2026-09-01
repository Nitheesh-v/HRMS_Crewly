// ─────────────────────────────────────────────────────────────
// Phase 29.7 — Payroll Review validators (shape only)
//
// The workflow rules live in payrollReviewRules.js. These checks
// only reject what is obviously malformed before it reaches the
// service: a bad month, a bad id, a runaway selection.
// ─────────────────────────────────────────────────────────────
import { body, param, validationResult } from 'express-validator';

import ApiError from '../utils/ApiError.js';
import {
  BULK_REVIEW_ACTIONS,
  CHECKLIST_ITEMS,
  EXPORT_REPORTS,
} from '../services/payroll/payrollReviewRules.js';

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

export const payrollReviewEmployeeParamValidator = [
  param('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  param('employeeId').isMongoId().withMessage('Invalid employee'),
  validate,
];

export const payrollChecklistValidator = [
  param('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  param('item')
    .isIn(CHECKLIST_ITEMS.map((row) => row.key))
    .withMessage('Unknown checklist item'),
  body('value').isBoolean().withMessage('Checklist value must be true or false'),
  validate,
];

export const payrollRemarkValidator = [
  param('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  body('message').isString().trim().isLength({ min: 1, max: 2000 }).withMessage('Write a remark'),
  body('channel').optional().isIn(['HR', 'FINANCE']).withMessage('Unknown remark channel'),
  validate,
];

export const payrollReviewEmployeeBodyValidator = [
  param('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  param('employeeId').isMongoId().withMessage('Invalid employee'),
  body('state').optional().isIn(['PENDING', 'REVIEWED']),
  body('note').optional().isString().trim().isLength({ max: 500 }),
  validate,
];

export const payrollBulkReviewValidator = [
  param('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  body('action').isIn(BULK_REVIEW_ACTIONS).withMessage('Unknown review action'),
  body('employeeIds').optional().isArray({ max: 5000 }),
  body('employeeIds.*').optional().isMongoId().withMessage('Invalid employee in the selection'),
  validate,
];

export const payrollReasonValidator = [
  param('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  body('reason').isString().trim().isLength({ min: 1, max: 1000 }).withMessage('A reason is required'),
  validate,
];

export const payrollExportValidator = [
  param('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  body('reportKey')
    .isIn(EXPORT_REPORTS.map((row) => row.key))
    .withMessage('Unknown report'),
  validate,
];

export const payrollExportIdValidator = [
  param('exportId').isMongoId().withMessage('Invalid export'),
  validate,
];

export default {
  payrollMonthParamValidator,
  payrollReviewEmployeeParamValidator,
  payrollChecklistValidator,
  payrollRemarkValidator,
  payrollReviewEmployeeBodyValidator,
  payrollBulkReviewValidator,
  payrollReasonValidator,
  payrollExportValidator,
  payrollExportIdValidator,
};
