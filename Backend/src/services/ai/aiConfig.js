// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 36.1 — AI SUITE CONFIGURATION (pure parsers, zero side effects)
//
//  WHY A SEPARATE MODULE
//    Every AI guardrail in this phase is a PURE function of the environment:
//    enablement, the redaction override, the token bounds, the quota. Keeping
//    them here means the server, the config:check CLI and the hermetic tests
//    all resolve the SAME values from the SAME source, and nothing in this
//    file can open a socket, touch Mongo or import the vendor SDK.
//
//  SECRET LAW (32.15 §95)
//    `getAIConfig` carries AI_API_KEY because the provider needs it. It is
//    NEVER logged, never serialised into a response, and never placed in a
//    job payload. `describeAIConfig` is the ONLY shape that may be printed or
//    asserted, and it carries `hasApiKey` instead of the value — pinned by
//    test/aiProviderFoundation.test.js.
//
//  IMPORT DIRECTION
//    config/env.js imports THIS module (one direction only) so the production
//    validator can reuse these parsers. This module imports nothing from
//    src/config — no cycle is possible.
// ═══════════════════════════════════════════════════════════════════════════

// ── VENDOR DEFAULTS ────────────────────────────────────────────────────────
// Groq today (OpenAI-compatible, free tier). The swap to OpenAI/Anthropic is
// AI_BASE_URL + AI_API_KEY and NOTHING else — no code change, by design.
export const AI_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

/*
 * 36.3-fix — THE MODEL DEFAULT WAS DEAD.
 *
 * The original default was llama-3.3-70b-versatile. Groq decommissioned that
 * model on the free/developer tier on 2026-08-16 (see
 * console.groq.com/docs/deprecations), so every call now fails with a 404
 * "the model does not exist or you do not have access to it" — which the
 * opaque-error law turns into one generic 503 AI_VENDOR_ERROR. Nothing is
 * wrong with the key, the network or the code; the model string is simply
 * gone.
 *
 * openai/gpt-oss-120b is Groq's own recommended replacement. A vendor retiring
 * a model is not a one-off, so this default is treated as ROT and pinned by a
 * test — if it ever stops working again, the suite says so rather than every
 * tenant discovering it as an unexplained 503.
 */
export const AI_DEFAULT_MODEL = 'openai/gpt-oss-120b';

export const AI_DEFAULT_MAX_TOKENS = 1024;

export const AI_DEFAULT_MONTHLY_QUOTA_TOKENS = 1_000_000;

export const AI_DEFAULT_TEMPERATURE = 0.3;

export const AI_DEFAULT_TIMEOUT_MS = 30_000;

// ── CODE-OWNED BOUNDS (not operator tuning) ────────────────────────────────
// A generous ceiling so a fat-fingered deployment cannot ask the vendor for a
// 100k-token completion on every request.
export const AI_MAX_TOKENS_CEILING = 4096;

export const AI_MONTHLY_QUOTA_CEILING = 100_000_000;

export const AI_TIMEOUT_CEILING_MS = 120_000;

// 36.1 request shape. A chatbot turn is a short conversation, not a document
// upload: 10 messages x 2000 characters is already far more than a person
// types, and the bound is what keeps a single request from becoming a
// quota-draining prompt-injection surface.
export const AI_MESSAGE_MAX_COUNT = 10;

export const AI_MESSAGE_MAX_CHARS = 2000;

// The ONLY roles accepted. 'tool'/'function' are deliberately absent — this
// foundation has no tool calling (Phase 36 §5.10), so accepting those roles
// would be a lie the client could exploit.
export const AI_MESSAGE_ROLES = Object.freeze(['system', 'user', 'assistant']);

// 32.4 reuse: ONE shared Redis tier, identity = companyId + userId, both
// SERVER-DERIVED. A client can never choose its own bucket.
export const AI_RATE_LIMIT = Object.freeze({
  sharedName: 'ai',
  windowMs: 60_000,
  maximum: 20,
});

// Phase 36.2 — the context-retrieval preview endpoint is a DEBUG surface: it
// returns a whole HR context string, which makes it a data-dump tool if it is
// not throttled harder than the chat itself. A separate 32.4 store keeps the
// two budgets independent — burning the chat budget must not lock a person
// out of previewing their own context, and vice versa.
export const AI_PREVIEW_RATE_LIMIT = Object.freeze({
  sharedName: 'ai-context-preview',
  windowMs: 60_000,
  maximum: 10,
});

// Phase 36.2 — per-tenant AI config caching. Short TTL on purpose (Phase 36
// §1.7): a disable flipped by an admin must take effect quickly, and a stale
// 10 minutes of "enabled" is the acceptable cost of not hitting Mongo on
// every AI request.
export const AI_TENANT_CONFIG_CACHE = Object.freeze({
  namespace: 'ai-config',
  version: 1,
  ttlSeconds: 600,
});

