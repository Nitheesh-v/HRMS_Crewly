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
//                      chat:message:sendFile { conversationId, clientMessageId,
//                                              attachmentIds[] }                  (33.10)
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
//
//  33.9 MODERATION: deletion gains ONE moderator fallback — when the
//  sender-only rule refuses a delete, a CHAT_MODERATE holder may tombstone
//  the message instead (resolved server-side from role matrices; audit is
//  written by moderateDeleteMessage). Disabled conversations keep refusing
//  send/edit/delete for everyone who is not a moderator; the lock itself is
//  applied over REST (PATCH .../disable) and needs no socket event.
// ═══════════════════════════════════════════════════════════════════════════

import { conversationRoom, userRoom } from '../utils/chatKeys.js';
import { CHAT_SOCKET_ERROR_CODES } from '../utils/chatErrors.js';
import {
  validateJoinPayload,
  validateSendPayload,
  validateEditPayload,
  validateDeletePayload,
  validateReadUpToPayload,
  validateSendFilePayload,
} from './chatSocketValidators.js';
import {
  loadWritableConversation,
  sendFileMessage,
  sendTextMessage,
} from '../services/chat/chatMessageService.js';
import { linkAttachmentsToMessage } from '../services/chat/chatAttachmentService.js';
import { toAttachmentReferences } from '../utils/chatAttachmentView.js';
import {
  editTextMessage,
  tombstoneMessage,
} from '../services/chat/chatEditService.js';
import { updateReadMarker } from '../services/chat/chatReadService.js';
import {
  actorHasChatModerate,
  moderateDeleteMessage,
} from '../services/chat/chatModerationService.js';

export { CHAT_SOCKET_ERROR_CODES };

// The ONLY refusals a CHAT_MODERATE holder may overturn on delete (33.9).
const MODERATOR_FALLBACK_CODES = new Set([
  'MESSAGE_NOT_EDITABLE',
  'CONVERSATION_DISABLED',
  'NOT_FOUND_OR_FORBIDDEN',
]);

// Moderation gate for the delete fallback. Never throws: an unavailable
// permission resolve means "not a moderator" (fail closed).
const defaultResolveModerator = async ({ companyId, userId }) => {
  try {
    return await actorHasChatModerate({ companyId, userId });
  } catch {
    return false;
  }
};

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

// 33.9-fix — NO ASYNC LISTENER MAY REJECT.
// socket.io invokes listeners through EventEmitter and ignores the returned
// promise, so a rejected async listener becomes an unhandledRejection — and
// the 32.x process policy drains the whole API on one (observed live: a
// mongoose ValidationError from a TEXT edit took the server down). Every
// chat listener therefore runs inside this guard: a service throw becomes a
// RETRYABLE ACK (the generic 33.x code), never a process event. Only the
// error NAME reaches the log — never payloads, text or stacks.
const reportHandlerError = (log, event, error) => {
  const message = `[ChatSocket] ${event} failed (${String(error?.name || 'error')})`;

  if (typeof log?.error === 'function') log.error(message);
  else if (typeof log?.warn === 'function') log.warn(message);
};

