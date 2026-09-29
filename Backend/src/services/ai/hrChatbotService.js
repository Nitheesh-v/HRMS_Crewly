// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 36.3 — HR CHATBOT SERVICE (one turn, one call, no agents)
//
//  WHAT THIS MODULE IS
//    The seam between 36.2's context retriever and 36.1's vendor call. It
//    takes a conversation, prepends a server-owned system prompt carrying the
//    employee's own redacted HR context, and makes ONE vendor call.
//
//  ONE CALL PER TURN, BY DESIGN (Phase 36 §2)
//    No multi-step agent loop, no follow-up tool calls, no second model call
//    to "check" the first. The AI receives everything it needs in a single
//    payload and returns one string. That is what keeps the cost bounded, the
//    audit trail one row per turn, and the failure modes countable.
//
//  THE SYSTEM PROMPT IS SERVER-OWNED
//    The client sends user/assistant turns only. 'system' is refused at the
//    validator, because a client that could write the system prompt could
//    instruct the model to ignore the HR context or to invent data.
//
//  WHAT NEVER LEAVES THE SERVER
//    The assembled payload (system prompt + history + context) is passed to
//    the vendor and to nothing else. The caller receives { reply, usage,
//    categoriesUsed } — never the context, never the prompt.
//
//  PII
//    Two independent layers, deliberately:
//      1. the context is ALREADY redacted by 36.2's retriever;
//      2. every USER turn is redacted HERE again, because a person can type
//         their Aadhaar number into a chat box no matter what the UI says.
//    Assistant turns are NOT re-redacted: they are model output derived from
//    already-redacted input, and re-redacting them would corrupt a legitimate
//    answer that happens to quote a masked placeholder.
// ═══════════════════════════════════════════════════════════════════════════

import { AI_CHATBOT_HISTORY_LIMIT, AI_FEATURE_CHATBOT } from './aiConfig.js';

import { redactPII } from './piiRedactor.js';

import { getUserHRContext } from './hrContextRetriever.js';

import { aiChat } from './aiProvider.js';

/**
 * The system prompt. Written as one template string so a test can assert the
 * rules are present VERBATIM — a prompt that drifted silently would be an
 * instruction the product never approved.
 */
export const SYSTEM_PROMPT_TEMPLATE = `You are the Crewly HR Assistant, a helpful and professional AI assistant embedded in the Crewly HR platform.

Your job is to answer the employee's HR questions using ONLY the information provided in the Employee HR Context below.

Rules you must follow:
1. Answer concisely and clearly. Use plain language.
2. If the answer is in the context, give it directly.
3. If the answer is NOT in the context, say "I do not have that information. Please contact your HR team." Do NOT guess.
4. NEVER invent leave balances, policies, holidays, or employee data.
5. NEVER reveal or repeat sensitive personal identifiers (Aadhaar, PAN, mobile numbers, bank accounts). If you see [REDACTED] placeholders, treat them as intentionally hidden.
6. NEVER offer to take actions on behalf of the employee (you cannot apply for leave, punch attendance, or update records).
7. Be polite and empathetic. This is a workplace assistant.

=== EMPLOYEE HR CONTEXT ===
{retrievedContext}
=== END CONTEXT ===`;

const buildSystemPrompt = (retrievedContext) =>
  SYSTEM_PROMPT_TEMPLATE.replace(
    '{retrievedContext}',
    typeof retrievedContext === 'string' ? retrievedContext : '',
  );

/**
 * Redact every USER turn, leave assistant turns alone.
 *
 * Returns a NEW array — the caller's history is React state, and mutating it
 * here would corrupt the conversation the person is still reading.
 */
const redactHistory = (messages, redact) =>
  messages.map((message) => {
    if (message?.role !== 'user') return message;

    return { ...message, content: redact(String(message.content ?? '')) };
  });

/**
 * One conversational turn.
 *
 * @param {object}   input
 * @param {string}   input.companyId   SERVER-DERIVED tenant authority
 * @param {string}   input.userId      SERVER-DERIVED caller (req.user._id)
 * @param {Array}    input.messages    [{role: 'user'|'assistant', content}]
 * @param {string[]} [input.categories] optional narrowing of the tenant allowlist
 * @param {object}   [input.deps]      DI seam: aiChat / getUserHRContext / redactPII
 *
 * @returns {Promise<{reply: string, usage: object, categoriesUsed: string[]}>}
 */
export const askHRAssistant = async ({
  companyId,
  userId,
  messages,
  categories,
  deps = {},
} = {}) => {
  const {
    aiChatFn = aiChat,
    getContextFn = getUserHRContext,
    redact = redactPII,
  } = deps;

  // Identity is never optional and never overridable, exactly as in 36.2.
  if (!companyId || !userId) {
    throw new Error('askHRAssistant requires companyId and userId');
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('askHRAssistant requires at least one message');
  }

  // STEP 1 — cap the history FIRST, before anything else is computed.
  //
  // `slice(-n)` keeps the LAST n in chronological order, so the oldest turns
  // are the ones dropped and the most recent exchange always survives. Doing
  // this before the context fetch matters for a second reason: the context
  // string is rebuilt on every turn anyway, so an old turn is pure overhead.
  const capped = messages.slice(-AI_CHATBOT_HISTORY_LIMIT);

  // STEP 2 — the employee's own authorized, redacted HR context.
  //
  // A failure here PROPAGATES. 36.2 wraps a tenant-config read failure as
  // AI_CONFIG_READ_FAILED, and answering an HR question with no context at all
  // would invite the model to guess — which is precisely what rule 4 forbids.
  // Partial context (one section unavailable) is fine and expected: 36.2 ships
  // partial results by design, and a missing announcement list must not stop
  // the employee learning their leave balance.
  const { context, categoriesUsed } = await getContextFn({
    companyId,
    userId,
    categories,
  });

  // STEP 3 — the server-owned system prompt.
  const systemPrompt = buildSystemPrompt(context);

  // STEP 4 — redact every user turn (the context is already redacted by 36.2).
  const history = redactHistory(capped, redact);

  // STEP 5 — the vendor payload: one system message, then the history.
  const payload = [{ role: 'system', content: systemPrompt }, ...history];

  // STEP 6 — ONE call, through the 36.1 choke point. Every guard (global and
  // per-tenant kill switch, rate limit, quota, redaction, vendor-error
  // opacity, usage recording) runs inside aiChat, so this module adds no
  // second copy of any of them.
  const response = await aiChatFn({
    messages: payload,
    companyId,
    userId,
    feature: AI_FEATURE_CHATBOT,
  });

  // STEP 7 — what the browser gets. The context and the prompt stay here.
  return {
    reply: String(response?.content ?? ''),
    usage: response?.usage ?? null,
    categoriesUsed: Array.isArray(categoriesUsed) ? categoriesUsed : [],
  };
};

export default askHRAssistant;
