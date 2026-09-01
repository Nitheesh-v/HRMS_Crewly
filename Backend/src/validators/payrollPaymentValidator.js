import { body, param, query } from 'express-validator';

import { BANK_FILE_FORMATS, FAILURE_REASONS } from '../services/payroll/payrollPaymentRules.js';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const payrollPaymentMonthQueryValidator = [
  query('month')
    .optional()
    .matches(MONTH_PATTERN)
    .withMessage('month must look like 2026-08'),
];

export const payrollPaymentBatchIdParamValidator = [
  param('batchId').isMongoId().withMessage('Invalid payment batch'),
];

export const payrollPaymentFileIdParamValidator = [
  param('fileId').isMongoId().withMessage('Invalid payment file'),
];

export const payrollPaymentEmployeeParamValidator = [
  param('batchId').isMongoId().withMessage('Invalid payment batch'),
  param('employeeId').isMongoId().withMessage('Invalid employee'),
];

export const createPaymentBatchValidator = [
  body('month').matches(MONTH_PATTERN).withMessage('month must look like 2026-08'),
  body('paymentDate')
    .optional()
    .isISO8601()
    .withMessage('paymentDate must be a date'),
];

export const generatePaymentFileValidator = [
  body('format')
    .optional()
    .isIn(BANK_FILE_FORMATS)
    .withMessage('format must be CSV or XLSX'),
];

export const markPaymentEmployeeValidator = [
  body('status').isIn(['PAID', 'FAILED', 'PENDING']).withMessage('status must be paid, failed or pending'),
  body('failureReason')
    .optional()
    .isIn(FAILURE_REASONS)
    .withMessage('Unknown failure reason'),
  body('remarks').optional().isString().trim().isLength({ max: 500 }),
];

export const cancelPaymentBatchValidator = [
  body('reason').optional().isString().trim().isLength({ max: 2000 }),
];
