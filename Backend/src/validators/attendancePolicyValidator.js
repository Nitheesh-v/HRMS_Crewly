// ─────────────────────────────────────────────────────────────
// Phase 31.1 — Attendance Policy validators.
//
// STRUCTURAL checks only (shape, enums, sizes, tenant-authority
// rejection). Business rules (threshold ordering, grace bounds,
// work-mode requirements) live in
// services/attendance/attendancePolicyRules.js so every caller is
// protected equally.
// ─────────────────────────────────────────────────────────────
import { body, query, validationResult } from 'express-validator';

import ApiError from '../utils/ApiError.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((entry) => ({ field: entry.path, message: entry.msg }));
  throw err;
};

// Tenant authority comes ONLY from req.companyId — a client-supplied
// companyId anywhere is rejected outright.
const noCompanyId = (location) =>
  body('companyId').custom((value, { req }) => {
    if (value !== undefined || req.query?.companyId !== undefined) {
      throw new Error('companyId must not be supplied by the client');
    }
    return true;
  });

const int = (min, max) =>
  `Must be an integer between ${min} and ${max}`;

export const attendancePolicyDraftValidator = [
  noCompanyId(),
  body('expectedConfigVersion').optional().isInt({ min: 1 }),
  body('name').optional().isString().trim().isLength({ min: 1, max: 80 }),
  body('description').optional().isString().trim().isLength({ max: 500 }),
  body('timezone').optional().isString().trim().isLength({ min: 1, max: 64 }),
  body('locationEnforcement').optional().isIn(['DISABLED', 'OPTIONAL', 'REQUIRED']),
  body('thresholds').optional().isObject(),
  body('thresholds.fullDayMinutes').optional().isInt({ min: 1, max: 1440 }).withMessage(int(1, 1440)),
  body('thresholds.halfDayMinutes').optional().isInt({ min: 0, max: 1440 }).withMessage(int(0, 1440)),
  body('grace').optional().isObject(),
  body('grace.lateInMinutes').optional().isInt({ min: 0, max: 120 }).withMessage(int(0, 120)),
  body('grace.earlyOutMinutes').optional().isInt({ min: 0, max: 120 }).withMessage(int(0, 120)),
  body('breaks').optional().isObject(),
  body('breaks.enabled').optional().isBoolean(),
  body('breaks.includeInWorkedTime').optional().isBoolean(),
  body('breaks.dailyLimitMinutes').optional({ nullable: true }).isInt({ min: 0, max: 1440 }),
  body('missingPunch').optional().isObject(),
  body('missingPunch.keepUnresolved').optional().isBoolean(),
  body('missingPunch.allowRegularization').optional().isBoolean(),
  body('missingPunch.regularizationWindowDays').optional().isInt({ min: 0, max: 31 }),
  body('overtime').optional().isObject(),
  body('overtime.trackingEnabled').optional().isBoolean(),
  body('overtime.minimumExtraMinutes').optional().isInt({ min: 0, max: 1440 }),
  body('overtime.approvalRequired').optional().isBoolean(),
  body('overtime.weekendEligible').optional().isBoolean(),
  body('overtime.holidayEligible').optional().isBoolean(),
  body('weekendHoliday').optional().isObject(),
  body('weekendHoliday.allowWorkOnWeeklyOff').optional().isBoolean(),
  body('weekendHoliday.allowWorkOnHoliday').optional().isBoolean(),
  body('workModes').optional().isObject(),
  body('workModes.office').optional().isBoolean(),
  body('workModes.wfh').optional().isBoolean(),
  body('workModes.field').optional().isBoolean(),
  body('workModes.clientSite').optional().isBoolean(),
  body('workModes.businessTravel').optional().isBoolean(),
  validate,
];

export const attendancePolicyActivateValidator = [
  noCompanyId(),
  body('expectedConfigVersion').optional().isInt({ min: 1 }),
  validate,
];

export const attendancePolicyHistoryValidator = [
  query('companyId').custom((value) => {
    if (value !== undefined) throw new Error('companyId must not be supplied by the client');
    return true;
  }),
  query('limit').optional().isInt({ min: 1, max: 50 }),
  validate,
];
