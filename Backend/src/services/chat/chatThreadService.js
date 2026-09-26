// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 34.2 — CHAT THREADS (read path + reply resolution)
//
//  A thread is a QUERY, not a document. The root message carries
//  threadRootMessageId = null; every reply carries the root's id there and its
//  immediate parent in replyToMessageId. That keeps storage flat (no child
//  arrays to grow, no counters to drift) and makes the whole unit two fields
//  and one index on ChatMessage.
//
//  WHAT LIVES HERE
//    · listThreadMessages  — the REST read behind GET …/threads/:rootMessageId
//    · resolveReplyTarget  — "may this message be replied to, and by whom?"
//    · summarizeThreadCounts / loadReplyPreviews — the two bounded page-level
//      lookups the history projection needs (one query each, never one per row)
//
//  TENANCY + MEMBERSHIP
//    Authority ({ companyId, userId }) comes from the authenticated request.
//    The conversation is loaded with BOTH the tenant and the member filter, so
//    a non-member — including a user from another tenant — gets
//    NOT_FOUND_OR_FORBIDDEN and never learns whether the id exists. The root
//    message is then loaded with companyId AND conversationId for the same
//    reason: an id from another room must read as "not found", not as "found
//    but forbidden".
//
//  LOCK LAW (unchanged from 33.9)
//    A disabled conversation stays READABLE. This module never refuses on
//    isDisabled — refusing here would hide history that the lock explicitly
//    promises to keep. Sending a reply is a WRITE and is refused earlier, in
//    the message service, by the same gate as every other write.
//
//  NO SURVEILLANCE
//    Nothing here records when a user read a thread, whether they follow it,
//    or that they are looking at it. Opening a thread is a read; the read
//    cursor stays the C1 per-member lastReadSeq on the conversation.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import ChatConversation from '../../models/ChatConversation.js';
import ChatMessage from '../../models/ChatMessage.js';

export const CHAT_THREAD_LIMIT_DEFAULT = 20;
export const CHAT_THREAD_LIMIT_MAX = 50;

// One reply preview is a CONTEXT HINT, not a copy of the parent. Long parents
// are truncated here — the message itself is a scroll away.
export const CHAT_REPLY_PREVIEW_MAX = 120;

const asId = (value) =>
  mongoose.isValidObjectId(String(value ?? '')) ? new mongoose.Types.ObjectId(String(value)) : null;

/**
 * The bounded, tombstone-safe preview a reply shows above its own body:
 * "Replying to <sender>: <snippet>". A deleted or body-less parent yields a
 * NULL snippet — the text is gone by then, and a preview must never resurrect
 * it. `messageId` + `senderUserId` alone let the UI name who is being answered.
 */
export const toReplyPreview = (parent) => {
  if (!parent) return null;

  const text = parent.deletedAt ? null : parent.text ?? null;

  return {
    messageId: parent._id,
    senderUserId: parent.senderUserId ?? null,
    snippet: text ? String(text).slice(0, CHAT_REPLY_PREVIEW_MAX) : null,
    deletedAt: parent.deletedAt ?? null,
  };
};

/**
 * Resolve a message a caller asked to REPLY to. Returns the parent document
 * fields the write path needs, or null when the id is not a message of THIS
 * tenant and THIS conversation (the caller maps null to
 * NOT_FOUND_OR_FORBIDDEN — never to a distinct "not yours" code).
 *
 * A tombstone IS a valid target: moderator removals must not freeze a thread,
 * and the parent's text is already gone (the preview snippet is null).
 */
export const resolveReplyTarget = async ({ companyId, conversationId, messageId }) => {
  const id = asId(messageId);

  if (!id) return null;

  const parent = await ChatMessage.findOne({
    _id: id,
    companyId,
    conversationId,
  })
    .select('_id senderUserId text deletedAt threadRootMessageId')
    .lean();

  return parent ?? null;
};

/**
 * Reply counts for a page of messages, in ONE aggregation.
 *
 * Only roots can have a count (a reply is never a root), so callers pass the
 * ids they already hold. Missing keys mean zero — the map is sparse on purpose.
 */
export const summarizeThreadCounts = async ({ companyId, conversationId, messageIds }) => {
  const counts = new Map();

  const ids = (Array.isArray(messageIds) ? messageIds : []).map(asId).filter(Boolean);

  if (ids.length === 0) return counts;

  const rows = await ChatMessage.aggregate([
    {
      $match: {
        companyId: asId(companyId) ?? companyId,
        conversationId: asId(conversationId) ?? conversationId,
        threadRootMessageId: { $in: ids },
      },
    },
    { $group: { _id: '$threadRootMessageId', count: { $sum: 1 } } },
  ]);

  for (const row of rows ?? []) {
    counts.set(String(row._id), Number(row.count) || 0);
  }

  return counts;
};

