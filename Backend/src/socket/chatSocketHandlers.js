// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.5 — CHAT SOCKET EVENT HANDLERS (join / leave / send)
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
//    server → client : chat:message:created { conversationId, message }
//
//  Every client→server event answers with an ACK of shape
//    { ok: true,  data }  or  { ok: false, code, message }
//  using the stable codes in CHAT_SOCKET_ERROR_CODES. Codes deliberately do
//  NOT distinguish "other tenant" from "not a member" (NOT_FOUND_OR_FORBIDDEN)
//  so the socket surface leaks no tenant existence.
//
//  NO presence, typing, last-seen, edit, delete or read-marker events here.
//  NO tokens, Redis ids, job ids or debug metadata in any payload or log.
// ═══════════════════════════════════════════════════════════════════════════

import { conversationRoom } from '../utils/chatKeys.js';
import {
  validateJoinPayload,
  validateSendPayload,
} from './chatSocketValidators.js';
import {
  loadWritableConversation,
  sendTextMessage,
} from '../services/chatMessageService.js';

export const CHAT_SOCKET_ERROR_CODES = Object.freeze({
  UNAUTHORIZED: 'UNAUTHORIZED',
  FEATURE_UNAVAILABLE: 'FEATURE_UNAVAILABLE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND_OR_FORBIDDEN: 'NOT_FOUND_OR_FORBIDDEN',
  CONVERSATION_DISABLED: 'CONVERSATION_DISABLED',
  RETRYABLE: 'RETRYABLE',
  RATE_LIMITED: 'RATE_LIMITED',
});

// Minimal per-socket abuse guard (fixed window). Bounded, in-memory, and
// per-socket only — it is not surveillance: nothing is stored about the user
// beyond the current window's counter, which dies with the socket.
const SEND_WINDOW_MS = 10_000;
const SEND_MAX_PER_WINDOW = 30;

const createSendGuard = () => {
  let windowStart = Date.now();
  let count = 0;

  return () => {
    const now = Date.now();

    if (now - windowStart >= SEND_WINDOW_MS) {
      windowStart = now;
      count = 0;
    }

    count += 1;

    return count <= SEND_MAX_PER_WINDOW;
  };
};

const ack = (callback, payload) => {
  if (typeof callback === 'function') callback(payload);
};

const fail = (code, message) => ({ ok: false, code, message });

// Broadcast shape is deliberately small and token/redis/job-free. The sender
// needs clientMessageId + seq to reconcile its optimistic UI; everyone needs
// enough to render the message.
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

    return;
  }

  const allowSend = createSendGuard();

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

    if (!allowSend()) {
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
};
