// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.6 — CHAT MESSAGE EDIT + TOMBSTONE DELETE (Mongo-authoritative)
//
//  The single write path for editing and deleting a TEXT chat message,
//  called by the Socket.IO handlers (33.6). Authority ({ companyId,
//  editorUserId / deleterUserId }) always comes from the authenticated
//  principal (socket.data), never from the payload.
//
//  EDIT RULES
//    · membership + tenant + disabled checked first (loadWritableConversation)
//    · only the SENDER may edit, only TEXT messages, only non-tombstoned ones
//      (moderation — admins acting on others' messages — is 33.9, not 33.6)
//    · optimistic concurrency: the atomic update filters on
//      editVersion === expectedEditVersion; a mismatch refetches and maps to
//      CONFLICT_EDIT_VERSION. Two simultaneous edits cannot both win.
//    · append-only history: each successful edit writes one ChatMessageEdit
//      row with version = the message's NEW editVersion and previousText =
//      the text that was replaced. (companyId, messageId, version) is unique,
//      so a history row can never be silently overwritten.
//    · retention cap: CHAT_EDIT_HISTORY_MAX rows per message; beyond it the
//      edit is REFUSED with HISTORY_LIMIT_REACHED (refuse is simpler and
//      safer than pruning — no destructive history writes in 33.6).
//    · clientEditId is accepted and bounded by the validators but NOT a
//      dedupe key in 33.6: expectedEditVersion already makes a blind retry
//      fail loudly (CONFLICT_EDIT_VERSION), which is the honest behaviour —
//      the client must refresh editVersion from chat:message:updated.
//
//  DELETE RULES (TOMBSTONE)
//    · never a hard delete: deletedAt + deletedByUserId are set, text is
//      nulled, seq stays — pagination and read cursors remain stable.
//    · idempotent: deleting an already-tombstoned message returns ok with
//      the EXISTING deletedAt and changed:false (no re-broadcast upstream).
//    · only the SENDER may delete in 33.6 (moderation deferred to 33.9).
//    · a disabled conversation does NOT block tombstoning: removal of one's
//      own content stays available even when writing new content is frozen.
//    · lastMessagePreview is intentionally NOT recomputed here (no expensive
//      history scan in 33.6); a deleted last message leaves the old preview
//      until the next send. Documented limitation.
//    · reason is accepted and bounded by the validators but not persisted —
//      ChatMessage has no delete-reason field in 33.2 and 33.6 does not
//      change models. 33.9 (moderation/audit) may add storage.
//
//  The tombstone update passes runValidators AND explicitly $sets text to
//  null / edit fields to their reset values, exactly as the ChatMessage
//  model header demands for atomic update paths.
// ═══════════════════════════════════════════════════════════════════════════

import ChatConversation from '../../models/ChatConversation.js';
import ChatMessage from '../../models/ChatMessage.js';
import ChatMessageEdit from '../../models/ChatMessageEdit.js';

import { loadWritableConversation } from './chatMessageService.js';

export const CHAT_EDIT_HISTORY_MAX = 20;

