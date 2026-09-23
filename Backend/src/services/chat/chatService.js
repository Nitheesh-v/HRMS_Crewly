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

import ChatConversation from '../../models/ChatConversation.js';
import ChatMessage from '../../models/ChatMessage.js';
import User from '../../models/User.js';
import ApiError from '../../utils/ApiError.js';
import {
  sanitizeConversationForMember,
  buildMemberDirectory,
} from './chatReadService.js';

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

export const addMembers = async ({
  companyId,
  actorId,
  conversationId,
  memberUserIds = [],
}) => {
  const { conversation, actor } = await loadForManage({ companyId, actorId, conversationId });

  if (!actor) throw ApiError.forbidden('You must be a member to manage this group.');
  if (actor.role !== 'ADMIN') throw ApiError.forbidden('Only group admins can add members.');

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
}) => {
  const { conversation, actor } = await loadForManage({ companyId, actorId, conversationId });

  if (!actor) throw ApiError.forbidden('You must be a member to manage this group.');

  const isSelf = String(actorId) === String(targetUserId);

  if (!isSelf && actor.role !== 'ADMIN') {
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
export const sanitizeMessageForHistory = (message) => ({
  _id: message._id,
  seq: message.seq,
  senderUserId: message.senderUserId,
  type: message.type,
  text: message.deletedAt ? null : message.text ?? null,
  editedAt: message.editedAt ?? null,
  editVersion: message.editVersion ?? 0,
  deletedAt: message.deletedAt ?? null,
  createdAt: message.createdAt ?? null,
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

  return {
    conversationId,
    items: page.map(sanitizeMessageForHistory),
    nextCursor: hasMore && last ? last.seq : null,
    hasMore,
    limit: pageSize,
  };
};