/**
 * Reply previews for a page of messages, in ONE query.
 *
 * Every parent id referenced by the page is fetched together with the tenant
 * AND conversation filter, then mapped back onto its child. Parents outside
 * this conversation cannot exist (the write path refuses them), and a parent
 * missing from this map simply yields no hint — never an error.
 */
export const loadReplyPreviews = async ({ companyId, conversationId, messages }) => {
  const previews = new Map();

  const rows = Array.isArray(messages) ? messages : [];

  const parentIds = [
    ...new Set(
      rows
        .map((message) => message?.replyToMessageId)
        .filter(Boolean)
        .map((value) => String(value))
    ),
  ].map(asId).filter(Boolean);

  if (parentIds.length === 0) return previews;

  const parents = await ChatMessage.find({
    _id: { $in: parentIds },
    companyId,
    conversationId,
  })
    .select('_id senderUserId text deletedAt')
    .lean();

  const byId = new Map((parents ?? []).map((parent) => [String(parent._id), parent]));

  for (const message of rows) {
    if (!message?.replyToMessageId) continue;

    previews.set(String(message._id), toReplyPreview(byId.get(String(message.replyToMessageId))));
  }

  return previews;
};

/**
 * THE READ GATE. Deliberately a local copy rather than an import from the
 * message service: the two gates answer different questions.
 *
 *   · the WRITE gate (loadWritableConversation + an isDisabled check) refuses
 *     when the conversation is locked;
 *   · THIS gate must NOT — a disabled conversation stays readable (33.9), and
 *     a thread is a read.
 *
 * Keeping them separate is what stops somebody "tidying up" the import and
 * silently locking history behind the lock. It also keeps this module free of
 * a circular import with the message service.
 */
const loadReadableConversation = async ({ companyId, userId, conversationId }) => {
  const conversation = await ChatConversation.findOne({
    _id: conversationId,
    companyId,
    'members.userId': userId,
  }).lean();

  return conversation ?? null;
};

/**
 * The thread behind one root message.
 *
 * Returns { ok:false, code:'NOT_FOUND_OR_FORBIDDEN' } when the conversation is
 * not the caller's, or when the given message is not a message of that
 * conversation. If the given message is ITSELF a reply, the effective root is
 * its threadRootMessageId — one thread has exactly one view, however the user
 * arrived at it.
 *
 * Pagination mirrors history exactly: cursor by seq, newest first, `limit + 1`
 * rows fetched to answer hasMore without a second query.
 */
export const listThreadMessages = async ({
  companyId,
  userId,
  conversationId,
  rootMessageId,
  cursor,
  limit,
}) => {
  const conversation = await loadReadableConversation({ companyId, userId, conversationId });

  // 33.9 lock law: a disabled conversation is still READABLE here.
  if (!conversation) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

  const rootId = asId(rootMessageId);

  if (!rootId) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

  const requested = await ChatMessage.findOne({
    _id: rootId,
    companyId,
    conversationId,
  })
    .select('_id threadRootMessageId')
    .lean();

  if (!requested) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

  const effectiveRootId = requested.threadRootMessageId ?? requested._id;

  const root = await ChatMessage.findOne({
    _id: effectiveRootId,
    companyId,
    conversationId,
  }).lean();

  // Defensive: a root id is only ever written after that message was verified
  // in this conversation, so this cannot happen — but a dangling pointer must
  // read as "not found" rather than return a half-thread.
  if (!root) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

  const pageSize = Math.min(
    Math.max(Number(limit) || CHAT_THREAD_LIMIT_DEFAULT, 1),
    CHAT_THREAD_LIMIT_MAX
  );

  const filter = {
    companyId,
    conversationId,
    threadRootMessageId: effectiveRootId,
    _id: { $ne: effectiveRootId },
  };

  if (cursor !== undefined && cursor !== null) filter.seq = { $lt: Number(cursor) };

  // The root's reply count is a CONVERSATION-WIDE truth (the panel header must
  // not claim a smaller number just because the page is small), so it is one
  // bounded aggregation rather than a length of the page.
  const rootCounts = await summarizeThreadCounts({
    companyId,
    conversationId,
    messageIds: [effectiveRootId],
  });

  const rows = await ChatMessage.find(filter).sort({ seq: -1 }).limit(pageSize + 1).lean();

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const last = page[page.length - 1];

  return {
    ok: true,
    root,
    rootReplyCount: rootCounts.get(String(effectiveRootId)) ?? 0,
    items: page,
    hasMore,
    nextCursor: hasMore && last ? last.seq : null,
    limit: pageSize,
  };
};
