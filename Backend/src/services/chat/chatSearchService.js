// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 34.4 — CHAT SEARCH (conversation-scoped, bounded, tombstone-safe)
//
//  WHAT THIS SEARCHES
//    TEXT messages of ONE conversation the caller is a member of. Not
//    attachments (their bytes are private storage, their names are not a body),
//    not deleted messages (the tombstone IS the redaction), and never another
//    conversation — v1 is deliberately conversation-scoped.
//
//  WHY REGEX AND NOT $text
//    Mongo allows ONE text index per collection and it cannot serve substring
//    matching ("rev" would not find "review"), so a text index would trade a
//    write-tax on every message for a search that still does not answer the
//    question people actually ask. Instead: an escaped, literal regex applied
//    over a BOUNDED window — the conversation's own
//    (companyId, conversationId, seq desc) index serves the range scan and the
//    sort, and `type` / `deletedAt` are cheap filters on top. Bounded by limit
//    and by the cursor; no new index, no new dependency, no second collection.
//
//  TENANCY + MEMBERSHIP
//    Same gate as history: ChatConversation.findOne({ _id, companyId,
//    'members.userId' }). A non-member — including a user from another tenant —
//    gets NOT_FOUND_OR_FORBIDDEN, which the controller reports as a 404. The
//    query itself also carries companyId, so a bug in the gate still cannot
//    cross a tenant boundary.
//
//  NO CONTENT IN LOGS
//    The query string is user content. Nothing on this path logs it: no
//    console call, no logger call, no error field. The controller's error path
//    only ever carries the rule message, never the term.
// ═══════════════════════════════════════════════════════════════════════════

import ChatConversation from '../../models/ChatConversation.js';
import ChatMessage from '../../models/ChatMessage.js';
import {
  buildSnippet,
  clampSearchLimit,
  escapeRegExp,
  normalizeSearchQuery,
} from '../../utils/chatSearchRules.js';

/**
 * THE READ GATE — the same question chatThreadService asks, answered locally
 * for the same two reasons: a disabled conversation stays READABLE (search is a
 * read, and the lock law promises history stays visible), and a module-local
 * gate avoids importing the conversation service into a read path that only
 * needs one query.
 *
 * A non-member and a user from another tenant both come back null, so they are
 * indistinguishable downstream.
 */
const loadReadableConversation = async ({ companyId, userId, conversationId }) =>
  (await ChatConversation.findOne({
    _id: conversationId,
    companyId,
    'members.userId': userId,
  }).lean()) ?? null;

/**
 * One page of matches, newest first.
 *
 * Returns { ok:false, code:'VALIDATION_ERROR', message } for a query that
 * breaks the bounds, and { ok:false, code:'NOT_FOUND_OR_FORBIDDEN' } when the
 * conversation is not the caller's (the same shape a missing conversation
 * produces — search must not become a way to probe which rooms exist).
 */
export const searchConversationMessages = async ({
  companyId,
  userId,
  conversationId,
  q,
  cursor,
  limit,
}) => {
  const normalized = normalizeSearchQuery(q);

  if (!normalized.ok) {
    return { ok: false, code: 'VALIDATION_ERROR', message: normalized.message };
  }

  const conversation = await loadReadableConversation({ companyId, userId, conversationId });

  if (!conversation) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

  const pageSize = clampSearchLimit(limit);

  const filter = {
    companyId,
    conversationId,
    // Only real bodies. A FILE caption is a body too, but the type rule keeps
    // the search to what the UI calls a message.
    type: 'TEXT',
    // The tombstone is the redaction: a deleted message must never be
    // discoverable, not even by its old words.
    deletedAt: null,
    // Escaped: the pattern can only match the literal text the person typed.
    text: { $regex: escapeRegExp(normalized.q), $options: 'i' },
  };

  if (Number.isFinite(cursor) && cursor > 0) filter.seq = { $lt: Number(cursor) };

  const rows = await ChatMessage.find(filter)
    .select('_id seq senderUserId text createdAt threadRootMessageId replyToMessageId')
    .sort({ seq: -1 })
    // +1 probe: hasMore without a second query, exactly like history.
    .limit(pageSize + 1)
    .lean();

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const last = page[page.length - 1];

  return {
    ok: true,
    conversationId,
    q: normalized.q,
    items: page.map((row) => ({
      _id: row._id,
      seq: row.seq,
      senderUserId: row.senderUserId,
      // Context, not the message: a bounded window around the match.
      textSnippet: buildSnippet(row.text, normalized.q),
      createdAt: row.createdAt ?? null,
      // Thread metadata so the UI can offer the thread for a reply, or jump
      // straight to the message for a top-level one.
      threadRootMessageId: row.threadRootMessageId ?? null,
      replyToMessageId: row.replyToMessageId ?? null,
    })),
    nextCursor: hasMore && last ? last.seq : null,
    hasMore,
    limit: pageSize,
  };
};
