// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.9 — PAYSLIP VALIDATORS
//
//  Server-side validation only (§26). Everything the client sends is treated
//  as untrusted: ids are ObjectId-checked, months are pattern-checked, and no
//  salary figure, employee name or PDF byte is ever accepted from a request.
// ═══════════════════════════════════════════════════════════════════════════
import { body, param, query, validationResult } from 'express-validator';

import mongoose from 'mongoose';

import ApiError from '../utils/ApiError.js';

const isObjectId = (value) => mongoose.isValidObjectId(String(value || ''));

const monthRule = (field) =>
  field
    .optional()
    .matches(/^\d{4}-(0[1-9]|1[0-2])$/)
    .withMessage('month must look like 2026-08');

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

export const payslipListQueryValidator = [
  query('month').optional().matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('month must look like 2026-08'),
  query('year').optional().matches(/^\d{4}$/).withMessage('year must look like 2026'),
  // §15 — FY 2026-27
  query('financialYear').optional().matches(/^\d{4}-\d{2}$/).withMessage('financialYear must look like 2026-27'),
  query('search').optional().isString().trim().isLength({ max: 80 }),
  validate,
];

export const payslipMonthBodyValidator = [
  body('month').matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('month must look like 2026-08'),
  validate,
];

export const generatePayslipsValidator = [
  body('month').matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('month must look like 2026-08'),
  validate,
];

export const emailMonthValidator = [
  body('month').matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('month must look like 2026-08'),
  body('employeeIds').optional().isArray({ max: 2000 }),
  body('employeeIds.*').optional().custom(isObjectId).withMessage('employeeIds contains an invalid id'),
  validate,
];

// §18 — a department ZIP is resolved server-side from this id.
export const bulkDownloadValidator = [
  body('month').matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('month must look like 2026-08'),
  body('scope').optional().isIn(['COMPANY', 'DEPARTMENT']).withMessage('scope must be COMPANY or DEPARTMENT'),
  body('departmentId').optional({ nullable: true }).custom((value) => value === null || isObjectId(value)).withMessage('departmentId is invalid'),
  validate,
];

// ── path params ────────────────────────────────────────────────────────────

export const payslipIdParamValidator = [objectIdRule(param('payslipId'), 'payslipId'), validate];

export const bulkFileIdParamValidator = [objectIdRule(param('fileId'), 'fileId'), validate];
