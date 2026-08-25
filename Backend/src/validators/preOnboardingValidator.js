import { body, param, query, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';
import { PRE_ONBOARDING_DOC_CATEGORIES } from '../models/PreOnboardingDocumentRequirement.js';
import { PRE_ONBOARDING_STATUSES } from '../models/PreOnboarding.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const message = errors
      .array()
      .map((item) => item.msg)
      .join(', ');
    return next(ApiError.badRequest(message));
  }
  return next();
};

const objectIdParam = (name) =>
  param(name).isMongoId().withMessage(`A valid ${name} is required`);

export const listPreOnboardingRules = [
  query('status')
    .optional({ nullable: true, checkFalsy: true })
    .isIn(PRE_ONBOARDING_STATUSES)
    .withMessage('Choose a valid pre-onboarding status'),
  query('jobId')
    .optional({ nullable: true, checkFalsy: true })
    .isMongoId()
    .withMessage('Choose a valid job'),
  query('page')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1, max: 100000 })
    .withMessage('Page must be a positive integer'),
  query('limit')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  validate,
];

export const preOnboardingIdRules = [objectIdParam('preOnboardingId'), validate];

export const startPreOnboardingRules = [
  objectIdParam('candidateId'),
  body('sendInvite')
    .optional()
    .isBoolean()
    .withMessage('sendInvite must be a boolean'),
  validate,
];

export const documentActionRules = [
  objectIdParam('preOnboardingId'),
  objectIdParam('documentId'),
  validate,
];

export const rejectDocumentRules = [
  objectIdParam('preOnboardingId'),
  objectIdParam('documentId'),
  body('reason')
    .trim()
    .notEmpty()
    .withMessage('A rejection reason is required')
    .isLength({ max: 1000 })
    .withMessage('Rejection reason is too long'),
  validate,
];

export const requirementIdRules = [objectIdParam('requirementId'), validate];

export const createRequirementRules = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Requirement name is required')
    .isLength({ max: 120 })
    .withMessage('Requirement name is too long'),
  body('code')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 40 })
    .withMessage('Requirement code is too long'),
  body('category')
    .optional()
    .isIn(PRE_ONBOARDING_DOC_CATEGORIES)
    .withMessage('Choose a valid category'),
  body('required').optional().isBoolean(),
  body('active').optional().isBoolean(),
  body('instructions')
    .optional({ nullable: true })
    .isLength({ max: 2000 })
    .withMessage('Instructions are too long'),
  body('maxFileSize')
    .optional()
    .isInt({ min: 50 * 1024, max: 10 * 1024 * 1024 })
    .withMessage('Max file size is out of range'),
  body('displayOrder').optional().isInt({ min: 0, max: 10000 }),
  body('requiresExpiryDate').optional().isBoolean(),
  body('requiresDocumentNumber').optional().isBoolean(),
  validate,
];

export const updateRequirementRules = [
  objectIdParam('requirementId'),
  body('name')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Requirement name cannot be empty')
    .isLength({ max: 120 }),
  body('category')
    .optional()
    .isIn(PRE_ONBOARDING_DOC_CATEGORIES)
    .withMessage('Choose a valid category'),
  body('required').optional().isBoolean(),
  body('active').optional().isBoolean(),
  body('instructions').optional({ nullable: true }).isLength({ max: 2000 }),
  body('maxFileSize')
    .optional()
    .isInt({ min: 50 * 1024, max: 10 * 1024 * 1024 }),
  body('displayOrder').optional().isInt({ min: 0, max: 10000 }),
  body('requiresExpiryDate').optional().isBoolean(),
  body('requiresDocumentNumber').optional().isBoolean(),
  validate,
];

export const publicPreOnboardingTokenRules = [
  param('secureToken')
    .isString()
    .isLength({ min: 40, max: 200 })
    .withMessage('A valid secure token is required'),
  validate,
];

export const publicUploadRules = [
  param('secureToken')
    .isString()
    .isLength({ min: 40, max: 200 })
    .withMessage('A valid secure token is required'),
  param('requirementCode')
    .trim()
    .notEmpty()
    .withMessage('Requirement code is required')
    .isLength({ max: 40 }),
  body('documentNumber')
    .optional({ nullable: true, checkFalsy: true })
    .isLength({ max: 80 })
    .withMessage('Document number is too long'),
  body('expiryDate')
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage('Expiry date must be a valid date'),
  validate,
];

export const publicDocumentReadRules = [
  param('secureToken')
    .isString()
    .isLength({ min: 40, max: 200 })
    .withMessage('A valid secure token is required'),
  param('documentCode')
    .trim()
    .notEmpty()
    .withMessage('Document code is required')
    .isLength({ max: 40 }),
  validate,
];
