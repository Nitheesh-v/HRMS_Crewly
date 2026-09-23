// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.5/33.6 — CHAT SOCKET EVENT HANDLERS (join / leave / send / edit / delete)
//
//  Registered once per authenticated socket by initSocketServer (33.1).
//  Authority comes ONLY from socket.data (set by the 33.1 handshake, the
//  socket re-expression of `protect`): companyId + userId. Payloads are
//  untrusted and are validated by chatSocketValidators before anything else.
//
//  Events (namespaced):
//    client → server : chat:join { conversationId }
//                      chat:leave { conversationId }
//                      chat:message:send { conversationId, clientMessageId, text }
//                      chat:message:edit { conversationId, messageId,
//                                          expectedEditVersion, newText }        (33.6)
//                      chat:message:delete { conversationId, messageId }          (33.6)
//                      chat:readUpTo { conversationId, lastReadSeq }              (33.7)
//    server → client : chat:message:created { conversationId, message }
//                      chat:message:updated { conversationId, messageId, newText,
//                                             editedAt, editVersion, editedByUserId } (33.6)
//                      chat:message:deleted { conversationId, messageId,
//                                             deletedAt, deletedByUserId }        (33.6)
//
//  Every client→server event answers with an ACK of shape
//    { ok: true,  data }  or  { ok: false, code, message }
//  using the stable codes in CHAT_SOCKET_ERROR_CODES (utils/chatErrors.js).
//  Codes deliberately do NOT distinguish "other tenant" from "not a member"
//  (NOT_FOUND_OR_FORBIDDEN) so the socket surface leaks no tenant existence.
//
//  33.6 edit/delete are sender-only and Mongo-authoritative. 33.7's
//  chat:readUpTo advances the caller's own C1 cursor and ACKs to the caller
//  ONLY — read state is never broadcast (it would be presence-ish
//  surveillance). No presence, typing or last-seen events here. NO tokens,
//  Redis ids, job ids or debug metadata in any payload or log.
// ═══════════════════════════════════════════════════════════════════════════

import { conversationRoom } from '../utils/chatKeys.js';
import { CHAT_SOCKET_ERROR_CODES } from '../utils/chatErrors.js';
import {
  validateJoinPayload,
  validateSendPayload,
  validateEditPayload,
  validateDeletePayload,
  validateReadUpToPayload,
} from './chatSocketValidators.js';
import {
  loadWritableConversation,
  sendTextMessage,
} from '../services/chat/chatMessageService.js';
import {
  editTextMessage,
  tombstoneMessage,
} from '../services/chat/chatEditService.js';
import { updateReadMarker } from '../services/chat/chatReadService.js';

export { CHAT_SOCKET_ERROR_CODES };

// Minimal per-socket abuse guard (fixed window), shared by every writing
// chat event (send, edit, delete). Bounded, in-memory, and per-socket only —
// it is not surveillance: nothing is stored about the user beyond the
// current window's counter, which dies with the socket.
const WRITE_WINDOW_MS = 10_000;
const WRITE_MAX_PER_WINDOW = 30;

const createWriteGuard = () => {
  let windowStart = Date.now();
  let count = 0;

  return () => {
    const now = Date.now();

    if (now - windowStart >= WRITE_WINDOW_MS) {
      windowStart = now;
      count = 0;
    }

    count += 1;

    return count <= WRITE_MAX_PER_WINDOW;
  };
};

const ack = (callback, payload) => {
  if (typeof callback === 'function') callback(payload);
};

const fail = (code, message) => ({ ok: false, code, message });

// Broadcast shape is deliberately small and token/redis/job-free. The sender
// needs clientMessageId + seq to reconcile its optimistic UI; everyone needs
// enough to render the message.
// Map a service failure code onto a stable ACK code. Anything unexpected
// degrades to RETRYABLE rather than leaking an internal shape.
const editFailureCode = (code) => {
  const known = [
    CHAT_SOCKET_ERROR_CODES.NOT_FOUND_OR_FORBIDDEN,
    CHAT_SOCKET_ERROR_CODES.CONVERSATION_DISABLED,
    CHAT_SOCKET_ERROR_CODES.MESSAGE_DELETED,
    CHAT_SOCKET_ERROR_CODES.MESSAGE_NOT_EDITABLE,
    CHAT_SOCKET_ERROR_CODES.CONFLICT_EDIT_VERSION,
    CHAT_SOCKET_ERROR_CODES.HISTORY_LIMIT_REACHED,
  ];

  return known.includes(code) ? code : CHAT_SOCKET_ERROR_CODES.RETRYABLE;
};

