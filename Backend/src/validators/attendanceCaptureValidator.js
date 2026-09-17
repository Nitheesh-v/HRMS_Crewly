// ─────────────────────────────────────────────────────────────
// Phase 31.14 — alternate-capture validators.
//
// STRUCTURAL checks only (ids, enums, sizes, override rejection).
// Source/provenance is ALWAYS server-decided: any client-supplied
// source, provenance, ingest, or timestamp override is refused.
// ─────────────────────────────────────────────────────────────
import { body, param, validationResult } from 'express-validator';

import ApiError from '../utils/ApiError.js';
import { EVENT_TYPE } from '../services/attendance/attendancePolicyRules.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((entry) => ({ field: entry.path, message: entry.msg }));
  throw err;
};

// Tenant/identity always come from the session (employee JWT or
// kiosk JWT) — never from the client.
const noIdentityOverride = body().custom((value, { req }) => {
  const payload = req.body || {};
  for (const field of ['companyId', 'company', 'employeeId', 'employee', 'user', 'userId']) {
    if (payload[field] !== undefined) {
      throw new Error(`${field} must not be supplied by the client`);
    }
  }
  return true;
});

// The backend decides source/provenance from the endpoint + auth
// context. Client claims are refused outright, never trusted,
// never stored.
const noSourceOverride = body().custom((value, { req }) => {
  const payload = req.body || {};
  for (const field of ['source', 'provenance', 'ingest', 'at', 'occurredAt', 'timestamp', 'workMode']) {
    if (payload[field] !== undefined) {
      throw new Error(`${field} is decided by the server and must not be supplied`);
    }
  }
  return true;
});

// 31.16 D-08 — the fence is the page the code hangs in: locationId is
// ALWAYS server-decided from the challenge binding (or the bound
// station's location). The client contributes only its GPS position,
// and never a verdict or measurement.
const noQrLocationOverride = body().custom((value, { req }) => {
  const payload = req.body || {};
  for (const field of [
    'locationId',
    'location',
    'locationVerification',
    'insideGeofence',
    'distanceMeters',
    'radiusMeters',
    'verified',
  ]) {
    if (payload[field] !== undefined) {
      throw new Error(`${field} is decided by the server and must not be supplied`);
    }
  }
  if (payload.position !== undefined && payload.position !== null && typeof payload.position !== 'object') {
    throw new Error('position must be an object');
  }
  return true;
});

// ── Station management (HR) ──────────────────────────────────

export const kioskStationValidator = [
  noIdentityOverride,
  body('name').isString().trim().isLength({ min: 1, max: 60 }).withMessage('Station name is required (max 60 characters)'),
  body('locationId').optional({ nullable: true }).isMongoId().withMessage('locationId must be an ObjectId string'),
  validate,
];

export const kioskStationIdValidator = [
  param('id').isMongoId().withMessage('Station id must be an ObjectId string'),
  validate,
];

export const kioskStationPatchValidator = [
  noIdentityOverride,
  param('id').isMongoId().withMessage('Station id must be an ObjectId string'),
  body('name').optional().isString().trim().isLength({ min: 1, max: 60 }).withMessage('Station name is required (max 60 characters)'),
  body('locationId').optional({ nullable: true }).isMongoId().withMessage('locationId must be an ObjectId string'),
  body('status').optional().isIn(['ACTIVE', 'INACTIVE']).withMessage('status must be ACTIVE or INACTIVE'),
  validate,
];

// ── Kiosk sessions + punches (shared device) ─────────────────

export const kioskSessionValidator = [
  body('stationId').isMongoId().withMessage('stationId must be an ObjectId string'),
  body('secret').isString().isLength({ min: 1, max: 500 }).withMessage('Station secret is required'),
  validate,
];

// 31.14 completion — the punch trusts ONLY the verified employee
// context: a client-supplied employeeCode alongside it is refused
// outright (it must never silently override the verified user).
const noKioskIdentityOverride = body().custom((value, { req }) => {
  const payload = req.body || {};
  for (const field of ['employeeCode', 'employeeId', 'userId', 'user']) {
    if (payload[field] !== undefined) {
      throw new Error(`${field} is decided by employee verification and must not be supplied`);
    }
  }
  return true;
});

export const kioskIdentifyValidator = [
  noIdentityOverride,
  body('employeeCode').isString().trim().isLength({ min: 1, max: 32 }).withMessage('employeeCode is required'),
  // Presence only — exact shape is enforced by the service behind
  // the generic 401 so failure detail never leaks which half failed.
  body('pin').isString().isLength({ min: 1, max: 32 }).withMessage('Kiosk PIN is required'),
  validate,
];

export const kioskPunchValidator = [
  noIdentityOverride,
  noSourceOverride,
  noKioskIdentityOverride,
  body('employeeToken').isString().isLength({ min: 1, max: 2000 }).withMessage('Employee verification is required'),
  body('action').isIn(Object.values(EVENT_TYPE)).withMessage('Unknown attendance action'),
  body('idempotencyKey').optional({ nullable: true }).isString().trim().isLength({ min: 1, max: 120 }).withMessage('idempotencyKey is too long'),
  validate,
];

// ── Kiosk PIN self-service (employee session) ────────────────
// Own-session writes: the service returns specific guidance here
// (no oracle concern — the caller proved identity via login).

export const kioskPinSetValidator = [
  noIdentityOverride,
  body('pin').isString().isLength({ min: 1, max: 32 }).withMessage('Kiosk PIN is required'),
  body('currentPin').optional({ nullable: true }).isString().isLength({ min: 1, max: 32 }).withMessage('Current Kiosk PIN is invalid'),
  validate,
];

export const kioskPinClearValidator = [
  noIdentityOverride,
  body('targetUserId').isMongoId().withMessage('targetUserId must be an ObjectId string'),
  validate,
];

// ── QR challenges ────────────────────────────────────────────

export const qrChallengeValidator = [
  noIdentityOverride,
  body('locationId').optional({ nullable: true }).isMongoId().withMessage('locationId must be an ObjectId string'),
  body('stationId').optional({ nullable: true }).isMongoId().withMessage('stationId must be an ObjectId string'),
  validate,
];

export const qrTokenValidator = [
  noIdentityOverride,
  noSourceOverride,
  body('token').isString().trim().isLength({ min: 1, max: 500 }).withMessage('QR token is required'),
  validate,
];

export const qrRedeemValidator = [
  noIdentityOverride,
  noSourceOverride,
  noQrLocationOverride,
  body('token').isString().trim().isLength({ min: 1, max: 500 }).withMessage('QR token is required'),
  body('action').isIn(Object.values(EVENT_TYPE)).withMessage('Unknown attendance action'),
  body('idempotencyKey').optional({ nullable: true }).isString().trim().isLength({ min: 1, max: 120 }).withMessage('idempotencyKey is too long'),
  // 31.16 D-08 — one-shot GPS for CLOCK_IN geofence verification
  // (consumed only by CLOCK_IN; exact ranges enforced by the service).
  body('position').optional({ nullable: true }).isObject().withMessage('position must be an object'),
  body('position.latitude')
    .optional()
    .isFloat()
    .withMessage('position.latitude must be a number'),
  body('position.longitude')
    .optional()
    .isFloat()
    .withMessage('position.longitude must be a number'),
  body('position.accuracy')
    .optional({ nullable: true })
    .isFloat()
    .withMessage('position.accuracy must be a number'),
  validate,
];

// ── Imports (HR; file arrives via multipart) ─────────────────

export const importIdValidator = [
  param('id').isMongoId().withMessage('Import id must be an ObjectId string'),
  validate,
];
