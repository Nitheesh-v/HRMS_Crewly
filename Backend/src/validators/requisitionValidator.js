import { body, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';
import {
  HIRING_REASONS,
  HIRING_TYPES,
  REQUISITION_EMPLOYMENT_TYPES,
  REQUISITION_PRIORITY,
  WORK_MODES,
} from '../models/JobRequisition.js';
import { DECISIONS } from '../services/recruitment/requisitionService.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);

  if (errors.isEmpty()) return next();

  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');

  err.errors = errors.array().map((e) => ({ field: e.path, message: e.msg }));

  throw err;
};

const optional = { values: 'falsy' };

const sharedRules = [
  body('department').optional(optional).isMongoId().withMessage('Invalid department'),
  body('team').optional(optional).trim().isLength({ max: 80 }),
  body('designation').optional(optional).trim().isLength({ max: 100 }),
  body('openings').optional(optional).isInt({ min: 1, max: 500 }).withMessage('Openings must be 1–500'),
  body('hiringType').optional(optional).isIn(HIRING_TYPES).withMessage('Invalid hiring type'),
  body('minExperience').optional(optional).isFloat({ min: 0, max: 50 }),
  body('maxExperience').optional(optional).isFloat({ min: 0, max: 50 }),
  body('hiringReason').optional(optional).isIn(HIRING_REASONS).withMessage('Invalid hiring reason'),
  body('reasonNote').optional(optional).trim().isLength({ max: 500 }),
  body('priority').optional(optional).isIn(REQUISITION_PRIORITY).withMessage('Invalid priority'),
  body('expectedJoiningDate').optional(optional).isISO8601().withMessage('Invalid joining date'),
  body('minSalary').optional(optional).isFloat({ min: 0 }),
  body('maxSalary').optional(optional).isFloat({ min: 0 }),
  body('hiringBudget').optional(optional).isFloat({ min: 0 }),
  body('employmentType')
    .optional(optional)
    .isIn(REQUISITION_EMPLOYMENT_TYPES)
    .withMessage('Invalid employment type'),
  body('workMode').optional(optional).isIn(WORK_MODES).withMessage('Invalid work mode'),
  body('location').optional(optional).trim().isLength({ max: 100 }),
  body('additionalRequirements').optional(optional).trim().isLength({ max: 2000 }),
];

export const createRequisitionRules = [
  body('position')
    .trim()
    .notEmpty()
    .withMessage('Position is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Position must be 2–100 characters'),
  ...sharedRules,
  validate,
];

export const updateRequisitionRules = [
  body('position').optional(optional).trim().isLength({ min: 2, max: 100 }),
  ...sharedRules,
  validate,
];

export const decisionRules = [
  body('decision').isIn(DECISIONS).withMessage('Decision must be APPROVE, REJECT or SEND_BACK'),
  body('reason').optional(optional).trim().isLength({ max: 500 }),
  validate,
];
