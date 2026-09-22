// ─────────────────────────────────────────────────────────────
// Phase 31.15 — attendance analytics validators.
//
// STRUCTURAL checks only (dates, enums, ids, pagination). Scope,
// source selection and aggregation live in the service + pure
// rules. Tenant authority is req.companyId — a companyId query
// param is refused outright.
// ─────────────────────────────────────────────────────────────
import { query, validationResult } from 'express-validator';

import ApiError from '../../utils/ApiError.js';
import { WORK_MODE } from '../../services/attendance/attendancePolicyRules.js';
import {
  ANALYTICS_PRESETS,
  EMPLOYEE_SORT_FIELDS,
} from '../../services/attendance/attendanceAnalyticsRules.js';
import { ANALYTICS_EXPORT_FORMATS, ANALYTICS_EXPORT_REPORTS } from '../../services/attendance/attendanceAnalyticsService.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((entry) => ({ field: entry.path, message: entry.msg }));
  throw err;
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const noTenantOverride = query().custom((value, { req }) => {
  if (req.query?.companyId !== undefined || req.query?.company !== undefined) {
    throw new Error('companyId must not be supplied by the client');
  }
  return true;
});

const objectIdOrEmpty = (field, label) =>
  query(field)
    .optional({ nullable: true, checkFalsy: true })
    .isMongoId()
    .withMessage(`${label} must be an ObjectId string`);

const rangeRules = [
  query('month')
    .optional({ nullable: true, checkFalsy: true })
    .matches(MONTH)
    .withMessage('month must look like 2026-09'),
  query('from')
    .optional({ nullable: true, checkFalsy: true })
    .matches(DAY)
    .withMessage('from must look like 2026-09-01'),
  query('to')
    .optional({ nullable: true, checkFalsy: true })
    .matches(DAY)
    .withMessage('to must look like 2026-09-30'),
  query('preset')
    .optional({ nullable: true, checkFalsy: true })
    .isIn([...ANALYTICS_PRESETS])
    .withMessage(`preset must be one of ${[...ANALYTICS_PRESETS].join(', ')}`),
];

const filterRules = [
  objectIdOrEmpty('departmentId', 'departmentId'),
  objectIdOrEmpty('shiftId', 'shiftId'),
  objectIdOrEmpty('locationId', 'locationId'),
  objectIdOrEmpty('employeeId', 'employeeId'),
  query('workMode')
    .optional({ nullable: true, checkFalsy: true })
    .isIn(Object.values(WORK_MODE))
    .withMessage('workMode is invalid'),
];

const pageRules = [
  query('page')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1, max: 1000 })
    .withMessage('page must be 1..1000'),
  query('pageSize')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1, max: 100 })
    .withMessage('pageSize must be 1..100'),
];

const sortRule = query('sort')
  .optional({ nullable: true, checkFalsy: true })
  .custom((value) => {
    const field = String(value).startsWith('-') ? String(value).slice(1) : String(value);
    if (!EMPLOYEE_SORT_FIELDS.includes(field)) {
      throw new Error(`sort must be one of ${EMPLOYEE_SORT_FIELDS.join(', ')}`);
    }
    return true;
  });

export const analyticsOverviewValidator = [noTenantOverride, ...rangeRules, ...filterRules, validate];

export const analyticsTrendsValidator = [noTenantOverride, ...rangeRules, ...filterRules, validate];

export const analyticsEmployeesValidator = [
  noTenantOverride,
  ...rangeRules,
  ...filterRules,
  ...pageRules,
  sortRule,
  validate,
];

export const analyticsMineValidator = [noTenantOverride, ...rangeRules, validate];

export const analyticsReconValidator = [
  noTenantOverride,
  query('month').matches(MONTH).withMessage('month must look like 2026-09'),
  validate,
];

export const analyticsExportValidator = [
  noTenantOverride,
  ...rangeRules,
  ...filterRules,
  query('reportType')
    .isIn([...ANALYTICS_EXPORT_REPORTS])
    .withMessage(`reportType must be one of ${[...ANALYTICS_EXPORT_REPORTS].join(', ')}`),
  query('format')
    .optional({ nullable: true, checkFalsy: true })
    .isIn([...ANALYTICS_EXPORT_FORMATS])
    .withMessage(`format must be one of ${[...ANALYTICS_EXPORT_FORMATS].join(', ')}`),
  validate,
];
