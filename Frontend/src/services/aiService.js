// ═══════════════════════════════════════════════════════════════════════════
// PHASE 36.3 — AI ASSISTANT REST CLIENT
//
// IMPORTANT — RESPONSE SHAPE (36.3)
//   The api.js response interceptor ALREADY UNWRAPS `body.data` once, so a
//   successful POST comes back as the `data` object itself, NOT as
//   { data }. Reading `const { data } = await api.post(...)` yields undefined.
//   The `bare()` helper mirrors chatService.js and is tolerant of both shapes.
//
// PRIVACY (36.3 §10)
//   The server never sends the HR context or the system prompt, so this module
//   has nothing to strip: it forwards { reply, usage, categoriesUsed } exactly
//   as received. Nothing is written to localStorage — the conversation lives in
//   React state and Redux only.
// ═══════════════════════════════════════════════════════════════════════════

import api from './api.js';

/**
 * Tolerate both the unwrapped shape (the interceptor already stripped `data`)
 * and the raw shape, so this client keeps working if that ever changes.
 */
const bare = (res) =>
  res && typeof res === 'object' && 'data' in res ? res.data : res;

const normalizeError = (error) => {
  // api.js attaches the response's `code` (e.g. AI_RATE_LIMITED) to the error,
  // which is how the slice decides between "wait a moment" and "ask HR".
  const normalized = new Error(
    error?.message || 'The assistant could not answer. Please try again.',
  );

  normalized.status = error?.status;
  normalized.code = error?.code;
  normalized.data = error?.data;

  return normalized;
};

/**
 * Ask the HR assistant one turn.
 *
 * The client sends ONLY { messages, categories }. It deliberately sends no
 * companyId, userId, user or feature — the validator refuses those, and the
 * server derives every one of them from the caller's own session. That is the
 * multi-tenancy boundary: there is no client-side tenant id to send at all.
 *
 * @param {{messages: Array<{role: string, content: string}>,
 *          categories?: string[],
 *          language?: string}} payload
 *        `language` is a PRESENTATION preference only. It is omitted
 *        entirely when it is English, so the base case sends the same
 *        payload 36.3 sent and costs no extra tokens.
 * @returns {Promise<{reply: string, usage: object|null, categoriesUsed: string[],
 *   followUpQuestions: string[], deepLinks: Array<{label: string, path: string}>}>}
 */
export const askHRAssistant = async ({ messages, categories, language } = {}) => {
  try {
    const payload = { messages };

    // Omit the key entirely rather than sending an empty array, which the
    // validator would accept as "narrow to nothing".
    if (Array.isArray(categories) && categories.length > 0) {
      payload.categories = categories;
    }

    // 36.5 — send the language ONLY when it is not English.
    //
    // English is the base case and the server adds no language rule for
    // it, so sending `en` would be a key that changes nothing. Omitting it
    // keeps the wire identical to 36.3 for the default and keeps the
    // prompt as short as the owner measured it.
    //
    // The value is already normalized by the slice, but this client is
    // also called directly from tests, so it re-checks rather than trust.
    const wanted =
      typeof language === 'string' && language.length > 0 ? language : '';

    if (wanted && wanted !== 'en') {
      payload.language = wanted;
    }

    const response = bare(await api.post('/ai/chatbot', payload));

    // 36.6 — the two chip arrays are normalized defensively rather than
    // forwarded raw. A malformed row must not reach a component that maps
    // over it, and a chip with an empty label or an empty path would render
    // as a dead button.
    const followUpQuestions = Array.isArray(response?.followUpQuestions)
      ? response.followUpQuestions
          .filter((question) => typeof question === 'string')
          .map((question) => question.trim())
          .filter((question) => question.length > 0)
      : [];

    const deepLinks = Array.isArray(response?.deepLinks)
      ? response.deepLinks
          .filter(
            (link) =>
              link &&
              typeof link.path === 'string' &&
              link.path.length > 0 &&
              typeof link.label === 'string' &&
              link.label.length > 0,
          )
          .map((link) => ({ label: link.label, path: link.path }))
      : [];

    return {
      reply: typeof response?.reply === 'string' ? response.reply : '',
      usage: response?.usage ?? null,
      categoriesUsed: Array.isArray(response?.categoriesUsed)
        ? response.categoriesUsed
        : [],
      followUpQuestions,
      deepLinks,
    };
  } catch (error) {
    throw normalizeError(error);
  }
};

