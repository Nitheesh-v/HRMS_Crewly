// ─────────────────────────────────────────────────────────────
// Phase 29.5 — Monthly Payroll Input validators
//
// STRUCTURAL checks only. Business rules (duplicate bonus,
// negative amounts, month matching, profile required) live in
// services/payroll/monthlyInputRules.js so the API, the bulk
// import and a future job are all protected the same way.
// ─────────────────────────────────────────────────────────────
import { body, param, query, validationResult } from 'express-validator';

import ApiError from '../utils/ApiError.js';
import {
  BULK_ACTIONS,
  ENTRY_TYPES,
  INPUT_STATUSES,
  PERIOD_STATUSES,
} from '../services/payroll/monthlyInputRules.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((e) => ({ field: e.path, message: e.msg }));
  throw err;
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const monthQueryValidator = [
  query('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  validate,
];

export const monthlyInputListValidator = [
  query('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  query('search').optional().isString().trim().isLength({ max: 80 }),
  query('status')
    .optional()
    .isIn([...INPUT_STATUSES, 'ALL'])
    .withMessage('Invalid status filter'),
  validate,
];

export const monthBodyValidator = [
  body('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  validate,
];

export const monthlyInputEntryValidator = [
  param('employeeId').isMongoId().withMessage('Invalid employee'),
  body('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  body('type').isIn(ENTRY_TYPES).withMessage('Choose a valid variable pay type'),
  body('amount').isFloat({ min: 0.01, max: 100000000 }).withMessage('Amount must be greater than zero'),
  body('reason').isString().trim().isLength({ min: 2, max: 200 }).withMessage('A reason is required'),
  body('remarks').optional().isString().trim().isLength({ max: 300 }),
  body('claimDate').optional({ nullable: true }).isISO8601(),
  validate,
];

export const monthlyInputEntryPatchValidator = [
  param('employeeId').isMongoId().withMessage('Invalid employee'),
  param('entryId').isString().trim().isLength({ min: 1, max: 80 }),
  body('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  body('type').optional().isIn(ENTRY_TYPES),
  body('amount').optional().isFloat({ min: 0.01, max: 100000000 }),
  body('reason').optional().isString().trim().isLength({ min: 2, max: 200 }),
  body('remarks').optional().isString().trim().isLength({ max: 300 }),
  body('claimStatus').optional().isIn(['PENDING', 'APPROVED', 'REJECTED']),
  validate,
];

export const monthlyInputEntryIdValidator = [
  param('employeeId').isMongoId().withMessage('Invalid employee'),
  param('entryId').isString().trim().isLength({ min: 1, max: 80 }),
  query('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  validate,
];

export const bulkActionValidator = [
  body('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  body('action').isIn(BULK_ACTIONS).withMessage('Unknown bulk action'),
  body('employeeIds').optional().isArray({ max: 2000 }),
  body('employeeIds.*').optional().isMongoId().withMessage('Invalid employee in the selection'),
  body('amount').optional().isFloat({ min: 0.01, max: 100000000 }),
  body('reason').optional().isString().trim().isLength({ max: 200 }),
  body('remarks').optional().isString().trim().isLength({ max: 300 }),
  validate,
];

export const importPreviewValidator = [
  body('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  body('content').isString().isLength({ min: 1, max: 5000000 }).withMessage('Upload a CSV file'),
  validate,
];

export const importConfirmValidator = [
  body('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  body('rows').isArray({ max: 5000 }).withMessage('Nothing to import'),
  body('rows.*.employeeId').isMongoId().withMessage('Invalid employee in the import'),
  body('rows.*.entry.type').isIn(ENTRY_TYPES).withMessage('Invalid type in the import'),
  body('rows.*.entry.amount')
    .isFloat({ min: 0.01, max: 100000000 })
    .withMessage('Invalid amount in the import'),
  validate,
];

// §10 — HR notes saved from the drawer.
export const monthlyInputRemarksValidator = [
  param('employeeId').isMongoId().withMessage('Invalid employee'),
  body('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  body('remarks').optional().isString().trim().isLength({ max: 500 }),
  validate,
];

export const periodStatusValidator = [
  body('month').matches(MONTH).withMessage('Payroll month must look like 2026-08'),
  body('status').isIn(PERIOD_STATUSES).withMessage('Invalid payroll month status'),
  validate,
];
