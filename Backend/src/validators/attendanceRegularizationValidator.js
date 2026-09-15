import { body, param, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';

// ─────────────────────────────────────────────────────────────
// Phase 31.5 — attendance regularization validators.
//
// Tenant + employee authority always come from req.companyId /
// req.user at the edge: identity overrides in the payload are
// refused outright (self-service spoof-proofing).
// ─────────────────────────────────────────────────────────────

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw ApiError.badRequest(errors.array()[0]?.msg || 'Invalid request');
  }
  next();
};

const noIdentityOverride = body().custom((value, { req }) => {
  const forbidden = ['companyId', 'userId', 'employeeId', 'approverId', 'user', 'approver'];
  const present = forbidden.filter((field) => req.body?.[field] !== undefined);
  if (present.length) {
    throw new Error(`${present.join(', ')} must not be supplied — identity comes from your login`);
  }
  return true;
});

const requestIdParam = param('requestId').isMongoId().withMessage('requestId must be a valid id');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const TYPES = [
  'MISSED_CLOCK_IN',
  'MISSED_CLOCK_OUT',
  'CLOCK_IN_TIME_CORRECTION',
  'CLOCK_OUT_TIME_CORRECTION',
  'BREAK_CORRECTION',
  'WORK_MODE_CORRECTION',
  'LATE_EXPLANATION',
  'EARLY_EXIT_EXPLANATION',
  'SHORT_HOURS_EXPLANATION',
  'GEOFENCE_EXPLANATION',
];

export const regularizationCreateValidator = [
  noIdentityOverride,
  body('type')
    .isIn(TYPES)
    .withMessage(`type must be one of ${TYPES.join(', ')}`),
  body('attendanceDate')
    .isString()
    .withMessage('attendanceDate must be a YYYY-MM-DD day string')
    .matches(DAY_RE)
    .withMessage('attendanceDate must be a valid YYYY-MM-DD day'),
  body('reason')
    .isString()
    .withMessage('reason is required')
    .trim()
    .isLength({ min: 1, max: 300 })
    .withMessage('reason must be 1–300 characters'),
  body('proposal.correctedIn')
    .optional({ nullable: true })
    .isISO8601()
    .withMessage('proposal.correctedIn must be an ISO datetime'),
  body('proposal.correctedOut')
    .optional({ nullable: true })
    .isISO8601()
    .withMessage('proposal.correctedOut must be an ISO datetime'),
  body('proposal.breaks')
    .optional({ nullable: true })
    .isArray()
    .withMessage('proposal.breaks must be an array of {start,end}'),
  body('proposal.breaks.*.start')
    .optional({ nullable: true })
    .isISO8601()
    .withMessage('proposal.breaks[].start must be an ISO datetime'),
  body('proposal.breaks.*.end')
    .optional({ nullable: true })
    .isISO8601()
    .withMessage('proposal.breaks[].end must be an ISO datetime'),
  body('proposal.workMode')
    .optional({ nullable: true })
    .isIn(['OFFICE', 'WFH', 'FIELD', 'CLIENT_SITE', 'BUSINESS_TRAVEL'])
    .withMessage('proposal.workMode must be a valid work mode'),
  validate,
];

export const regularizationIdValidator = [noIdentityOverride, requestIdParam, validate];

export const regularizationDecideValidator = [
  noIdentityOverride,
  requestIdParam,
  body('reviewReason')
    .optional({ nullable: true })
    .isString()
    .withMessage('reviewReason must be text')
    .trim()
    .isLength({ max: 300 })
    .withMessage('reviewReason must be at most 300 characters'),
  validate,
];