/**
 * 36.6 — the admin AI usage dashboard.
 *
 * WHAT IT RETURNS: aggregate counts for the caller's own company. Tokens by
 * feature, tokens by status, and the top users. No prompts, no replies and
 * no HR content — the AIUsageLog collection cannot hold any of those, which
 * is why the dashboard is safe to build at all.
 *
 * WHO CAN CALL IT: only someone with SETTINGS_MANAGE. The route enforces
 * that server-side; this client cannot and does not try to.
 *
 * NO PARAMETERS. `now` is computed on the server, so the month window
 * cannot be shifted by editing a request in the browser, and the company
 * is taken from the caller's own token. A client-supplied companyId would
 * be a multi-tenancy hole and is refused by the validator.
 */
export const getAiUsage = async () => {
  try {
    const response = await api.get('/ai/usage');

    const payload = bare(response);

    // THE ACTUAL SERVER SHAPE, recorded so nobody has to re-derive it:
    //
    //   data.totals        { totalTokens, calls, quotaTokens }
    //   data.window        { start, end }   — ISO strings
    //   data.byFeature     [ { feature, totalTokens, calls } ]
    //   data.byStatus      { SUCCESS: { totalTokens, calls }, ... }
    //                       an OBJECT keyed by status, not an array
    //   data.topUsers      [ { userId, name, designation, totalTokens, calls } ]
    //
    // Every field is normalized rather than forwarded. A missing array must
    // not crash a `.map`, a missing object must not crash an `Object.entries`,
    // and a deleted user must not render as `undefined`.
    const totals = payload?.totals || {};

    const window = payload?.window || {};

    const byStatus = payload?.byStatus || {};

    return {
      totalTokens: Number(totals.totalTokens) || 0,
      calls: Number(totals.calls) || 0,

      // null from the server means "the platform default applies". It is
      // passed through as null rather than 0, so the page can tell a real
      // zero from an unset ceiling.
      quotaTokens:
        totals.quotaTokens === null || totals.quotaTokens === undefined
          ? null
          : Number(totals.quotaTokens) || 0,

      windowStart: typeof window.start === 'string' ? window.start : '',
      windowEnd: typeof window.end === 'string' ? window.end : '',

      byFeature: Array.isArray(payload?.byFeature)
        ? payload.byFeature
            .filter((row) => row && typeof row.feature === 'string')
            .map((row) => ({
              feature: row.feature,
              totalTokens: Number(row.totalTokens) || 0,
              calls: Number(row.calls) || 0,
            }))
        : [],

      // An object, so it is normalized entry by entry.
      byStatus:
        typeof byStatus === 'object' && byStatus !== null
          ? Object.keys(byStatus).reduce((accumulator, key) => {
              accumulator[key] = {
                totalTokens: Number(byStatus[key]?.totalTokens) || 0,
                calls: Number(byStatus[key]?.calls) || 0,
              };

              return accumulator;
            }, {})
          : {},

      topUsers: Array.isArray(payload?.topUsers)
        ? payload.topUsers.map((row) => ({
            userId: String(row?.userId || ''),

            // An empty string means the user was deleted. The row is kept
            // deliberately — the spend is real and hiding it would understate
            // the company's usage — and the page labels it as such.
            name: String(row?.name || ''),
            designation: String(row?.designation || ''),
            totalTokens: Number(row?.totalTokens) || 0,
            calls: Number(row?.calls) || 0,
          }))
        : [],
    };
  } catch (error) {
    throw normalizeError(error);
  }
};

/**
 * 36.7 — the reply languages THIS tenant offers.
 *
 * WHY IT IS A SEPARATE CALL. The assistant widget is open to every employee
 * and its selector must list exactly the languages the admin enabled, so an
 * employee has to be able to ask. /ai/config answers that too, but it is
 * behind SETTINGS_MANAGE and carries the quota — an employee has no business
 * reading either. So the list gets its own route behind authentication alone.
 *
 * WHAT COMES BACK: the tenant's enabled codes, plus the matching catalogue
 * records so the client never keeps a second copy of the native names and
 * BCP-47 tags. No quota, no enabled flag, no categories, no usage — a
 * language is a presentation preference and knowing which are on offer tells
 * a caller nothing about what they may read.
 *
 * NO PARAMETERS. The company comes from the caller's own token; a
 * client-supplied companyId would be a multi-tenancy hole and is refused.
 *
 * @returns {Promise<{languages: string[], catalogue: Array<{code: string,
 *   label: string, native: string, hint: string, bcp47: string}>}>}
 */