// ── STABLE VOCABULARIES ────────────────────────────────────────────────────
// Usage-log status. QUOTA_EXCEEDED is a REFUSAL, not a vendor error: the call
// never reached the model, so its token counts are zero by construction.
export const AI_USAGE_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
});

// Bounded error-type vocabulary. NEVER a vendor message: these strings are
// what an operator may read in the admin dashboard, and nothing else about a
// failure is persisted (Phase 36 §5.3 / §5.11).
export const AI_ERROR_TYPES = Object.freeze([
  'none',
  'config',
  'quota',
  'rate_limit',
  'timeout',
  'auth',
  'network',
  'vendor',
]);

// Feature labels. Closed on purpose: a usage row with an unknown feature is
// a coding error, not something to accept from a request body.
//
// Phase 36.3 adds 'chatbot' so an employee-facing turn is distinguishable in
// AIUsageLog from a raw /chat verification call. Additive: 'hr.chat' keeps its
// meaning and every 36.1 assertion still holds.
export const AI_FEATURES = Object.freeze(['hr.chat', 'chatbot']);

export const AI_FEATURE_HR_CHAT = 'hr.chat';

export const AI_FEATURE_CHATBOT = 'chatbot';

// Phase 36.3 — how much conversation history reaches the vendor.
//
// The system prompt carries the whole HR context, which is already several
// hundred tokens before the person types anything. Sending ten more turns on
// top of that would spend the budget on history the model rarely needs, so
// the cap is deliberately tighter than the UI's 20-message display cap: the
// person can scroll back further than the model can remember, and that is the
// honest trade (a chatbot that silently forgot turn 3 is worse than one that
// never claimed to remember it).
export const AI_CHATBOT_HISTORY_LIMIT = 6;

// The two roles a CLIENT may send. 'system' is refused at the validator: the
// system prompt is server-owned, and a client that could write it could
// instruct the model to ignore the HR context.
export const AI_CHATBOT_CLIENT_ROLES = Object.freeze(['user', 'assistant']);

// Phase 36.3 — the chatbot gets its own 32.4 tier. A separate store keeps the
// budgets independent: exhausting the raw /chat allowance must not lock a
// person out of the employee assistant, and vice versa.
export const AI_CHATBOT_RATE_LIMIT = Object.freeze({
  sharedName: 'ai-chatbot',
  windowMs: 60_000,
  maximum: 20,
});

// Phase 36.2 — HR context categories the retriever can assemble. This is the
// SINGLE source of truth: the AITenantConfig enum, the request validator and
// the retriever all read it, so a category cannot exist in one and not the
// others.
//
// Deliberately absent (Phase 36 §10): 'payroll' and 'performance'. Reading a
// payslip runs the payslipScope authorisation chain and reading an appraisal
// runs the appraisal access chain; a config flag must never be able to switch
// either on.
export const AI_CONTEXT_CATEGORIES = Object.freeze([
  'profile',
  'leaves',
  'attendance',
  'policies',
]);

// Phase 36.2 — how far ahead the policies section looks, and how much of each
// list it returns. Bounded on purpose: an unbounded holiday or announcement
// list would turn one context string into a document, and the prompt budget
// (AI_MAX_TOKENS) is shared with the answer.
export const AI_POLICY_LOOKAHEAD_DAYS = 30;

export const AI_POLICY_HOLIDAY_LIMIT = 10;

export const AI_POLICY_ANNOUNCEMENT_LIMIT = 5;

// Rolling window for "this week" worked hours. Seven calendar days back from
// today, inclusive — a working week, not a payroll week.
export const AI_WEEK_HOURS_DAYS = 7;

// ── STRICT PARSERS ─────────────────────────────────────────────────────────
// The Phase 28.1 law, applied to AI: NEVER `Boolean(env)`. An explicit
// truthy set, everything else false, so `AI_ENABLED=yes` can never silently
// turn the suite on.
const TRUTHY = new Set(['true', '1', 'yes', 'on']);

const FALSY = new Set(['false', '0', 'no', 'off']);

export const parseAiEnabled = (source = process.env) =>
  TRUTHY.has(String(source?.AI_ENABLED ?? '').trim().toLowerCase());

/**
 * PII redaction is ON unless the deployer explicitly turns it off, and an
 * unrecognised value is treated as ON (fail closed — never the other way).
 */
export const parseAiPiiRedaction = (source = process.env) => {
  const raw = String(source?.AI_PII_REDACTION ?? '').trim().toLowerCase();

  if (raw === '') return true; // default

  if (FALSY.has(raw)) return false;

  return true; // unknown value → redact
};

