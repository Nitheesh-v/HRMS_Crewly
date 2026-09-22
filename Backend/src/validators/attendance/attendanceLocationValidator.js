// ─────────────────────────────────────────────────────────────
// Phase 31.3 — attendance-location validators.
//
// STRUCTURAL checks only (shape, enums, sizes, tenant-authority
// rejection, id shape). Business rules (coordinate/radius bounds,
// lifecycle) live in services/attendance/attendanceLocationRules.js
// so every caller is protected equally.
// ─────────────────────────────────────────────────────────────
import { body, param, validationResult } from 'express-validator';

import ApiError from '../../utils/ApiError.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((entry) => ({ field: entry.path, message: entry.msg }));
  throw err;
};

// Tenant authority comes ONLY from req.companyId — a client-supplied
// companyId anywhere is rejected outright.
const noCompanyId = body('companyId').custom((value, { req }) => {
  if (value !== undefined || req.query?.companyId !== undefined) {
    throw new Error('companyId must not be supplied by the client');
  }
  return true;
});

const locationIdParam = param('locationId').isMongoId().withMessage('Choose a valid location');

const nameField = (optional) => {
  const chain = body('name');
  if (optional) chain.optional();
  return chain.isString().trim().isLength({ min: 1, max: 80 }).withMessage('name must be 1–80 characters');
};

const radiusField = (optional) => {
  const chain = body('radiusMeters');
  if (optional) chain.optional();
  return chain.isInt({ min: 10, max: 100000 }).withMessage('radiusMeters must be an integer between 10 and 100000');
};

const coordinateFields = (optional) => {
  const lat = body('latitude');
  const lng = body('longitude');
  if (optional) {
    lat.optional();
    lng.optional();
  }
  return [
    lat.isFloat({ min: -90, max: 90 }).withMessage('latitude must be between -90 and 90'),
    lng.isFloat({ min: -180, max: 180 }).withMessage('longitude must be between -180 and 180'),
  ];
};

const optionalMeta = [
  body('code').optional({ nullable: true }).isString().trim().isLength({ max: 32 }).withMessage('code must be 32 characters or fewer'),
  body('displayAddress')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 300 })
    .withMessage('displayAddress must be 300 characters or fewer'),
  body('isActive').optional().isBoolean().withMessage('isActive must be a boolean'),
];

export const attendanceLocationCreateValidator = [
  noCompanyId,
  nameField(false),
  ...optionalMeta,
  ...coordinateFields(false),
  radiusField(false),
  validate,
];

export const attendanceLocationUpdateValidator = [
  noCompanyId,
  locationIdParam,
  nameField(true),
  ...optionalMeta,
  ...coordinateFields(true),
  radiusField(true),
  validate,
];

export const attendanceLocationIdValidator = [noCompanyId, locationIdParam, validate];
