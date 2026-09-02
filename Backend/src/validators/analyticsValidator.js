// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.12 — PAYROLL ANALYTICS VALIDATORS (§24)
//
//  Server-side only. Everything the client sends is untrusted:
//
//    · companyId is NEVER accepted — it comes from req.companyId.
//    · report keys, periods, frequencies and formats are checked against the
//      catalogue in analyticsRules.js, never against a free-text field.
//    · no figure is ever accepted from the browser: every number is re-read
//      from the 29.6 snapshot by the service.
//
//  Every chain below ends in `validate`, which CALLS validationResult. An
//  express-validator chain only collects errors until something reads them —
//  the 29.11 audit found four payroll validator files (29.8–29.11) that
//  shipped without this half, so malformed input reached the services
//  unchecked. This file has it from the start, and a test asserts it.
// ═══════════════════════════════════════════════════════════════════════════
import { body, param, query, validationResult } from 'express-validator';

import mongoose from 'mongoose';

import ApiError from '../utils/ApiError.js';

import {
  REPORT_KEYS,
  SCHEDULE_FREQUENCIES,
  TREND_PERIODS,
} from '../services/payroll/analyticsRules.js';

const isObjectId = (value) => mongoose.isValidObjectId(String(value || ''));

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const error = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  error.errors = errors.array().map((entry) => ({ field: entry.path, message: entry.msg }));
  throw error;
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const FY = /^\d{4}-\d{2}$/;

const monthRule = (field) =>
  field.optional({ nullable: true }).matches(MONTH).withMessage('month must look like 2026-08');

const objectIdRule = (field, label) => field.custom(isObjectId).withMessage(`${label} is invalid`);

const optionalObjectIdRule = (field, label) =>
  field.optional({ nullable: true, checkFalsy: true }).custom(isObjectId).withMessage(`${label} is invalid`);

// ── shared query rules (§18 — the filters every report supports) ────────────

const reportQueryRules = [
  monthRule(query('month')),
  query('period')
    .optional({ nullable: true })
    .isIn(TREND_PERIODS)
    .withMessage(`period must be one of ${TREND_PERIODS.join(', ')}`),
  query('financialYear')
    .optional({ nullable: true, checkFalsy: true })
    .matches(FY)
    .withMessage('financialYear must look like 2026-27'),
  optionalObjectIdRule(query('departmentId'), 'departmentId'),
  query('designation').optional({ nullable: true }).isString().trim().isLength({ max: 80 }),
  optionalObjectIdRule(query('employeeId'), 'employeeId'),
  query('status')
    .optional({ nullable: true, checkFalsy: true })
    .isIn(['PAID', 'PENDING', 'FAILED', 'NOT_IN_BATCH'])
    .withMessage('status must be PAID, PENDING, FAILED or NOT_IN_BATCH'),
];

// ── routes ─────────────────────────────────────────────────────────────────

export const analyticsDashboardValidator = [monthRule(query('month')), validate];

export const analyticsReportKeyValidator = [
  param('reportKey')
    .isString()
    .trim()
    .toUpperCase()
    // The catalogue, not a free-text field: an unknown key is a 400, not a
    // 500 from a switch that fell through.
    .isIn(REPORT_KEYS)
    .withMessage(`reportKey must be one of ${REPORT_KEYS.join(', ')}`),
  validate,
];

export const analyticsReportQueryValidator = [
  ...analyticsReportKeyValidator.slice(0, -1),
  ...reportQueryRules,
  validate,
];

export const analyticsExportQueryValidator = [
  ...analyticsReportKeyValidator.slice(0, -1),
  query('format').optional({ nullable: true }).isIn(['CSV', 'XLSX', 'PDF']).withMessage('format must be CSV, XLSX or PDF'),
  ...reportQueryRules,
  validate,
];

