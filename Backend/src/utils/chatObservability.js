// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.11 — CHAT OBSERVABILITY (safe by construction)
//
//  WHAT MAY BE LOGGED ABOUT A RATE-LIMIT EVENT
//    surface (rest|socket), action (a FIXED vocabulary), the server-derived
//    companyId/userId, the limiter tier (shared|local), the count, the
//    maximum and the window — nothing else.
//
//  WHAT MAY NEVER BE LOGGED
//    message text, captions, attachment NAMES, storage keys, file bytes,
//    tokens, cookies, URLs, payload dumps, or any client-supplied identifier.
//    The `action` is validated against a vocabulary and anything unknown is
//    NOT logged at all (fail closed): an unrecognized string must never
//    become a log field.
//
//  This module is the only place a chat rate limit is reported, so the rule
//  is enforced once instead of at every call site. Redaction stays the
//  CALLER's law (32.12): the fields here are already safe by construction.
// ═══════════════════════════════════════════════════════════════════════════

import logger from '../config/logger.js';
import { getMetricsRegistry } from '../infrastructure/observability/metricsRegistry.js';

/** Bounded vocabulary. A new limit point adds a word here — nothing else. */
export const CHAT_LIMIT_ACTIONS = Object.freeze([
  'conversation.create',
  'conversation.list',
  'conversation.detail',
  'conversation.members.add',
  'conversation.members.remove',
  'message.history',
  'message.read',
  'message.send',
  'message.sendFile',
  'message.edit',
  'message.delete',
  'message.moderateDelete',
  'conversation.moderateState',
  'attachment.upload',
  'attachment.download',
  'socket.join',
  'socket.readUpTo',
]);

export const CHAT_LIMIT_SURFACES = Object.freeze(['rest', 'socket']);

const TIERS = Object.freeze(['shared', 'local']);

const isKnownAction = (action) => CHAT_LIMIT_ACTIONS.includes(String(action));

const isKnownSurface = (surface) => CHAT_LIMIT_SURFACES.includes(String(surface));

const safeId = (value) => {
  const text = String(value ?? '');

  // Ids are opaque internal values; anything long or unusual is dropped
  // rather than logged (a token pasted into an id field must not leak).
  return text.length > 0 && text.length <= 64 ? text : '';
};

/**
 * Report ONE rate-limit refusal. Returns true when it logged, false when the
 * event was refused by the vocabulary (never throws — observability must not
 * break a response or a socket ACK).
 */
export const logChatRateLimited = ({
  surface,
  action,
  companyId,
  userId,
  tier,
  count,
  maximum,
  windowMs,
  log = logger,
} = {}) => {
  try {
    if (!isKnownSurface(surface) || !isKnownAction(action)) return false;

    const safeTier = TIERS.includes(String(tier)) ? String(tier) : 'local';

    const meta = {
      surface: String(surface),
      action: String(action),
      tier: safeTier,
      count: Number.isFinite(Number(count)) ? Number(count) : undefined,
      maximum: Number.isFinite(Number(maximum)) ? Number(maximum) : undefined,
      windowMs: Number.isFinite(Number(windowMs)) ? Number(windowMs) : undefined,
      companyId: safeId(companyId) || undefined,
      userId: safeId(userId) || undefined,
    };

    const writer = typeof log?.warn === 'function' ? log.warn : logger.warn;

    writer.call(log, 'chat.rate_limited', meta);

    // Bounded, low-cardinality counters (allowlisted labels only).
    const metrics = getMetricsRegistry();

    metrics.increment('chat.rate_limited', { action: String(action) });
    metrics.increment('chat.rate_limit_degraded', { tier: safeTier });

    return true;
  } catch {
    return false;
  }
};

/**
 * Report the realtime-unavailable degradation ONCE per transition (never per
 * request). Reason words come from the socket layer's own safe vocabulary.
 */
export const logChatRealtimeUnavailable = ({ reason, log = logger } = {}) => {
  try {
    const safeReason = safeId(reason).slice(0, 40) || 'UNKNOWN';

    log.warn('chat.realtime_unavailable', { reason: safeReason });

    return true;
  } catch {
    return false;
  }
};

export default logChatRateLimited;
