// ─────────────────────────────────────────────────────────────────────────────
// Phase 36.1/36.2 — AI request validators.
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
import { body, query, validationResult } from 'express-validator';

import ApiError from '../../utils/ApiError.js';

import {
  AI_CHATBOT_CLIENT_ROLES,
  AI_CONTEXT_CATEGORIES,
  AI_MESSAGE_MAX_CHARS,
  AI_MESSAGE_MAX_COUNT,
  AI_MESSAGE_ROLES,
  AI_MONTHLY_QUOTA_CEILING,
  AI_SUPPORTED_LANGUAGES,
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

// Same rule for a GET: a query string is just as much client input as a body,
// and `?companyId=` on a context preview would be an attempt to read another
// tenant's employees.
const noQueryIdentityOverride = query().custom((_value, { req }) => {
  const payload = req.query || {};

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

// ── Phase 36.2 — per-tenant AI configuration ────────────────────────────────
//
// The three updatable fields are checked individually so a payload mixing a
// valid `enabled` with a nonsense `monthlyQuotaTokens` is refused as a whole
// rather than half-applied. `undefined` means "not supplied" and is skipped;
// `null` is a real value (reset the quota to the env default) and is kept.

const parseQuota = (value) => {
  if (value === null) return null;

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      'monthlyQuotaTokens must be null (use the platform default) or an integer of 0 (unlimited) or more',
    );
  }

  if (value > AI_MONTHLY_QUOTA_CEILING) {
    throw new Error(
      `monthlyQuotaTokens must not exceed ${AI_MONTHLY_QUOTA_CEILING}`,
    );
  }

  return value;
};

const quotaBody = body('monthlyQuotaTokens').custom((value, { req }) => {
  if (value === undefined) return true;

  const parsed = parseQuota(value);

  // Write the coerced value back so the controller never re-parses.
  req.body.monthlyQuotaTokens = parsed;

  return true;
});

const enabledBody = body('enabled')
  .optional()
  .isBoolean()
  .withMessage('enabled must be a boolean');

const categoriesBody = body('allowedCategories')
  .optional()
  .isArray({ min: 1 })
  .withMessage('allowedCategories must be a non-empty array')
  .custom((value) => {
    const unknown = (value || []).filter(
      (entry) => !AI_CONTEXT_CATEGORIES.includes(entry),
    );

    if (unknown.length > 0) {
      throw new Error(
        `allowedCategories may only contain: ${AI_CONTEXT_CATEGORIES.join(', ')}.`,
      );
    }

    if (new Set(value || []).size !== (value || []).length) {
      throw new Error('allowedCategories must not contain duplicates.');
    }

    return true;
  });

// A payload with none of the three fields is a no-op dressed as a change.
const atLeastOneField = body().custom((_value, { req }) => {
  const payload = req.body || {};

  const supplied = ['enabled', 'monthlyQuotaTokens', 'allowedCategories'].filter(
    (field) => Object.prototype.hasOwnProperty.call(payload, field),
  );

  if (supplied.length === 0) {
    throw new Error(
      'Supply at least one of: enabled, monthlyQuotaTokens, allowedCategories.',
    );
  }

  return true;
});

export const updateConfigValidator = [
  noIdentityOverride,
  enabledBody,
  quotaBody,
  categoriesBody,
  atLeastOneField,
  validate,
];

// GET /api/ai/context/preview?categories=profile,leaves
//
// Optional CSV. An absent value means "everything the tenant allows"; an
// empty value is treated the same way rather than as an error, because
// `?categories=` is what a browser sends when a field is left blank.
export const previewContextValidator = [
  noQueryIdentityOverride,

  query('categories')
    .optional({ values: 'falsy' })
    .custom((value) => {
      const list = String(value)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);

      const unknown = list.filter(
        (entry) => !AI_CONTEXT_CATEGORIES.includes(entry),
      );

      if (unknown.length > 0) {
        throw new Error(
          `categories may only contain: ${AI_CONTEXT_CATEGORIES.join(', ')}.`,
        );
      }

      return true;
    }),
  validate,
];

// ── Phase 36.3 — the employee chatbot ──────────────────────────────────────
//
// The system prompt is SERVER-OWNED, so 'system' is refused from a client by
// simply not listing it: a client that could write the system prompt could
// instruct the model to ignore the HR context or to invent data. The cap here
// is the UI's display cap (20); the service caps the payload further, to the
// last 6 turns, which is where the token budget is actually protected.

const chatbotIdentityOverride = body().custom((_value, { req }) => {
  const payload = req.body || {};

  for (const field of ['companyId', 'company', 'userId', 'user', 'feature']) {
    if (payload[field] !== undefined) {
      throw new Error(`${field} must not be supplied by the client`);
    }
  }

  return true;
});

export const chatbotValidator = [
  chatbotIdentityOverride,

  body('messages')
    .isArray({ min: 1, max: 20 })
    .withMessage('messages must be an array of 1 to 20 entries.'),

  body('messages.*.role')
    .isIn([...AI_CHATBOT_CLIENT_ROLES])
    .withMessage(
      `role must be one of: ${AI_CHATBOT_CLIENT_ROLES.join(', ')}. The system prompt is added by the server.`,
    ),

  body('messages.*.content')
    .isString()
    .withMessage('content must be a string.')
    .bail()
    .trim()
    .isLength({ min: 1, max: AI_MESSAGE_MAX_CHARS })
    .withMessage(`content must be 1 to ${AI_MESSAGE_MAX_CHARS} characters.`),

  // Optional narrowing of the tenant's own allowlist. Unknown values are
  // dropped by the retriever rather than refused here, so a typo cannot turn a
  // working chat into an error — but a NON-ARRAY is a client bug and is caught.
  body('categories')
    .optional()
    .isArray()
    .withMessage('categories must be an array.')
    .bail()
    .custom((value) => {
      const unknown = value.filter(
        (entry) => !AI_CONTEXT_CATEGORIES.includes(entry),
      );

      if (unknown.length > 0) {
        throw new Error(
          `categories may only contain: ${AI_CONTEXT_CATEGORIES.join(', ')}.`,
        );
      }

      return true;
    }),

  // Optional reply language (Phase 36.5).
  //
  // OPTIONAL, so an absent key is legal: every 36.3 client that never sent
  // one keeps working untouched, and the service defaults it to English.
  //
  // An UNSUPPORTED value is refused with a 400 rather than silently
  // defaulted. The difference matters: a silent default would make the UI
  // claim the employee is getting Tamil while the model answers in
  // English, which is the kind of quiet lie this codebase refuses. The
  // service still normalizes defensively, but it should never have to.
  //
  // This is a PRESENTATION preference. It is deliberately NOT in
  // chatbotIdentityOverride: that list is the set of fields a client must
  // never supply because they decide AUTHORITY, and language decides
  // nothing about what the caller may read.
  // `{ nullable: true }` because a JSON null is how a client says "no
  // preference", and refusing it would fail a question over cosmetics.
  body('language')
    .optional({ nullable: true })
    .isIn([...AI_SUPPORTED_LANGUAGES])
    .withMessage(
      `language must be one of: ${AI_SUPPORTED_LANGUAGES.join(', ')}.`,
    ),

  validate,
];
