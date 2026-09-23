// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.3 — CHAT CONVERSATION VALIDATORS
//
//  Server-side only. Everything the client sends is untrusted:
//
//    · companyId is NEVER accepted — it comes from req.companyId.
//    · ids are checked with mongoose.isValidObjectId, never trusted raw.
//    · strings are trimmed and length-capped.
//    · member arrays are size-capped so no request can ask for an unbounded
//      fan-out.
//
//  Every exported chain ends in `validate`, which CALLS validationResult —
//  an express-validator chain only collects errors until something reads
//  them, so omitting this half would let malformed input reach the service
//  unchecked (the 29.11 audit found exactly that bug elsewhere).
// ═══════════════════════════════════════════════════════════════════════════

import { body, param, query, validationResult } from 'express-validator';

import mongoose from 'mongoose';

import ApiError from '../../utils/ApiError.js';
import { CHAT_GROUP_MAX_MEMBERS } from '../../services/chat/chatService.js';

const isObjectId = (value) => mongoose.isValidObjectId(String(value || ''));

const validate = (req, _res, next) => {
  const errors = validationResult(req);

  if (errors.isEmpty()) return next();

  const error = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');
  error.errors = errors.array().map((entry) => ({ field: entry.path, message: entry.msg }));

  throw error;
};

const objectIdRule = (field, label) =>
  field.custom(isObjectId).withMessage(`${label} is not a valid identifier.`);

// ── POST /api/chat/conversations ──────────────────────────────────────────

export const createConversationValidator = [
  body('type').isIn(['DIRECT', 'GROUP']).withMessage('type must be DIRECT or GROUP.'),

  // DIRECT only.
  body('targetUserId')
    .if(body('type').equals('DIRECT'))
    .exists()
    .withMessage('targetUserId is required for a direct conversation.')
    .bail()
    .custom(isObjectId)
    .withMessage('targetUserId is not a valid identifier.'),

  // GROUP only.
  body('name')
    .if(body('type').equals('GROUP'))
    .exists()
    .withMessage('name is required for a group conversation.')
    .bail()
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage('name must be between 2 and 80 characters.'),

  body('memberUserIds')
    .if(body('type').equals('GROUP'))
    .exists()
    .withMessage('memberUserIds is required for a group conversation.')
    .bail()
    .isArray({ max: CHAT_GROUP_MAX_MEMBERS - 1 })
    .withMessage(`memberUserIds must be an array of at most ${CHAT_GROUP_MAX_MEMBERS - 1}.`),

  body('memberUserIds.*')
    .if(body('type').equals('GROUP'))
    .custom(isObjectId)
    .withMessage('every memberUserId must be a valid identifier.'),

  validate,
];

// ── GET /api/chat/conversations ───────────────────────────────────────────

export const listConversationsValidator = [
  query('cursor')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .withMessage('cursor must be a string.')
    .isLength({ max: 512 })
    .withMessage('cursor is too long.'),

  query('limit')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1, max: 50 })
    .withMessage('limit must be an integer between 1 and 50.'),

  validate,
];

// ── GET /api/chat/conversations/:conversationId ───────────────────────────

export const conversationIdParamValidator = [
  objectIdRule(param('conversationId'), 'conversationId'),
  validate,
];

// ── POST /api/chat/conversations/:conversationId/members ──────────────────

export const addMembersValidator = [
  objectIdRule(param('conversationId'), 'conversationId'),

  body('memberUserIds')
    .exists()
    .withMessage('memberUserIds is required.')
    .bail()
    .isArray({ min: 1, max: CHAT_GROUP_MAX_MEMBERS })
    .withMessage(`memberUserIds must be an array of 1..${CHAT_GROUP_MAX_MEMBERS}.`),

  body('memberUserIds.*').custom(isObjectId).withMessage('every memberUserId must be a valid identifier.'),

  validate,
];

// ── GET /api/chat/conversations/:conversationId/messages ──────────────────

export const messageHistoryValidator = [
  objectIdRule(param('conversationId'), 'conversationId'),

  query('cursor')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1 })
    .withMessage('cursor must be a positive integer (a message seq).'),

  query('limit')
    .optional({ nullable: true, checkFalsy: true })
    .isInt({ min: 1, max: 50 })
    .withMessage('limit must be an integer between 1 and 50.'),

  validate,
];

// ── DELETE /api/chat/conversations/:conversationId/members/:userId ────────

export const removeMemberValidator = [
  objectIdRule(param('conversationId'), 'conversationId'),
  objectIdRule(param('userId'), 'userId'),
  validate,
];

// ── POST /api/chat/conversations/:conversationId/read (33.7) ──────────────

export const readMarkerValidator = [
  objectIdRule(param('conversationId'), 'conversationId'),

  body('lastReadSeq')
    .exists()
    .withMessage('lastReadSeq is required.')
    .bail()
    .isInt({ min: 0 })
    .withMessage('lastReadSeq must be a whole number of zero or more.'),

  validate,
];
