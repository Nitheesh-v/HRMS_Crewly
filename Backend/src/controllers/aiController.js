// ─────────────────────────────────────────────────────────────────────────────
// Phase 36.1/36.2 — AI controller.
//
// Deliberately thin. Every guardrail (kill switch, rate limit, quota,
// redaction, vendor-error opacity) lives in services/ai/, so this file does
// four things and nothing else:
//   1. take identity from the VERIFIED session — never from the body;
//   2. call the service;
//   3. write the reply, mapping an AIError to its stable code;
//   4. throttle the debug-only context preview.
//
// Step 3 is why the try/catch exists at all: utils/errorHandler drops a
// custom `err.code`, so the code-bearing 429/503 replies this feature needs
// are written here, directly (briefing §J pitfall 1).
// ─────────────────────────────────────────────────────────────────────────────
import asyncHandler from '../utils/asyncHandler.js';

import {
  AI_CHATBOT_RATE_LIMIT,
  AI_CONTEXT_CATEGORIES,
  AI_FEATURE_HR_CHAT,
  AI_PREVIEW_RATE_LIMIT,
} from '../services/ai/aiConfig.js';

import { AIError, sendAIError } from '../services/ai/aiErrors.js';

import { aiChat } from '../services/ai/aiProvider.js';

import { getMonthUsage } from '../services/ai/aiUsageTracker.js';

import {
  getTenantConfig,
  updateTenantConfig,
} from '../services/ai/aiTenantConfigService.js';

import { getUserHRContext } from '../services/ai/hrContextRetriever.js';

import { askHRAssistant } from '../services/ai/hrChatbotService.js';

import { createRateLimitStore } from '../utils/rateLimitStore.js';

// Phase 36.2 — the preview endpoint returns a whole HR context string, which
// makes it a data-dump tool if it is not throttled harder than the chat
// itself. A SEPARATE 32.4 store keeps the budgets independent, and it is
// enforced HERE and nowhere else — a second check in the service would
// double-count one request (the 36.1 lesson).
const previewLimiter = createRateLimitStore({
  sharedName: AI_PREVIEW_RATE_LIMIT.sharedName,
  windowMs: AI_PREVIEW_RATE_LIMIT.windowMs,
});

// Phase 36.3 — the chatbot gets its OWN tier for the same reason: a person
// exhausting the verification endpoint's budget must not be locked out of the
// employee assistant, and vice versa. Enforced HERE and nowhere else.
const chatbotLimiter = createRateLimitStore({
  sharedName: AI_CHATBOT_RATE_LIMIT.sharedName,
  windowMs: AI_CHATBOT_RATE_LIMIT.windowMs,
});

/** Turn `?categories=a,b` into ['a','b'], or null when nothing usable was asked for. */
const parseCategories = (raw) => {
  if (typeof raw !== 'string') return null;

  const list = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => AI_CONTEXT_CATEGORIES.includes(entry));

  return list.length > 0 ? list : null;
};

// POST /api/ai/chat  { messages: [{role, content}] }
export const chat = asyncHandler(async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const { messages } = req.body;

    const result = await aiChat({
      messages,

      // Tenant authority and caller identity are SERVER-DERIVED. The body
      // never carries them (pinned by the validator's noIdentityOverride).
      companyId: req.companyId,
      userId: req.user._id,
      feature: AI_FEATURE_HR_CHAT,
    });

    // Data to frontend - response to frontend
    return res.status(200).json({
      statusCode: 200,
      success: true,
      data: result,
      message: 'AI response ready',
    });
  } catch (error) {
    // A code-bearing AI reply is written directly — the shared error pipeline
    // has no code field, and the frontend branches on these codes.
    if (error instanceof AIError) {
      return sendAIError(res, error);
    }

    // Anything else is a genuine bug: let the normal pipeline log it with a
    // request id and answer a generic 500.
    throw error;
  }
});

// GET /api/ai/config — this tenant's AI configuration and its month-to-date
// spend. Behind SETTINGS_MANAGE: an ordinary employee has no business reading
// the tenant's quota.
export const getConfig = asyncHandler(async (req, res) => {
  try {
    // DB Logic - DB logics
    const [config, usage] = await Promise.all([
      getTenantConfig(req.companyId),
      getMonthUsage({ companyId: req.companyId }),
    ]);

    // Data to frontend - response to frontend
    return res.status(200).json({
      statusCode: 200,
      success: true,
      data: {
        config: {
          enabled: config.enabled,
          monthlyQuotaTokens: config.monthlyQuotaTokens,
          allowedCategories: config.allowedCategories,
          updatedBy: config.updatedBy,
          updatedAt: config.updatedAt,
        },
        currentMonthUsage: {
          totalTokens: usage.totalTokens,
          calls: usage.calls,
          byStatus: usage.byStatus,
          windowStart: usage.windowStart,
          windowEnd: usage.windowEnd,
        },
      },
      message: 'AI configuration loaded',
    });
  } catch (error) {
    if (error instanceof AIError) {
      return sendAIError(res, error);
    }

    throw error;
  }
});