const guard = (socket, log, event, handler) =>
  socket.on(event, async (payload, cb) => {
    try {
      return await handler(payload, cb);
    } catch (error) {
      reportHandlerError(log, event, error);

      return ack(
        cb,
        fail(
          CHAT_SOCKET_ERROR_CODES.RETRYABLE,
          'The chat server could not complete that action. Try again.',
        ),
      );
    }
  });

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
  // 33.10 — references only (id + display metadata). Never a storage key,
  // never a URL: the download is a separate, auth-gated request.
  // 33.10-fix3 — ONE definition, shared with the REST history projection so
  // the two surfaces cannot drift (they did: history dropped the field).
  attachments: toAttachmentReferences(message.attachments),
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
  // 33.10 — injectable so the FILE path is hermetically testable.
  linkAttachments = linkAttachmentsToMessage,
  sendFile = sendFileMessage,
  // 33.9 — moderation. Injectable so handler tests stay hermetic (no role
  // provisioning, no Mongo). resolveModerator degrades to false on error.
  resolveModerator = defaultResolveModerator,
  moderateDelete = moderateDeleteMessage,
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
    socket.on('chat:message:sendFile', (_p, cb) =>
      ack(cb, fail(CHAT_SOCKET_ERROR_CODES.UNAUTHORIZED, 'Authentication required.')));
    socket.on('chat:message:delete', (_p, cb) =>
      ack(cb, fail(CHAT_SOCKET_ERROR_CODES.UNAUTHORIZED, 'Authentication required.')));
    socket.on('chat:readUpTo', (_p, cb) =>
      ack(cb, fail(CHAT_SOCKET_ERROR_CODES.UNAUTHORIZED, 'Authentication required.')));

    return;
  }

  // 33.8-fix — personal room so REST-side list changes (a conversation
  // created elsewhere) can nudge members who have not opened that
  // conversation yet. Routing metadata only: no presence state is written,
  // nothing surveillance-shaped (locked 33 decision).
  socket.join(userRoom(userId));

  const allowWrite = createWriteGuard();

  guard(socket, log, 'chat:join', async (payload, cb) => {
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

  guard(socket, log, 'chat:leave', (payload, cb) => {
    const parsed = validateJoinPayload(payload);

    if (!parsed.ok) return ack(cb, fail(CHAT_SOCKET_ERROR_CODES.VALIDATION_ERROR, parsed.message));

    socket.leave(conversationRoom(parsed.conversationId));

    ack(cb, { ok: true });
  });

  guard(socket, log, 'chat:message:send', async (payload, cb) => {
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
      // 33.10-fix2 — a refused unrenderable body is the caller's mistake, not
      // a server fault: answer with the rule, not with "retry".
      if (result.code === 'EMPTY_BODY') {
        return ack(cb, fail(
          CHAT_SOCKET_ERROR_CODES.VALIDATION_ERROR,
          result.message || 'A message must not be empty.',
        ));
      }

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

  // 33.10 — FILE send. The ids are revalidated against THIS tenant and THIS
  // conversation before anything is written (linkAttachments), so an id from
  // another room — or another company — cannot be attached here. The message
  // then stores only the metadata the service returned, never the ids the
  // client asked for. Same idempotency index and same ACK shape as TEXT.
  guard(socket, log, 'chat:message:sendFile', async (payload, cb) => {
    const parsed = validateSendFilePayload(payload);

    if (!parsed.ok) return ack(cb, fail(CHAT_SOCKET_ERROR_CODES.VALIDATION_ERROR, parsed.message));

    if (!allowWrite()) {
      return ack(cb, fail(
        CHAT_SOCKET_ERROR_CODES.RATE_LIMITED,
        'Too many messages. Slow down and retry.',
      ));
    }

    let attachments;

    try {
      attachments = await linkAttachments({
        companyId,
        conversationId: parsed.conversationId,
        attachmentIds: parsed.attachmentIds,
      });
    } catch (error) {
      // A rejected link is a REFUSAL, not a server fault: the caller is told
      // which of the two things went wrong, without a tenant probe surface.
      return ack(cb, fail(
        CHAT_SOCKET_ERROR_CODES.VALIDATION_ERROR,
        error?.message || 'The attachments are not available in this conversation.',
      ));
    }

    const result = await sendFile({
      companyId,
      senderUserId: userId,
      conversationId: parsed.conversationId,
      clientMessageId: parsed.clientMessageId,
      attachments,
    });

    if (!result.ok) {
      // 33.10-fix2 — a refused unrenderable body is the caller's mistake, not
      // a server fault: answer with the rule, not with "retry".
      if (result.code === 'EMPTY_BODY') {
        return ack(cb, fail(
          CHAT_SOCKET_ERROR_CODES.VALIDATION_ERROR,
          result.message || 'A message must not be empty.',
        ));
      }

      const code = result.code === 'NOT_FOUND_OR_FORBIDDEN'
        ? CHAT_SOCKET_ERROR_CODES.NOT_FOUND_OR_FORBIDDEN
        : result.code === 'CONVERSATION_DISABLED'
          ? CHAT_SOCKET_ERROR_CODES.CONVERSATION_DISABLED
          : CHAT_SOCKET_ERROR_CODES.RETRYABLE;

      return ack(cb, fail(code, 'The message could not be sent.'));
    }

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
  guard(socket, log, 'chat:message:edit', async (payload, cb) => {
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
  guard(socket, log, 'chat:message:delete', async (payload, cb) => {
    const parsed = validateDeletePayload(payload);

    if (!parsed.ok) return ack(cb, fail(CHAT_SOCKET_ERROR_CODES.VALIDATION_ERROR, parsed.message));

    if (!allowWrite()) {
      return ack(cb, fail(
        CHAT_SOCKET_ERROR_CODES.RATE_LIMITED,
        'Too many changes. Slow down and retry.',
      ));
    }

    let result = await deleteMessage({
      companyId,
      deleterUserId: userId,
      conversationId: parsed.conversationId,
      messageId: parsed.messageId,
    });

    // 33.9 — moderation fallback: the sender-only rule is the ONLY gate a
    // CHAT_MODERATE holder may bypass (only for delete, never edit). The
    // permission is resolved server-side from role matrices; a broken
    // resolve degrades to "not a moderator". The lookup runs only on the
    // refusal codes a moderator could legitimately overturn, so the happy
    // path stays a single Mongo round-trip.
    if (!result.ok && MODERATOR_FALLBACK_CODES.has(result.code)) {
      const isModerator = await resolveModerator({ companyId, userId });

      if (isModerator) {
        result = await moderateDelete({
          companyId,
          actorId: userId,
          conversationId: parsed.conversationId,
          messageId: parsed.messageId,
        });
      }
    }

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
  guard(socket, log, 'chat:readUpTo', async (payload, cb) => {
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