/**
 * The override is honoured ONLY outside production. Development and test may
 * turn redaction off to debug a prompt; production may not, ever.
 */
export const isRedactionOverridePermitted = (nodeEnv) => {
  const normalized = String(nodeEnv ?? '').trim().toLowerCase();

  return normalized === 'development' || normalized === 'test';
};

/**
 * The EFFECTIVE answer, fail-closed: even if someone boots production with
 * AI_PII_REDACTION=false, redaction still runs. The startup validator refuses
 * that configuration outright (see validateProductionConfig), so this is the
 * second line, not the first.
 */
export const isRedactionEnforced = (source = process.env) => {
  if (parseAiPiiRedaction(source)) return true;

  // The flag says "off", but the override is only honoured outside
  // production — so in production redaction is forced back ON.
  return !isRedactionOverridePermitted(source?.NODE_ENV);
};

const clampInt = (raw, { fallback, min, max }) => {
  const parsed = Number(raw);

  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

const clampFloat = (raw, { fallback, min, max }) => {
  const parsed = Number(raw);

  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(max, Math.max(min, parsed));
};

// ── RESOLVED CONFIG ────────────────────────────────────────────────────────
/**
 * Resolve the AI configuration from an environment source. Read at CALL time
 * (not snapshotted) so the config:check CLI, the server and an injected test
 * source all see one truth.
 *
 * `apiKey` is present because the provider needs it. Nothing in this codebase
 * may log, return or serialise it — use describeAIConfig for anything that
 * leaves the process.
 */
export const getAIConfig = (source = process.env) => ({
  enabled: parseAiEnabled(source),

  baseUrl: String(source?.AI_BASE_URL || '').trim() || AI_DEFAULT_BASE_URL,

  model: String(source?.AI_MODEL || '').trim() || AI_DEFAULT_MODEL,

  apiKey: String(source?.AI_API_KEY ?? '').trim(),

  hasApiKey: String(source?.AI_API_KEY ?? '').trim().length > 0,

  maxTokens: clampInt(source?.AI_MAX_TOKENS, {
    fallback: AI_DEFAULT_MAX_TOKENS,
    min: 1,
    max: AI_MAX_TOKENS_CEILING,
  }),

  temperature: clampFloat(source?.AI_TEMPERATURE, {
    fallback: AI_DEFAULT_TEMPERATURE,
    min: 0,
    max: 1,
  }),

  timeoutMs: clampInt(source?.AI_TIMEOUT_MS, {
    fallback: AI_DEFAULT_TIMEOUT_MS,
    min: 1000,
    max: AI_TIMEOUT_CEILING_MS,
  }),

  // 0 or negative = unlimited (documented: a tenant with no configured
  // allowance must not be locked out by a zero that nobody meant).
  monthlyQuotaTokens: clampInt(source?.AI_MONTHLY_QUOTA_TOKENS, {
    fallback: AI_DEFAULT_MONTHLY_QUOTA_TOKENS,
    min: 0,
    max: AI_MONTHLY_QUOTA_CEILING,
  }),

  piiRedaction: parseAiPiiRedaction(source),

  redactionEnforced: isRedactionEnforced(source),
});

/**
 * Secret-free projection. The ONLY shape that may be printed by config:check,
 * logged, or asserted in a test. Carries `hasApiKey`, never the key.
 */
export const describeAIConfig = (source = process.env) => {
  const config = getAIConfig(source);

  return {
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    model: config.model,
    hasApiKey: config.hasApiKey,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    monthlyQuotaTokens: config.monthlyQuotaTokens,
    piiRedaction: config.piiRedaction,
    redactionEnforced: config.redactionEnforced,
  };
};

/**
 * Pure AI configuration validation. Called by validateProductionConfig so the
 * production fail-fast and the config:check CLI share ONE law. Errors NAME the
 * variable and give a safe reason — never a value (32.15 §95).
 */
export const validateAIConfig = (source = process.env) => {
  const errors = [];
  const config = getAIConfig(source);

  if (config.enabled && !config.hasApiKey) {
    errors.push(
      'AI_API_KEY: required when AI_ENABLED=true (the AI provider cannot authenticate)',
    );
  }

  // Fail-closed redaction override. Honoured in development/test only; in
  // production it is a misconfiguration AND a privacy regression, so startup
  // refuses it outright. The runtime enforces redaction regardless
  // (isRedactionEnforced), so this is defence in depth, not the only guard.
  if (config.piiRedaction === false && !isRedactionOverridePermitted(source?.NODE_ENV)) {
    errors.push(
      'AI_PII_REDACTION: cannot be disabled in production (redaction is mandatory before any text leaves the server)',
    );
  }

  return { ok: errors.length === 0, errors };
};
