import { body, param, query, validationResult } from 'express-validator';
import { OFFER_STATUSES } from '../models/OfferLetter.js';
import ApiError from '../utils/ApiError.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const normalized = errors.array().map((error) => ({ field: error.path, message: error.msg }));
  throw ApiError.badRequest(normalized[0]?.message || 'Validation failed', normalized);
};

const offerId = param('offerId').isMongoId().withMessage('Choose a valid offer');
const optionalMoney = (field) =>
  body(field).optional().isFloat({ min: 0, max: 1000000000000 }).withMessage(`${field} must be zero or more`);

const draftFields = ({ optional = false } = {}) => {
  const field = (name) => (optional ? body(name).optional() : body(name));
  return [
    field('templateId').isMongoId().withMessage('Choose a valid offer template'),
    field('terms.designation').trim().isLength({ min: 2, max: 180 }).withMessage('Designation must be 2–180 characters'),
    body('terms.departmentName').optional().trim().isLength({ max: 160 }).withMessage('Department is too long'),
    field('terms.location').trim().isLength({ min: 2, max: 240 }).withMessage('Location must be 2–240 characters'),
    body('terms.employmentType').optional().isIn(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'TEMPORARY']).withMessage('Choose a valid employment type'),
    body('terms.workMode').optional().isIn(['ONSITE', 'REMOTE', 'HYBRID']).withMessage('Choose a valid work mode'),
    body('terms.reportingManagerId').optional({ nullable: true, checkFalsy: true }).isMongoId().withMessage('Choose a valid reporting manager'),
    field('terms.joiningDate').isISO8601().withMessage('Choose a valid joining date'),
    body('terms.offerDate').optional().isISO8601().withMessage('Choose a valid offer date'),
    field('terms.expiryDate').isISO8601().withMessage('Choose a valid expiry date'),
    body('terms.probationMonths').optional().isInt({ min: 0, max: 36 }).withMessage('Probation must be 0–36 months'),
    body('terms.noticePeriodDays').optional().isInt({ min: 0, max: 365 }).withMessage('Notice period must be 0–365 days'),
    body('terms.additionalTerms').optional().isString().isLength({ max: 5000 }).withMessage('Additional terms are too long'),
    field('compensation.currency').trim().isLength({ min: 3, max: 3 }).isAlpha().withMessage('Currency must be a three-letter code'),
    field('compensation.annualCTC').isFloat({ min: 0.01, max: 1000000000000 }).withMessage('Annual CTC must be greater than zero'),
    optionalMoney('compensation.monthly.basic'),
    optionalMoney('compensation.monthly.hra'),
    optionalMoney('compensation.monthly.allowances'),
    optionalMoney('compensation.variablePay'),
    optionalMoney('compensation.bonus'),
  ];
};

export const listOfferRules = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be positive'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be 1–100'),
  query('status').optional().isIn(OFFER_STATUSES).withMessage('Choose a valid offer status'),
  query('candidateId').optional().isMongoId().withMessage('Choose a valid candidate'),
  query('jobId').optional().isMongoId().withMessage('Choose a valid job'),
  query('search').optional().trim().isLength({ max: 100 }).withMessage('Search is too long'),
  validate,
];

export const createOfferRules = [
  body('candidateId').isMongoId().withMessage('Choose a valid candidate'),
  body('replacesOfferId').optional({ nullable: true, checkFalsy: true }).isMongoId().withMessage('Choose a valid predecessor offer'),
  ...draftFields(),
  validate,
];

export const updateOfferRules = [offerId, ...draftFields({ optional: true }), validate];
export const offerActionRules = [offerId, validate];
export const offerReasonRules = [
  offerId,
  body('reason').trim().isLength({ min: 3, max: 1000 }).withMessage('A reason of 3–1,000 characters is required'),
  validate,
];
