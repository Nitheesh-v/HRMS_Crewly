// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.3 — CHAT CONVERSATION SERVICE (REST, no realtime yet)
//
//  WHAT THIS IS
//    All Mongo logic for conversation create / list / detail / member
//    management. Controllers stay thin and call into here.
//
//  TENANCY LAW
//    Every query carries companyId, taken ONLY from req.companyId (which
//    protect derives from Mongo). A client-supplied tenant id is never read.
//    Reads additionally require membership: 'members.userId' must equal the
//    requesting user, so a non-member — including a user from another tenant
//    — gets a 404, never a leak.
//
//  AUTHORIZATION (deliberate, documented)
//    Phase 33.3 adds NO new permissions and NO subscription feature. The
//    repo's permission catalogue (SYSTEM_PERMISSION_VERSION=36) and plan
//    feature map are strictly versioned and contain no CHAT entries; adding
//    them is a separate, carefully-versioned unit. Here, write access to a
//    group's membership is gated by the in-conversation ADMIN role stored on
//    ChatConversation.members[].role (33.2), on top of protect +
//    tenantContext + checkSubscriptionStatus applied in the router.
//
//  DIRECT UNIQUENESS
//    A DIRECT conversation is identified by directKey = sorted member ids
//    joined by ':'. Create is idempotent: find existing first, else insert,
//    and on a duplicate-key race (E11000) refetch and return the winner so
//    two concurrent "start chat" calls converge on one conversation.
//
//  ORDERING / PAGINATION
//    Lists are keyset-paginated over { lastMessageAt: -1, _id: -1 }.
//    lastMessageAt is seeded to "now" on create, so for a conversation with
//    no messages it equals createdAt — exactly "lastMessageAt desc with a
//    createdAt fallback" — and 33.5 only has to bump it when a message lands.
//    limit is clamped 1..50 (default 20). No unbounded query exists here.
//
//  NO runtime index management here. Indexes are schema-declared in the
//    33.2 models; this service only reads and writes documents.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';
import { toAttachmentReferences } from '../../utils/chatAttachmentView.js';

import ChatConversation from '../../models/ChatConversation.js';
import ChatMessage from '../../models/ChatMessage.js';
import User from '../../models/User.js';
import ApiError from '../../utils/ApiError.js';
import {
  sanitizeConversationForMember,
  buildMemberDirectory,
} from './chatReadService.js';
// 34.1 — reactions are projected into history here; the service owns the caps
// and the viewer-aware grouping (one query per page, never one per message).
import { summarizeReactions } from './chatReactionService.js';
// 34.2 — the same shape for threads: reply hints and reply counts for a whole
// page in two bounded lookups, never one per row.
import {
  listThreadMessages,
  loadReplyPreviews,
  summarizeThreadCounts,
} from './chatThreadService.js';

export const CHAT_GROUP_MAX_MEMBERS = 50;

export const CHAT_LIST_LIMIT_DEFAULT = 20;
export const CHAT_LIST_LIMIT_MAX = 50;

const { ObjectId } = mongoose.Types;

// ── pure helpers (exported for hermetic tests) ────────────────────────────

export const buildDirectKey = (idA, idB) =>
  [String(idA), String(idB)].sort().join(':');

export const clampChatLimit = (raw) => {
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed < 1) return CHAT_LIST_LIMIT_DEFAULT;

  return Math.min(CHAT_LIST_LIMIT_MAX, Math.floor(parsed));
};

export const encodeChatCursor = ({ at, id }) =>
  Buffer.from(JSON.stringify({ a: new Date(at).getTime(), id: String(id) }), 'utf8')
    .toString('base64url');

export const decodeChatCursor = (cursor) => {
  try {
    const parsed = JSON.parse(
      Buffer.from(String(cursor), 'base64url').toString('utf8')
    );

    if (typeof parsed.a !== 'number' || !mongoose.isValidObjectId(parsed.id)) {
      return null;
    }

    return { at: new Date(parsed.a), id: new ObjectId(parsed.id) };
  } catch {
    return null;
  }
};

