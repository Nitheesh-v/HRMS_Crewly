import { body, param, query, validationResult } from 'express-validator';
import ApiError from '../../utils/ApiError.js';

// ─────────────────────────────────────────────────────────────
// Phase 31.8 — overtime / comp-off validators.
//
// Tenant + employee authority always come from req.companyId /
// req.user at the edge: identity overrides in the payload are
// refused outright (self-service spoof-proofing). Eligibility
// figures (eligible/recorded minutes, calendar context) are never
// accepted from the client — the backend recomputes them.
// ─────────────────────────────────────────────────────────────

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw ApiError.badRequest(errors.array()[0]?.msg || 'Invalid request');
  }
  next();
};

const noIdentityOverride = body().custom((value, { req }) => {
  const forbidden = [
    'companyId',
    'userId',
    'employeeId',
    'approverId',
    'reviewerId',
    'user',
    'approver',
    'reviewedBy',
    'eligibleMinutes',
    'recordedMinutes',
    'approvedMinutes',
    'compOffDays',
    'calendarContext',
    'scheduledEnd',
    'isHoliday',
    'isWeeklyOff',
  ];
  const present = forbidden.filter((field) => req.body?.[field] !== undefined);
  if (present.length) {
    throw new Error(`${present.join(', ')} must not be supplied — authority comes from your login and company records`);
  }
  return true;
});

// approvedMinutes arrives on the APPROVE path only, so the shared
// guard above cannot list it — the approve validator uses this
// variant without that field.
const noIdentityOverrideApprove = body().custom((value, { req }) => {
  const forbidden = [
    'companyId',
    'userId',
    'employeeId',
    'approverId',
    'reviewerId',
    'user',
    'approver',
    'reviewedBy',
    'eligibleMinutes',
    'recordedMinutes',
    'compOffDays',
    'calendarContext',
    'scheduledEnd',
    'isHoliday',
    'isWeeklyOff',
  ];
  const present = forbidden.filter((field) => req.body?.[field] !== undefined);
  if (present.length) {
    throw new Error(`${present.join(', ')} must not be supplied — authority comes from your login and company records`);
  }
  return true;
});

const requestIdParam = param('requestId').isMongoId().withMessage('requestId must be a valid id');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const TYPES = ['OVERTIME', 'COMP_OFF'];

const dayField = (field) =>
  body(field)
    .isString()
    .withMessage(`${field} must be a YYYY-MM-DD day string`)
    .matches(DAY_RE)
    .withMessage(`${field} must be a valid YYYY-MM-DD day`);

const reviewReasonField = body('reviewReason')
  .optional({ nullable: true })
  .isString()
  .withMessage('reviewReason must be text')
  .trim()
  .isLength({ max: 300 })
  .withMessage('reviewReason must be at most 300 characters');

export const overtimeCreateValidator = [
  noIdentityOverride,
  body('type').isIn(TYPES).withMessage(`type must be one of ${TYPES.join(', ')}`),
  dayField('attendanceDate'),
  body('requestedMinutes')
    .isInt({ min: 1, max: 1440 })
    .withMessage('requestedMinutes must be a whole number between 1 and 1440'),
  body('reason')
    .isString()
    .withMessage('reason is required')
    .trim()
    .isLength({ min: 1, max: 300 })
    .withMessage('reason must be between 1 and 300 characters'),
  validate,
];

export const overtimeIdValidator = [requestIdParam, validate];

export const overtimeEligibilityValidator = [
  query('from')
    .optional()
    .isString()
    .withMessage('from must be a YYYY-MM-DD day string')
    .matches(DAY_RE)
    .withMessage('from must be a valid YYYY-MM-DD day'),
  query('to')
    .optional()
    .isString()
    .withMessage('to must be a YYYY-MM-DD day string')
    .matches(DAY_RE)
    .withMessage('to must be a valid YYYY-MM-DD day'),
  validate,
];

export const overtimeApproveValidator = [
  noIdentityOverrideApprove,
  requestIdParam,
  body('approvedMinutes')
    .isInt({ min: 1, max: 1440 })
    .withMessage('approvedMinutes must be a whole number between 1 and 1440'),
  reviewReasonField,
  validate,
];

export const overtimeRejectValidator = [noIdentityOverride, requestIdParam, reviewReasonField, validate];

export const overtimeCancelValidator = [noIdentityOverride, requestIdParam, validate];
