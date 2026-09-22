// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.12 — SAFE ERROR SERIALIZER (§23)
//
// Errors leak secrets through message/cause/stack/config (Axios config
// objects, Mongoose validation errors, Redis errors). This is THE one
// serialization path for observability logging: bounded, sanitized,
// sensitive-key-redacted, stack retained SERVER-SIDE but sanitized for
// embedded tokens. HTTP responses keep their own existing safe shape —
// this module never touches responses (errorHandler does).
// ─────────────────────────────────────────────────────────────────────────────
import { redactForLog, sanitizeText } from './redaction.js';

const MAX_STACK_LINES = 12;

const boundedStack = (stack) => {
  if (typeof stack !== 'string') return undefined;
  return stack
    .split('\n')
    .slice(0, MAX_STACK_LINES)
    .map((line) => sanitizeText(line, 300))
    .join('\n');
};

/**
 * Serialize any thrown value into a bounded, log-safe record.
 * Useful non-sensitive diagnostics (name/code/status/message) are
 * preserved — the law is redaction, not silence (§85).
 */
export const serializeError = (error) => {
  if (!(error instanceof Error)) {
    return { name: 'NonError', message: sanitizeText(String(error), 300) };
  }

  const base = {
    name: error.name || 'Error',
    message: sanitizeText(error.message, 300),
  };

  if (error.code !== undefined && typeof error.code !== 'object') {
    base.code = sanitizeText(String(error.code), 64);
  }
  if (Number.isFinite(error.statusCode)) base.statusCode = error.statusCode;

  // `cause` chains (Node 16.9+) — bounded to one hop, redacted.
  if (error.cause instanceof Error) {
    base.cause = {
      name: error.cause.name,
      message: sanitizeText(error.cause.message, 200),
    };
  }

  // Everything else on the error (config, keyValue, errors, …) goes
  // through the deep redactor so nested secrets fail closed.
  const extra = redactForLog(
    {
      ...(error.config ? { config: error.config } : {}),
      ...(error.keyValue ? { keyValue: error.keyValue } : {}),
      ...(error.hostname ? { hostname: '[redacted-host]' } : {}),
    },
  );
  if (Object.keys(extra).length > 0) base.details = extra;

  const stack = boundedStack(error.stack);
  if (stack) base.stack = stack;

  return base;
};

export default serializeError;
