// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 34.4 — CHAT SEARCH RULES (pure, no I/O)
//
//  CONVERSATION-SCOPED ONLY. v1 searches inside ONE conversation the caller is
//  already a member of: a tenant-wide "search all chats" surface would need its
//  own permission review, its own result-ranking story and its own leak
//  analysis, and none of that is in this unit.
//
//  THE QUERY IS UNTRUSTED TEXT, AND IT BECOMES A REGEX
//    So it is ESCAPED, always, before it reaches Mongo. Without escaping a
//    search for "a+b" would mean "one or more a's followed by b" (a different
//    query), and ".*.*.*.*x" would turn a bounded conversation scan into a
//    pathological one. Escaping makes every query literal, which is also what
//    a person typing into a search box expects.
//
//  BOUNDS ARE PART OF THE CONTRACT, NOT DECORATION
//    · q shorter than 2 characters matches nearly everything, which is a scan
//      with extra steps — refused with a clear rule instead.
//    · q longer than 64 characters is not a search, it is a paste — refused by
//      the same rule, before anything touches the database.
//    · the page size is clamped so one request can never ask for the archive.
// ═══════════════════════════════════════════════════════════════════════════

export const CHAT_SEARCH_MIN_QUERY = 2;
export const CHAT_SEARCH_MAX_QUERY = 64;

export const CHAT_SEARCH_LIMIT_DEFAULT = 10;
export const CHAT_SEARCH_LIMIT_MAX = 20;

/** How much of a matching message the result shows. Bounded, always. */
export const CHAT_SEARCH_SNIPPET_MAX = 160;
export const CHAT_SEARCH_SNIPPET_LEAD = 40;

export const CHAT_SEARCH_MESSAGES = Object.freeze({
  TOO_SHORT: `Type at least ${CHAT_SEARCH_MIN_QUERY} characters to search.`,
  TOO_LONG: `A search is at most ${CHAT_SEARCH_MAX_QUERY} characters.`,
});

/**
 * Escape every regex metacharacter, so the pattern can only ever match the
 * literal text the person typed.
 */
export const escapeRegExp = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Normalize + bound a search query.
 *
 * Returns { ok:true, q } or { ok:false, message } — the caller turns a refusal
 * into a 400 with the rule, before any database work. The query is NEVER
 * logged anywhere on this path.
 */
export const normalizeSearchQuery = (raw) => {
  const q = String(raw ?? '').replace(/\s+/g, ' ').trim();

  if (q.length < CHAT_SEARCH_MIN_QUERY) {
    return { ok: false, message: CHAT_SEARCH_MESSAGES.TOO_SHORT };
  }

  if (q.length > CHAT_SEARCH_MAX_QUERY) {
    return { ok: false, message: CHAT_SEARCH_MESSAGES.TOO_LONG };
  }

  return { ok: true, q };
};

/** Page size, clamped. A missing/NaN limit means the documented default. */
export const clampSearchLimit = (value) => {
  const limit = Number(value);

  if (!Number.isFinite(limit) || limit < 1) return CHAT_SEARCH_LIMIT_DEFAULT;

  return Math.min(Math.floor(limit), CHAT_SEARCH_LIMIT_MAX);
};

/**
 * A bounded snippet around the first match.
 *
 * The result list needs CONTEXT, not the message. Returning the full body would
 * turn a 20-row result page into a 20-message payload, and it would put text
 * (including text scrolled far past the match) into a response that exists to
 * point at a message. So: a window around the hit, with ellipses showing which
 * side was cut.
 */
export const buildSnippet = (text, query) => {
  const body = String(text ?? '');

  if (body.length === 0) return '';

  const at = body.toLowerCase().indexOf(String(query ?? '').toLowerCase());

  if (at < 0) {
    // Should not happen for a stored match, but a defensive bounded prefix is
    // better than echoing the whole body.
    return body.length > CHAT_SEARCH_SNIPPET_MAX
      ? `${body.slice(0, CHAT_SEARCH_SNIPPET_MAX)}…`
      : body;
  }

  const start = Math.max(0, at - CHAT_SEARCH_SNIPPET_LEAD);
  const end = Math.min(body.length, start + CHAT_SEARCH_SNIPPET_MAX);

  const slice = body.slice(start, end);

  return `${start > 0 ? '…' : ''}${slice}${end < body.length ? '…' : ''}`;
};