export const editTextMessage = async ({
  companyId,
  editorUserId,
  conversationId,
  messageId,
  expectedEditVersion,
  newText,
}) => {
  const conversation = await loadWritableConversation({
    companyId,
    userId: editorUserId,
    conversationId,
  });

  if (!conversation) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

  if (conversation.isDisabled) return { ok: false, code: 'CONVERSATION_DISABLED' };

  const message = await ChatMessage.findOne({
    _id: messageId,
    companyId,
    conversationId,
  }).lean();

  if (!message) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

  if (message.deletedAt) return { ok: false, code: 'MESSAGE_DELETED' };

  if (message.type !== 'TEXT') return { ok: false, code: 'MESSAGE_NOT_EDITABLE' };

  if (String(message.senderUserId) !== String(editorUserId)) {
    return { ok: false, code: 'MESSAGE_NOT_EDITABLE' };
  }

  const historyCount = await ChatMessageEdit.countDocuments({ companyId, messageId });

  if (historyCount >= CHAT_EDIT_HISTORY_MAX) {
    return { ok: false, code: 'HISTORY_LIMIT_REACHED' };
  }

  const now = new Date();
  const previousText = message.text;

  // Optimistic concurrency: this matches only while editVersion is still the
  // version the client based its edit on. The first writer wins; a second
  // concurrent edit with the same expectation finds no match.
  const updated = await ChatMessage.findOneAndUpdate(
    {
      _id: messageId,
      companyId,
      conversationId,
      editVersion: expectedEditVersion,
      deletedAt: null,
      type: 'TEXT',
    },
    {
      $set: { text: newText, editedAt: now, editedByUserId: editorUserId },
      $inc: { editVersion: 1 },
    },
    { new: true, runValidators: true }
  ).lean();

  if (!updated) {
    const current = await ChatMessage.findOne({ _id: messageId, companyId, conversationId }).lean();

    if (!current) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };
    if (current.deletedAt) return { ok: false, code: 'MESSAGE_DELETED' };
    if (current.editVersion !== expectedEditVersion) {
      return { ok: false, code: 'CONFLICT_EDIT_VERSION' };
    }

    return { ok: false, code: 'RETRYABLE' };
  }

  try {
    await ChatMessageEdit.create({
      companyId,
      conversationId,
      messageId,
      version: updated.editVersion,
      previousText,
      editedAt: now,
      editedByUserId: editorUserId,
    });
  } catch {
    // The (companyId, messageId, version) unique index makes this
    // unreachable in practice (the version filter above already serialized
    // writers); if it ever fires, report retryable rather than claim the
    // history append succeeded.
    return { ok: false, code: 'RETRYABLE' };
  }

  return { ok: true, message: updated };
};

export const tombstoneMessage = async ({
  companyId,
  deleterUserId,
  conversationId,
  messageId,
  // 33.9: CHAT_MODERATE holders tombstone ANY message. The permission is
  // verified by the CALLER (socket handler / moderation service) — this
  // flag only relaxes the sender-only rule and the membership loader; the
  // tenant scope below is untouched. Moderators may also delete inside a
  // disabled conversation (that is the point of the lock); non-moderators
  // may not delete at all while disabled.
  moderator = false,
}) => {
  const conversation = moderator
    ? await ChatConversation.findOne({ _id: conversationId, companyId }).lean()
    : await loadWritableConversation({
        companyId,
        userId: deleterUserId,
        conversationId,
      });

  if (!conversation) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

  if (!moderator && conversation.isDisabled) {
    return { ok: false, code: 'CONVERSATION_DISABLED' };
  }

  const message = await ChatMessage.findOne({
    _id: messageId,
    companyId,
    conversationId,
  }).lean();

  if (!message) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

  // Idempotent delete: the tombstone already exists — acknowledge with the
  // original deletedAt so a retried delete never looks like an error and
  // never re-broadcasts.
  if (message.deletedAt) {
    return { ok: true, messageId: message._id, deletedAt: message.deletedAt, changed: false };
  }

  if (!moderator && String(message.senderUserId) !== String(deleterUserId)) {
    return { ok: false, code: 'MESSAGE_NOT_EDITABLE' };
  }

  const now = new Date();

  const updated = await ChatMessage.findOneAndUpdate(
    { _id: messageId, companyId, conversationId, deletedAt: null },
    {
      $set: {
        deletedAt: now,
        deletedByUserId: deleterUserId,
        text: null,
        editVersion: 0,
        editedAt: null,
        editedByUserId: null,
      },
    },
    { new: true, runValidators: true }
  ).lean();

  if (!updated) {
    const current = await ChatMessage.findOne({ _id: messageId, companyId, conversationId }).lean();

    if (current?.deletedAt) {
      return { ok: true, messageId: current._id, deletedAt: current.deletedAt, changed: false };
    }

    return { ok: false, code: 'RETRYABLE' };
  }

  return { ok: true, messageId: updated._id, deletedAt: updated.deletedAt, changed: true };
};
