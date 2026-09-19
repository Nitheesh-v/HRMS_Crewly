// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.12 — REDACTION (central, defense-in-depth, §15/§54)
//
// Observability must never emit raw secrets/PII. Key-name redaction alone
// cannot catch a token embedded in a URL or error string, so the law is
// layered:
//   1. log allowlisted metadata (callers pass bounded, safe fields)
//   2. redact known sensitive KEY names (redactForLog)
//   3. normalize tokenized routes / strip query strings (redactRequestUrl)
//   4. safe error serialization (safeErrorSerializer.js)
//
// NOTHING in this module reads env, DB, or network — pure functions only.
// ─────────────────────────────────────────────────────────────────────────────

// Key-NAME patterns whose VALUES must never reach a log. Broad on
// purpose: an unknown "clientSecret"-shaped field must fail closed.
export const SENSITIVE_KEY_PATTERN =
  /(pass(word|wd)?|secret|token|authorization|bearer|cookie|session|credential|apikey|api_?key|access_?key|pin|otp|cvv|card|ssn|pan|uan|aadhaar|iban|account_?(number|no)|bank|salary|wage|refresh|jwt|fingerprint|\blat\b|\blng\b|latitude|longitude|\bgps\b|coords?|location)/i;

export const REDACTED = '[REDACTED]';

// Bounded output law: redaction must never itself become the DoS.
const MAX_DEPTH = 4;
const MAX_KEYS = 50;
const MAX_STRING = 512;

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const boundString = (value) => sanitizeText(value, MAX_STRING);

/**
 * Free-text sanitizer for messages that may embed user/controller data:
 * control characters neutralized, length bounded, and embedded bearer
 * tokens / long raw JWT-looking strings redacted even mid-string.
 */
export const sanitizeText = (value, maxLength = 300) => {
  let text = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '[REDACTED_JWT]') // raw JWT segment
    // Connection strings with credentials (§15: MONGO_URI/REDIS_URL/SMTP
    // can ride error messages — redact the WHOLE URI, scheme included).
    .replace(/\b(?:mongodb(?:\+srv)?|redis|rediss|postgres(?:ql)?|mysql|amqp|smtp):\/\/[^\s'"]+/gi, '[REDACTED_URI]')
    // Secure-token path segments (§17): candidate/BGV/verifier/reset
    // tokens embedded in URLs inside error strings.
    .replace(/\/(?:offers|pre-onboarding|bgv-consent|bgv-collection|setup|reset)\/([A-Za-z0-9_-]{12,})/gi,
      (match, token) => match.replace(token, '[REDACTED]'));
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}…`;
  return text;
};

/**
 * Deep, bounded redaction of an arbitrary value for logging.
 * - sensitive key names → value replaced by [REDACTED]
 * - strings are control-stripped and length-bounded
 * - depth/key-count bounded; cycles safe; functions → '[fn]'
 */
export const redactForLog = (value, depth = 0, seen = new WeakSet()) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return boundString(value);
  if (typeof value === 'function') return '[fn]';
  if (depth >= MAX_DEPTH) return '[depth-limit]';

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[cycle]';
    seen.add(value);
    return value.slice(0, MAX_KEYS).map((entry) => redactForLog(entry, depth + 1, seen));
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) return '[cycle]';
    seen.add(value);
    const out = {};
    for (const [key, entry] of Object.entries(value).slice(0, MAX_KEYS)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactForLog(entry, depth + 1, seen);
    }
    return out;
  }

  return '[unloggable]';
};


// ── Tokenized route normalization (§17/§84) ────────────────────────────────
// Secure-token path segments are replaced by [REDACTED] so access/error
// logs can never carry live candidate/BGV/verifier/pre-onboarding tokens.
// Families mirror routes/index.js mounts; the generic tail catches any
// long high-entropy segment on PUBLIC route families (never touches
// ordinary ids like /api/users/64-char Mongo ObjectIds? — ObjectIds are
// 24 hex chars and still redacted on public families only; internal
// authenticated routes keep their path shape for diagnosability).

const TOKEN_ROUTE_PATTERNS = [
  /\/api\/public\/candidate\/offers\/[^/?#]+/gi,
  /\/api\/public\/candidate\/pre-onboarding\/[^/?#]+/gi,
  /\/api\/public\/candidate\/bgv-consent\/[^/?#]+/gi,
  /\/api\/public\/candidate\/bgv-collection\/[^/?#]+/gi,
  /\/api\/bgv-verifier\/auth\/setup\/[^/?#]+/gi,
];

/**
 * Normalize a raw URL for logging: strip the query string entirely
 * (§12 — queries carry search text/PII/tokens) and redact secure-token
 * path segments on the known public families.
 */
export const redactRequestUrl = (value = '') => {
  const withoutQuery = String(value).split('?')[0].slice(0, MAX_STRING);
  let out = withoutQuery;
  for (const pattern of TOKEN_ROUTE_PATTERNS) {
    out = out.replace(pattern, (match) => `${match.replace(/[^/?#]+$/, REDACTED)}`);
  }
  return out;
};

/**
 * Normalized ROUTE TEMPLATE for bounded-cardinality labels (§47/§61):
 * prefer Express's own route knowledge (`req.baseUrl + req.route.path`,
 * e.g. `/api/users/:id`); fall back to the redacted URL for unmatched
 * (404) requests. Never includes the query string.
 */
export const routeTemplateOf = (req = {}) => {
  const baseUrl = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  const routePath = typeof req.route?.path === 'string' ? req.route.path : '';
  if (routePath) return `${baseUrl}${routePath}`.slice(0, MAX_STRING) || 'unmatched';
  return redactRequestUrl(req.originalUrl || req.url || '') || 'unmatched';
};
