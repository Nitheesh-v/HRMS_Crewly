// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.1 — PRESENCE VALIDATORS
//
//  STRUCTURAL only. The policy decisions (WFH disabled / WFH approval-
// required / status messages disabled) live in the service. Mirrors the
// 36.1/36.2 aiValidator.js shape exactly so the controller code stays
// uniform.
//
//  IDENTITY OVERRIDE
//    Phase 37 §19 + §4 + §16:
//    a request body / query MUST NOT carry companyId / company / userId
//    / user / employeeId / employee. The Phase 36 aiValidator refuses
//    the first five; Phase 37 adds employeeId and employee. Same shape
//    as 36: a `body().custom((_v, { req }) => ...)` walk that throws on
//    any forbidden key.
// ═══════════════════════════════════════════════════════════════════════════

import { body, validationResult } from 'express-validator';

import ApiError from '../../utils/ApiError.js';

import {
  EXPIRY_MAX_DAYS,
  PRESENCE_MANUAL_VALUES,
  STATUS_MESSAGE_MAX_CHARS,
  WORK_LOCATION_VALUES,
  isWfhMode,
  isWorkLocation,
} from '../../services/presence/presenceConfig.js';

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
]);

const noIdentityOverride = body().custom((_value, { req }) => {
  const payload = req.body || {};
  for (const field of FORBIDDEN_IDENTITY_FIELDS) {
    if (payload[field] !== undefined) {
      throw new Error(`${field} must not be supplied by the client`);
    }
  }
  return true;
});

// ─── Status mutation ───────────────────────────────────────────────────────
//
// PUT /api/presence/me/status
//   { status: 'available' | 'busy' | 'dnd' | null,
//     expiresAt?: ISO string | null }
//
//   status === null             → clear the manual row
//   status === undefined       → 400 (you sent nothing useful)
//   status !== manual enum     → 400 (the manual set is closed)
//
// expiresAt semantics:
//   · absent / undefined        → no expiry, manual persists indefinitely
//                                 until the user clears it
//   · null                      → 400 (use the clear shape: status: null)
//   · non-ISO string / Date     → 400 EXPIRY_IN_PAST or EXPIRY_TOO_FAR
const optionalFutureIsoDate = body('expiresAt')
  .optional({ checkFalsy: false })
  .custom((value) => {
    if (value === null) {
      throw new Error(
        'expiresAt must be omitted or an ISO date string; use status: null to clear',
      );
    }
    if (value === undefined) return false;

    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new Error('expiresAt must be an ISO date string');
    }
    if (d.getTime() <= Date.now()) {
      throw new Error('expiresAt must be in the future');
    }
    const maxFutureMs = EXPIRY_MAX_DAYS * 24 * 60 * 60 * 1000;
    if (d.getTime() - Date.now() > maxFutureMs) {
      throw new Error(
        `expiresAt must be within ${EXPIRY_MAX_DAYS} days from now`,
      );
    }
    return true;
  });

const statusValue = body('status').custom((value, { req }) => {
  // status: null is the explicit clear shape.
  if (value === null) {
    if (req.body?.expiresAt !== undefined) {
      throw new Error(
        'expiresAt must be omitted while clearing (status: null)',
      );
    }
    return true;
  }
  if (value === undefined) {
    throw new Error('status is required (use null to clear)');
  }
  if (typeof value !== 'string' || !PRESENCE_MANUAL_VALUES.includes(value)) {
    throw new Error(
      `status must be one of: ${PRESENCE_MANUAL_VALUES.join(', ')}, or null to clear`,
    );
  }
  return true;
});

export const presenceStatusValidator = [
  noIdentityOverride,
  statusValue,
  optionalFutureIsoDate,
  validate,
];

// ─── Status message mutation ───────────────────────────────────────────────
//
// PUT /api/presence/me/status-message
//   { message: 'string' | '',
//     expiresAt?: ISO string | null }
//
//   empty string after trim → 400 STATUS_MESSAGE_EMPTY_AFTER_TRIM
//   > STATUS_MESSAGE_MAX_CHARS  → 400 STATUS_MESSAGE_TOO_LONG
const messageValue = body('message').custom((value) => {
  if (value === undefined) throw new Error('message is required');
  if (typeof value !== 'string') throw new Error('message must be a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(
      'message must contain at least one non-whitespace character',
    );
  }
  if (trimmed.length > STATUS_MESSAGE_MAX_CHARS) {
    throw new Error(
      `message must be at most ${STATUS_MESSAGE_MAX_CHARS} characters`,
    );
  }
  return true;
});

