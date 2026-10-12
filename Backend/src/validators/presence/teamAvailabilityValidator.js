// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.3 — TEAM AVAILABILITY VALIDATOR
//
//  STRUCTURAL only. The controller's runWithPresenceError helper converts
//  thrown errors into the project's response shape. A presence
//  PresenceError is converted with the `code` field; an ApiError (from
//  this validator) becomes a plain 400 with no code.
//
//  IDENTITY OVERRIDE
//    Same six-field refusal as 37.1. Phase 37.3 §6 / §42 explicitly
//    attempts ?companyId / ?userId / ?employeeId and tests that they
//    cannot expand scope.
// ═══════════════════════════════════════════════════════════════════════════

import { query, validationResult } from 'express-validator';

import ApiError from '../../utils/ApiError.js';

import {
  PRESENCE_TEAM_ALLOWED_FILTERS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_SEARCH_LEN,
} from '../../services/presence/presenceTeamService.js';

const FORBIDDEN_IDENTITY_FIELDS = Object.freeze([
  'companyId',
  'company',
  'userId',
  'user',
  'employeeId',
  'employee',
]);

const noQueryIdentityOverride = query().custom((_value, { req }) => {
  const payload = req.query || {};
  for (const field of FORBIDDEN_IDENTITY_FIELDS) {
    if (payload[field] !== undefined) {
      throw new Error(`${field} must not be supplied by the client`);
    }
  }
  return true;
});

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

export const teamAvailabilityValidator = [
  noQueryIdentityOverride,

  query('search')
    .optional()
    .isString()
    .withMessage('search must be a string')
    .bail()
    .custom((value) => {
      if (value.length > MAX_SEARCH_LEN) {
        throw new Error(`search must be at most ${MAX_SEARCH_LEN} characters`);
      }
      return true;
    }),

  // The presence filter accepts EITHER a presence value
  // (available / busy / dnd / unknown) OR a work-location value
  // (office / wfh / remote) — both go through the same chip set
  // (37.3 §16). Unknown filter values are refused outright.
  query('presence')
    .optional()
    .isString()
    .withMessage('presence must be a string')
    .bail()
    .custom((value) => {
      if (!PRESENCE_TEAM_ALLOWED_FILTERS.includes(value)) {
        throw new Error(
          `presence must be one of: ${PRESENCE_TEAM_ALLOWED_FILTERS.join(', ')}`,
        );
      }
      return true;
    }),

  query('workLocation')
    .optional()
    .isString()
    .withMessage('workLocation must be a string')
    .bail()
    .custom((value) => {
      if (!['office', 'wfh', 'remote'].includes(value)) {
        throw new Error('workLocation must be one of: office, wfh, remote');
      }
      return true;
    }),

  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('page must be a positive integer'),

  query('limit')
    .optional()
    .isInt({ min: 1, max: MAX_LIMIT })
    .withMessage(`limit must be a positive integer <= ${MAX_LIMIT}`),

  validate,
];

export const PRESENCE_TEAM_FORBIDDEN_IDENTITY_FIELDS = FORBIDDEN_IDENTITY_FIELDS;