const editFailureMessage = (code) => ({
  [CHAT_SOCKET_ERROR_CODES.NOT_FOUND_OR_FORBIDDEN]: 'Message not found.',
  [CHAT_SOCKET_ERROR_CODES.CONVERSATION_DISABLED]: 'This conversation is disabled.',
  [CHAT_SOCKET_ERROR_CODES.MESSAGE_DELETED]: 'This message was deleted.',
  [CHAT_SOCKET_ERROR_CODES.MESSAGE_NOT_EDITABLE]: 'This message cannot be changed.',
  [CHAT_SOCKET_ERROR_CODES.CONFLICT_EDIT_VERSION]: 'The message changed since you loaded it. Refresh and retry.',
  [CHAT_SOCKET_ERROR_CODES.HISTORY_LIMIT_REACHED]: 'This message has reached the edit history limit.',
})[code] ?? 'The change could not be applied.';

const toBroadcastMessage = (message) => ({
  _id: message._id,
  seq: message.seq,
  senderUserId: message.senderUserId,
  type: message.type,
  text: message.text ?? null,
  clientMessageId: message.clientMessageId,
  editVersion: message.editVersion ?? 0,
  deletedAt: message.deletedAt ?? null,
  createdAt: message.createdAt ?? null,
});

export const registerChatSocketHandlers = ({
  io,
  socket,
  log = console,
  loadConversation = loadWritableConversation,
  sendMessage = sendTextMessage,
  editMessage = editTextMessage,
  deleteMessage = tombstoneMessage,
  markRead = updateReadMarker,
}) => {
  const companyId = socket.data?.companyId;
  const userId = socket.data?.userId;

  // A socket without a server-derived principal must not use chat events.
  // (33.1 already refuses such connections; this is defense in depth.)
  if (!companyId || !userId) {
    socket.on('chat:join', (_p, cb) =>
      ack(cb, fail(CHAT_SOCKET_ERROR_CODES.UNAUTHORIZED, 'Authentication required.')));
    socket.on('chat:message:send', (_p, cb) =>
      ack(cb, fail(CHAT_SOCKET_ERROR_CODES.UNAUTHORIZED, 'Authentication required.')));
    socket.on('chat:message:edit', (_p, cb) =>
      ack(cb, fail(CHAT_SOCKET_ERROR_CODES.UNAUTHORIZED, 'Authentication required.')));
    socket.on('chat:message:delete', (_p, cb) =>
      ack(cb, fail(CHAT_SOCKET_ERROR_CODES.UNAUTHORIZED, 'Authentication required.')));
    socket.on('chat:readUpTo', (_p, cb) =>
      ack(cb, fail(CHAT_SOCKET_ERROR_CODES.UNAUTHORIZED, 'Authentication required.')));

    return;
  }

  const allowWrite = createWriteGuard();

  socket.on('chat:join', async (payload, cb) => {
    const parsed = validateJoinPayload(payload);

    if (!parsed.ok) return ack(cb, fail(CHAT_SOCKET_ERROR_CODES.VALIDATION_ERROR, parsed.message));

    const conversation = await loadConversation({
      companyId,
      userId,
      conversationId: parsed.conversationId,
    });

    if (!conversation) {
      return ack(cb, fail(
        CHAT_SOCKET_ERROR_CODES.NOT_FOUND_OR_FORBIDDEN,
        'Conversation not found.',
      ));
    }

    if (conversation.isDisabled) {
      return ack(cb, fail(
        CHAT_SOCKET_ERROR_CODES.CONVERSATION_DISABLED,
        'This conversation is disabled.',
      ));
    }

    await socket.join(conversationRoom(parsed.conversationId));

    ack(cb, { ok: true });
  });

  socket.on('chat:leave', (payload, cb) => {
    const parsed = validateJoinPayload(payload);

    if (!parsed.ok) return ack(cb, fail(CHAT_SOCKET_ERROR_CODES.VALIDATION_ERROR, parsed.message));

    socket.leave(conversationRoom(parsed.conversationId));

    ack(cb, { ok: true });
  });

  socket.on('chat:message:send', async (payload, cb) => {
    const parsed = validateSendPayload(payload);

    if (!parsed.ok) return ack(cb, fail(CHAT_SOCKET_ERROR_CODES.VALIDATION_ERROR, parsed.message));

    if (!allowWrite()) {
      return ack(cb, fail(
        CHAT_SOCKET_ERROR_CODES.RATE_LIMITED,
        'Too many messages. Slow down and retry.',
      ));
    }

    const result = await sendMessage({
      companyId,
      senderUserId: userId,
      conversationId: parsed.conversationId,
      clientMessageId: parsed.clientMessageId,
      text: parsed.text,
    });

    if (!result.ok) {
      const code = result.code === 'NOT_FOUND_OR_FORBIDDEN'
        ? CHAT_SOCKET_ERROR_CODES.NOT_FOUND_OR_FORBIDDEN
        : result.code === 'CONVERSATION_DISABLED'
          ? CHAT_SOCKET_ERROR_CODES.CONVERSATION_DISABLED
          : CHAT_SOCKET_ERROR_CODES.RETRYABLE;

      return ack(cb, fail(code, 'The message could not be sent.'));
    }

    // Broadcast only a genuinely new message; an idempotent retry is
    // acknowledged to the sender without re-emitting to the room.
    if (result.created) {
      io.to(conversationRoom(parsed.conversationId)).emit('chat:message:created', {
        conversationId: parsed.conversationId,
        message: toBroadcastMessage(result.message),
      });
    }

    ack(cb, { ok: true, data: { message: toBroadcastMessage(result.message) } });
  });

  // 33.6 — edit. Optimistic concurrency lives in the service (the atomic
  // update filters on expectedEditVersion); the handler only validates,
  // rate-guards, and fans the win out to the room.
  socket.on('chat:message:edit', async (payload, cb) => {
    const parsed = validateEditPayload(payload);

    if (!parsed.ok) return ack(cb, fail(CHAT_SOCKET_ERROR_CODES.VALIDATION_ERROR, parsed.message));

    if (!allowWrite()) {
      return ack(cb, fail(
        CHAT_SOCKET_ERROR_CODES.RATE_LIMITED,
        'Too many changes. Slow down and retry.',
      ));
    }

    const result = await editMessage({
      companyId,
      editorUserId: userId,
      conversationId: parsed.conversationId,
      messageId: parsed.messageId,
      expectedEditVersion: parsed.expectedEditVersion,
      newText: parsed.text,
    });

    if (!result.ok) {
      return ack(cb, fail(editFailureCode(result.code), editFailureMessage(result.code)));
    }

    io.to(conversationRoom(parsed.conversationId)).emit('chat:message:updated', {
      conversationId: parsed.conversationId,
      messageId: result.message._id,
      newText: result.message.text,
      editedAt: result.message.editedAt,
      editVersion: result.message.editVersion,
      editedByUserId: result.message.editedByUserId,
    });

    ack(cb, { ok: true, data: { message: toBroadcastMessage(result.message) } });
  });

  // 33.6 — delete (tombstone). Idempotent: re-deleting an already-tombstoned
  // message acknowledges with the original deletedAt and does NOT re-broadcast.
  socket.on('chat:message:delete', async (payload, cb) => {
    const parsed = validateDeletePayload(payload);

    if (!parsed.ok) return ack(cb, fail(CHAT_SOCKET_ERROR_CODES.VALIDATION_ERROR, parsed.message));

    if (!allowWrite()) {
      return ack(cb, fail(
        CHAT_SOCKET_ERROR_CODES.RATE_LIMITED,
        'Too many changes. Slow down and retry.',
      ));
    }

    const result = await deleteMessage({
      companyId,
      deleterUserId: userId,
      conversationId: parsed.conversationId,
      messageId: parsed.messageId,
    });

    if (!result.ok) {
      return ack(cb, fail(editFailureCode(result.code), editFailureMessage(result.code)));
    }

    if (result.changed) {
      io.to(conversationRoom(parsed.conversationId)).emit('chat:message:deleted', {
        conversationId: parsed.conversationId,
        messageId: result.messageId,
        deletedAt: result.deletedAt,
        deletedByUserId: userId,
      });
    }

    ack(cb, { ok: true, data: { messageId: result.messageId, deletedAt: result.deletedAt } });
  });

  // 33.7 — advance the caller's own C1 read cursor. Monotonic + clamped in
  // the service; ACKs to the caller ONLY. Read state is privacy-sensitive,
  // so nothing is broadcast to other members (no "seen by" in Phase 33).
  socket.on('chat:readUpTo', async (payload, cb) => {
    const parsed = validateReadUpToPayload(payload);

    if (!parsed.ok) return ack(cb, fail(CHAT_SOCKET_ERROR_CODES.VALIDATION_ERROR, parsed.message));

    const result = await markRead({
      companyId,
      userId,
      conversationId: parsed.conversationId,
      lastReadSeq: parsed.lastReadSeq,
    });

    if (!result.ok) {
      return ack(cb, fail(
        CHAT_SOCKET_ERROR_CODES.NOT_FOUND_OR_FORBIDDEN,
        'Conversation not found.',
      ));
    }

    ack(cb, {
      ok: true,
      data: { myLastReadSeq: result.myLastReadSeq, unreadCount: result.unreadCount },
    });
  });
};
