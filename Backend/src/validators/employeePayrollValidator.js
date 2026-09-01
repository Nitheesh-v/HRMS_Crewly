// ─────────────────────────────────────────────────────────────
// Phase 29.4 — Employee Payroll Profile validators
//
// STRUCTURAL checks only (shape, enums, sizes). Business rules
// (CTC ↔ gross alignment, active structure, statutory rules from
// 29.1, no overlapping revisions) live in
// services/payroll/employeePayrollRules.js so every caller —
// including the recruitment conversion — is protected equally.
// ─────────────────────────────────────────────────────────────
import { body, param, query, validationResult } from 'express-validator';

import ApiError from '../utils/ApiError.js';
import {
  ACCOUNT_TYPES,
  EMPLOYMENT_TYPES,
  PAYROLL_STATUSES,
  PAY_GROUPS,
  PAYMENT_METHODS,
  RESIDENTIAL_STATUSES,
  TAX_REGIMES,
} from '../services/payroll/employeePayrollRules.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((e) => ({ field: e.path, message: e.msg }));
  throw err;
};

export const employeeIdParamValidator = [
  param('employeeId').isMongoId().withMessage('Invalid employee'),
  validate,
];

export const payrollProfileListValidator = [
  query('search').optional().isString().trim().isLength({ max: 80 }),
  query('payrollStatus')
    .optional()
    .isIn([...PAYROLL_STATUSES, 'ALL'])
    .withMessage('Invalid payroll status filter'),
  query('employmentType')
    .optional()
    .isIn([...EMPLOYMENT_TYPES, 'ALL'])
    .withMessage('Invalid employment type filter'),
  query('structureId').optional().isMongoId().withMessage('Invalid salary structure filter'),
  query('departmentId').optional().isMongoId().withMessage('Invalid department filter'),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 200 }),
  validate,
];

export const payrollProfileSaveValidator = [
  param('employeeId').isMongoId().withMessage('Invalid employee'),
  body().isObject().withMessage('Request body must be an object'),
  body('structureId').optional({ nullable: true }).isMongoId().withMessage('Choose a valid salary structure'),
  body('annualCtc').optional().isFloat({ min: 0, max: 1000000000 }),
  body('monthlyGross').optional().isFloat({ min: 0, max: 1000000000 }),
  body('employmentType').optional().isIn(EMPLOYMENT_TYPES),
  body('payGroup').optional().isIn(PAY_GROUPS),
  body('payrollStatus').optional().isIn(PAYROLL_STATUSES),
  body('designation').optional().isString().trim().isLength({ max: 80 }),
  body('effectiveFrom').optional({ nullable: true }).isISO8601().withMessage('Effective date is not a valid date'),

  body('bank').optional().isObject(),
  body('bank.bankName').optional().isString().trim().isLength({ max: 120 }),
  body('bank.accountHolderName').optional().isString().trim().isLength({ max: 120 }),
  body('bank.accountNumber').optional().isString().trim().isLength({ min: 9, max: 18 }),
  body('bank.ifsc').optional().isString().trim().isLength({ max: 11 }),
  body('bank.branch').optional().isString().trim().isLength({ max: 120 }),
  body('bank.accountType').optional().isIn(ACCOUNT_TYPES),
  body('bank.paymentMethod').optional().isIn(PAYMENT_METHODS),

  body('statutory').optional().isObject(),
  body('statutory.pan').optional().isString().trim().isLength({ max: 10 }),
  body('statutory.aadhaar').optional().isString().trim().isLength({ max: 12 }),
  body('statutory.uan').optional().isString().trim().isLength({ max: 12 }),
  body('statutory.esiNumber').optional().isString().trim().isLength({ max: 17 }),
  body('statutory.pfMember').optional().isBoolean(),
  body('statutory.gratuityEligible').optional().isBoolean(),

  body('tax').optional().isObject(),
  body('tax.regime').optional().isIn(TAX_REGIMES),
  body('tax.tdsApplicable').optional().isBoolean(),
  body('tax.panVerified').optional().isBoolean(),
  body('tax.declarationStatus').optional().isString().trim().isLength({ max: 30 }),
  body('tax.residentialStatus').optional().isIn(RESIDENTIAL_STATUSES),
  validate,
];

export const payrollProfileStatusValidator = [
  param('employeeId').isMongoId().withMessage('Invalid employee'),
  body('status').isIn(PAYROLL_STATUSES).withMessage('Invalid payroll status'),
  validate,
];

export const payrollProfilePreviewValidator = [
  body('structureId').isMongoId().withMessage('Choose a salary structure'),
  body('monthlyGross').isFloat({ min: 0 }).withMessage('Monthly gross must be a positive number'),
  validate,
];
