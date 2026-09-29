// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 36.1 — AI ERRORS (stable codes, opaque to the client)
//
//  WHY A DEDICATED ERROR TYPE
//    utils/errorHandler DROPS a custom `err.code` (it emits no code field),
//    so an AI failure that must carry a machine-readable code — 429
//    QUOTA_EXCEEDED, 503 AI_UNAVAILABLE — has to be written directly to the
//    response. Rather than repeat that at every call site, AIError carries the
//    code and `sendAIError` is the ONE place that writes it. Same shape as the
//    403 CSWSH precedent in authController.
//
//  THE OPACITY LAW (Phase 36 §5.8)
//    A vendor rate limit, an auth failure, a timeout and a network error all
//    collapse to the SAME generic sentence with the appropriate status. The
//    vendor's own words are classified into a bounded errorType, logged
//    metadata-only, and never reach the browser or the tenant.
// ═══════════════════════════════════════════════════════════════════════════

import ApiError from '../../utils/ApiError.js';

// ── STABLE CODES ───────────────────────────────────────────────────────────
// Frozen: these strings are a contract with the frontend. Adding one is a
// feature; changing or removing one breaks every client that branches on it.
export const AI_ERROR_CODES = Object.freeze({
  // Kill switch (global or per-tenant), or the provider was never
  // initialised. 503: the feature is off, the API is fine.
  UNAVAILABLE: 'AI_UNAVAILABLE',

  // Monthly tenant token allowance exhausted. 429, hard — no soft overage.
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',

  // 32.4 shared limiter refused this identity. 429.
  RATE_LIMITED: 'RATE_LIMITED',

  // The request itself is malformed (validators already cover the REST
  // surface; this guards the service against a bad internal call).
  REQUEST_INVALID: 'AI_REQUEST_INVALID',

  // Deployment misconfiguration: AI_ENABLED=true with no key. Never carries
  // the key, never carries a vendor message.
  CONFIG_INVALID: 'AI_CONFIG_INVALID',

  // Anything the vendor said that is not one of the above. Always 503 and
  // always the same sentence.
  VENDOR_ERROR: 'AI_VENDOR_ERROR',

  // Embeddings are not offered by the current provider (Groq). 501 so a
  // future caller cannot mistake it for a transient failure.
  EMBEDDINGS_UNSUPPORTED: 'AI_EMBEDDINGS_UNSUPPORTED',
});

// ── CLIENT-FACING SENTENCES ────────────────────────────────────────────────
// Generic on purpose. No vendor name, no vendor status, no vendor message.
export const AI_CLIENT_MESSAGES = Object.freeze({
  [AI_ERROR_CODES.UNAVAILABLE]:
    'AI features are temporarily unavailable. Please try again shortly.',

  [AI_ERROR_CODES.QUOTA_EXCEEDED]:
    "Your organisation's monthly AI allowance has been used. Contact your administrator.",

  [AI_ERROR_CODES.RATE_LIMITED]:
    'Too many AI requests. Please wait a moment before trying again.',

  [AI_ERROR_CODES.REQUEST_INVALID]: 'That request could not be processed.',

  [AI_ERROR_CODES.CONFIG_INVALID]:
    'AI is not configured correctly on this server. Contact your administrator.',

  [AI_ERROR_CODES.VENDOR_ERROR]:
    'The AI service could not complete your request. Please try again shortly.',

  [AI_ERROR_CODES.EMBEDDINGS_UNSUPPORTED]:
    'This AI provider does not offer embeddings.',
});

/**
 * An operational AI failure that carries a stable code.
 *
 * Extends ApiError so `next(error)` still produces a correct status/message
 * if a caller forgets to use sendAIError — the code is simply lost, exactly
 * as the shared error pipeline has always behaved. The code is only ever
 * emitted by sendAIError.
 */
export class AIError extends ApiError {
  constructor(statusCode, code, message = AI_CLIENT_MESSAGES[code]) {
    super(statusCode, message);

    this.code = code;
  }

  static unavailable() {
    return new AIError(503, AI_ERROR_CODES.UNAVAILABLE);
  }

  static quotaExceeded() {
    return new AIError(429, AI_ERROR_CODES.QUOTA_EXCEEDED);
  }

  static rateLimited() {
    return new AIError(429, AI_ERROR_CODES.RATE_LIMITED);
  }

  static requestInvalid(message) {
    return new AIError(400, AI_ERROR_CODES.REQUEST_INVALID, message);
  }

  static configInvalid() {
    return new AIError(500, AI_ERROR_CODES.CONFIG_INVALID);
  }

  static vendorError() {
    return new AIError(503, AI_ERROR_CODES.VENDOR_ERROR);
  }

  static embeddingsUnsupported() {
    return new AIError(501, AI_ERROR_CODES.EMBEDDINGS_UNSUPPORTED);
  }
}

/**
 * Write an AIError straight to the response, code included.
 *
 * THE ONE PLACE a code-bearing AI reply is produced (briefing §J pitfall 1:
 * the shared errorHandler drops err.code). The message is always the generic
 * sentence for that code — a vendor message can never ride along, because the
 * only thing AIError carries besides the code is that sentence.
 */
export const sendAIError = (res, error) => {
  const code = error?.code || AI_ERROR_CODES.VENDOR_ERROR;

  const known = Object.prototype.hasOwnProperty.call(AI_CLIENT_MESSAGES, code);

  // An unrecognised code is forced to 503 with the generic vendor sentence.
  // Trusting an arbitrary statusCode here would let an upstream status (a
  // vendor 502, say) reach the browser, which is exactly the opacity the law
  // forbids.
  const statusCode = known ? Number(error?.statusCode) || 503 : 503;

  const message =
    AI_CLIENT_MESSAGES[code] || AI_CLIENT_MESSAGES[AI_ERROR_CODES.VENDOR_ERROR];

  return res.status(statusCode).json({
    statusCode,
    success: false,
    code: known ? code : AI_ERROR_CODES.VENDOR_ERROR,
    message,
  });
};

/**
 * Classify a thrown vendor error into the bounded errorType vocabulary.
 *
 * Metadata only: the returned string is one of AI_ERROR_TYPES and is what an
 * operator may read. The original error is NEVER returned, never logged in
 * full (the caller logs the classification), and never sent to the client.
 */
export const classifyVendorError = (error) => {
  const name = String(error?.name || '');

  const status = Number(error?.status ?? error?.statusCode ?? 0);

  const code = String(error?.code || '');

  if (status === 429) return 'rate_limit';

  if (status === 401 || status === 403) return 'auth';

  if (name.includes('Timeout') || code === 'ETIMEDOUT' || code === 'ABORT_ERR') {
    return 'timeout';
  }

  if (
    name.includes('APIConnection') ||
    ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE'].includes(code)
  ) {
    return 'network';
  }

  return 'vendor';
};
