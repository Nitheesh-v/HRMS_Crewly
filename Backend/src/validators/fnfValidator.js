// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.11 — FINAL SETTLEMENT VALIDATORS
//
//  Server-side validation only (§24). Everything the client sends is treated
//  as untrusted:
//
//    · companyId is NEVER accepted — it comes from req.companyId.
//    · employeeId is accepted only as a reference to look up (and the lookup
//      is company-scoped), never as authority.
//    · Amounts are validated for shape here; whether a recovery is ALLOWED is
//      decided by fnfRules, not by the validator.
// ═══════════════════════════════════════════════════════════════════════════
import { body, param, query } from 'express-validator';

import mongoose from 'mongoose';

import {
  CHECKLIST_ITEMS,
  EXPORT_FORMATS,
  NOTICE_DECISIONS,
  PAYABLE_TYPES,
  RECOVERY_TYPES,
  SETTLEMENT_STATUSES,
} from '../services/payroll/fnfRules.js';

const isObjectId = (value) => mongoose.isValidObjectId(String(value || ''));

const monthRule = (field) =>
  field
    .optional()
    .matches(/^\d{4}-(0[1-9]|1[0-2])$/)
    .withMessage('month must look like 2026-08');

const dateRule = (field) =>
  field
    .optional()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('date must look like 2026-08-31');

const objectIdRule = (field, label) =>
  field.custom(isObjectId).withMessage(`${label} is invalid`);

// ── query params ───────────────────────────────────────────────────────────

export const fnfMonthQueryValidator = [monthRule(query('month'))];

export const fnfListQueryValidator = [
  monthRule(query('month')),
  query('status')
    .optional()
    .isIn(SETTLEMENT_STATUSES)
    .withMessage(`status must be one of ${SETTLEMENT_STATUSES.join(', ')}`),
  query('search').optional().isString().trim().isLength({ max: 80 }),
  query('departmentId').optional().custom(isObjectId).withMessage('departmentId is invalid'),
];

export const fnfExportQueryValidator = [
  monthRule(query('month')),
  query('format')
    .optional()
    .isIn(EXPORT_FORMATS)
    .withMessage('format must be CSV or XLSX'),
];

// ── bodies ─────────────────────────────────────────────────────────────────

export const createSettlementValidator = [
  body('employeeId').custom(isObjectId).withMessage('employeeId is invalid'),
  body('resignationId').optional({ nullable: true }).custom(
    (value) => value === null || value === '' || isObjectId(value),
  ).withMessage('resignationId is invalid'),
  monthRule(body('month')),
  dateRule(body('lastWorkingDate')),
  body('noticePeriodDays').optional().isInt({ min: 0, max: 365 }).withMessage('noticePeriodDays must be 0-365'),
  body('noticeDecision')
    .optional()
    .isIn(NOTICE_DECISIONS)
    .withMessage(`noticeDecision must be one of ${NOTICE_DECISIONS.join(', ')}`),
];

export const updateItemsValidator = [
  body('payables')
    .optional()
    .isArray({ max: 40 })
    .withMessage('payables must be an array'),
  body('payables.*.type')
    .optional()
    .isIn(PAYABLE_TYPES)
    .withMessage(`payable type must be one of ${PAYABLE_TYPES.join(', ')}`),
  body('payables.*.amount')
    .optional()
    .isFloat({ gt: 0 })
    .withMessage('payable amount must be greater than zero'),
  body('payables.*.label').optional().isString().trim().isLength({ max: 120 }),
  body('payables.*.note').optional().isString().trim().isLength({ max: 300 }),

  body('recoveries')
    .optional()
    .isArray({ max: 40 })
    .withMessage('recoveries must be an array'),
  body('recoveries.*.type')
    .optional()
    .isIn(RECOVERY_TYPES)
    .withMessage(`recovery type must be one of ${RECOVERY_TYPES.join(', ')}`),
  body('recoveries.*.amount')
    .optional()
    .isFloat({ gt: 0 })
    .withMessage('recovery amount must be greater than zero'),
  // §9 — a recovery is not a number on its own; it needs a reason.
  body('recoveries.*.reason').optional().isString().trim().isLength({ min: 3, max: 300 })
    .withMessage('each recovery needs a reason'),
  body('recoveries.*.label').optional().isString().trim().isLength({ max: 120 }),
];

export const noticeDecisionValidator = [
  body('decision')
    .isIn(NOTICE_DECISIONS)
    .withMessage(`decision must be one of ${NOTICE_DECISIONS.join(', ')}`),
  body('noticePeriodDays').optional().isInt({ min: 0, max: 365 }).withMessage('noticePeriodDays must be 0-365'),
];

export const hrReviewValidator = [
  body('complete').optional().isBoolean().withMessage('complete must be true or false'),
  body('remarks').optional().isString().trim().isLength({ max: 500 }),
  ...CHECKLIST_ITEMS.map((key) =>
    body(`checklist.${key}`).optional().isBoolean().withMessage(`${key} must be true or false`),
  ),
];

export const financeDecisionValidator = [
  body('action').isIn(['APPROVE', 'REJECT']).withMessage('action must be APPROVE or REJECT'),
  body('remarks').optional().isString().trim().isLength({ max: 500 }),
];

export const markPaidValidator = [
  dateRule(body('paidAt')),
  body('reference').optional().isString().trim().isLength({ max: 60 }),
  body('method').optional().isString().trim().isLength({ max: 40 }),
];

export const reopenValidator = [
  body('remarks')
    .isString()
    .trim()
    .isLength({ min: 3, max: 500 })
    .withMessage('a reopened settlement needs a reason'),
];

// ── path params ────────────────────────────────────────────────────────────

export const settlementIdParamValidator = [objectIdRule(param('settlementId'), 'settlementId')];
export const settlementFileIdParamValidator = [objectIdRule(param('fileId'), 'fileId')];
