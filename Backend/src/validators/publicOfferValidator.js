import { body, param, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  throw ApiError.badRequest('Offer request could not be processed');
};

const token = param('secureToken')
  .isString()
  .isLength({ min: 40, max: 200 })
  .matches(/^[A-Za-z0-9_-]+$/)
  .withMessage('Offer is unavailable');

export const publicOfferReadRules = [token, validate];
export const publicOfferDecisionRules = [
  token,
  body('confirmed').equals('true').withMessage('Explicit confirmation is required'),
  validate,
];
export const publicOfferRejectRules = [
  token,
  body('confirmed').equals('true').withMessage('Explicit confirmation is required'),
  body('category')
    .optional()
    .isIn(['COMPENSATION', 'JOINING_DATE', 'ACCEPTED_ANOTHER_OFFER', 'PERSONAL', 'OTHER', 'NO_REASON'])
    .withMessage('Choose a valid reason category'),
  body('comment').optional().trim().isLength({ max: 1000 }).withMessage('Comment is too long'),
  validate,
];
