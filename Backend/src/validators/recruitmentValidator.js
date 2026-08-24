import { body, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';
import {
  EMPLOYMENT_TYPES,
  JOB_EXPERIENCE_LEVELS,
  JOB_PUBLICATION_STATUSES,
  JOB_STATUS,
  JOB_WORK_MODES,
} from '../models/JobPosting.js';
import { OFFER_STATUS } from '../models/Candidate.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const err = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  err.errors = errors.array().map((e) => ({ field: e.path, message: e.msg }));
  throw err;
};

const boundedList = (field, maximum, itemLength) =>
  body(field)
    .optional()
    .custom((value) => {
      const values = Array.isArray(value)
        ? value
        : String(value || '').split(',');

      if (values.length > maximum) {
        throw new Error(`${field} cannot contain more than ${maximum} entries`);
      }

      if (values.some((item) => String(item).trim().length > itemLength)) {
        throw new Error(`Each ${field} entry must be ${itemLength} characters or fewer`);
      }

      return true;
    });

const matchingRequirementRules = [
  body('workMode')
    .optional({ values: 'falsy' })
    .isIn(JOB_WORK_MODES)
    .withMessage('Invalid work mode'),
  body('experienceLevel')
    .optional({ values: 'falsy' })
    .isIn(JOB_EXPERIENCE_LEVELS)
    .withMessage('Invalid experience level'),
  body('minExperience')
    .optional({ nullable: true })
    .isFloat({ min: 0, max: 60 })
    .withMessage('Minimum experience must be between 0 and 60 years'),
  body('maxExperience')
    .optional({ nullable: true })
    .isFloat({ min: 0, max: 60 })
    .withMessage('Maximum experience must be between 0 and 60 years'),
  boundedList('requiredSkills', 50, 60),
  boundedList('preferredSkills', 50, 60),
  boundedList('educationRequirements', 20, 200),
  body('maxNoticePeriod')
    .optional({ nullable: true })
    .isInt({ min: 0, max: 365 })
    .withMessage('Maximum notice period must be between 0 and 365 days'),
];

export const createJobRules = [
  body('title').trim().notEmpty().withMessage('Job title is required').isLength({ min: 3, max: 120 }).withMessage('Title must be 3–120 characters'),
  body('department').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid department'),
  body('location').optional({ values: 'falsy' }).trim().isLength({ max: 80 }),
  body('employmentType').optional({ values: 'falsy' }).isIn(EMPLOYMENT_TYPES).withMessage('Invalid employment type'),
  body('openings').optional({ values: 'falsy' }).isInt({ min: 1, max: 500 }).withMessage('Openings must be 1–500'),
  body('description').optional({ values: 'falsy' }).trim().isLength({ max: 2000 }),
  ...matchingRequirementRules,
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
  ...matchingRequirementRules,
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

export const offerRules = [
  body('offerStatus').isIn(OFFER_STATUS.filter((s) => s !== 'NONE')).withMessage('Invalid offer status'),
  body('offerSalary').optional({ values: 'falsy' }).isFloat({ min: 0 }).withMessage('Offer salary must be 0 or more'),
  body('offerJoiningDate').optional({ values: 'falsy' }).isISO8601().withMessage('Joining date must be a valid date'),
  validate,
];