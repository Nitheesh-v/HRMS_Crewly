// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.5 — CHAT MESSAGE SEND (persistence + idempotency + seq)
//
//  The single Mongo-authoritative write path for a TEXT chat message, shared
//  by the Socket.IO handler (33.5). It is deliberately callable with an
//  explicit { companyId, senderUserId } so the authority always comes from
//  the authenticated principal (socket.data / req), never from the payload.
//
//  ORDER OF OPERATIONS (each step is the cheapest rejection first):
//    1. membership + tenant + disabled check (findOne)            → refuse
//    2. idempotency pre-check (find by clientMessageId)          → return existing
//    3. atomic seq allocation ($inc lastMessageSeq, new:true)     → seq
//    4. ChatMessage.create (unique idempotency index guards race) → message
//    5. on E11000: refetch the winner and return it, created:false
//
//  AT-LEAST-ONCE, NOT EXACTLY-ONCE. A retried send resolves to the same
//  message through the unique (companyId, conversationId, senderUserId,
//  clientMessageId) index; we never claim the network delivered exactly once.
//  Broadcasting happens ONLY when created is true, so a retry is acknowledged
//  to the sender without re-emitting to the room.
//
//  Seq gaps are acceptable: seq must be unique and increasing per
//  conversation, not gapless. A lost create after an $inc leaves a gap, which
//  the C1 cursor model tolerates (unread = lastMessageSeq - lastReadSeq).
//
//  PHASE 33.10 — ONE persistence core, two message kinds.
//    `persistMessage` holds steps 1-5 above; `sendTextMessage` and
//    `sendFileMessage` differ only in what they write (type, text,
//    attachments). The TEXT contract is byte-identical to 33.5 — the file
//    path reuses the SAME idempotency index, the SAME atomic seq allocation
//    and the SAME E11000 convergence, so a retried FILE send behaves exactly
//    like a retried TEXT send. Attachments are revalidated by the caller
//    (chatAttachmentService.linkAttachmentsToMessage) BEFORE this runs, and
//    the preview for a FILE message is a generic word — never a filename.
// ═══════════════════════════════════════════════════════════════════════════

import ChatConversation from '../../models/ChatConversation.js';
import ChatMessage from '../../models/ChatMessage.js';
import {
  CHAT_ATTACHMENT_MESSAGES,
  CHAT_FILE_PREVIEW_TEXT,
} from '../../utils/chatFileRules.js';
import { hasVisibleText } from '../../utils/chatTextRules.js';
import logger from '../../config/logger.js';
// 34.2 — threads. The resolver lives in its own module (the read path needs it
// too); importing it here keeps ONE definition of "may this be replied to".
import { resolveReplyTarget, toReplyPreview } from './chatThreadService.js';

const PREVIEW_MAX = 200; // matches ChatConversation.lastMessagePreview maxlength

// The one sentence the API says when a message would carry no renderable
// content. Shared by both senders so the wording cannot drift.
export const EMPTY_BODY_MESSAGE = 'A message must not be empty.';

const buildPreview = (text) => String(text ?? '').slice(0, PREVIEW_MAX);

// Membership + tenant + disabled, Mongo-authoritative. Returns the lean
// conversation or null. A null here means "refuse and reveal nothing" — the
// caller maps it to NOT_FOUND_OR_FORBIDDEN so other tenants and non-members
// are indistinguishable.
export const loadWritableConversation = async ({
  companyId,
  userId,
  conversationId,
}) => {
  const conversation = await ChatConversation.findOne({
    _id: conversationId,
    companyId,
    'members.userId': userId,
  }).lean();

  return conversation ?? null;
};

// ── shared persistence core ───────────────────────────────────────────────
// Membership → disabled → idempotency → atomic seq → create → E11000 winner.
// `mutation` supplies ONLY the type-specific fields.
// 33.10-fix2 — THE RENDERABILITY INVARIANT.
//
// A stored message must render something: a visible body, or at least one
// attachment reference. Localhost acceptance showed a bubble carrying only a
// timestamp (2026-09-26, 10:57) — an all-invisible body was accepted by the
// old trim()-only check. Rather than trust every present and future writer to
// remember the rule, the ONE create path refuses what nobody could read.
const unrenderableMutation = (mutation) => {
  const fileCount = Array.isArray(mutation?.attachments) ? mutation.attachments.length : 0;

  // A FILE message with no file is a hollow bubble wearing a caption's clothes.
  if (mutation?.type === 'FILE' && fileCount === 0) return true;

  return !hasVisibleText(mutation?.text) && fileCount === 0;
};

