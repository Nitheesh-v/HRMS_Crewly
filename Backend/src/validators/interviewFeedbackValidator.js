import { body, param, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';

const ALLOWED_FIELDS = [
  'action',
  'ratings',
  'strengths',
  'concerns',
  'privateNotes',
  'recommendation',
];
const SERVER_CONTROLLED_FIELDS = [
  'companyId',
  'interviewerId',
  'interviewer',
  'candidateId',
  'jobId',
  'templateId',
  'scorecardTemplate',
  'overallScore',
  'maxOverallScore',
  'status',
  'submittedAt',
  'decidedBy',
];

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  const normalized = errors.array().map((error) => ({
    field: error.path,
    message: error.msg,
  }));
  throw ApiError.badRequest(
    normalized[0]?.message || 'Invalid interview feedback request',
    normalized
  );
};

const interviewIdRule = param('id')
  .isMongoId()
  .withMessage('Choose a valid interview');

export const interviewFeedbackReadRules = [interviewIdRule, validate];

export const interviewFeedbackSaveRules = [
  interviewIdRule,
  body().custom((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Feedback must be an object');
    }
    const keys = Object.keys(value);
    const controlled = SERVER_CONTROLLED_FIELDS.find((field) => keys.includes(field));
    if (controlled) {
      throw new Error(`${controlled} is controlled by the server`);
    }
    const unsupported = keys.find((field) => !ALLOWED_FIELDS.includes(field));
    if (unsupported) throw new Error(`Unsupported feedback field: ${unsupported}`);
    return true;
  }),
  body('action')
    .optional()
    .toUpperCase()
    .isIn(['SAVE_DRAFT', 'SUBMIT'])
    .withMessage('Action must be Save Draft or Submit'),
  body('ratings')
    .optional()
    .isArray({ max: 20 })
    .withMessage('Ratings must contain no more than 20 criteria'),
  body('ratings.*').custom((value) => {
    const allowed = ['criterionKey', 'score', 'comment'];
    const unsupported = Object.keys(value || {}).find((field) => !allowed.includes(field));
    if (unsupported) {
      throw new Error(`${unsupported} is not accepted in a criterion rating`);
    }
    return true;
  }),
  body('ratings.*.criterionKey')
    .trim()
    .toUpperCase()
    .matches(/^[A-Z0-9_]{2,80}$/)
    .withMessage('Each rating must identify a valid criterion'),
  body('ratings.*.score')
    .isFloat({ min: 1, max: 100 })
    .withMessage('Each rating score must be between 1 and 100')
    .toFloat(),
  body('ratings.*.comment')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 1500 })
    .withMessage('Criterion comments must be 1500 characters or fewer'),
  body('strengths')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 4000 })
    .withMessage('Strengths must be 4000 characters or fewer'),
  body('concerns')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 4000 })
    .withMessage('Concerns must be 4000 characters or fewer'),
  body('privateNotes')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ max: 5000 })
    .withMessage('Private notes must be 5000 characters or fewer'),
  body('recommendation')
    .optional({ values: 'falsy' })
    .trim()
    .toUpperCase()
    .isIn(['STRONG_HIRE', 'HIRE', 'NEXT_ROUND', 'HOLD', 'NO_HIRE'])
    .withMessage('Choose a valid recommendation'),
  validate,
];
