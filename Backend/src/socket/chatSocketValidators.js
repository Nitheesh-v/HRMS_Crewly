// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.5 — CHAT SOCKET PAYLOAD VALIDATORS
//
//  Socket frames are untrusted input, exactly like HTTP bodies. These are
//  deliberately NOT express-validator chains (there is no req/res here) —
//  they are tiny pure functions that either return a normalized payload or a
//  VALIDATION_ERROR shape, so the handlers stay readable and hermetically
//  testable.
//
//  Every rule mirrors the 33.2 schema bounds (text ≤ CHAT_MESSAGE_TEXT_MAX,
//  clientMessageId ≤ 80) so a frame that passes here can never fail schema
//  validation for a size reason.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import { CHAT_MESSAGE_TEXT_MAX } from '../models/ChatMessage.js';
import { hasVisibleText } from '../utils/chatTextRules.js';
import { CHAT_ATTACHMENT_MAX_PER_MESSAGE } from '../utils/chatFileRules.js';
// 34.1 — the reaction vocabulary is defined by the model, never by the client.
import { CHAT_REACTION_TYPES } from '../models/ChatMessageReaction.js';

export const CHAT_CLIENT_MESSAGE_ID_MAX = 80;
export const CHAT_CLIENT_EDIT_ID_MAX = 80;
export const CHAT_DELETE_REASON_MAX = 200;

const validationError = (message) => ({ ok: false, code: 'VALIDATION_ERROR', message });

const asObject = (payload) =>
  payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;

export const validateJoinPayload = (payload) => {
  const body = asObject(payload);

  if (!body) return validationError('A join payload is required.');

  if (!mongoose.isValidObjectId(String(body.conversationId || ''))) {
    return validationError('conversationId is not a valid identifier.');
  }

  return { ok: true, conversationId: String(body.conversationId) };
};

export const validateSendPayload = (payload) => {
  const body = asObject(payload);

  if (!body) return validationError('A message payload is required.');

  if (!mongoose.isValidObjectId(String(body.conversationId || ''))) {
    return validationError('conversationId is not a valid identifier.');
  }

  const clientMessageId = String(body.clientMessageId || '').trim();

  if (clientMessageId.length < 1 || clientMessageId.length > CHAT_CLIENT_MESSAGE_ID_MAX) {
    return validationError('clientMessageId is required for idempotent delivery.');
  }

  const text = String(body.text ?? '').trim();

  // 33.10-fix2 — `trim()` alone accepts a body made of zero-width/invisible
  // characters, which stored a message nobody could read (an empty bubble for
  // every member). The body must carry at least one VISIBLE character.
  if (!hasVisibleText(text)) return validationError('A message must not be empty.');

  if (text.length > CHAT_MESSAGE_TEXT_MAX) {
    return validationError(`A message must be at most ${CHAT_MESSAGE_TEXT_MAX} characters.`);
  }

  return {
    ok: true,
    conversationId: String(body.conversationId),
    clientMessageId,
    text,
  };
};

// 33.6 — edit. expectedEditVersion is the optimistic-concurrency token: the
// client must send the editVersion it based its edit on, so a stale editor
// fails with CONFLICT_EDIT_VERSION instead of clobbering a newer edit.
export const validateEditPayload = (payload) => {
  const body = asObject(payload);

  if (!body) return validationError('An edit payload is required.');

  if (!mongoose.isValidObjectId(String(body.conversationId || ''))) {
    return validationError('conversationId is not a valid identifier.');
  }

  if (!mongoose.isValidObjectId(String(body.messageId || ''))) {
    return validationError('messageId is not a valid identifier.');
  }

  const { expectedEditVersion } = body;

  if (!Number.isInteger(expectedEditVersion) || expectedEditVersion < 0) {
    return validationError('expectedEditVersion must be a whole number of zero or more.');
  }

  const text = String(body.newText ?? '').trim();

  // Same visibility law as send: an edit may not blank a message into an
  // invisible one either.
  if (!hasVisibleText(text)) return validationError('The edited text must not be empty.');

  if (text.length > CHAT_MESSAGE_TEXT_MAX) {
    return validationError(`A message must be at most ${CHAT_MESSAGE_TEXT_MAX} characters.`);
  }

  let clientEditId = null;

  if (body.clientEditId !== undefined && body.clientEditId !== null) {
    clientEditId = String(body.clientEditId).trim();

    if (clientEditId.length < 1 || clientEditId.length > CHAT_CLIENT_EDIT_ID_MAX) {
      return validationError('clientEditId must be at most 80 characters.');
    }
  }

  return {
    ok: true,
    conversationId: String(body.conversationId),
    messageId: String(body.messageId),
    expectedEditVersion,
    text,
    clientEditId,
  };
};

