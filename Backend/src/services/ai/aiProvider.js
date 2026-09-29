// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 36.1 — AI PROVIDER (the ONE choke point every AI call passes through)
//
//  WHAT THIS MODULE GUARANTEES
//    Every call to `aiChat` enforces, IN THIS ORDER:
//      1. the GLOBAL kill switch (AI_ENABLED)      → 503 AI_UNAVAILABLE
//      2. the PER-TENANT kill switch (36.2 wires it) → 503 AI_UNAVAILABLE
//      3. the 32.4 shared rate limit               → 429 RATE_LIMITED
//      4. the monthly token quota                  → 429 QUOTA_EXCEEDED
//      5. PII REDACTION of every message           → before the vendor call
//      6. the vendor call itself (bounded timeout)  → 503 on any failure
//      7. usage recording (fire-and-forget)         → never blocks the answer
//
//  WHAT THE AI NEVER GETS
//    · No Mongo credentials, no service account, no query ability. It
//      receives redacted text and returns text (Phase 36 §5.5).
//    · No tenant id in the payload. companyId is used for OUR bookkeeping
//      (limiter key, usage row) and is never sent to the vendor.
//
//  THE VENDOR SWAP
//    Two env vars (AI_BASE_URL, AI_API_KEY). The SDK is OpenAI's against an
//    OpenAI-compatible endpoint, so Groq today and OpenAI/Anthropic later is
//    a deployment change, not a code change.
// ═══════════════════════════════════════════════════════════════════════════

import OpenAI from 'openai';

import logger from '../../config/logger.js';

import { createRateLimitStore } from '../../utils/rateLimitStore.js';

import AIUsageLog from '../../models/AIUsageLog.js';

import {
  AI_ERROR_TYPES,
  AI_FEATURES,
  AI_FEATURE_HR_CHAT,
  AI_RATE_LIMIT,
  getAIConfig,
} from './aiConfig.js';

import {
  AIError,
  AI_ERROR_CODES,
  classifyVendorError,
} from './aiErrors.js';

import { redactMessages } from './piiRedactor.js';

import { checkQuota, recordUsage } from './aiUsageTracker.js';

// ── PROCESS STATE ──────────────────────────────────────────────────────────
// One client per API process. The SDK pools its own connections; there is no
// reason to build one per request (and a reason not to: each client carries
// its own keep-alive sockets).
let client = null;

let state = Object.freeze({
  initialized: false,
  enabled: false,
  reason: null,
});

/** Read-only view of provider state. Never contains the key. */
export const getAIProviderState = () => state;

// ── INITIALISATION ─────────────────────────────────────────────────────────

const buildClient = (config) =>
  new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    // Bounded: a hung vendor must not hold a request open forever. The
    // request-level guard is AI_TIMEOUT_MS; this is the SDK's own socket
    // timeout for the same budget.
    timeout: config.timeoutMs,
    // No SDK-level retries. A retry doubles the token spend on a call the
    // person already gave up on, and when Phase 36 needs retries they belong
    // to the queue layer with an idempotency key, not to a synchronous
    // request. The limiter and quota are the real protection.
    maxRetries: 0,
  });

/**
 * Initialise the provider from an environment source.
 *
 * FAIL-FAST BY DESIGN (36.1 build prompt): AI_ENABLED=true with no
 * AI_API_KEY is a misconfigured deployment, and booting an API that will
 * 503 every /api/ai/chat call is worse than refusing to start. server.js
 * calls this inside its existing try/catch, which logs the message (the KEY
 * name only) and exits 1.
 *
 * AI_ENABLED=false — the default — is a clean, silent no-op.
 */
export const initAIProvider = ({
  source = process.env,
  clientFactory = buildClient,
} = {}) => {
  const config = getAIConfig(source);

  if (!config.enabled) {
    client = null;

    state = Object.freeze({ initialized: true, enabled: false, reason: 'DISABLED' });

    return state;
  }

  if (!config.hasApiKey) {
    // Names the KEY, never a value, never a vendor message.
    throw AIError.configInvalid();
  }

  client = clientFactory(config);

  state = Object.freeze({ initialized: true, enabled: true, reason: null });

  return state;
};

