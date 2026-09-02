import { body, param, query, validationResult } from 'express-validator';

import { BANK_FILE_FORMATS, FAILURE_REASONS } from '../services/payroll/payrollPaymentRules.js';

import ApiError from '../utils/ApiError.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * §24 — the half this file was missing.
 *
 * An express-validator chain only COLLECTS errors. Nothing is enforced until
 * something calls validationResult, so without this middleware the chains
 * above were decoration: a malformed month, a non-ObjectId id or an
 * out-of-catalogue `format` sailed straight through to the service.
 */
const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const error = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  error.errors = errors.array().map((entry) => ({ field: entry.path, message: entry.msg }));
  throw error;
};

export const payrollPaymentMonthQueryValidator = [
  query('month')
    .optional()
    .matches(MONTH_PATTERN)
    .withMessage('month must look like 2026-08'),
  validate,
];

export const payrollPaymentBatchIdParamValidator = [
  param('batchId').isMongoId().withMessage('Invalid payment batch'),
  validate,
];

export const payrollPaymentFileIdParamValidator = [
  param('fileId').isMongoId().withMessage('Invalid payment file'),
  validate,
];

export const payrollPaymentEmployeeParamValidator = [
  param('batchId').isMongoId().withMessage('Invalid payment batch'),
  param('employeeId').isMongoId().withMessage('Invalid employee'),
  validate,
];

export const createPaymentBatchValidator = [
  body('month').matches(MONTH_PATTERN).withMessage('month must look like 2026-08'),
  body('paymentDate')
    .optional()
    .isISO8601()
    .withMessage('paymentDate must be a date'),
  validate,
];

export const generatePaymentFileValidator = [
  body('format')
    .optional()
    .isIn(BANK_FILE_FORMATS)
    .withMessage('format must be CSV or XLSX'),
  validate,
];

export const markPaymentEmployeeValidator = [
  body('status').isIn(['PAID', 'FAILED', 'PENDING']).withMessage('status must be paid, failed or pending'),
  body('failureReason')
    .optional()
    .isIn(FAILURE_REASONS)
    .withMessage('Unknown failure reason'),
  body('remarks').optional().isString().trim().isLength({ max: 500 }),
  validate,
];

export const cancelPaymentBatchValidator = [
  body('reason').optional().isString().trim().isLength({ max: 2000 }),
  validate,
];
