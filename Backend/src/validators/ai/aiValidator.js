// ─────────────────────────────────────────────────────────────────────────────
// Phase 36.1 — AI chat request validators.
//
// STRUCTURAL checks only: shape, roles, sizes, and the refusal of any
// client-supplied identity. The guards that actually protect the vendor
// (kill switch, rate limit, quota, redaction) live in the service, because a
// validator that "checked" them would be a second, weaker copy of the law.
//
// Every exported chain ends in `validate`, which CALLS validationResult — an
// express-validator chain only collects errors until something reads them, so
// omitting that half would let malformed input reach the service unchecked.
// ─────────────────────────────────────────────────────────────────────────────
import { body, validationResult } from 'express-validator';

import ApiError from '../../utils/ApiError.js';

import {
  AI_MESSAGE_MAX_CHARS,
  AI_MESSAGE_MAX_COUNT,
  AI_MESSAGE_ROLES,
} from '../../services/ai/aiConfig.js';

const validate = (req, _res, next) => {
  const errors = validationResult(req);

  if (errors.isEmpty()) return next();

  const error = ApiError.badRequest(errors.array()[0]?.msg || 'Validation failed');

  error.errors = errors.array().map((entry) => ({
    field: entry.path,
    message: entry.msg,
  }));

  throw error;
};

// Identity comes ONLY from req.user / req.companyId after protect +
// tenantContext. A client that tries to name its own tenant, user or feature
// is refused outright — the same rule the attendance capture validators use.
const noIdentityOverride = body().custom((_value, { req }) => {
  const payload = req.body || {};

  for (const field of ['companyId', 'company', 'userId', 'user', 'feature']) {
    if (payload[field] !== undefined) {
      throw new Error(`${field} must not be supplied by the client`);
    }
  }

  return true;
});

export const aiChatValidator = [
  noIdentityOverride,

  body('messages')
    .isArray({ min: 1, max: AI_MESSAGE_MAX_COUNT })
    .withMessage(`messages must be an array of 1 to ${AI_MESSAGE_MAX_COUNT} entries.`),

  body('messages.*.role')
    .isIn(AI_MESSAGE_ROLES)
    .withMessage(`role must be one of: ${AI_MESSAGE_ROLES.join(', ')}.`),

  body('messages.*.content')
    .isString()
    .withMessage('content must be a string.')
    .bail()
    .trim()
    .isLength({ min: 1, max: AI_MESSAGE_MAX_CHARS })
    .withMessage(`content must be 1 to ${AI_MESSAGE_MAX_CHARS} characters.`),

  validate,
];
