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

export const CHAT_CLIENT_MESSAGE_ID_MAX = 80;

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

  if (text.length < 1) return validationError('A message must not be empty.');

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