// ── THE ONE LIMITER ────────────────────────────────────────────────────────
// 32.4 reuse: ONE shared Redis counter under
// crewly:<env>:rl:ai:<companyId>:<userId>. Both halves of the identity are
// SERVER-DERIVED (req.companyId / req.user._id), so a client can never choose
// its own bucket. Redis down → the store's bounded per-process bucket, the
// same refusal contract, never unlimited.
//
// Created once at module load: the store is stateless apart from its own
// bounded fallback map, and a single instance keeps the degraded-mode circuit
// shared across requests.
const aiLimiter = createRateLimitStore({
  sharedName: AI_RATE_LIMIT.sharedName,
  windowMs: AI_RATE_LIMIT.windowMs,
});

export const getAIRateLimitIdentity = (companyId, userId) =>
  `${companyId}:${userId}`;

// ── THE VENDOR CALL ────────────────────────────────────────────────────────

const defaultCreateCompletion = async ({ client: sdk, messages, config }) =>
  sdk.chat.completions.create({
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
  });

// ── IN-FLIGHT USAGE WRITES ─────────────────────────────────────────────────
// Fire-and-forget must still be observable and drainable, otherwise a test
// cannot assert the row was written and a shutdown could abandon it. The
// provider tracks every pending write here and drains them on demand.
const pendingUsageWrites = new Set();

const fireUsageWrite = (entry) => {
  const promise = recordUsage(entry)
    .catch(() => false)
    .finally(() => pendingUsageWrites.delete(promise));

  pendingUsageWrites.add(promise);

  return promise;
};

/** Await every in-flight usage write. Test + graceful-shutdown helper. */
export const drainAIUsageWrites = async () => {
  await Promise.all([...pendingUsageWrites]);
};

// ── aiChat ─────────────────────────────────────────────────────────────────

/**
 * One AI chat completion, fully guarded.
 *
 * @param {object}   input
 * @param {Array}    input.messages   [{role, content}] — already validated
 * @param {string}   input.companyId  SERVER-DERIVED tenant authority
 * @param {string}   input.userId     SERVER-DERIVED caller
 * @param {string}   input.feature    one of AI_FEATURES
 * @param {object}   input.deps       dependency-injection seam (tests, 36.2)
 *
 * Every dependency is injectable so the hermetic suite can drive the real
 * control flow with no Mongo, no Redis and no network.
 */