// PUT /api/ai/config — the tenant's own kill switch, quota and allowlist.
export const updateConfig = asyncHandler(async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const { enabled, monthlyQuotaTokens, allowedCategories } = req.body;

    const updates = {};

    if (enabled !== undefined) updates.enabled = enabled;

    if (monthlyQuotaTokens !== undefined) {
      updates.monthlyQuotaTokens = monthlyQuotaTokens;
    }

    if (allowedCategories !== undefined) {
      updates.allowedCategories = allowedCategories;
    }

    // DB Logic - DB logics
    const config = await updateTenantConfig(
      req.companyId,
      updates,
      req.user._id,
    );

    // Data to frontend - response to frontend
    return res.status(200).json({
      statusCode: 200,
      success: true,
      data: { config },
      message: 'AI configuration updated',
    });
  } catch (error) {
    if (error instanceof AIError) {
      return sendAIError(res, error);
    }

    throw error;
  }
});

// GET /api/ai/context/preview — the caller's OWN context, redacted, exactly
// as the AI would receive it. A debugging and verification surface: it is what
// lets an owner see with their own eyes that no PII crosses the boundary.
// Not called from any production UI (Phase 36 §9.3).
export const previewContext = asyncHandler(async (req, res) => {
  try {
    // Guard first: this endpoint is the most expensive read in the suite and
    // returns the most data, so it is throttled before anything is fetched.
    let limited = false;

    try {
      const verdict = await previewLimiter.hit(
        `${req.companyId}:${req.user._id}`,
        AI_PREVIEW_RATE_LIMIT.maximum,
      );

      limited = verdict?.limited === true;
    } catch {
      // The store never throws by contract. If it somehow does, refuse rather
      // than guess — the same direction as the chat limiter.
      limited = true;
    }

    if (limited) {
      throw AIError.rateLimited();
    }

    // Data from frontend - requests from frontend
    const categories = parseCategories(req.query.categories);

    // DB Logic - DB logics
    const result = await getUserHRContext({
      companyId: req.companyId,
      userId: req.user._id,
      categories,
    });

    // Data to frontend - response to frontend
    return res.status(200).json({
      statusCode: 200,
      success: true,
      data: {
        context: result.context,
        categoriesUsed: result.categoriesUsed,
      },
      message: 'AI context preview ready',
    });
  } catch (error) {
    if (error instanceof AIError) {
      return sendAIError(res, error);
    }

    throw error;
  }
});

// POST /api/ai/chatbot — one employee-facing turn.
//
// This is the ONLY employee-visible AI endpoint. It differs from /chat in
// three ways, all deliberate:
//   · the system prompt and the HR context are assembled SERVER-SIDE, so the
//     client cannot supply either;
//   · the caller receives { reply, usage, categoriesUsed } and NEVER the
//     context, which stays on the server (Phase 36 §10);
//   · the feature label is 'chatbot', so a usage row says which surface spent
//     the tokens.
export const askChatbot = asyncHandler(async (req, res) => {
  try {
    // Guard first: one request, one charge, in exactly one place. A second
    // check inside the service would double-count this turn (36.1 lesson).
    let limited = false;

    try {
      const verdict = await chatbotLimiter.hit(
        `${req.companyId}:${req.user._id}`,
        AI_CHATBOT_RATE_LIMIT.maximum,
      );

      limited = verdict?.limited === true;
    } catch {
      // The store never throws by contract. If it somehow does, refuse rather
      // than guess — the same direction as the chat limiter.
      limited = true;
    }

    if (limited) {
      throw AIError.rateLimited();
    }

    // Data from frontend - requests from frontend
    // `language` is the ONLY presentation field the client may send, and it
    // carries no authority: it changes how the reply is phrased, never what
    // the caller may read. Tenant authority and caller identity stay
    // server-derived below, exactly as in 36.3.
    const { messages, categories, language } = req.body;

    // DB Logic - DB logics
    const response = await askHRAssistant({
      messages,
      categories,
      language,

      // Tenant authority and caller identity are SERVER-DERIVED. The validator
      // refuses any client-supplied identity outright.
      companyId: req.companyId,
      userId: req.user._id,
    });

    // Data to frontend - response to frontend
    return res.status(200).json({
      statusCode: 200,
      success: true,
      data: response,
      message: 'Chatbot reply generated',
    });
  } catch (error) {
    if (error instanceof AIError) {
      return sendAIError(res, error);
    }

    throw error;
  }
});
