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
  AI_LANGUAGE_CATALOGUE,
  AI_PREVIEW_RATE_LIMIT,
} from '../services/ai/aiConfig.js';

import { AIError, sendAIError } from '../services/ai/aiErrors.js';

import { aiChat } from '../services/ai/aiProvider.js';

import {
  getMonthUsage,
  getUsageBreakdown,
} from '../services/ai/aiUsageTracker.js';

import {
  getTenantConfig,
  getTenantLanguages,
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

// GET /api/ai/languages — the reply languages THIS tenant offers.
//
// WHY A SEPARATE ENDPOINT FROM /config.
//   The assistant widget is open to every employee, and its selector has to
//   list exactly the languages the admin enabled. /config answers that too,
//   but it is behind SETTINGS_MANAGE and carries the quota — an employee has
//   no business reading either. So the list gets its own route behind
//   authentication alone.
//
// WHAT IT DOES NOT RETURN. No quota, no enabled flag, no categories, no
// usage. A language is a PRESENTATION preference: knowing which ones are on
// offer tells a caller nothing about what they may read.
export const getChatLanguages = asyncHandler(async (req, res) => {
  try {
    // DB Logic - DB logics
    // The tenant's enabled codes. Fails CLOSED to the platform default set
    // rather than to an error, so an unreadable config costs a tenant the
    // extra languages for one request and nothing more.
    const languages = await getTenantLanguages(req.companyId);

    // The catalogue travels with the codes so the client never keeps a second
    // copy. A new language added to aiConfig.js appears in the selector the
    // moment the page reloads — there is no frontend edit to forget.
    const catalogue = AI_LANGUAGE_CATALOGUE.filter((entry) =>
      languages.includes(entry.code),
    );

    // Data to frontend - response to frontend
    return res.status(200).json({
      statusCode: 200,
      success: true,
      data: {
        languages,
        catalogue,
      },
      message: 'Chat languages loaded',
    });
  } catch (error) {
    if (error instanceof AIError) {
      return sendAIError(res, error);
    }

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

          // 36.7 — the languages this tenant offers. The admin page renders
          // checkboxes from the platform catalogue and ticks these.
          languages: config.languages,
          updatedBy: config.updatedBy,
          updatedAt: config.updatedAt,
        },

        // The platform catalogue travels with the config so the admin page
        // does not have to hardcode a second copy of it. One source of
        // truth, and a new language appears in the UI the moment it is
        // added to aiConfig.js.
        languageCatalogue: AI_LANGUAGE_CATALOGUE,

        // 36.7 — the platform's context-category codes, for the same reason.
        //
        // The admin page needs the FULL set to offer the categories that are
        // switched off. Sending only the tenant's enabled list would make
        // the section a display of what is on with no way to turn anything
        // else on, which is exactly the read-only dead end it replaced.
        //
        // These are codes, not descriptions. The page owns the human labels,
        // and it keeps them next to what the retriever actually puts in the
        // context so the two cannot drift.
        categoryCatalogue: AI_CONTEXT_CATEGORIES,
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
    const {
      enabled,
      monthlyQuotaTokens,
      allowedCategories,
      languages,
    } = req.body;

    const updates = {};

    if (enabled !== undefined) updates.enabled = enabled;

    if (monthlyQuotaTokens !== undefined) {
      updates.monthlyQuotaTokens = monthlyQuotaTokens;
    }

    if (allowedCategories !== undefined) {
      updates.allowedCategories = allowedCategories;
    }

    // 36.7 — the language list. The MODEL refuses an empty list and a
    // list without English, so the "you must keep English" rule is
    // enforced in one place rather than repeated in the UI, where it could
    // be bypassed.
    if (languages !== undefined) {
      updates.languages = languages;
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
    //
    // 36.7 — the reply languages THIS tenant offers. Read here rather than
    // inside the service so the service stays a pure function of its
    // arguments and a test can pass any list it likes. The read is cached
    // per tenant, so this is not a second database round trip per turn.
    //
    // It fails closed to the platform default set, so an unreadable config
    // degrades to "the five 36.5 languages" rather than to an error.
    const languages = await getTenantLanguages(req.companyId);

    const response = await askHRAssistant({
      messages,
      categories,
      language,
      languages,

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

// GET /api/ai/usage — the admin token dashboard (Phase 36.6).
//
// Answers "where did this month's AI budget go?" for a company admin.
// The route is behind protect → tenantContext → SETTINGS_MANAGE, so the
// only rows that can come back are this tenant's own.
//
// WHAT IT DELIBERATELY DOES NOT RETURN: any prompt, any reply, any
// category list and any per-user timestamp. `topUsers` carries a name, a
// designation and a token count — the name and designation are already
// visible to this admin on the employee screen, and the token count is the
// number the quota is made of. Nothing new about anyone is exposed.
export const getUsage = asyncHandler(async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    // Nothing is read from the body or the query. `now` is server-side, so
    // a client cannot ask for another tenant's window or another month.
    const now = new Date();

    // DB Logic - DB logics
    // Tenant authority is req.companyId ONLY. There is no companyId in the
    // request and no way to supply one.
    const [config, breakdown] = await Promise.all([
      getTenantConfig(req.companyId),
      getUsageBreakdown({ companyId: req.companyId, now }),
    ]);

    // Data to frontend - response to frontend
    return res.status(200).json({
      statusCode: 200,
      success: true,
      data: {
        window: {
          start: breakdown.windowStart,
          end: breakdown.windowEnd,
        },

        totals: {
          totalTokens: breakdown.totalTokens,
          calls: breakdown.calls,

          // null means "use the platform default", which the config
          // service has already resolved. The UI shows a real ceiling.
          quotaTokens: config.monthlyQuotaTokens,
        },

        byFeature: breakdown.byFeature,
        byStatus: breakdown.byStatus,
        topUsers: breakdown.topUsers,
      },
      message: 'AI usage breakdown ready',
    });
  } catch (error) {
    if (error instanceof AIError) {
      return sendAIError(res, error);
    }

    throw error;
  }
});
