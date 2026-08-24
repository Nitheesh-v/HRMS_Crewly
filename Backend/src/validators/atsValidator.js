import { param, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);

  if (errors.isEmpty()) return next();

  const normalized = errors.array().map((error) => ({
    field: error.path,
    message: error.msg,
  }));

  throw ApiError.badRequest(
    normalized[0]?.message || 'Invalid ATS request',
    normalized
  );
};

const candidateIdRule = param('candidateId')
  .trim()
  .isLength({ min: 10, max: 30 })
  .withMessage('Invalid candidate reference')
  .custom(
    (value) =>
      /^[a-f\d]{24}$/i.test(value) || /^CAN-\d{6,}$/i.test(value)
  )
  .withMessage('Invalid candidate reference');

export const atsResultReadRules = [candidateIdRule, validate];
export const atsReprocessRules = [candidateIdRule, validate];
