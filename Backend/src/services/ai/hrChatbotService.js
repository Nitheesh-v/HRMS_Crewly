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

import {
  AI_CHATBOT_HISTORY_LIMIT,
  AI_DEFAULT_LANGUAGE,
  AI_DEEP_LINKS,
  AI_DEEP_LINK_ORDER,
  AI_FEATURE_CHATBOT,
  AI_FOLLOW_UP_FALLBACKS,
  AI_FOLLOW_UP_MAX,
  AI_LANGUAGE_LABELS,
  normalizeLanguage,
} from './aiConfig.js';

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
3. If the answer is NOT in the context, do NOT guess. You may say you do not have it, but a bare refusal is not enough — rule 14 requires you to follow it with something useful.
4. NEVER invent leave balances, policies, holidays, or employee data.
5. NEVER reveal or repeat sensitive personal identifiers (Aadhaar, PAN, mobile numbers, bank accounts). If you see [REDACTED] placeholders, treat them as intentionally hidden.
6. NEVER offer to take actions on behalf of the employee (you cannot apply for leave, punch attendance, or update records).
7. Be polite and empathetic. This is a workplace assistant.
8. "NONE" IS AN ANSWER. When a line says "none", "NO_RECORD" or "no ... assigned", that is a real, confirmed fact about this employee - state it plainly and helpfully. Example: the context says "Shift: none assigned to you", so answer "You do not have a shift assigned to you yet." NEVER say you lack information when the context names the answer, including when the answer is that nothing exists.
9. "UNAVAILABLE" IS NOT AN ANSWER. When a line says "(something unavailable)", the system could not READ that section. Say you could not retrieve it and suggest contacting HR. Do not guess what it would have said, and do not treat it as "none".
10. "HOW DO I..." QUESTIONS ARE ANSWERED FROM THE CAPABILITY LIST. When the employee asks how to do something — apply for leave, punch in, claim an expense, fix a missed punch, upload a document — answer from the "What This Assistant Can Help You Do" section. That section is complete for this product, so the answer is there. Never tell the employee a screen or a step exists if it is not in that section.
11. NAME YOUR SOURCE. When you give an answer drawn from the context, say which section it came from, in plain words (for example "your leave balances show" or "your task list shows"). If you could not find the answer in any section, say that plainly instead of implying you checked.
12. NEVER STATE A SALARY FIGURE. The context deliberately carries no net pay, gross pay or deduction amounts. If the employee asks for a figure, say the amount is not shared with the assistant by design and point them to My Payslips. Do not estimate, do not repeat a placeholder such as [AMOUNT_REDACTED] as if it were a number, and do not offer to look it up.
13. YOU ONLY KNOW THIS EMPLOYEE. The context is the caller's own records, plus counts where their role allows it. A count is not a person: never turn "3 people are on leave today" into a name, and never speculate about a colleague's leave, salary, attendance or performance. If asked about someone else, say you only have access to their own records.
14. WHEN YOU CANNOT ANSWER, STILL BE USEFUL. A bare "I do not have that information" is a dead end, so instead give THREE things in this order: (a) say plainly that you do not have that; (b) give the closest thing you DO have — a related section from the context, or the screen where the answer lives, or the person who owns it; (c) if neither applies, say what the employee can do next. Worked example: asked "what is my bonus for last year?" — "I do not have your bonus figures. What I can see is that you have payslips for the months listed above, so the bonus would appear on your December payslip under My Payslips. If it is missing there, your payroll team can confirm it." Worked example: asked "what is my manager's salary?" — "I only have access to your own records, so I cannot see anyone else's salary." HARD LIMIT: (b) must come from the context or the capability list as written. Never estimate, never invent a number, never name a person, and never present a guess as a fact. Rule 4 still wins over rule 14.

{followUpRule}

{languageRule}