// Keyset "next page" condition for the DESC order
// { lastMessageAt: -1, _id: -1 }.
export const buildPageFilter = ({ companyId, userId, cursor }) => {
  const filter = { companyId, 'members.userId': userId };

  if (cursor) {
    filter.$or = [
      { lastMessageAt: { $lt: cursor.at } },
      { lastMessageAt: cursor.at, _id: { $lt: cursor.id } },
    ];
  }

  return filter;
};

// ── shared lookups ────────────────────────────────────────────────────────

const loadCompanyUsers = async (companyId, userIds) =>
  User.find({
    _id: { $in: userIds },
    companyId,
    status: 'ACTIVE',
  })
    .select('_id')
    .lean();

const assertIdsAreHex = (ids) => {
  for (const id of ids) {
    if (!mongoose.isValidObjectId(String(id))) {
      throw ApiError.badRequest('A member id is not a valid identifier.');
    }
  }
};

// ── create ────────────────────────────────────────────────────────────────

export const createDirectConversation = async ({
  companyId,
  requesterId,
  targetUserId,
}) => {
  if (String(requesterId) === String(targetUserId)) {
    throw ApiError.badRequest('You cannot start a direct conversation with yourself.');
  }

  const [target] = await loadCompanyUsers(companyId, [targetUserId]);

  if (!target) {
    throw ApiError.notFound('The person you are trying to message was not found in your company.');
  }

  const directKey = buildDirectKey(requesterId, targetUserId);

  const existing = await ChatConversation.findOne({ companyId, directKey }).lean();

  if (existing) return { conversation: existing, created: false };

  const now = new Date();

  try {
    const conversation = await ChatConversation.create({
      companyId,
      type: 'DIRECT',
      directKey,
      members: [
        { userId: requesterId, role: 'MEMBER', joinedAt: now, joinedAtSeq: 0, lastReadSeq: 0 },
        { userId: targetUserId, role: 'MEMBER', joinedAt: now, joinedAtSeq: 0, lastReadSeq: 0 },
      ],
      lastMessageAt: now,
    });

    return { conversation: conversation.toObject(), created: true };
  } catch (error) {
    // Duplicate-key race: another request created the same pair first.
    // Refetch and return the winner — idempotent create, never a 500.
    if (error?.code === 11000) {
      const winner = await ChatConversation.findOne({ companyId, directKey }).lean();

      if (winner) return { conversation: winner, created: false };
    }

    throw error;
  }
};

export const createGroupConversation = async ({
  companyId,
  requesterId,
  name,
  memberUserIds = [],
}) => {
  const cleaned = [
    ...new Set(
      memberUserIds
        .map((id) => String(id))
        .filter((id) => id !== String(requesterId))
    ),
  ];

  if (cleaned.length < 1) {
    throw ApiError.badRequest('A group needs at least one other member besides you.');
  }

  if (cleaned.length + 1 > CHAT_GROUP_MAX_MEMBERS) {
    throw ApiError.badRequest(`A group can have at most ${CHAT_GROUP_MAX_MEMBERS} members.`);
  }

  assertIdsAreHex(cleaned);

  const valid = await loadCompanyUsers(companyId, cleaned);

  if (valid.length !== cleaned.length) {
    throw ApiError.badRequest('One or more selected members are not active users in your company.');
  }

  const now = new Date();

  const members = [
    { userId: requesterId, role: 'ADMIN', joinedAt: now, joinedAtSeq: 0, lastReadSeq: 0 },
    ...cleaned.map((id) => ({
      userId: new ObjectId(id),
      role: 'MEMBER',
      joinedAt: now,
      joinedAtSeq: 0,
      lastReadSeq: 0,
    })),
  ];

  const conversation = await ChatConversation.create({
    companyId,
    type: 'GROUP',
    title: name.trim(),
    members,
    lastMessageAt: now,
  });

  return { conversation: conversation.toObject(), created: true };
};

export const createConversation = async ({
  companyId,
  requesterId,
  type,
  targetUserId,
  name,
  memberUserIds,
}) =>
  type === 'DIRECT'
    ? createDirectConversation({ companyId, requesterId, targetUserId })
    : createGroupConversation({ companyId, requesterId, name, memberUserIds });

