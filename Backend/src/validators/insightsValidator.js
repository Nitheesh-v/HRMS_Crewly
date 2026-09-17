// ─────────────────────────────────────────────────────────────
// Insights validators — Analytics Hub + Report Builder.
//
// STRUCTURAL checks only (presets, dates, enums, pagination).
// Tenant authority is req.companyId — companyId/company params are
// refused outright. Scope lives in the controllers.
// ─────────────────────────────────────────────────────────────
import { body, query, validationResult } from 'express-validator';

import ApiError from '../utils/ApiError.js';
import { REPORT_PRESETS } from '../utils/reportingCore.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((entry) => ({ field: entry.path, message: entry.msg }));
  throw err;
};

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const noTenantOverride = query().custom((value, { req }) => {
  if (req.query?.companyId !== undefined || req.query?.company !== undefined) {
    throw new Error('companyId must not be supplied by the client');
  }
  return true;
});

// ?preset=this_month (Analytics Hub tabs). `custom` needs from/to days.
export const analyticsPresetValidator = [
  noTenantOverride,
  query('preset')
    .optional()
    .isIn(REPORT_PRESETS)
    .withMessage(`preset must be one of: ${REPORT_PRESETS.join(', ')}`),
  query('from')
    .optional()
    .matches(DAY)
    .withMessage('from must be a YYYY-MM-DD day'),
  query('to')
    .optional()
    .matches(DAY)
    .withMessage('to must be a YYYY-MM-DD day'),
  validate,
];

export const REPORT_BUILDER_MODULES = [
  'employees',
  'attendance',
  'leaves',
  'tasks',
  'expenses',
  'payroll',
];

// POST /report-builder/run + /report-builder/export bodies.
export const reportRunValidator = [
  body('module')
    .isIn(REPORT_BUILDER_MODULES)
    .withMessage(`module must be one of: ${REPORT_BUILDER_MODULES.join(', ')}`),
  body('fields')
    .optional()
    .isArray({ max: 12 })
    .withMessage('fields must be an array of at most 12 entries'),
  body('fields.*')
    .optional()
    .isString()
    .isLength({ min: 1, max: 40 })
    .withMessage('each field must be a 1–40 character key'),
  body('preset')
    .optional()
    .isIn(REPORT_PRESETS)
    .withMessage(`preset must be one of: ${REPORT_PRESETS.join(', ')}`),
  body('from')
    .optional()
    .matches(DAY)
    .withMessage('from must be a YYYY-MM-DD day'),
  body('to').optional().matches(DAY).withMessage('to must be a YYYY-MM-DD day'),
  body('filters.status')
    .optional()
    .isString()
    .isLength({ min: 1, max: 40 })
    .withMessage('filters.status must be a 1–40 character value'),
  body('filters.type')
    .optional()
    .isString()
    .isLength({ min: 1, max: 40 })
    .withMessage('filters.type must be a 1–40 character value'),
  body('filters.role')
    .optional()
    .isString()
    .isLength({ min: 1, max: 40 })
    .withMessage('filters.role must be a 1–40 character value'),
  body('filters.category')
    .optional()
    .isString()
    .isLength({ min: 1, max: 40 })
    .withMessage('filters.category must be a 1–40 character value'),
  body('page')
    .optional()
    .isInt({ min: 1, max: 100000 })
    .withMessage('page must be a positive integer'),
  body('pageSize')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('pageSize must be between 1 and 100'),
  validate,
];

export const reportExportValidator = [
  query('format')
    .optional()
    .isIn(['csv', 'xls'])
    .withMessage('format must be csv or xls'),
  ...reportRunValidator,
];