export const aiChat = async ({
  messages,
  companyId,
  userId,
  feature = AI_FEATURE_HR_CHAT,
  deps = {},
} = {}) => {
  const {
    getConfig = () => getAIConfig(),
    isTenantEnabled = async () => true,
    resolveQuota = async () => getAIConfig().monthlyQuotaTokens,
    checkQuotaFn = checkQuota,
    limiter = aiLimiter,
    redact = redactMessages,
    createCompletion = defaultCreateCompletion,
    recordUsageFn = recordUsage,
    UsageModel = AIUsageLog,
    resolveClient = () => client,
    now = () => new Date(),
    clock = () => Date.now(),
  } = deps;

  // Guard 0 — a caller error is a programming error, not a client error, but
  // it must never reach the vendor. Refused before any I/O.
  if (!AI_FEATURES.includes(feature)) {
    throw AIError.requestInvalid('Unknown AI feature.');
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw AIError.requestInvalid('At least one message is required.');
  }

  if (!companyId || !userId) {
    // Identity is never optional. A missing tenant means the caller skipped
    // tenantContext, which is a bug, and it must fail closed.
    throw AIError.requestInvalid('AI identity is incomplete.');
  }

  const config = getConfig();

  // Guard 1 — GLOBAL kill switch.
  if (!config.enabled) {
    throw AIError.unavailable();
  }

  // Guard 1b — the SDK client. A missing client means initAIProvider never
  // ran (or refused), which is a deployment problem, not a vendor problem.
  // Reporting it as CONFIG_INVALID keeps the two apart in the logs.
  const sdkClient = resolveClient();

  if (!sdkClient) {
    throw AIError.configInvalid();
  }

  // Guard 2 — PER-TENANT kill switch. 36.2 replaces the default resolver
  // with an AITenantConfig read; the seam exists now so that unit does not
  // have to reopen this one.
  let tenantEnabled = true;

  try {
    tenantEnabled = await isTenantEnabled({ companyId, config });
  } catch {
    // A tenant-config read failure must not silently allow the call.
    throw AIError.unavailable();
  }

  if (!tenantEnabled) {
    throw AIError.unavailable();
  }

  // Guard 3 — 32.4 shared rate limit (per company + per user).
  let limited = false;

  try {
    const verdict = await limiter.hit(
      getAIRateLimitIdentity(companyId, userId),
      AI_RATE_LIMIT.maximum,
    );

    limited = verdict?.limited === true;
  } catch {
    // The store never throws by contract; if it somehow does, the bounded
    // local bucket already refused or allowed. Refuse rather than guess.
    limited = true;
  }

  if (limited) {
    // The refusal is part of the audit trail, and it costs zero tokens.
    fireUsageWrite({
      companyId,
      userId,
      feature,
      model: config.model,
      provider: 'groq',
      totalTokens: 0,
      latencyMs: 0,
      status: 'ERROR',
      errorType: 'rate_limit',
      UsageModel,
    });

    throw AIError.rateLimited();
  }

  // Guard 4 — monthly token quota (hard).
  const startedAt = clock();

  let quota;

  try {
    const limit = await resolveQuota({ companyId, config });

    quota = await checkQuotaFn({
      companyId,
      limitTokens: limit,
      now: now(),
      UsageModel,
    });
  } catch (error) {
    if (error instanceof AIError) throw error;

    // Any other failure to establish the quota is a refusal, never an
    // allowance (fail closed).
    throw AIError.unavailable();
  }

  if (!quota.allowed) {
    fireUsageWrite({
      companyId,
      userId,
      feature,
      model: config.model,
      provider: 'groq',
      totalTokens: 0,
      latencyMs: 0,
      status: 'QUOTA_EXCEEDED',
      errorType: 'quota',
      UsageModel,
    });

    throw AIError.quotaExceeded();
  }

  // Guard 5 — PII REDACTION. Happens HERE, after every guard and before the
  // vendor call, so nothing that was refused ever reached the redactor and
  // nothing that was allowed ever reached the vendor unredacted.
  const outbound = redact(messages);

  // Guard 6 — the vendor call.
  let response;

  try {
    response = await createCompletion({
      client: sdkClient,
      messages: outbound,
      config,
    });
  } catch (error) {
    const errorType = classifyVendorError(error);

    // Metadata only: the classification, never the vendor's message.
    logger.warn('ai.vendor.error', {
      feature,
      errorType,
      status: Number(error?.status ?? 0) || undefined,
      latencyMs: clock() - startedAt,
    });

    fireUsageWrite({
      companyId,
      userId,
      feature,
      model: config.model,
      provider: 'groq',
      totalTokens: 0,
      latencyMs: clock() - startedAt,
      status: 'ERROR',
      errorType,
      UsageModel,
    });

    // One generic sentence, whatever the vendor said.
    throw AIError.vendorError();
  }

  const latencyMs = clock() - startedAt;

  const usage = response?.usage || {};

  const promptTokens = Number(usage.prompt_tokens) || 0;

  const completionTokens = Number(usage.completion_tokens) || 0;

  const totalTokens = Number(usage.total_tokens) || promptTokens + completionTokens;

  const content = String(response?.choices?.[0]?.message?.content ?? '');

  // Guard 7 — usage recording. Fire-and-forget: the person is waiting for the
  // answer, and a failed audit write must not turn a good answer into an
  // error. drainAIUsageWrites() exists for tests and shutdown.
  fireUsageWrite({
    companyId,
    userId,
    feature,
    model: config.model,
    provider: 'groq',
    promptTokens,
    completionTokens,
    totalTokens,
    latencyMs,
    status: 'SUCCESS',
    errorType: 'none',
    UsageModel,
  });

  // What goes back to the browser: the answer and its cost. Never the
  // outbound (redacted) messages — the client already has its own copy, and
  // echoing them would imply the server stores them.
  return {
    content,
    model: config.model,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens,
    },
    latencyMs,
  };
};

/**
 * Embeddings. NOT SUPPORTED by the current provider (Groq offers no
 * first-party embeddings endpoint), and the answer is an immediate, loud
 * refusal rather than a call that fails halfway — a future unit must not
 * build on a capability that does not exist.
 */
export const embed = async () => {
  throw AIError.embeddingsUnsupported();
};

export { AI_ERROR_CODES, AI_ERROR_TYPES };
