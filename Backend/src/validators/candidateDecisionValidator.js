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
    normalized[0]?.message || 'Invalid candidate decision request',
    normalized
  );
};

const candidateIdRule = param('candidateId')
  .isMongoId()
  .withMessage('Choose a valid candidate');
const rejectServerIdentity = body().custom((value) => {
  const keys = Object.keys(value || {});
  const controlled = [
    'companyId',
    'decidedBy',
    'actorId',
    'candidateId',
    'currentStage',
    'pipelineHistoryId',
    'status',
  ].find((field) => keys.includes(field));
  if (controlled) throw new Error(`${controlled} is controlled by the server`);
  return true;
});

export const finalReviewRules = [
  candidateIdRule,
  rejectServerIdentity,
  body().custom((value) => {
    const unsupported = Object.keys(value || {}).find((field) => field !== 'comment');
    if (unsupported) throw new Error(`Unsupported Final Review field: ${unsupported}`);
    return true;
  }),
  body('comment')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Final Review comment must be 1000 characters or fewer'),
  validate,
];

export const finalDecisionRules = [
  candidateIdRule,
  rejectServerIdentity,
  body().custom((value) => {
    const allowed = ['decision', 'reasonCategory', 'comment'];
    const unsupported = Object.keys(value || {}).find((field) => !allowed.includes(field));
    if (unsupported) throw new Error(`Unsupported final-decision field: ${unsupported}`);
    return true;
  }),
  body('decision')
    .trim()
    .toUpperCase()
    .isIn(['SELECTED', 'REJECTED', 'HOLD'])
    .withMessage('Choose Selected, Rejected, or Hold'),
  body('reasonCategory')
    .trim()
    .toUpperCase()
    .matches(/^[A-Z0-9_]{2,80}$/)
    .withMessage('Choose a valid reason category'),
  body('comment')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 2000 })
    .withMessage('Decision comment must be 2000 characters or fewer'),
  validate,
];
