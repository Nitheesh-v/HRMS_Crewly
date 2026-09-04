import { body, param, query, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';
import { BGV_TRIGGER_STAGES } from '../models/BackgroundVerificationSettings.js';
import { BGV_CASE_STATUSES } from '../models/BackgroundVerificationCase.js';
import { BGV_CHECK_CATEGORIES } from '../models/BackgroundVerificationCheckType.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed'));
  }
  return next();
};

export const bgvSettingsUpdateRules = [
  body('enabled').optional().isBoolean(),
  body('consentRequired').optional().isBoolean(),
  body('bgvRequiredBeforeConversion').optional().isBoolean(),
  body('bgvRequiredBeforeJoining').optional().isBoolean(),
  body('triggerStage')
    .optional()
    .isIn(BGV_TRIGGER_STAGES)
    .withMessage('Choose a valid BGV trigger stage'),
  validate,
];

export const bgvCheckTypeCreateRules = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 120 }),
  body('code').optional({ checkFalsy: true }).trim().isLength({ max: 40 }),
  body('category').optional().isIn(BGV_CHECK_CATEGORIES),
  body('required').optional().isBoolean(),
  body('active').optional().isBoolean(),
  body('instructions').optional({ nullable: true }).isLength({ max: 2000 }),
  body('displayOrder').optional().isInt({ min: 0, max: 10000 }),
  validate,
];

export const bgvCheckTypeUpdateRules = [
  param('checkTypeId').isMongoId().withMessage('Choose a valid check type'),
  body('name').optional().trim().notEmpty().isLength({ max: 120 }),
  body('category').optional().isIn(BGV_CHECK_CATEGORIES),
  body('required').optional().isBoolean(),
  body('active').optional().isBoolean(),
  body('instructions').optional({ nullable: true }).isLength({ max: 2000 }),
  body('displayOrder').optional().isInt({ min: 0, max: 10000 }),
  validate,
];

export const bgvCaseListRules = [
  query('status')
    .optional({ checkFalsy: true })
    .isIn(BGV_CASE_STATUSES)
    .withMessage('Choose a valid BGV status'),
  query('jobId').optional({ checkFalsy: true }).isMongoId(),
  query('verifierId').optional({ checkFalsy: true }).isMongoId(),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 100 }),
  validate,
];

export const bgvCaseIdRules = [
  param('caseId').isMongoId().withMessage('Choose a valid BGV case'),
  validate,
];

export const bgvStartRules = [
  param('candidateId').trim().notEmpty().isLength({ max: 40 }),
  validate,
];

export const bgvAssignRules = [
  param('caseId').isMongoId(),
  body('verifierId').isMongoId().withMessage('Choose a valid verifier'),
  validate,
];

export const bgvCheckActionRules = [
  param('caseId').isMongoId(),
  param('checkId').isMongoId(),
  body('action')
    .trim()
    .notEmpty()
    .isIn([
      'START',
      'REQUEST_INFORMATION',
      'MARK_VERIFIED',
      'RECORD_DISCREPANCY',
      'UNABLE_TO_VERIFY',
    ])
    .withMessage('Choose a valid check action'),
  body('discrepancy').optional({ nullable: true }).isLength({ max: 2000 }),
  body('verifiedInformation').optional({ nullable: true }).isLength({ max: 4000 }),
  body('resultSummary').optional({ nullable: true }).isLength({ max: 2000 }),
  body('hrComment').optional({ nullable: true }).isLength({ max: 2000 }),
  body('claimedInformation').optional({ nullable: true }).isLength({ max: 4000 }),
  validate,
];

export const bgvCompleteRules = [
  param('caseId').isMongoId(),
  body('overallOutcome')
    .trim()
    .notEmpty()
    .isIn(['CLEAR', 'CLEAR_WITH_DISCREPANCIES', 'HOLD'])
    .withMessage('Choose a valid overall outcome'),
  body('reviewComment').optional({ nullable: true }).isLength({ max: 2000 }),
  validate,
];

export const bgvCancelRules = [
  param('caseId').isMongoId(),
  body('reason').trim().notEmpty().withMessage('Cancellation reason is required').isLength({ max: 1000 }),
  validate,
];
