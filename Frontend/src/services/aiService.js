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
 *          categories?: string[]}} payload
 * @returns {Promise<{reply: string, usage: object|null, categoriesUsed: string[]}>}
 */
export const askHRAssistant = async ({ messages, categories } = {}) => {
  try {
    const payload = { messages };

    // Omit the key entirely rather than sending an empty array, which the
    // validator would accept as "narrow to nothing".
    if (Array.isArray(categories) && categories.length > 0) {
      payload.categories = categories;
    }

    const response = bare(await api.post('/ai/chatbot', payload));

    return {
      reply: typeof response?.reply === 'string' ? response.reply : '',
      usage: response?.usage ?? null,
      categoriesUsed: Array.isArray(response?.categoriesUsed)
        ? response.categoriesUsed
        : [],
    };
  } catch (error) {
    throw normalizeError(error);
  }
};

export default { askHRAssistant };
