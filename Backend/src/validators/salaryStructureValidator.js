// ─────────────────────────────────────────────────────────────
// Phase 29.3 — Salary Structure validators
//
// STRUCTURAL checks only (shape, enums, sizes). Business rules
// (one Remaining component, duplicate components, inactive
// components, gross balancing, tenant-unique codes) live in
// services/payroll/salaryStructureRules.js so every caller is
// protected the same way.
// ─────────────────────────────────────────────────────────────
import { body, param, query, validationResult } from 'express-validator';

import ApiError from '../utils/ApiError.js';
import {
  CALCULATION_METHODS,
  STRUCTURE_STATUSES,
} from '../services/payroll/salaryStructureRules.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((e) => ({ field: e.path, message: e.msg }));
  throw err;
};

export const salaryStructureListValidator = [
  query('search').optional().isString().trim().isLength({ max: 80 }).withMessage('Search is too long'),
  query('status')
    .optional()
    .isIn([...STRUCTURE_STATUSES, 'ALL'])
    .withMessage('Invalid status filter'),
  query('departmentId').optional().isMongoId().withMessage('Invalid department filter'),
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive number'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  validate,
];

const itemRules = [
  body('items').isArray({ min: 1 }).withMessage('Add at least one salary component'),
  body('items.*.componentCode')
    .isString()
    .trim()
    .isLength({ min: 1, max: 30 })
    .withMessage('Every line needs a component'),
  body('items.*.calculationMethod')
    .isIn(CALCULATION_METHODS)
    .withMessage('Unsupported calculation method'),
  body('items.*.value').optional({ nullable: true }).isFloat({ min: 0, max: 100000000 }),
  body('items.*.order').optional().isInt({ min: 0, max: 999 }),
];

export const salaryStructureIdValidator = [
  param('structureId').isMongoId().withMessage('Invalid salary structure id'),
  validate,
];

export const salaryStructureCreateValidator = [
  body().isObject().withMessage('Request body must be an object'),
  body('name')
    .isString()
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage('Structure name must be between 2 and 80 characters'),
  body('code')
    .isString()
    .trim()
    .isLength({ min: 2, max: 30 })
    .matches(/^[A-Za-z0-9_-]+$/)
    .withMessage('Structure code can only contain letters, numbers, hyphens and underscores'),
  body('description').optional().isString().trim().isLength({ max: 500 }),
  body('departmentId').optional({ nullable: true }).isMongoId().withMessage('Invalid department'),
  body('designation').optional().isString().trim().isLength({ max: 80 }),
  body('effectiveFrom').optional({ nullable: true }).isISO8601().withMessage('Effective date is not a valid date'),
  body('status').optional().isIn(STRUCTURE_STATUSES).withMessage('Invalid status'),
  body('sampleGross').optional({ nullable: true }).isFloat({ min: 0 }),
  ...itemRules,
  validate,
];

export const salaryStructureUpdateValidator = [
  param('structureId').isMongoId().withMessage('Invalid salary structure id'),
  body().isObject().withMessage('Request body must be an object'),
  body('name').optional().isString().trim().isLength({ min: 2, max: 80 }),
  body('code').optional().isString().trim().isLength({ min: 2, max: 30 }),
  body('description').optional().isString().trim().isLength({ max: 500 }),
  body('departmentId').optional({ nullable: true }).isMongoId(),
  body('designation').optional().isString().trim().isLength({ max: 80 }),
  body('effectiveFrom').optional({ nullable: true }).isISO8601(),
  body('status').optional().isIn(STRUCTURE_STATUSES),
  body('sampleGross').optional({ nullable: true }).isFloat({ min: 0 }),
  body('items').optional().isArray(),
  body('items.*.componentCode').optional().isString().trim().isLength({ min: 1, max: 30 }),
  body('items.*.calculationMethod').optional().isIn(CALCULATION_METHODS),
  body('items.*.value').optional({ nullable: true }).isFloat({ min: 0, max: 100000000 }),
  body('items.*.order').optional().isInt({ min: 0, max: 999 }),
  validate,
];

export const salaryStructureStatusValidator = [
  param('structureId').isMongoId().withMessage('Invalid salary structure id'),
  body('status').isIn(STRUCTURE_STATUSES).withMessage('Invalid status'),
  validate,
];

export const salaryStructureCloneValidator = [
  param('structureId').isMongoId().withMessage('Invalid salary structure id'),
  body('name').optional().isString().trim().isLength({ min: 2, max: 80 }),
  body('code')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 2, max: 30 })
    .matches(/^[A-Za-z0-9_-]+$/)
    .withMessage('Structure code can only contain letters, numbers, hyphens and underscores'),
  body('effectiveFrom').optional({ nullable: true }).isISO8601(),
  validate,
];

export const salaryStructurePreviewValidator = [
  body('items').isArray().withMessage('items must be an array'),
  body('gross').optional({ nullable: true }).isFloat({ min: 0 }).withMessage('Gross must be a positive number'),
  validate,
];
