// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.3 — CHAT CONVERSATION CONTROLLER (thin)
//
//  Controllers only translate HTTP ↔ service. Every tenant decision,
//  membership check and Mongo write lives in services/chatService.js.
//  req.companyId / req.user._id are the ONLY sources of tenant + identity.
// ═══════════════════════════════════════════════════════════════════════════

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import * as chatService from '../services/chatService.js';

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

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Members added',
    data: { conversation, added },
  });
});

export const removeMember = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { conversationId, userId } = req.params;

  // DB Logic - DB logics
  const { conversation, removed } = await chatService.removeMember({
    companyId: req.companyId,
    actorId: req.user._id,
    conversationId,
    targetUserId: userId,
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Member removed',
    data: { conversation, removed },
  });
});
