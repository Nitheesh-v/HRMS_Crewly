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
import { body, param, query, validationResult } from 'express-validator';

import mongoose from 'mongoose';

import ApiError from '../utils/ApiError.js';

import {
  CHECKLIST_ITEMS,
  EXPORT_FORMATS,
  NOTICE_DECISIONS,
  PAYABLE_TYPES,
  RECOVERY_TYPES,
  SETTLEMENT_STATUSES,
} from '../services/payroll/fnfRules.js';

/**
 * §24 — the half every validator file needs and this one was missing.
 *
 * An express-validator chain only COLLECTS errors; nothing acts on them until
 * something calls validationResult. Without this middleware the chains above
 * were decoration: a malformed month, a non-ObjectId settlement id or an
 * out-of-catalogue recovery type sailed straight through to the service.
 */
const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const error = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  error.errors = errors.array().map((entry) => ({ field: entry.path, message: entry.msg }));
  throw error;
};

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

export const fnfMonthQueryValidator = [monthRule(query('month')), validate];

export const fnfListQueryValidator = [
  monthRule(query('month')),
  query('status')
    .optional()
    .isIn(SETTLEMENT_STATUSES)
    .withMessage(`status must be one of ${SETTLEMENT_STATUSES.join(', ')}`),
  query('search').optional().isString().trim().isLength({ max: 80 }),
  query('departmentId').optional().custom(isObjectId).withMessage('departmentId is invalid'),
  validate,
];

export const fnfExportQueryValidator = [
  monthRule(query('month')),
  query('format')
    .optional()
    .isIn(EXPORT_FORMATS)
    .withMessage('format must be CSV or XLSX'),
  validate,
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
  validate,
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
  validate,
];

export const noticeDecisionValidator = [
  body('decision')
    .isIn(NOTICE_DECISIONS)
    .withMessage(`decision must be one of ${NOTICE_DECISIONS.join(', ')}`),
  body('noticePeriodDays').optional().isInt({ min: 0, max: 365 }).withMessage('noticePeriodDays must be 0-365'),
  validate,
];

/**
 * §13 — one recovery added by Finance while the settlement is with them.
 * Same shape as an item in updateItems: amount and reason are mandatory,
 * the type must be one of the recovery catalogue, and no payable field is
 * accepted here at all.
 */
export const addRecoveryValidator = [
  param('settlementId').isMongoId().withMessage('A valid settlement id is required'),
  body('type')
    .isString()
    .trim()
    .isIn(RECOVERY_TYPES)
    .withMessage('Choose a valid recovery type'),
  body('amount').isFloat({ gt: 0 }).withMessage('A recovery needs an amount greater than zero'),
  // §9 — a recovery without a reason is not a recovery, it is a deduction
  // nobody can explain to the employee later.
  body('reason').isString().trim().isLength({ min: 3, max: 300 }).withMessage('A recovery needs a reason'),
  body('label').optional({ nullable: true }).isString().trim().isLength({ max: 120 }),
  validate,
];

export const hrReviewValidator = [
  body('complete').optional().isBoolean().withMessage('complete must be true or false'),
  body('remarks').optional().isString().trim().isLength({ max: 500 }),
  ...CHECKLIST_ITEMS.map((key) =>
    body(`checklist.${key}`).optional().isBoolean().withMessage(`${key} must be true or false`),
  ),
  validate,
];

export const financeDecisionValidator = [
  body('action').isIn(['APPROVE', 'REJECT']).withMessage('action must be APPROVE or REJECT'),
  body('remarks').optional().isString().trim().isLength({ max: 500 }),
  validate,
];

export const markPaidValidator = [
  dateRule(body('paidAt')),
  body('reference').optional().isString().trim().isLength({ max: 60 }),
  body('method').optional().isString().trim().isLength({ max: 40 }),
  validate,
];

export const reopenValidator = [
  body('remarks')
    .isString()
    .trim()
    .isLength({ min: 3, max: 500 })
    .withMessage('a reopened settlement needs a reason'),
  validate,
];

// ── path params ────────────────────────────────────────────────────────────

export const settlementIdParamValidator = [objectIdRule(param('settlementId'), 'settlementId'), validate];
export const settlementFileIdParamValidator = [objectIdRule(param('fileId'), 'fileId'), validate];
