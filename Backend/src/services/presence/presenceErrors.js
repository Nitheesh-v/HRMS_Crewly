// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.1 — PRESENCE ERROR CODES
//
//  WHY A NEW ERROR FILE
//    Phase 36 uses codes like AI_VENDOR_ERROR / AI_REQUEST_INVALID /
//    AI_CONFIG_READ_FAILED (services/ai/aiErrors.js). Phase 37 must NOT
//    reuse those (capsule §30, Phase 37.1 §30) — a vendor failure is not
//    a presence policy failure, and a 400 from the chatbot is not the
//    same 400 as a 37 refusal. The error architecture is the same
//    (ApiError + presence code + human message), the namespace is fresh.
//
//  SHAPE
//      throw PresenceError.badRequest('WFH_DISABLED', 'WFH is disabled
//      for your company.');
//
//    The handler in middlewares/errorHandler.js does NOT carry a `code`
//    field by default (it strips it for security — see the 36.6 capsule
//    pitfall §4.2). The presence routes attach the code explicitly via
//    res.status(...).json({success:false, code, message, ...}) so a
//    frontend can branch on it without scraping prose.
// ═══════════════════════════════════════════════════════════════════════════

import ApiError from '../../utils/ApiError.js';

export const PRESENCE_ERROR_CODES = Object.freeze({
  // 400 — request was structurally OK but the value isn't allowed.
  INVALID_PRESENCE_VALUE: 'INVALID_PRESENCE_VALUE',
  INVALID_WORK_LOCATION: 'INVALID_WORK_LOCATION',
  INVALID_WFH_MODE: 'INVALID_WFH_MODE',
  INVALID_TIMEOUT_RELATIONSHIP: 'INVALID_TIMEOUT_RELATIONSHIP',
  INVALID_ALLOWED_WORK_LOCATIONS: 'INVALID_ALLOWED_WORK_LOCATIONS',
  STATUS_MESSAGE_TOO_LONG: 'STATUS_MESSAGE_TOO_LONG',
  STATUS_MESSAGE_EMPTY_AFTER_TRIM: 'STATUS_MESSAGE_EMPTY_AFTER_TRIM',
  EXPIRY_IN_PAST: 'EXPIRY_IN_PAST',
  EXPIRY_TOO_FAR: 'EXPIRY_TOO_FAR',

  // 403 — feature or option disabled for this tenant.
  PRESENCE_DISABLED: 'PRESENCE_DISABLED',
  STATUS_MESSAGES_DISABLED: 'STATUS_MESSAGES_DISABLED',
  WORK_LOCATION_DISABLED: 'WORK_LOCATION_DISABLED',
  WFH_DISABLED: 'WFH_DISABLED',

  // 409 — needs an out-of-band action the API cannot do yet.
  WFH_APPROVAL_REQUIRED: 'WFH_APPROVAL_REQUIRED',

  // 503 — config cannot be read; never bypass.
  PRESENCE_TENANT_CONFIG_READ_FAILED: 'PRESENCE_TENANT_CONFIG_READ_FAILED',
});

// Small helper that keeps the throw site short and the message list
// stable. Mirrors aiErrors.js / ApiError.js, with a Phase-37-only code.
export class PresenceError extends ApiError {
  constructor(statusCode, code, message) {
    super(statusCode, message);
    this.presenceCode = code;
  }

  static badRequest(code, message) {
    return new PresenceError(400, code, message);
  }

  static forbidden(code, message) {
    return new PresenceError(403, code, message);
  }

  static conflict(code, message) {
    return new PresenceError(409, code, message);
  }

  static unavailable(code, message) {
    return new PresenceError(503, code, message);
  }
}

// The exact wire shape used by the presence routes when a PresenceError
// reaches the response. Other failures fall through the shared error
// handler (success:false, message, no code) — only PresenceError carries
// the deterministic code a widget needs to render policy copy.
export const sendPresenceError = (res, err) =>
  res.status(err.statusCode || 400).json({
    success: false,
    code: err.presenceCode || 'PRESENCE_ERROR',
    message: err.message,
    ...(Array.isArray(err.errors) && err.errors.length > 0
      ? { errors: err.errors }
      : {}),
  });