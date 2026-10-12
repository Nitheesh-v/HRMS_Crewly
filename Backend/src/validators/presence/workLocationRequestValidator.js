// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.5 — WORK-LOCATION REQUEST VALIDATORS
//
//  Structural only. Policy decisions (wfhMode, allowedWorkLocations,
//  timezone) live in the service. Mirrors the 31.4 attendance validator
//  shape. Identity-override fields are refused outright (spec §9, §43).
// ═══════════════════════════════════════════════════════════════════════════

import { body, param, validationResult } from 'express-validator';
import ApiError from '../../utils/ApiError.js';

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
  'userId',
  'user',
  'employeeId',
  'employee',
  'approver',
  'approverId',
  'reviewedBy',
  'cancelledBy',
  'requestedBy',
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

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const dayField = (field) =>
  body(field)
    .isString()
    .withMessage(`${field} must be a YYYY-MM-DD day string`)
    .matches(DAY_RE)
    .withMessage(`${field} must be a valid YYYY-MM-DD day`);

const locationField = body('location')
  .custom((value) => {
    if (value === undefined || value === null) {
      throw new Error('location is required');
    }
    if (value !== 'wfh') {
      throw new Error('location must be "wfh"');
    }
    return true;
  });

const decisionNoteField = body('decisionNote')
  .optional({ nullable: true })
  .isString()
  .withMessage('decisionNote must be a string')
  .trim()
  .isLength({ max: 300 })
  .withMessage('decisionNote must be at most 300 characters');

// POST /api/presence/work-location-requests
export const workLocationRequestSubmitValidator = [
  noIdentityOverride,
  locationField,
  dayField('startDate'),
  dayField('endDate').optional(),
  validate,
];

// POST/PATCH /api/presence/work-location-requests/:requestId/{approve,reject,cancel}
export const workLocationRequestDecideValidator = [
  noIdentityOverride,
  requestIdParam,
  decisionNoteField,
  validate,
];

// GET /:requestId, GET /pending, GET /mine, POST /:requestId/cancel
export const workLocationRequestIdParamValidator = [
  noIdentityOverride,
  requestIdParam,
  validate,
];
