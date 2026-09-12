// ─────────────────────────────────────────────────────────────
// Phase 31.2 — attendance event validators.
//
// STRUCTURAL checks only (action allowlist, enums, sizes, identity/
// tenant-override rejection). Transition validity, work-mode policy
// and idempotency semantics live in the service + pure rules.
// ─────────────────────────────────────────────────────────────
import { body, validationResult } from 'express-validator';

import ApiError from '../utils/ApiError.js';
import { EVENT_TYPE, WORK_MODE } from '../services/attendance/attendancePolicyRules.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((entry) => ({ field: entry.path, message: entry.msg }));
  throw err;
};

// Self-service identity comes ONLY from req.user / req.companyId.
// Any client-supplied identity or tenant override is refused outright.
const noIdentityOverride = body().custom((value, { req }) => {
  const body = req.body || {};
  for (const field of ['companyId', 'company', 'employeeId', 'employee', 'user', 'userId']) {
    if (body[field] !== undefined) {
      throw new Error(`${field} must not be supplied by the client`);
    }
  }
  return true;
});

export const attendanceEventValidator = [
  noIdentityOverride,
  body('action')
    .exists({ checkFalsy: true })
    .withMessage('action is required')
    .isString()
    .isIn(Object.values(EVENT_TYPE))
    .withMessage(`action must be one of ${Object.values(EVENT_TYPE).join(', ')}`),
  body('workMode')
    .optional({ nullable: true })
    .isString()
    .isIn(Object.values(WORK_MODE))
    .withMessage(`workMode must be one of ${Object.values(WORK_MODE).join(', ')}`),
  body('date')
    .optional({ nullable: true })
    .isString()
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage('date must be YYYY-MM-DD'),
  // Opaque client idempotency key: no PII, bounded length.
  body('idempotencyKey')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ min: 8, max: 64 })
    .withMessage('idempotencyKey must be 8–64 characters'),
  validate,
];