export const presenceStatusMessageValidator = [
  noIdentityOverride,
  messageValue,
  optionalFutureIsoDate,
  validate,
];

// ─── Work-location mutation ────────────────────────────────────────────────
//
// PUT /api/presence/me/work-location
//   { location: 'office' | 'wfh' | 'remote' | null,
//     expiresAt?: ISO string | null }
//
//   null clears the work-location. Policy checks live in the SERVICE —
//   a body validator cannot answer "is WFH allowed right now?" because
//   that depends on tenant config.
const locationValue = body('location').custom((value) => {
  if (value === null) return true;
  if (value === undefined) throw new Error('location is required');
  if (!isWorkLocation(value)) {
    throw new Error(
      `location must be one of: ${WORK_LOCATION_VALUES.join(', ')}, or null to clear`,
    );
  }
  return true;
});

export const presenceWorkLocationValidator = [
  noIdentityOverride,
  locationValue,
  optionalFutureIsoDate,
  validate,
];

// ─── Tenant config PUT ────────────────────────────────────────────────────
//
// PUT /api/presence/config
//   { enabled?, statusMessagesEnabled?, workLocationEnabled?, wfhMode?,
//     awayAfterMinutes?, offlineAfterMinutes?, lastSeenVisible?,
//     allowedWorkLocations? }
//
//   wfhMode must be in WFH_MODES
//   allowedWorkLocations must be a non-duplicate subset of WORK_LOCATION_VALUES
//   offlineAfterMinutes must be > awayAfterMinutes
const configPatch = [
  body('wfhMode')
    .optional()
    .custom((value) => {
      if (!isWfhMode(value)) {
        throw new Error(
          `wfhMode must be one of: self_declare, approval_required, disabled`,
        );
      }
      return true;
    }),
  body('allowedWorkLocations')
    .optional()
    .custom((value) => {
      if (!Array.isArray(value)) {
        throw new Error('allowedWorkLocations must be an array');
      }
      const set = new Set(value);
      if (set.size !== value.length) {
        throw new Error('allowedWorkLocations must not contain duplicates');
      }
      for (const v of value) {
        if (!isWorkLocation(v)) {
          throw new Error(
            `allowedWorkLocations entries must be one of: ${WORK_LOCATION_VALUES.join(', ')}`,
          );
        }
      }
      return true;
    }),
  body('awayAfterMinutes')
    .optional()
    .isInt({ min: 1 })
    .withMessage('awayAfterMinutes must be a positive integer'),
  body('offlineAfterMinutes')
    .optional()
    .isInt({ min: 1 })
    .withMessage('offlineAfterMinutes must be a positive integer')
    .custom((value, { req }) => {
      const away = req.body?.awayAfterMinutes;
      if (typeof away === 'number' && value <= away) {
        throw new Error(
          'offlineAfterMinutes must be greater than awayAfterMinutes',
        );
      }
      return true;
    }),
  body('enabled')
    .optional()
    .isBoolean()
    .withMessage('enabled must be boolean'),
  body('statusMessagesEnabled')
    .optional()
    .isBoolean()
    .withMessage('statusMessagesEnabled must be boolean'),
  body('workLocationEnabled')
    .optional()
    .isBoolean()
    .withMessage('workLocationEnabled must be boolean'),
  body('lastSeenVisible')
    .optional()
    .isBoolean()
    .withMessage('lastSeenVisible must be boolean'),
  body('employeePresenceVisible')
    .optional()
    .isBoolean()
    .withMessage('employeePresenceVisible must be boolean'),
];

export const presenceConfigValidator = [
  noIdentityOverride,
  ...configPatch,
  validate,
];

// Export the constant so the tests pin it verbatim.
export const PRESENCE_FORBIDDEN_IDENTITY_FIELDS = FORBIDDEN_IDENTITY_FIELDS;