export const getChatLanguages = async () => {
  try {
    const payload = bare(await api.get('/ai/languages'));

    const languages = Array.isArray(payload?.languages)
      ? payload.languages.filter((code) => typeof code === 'string')
      : [];

    // The catalogue is filtered by the server to the tenant's codes already.
    // It is re-normalized here because a record with an empty code would
    // render as an <option> with nothing in it, and a missing bcp47 would
    // make the browser silently ignore the speech request.
    const catalogue = Array.isArray(payload?.catalogue)
      ? payload.catalogue
          .filter(
            (entry) => entry && typeof entry.code === 'string' && entry.code,
          )
          .map((entry) => ({
            code: entry.code,
            label: String(entry.label || entry.code),
            native: String(entry.native || entry.label || entry.code),
            hint: String(entry.hint || ''),
            bcp47: String(entry.bcp47 || 'en-IN'),
          }))
      : [];

    return { languages, catalogue };
  } catch (error) {
    throw normalizeError(error);
  }
};

/**
 * 36.7 — the admin AI configuration.
 *
 * Behind SETTINGS_MANAGE server-side. This client cannot and does not try to
 * enforce that; a caller without the permission gets a 403 they must render.
 *
 * @returns {Promise<{enabled: boolean, monthlyQuotaTokens: number|null,
 *   allowedCategories: string[], languages: string[], languageCatalogue:
 *   Array<{code: string, label: string, native: string, hint: string,
 *   bcp47: string}>, updatedBy: string|null, updatedAt: string|null,
 *   usage: object}>}
 */
export const getAiConfig = async () => {
  try {
    const payload = bare(await api.get('/ai/config'));

    const config = payload?.config || {};

    const usage = payload?.currentMonthUsage || {};

    return {
      enabled: config.enabled !== false,
      monthlyQuotaTokens:
        config.monthlyQuotaTokens === null ||
        config.monthlyQuotaTokens === undefined
          ? null
          : Number(config.monthlyQuotaTokens) || 0,
      allowedCategories: Array.isArray(config.allowedCategories)
        ? config.allowedCategories.filter((entry) => typeof entry === 'string')
        : [],
      languages: Array.isArray(config.languages)
        ? config.languages.filter((entry) => typeof entry === 'string')
        : [],
      languageCatalogue: Array.isArray(payload?.languageCatalogue)
        ? payload.languageCatalogue
            .filter((entry) => entry && typeof entry.code === 'string')
            .map((entry) => ({
              code: entry.code,
              label: String(entry.label || entry.code),
              native: String(entry.native || entry.label || entry.code),
              hint: String(entry.hint || ''),
              bcp47: String(entry.bcp47 || 'en-IN'),
            }))
        : [],
      updatedBy: config.updatedBy ? String(config.updatedBy) : null,
      updatedAt: config.updatedAt ? String(config.updatedAt) : null,
      usage: {
        totalTokens: Number(usage.totalTokens) || 0,
        calls: Number(usage.calls) || 0,
        windowStart: typeof usage.windowStart === 'string' ? usage.windowStart : '',
        windowEnd: typeof usage.windowEnd === 'string' ? usage.windowEnd : '',
        byStatus:
          typeof usage.byStatus === 'object' && usage.byStatus !== null
            ? usage.byStatus
            : {},
      },
    };
  } catch (error) {
    throw normalizeError(error);
  }
};

/**
 * 36.7 — save the tenant's AI configuration.
 *
 * Only the supplied keys are sent. A key that is absent is left alone on the
 * server, which is what lets the settings page save one field without
 * silently overwriting the others from a stale render.
 *
 * @param {{enabled?: boolean, monthlyQuotaTokens?: number|null,
 *          allowedCategories?: string[], languages?: string[]}} updates
 */
export const updateAiConfig = async (updates = {}) => {
  try {
    const payload = {};

    if (updates.enabled !== undefined) payload.enabled = updates.enabled;

    if (updates.monthlyQuotaTokens !== undefined) {
      payload.monthlyQuotaTokens = updates.monthlyQuotaTokens;
    }

    if (updates.allowedCategories !== undefined) {
      payload.allowedCategories = updates.allowedCategories;
    }

    // 36.7 — the language list. The MODEL refuses an empty list and a list
    // without English, so that rule is enforced in one place rather than
    // repeated in the UI where it could be bypassed.
    if (updates.languages !== undefined) {
      payload.languages = updates.languages;
    }

    const response = bare(await api.put('/ai/config', payload));

    return response?.config || null;
  } catch (error) {
    throw normalizeError(error);
  }
};

export default {
  askHRAssistant,
  getAiUsage,
  getChatLanguages,
  getAiConfig,
  updateAiConfig,
};
