// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 38 — PROFILE CHANGE REQUEST VALIDATORS
//
//  Structural checks only. The business rules (which fields may be changed,
//  what a valid employee code looks like, whether the value actually differs
//  from the current one) live in services/profile/profileChangeRules.js and
//  are enforced there as well — a validator is UX, never the last line.
//
//  IDENTITY RULE
//    `companyId`, `employeeId`, `status`, `reviewedBy`, `requestedBy` are
//    refused outright when a client sends them. Every identity fact comes
//    from the access token (authMiddleware → req.user/_id + req.companyId).
// ═══════════════════════════════════════════════════════════════════════════

import { body, param, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const first = errors.array()[0];
  const error = ApiError.badRequest(first?.msg || 'Validation failed');
  error.errors = errors.array().map((entry) => ({
    field: entry.path,
    message: entry.msg,
  }));
  throw error;
};

const FORBIDDEN_IDENTITY_FIELDS = Object.freeze([
  'companyId',
  'company',
  'employeeId',
  'employee',
  'userId',
  'user',
  'status',
  'reviewedBy',
  'reviewer',
  'requestedBy',
  'appliedAt',
]);

const noIdentityOverride = body().custom((_value, { req }) => {
  const payload = { ...(req.body || {}), ...(req.params || {}) };
  for (const field of FORBIDDEN_IDENTITY_FIELDS) {
    if (payload[field] !== undefined) {
      throw new Error(`${field} must not be supplied by the client`);
    }
  }
  return true;
});

const requestIdParam = param('requestId')
  .isString()
  .withMessage('requestId must be a string')
  .isLength({ min: 1 })
  .withMessage('requestId is required');

// POST /api/profile/change-requests
export const profileChangeSubmitValidator = [
  noIdentityOverride,
  body('changes')
    .exists()
    .withMessage('changes is required')
    .bail()
    .isObject()
    .withMessage('changes must be an object of field → new value'),
  body('reason')
    .optional({ nullable: true })
    .isString()
    .withMessage('reason must be a string')
    .trim()
    .isLength({ max: 300 })
    .withMessage('reason must be at most 300 characters'),
  validate,
];

// POST /:requestId/approve | /:requestId/reject
export const profileChangeDecideValidator = [
  noIdentityOverride,
  requestIdParam,
  body('decisionNote')
    .optional({ nullable: true })
    .isString()
    .withMessage('decisionNote must be a string')
    .trim()
    .isLength({ max: 300 })
    .withMessage('decisionNote must be at most 300 characters'),
  validate,
];

// GET /:requestId | POST /:requestId/cancel
export const profileChangeIdParamValidator = [noIdentityOverride, requestIdParam, validate];