export const analyticsExportBodyValidator = [
  ...analyticsReportKeyValidator.slice(0, -1),
  // A validator must REJECT what it does not understand, never coerce it —
  // the rule that fixed 29.11 silently turning PDF into CSV.
  body('format').optional({ nullable: true }).isIn(['CSV', 'XLSX', 'PDF']).withMessage('format must be CSV, XLSX or PDF'),
  monthRule(body('month')),
  body('period').optional({ nullable: true }).isIn(TREND_PERIODS).withMessage(`period must be one of ${TREND_PERIODS.join(', ')}`),
  body('financialYear').optional({ nullable: true, checkFalsy: true }).matches(FY).withMessage('financialYear must look like 2026-27'),
  optionalObjectIdRule(body('departmentId'), 'departmentId'),
  body('designation').optional({ nullable: true }).isString().trim().isLength({ max: 80 }),
  optionalObjectIdRule(body('employeeId'), 'employeeId'),
  body('status')
    .optional({ nullable: true, checkFalsy: true })
    .isIn(['PAID', 'PENDING', 'FAILED', 'NOT_IN_BATCH'])
    .withMessage('status must be PAID, PENDING, FAILED or NOT_IN_BATCH'),
  validate,
];

export const analyticsFilesQueryValidator = [
  query('reportKey').optional({ nullable: true, checkFalsy: true }).isIn(REPORT_KEYS).withMessage('reportKey is invalid'),
  validate,
];

export const analyticsFileIdParamValidator = [objectIdRule(param('fileId'), 'fileId'), validate];

export const analyticsScheduleIdParamValidator = [objectIdRule(param('scheduleId'), 'scheduleId'), validate];

export const createScheduleValidator = [
  body('name').isString().trim().isLength({ min: 2, max: 120 }).withMessage('Give the schedule a name (2-120 characters)'),
  body('reportKey').isString().trim().toUpperCase().isIn(REPORT_KEYS).withMessage(`reportKey must be one of ${REPORT_KEYS.join(', ')}`),
  body('format').optional({ nullable: true }).isIn(['CSV', 'XLSX', 'PDF']).withMessage('format must be CSV, XLSX or PDF'),
  body('frequency').optional({ nullable: true }).isIn(SCHEDULE_FREQUENCIES).withMessage(`frequency must be one of ${SCHEDULE_FREQUENCIES.join(', ')}`),
  body('dayOfMonth').optional({ nullable: true }).isInt({ min: 1, max: 31 }).withMessage('dayOfMonth must be between 1 and 31'),
  optionalObjectIdRule(body('departmentId'), 'departmentId'),
  body('designation').optional({ nullable: true }).isString().trim().isLength({ max: 80 }),
  // §22 — who is told when the report lands. A permission, never a list of
  // people: the audience has to stay correct as the company changes.
  body('notifyPermission').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ max: 80 }),
  validate,
];

export const updateScheduleValidator = [
  objectIdRule(param('scheduleId'), 'scheduleId'),
  body('name').optional({ nullable: true }).isString().trim().isLength({ min: 2, max: 120 }).withMessage('name must be 2-120 characters'),
  body('format').optional({ nullable: true }).isIn(['CSV', 'XLSX', 'PDF']).withMessage('format must be CSV, XLSX or PDF'),
  body('frequency').optional({ nullable: true }).isIn(SCHEDULE_FREQUENCIES).withMessage(`frequency must be one of ${SCHEDULE_FREQUENCIES.join(', ')}`),
  body('dayOfMonth').optional({ nullable: true }).isInt({ min: 1, max: 31 }).withMessage('dayOfMonth must be between 1 and 31'),
  body('active').optional({ nullable: true }).isBoolean().withMessage('active must be true or false'),
  body('notifyPermission').optional({ nullable: true, checkFalsy: true }).isString().trim().isLength({ max: 80 }),
  validate,
];

export const refreshDashboardValidator = [monthRule(body('month')), validate];

export default {
  analyticsDashboardValidator,
  analyticsReportKeyValidator,
  analyticsReportQueryValidator,
  analyticsExportQueryValidator,
  analyticsExportBodyValidator,
  analyticsFilesQueryValidator,
  analyticsFileIdParamValidator,
  analyticsScheduleIdParamValidator,
  createScheduleValidator,
  updateScheduleValidator,
  refreshDashboardValidator,
};
