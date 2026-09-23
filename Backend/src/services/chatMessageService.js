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
// ═══════════════════════════════════════════════════════════════════════════

import ChatConversation from '../models/ChatConversation.js';
import ChatMessage from '../models/ChatMessage.js';

const PREVIEW_MAX = 200; // matches ChatConversation.lastMessagePreview maxlength

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

export const sendTextMessage = async ({
  companyId,
  senderUserId,
  conversationId,
  clientMessageId,
  text,
}) => {
  const conversation = await loadWritableConversation({
    companyId,
    userId: senderUserId,
    conversationId,
  });

  if (!conversation) return { ok: false, code: 'NOT_FOUND_OR_FORBIDDEN' };

  if (conversation.isDisabled) return { ok: false, code: 'CONVERSATION_DISABLED' };

  // Idempotency pre-check: a retry of an already-stored intent returns the
  // stored message instead of writing a second one.
  const existing = await ChatMessage.findOne({
    companyId,
    conversationId,
    senderUserId,
    clientMessageId,
  }).lean();

  if (existing) return { ok: true, message: existing, created: false };

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
        lastMessagePreview: buildPreview(text),
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
      type: 'TEXT',
      text,
    });

    return { ok: true, message: message.toObject(), created: true };
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

      if (winner) return { ok: true, message: winner, created: false };
    }

    return { ok: false, code: 'RETRYABLE' };
  }
};