// ── read ──────────────────────────────────────────────────────────────────

export const listMyConversations = async ({ companyId, userId, cursor, limit }) => {
  const pageSize = clampChatLimit(limit);

  const decoded = cursor ? decodeChatCursor(cursor) : null;

  // An unreadable cursor is treated as "start from the top", never a 500.
  const filter = buildPageFilter({ companyId, userId, cursor: decoded });

  const rows = await ChatConversation.find(filter)
    .sort({ lastMessageAt: -1, _id: -1 })
    .limit(pageSize + 1)
    .lean();

  const hasMore = rows.length > pageSize;
  const items = hasMore ? rows.slice(0, pageSize) : rows;

  const last = items[items.length - 1];

  // 33.7: project each row for the requester — C1 count at the top level,
  // and no other member's read cursor leaves the service. 33.8-fix: slim
  // member identities ride along so clients can render names even when
  // the company directory endpoint is scoped narrower than the chat.
  const directory = await buildMemberDirectory(items);

  return {
    conversations: items.map((conversation) =>
      sanitizeConversationForMember(conversation, userId, directory)
    ),
    nextCursor: hasMore && last ? encodeChatCursor({ at: last.lastMessageAt, id: last._id }) : null,
    hasMore,
    limit: pageSize,
  };
};

export const getConversation = async ({ companyId, userId, conversationId }) => {
  const conversation = await ChatConversation.findOne({
    _id: conversationId,
    companyId,
    'members.userId': userId,
  }).lean();

  if (!conversation) throw ApiError.notFound('Conversation not found.');

  // 33.7: same privacy projection as the list — the detail view must not
  // expose other members' read cursors either. 33.8-fix: same slim member
  // identities as the list.
  const directory = await buildMemberDirectory([conversation]);

  return {
    conversation: sanitizeConversationForMember(conversation, userId, directory),
  };
};

// ── member management ─────────────────────────────────────────────────────

const loadForManage = async ({ companyId, actorId, conversationId }) => {
  const conversation = await ChatConversation.findOne({ _id: conversationId, companyId }).lean();

  if (!conversation) throw ApiError.notFound('Conversation not found.');

  if (conversation.type !== 'GROUP') {
    throw ApiError.badRequest('Member management applies to group conversations only.');
  }

  const actor = conversation.members.find((member) => String(member.userId) === String(actorId));

  return { conversation, actor };
};

/**
 * 34.2 — ONE thread page, fully projected.
 *
 * The thread service owns the gate (membership + tenant + root-in-this-
 * conversation) and the pagination; this function owns the projection, so the
 * thread panel renders exactly the same message shape as the main history —
 * reactions included, reply hints included. Three bounded lookups at most, and
 * a tombstone is never asked about.
 */
export const getThread = async ({
  companyId,
  userId,
  conversationId,
  rootMessageId,
  cursor,
  limit,
}) => {
  const result = await listThreadMessages({
    companyId,
    userId,
    conversationId,
    rootMessageId,
    cursor,
    limit,
  });

  if (!result.ok) return result;

  const liveItems = result.items.filter((row) => !row.deletedAt);
  const rootIsLive = !result.root.deletedAt;

  const ids = [...liveItems.map((row) => row._id), ...(rootIsLive ? [result.root._id] : [])];

  const reactionsByMessage = await summarizeReactions({
    companyId,
    messageIds: ids,
    viewerUserId: userId,
  });

  const replyPreviews = await loadReplyPreviews({
    companyId,
    conversationId,
    messages: result.items,
  });

  return {
    ok: true,
    conversationId,
    // The root keeps its own count (the whole thread) and never carries a
    // reply hint of its own: by definition it is the start.
    root: sanitizeMessageForHistory(
      result.root,
      reactionsByMessage.get(String(result.root._id)) ?? [],
      { replyTo: null, threadReplyCount: result.rootReplyCount ?? 0 }
    ),
    // A thread item can never root another thread (the write path always keeps
    // the original root), so its own count is zero by construction.
    items: result.items.map((row) =>
      sanitizeMessageForHistory(row, reactionsByMessage.get(String(row._id)) ?? [], {
        replyTo: replyPreviews.get(String(row._id)) ?? null,
        threadReplyCount: 0,
      })
    ),
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
    limit: result.limit,
  };
};

