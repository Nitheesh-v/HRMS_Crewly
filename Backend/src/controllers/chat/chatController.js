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
import * as chatModerationService from '../../services/chat/chatModerationService.js';
import * as chatAttachmentService from '../../services/chat/chatAttachmentService.js';
import { resolveChatAttachmentDelivery } from '../../services/chat/chatAttachmentStorage.js';
import { hasPermission } from '../../utils/permissionService.js';

// 33.9 — CHAT_GROUP_MANAGE WIDENS 33.2's in-group ADMIN rule; it can never
// narrow it (a group's own ADMIN still manages that group without the
// permission). Resolution is server-side only and fails closed.
const canManageAnyGroup = async (req) => {
  try {
    return await hasPermission(
      { ...req.user, companyId: req.companyId },
      'CHAT_GROUP_MANAGE',
    );
  } catch {
    return false;
  }
};

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
    moderatorManage: await canManageAnyGroup(req),
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
    moderatorManage: await canManageAnyGroup(req),
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

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.9 — MODERATION (thin; CHAT_MODERATE enforced in the service)
// ═══════════════════════════════════════════════════════════════════════════

// A lock/unlock changes every member's composer state, so the affected
// members get the same data-less list nudge the 33.8-fix membership paths
// use (their next fetch re-reads the authoritative Mongo row).
const memberIdsOf = (conversation) =>
  (conversation?.members ?? []).map((member) => member.userId);

// The audit meta is derived from the request, never from the body.
const moderationMeta = (req) => ({
  method: req.method,
  path: req.originalUrl.split('?')[0],
  ip: req.ip || '',
});

// PATCH /api/chat/conversations/:conversationId/disable
export const disableConversation = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { conversationId } = req.params;
  const { reason } = req.body;

  // DB Logic - DB logics
  const result = await chatModerationService.disableConversation({
    companyId: req.companyId,
    actorId: req.user._id,
    conversationId,
    reason,
    reqMeta: moderationMeta(req),
  });

  if (result.changed) notifyConversationsChanged(memberIdsOf(result.conversation));

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.changed ? 'Conversation disabled' : 'Conversation was already disabled',
    data: { conversation: result.conversation, changed: result.changed },
  });
});

// PATCH /api/chat/conversations/:conversationId/enable
export const enableConversation = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { conversationId } = req.params;

  // DB Logic - DB logics
  const result = await chatModerationService.enableConversation({
    companyId: req.companyId,
    actorId: req.user._id,
    conversationId,
    reqMeta: moderationMeta(req),
  });

  if (result.changed) notifyConversationsChanged(memberIdsOf(result.conversation));

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.changed ? 'Conversation enabled' : 'Conversation was already enabled',
    data: { conversation: result.conversation, changed: result.changed },
  });
});

// POST /api/chat/conversations/:conversationId/messages/:messageId/moderate-delete
export const moderateDeleteMessage = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { conversationId, messageId } = req.params;
  const { reason } = req.body;

  // DB Logic - DB logics
  const result = await chatModerationService.moderateDeleteMessage({
    companyId: req.companyId,
    actorId: req.user._id,
    conversationId,
    messageId,
    reason,
    reqMeta: moderationMeta(req),
  });

  if (!result.ok) throw ApiError.notFound('Message not found.');

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: result.changed ? 'Message removed by moderator' : 'Message was already removed',
    data: {
      conversationId,
      messageId: result.messageId,
      deletedAt: result.deletedAt,
      changed: result.changed,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.10 — ATTACHMENTS (thin; auth + rules live in the services)
// ═══════════════════════════════════════════════════════════════════════════

// The name already went through safeChatFileName at upload; this second pass
// exists because a download header must ALSO be quote/newline-safe (header
// injection is a transport concern, not a storage one).
const sanitizeDownloadName = (raw) =>
  String(raw || 'attachment')
    .replace(/[\r\n"]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 200) || 'attachment';

// POST /api/chat/conversations/:conversationId/attachments (multipart)
export const uploadAttachment = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { conversationId } = req.params;
  const file = req.file;

  // DB Logic - DB logics
  // The service resolves membership from Mongo, enforces the type/size
  // policy, stores the bytes in private storage and writes the metadata row.
  const attachment = await chatAttachmentService.uploadAttachment({
    companyId: req.companyId,
    userId: req.user._id,
    conversationId,
    file,
  });

  // Data to frontend - response to frontend
  // No storage key, no URL, no checksum: the client only needs what a bubble
  // renders, and the download is a separate gated request.
  return ApiResponse.success(res, {
    message: 'Attachment uploaded',
    data: { attachment },
  });
});

// GET /api/chat/attachments/:attachmentId/download
export const downloadAttachment = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { attachmentId } = req.params;

  // DB Logic - DB logics
  // Tenant + membership are proven BEFORE any storage call; a miss is an
  // indistinguishable 404 (never "exists but forbidden").
  const attachment = await chatAttachmentService.authorizeAttachmentDownload({
    companyId: req.companyId,
    userId: req.user._id,
    attachmentId,
  });

  const delivery = await resolveChatAttachmentDelivery({ attachment });

  // Data to frontend - private, uncacheable, sanitized name. Also set on the
  // redirect: a signed URL must never be cached by a shared proxy either.
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('X-Content-Type-Options', 'nosniff');

  // The resolver is streaming-first (see chatAttachmentStorage); the
  // redirect branch stays for completeness and is not used by chat today.
  if (delivery.kind === 'SIGNED_URL' || delivery.kind === 'REDIRECT') {
    return res.redirect(302, delivery.url);
  }

  res.set(
    'Content-Type',
    delivery.contentType || attachment.mimeType || 'application/octet-stream'
  );
  res.set(
    'Content-Disposition',
    `attachment; filename="${sanitizeDownloadName(attachment.originalFileName)}"`
  );

  return res.status(200).send(delivery.bytes);
});
