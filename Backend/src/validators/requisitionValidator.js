import { body, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';
import {
  REQUISITION_EMPLOYMENT_TYPES,
  REQUISITION_EXPERIENCE_LEVELS,
  REQUISITION_HIRING_REASONS,
  REQUISITION_PRIORITIES,
  REQUISITION_WORK_MODES,
} from '../models/JobRequisition.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);

  if (errors.isEmpty()) return next();

  const normalized = errors.array().map((error) => ({
    field: error.path,
    message: error.msg,
  }));

  throw ApiError.badRequest(
    normalized[0]?.message || 'Validation failed',
    normalized
  );
};

const skillList = (field) =>
  body(field)
    .optional()
    .custom((value) => {
      const values = Array.isArray(value)
        ? value
        : String(value || '').split(',');

      if (values.length > 50) {
        throw new Error(`${field} cannot contain more than 50 skills`);
      }

      if (values.some((item) => String(item).trim().length > 60)) {
        throw new Error('Each skill must be 60 characters or fewer');
      }

      return true;
    });

const commonRules = [
  body('department')
    .optional()
    .isMongoId()
    .withMessage('Choose a valid department'),
  body('team')
    .optional()
    .trim()
    .isLength({ max: 80 })
    .withMessage('Team must be 80 characters or fewer'),
  body('position')
    .optional()
    .trim()
    .isLength({ min: 2, max: 120 })
    .withMessage('Position must be 2–120 characters'),
  body('openings')
    .optional()
    .isInt({ min: 1, max: 500 })
    .withMessage('Openings must be between 1 and 500'),
  body('experienceLevel')
    .optional()
    .isIn(REQUISITION_EXPERIENCE_LEVELS)
    .withMessage('Choose a valid experience level'),
  body('minExperience')
    .optional({ nullable: true })
    .isFloat({ min: 0, max: 60 })
    .withMessage('Minimum experience must be between 0 and 60 years'),
  body('maxExperience')
    .optional({ nullable: true })
    .isFloat({ min: 0, max: 60 })
    .withMessage('Maximum experience must be between 0 and 60 years'),
  skillList('requiredSkills'),
  skillList('preferredSkills'),
  body('salaryMin')
    .optional({ nullable: true })
    .isFloat({ min: 0 })
    .withMessage('Minimum salary cannot be negative'),
  body('salaryMax')
    .optional({ nullable: true })
    .isFloat({ min: 0 })
    .withMessage('Maximum salary cannot be negative'),
  body('hiringBudget')
    .optional({ nullable: true })
    .isFloat({ min: 0 })
    .withMessage('Hiring budget cannot be negative'),
  body('employmentType')
    .optional()
    .isIn(REQUISITION_EMPLOYMENT_TYPES)
    .withMessage('Choose a valid employment type'),
  body('workMode')
    .optional()
    .isIn(REQUISITION_WORK_MODES)
    .withMessage('Choose a valid work mode'),
  body('location')
    .optional()
    .trim()
    .isLength({ max: 120 })
    .withMessage('Location must be 120 characters or fewer'),
  body('hiringReason')
    .optional()
    .isIn(REQUISITION_HIRING_REASONS)
    .withMessage('Choose a valid hiring reason'),
  body('hiringReasonDetails')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Hiring reason details must be 500 characters or fewer'),
  body('priority')
    .optional()
    .isIn(REQUISITION_PRIORITIES)
    .withMessage('Choose a valid priority'),
  body('expectedJoiningDate')
    .optional({ values: 'falsy', nullable: true })
    .isISO8601()
    .withMessage('Expected joining date must be a valid date'),
];

export const createRequisitionRules = [
  body('department')
    .notEmpty()
    .withMessage('Department is required')
    .isMongoId()
    .withMessage('Choose a valid department'),
  body('position')
    .trim()
    .notEmpty()
    .withMessage('Position is required')
    .isLength({ min: 2, max: 120 })
    .withMessage('Position must be 2–120 characters'),
  ...commonRules,
  validate,
];

export const updateRequisitionRules = [
  ...commonRules,
  validate,
];

export const submitRequisitionRules = [
  body('comment')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Submission comment must be 500 characters or fewer'),
  validate,
];

export const approveRequisitionRules = [
  body('comment')
    .optional({ nullable: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('Approval comment must be 500 characters or fewer'),
  validate,
];

export const rejectRequisitionRules = [
  body('comment')
    .trim()
    .notEmpty()
    .withMessage('A rejection reason is required')
    .bail()
    .isLength({ max: 500 })
    .withMessage('Rejection reason must be 500 characters or fewer'),
  validate,
];

export const sendBackRequisitionRules = [
  body('comment')
    .trim()
    .notEmpty()
    .withMessage('A send-back comment is required')
    .bail()
    .isLength({ max: 500 })
    .withMessage('Send-back comment must be 500 characters or fewer'),
  validate,
];
