import { body, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';
import {
  EMPLOYMENT_TYPES,
  JOB_PUBLICATION_STATUSES,
  JOB_STATUS,
} from '../models/JobPosting.js';
import { CANDIDATE_STAGES, OFFER_STATUS } from '../models/Candidate.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((e) => ({ field: e.path, message: e.msg }));
  throw err;
};

export const createJobRules = [
  body('title').trim().notEmpty().withMessage('Job title is required').isLength({ min: 3, max: 120 }).withMessage('Title must be 3–120 characters'),
  body('department').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid department'),
  body('location').optional({ values: 'falsy' }).trim().isLength({ max: 80 }),
  body('employmentType').optional({ values: 'falsy' }).isIn(EMPLOYMENT_TYPES).withMessage('Invalid employment type'),
  body('openings').optional({ values: 'falsy' }).isInt({ min: 1, max: 500 }).withMessage('Openings must be 1–500'),
  body('description').optional({ values: 'falsy' }).trim().isLength({ max: 2000 }),
  validate,
];

export const updateJobRules = [
  body('title').optional({ values: 'falsy' }).trim().isLength({ min: 3, max: 120 }),
  body('department').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid department'),
  body('location').optional({ values: 'falsy' }).trim().isLength({ max: 80 }),
  body('employmentType').optional({ values: 'falsy' }).isIn(EMPLOYMENT_TYPES).withMessage('Invalid employment type'),
  body('openings').optional({ values: 'falsy' }).isInt({ min: 1, max: 500 }).withMessage('Openings must be 1–500'),
  body('description').optional().trim().isLength({ max: 2000 }),
  body('status').optional({ values: 'falsy' }).isIn(JOB_STATUS).withMessage('Invalid job status'),
  body('publicationStatus')
    .optional({ values: 'falsy' })
    .isIn(JOB_PUBLICATION_STATUSES)
    .withMessage('Invalid job publication status'),
  body('applicationDeadline')
    .optional({ values: 'falsy', nullable: true })
    .isISO8601()
    .withMessage('Application deadline must be a valid date'),
  body('publicSalaryVisible')
    .optional()
    .isBoolean()
    .withMessage('Public salary visibility must be true or false')
    .toBoolean(),
  validate,
];

export const candidateRules = [
  body('job').notEmpty().withMessage('Job is required').isMongoId().withMessage('Invalid job'),
  body('name').trim().notEmpty().withMessage('Candidate name is required').isLength({ min: 2, max: 100 }),
  body('email').trim().isEmail().withMessage('Enter a valid email').normalizeEmail(),
  body('phone').optional({ values: 'falsy' }).trim().matches(/^[0-9+()\-\s]{6,20}$/).withMessage('Enter a valid phone number'),
  body('resumeLink').optional({ values: 'falsy' }).trim().isLength({ max: 300 }),
  body('notes').optional({ values: 'falsy' }).trim().isLength({ max: 500 }),
  validate,
];

export const stageRules = [
  body('stage').isIn(CANDIDATE_STAGES).withMessage('Invalid stage'),
  validate,
];

export const offerRules = [
  body('offerStatus').isIn(OFFER_STATUS.filter((s) => s !== 'NONE')).withMessage('Invalid offer status'),
  body('offerSalary').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Offer salary must be 0 or more'),
  body('offerJoiningDate').optional({ values: 'falsy' }).isISO8601().withMessage('Joining date must be a valid date'),
  validate,
];