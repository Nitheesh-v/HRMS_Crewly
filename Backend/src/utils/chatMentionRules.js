// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 34.3 — MENTION RULES (pure, no I/O)
//
//  One definition of what a mention IS, shared by the socket validator and the
//  service, so the wire rules and the stored rules cannot drift.
//
//  MENTIONS ARE STRUCTURED, NEVER PARSED
//    The client sends user ids; the server never guesses who "@something" means.
//    Name-based parsing would need a name→user lookup (an enumeration surface:
//    "does a user called X exist in this company?") and would be ambiguous the
//    moment two people share a first name. The text is still what the reader
//    sees — the token below is derived FROM the resolved user, so the highlight
//    can never point at somebody the server did not validate.
//
//  THE VISIBILITY RULE
//    A mention counts only if its token really appears in the body. Without
//    that rule a client could attach a userId to a message that mentions nobody,
//    producing a SILENT PING: a notification about text that does not mention
//    you. So an invisible mention is dropped, while an id that is not a member
//    of this conversation is refused outright (see chatMentionService).
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

/** A message can address at most this many people. Bounded fan-out, bounded noise. */
export const CHAT_MENTION_MAX_PER_MESSAGE = 10;

/** The stored token is the visible '@Name' fragment. Bounded like a display name. */
export const CHAT_MENTION_TOKEN_MAX = 120;

/**
 * The exact visible token for one user: '@' + display name.
 *
 * Derived server-side from the resolved user, never taken from the payload —
 * a client cannot fabricate a token that highlights somebody else, and cannot
 * smuggle markup into a highlighted span (rendering is a text node either way).
 */
export const mentionTokenFor = (name) => {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim();

  return clean ? `@${clean}`.slice(0, CHAT_MENTION_TOKEN_MAX) : null;
};

/**
 * Is that token actually visible in the body?
 *
 * Case-sensitive and literal on purpose: the token is inserted verbatim by the
 * autocomplete, and a case-insensitive match would let "@MANIKANDAN" count as a
 * mention of "Manikandan" while the reader sees something else.
 */
export const tokenAppearsInText = (text, token) =>
  Boolean(token) && String(text ?? '').includes(token);

/**
 * Shape-check the wire value: absent/null → no mentions; otherwise an array of
 * at most CHAT_MENTION_MAX_PER_MESSAGE valid ObjectIds, de-duplicated.
 *
 * Returns { ok, ids } | { ok:false, message } — the caller turns a refusal into
 * VALIDATION_ERROR before any database work happens.
 */
export const parseMentionIds = (raw) => {
  if (raw === undefined || raw === null) return { ok: true, ids: [] };

  if (!Array.isArray(raw)) {
    return { ok: false, message: 'mentions must be a list of user ids.' };
  }

  const ids = raw.map((value) => String(value ?? '').trim());

  if (ids.some((value) => !mongoose.isValidObjectId(value))) {
    return { ok: false, message: 'mentions contains an invalid user id.' };
  }

  const unique = [...new Set(ids)];

  if (unique.length > CHAT_MENTION_MAX_PER_MESSAGE) {
    return {
      ok: false,
      message: `A message can mention at most ${CHAT_MENTION_MAX_PER_MESSAGE} people.`,
    };
  }

  return { ok: true, ids: unique };
};
