import { body, param, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);

  if (errors.isEmpty()) return next();

  const normalized = errors.array().map((error) => ({
    field: error.path,
    message: error.msg,
  }));

  throw ApiError.badRequest(
    normalized[0]?.message || 'Invalid resume processing request',
    normalized
  );
};

const candidateReferenceRule = param('candidateRef')
  .trim()
  .isLength({ min: 10, max: 30 })
  .withMessage('Invalid candidate reference')
  .custom(
    (value) =>
      /^[a-f\d]{24}$/i.test(value) || /^CAN-\d{6,}$/i.test(value)
  )
  .withMessage('Invalid candidate reference');

const emptyBodyRule = body().custom((value) => {
  if (value && Object.keys(value).length > 0) {
    throw new Error('Resume reprocessing does not accept request fields');
  }

  return true;
});

export const resumeParsedReadRules = [candidateReferenceRule, validate];
export const resumeReprocessRules = [
  candidateReferenceRule,
  emptyBodyRule,
  validate,
];
