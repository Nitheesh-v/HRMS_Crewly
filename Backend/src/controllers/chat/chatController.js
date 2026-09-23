// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.3 — CHAT CONVERSATION CONTROLLER (thin)
//
//  Controllers only translate HTTP ↔ service. Every tenant decision,
//  membership check and Mongo write lives in the chat services
//  (chatService.js, chatReadService.js).
//  req.companyId / req.user._id are the ONLY sources of tenant + identity.
// ═══════════════════════════════════════════════════════════════════════════

import asyncHandler from '../../utils/asyncHandler.js';
import ApiResponse from '../../utils/ApiResponse.js';
import ApiError from '../../utils/ApiError.js';
import * as chatService from '../../services/chat/chatService.js';
import * as chatReadService from '../../services/chat/chatReadService.js';
// 33.8-fix: data-less list-change nudge. A no-op (false) when realtime is
// off — REST already did the work; the client's next fetch catches up.
import { notifyConversationsChanged } from '../../socket/realtimeNudge.js';

export const createConversation = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { type, targetUserId, name, memberUserIds } = req.body;

  // DB Logic - DB logics
  const { conversation, created } = await chatService.createConversation({
    companyId: req.companyId,
    requesterId: req.user._id,
    type,
    targetUserId,
    name,
    memberUserIds,
  });

  // 33.8-fix: nudge every other member's personal room so their Chat page
  // refetches the list live (the event carries no data; Mongo stays truth).
  if (created) {
    notifyConversationsChanged(
      (conversation?.members ?? [])
        .map((member) => member?.userId)
        .filter((id) => id != null && String(id) !== String(req.user._id))
    );
  }

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    statusCode: created ? 201 : 200,
    message: created ? 'Conversation created' : 'Conversation already exists',
    data: { conversation },
  });
});

export const listMyConversations = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { cursor, limit } = req.query;

  // DB Logic - DB logics
  const result = await chatService.listMyConversations({
    companyId: req.companyId,
    userId: req.user._id,
    cursor,
    limit,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Conversations fetched',
    data: { conversations: result.conversations },
    meta: {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      limit: result.limit,
    },
  });
});

export const getConversation = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { conversationId } = req.params;

  // DB Logic - DB logics
  const { conversation } = await chatService.getConversation({
    companyId: req.companyId,
    userId: req.user._id,
    conversationId,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Conversation fetched',
    data: { conversation },
  });
});

export const getMessages = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { conversationId } = req.params;
  const { cursor, limit } = req.query;

  // DB Logic - DB logics
  const result = await chatService.listMessages({
    companyId: req.companyId,
    userId: req.user._id,
    conversationId,
    cursor: cursor !== undefined ? Number(cursor) : undefined,
    limit,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Messages fetched',
    data: {
      conversationId: result.conversationId,
      items: result.items,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    },
    meta: { limit: result.limit },
  });
});

export const addMembers = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { conversationId } = req.params;
  const { memberUserIds } = req.body;

  // DB Logic - DB logics
  const { conversation, added } = await chatService.addMembers({
    companyId: req.companyId,
    actorId: req.user._id,
    conversationId,
    memberUserIds,
  });

  // 33.8-fix: added users learn about the conversation live; a no-op when
  // realtime is off (their next fetch catches up).
  if (added > 0) notifyConversationsChanged(memberUserIds);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Members added',
    data: { conversation, added },
  });
});

export const removeMember = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { conversationId, userId: removedUserId } = req.params;

  // DB Logic - DB logics
  const { conversation, removed } = await chatService.removeMember({
    companyId: req.companyId,
    actorId: req.user._id,
    conversationId,
    targetUserId: removedUserId,
  });

  // 33.8-fix: the removed user's list loses the conversation live.
  if (removed) notifyConversationsChanged([removedUserId]);

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Member removed',
    data: { conversation, removed },
  });
});

// 33.7 — advance the caller's C1 read cursor (monotonic, clamped).
export const updateReadMarker = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { conversationId } = req.params;
  const { lastReadSeq } = req.body;

  // DB Logic - DB logics
  const result = await chatReadService.updateReadMarker({
    companyId: req.companyId,
    userId: req.user._id,
    conversationId,
    lastReadSeq: Number(lastReadSeq),
  });

  if (!result.ok) throw ApiError.notFound('Conversation not found.');

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Read marker updated',
    data: {
      conversationId: result.conversationId,
      myLastReadSeq: result.myLastReadSeq,
      lastMessageSeq: result.lastMessageSeq,
      unreadCount: result.unreadCount,
    },
  });
});
