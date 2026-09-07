// Phase 30.5 — candidate BGV collection validators.
// Structural checks only; business rules (consent gate, purchased checks,
// readiness) live in the service — the validator is never the boundary.

import { body, param, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';
import {
  ADDRESS_EVIDENCE_CATEGORIES,
  BGV_IDENTITY_DOCUMENT_TYPES,
  RESIDENCE_TYPES,
} from '../models/BgvCollectionCase.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed'));
  }
  return next();
};

export const bgvCollectionTokenRules = [
  param('secureToken').trim().isLength({ min: 40, max: 200 }),
  validate,
];

export const bgvCollectionIdentityRules = [
  param('secureToken').trim().isLength({ min: 40, max: 200 }),
  body('legalName').trim().notEmpty().withMessage('Legal name is required').isLength({ max: 160 }),
  body('dateOfBirth').notEmpty().withMessage('Date of birth is required').isISO8601(),
  body('documentType').isIn(BGV_IDENTITY_DOCUMENT_TYPES).withMessage('Choose a supported identity document type'),
  // The number itself is validated by the service's type-aware pattern and
  // is never persisted — masked display + fingerprint only.
  body('identifier').trim().notEmpty().withMessage('Identity document number is required').isLength({ max: 40 }),
  validate,
];

export const bgvCollectionAddressRules = [
  param('secureToken').trim().isLength({ min: 40, max: 200 }),
  body('line1').trim().notEmpty().withMessage('Address line 1 is required').isLength({ max: 200 }),
  body('line2').optional({ checkFalsy: true }).trim().isLength({ max: 200 }),
  body('locality').optional({ checkFalsy: true }).trim().isLength({ max: 120 }),
  body('city').trim().notEmpty().withMessage('City is required').isLength({ max: 120 }),
  body('state').trim().notEmpty().withMessage('State is required').isLength({ max: 120 }),
  body('pincode').trim().notEmpty().withMessage('PIN code is required').matches(/^[0-9]{4,10}$/),
  body('country').trim().notEmpty().withMessage('Country is required').isLength({ max: 120 }),
  body('residenceType').optional({ nullable: true, checkFalsy: true }).isIn(RESIDENCE_TYPES),
  body('livingSince').optional({ nullable: true, checkFalsy: true }).isISO8601(),
  body('evidenceCategory')
    .optional({ nullable: true, checkFalsy: true })
    .isIn(ADDRESS_EVIDENCE_CATEGORIES)
    .withMessage('Choose a supported address evidence category'),
  validate,
];

const recordBaseRules = [
  param('secureToken').trim().isLength({ min: 40, max: 200 }),
  body('recordId').optional({ checkFalsy: true }).trim().isLength({ max: 64 }),
];

export const bgvCollectionEducationRules = [
  ...recordBaseRules,
  body('institution').trim().notEmpty().withMessage('Institution name is required').isLength({ max: 200 }),
  body('qualification').trim().notEmpty().withMessage('Qualification is required').isLength({ max: 120 }),
  body('startYear').notEmpty().withMessage('Start year is required').isInt({ min: 1950, max: 2100 }),
  body('endYear').optional({ nullable: true, checkFalsy: true }).isInt({ min: 1950, max: 2108 }),
  validate,
];

export const bgvCollectionEmploymentRules = [
  ...recordBaseRules,
  body('employer').trim().notEmpty().withMessage('Employer name is required').isLength({ max: 200 }),
  body('designation').trim().notEmpty().withMessage('Designation is required').isLength({ max: 120 }),
  body('startDate').notEmpty().withMessage('Start date is required').isISO8601(),
  body('endDate').optional({ nullable: true, checkFalsy: true }).isISO8601(),
  body('employmentType').optional({ checkFalsy: true }).isIn(['CURRENT', 'PREVIOUS']),
  body('hrContactEmail').optional({ checkFalsy: true }).isEmail().withMessage('HR contact email is not valid'),
  body('hrContactPhone')
    .optional({ checkFalsy: true })
    .matches(/^[0-9+\-\s()]{6,20}$/)
    .withMessage('HR contact phone is not valid'),
  validate,
];

export const bgvCollectionReferenceRules = [
  ...recordBaseRules,
  body('name').trim().notEmpty().withMessage('Referee name is required').isLength({ max: 120 }),
  body('relationship').trim().notEmpty().withMessage('Relationship is required').isLength({ max: 120 }),
  body('email').optional({ checkFalsy: true }).isEmail().withMessage('Referee email is not valid'),
  body('phone')
    .optional({ checkFalsy: true })
    .matches(/^[0-9+\-\s()]{6,20}$/)
    .withMessage('Referee phone is not valid'),
  validate,
];

export const bgvCollectionRecordRemoveRules = [
  param('secureToken').trim().isLength({ min: 40, max: 200 }),
  param('recordId').trim().notEmpty().isLength({ max: 64 }),
  validate,
];

export const bgvCollectionUploadRules = [
  param('secureToken').trim().isLength({ min: 40, max: 200 }),
  body('category').trim().notEmpty().withMessage('Evidence category is required').isLength({ max: 40 }),
  body('recordId').optional({ checkFalsy: true }).trim().isLength({ max: 64 }),
  validate,
];

export const bgvCollectionFileRules = [
  param('secureToken').trim().isLength({ min: 40, max: 200 }),
  param('fileId').trim().isMongoId().withMessage('Invalid file reference'),
  validate,
];

export const bgvCollectionSubmitRules = [
  param('secureToken').trim().isLength({ min: 40, max: 200 }),
  validate,
];