// 33.6 — delete (tombstone). reason is accepted and bounded but not
// persisted in 33.6; ChatMessage carries no delete-reason field until 33.9.
export const validateDeletePayload = (payload) => {
  const body = asObject(payload);

  if (!body) return validationError('A delete payload is required.');

  if (!mongoose.isValidObjectId(String(body.conversationId || ''))) {
    return validationError('conversationId is not a valid identifier.');
  }

  if (!mongoose.isValidObjectId(String(body.messageId || ''))) {
    return validationError('messageId is not a valid identifier.');
  }

  let reason = null;

  if (body.reason !== undefined && body.reason !== null) {
    reason = String(body.reason).trim();

    if (reason.length > CHAT_DELETE_REASON_MAX) {
      return validationError(`reason must be at most ${CHAT_DELETE_REASON_MAX} characters.`);
    }
  }

  return {
    ok: true,
    conversationId: String(body.conversationId),
    messageId: String(body.messageId),
    reason,
  };
};

// 33.7 — read cursor advance. Same bounds as the REST read marker: a whole
// number of zero or more; the service clamps it to lastMessageSeq and keeps
// the higher of old/new (monotonic).
export const validateReadUpToPayload = (payload) => {
  const body = asObject(payload);

  if (!body) return validationError('A read payload is required.');

  if (!mongoose.isValidObjectId(String(body.conversationId || ''))) {
    return validationError('conversationId is not a valid identifier.');
  }

  const { lastReadSeq } = body;

  if (!Number.isInteger(lastReadSeq) || lastReadSeq < 0) {
    return validationError('lastReadSeq must be a whole number of zero or more.');
  }

  return {
    ok: true,
    conversationId: String(body.conversationId),
    lastReadSeq,
  };
};

// ── 33.10 — FILE send ─────────────────────────────────────────────────────
// Same idempotency contract as TEXT (clientMessageId is required), but the
// body is a bounded, deduplicated array of attachment ids. Ids are validated
// as ObjectIds HERE so a malformed frame never reaches a Mongo query; the
// tenant/conversation/unused revalidation happens in the service, because
// only the database can answer those questions.
/**
 * 34.1 — chat:message:react / chat:message:unreact.
 *
 * `reactionType` is validated against the model's closed set, so an unknown
 * string is a VALIDATION_ERROR at the edge instead of a schema failure deep
 * inside the write path. The type is normalized to upper case first — a client
 * sending "like" means LIKE, and refusing it would be pedantry, not security.
 */
export const validateReactionPayload = (payload) => {
  const body = asObject(payload);

  if (!body) return validationError('A reaction payload is required.');

  if (!mongoose.isValidObjectId(String(body.conversationId || ''))) {
    return validationError('conversationId is not a valid identifier.');
  }

  if (!mongoose.isValidObjectId(String(body.messageId || ''))) {
    return validationError('messageId is not a valid identifier.');
  }

  const reactionType = String(body.reactionType || '').trim().toUpperCase();

  if (!CHAT_REACTION_TYPES.includes(reactionType)) {
    return validationError('That reaction is not supported.');
  }

  return {
    ok: true,
    conversationId: String(body.conversationId),
    messageId: String(body.messageId),
    reactionType,
  };
};

export const validateSendFilePayload = (payload) => {
  const body = asObject(payload);

  if (!body) return validationError('A message payload is required.');

  if (!mongoose.isValidObjectId(String(body.conversationId || ''))) {
    return validationError('conversationId is not a valid identifier.');
  }

  const clientMessageId = String(body.clientMessageId || '').trim();

  if (clientMessageId.length < 1 || clientMessageId.length > CHAT_CLIENT_MESSAGE_ID_MAX) {
    return validationError('clientMessageId is required for idempotent delivery.');
  }

  if (!Array.isArray(body.attachmentIds)) {
    return validationError('attachmentIds must be a list of attachment ids.');
  }

  const attachmentIds = [...new Set(body.attachmentIds.map((id) => String(id || '')))];

  if (attachmentIds.length < 1) return validationError('At least one file is required.');

  if (attachmentIds.length > CHAT_ATTACHMENT_MAX_PER_MESSAGE) {
    return validationError(
      `A message can carry at most ${CHAT_ATTACHMENT_MAX_PER_MESSAGE} files.`
    );
  }

  if (attachmentIds.some((id) => !mongoose.isValidObjectId(id))) {
    return validationError('attachmentIds contains an invalid identifier.');
  }

  // 33.10-fix4 — an OPTIONAL caption. The composer has always sent the typed
  // text with the files; until now the server dropped it. A caption is a body,
  // so it obeys the same rules as any other body: visible, and length-capped.
  const caption = String(body.text ?? '').trim();

  if (caption.length > 0 && !hasVisibleText(caption)) {
    return validationError('A message must not be empty.');
  }

  if (caption.length > CHAT_MESSAGE_TEXT_MAX) {
    return validationError(`A message must be at most ${CHAT_MESSAGE_TEXT_MAX} characters.`);
  }

  return {
    ok: true,
    conversationId: String(body.conversationId),
    clientMessageId,
    attachmentIds,
    text: caption.length > 0 ? caption : null,
  };
};
