// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.10 — CHAT ATTACHMENT SERVICE (authorization + lifecycle)
//
//  AUTHORIZATION (non-negotiable, Mongo-authoritative)
//    Every entry point resolves membership from the DATABASE, never from a
//    client-supplied id:
//      ChatConversation.findOne({ _id, companyId, 'members.userId': userId })
//    A miss returns the same NOT_FOUND_OR_FORBIDDEN / 404 shape a genuinely
//    missing row produces, so neither another tenant's existence nor another
//    member's access can be probed.
//
//  LINKING (the anti-abuse rule)
//    A FILE message may reference ONLY attachments that are (a) in the same
//    tenant, (b) in the SAME conversation and (c) not already referenced by
//    another message. That last rule is what stops a member from uploading
//    once and replaying the id into every conversation they can reach; it is
//    enforced with one indexed query, and the message write then binds the
//    ids it actually found (never the ids it was asked for).
//
//  SCAN POSTURE
//    There is no scanner in this repository. Rows are created with
//    scanStatus = NOT_CONFIGURED and nothing here ever upgrades that to
//    CLEAN. The download path does not pretend a file was inspected.
// ═══════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';

import ChatAttachment from '../../models/ChatAttachment.js';
import ChatConversation from '../../models/ChatConversation.js';
import ChatMessage from '../../models/ChatMessage.js';
import ApiError from '../../utils/ApiError.js';
import {
  CHAT_ATTACHMENT_MAX_PER_MESSAGE,
  assertAllowedChatFile,
  assertAttachmentCount,
  safeChatFileName,
} from '../../utils/chatFileRules.js';
import { storeChatAttachment } from './chatAttachmentStorage.js';

// The only membership answer this module trusts.
const loadMembership = async ({ companyId, userId, conversationId }) =>
  ChatConversation.findOne({
    _id: conversationId,
    companyId,
    'members.userId': userId,
  }).lean();

// ── upload ────────────────────────────────────────────────────────────────

export const uploadAttachment = async ({
  companyId,
  userId,
  conversationId,
  file,
  _store = storeChatAttachment,
  _model = ChatAttachment,
  _conversationModel = ChatConversation,
} = {}) => {
  if (!file?.buffer?.length) {
    throw ApiError.badRequest('A file is required.');
  }

  const conversation = await _conversationModel.findOne({
    _id: conversationId,
    companyId,
    'members.userId': userId,
  }).lean();

  if (!conversation) throw ApiError.notFound('Conversation not found.');

  // Uploading IS sending, so a locked conversation refuses it for the same
  // reason send/edit/delete do (33.9 lock contract).
  if (conversation.isDisabled) {
    throw ApiError.badRequest('This conversation is disabled.');
  }

  const extension = assertAllowedChatFile({
    originalName: file.originalname,
    mimeType: file.mimetype,
    sizeBytes: file.buffer.length,
  });

  const stored = await _store({
    buffer: file.buffer,
    companyId,
    conversationId,
  });

  const attachment = await _model.create({
    companyId,
    conversationId,
    uploadedByUserId: userId,
    storageProvider: stored.storageProvider,
    storageKey: stored.storageKey,
    checksumSha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    originalFileName: safeChatFileName(file.originalname, extension),
    mimeType: String(file.mimetype).toLowerCase(),
    sizeBytes: file.buffer.length,
    // No scanner exists in this repo — the honest value, never a fake CLEAN.
    scanStatus: 'NOT_CONFIGURED',
    scanCheckedAt: null,
  });

  // The response SHAPE is built here on purpose: storageKey/checksum are
  // select:false, and this projection means the upload response can never
  // grow a key by accident.
  return {
    _id: attachment._id,
    conversationId: attachment.conversationId,
    fileName: attachment.originalFileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    scanState: attachment.scanStatus,
    createdAt: attachment.createdAt,
  };
};

// ── download authorization ────────────────────────────────────────────────

// Resolves the ATTACHMENT + proves the caller may read it. `select('+storageKey')`
// is the only place the key is ever read back out.
export const authorizeAttachmentDownload = async ({
  companyId,
  userId,
  attachmentId,
  _model = ChatAttachment,
  _conversationModel = ChatConversation,
} = {}) => {
  const attachment = await _model
    .findOne({ _id: attachmentId, companyId })
    .select('+storageKey')
    .lean();

  if (!attachment) throw ApiError.notFound('File not found');

  if (attachment.removedAt) throw ApiError.notFound('File not found');

  const conversation = await _conversationModel.findOne({
    _id: attachment.conversationId,
    companyId,
    'members.userId': userId,
  }).lean();

  if (!conversation) throw ApiError.notFound('File not found');

  return attachment;
};

// ── linking (used by the socket FILE send path) ───────────────────────────

// Revalidates EVERY id against tenant + conversation + "not already linked".
// Returns the message-ready metadata for exactly the attachments it found;
// a mismatch is a hard refusal (the caller cannot attach arbitrary files).
export const linkAttachmentsToMessage = async ({
  companyId,
  conversationId,
  attachmentIds = [],
  _model = ChatAttachment,
  _messageModel = ChatMessage,
} = {}) => {
  const requested = [...new Set((attachmentIds ?? []).map((id) => String(id)))];

  assertAttachmentCount(requested.length);

  if (requested.length > CHAT_ATTACHMENT_MAX_PER_MESSAGE) {
    throw ApiError.badRequest('Too many attachments for one message.');
  }

  const rows = await _model
    .find({
      _id: { $in: requested },
      companyId,
      conversationId,
      removedAt: null,
    })
    .lean();

  // Anything fewer than asked-for means at least one id was foreign, from
  // another conversation, or already withdrawn. Refuse wholesale rather than
  // silently attaching a subset the sender did not intend.
  if (rows.length !== requested.length) {
    throw ApiError.badRequest('One or more attachments are not available in this conversation.');
  }

  // Already referenced by a message? Then it is spent: an attachment belongs
  // to exactly one message, so an id cannot be replayed.
  const spent = await _messageModel
    .find({
      companyId,
      conversationId,
      'attachments.attachmentId': { $in: requested },
    })
    .select('attachments.attachmentId')
    .lean();

  if (spent.length > 0) {
    throw ApiError.badRequest('One or more attachments were already sent.');
  }

  // Order follows the caller's order so the bubble matches what they picked.
  const byId = new Map(rows.map((row) => [String(row._id), row]));

  return requested.map((id) => {
    const row = byId.get(id);

    return {
      attachmentId: row._id,
      fileName: row.originalFileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
    };
  });
};

// ── lifecycle: "delete for everyone" also withdraws the files ─────────────

// Called by the tombstone path. Marks the attachments of a deleted FILE
// message as removed so the download endpoint refuses them from then on.
// Best-effort: a failure here must not undo the tombstone itself.
export const withdrawMessageAttachments = async ({
  companyId,
  conversationId,
  attachments = [],
  _model = ChatAttachment,
} = {}) => {
  const ids = (attachments ?? [])
    .map((row) => row?.attachmentId)
    .filter(Boolean);

  if (ids.length === 0) return { removed: 0 };

  try {
    const result = await _model.updateMany(
      { _id: { $in: ids }, companyId, conversationId, removedAt: null },
      { $set: { removedAt: new Date() } }
    );

    return { removed: result?.modifiedCount ?? 0 };
  } catch {
    return { removed: 0 };
  }
};