const persistMessage = async ({
  companyId,
  senderUserId,
  conversationId,
  clientMessageId,
  mutation,
  preview,
  // 34.2 — optional. When present, this message answers that message.
  replyToMessageId = null,
}) => {
  if (unrenderableMutation(mutation)) {
    // Refused before any DB work. Logged with safe scalars only — never the
    // body (it is invisible, but it is still user content).
    logger.warn('chat.message.unrenderable', {
      conversationId: String(conversationId),
      senderUserId: String(senderUserId),
      type: mutation?.type ?? null,
      textLength: typeof mutation?.text === 'string' ? mutation.text.length : 0,
      attachmentCount: Array.isArray(mutation?.attachments) ? mutation.attachments.length : 0,
    });

    return {
      ok: false,
      code: 'EMPTY_BODY',
      message: mutation?.type === 'FILE' ? CHAT_ATTACHMENT_MESSAGES.EMPTY : EMPTY_BODY_MESSAGE,
    };
  }

  const conversation = await loadWritableConversation({
    companyId,
    userId: senderUserId,
    conversationId,
  });

  if (!conversation) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

  if (conversation.isDisabled) return { ok: false, code: 'CONVERSATION_DISABLED' };

  // 34.2 — the parent is resolved BEFORE anything is written and with the same
  // tenant + conversation filter, so a reply can never point across a boundary
  // and a foreign id is indistinguishable from a missing one. A tombstoned
  // parent is allowed on purpose (a moderator removal must not freeze a
  // thread); its preview snippet comes back null, never the deleted text.
  let replyTo = null;

  if (replyToMessageId !== null && replyToMessageId !== undefined && replyToMessageId !== '') {
    const parent = await resolveReplyTarget({ companyId, conversationId, messageId: replyToMessageId });

    if (!parent) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

    mutation.replyToMessageId = parent._id;
    // Replying to a reply keeps the ORIGINAL root: threads stay two levels
    // deep and a thread view can never fork.
    mutation.threadRootMessageId = parent.threadRootMessageId ?? parent._id;
    replyTo = toReplyPreview(parent);
  }

  // Idempotency pre-check: a retry of an already-stored intent returns the
  // stored message instead of writing a second one.
  const existing = await ChatMessage.findOne({
    companyId,
    conversationId,
    senderUserId,
    clientMessageId,
  }).lean();

  if (existing) {
    // A retry returns the STORED message; its reply context is re-resolved so
    // the ACK still shows the hint the sender expects, without a second write.
    const storedReply =
      !replyTo && existing.replyToMessageId
        ? toReplyPreview(await resolveReplyTarget({
          companyId,
          conversationId,
          messageId: existing.replyToMessageId,
        }))
        : replyTo;

    return { ok: true, message: existing, created: false, replyTo: storedReply };
  }

  // Atomic seq allocation: bump the conversation counter and read the new
  // value in one round-trip. `new: true` returns the post-increment document,
  // so lastMessageSeq IS the seq for this message. The same update refreshes
  // the denormalized lastMessage* preview fields.
  const now = new Date();

  const updated = await ChatConversation.findOneAndUpdate(
    { _id: conversationId, companyId },
    {
      $inc: { lastMessageSeq: 1 },
      $set: {
        lastMessageAt: now,
        lastMessagePreview: buildPreview(preview),
        lastMessageSenderUserId: senderUserId,
      },
    },
    { new: true }
  ).lean();

  if (!updated) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

  const seq = updated.lastMessageSeq;

  try {
    const message = await ChatMessage.create({
      companyId,
      conversationId,
      senderUserId,
      seq,
      clientMessageId,
      ...mutation,
    });

    return { ok: true, message: message.toObject(), created: true, replyTo };
  } catch (error) {
    // Duplicate-key race: a concurrent send with the same clientMessageId won.
    // Refetch and return the winner; do NOT broadcast again.
    if (error?.code === 11000) {
      const winner = await ChatMessage.findOne({
        companyId,
        conversationId,
        senderUserId,
        clientMessageId,
      }).lean();

      if (winner) return { ok: true, message: winner, created: false, replyTo };
    }

    return { ok: false, code: 'RETRYABLE' };
  }
};

export const sendTextMessage = async ({
  companyId,
  senderUserId,
  conversationId,
  clientMessageId,
  text,
  // 34.2 — optional reply target (same tenant + conversation, verified inside).
  replyToMessageId = null,
}) =>
  persistMessage({
    companyId,
    senderUserId,
    conversationId,
    clientMessageId,
    mutation: { type: 'TEXT', text },
    preview: text,
    replyToMessageId,
  });

// 33.10 — a FILE message carries references, never bytes. `attachments` is
// the metadata array produced by linkAttachmentsToMessage (already
// revalidated for tenant + conversation + unused); this function does not
// re-derive it from the payload.
//
// 33.10-fix4 — `text` is an OPTIONAL caption (validated by the socket layer:
// visible only, length-capped). The conversation-list preview prefers the
// caption because it is a normal body, and falls back to the generic word so
// a private FILENAME never lands in a denormalized field.
export const sendFileMessage = async ({
  companyId,
  senderUserId,
  conversationId,
  clientMessageId,
  attachments,
  text = null,
  // 34.2 — a FILE message may answer a message too. Without this the reply
  // context would be silently dropped whenever the composer had an attachment.
  replyToMessageId = null,
}) => {
  const caption = hasVisibleText(text) ? String(text).trim() : null;

  return persistMessage({
    companyId,
    senderUserId,
    conversationId,
    clientMessageId,
    mutation: { type: 'FILE', text: caption, attachments },
    preview: caption ?? CHAT_FILE_PREVIEW_TEXT,
    replyToMessageId,
  });
};