=== EMPLOYEE HR CONTEXT ===
{retrievedContext}
=== END CONTEXT ===`;

/**
 * Rule 15 — the language instruction (Phase 36.5).
 *
 * Built as a SEPARATE string rather than a fifteenth line of the template
 * for one reason: English is the base case and must not carry the rule at
 * all. A template that always contained it would spend tokens on every
 * English turn telling the model to reply in English, and the 36.3 owner
 * measured a full turn at ~556 tokens against a 1024 ceiling.
 *
 * Everything else about the prompt is untouched, so a language change can
 * never weaken a rule 1-14 guarantee.
 */
const buildLanguageRule = (languageLabel) =>
  '16. REPLY IN THE LANGUAGE THE EMPLOYEE CHOSE: ' +
  languageLabel +
  '. Write your whole answer in that language and that script, using the '
  + " employee's own words for their HR terms. Keep JSON field names, "
  + 'proper nouns (Crewly), and any code or identifier exactly as they are. '
  + 'If the employee mixes two languages, match the mix. Never answer in a '
  + 'language the employee did not choose, and never translate an HR figure.';

/**
 * The follow-up instruction (Phase 36.6).
 *
 * ALWAYS present, unlike the language rule: it is not a preference, it is
 * how the UI gets its suggestion chips. Kept short on purpose — every
 * token here is spent on every English turn too, and the owner measured a
 * full turn at ~556 tokens against a 1024 ceiling.
 *
 * The marker is a fixed, machine-readable token so the parser has one
 * shape to look for. A model that ignores it costs nothing: the parser
 * falls back to the deterministic suggestions and the reply is simply
 * shown without chips.
 */
const FOLLOW_UP_RULE =
  '15. IF IT HELPS, END WITH 2 SHORT FOLLOW-UP QUESTIONS the employee ' +
  'might ask next, on ONE final line, in exactly this shape: ' +
  '"Follow-up: <question one> | <question two>". Ask about things the ' +
  'context above can actually answer. If nothing useful follows, omit ' +
  'the line entirely. Never invent a question the context cannot answer.';

const buildSystemPrompt = (retrievedContext, languageLabel) =>
  SYSTEM_PROMPT_TEMPLATE
    .replace(
      '{languageRule}',
      languageLabel ? '\n' + buildLanguageRule(languageLabel) : '',
    )
    .replace(
      '{followUpRule}',
      '\n' + FOLLOW_UP_RULE,
    )
    .replace(
      '{retrievedContext}',
      typeof retrievedContext === 'string' ? retrievedContext : '',
    );

/**
 * Phase 36.6 — the navigational deep links for a turn.
 *
 * Built from the categories the RETRIEVER actually filled, never from the
 * model. A model-chosen path would be a model-chosen action, and no model
 * output is allowed to move this product.
 *
 * Deduplicated and ordered by AI_DEEP_LINK_ORDER, so two turns that used
 * the same categories always produce the same chips in the same order.
 *
 * @param {string[]} categoriesUsed
 * @returns {Array<{label: string, path: string}>}
 */
export const buildDeepLinks = (categoriesUsed) => {
  if (!Array.isArray(categoriesUsed)) return [];

  const used = new Set(categoriesUsed);

  const seen = new Set();

  // Deliberately written with array methods and NO loop. Two reasons.
  //
  // The first is that it reads better for a four-element ordered list. The
  // second is the one that matters: test/hrChatbotService.test.js pins
  // this module as loop-free to prove there is no agent behaviour — no
  // retry, no "ask the model again" cycle. Writing this as a counted loop
  // would trip that pin, and the pin is protecting a real law.
  return AI_DEEP_LINK_ORDER.filter((category) => used.has(category))
    .map((category) => AI_DEEP_LINKS[category])
    .filter((link) => Boolean(link))
    .filter((link) => {
      if (seen.has(link.path)) return false;

      seen.add(link.path);

      return true;
    })
    .map((link) => ({ label: link.label, path: link.path }));
};

/**
 * Phase 36.6 — pull the follow-up questions out of the model's reply.
 *
 * TWO THINGS THIS MUST GET RIGHT, and the second is the one that matters.
 *
 * 1. The marker line is STRIPPED from the reply the employee reads. A raw
 *    "Follow-up: ..." line leaking into the answer is a bug the person would
 *    notice immediately.
 *
 * 2. Nothing is ever INVENTED. When the model supplies nothing usable, the
 *    fallback is the static, known-answerable list in AI_FOLLOW_UP_FALLBACKS
 *    — never a generated guess. Rule 4 (never invent) and rule 14's hard
 *    limit still win over the convenience of a full chip row.
 *
 * Tolerant by design: the marker is matched case-insensitively, the
 * separator may be a pipe with or without padding, and a stray bracket
 * pair is stripped. A model that formats it slightly differently still
 * works; a model that omits it costs nothing.
 *
 * @param {string}   reply
 * @param {string[]} categoriesUsed
 * @returns {{cleanReply: string, questions: string[]}}
 */
export const parseFollowUps = (reply, categoriesUsed) => {
  const text = typeof reply === 'string' ? reply : '';

  const lines = text.split('\n');

  const kept = [];

  const found = [];

  // True as soon as ANY marker line matches, even one that yields no
  // usable question. Without this, a malformed "Follow-up:" line would
  // stay visible in the answer the employee reads.
  let sawMarker = false;

  // A single pass, so a reply with several candidate lines keeps them all
  // but never duplicates one.
  lines.forEach((line) => {
    // `(.*)` and not `(.+)`. A model that emits a bare "Follow-up:" with
    // nothing after it must still have that line STRIPPED from the answer:
    // it is a prompt artefact, not content. With `(.+)` the line never
    // matched, so `sawMarker` never fired and the marker stayed visible.
    // The empty case is what the 36.6 test "an EMPTY marker leaks nothing"
    // pins.
    const match = /^\s*follow[- ]?ups?\s*:\s*(.*)$/i.exec(line);

    if (!match) {
      kept.push(line);

      return;
    }

    sawMarker = true;

    // ' | ' is the documented separator, but a model that pads differently
    // or uses a bare pipe should not break the feature.
    match[1].split('|').forEach((part) => {
      const cleaned = part
        .trim()
        // The prompt's own template shows the questions in brackets. They
        // are placeholders, not literal characters.
        .replace(/^\[\s*/, '')
        .replace(/\s*\]$/, '')
        .replace(/^['\"]+|['\"]+$/g, '')
        .trim();

      if (cleaned.length > 0) found.push(cleaned);
    });
  });

  const capped = found.slice(0, AI_FOLLOW_UP_MAX);

  if (capped.length > 0) {
    // The marker line is gone; what is left is the answer.
    return { cleanReply: kept.join('\n').trim(), questions: capped };
  }

  // Deterministic fallback. Every string in AI_FOLLOW_UP_FALLBACKS is a
  // static question the retriever can actually answer, which is the same
  // rule chatPrompts.js enforces for the quick-prompt pills.
  const fallback = [];

  const seen = new Set();

  (Array.isArray(categoriesUsed) ? categoriesUsed : []).forEach(
    (category) => {
      const suggestions = AI_FOLLOW_UP_FALLBACKS[category];

      if (!suggestions) return;

      suggestions.forEach((question) => {
        const key = question.toLowerCase();

        if (seen.has(key)) return;

        seen.add(key);

        fallback.push(question);
      });
    },
  );

  return {
    // When a marker was present but unusable, the marker line is still
    // stripped: it is a formatting artefact, not content. When there was
    // no marker at all, the reply is returned exactly as written.
    cleanReply: sawMarker ? kept.join('\n').trim() : text.trim(),
    questions: fallback.slice(0, AI_FOLLOW_UP_MAX),
  };
};

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
 * @returns {Promise<{reply: string, usage: object, categoriesUsed: string[],
 *   followUpQuestions: string[], deepLinks: Array<{label: string, path: string}>}>}
 */
export const askHRAssistant = async ({
  companyId,
  userId,
  messages,
  categories,
  language,
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
  //
  // The language is resolved HERE, once, and normalized silently: an
  // unknown or missing value becomes English rather than an error. The
  // validator already refuses an unsupported language with a 400, so this
  // is the defence in depth for a direct caller, and failing a question
  // over a cosmetic preference would be the wrong trade.
  //
  // This is a PREFERENCE and nothing more. It changes how the answer is
  // phrased, never what the caller is allowed to read — the context was
  // already scoped in STEP 2 and is not touched here.
  const resolvedLanguage = normalizeLanguage(language);

  // English needs no instruction at all, hence the empty label.
  const languageLabel =
    resolvedLanguage === AI_DEFAULT_LANGUAGE
      ? ''
      : AI_LANGUAGE_LABELS[resolvedLanguage];

  const systemPrompt = buildSystemPrompt(context, languageLabel);

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
  //
  // Phase 36.6 adds two fields, and both are derived from things this
  // function already knows:
  //
  //   followUpQuestions — parsed out of the model's own reply, or the
  //     deterministic fallback. Never invented.
  //   deepLinks — built from categoriesUsed, which is server-derived
  //     truth. Never from the model.
  //
  // Neither is persisted anywhere. They live for one HTTP response.
  const { cleanReply, questions } = parseFollowUps(
    String(response?.content ?? ''),
    categoriesUsed,
  );

  return {
    // The reply the employee reads, with the marker line stripped.
    reply: cleanReply,
    usage: response?.usage ?? null,
    categoriesUsed: Array.isArray(categoriesUsed) ? categoriesUsed : [],

    // 2-3 short next questions, or the static fallback.
    followUpQuestions: questions,

    // Navigation only. The assistant never performs an action.
    deepLinks: buildDeepLinks(categoriesUsed),
  };
};

export default askHRAssistant;
