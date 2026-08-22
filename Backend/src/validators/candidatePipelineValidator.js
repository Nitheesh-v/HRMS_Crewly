import { body, validationResult } from 'express-validator';
import { PIPELINE_STAGES } from '../models/CandidatePipelineHistory.js';
import ApiError from '../utils/ApiError.js';

export const BULK_PIPELINE_ACTIONS = [
  'SHORTLIST',
  'REJECT',
  'HOLD',
  'MOVE_STAGE',
  'ASSIGN_RECRUITER',
  'ASSIGN_HIRING_MANAGER',
  'SEND_EMAIL',
];

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();

  const normalized = errors.array().map((error) => ({
    field: error.path,
    message: error.msg,
  }));

  throw ApiError.badRequest(
    normalized[0]?.message || 'Invalid candidate pipeline request',
    normalized
  );
};

const reasonRule = body('reason')
  .optional({ values: 'falsy' })
  .trim()
  .isLength({ max: 1000 })
  .withMessage('Reason must be 1000 characters or fewer');

export const pipelineStageRules = [
  body('stage')
    .isIn(PIPELINE_STAGES)
    .withMessage('Choose a valid pipeline stage'),
  reasonRule,
  validate,
];

export const bulkPipelineRules = [
  body('candidateIds')
    .isArray({ min: 1, max: 100 })
    .withMessage('Select between 1 and 100 candidates')
    .custom((values) => {
      const normalized = values.map(String);
      if (new Set(normalized).size !== normalized.length) {
        throw new Error('Candidate selection cannot contain duplicates');
      }
      return true;
    }),
  body('candidateIds.*')
    .isMongoId()
    .withMessage('Candidate selection contains an invalid reference'),
  body('action')
    .isIn(BULK_PIPELINE_ACTIONS)
    .withMessage('Choose a valid bulk action'),
  body('targetStage')
    .optional({ values: 'falsy' })
    .isIn(PIPELINE_STAGES)
    .withMessage('Choose a valid target stage'),
  body('userId')
    .optional({ values: 'falsy' })
    .isMongoId()
    .withMessage('Choose a valid assignee'),
  reasonRule,
  body().custom((value) => {
    if (value.action === 'MOVE_STAGE' && !value.targetStage) {
      throw new Error('Target stage is required for bulk stage movement');
    }

    if (
      ['ASSIGN_RECRUITER', 'ASSIGN_HIRING_MANAGER'].includes(value.action) &&
      !value.userId
    ) {
      throw new Error('An assignee is required for this bulk action');
    }

    if (
      (
        ['REJECT', 'HOLD'].includes(value.action) ||
        (
          value.action === 'MOVE_STAGE' &&
          ['REJECTED', 'HOLD', 'WITHDRAWN'].includes(value.targetStage)
        )
      ) &&
      !String(value.reason || '').trim()
    ) {
      throw new Error('A reason is required for this bulk action');
    }

    return true;
  }),
  validate,
];
