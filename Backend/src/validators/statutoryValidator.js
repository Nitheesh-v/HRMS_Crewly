// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.10 — STATUTORY VALIDATORS
//
//  Server-side validation only (§24). Everything the client sends is treated
//  as untrusted: months and financial years are pattern-checked, report types
//  and filing statuses come from the rules module rather than from a free-text
//  field, and no salary figure or employee identifier is ever accepted into a
//  statutory calculation — every number is re-read from the 29.6 snapshot.
// ═══════════════════════════════════════════════════════════════════════════
import { body, param, query, validationResult } from 'express-validator';

import mongoose from 'mongoose';

import ApiError from '../utils/ApiError.js';

import {
  ANNUAL_REPORT_KEYS,
  EXPORT_FORMATS,
  FILING_STATUSES,
  REPORT_KEYS,
  STATUTORY_TYPES,
  isStatutoryType,
} from '../services/payroll/statutoryRules.js';

const isObjectId = (value) => mongoose.isValidObjectId(String(value || ''));

const monthRule = (field) =>
  field
    .optional()
    .matches(/^\d{4}-(0[1-9]|1[0-2])$/)
    .withMessage('month must look like 2026-08');

const fyRule = (field) =>
  field
    .optional()
    .matches(/^\d{4}-\d{2}$/)
    .withMessage('financialYear must look like 2026-27');

const objectIdRule = (field, label) =>
  field.custom(isObjectId).withMessage(`${label} is invalid`);

// ── query params ───────────────────────────────────────────────────────────

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

export const statutoryMonthQueryValidator = [monthRule(query('month')), validate];

export const statutoryReportQueryValidator = [
  ...statutoryMonthQueryValidator,
  query('type')
    .custom((value) => isStatutoryType(value))
    .withMessage(`type must be one of ${STATUTORY_TYPES.join(', ')}`),
  validate,
];

export const statutoryExportQueryValidator = [
  monthRule(query('month')),
  fyRule(query('financialYear')),
  query('reportKey')
    .custom((value) => REPORT_KEYS.includes(String(value || '').toUpperCase()))
    .withMessage('reportKey is not a known statutory report'),
  query('format')
    .optional()
    .isIn(EXPORT_FORMATS)
    .withMessage('format must be CSV, XLSX or PDF'),
  validate,
];

export const statutoryHistoryQueryValidator = [fyRule(query('financialYear')), validate];

// §19 — a bounded window of months so a calendar request can never ask the
// service to walk a decade of payroll.
export const statutoryCalendarQueryValidator = [
  query('months').optional().isString().trim().isLength({ max: 200 }),
  validate,
];

// ── bodies ─────────────────────────────────────────────────────────────────

export const generateStatutoryValidator = [
  body('month').matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('month must look like 2026-08'),
  validate,
];

export const filingStatusValidator = [
  body('status')
    .custom((value) => FILING_STATUSES.includes(String(value || '').toUpperCase()))
    .withMessage(`status must be one of ${FILING_STATUSES.join(', ')}`),
  body('filingReference').optional().isString().trim().isLength({ max: 60 }),
  body('filingRemarks').optional().isString().trim().isLength({ max: 500 }),
  validate,
];

export const calendarTaskValidator = [
  body('month').matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('month must look like 2026-08'),
  body('type')
    .custom((value) => isStatutoryType(value))
    .withMessage(`type must be one of ${STATUTORY_TYPES.join(', ')}`),
  body('done').optional().isBoolean().withMessage('done must be true or false'),
  body('note').optional().isString().trim().isLength({ max: 300 }),
  validate,
];

export const reminderValidator = [monthRule(body('month')), validate];

export const annualExportValidator = [
  body('financialYear').matches(/^\d{4}-\d{2}$/).withMessage('financialYear must look like 2026-27'),
  body('reportKey')
    .custom((value) => ANNUAL_REPORT_KEYS.includes(String(value || '').toUpperCase()))
    .withMessage('reportKey must be an annual statutory report'),
  body('format')
    .optional()
    .isIn(EXPORT_FORMATS)
    .withMessage('format must be CSV, XLSX or PDF'),
  validate,
];

// ── path params ────────────────────────────────────────────────────────────

export const statutoryTypeParamValidator = [
  param('type')
    .custom((value) => isStatutoryType(value))
    .withMessage(`type must be one of ${STATUTORY_TYPES.join(', ')}`),
  validate,
];

export const exportIdParamValidator = [objectIdRule(param('exportId'), 'exportId'), validate];

export const employeeIdParamValidator = [objectIdRule(param('employeeId'), 'employeeId'), validate];
