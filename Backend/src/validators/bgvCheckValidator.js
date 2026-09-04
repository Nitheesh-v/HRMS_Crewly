// ============================================================
//  PHASE 30.1 — BGV CHECK FRAMEWORK validators
// ============================================================

import { body, param, query, validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';
import {
  AGING_BUCKETS,
  BGV_CHECK_STATUSES,
  BGV_CHECK_TYPES,
  BGV_EVIDENCE_KINDS,
} from '../services/bgv/bgvCheckRules.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed'));
  }
  return next();
};

// Statuses a client may request as a target. PENDING is not a
// valid target (nothing moves backwards to "not started"), and
// terminal reopen goes through /reopen, not /status.
const STATUS_TARGETS = BGV_CHECK_STATUSES.filter((status) => status !== 'PENDING');

export const bgvCheckListRules = [
  query('checkType').optional({ checkFalsy: true }).isIn(BGV_CHECK_TYPES),
  query('status')
    .optional({ checkFalsy: true })
    .bail()
    .custom((value) =>
      (Array.isArray(value) ? value : String(value).split(',')).every((item) =>
        BGV_CHECK_STATUSES.includes(String(item).trim().toUpperCase())
      )
    )
    .withMessage('Choose valid BGV check statuses'),
  query('assignedVerifierId').optional({ checkFalsy: true }).isMongoId(),
  query('caseId').optional({ checkFalsy: true }).isMongoId(),
  query('candidateId').optional({ checkFalsy: true }).isMongoId(),
  query('agingBucket').optional({ checkFalsy: true }).isIn(AGING_BUCKETS),
  query('search').optional({ checkFalsy: true }).isLength({ max: 80 }),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 100 }),
  validate,
];

export const bgvCheckIdRules = [param('checkId').isMongoId().withMessage('Choose a valid BGV check'), validate];

export const bgvCheckAssignRules = [
  param('checkId').isMongoId(),
  body('verifierId').isMongoId().withMessage('Choose a valid verifier'),
  validate,
];

export const bgvCheckStatusRules = [
  param('checkId').isMongoId(),
  body('toStatus').trim().notEmpty().isIn(STATUS_TARGETS).withMessage('Choose a valid target status'),
  body('entryKey').optional({ checkFalsy: true }).isString().isLength({ max: 40 }),
  body('resultSummary').optional({ nullable: true }).isLength({ max: 2000 }),
  body('discrepancyNote').optional({ nullable: true }).isLength({ max: 2000 }),
  body('followUp').optional().isObject(),
  body('followUp.closedReason').optional({ checkFalsy: true }).isLength({ max: 200 }),
  body('reason').optional({ checkFalsy: true }).isLength({ max: 500 }),
  validate,
];

export const bgvEvidenceRules = [
  param('checkId').isMongoId(),
  body('kind').trim().notEmpty().isIn(BGV_EVIDENCE_KINDS).withMessage('Choose a valid evidence kind'),
  body('entryKey').optional({ checkFalsy: true }).isString().isLength({ max: 40 }),
  body('note').optional({ nullable: true }).isLength({ max: 2000 }),
  validate,
];

export const bgvExtendSlaRules = [
  param('checkId').isMongoId(),
  body('days').isInt({ min: 1, max: 30 }).withMessage('Extension must be between 1 and 30 days'),
  body('reason').trim().notEmpty().withMessage('An extension reason is required').isLength({ max: 500 }),
  validate,
];

export const bgvReopenRules = [
  param('checkId').isMongoId(),
  body('reason').trim().notEmpty().withMessage('A written reopen reason is required').isLength({ max: 500 }),
  validate,
];

export const bgvSeedRules = [param('caseId').isMongoId().withMessage('Choose a valid BGV case'), validate];
