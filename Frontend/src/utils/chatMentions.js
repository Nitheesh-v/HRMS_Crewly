// PHASE 34.3 — mention helpers (client mirror of the server rules).
//
// The SERVER is the authority: it decides who may be mentioned, derives the
// stored token, and refuses or drops anything invalid. These helpers only make
// the composer ergonomic — finding the '@query' under the caret, inserting the
// token, and reading back which mentions are still visible in the text.
//
// No new dependency: the detection is a caret scan, not a regex library.

export const CHAT_MENTION_MAX_PER_MESSAGE = 10;

/** Longest token the server will store (mirrors chatMentionRules.js). */
export const CHAT_MENTION_TOKEN_MAX = 120;

/**
 * The '@query' being typed right before the caret, or null.
 *
 * Deliberately conservative: a query stops at whitespace, so "@Alice Rao" is
 * found as "@Alice" the moment a space is typed — which is exactly how the
 * autocomplete keeps filtering until the user picks a name. A second '@' and
 * newlines end the query too.
 */
export const mentionQueryAt = (text, caret) => {
  const value = String(text ?? '');
  const end = Number.isFinite(caret) ? caret : value.length;

  const upto = value.slice(0, end);
  const at = upto.lastIndexOf('@');

  if (at < 0) return null;

  // A mention starts at a word boundary, so an email ("boss@company") is not
  // a mention trigger.
  const before = at > 0 ? upto[at - 1] : '';
  if (before && !/\s/.test(before)) return null;

  const query = upto.slice(at + 1);

  if (query.includes('@') || /[\n\r]/.test(query) || /\s{2,}/.test(query)) return null;

  return { start: at, end, query: query.trim() };
};

/** Suggestions for the query, members only, me excluded, name-matched. */
export const mentionSuggestions = ({ members = [], query = '', meId = null }) => {
  const needle = String(query ?? '').toLowerCase();

  return (members ?? [])
    .filter((member) => member?.userId && String(member.userId) !== String(meId ?? ''))
    .map((member) => ({
      userId: String(member.userId),
      name: String(member.user?.name ?? member.name ?? '').trim(),
    }))
    .filter((member) => member.name.length > 0)
    .filter((member) => (needle ? member.name.toLowerCase().includes(needle) : true))
    .slice(0, 8);
};

/** The exact visible token for a name — the same shape the server stores. */
export const mentionTokenFor = (name) =>
  String(name ?? '').replace(/\s+/g, ' ').trim()
    ? `@${String(name).replace(/\s+/g, ' ').trim()}`.slice(0, CHAT_MENTION_TOKEN_MAX)
    : null;

/**
 * Strip the token at [start, end) and put its replacement in, returning the
 * next text plus where the caret should land.
 */
export const insertMention = ({ text, start, end, token }) => {
  const value = String(text ?? '');
  const before = value.slice(0, start);
  const after = value.slice(end);
  const insert = `${token} `;

  return { text: `${before}${insert}${after}`, caret: before.length + insert.length };
};

/**
 * Reconcile the picked mentions against the text being sent: only mentions
 * whose token is still visible are sent. (The server drops invisible ones
 * anyway — this just avoids asking it to.)
 */
export const visibleMentionIds = (mentions = [], text = '') =>
  (mentions ?? [])
    .filter((mention) => mention?.token && String(text ?? '').includes(mention.token))
    .map((mention) => String(mention.userId));
