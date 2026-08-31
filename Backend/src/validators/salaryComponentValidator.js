// ─────────────────────────────────────────────────────────────
// Phase 29.2 — Salary Component validators
//
// STRUCTURAL checks only (shape, enums, sizes). Business rules
// (percentage ranges, dependency sanity, duplicate codes across the
// tenant, circular dependencies) live once in
// services/payroll/salaryComponentRules.js and run in the service, so
// the same rules protect every future caller (jobs, scripts, 29.3).
// ─────────────────────────────────────────────────────────────
import { body, param, query, validationResult } from 'express-validator';

import ApiError from '../utils/ApiError.js';
import {
  CALCULATION_TYPES,
  COMPONENT_CATEGORIES,
  COMPONENT_STATUS,
  TAXABILITY_TYPES,
} from '../services/payroll/salaryComponentRules.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((e) => ({ field: e.path, message: e.msg }));
  throw err;
};

export const salaryComponentListValidator = [
  query('search').optional().isString().trim().isLength({ max: 80 }).withMessage('Search is too long'),
  query('category')
    .optional()
    .isIn([...COMPONENT_CATEGORIES, 'ALL'])
    .withMessage('Invalid component type filter'),
  query('status')
    .optional()
    .isIn([...COMPONENT_STATUS, 'ALL'])
    .withMessage('Invalid status filter'),
  query('calculationType')
    .optional()
    .isIn([...CALCULATION_TYPES, 'ALL'])
    .withMessage('Invalid calculation filter'),
  query('taxability')
    .optional()
    .isIn([...TAXABILITY_TYPES, 'ALL'])
    .withMessage('Invalid taxability filter'),
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive number'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  validate,
];

export const salaryComponentIdValidator = [
  param('componentId').isMongoId().withMessage('Invalid salary component id'),
  validate,
];

export const salaryComponentCreateValidator = [
  body().isObject().withMessage('Request body must be an object'),
  body('name')
    .isString()
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage('Component name must be between 2 and 80 characters'),
  body('code')
    .isString()
    .trim()
    .isLength({ min: 2, max: 30 })
    .matches(/^[A-Za-z0-9_-]+$/)
    .withMessage('Component code can only contain letters, numbers, hyphens and underscores'),
  body('description').optional().isString().trim().isLength({ max: 500 }),
  body('category')
    .isIn(COMPONENT_CATEGORIES)
    .withMessage('Component type must be Earning, Deduction or Employer Contribution'),
  body('calculationType')
    .isIn(CALCULATION_TYPES)
    .withMessage('Calculation type must be Fixed Amount, Percentage or Formula'),
  body('defaultAmount').optional({ nullable: true }).isFloat({ min: 0 }),
  body('percentage').optional({ nullable: true }).isFloat({ min: 0.01, max: 1000 }),
  body('calculationBase').optional({ nullable: true }).isString().trim(),
  body('dependsOnCode').optional({ nullable: true }).isString().trim(),
  body('taxability').optional().isIn(TAXABILITY_TYPES).withMessage('Invalid tax treatment'),
  body('pfApplicable').optional().isBoolean(),
  body('esiApplicable').optional().isBoolean(),
  body('tdsApplicable').optional().isBoolean(),
  body('professionalTaxApplicable').optional().isBoolean(),
  body('status').optional().isIn(COMPONENT_STATUS),
  body('effectiveFrom').optional({ nullable: true }).isISO8601().withMessage('Effective date is not a valid date'),
  validate,
];

export const salaryComponentUpdateValidator = [
  param('componentId').isMongoId().withMessage('Invalid salary component id'),
  body().isObject().withMessage('Request body must be an object'),
  body('name').optional().isString().trim().isLength({ min: 2, max: 80 }),
  body('code').optional().isString().trim().isLength({ min: 2, max: 30 }),
  body('description').optional().isString().trim().isLength({ max: 500 }),
  body('category').optional().isIn(COMPONENT_CATEGORIES),
  body('calculationType').optional().isIn(CALCULATION_TYPES),
  body('defaultAmount').optional({ nullable: true }).isFloat({ min: 0 }),
  body('percentage').optional({ nullable: true }).isFloat({ min: 0.01, max: 1000 }),
  body('taxability').optional().isIn(TAXABILITY_TYPES),
  body('pfApplicable').optional().isBoolean(),
  body('esiApplicable').optional().isBoolean(),
  body('tdsApplicable').optional().isBoolean(),
  body('professionalTaxApplicable').optional().isBoolean(),
  body('status').optional().isIn(COMPONENT_STATUS),
  body('effectiveFrom').optional({ nullable: true }).isISO8601(),
  validate,
];

export const salaryComponentStatusValidator = [
  param('componentId').isMongoId().withMessage('Invalid salary component id'),
  body('status').isIn(COMPONENT_STATUS).withMessage('Status must be Active or Inactive'),
  validate,
];

export const salaryComponentDuplicateValidator = [
  param('componentId').isMongoId().withMessage('Invalid salary component id'),
  body('name').optional().isString().trim().isLength({ min: 2, max: 80 }),
  body('code')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 2, max: 30 })
    .matches(/^[A-Za-z0-9_-]+$/)
    .withMessage('Component code can only contain letters, numbers, hyphens and underscores'),
  validate,
];
