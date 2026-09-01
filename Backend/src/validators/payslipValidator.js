// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.9 — PAYSLIP VALIDATORS
//
//  Server-side validation only (§26). Everything the client sends is treated
//  as untrusted: ids are ObjectId-checked, months are pattern-checked, and no
//  salary figure, employee name or PDF byte is ever accepted from a request.
// ═══════════════════════════════════════════════════════════════════════════
import { body, param, query } from 'express-validator';

import mongoose from 'mongoose';

const isObjectId = (value) => mongoose.isValidObjectId(String(value || ''));

const monthRule = (field) =>
  field
    .optional()
    .matches(/^\d{4}-(0[1-9]|1[0-2])$/)
    .withMessage('month must look like 2026-08');

const objectIdRule = (field, label) =>
  field.custom(isObjectId).withMessage(`${label} is invalid`);

// ── query params ───────────────────────────────────────────────────────────

export const payslipListQueryValidator = [
  query('month').optional().matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('month must look like 2026-08'),
  query('year').optional().matches(/^\d{4}$/).withMessage('year must look like 2026'),
  // §15 — FY 2026-27
  query('financialYear').optional().matches(/^\d{4}-\d{2}$/).withMessage('financialYear must look like 2026-27'),
  query('search').optional().isString().trim().isLength({ max: 80 }),
];

export const payslipMonthBodyValidator = [body('month').matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('month must look like 2026-08')];

export const generatePayslipsValidator = [
  body('month').matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('month must look like 2026-08'),
];

export const emailMonthValidator = [
  body('month').matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('month must look like 2026-08'),
  body('employeeIds').optional().isArray({ max: 2000 }),
  body('employeeIds.*').optional().custom(isObjectId).withMessage('employeeIds contains an invalid id'),
];

// §18 — a department ZIP is resolved server-side from this id.
export const bulkDownloadValidator = [
  body('month').matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('month must look like 2026-08'),
  body('scope').optional().isIn(['COMPANY', 'DEPARTMENT']).withMessage('scope must be COMPANY or DEPARTMENT'),
  body('departmentId').optional({ nullable: true }).custom((value) => value === null || isObjectId(value)).withMessage('departmentId is invalid'),
];

// ── path params ────────────────────────────────────────────────────────────

export const payslipIdParamValidator = [objectIdRule(param('payslipId'), 'payslipId')];

export const bulkFileIdParamValidator = [objectIdRule(param('fileId'), 'fileId')];