export const addMembers = async ({
  companyId,
  actorId,
  conversationId,
  memberUserIds = [],
  // 33.9: CHAT_GROUP_MANAGE holders (verified by the controller) may manage
  // ANY group in the tenant without holding the in-group ADMIN role. The
  // 33.2 rule is untouched for everyone else.
  moderatorManage = false,
}) => {
  const { conversation, actor } = await loadForManage({ companyId, actorId, conversationId });

  if (!actor && !moderatorManage) {
    throw ApiError.forbidden('You must be a member to manage this group.');
  }
  if (!moderatorManage && actor?.role !== 'ADMIN') {
    throw ApiError.forbidden('Only group admins can add members.');
  }

  const cleaned = [
    ...new Set(
      memberUserIds
        .map((id) => String(id))
        .filter((id) => !conversation.members.some((member) => String(member.userId) === id))
    ),
  ];

  if (cleaned.length === 0) {
    throw ApiError.badRequest('No new members to add.');
  }

  if (conversation.members.length + cleaned.length > CHAT_GROUP_MAX_MEMBERS) {
    throw ApiError.badRequest(`A group can have at most ${CHAT_GROUP_MAX_MEMBERS} members.`);
  }

  assertIdsAreHex(cleaned);

  const valid = await loadCompanyUsers(companyId, cleaned);

  if (valid.length !== cleaned.length) {
    throw ApiError.badRequest('One or more selected members are not active users in your company.');
  }

  const now = new Date();
  const docs = cleaned.map((id) => ({
    userId: new ObjectId(id),
    role: 'MEMBER',
    joinedAt: now,
    joinedAtSeq: conversation.lastMessageSeq || 0,
    lastReadSeq: conversation.lastMessageSeq || 0,
  }));

  await ChatConversation.updateOne(
    { _id: conversationId, companyId },
    { $push: { members: { $each: docs } } }
  );

  const updated = await ChatConversation.findOne({ _id: conversationId, companyId }).lean();

  return { conversation: updated, added: cleaned.length };
};

export const removeMember = async ({
  companyId,
  actorId,
  conversationId,
  targetUserId,
  moderatorManage = false,
}) => {
  const { conversation, actor } = await loadForManage({ companyId, actorId, conversationId });

  if (!actor && !moderatorManage) {
    throw ApiError.forbidden('You must be a member to manage this group.');
  }

  const isSelf = String(actorId) === String(targetUserId);

  if (!isSelf && !moderatorManage && actor?.role !== 'ADMIN') {
    throw ApiError.forbidden('Only group admins can remove other members.');
  }

  const target = conversation.members.find(
    (member) => String(member.userId) === String(targetUserId)
  );

  if (!target) throw ApiError.notFound('That person is not a member of this group.');

  if (conversation.members.length <= 2) {
    throw ApiError.badRequest('A group needs at least two members; it cannot be emptied.');
  }

  const adminCount = conversation.members.filter((member) => member.role === 'ADMIN').length;

  if (target.role === 'ADMIN' && adminCount <= 1) {
    throw ApiError.badRequest('A group must keep at least one admin.');
  }

  await ChatConversation.updateOne(
    { _id: conversationId, companyId },
    { $pull: { members: { userId: new ObjectId(String(targetUserId)) } } }
  );

  const updated = await ChatConversation.findOne({ _id: conversationId, companyId }).lean();

  return { conversation: updated, removed: String(targetUserId) };
};

// ── message history (33.4) ────────────────────────────────────────────────

