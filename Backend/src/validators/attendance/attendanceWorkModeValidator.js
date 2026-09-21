import { body, param, validationResult } from 'express-validator';
import ApiError from '../../utils/ApiError.js';

// ─────────────────────────────────────────────────────────────
// Phase 31.4 — work-mode request validators.
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

const dayField = (field, optional) => {
  let chain = body(field);
  if (optional) chain = chain.optional();
  return chain
    .isString()
    .withMessage(`${field} must be a YYYY-MM-DD day string`)
    .matches(DAY_RE)
    .withMessage(`${field} must be a valid YYYY-MM-DD day`);
};

export const workModeRequestCreateValidator = [
  noIdentityOverride,
  body('mode')
    .isIn(['WFH', 'FIELD', 'CLIENT_SITE', 'BUSINESS_TRAVEL'])
    .withMessage('mode must be one of WFH, FIELD, CLIENT_SITE, BUSINESS_TRAVEL'),
  dayField('startDate', false),
  dayField('endDate', true),
  body('dayPortion')
    .optional()
    .isIn(['FULL_DAY', 'FIRST_HALF', 'SECOND_HALF'])
    .withMessage('dayPortion must be one of FULL_DAY, FIRST_HALF, SECOND_HALF'),
  body('reason')
    .isString()
    .withMessage('reason is required')
    .trim()
    .isLength({ min: 1, max: 300 })
    .withMessage('reason must be 1–300 characters'),
  body('placeLabel')
    .optional({ nullable: true })
    .isString()
    .withMessage('placeLabel must be text')
    .trim()
    .isLength({ max: 120 })
    .withMessage('placeLabel must be at most 120 characters'),
  validate,
];

export const workModeRequestIdValidator = [noIdentityOverride, requestIdParam, validate];

export const workModeRequestDecideValidator = [
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