// Defense-in-depth tombstone sanitizer. The 33.2 schema clears body text at
// write time, but a tombstone written through an atomic update that skips
// validators could still carry text — so the read path never trusts the
// stored body: if deletedAt is set, text is always null. We also never leak
// edit history here (that is a separate, permission-gated read in 33.6).
export const sanitizeMessageForHistory = (
  message,
  reactions = [],
  // 34.2 — page-level extras, resolved in bulk by the caller. Defaults keep
  // every existing single-message call site (and its tests) valid.
  { replyTo = null, threadReplyCount = 0 } = {}
) => ({
  _id: message._id,
  seq: message.seq,
  senderUserId: message.senderUserId,
  type: message.type,
  text: message.deletedAt ? null : message.text ?? null,
  // 33.10-fix3 — the whitelist FORGOT attachments when 33.10 shipped, so a
  // FILE message loaded from history arrived with no file and rendered as an
  // empty bubble (it looked fine only while it was still the live socket
  // copy). References only — id + display metadata, the same view the socket
  // broadcasts; the bytes stay behind the gated download.
  attachments: toAttachmentReferences(message.attachments),
  editedAt: message.editedAt ?? null,
  editVersion: message.editVersion ?? 0,
  deletedAt: message.deletedAt ?? null,
  createdAt: message.createdAt ?? null,
  // 34.1 — reactions, as [{ type, count, mine }]. Viewer-aware on purpose: the
  // REST surface knows who is asking, so it answers "did *I* react" instead of
  // making every client join a userId list. Empty array (never undefined) so
  // the renderer has one shape to handle. Tombstones are passed [] by the
  // caller — a deleted message shows no reactions.
  reactions,

  // ── 34.2 threads ───────────────────────────────────────────────────────
  // Both ids are null for a top-level message. `threadRootMessageId` is what
  // the UI uses to open the right thread from a reply, and `replyTo` is the
  // bounded hint above the bubble (null snippet for a deleted parent — the
  // parent is never echoed back, so a tombstone stays a tombstone).
  replyToMessageId: message.replyToMessageId ?? null,
  threadRootMessageId: message.threadRootMessageId ?? null,
  replyTo,
  // Count of replies in the thread this message ROOTS. Derived, never stored:
  // a delete can therefore never leave a stale number behind.
  threadReplyCount: Number(threadReplyCount) || 0,
});

// Newest-first keyset pagination over the 33.2 index
// (companyId, conversationId, seq desc). cursor is a seq; when present we
// fetch the page strictly older than it. Membership is verified FIRST via
// getConversation, so a non-member or another tenant gets a 404 before any
// message is touched.
export const listMessages = async ({
  companyId,
  userId,
  conversationId,
  cursor,
  limit,
}) => {
  // Throws 404 unless the requester is a member of this tenant's conversation.
  await getConversation({ companyId, userId, conversationId });

  const pageSize = clampChatLimit(limit);

  const filter = { companyId, conversationId };

  if (Number.isFinite(cursor) && cursor > 0) {
    filter.seq = { $lt: cursor };
  }

  const rows = await ChatMessage.find(filter)
    .sort({ seq: -1 })
    .limit(pageSize + 1)
    .lean();

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;

  const last = page[page.length - 1];

  // 34.1 — reactions ride the history page: ONE extra bounded query for the
  // whole page (never one per message), and only for messages that can still
  // receive them. A tombstone shows nothing, so those ids are not even asked
  // about.
  const liveIds = page.filter((row) => !row.deletedAt).map((row) => row._id);

  const reactionsByMessage = await summarizeReactions({
    companyId,
    messageIds: liveIds,
    viewerUserId: userId,
  });

  // 34.2 — two more bounded lookups for the same page: reply hints (one query
  // for every parent referenced by the page) and reply counts (one
  // aggregation). Both are skipped entirely when the page has no replies, so a
  // plain conversation costs exactly what it cost before threads existed.
  const replyPreviews =
    liveIds.length > 0
      ? await loadReplyPreviews({ companyId, conversationId, messages: page })
      : new Map();

  const threadCounts = await summarizeThreadCounts({
    companyId,
    conversationId,
    messageIds: page.map((row) => row._id),
  });

  return {
    conversationId,
    items: page.map((row) =>
      sanitizeMessageForHistory(row, reactionsByMessage.get(String(row._id)) ?? [], {
        replyTo: replyPreviews.get(String(row._id)) ?? null,
        threadReplyCount: threadCounts.get(String(row._id)) ?? 0,
      })
    ),
    nextCursor: hasMore && last ? last.seq : null,
    hasMore,
    limit: pageSize,
  };
};
