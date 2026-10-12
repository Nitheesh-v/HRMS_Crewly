// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — PRESENCE BUS (thin façade over /presence Socket.IO)
//
//  The socket handlers, REST controller, and work-location workflow
//  publish through this one typed seam. Product presence events go to
//  the authenticated `/presence` namespace, whose dedicated Redis
//  adapter provides cross-instance fan-out. They do not use the
//  infrastructure-only Phase 32.11 SSE gateway (its allowlist excludes
//  product events), and do not depend on REALTIME_ENABLED.
//
//  WHAT THIS MODULE DOES NOT DO
//    · Does NOT import Socket.IO or a Redis client directly.
//    · Does NOT mutate any Redis key (that's presenceLiveStore).
//    · Does NOT carry PII. Envelopes have fixed, minimal shapes.
//    · Does NOT make HTTP / HR decisions depend on realtime delivery.
//      A missing namespace or failed publish is a safe no-op.
// ═══════════════════════════════════════════════════════════════════════════

import {
  buildPresenceChangedEnvelope,
  PRESENCE_GATEWAY_EVENT_TYPE,
  PRESENCE_INVALIDATED_EVENT_TYPE,
  buildPresenceInvalidatedEnvelope,
} from './presenceEvents.js';
import {
  emitPresenceSocketEvent,
  isPresenceSocketPublisherReady,
} from './presenceSocketPublisher.js';

/**
 * Publish a `presence:changed` envelope. Returns `{ok, delivered, error}`
 * so the caller can log a meaningful outcome (or assert against it in
 * tests). Never throws.
 *
 * @param {Object} input
 * @param {string} input.companyId        — server-derived
 * @param {string} input.userId           — server-derived
 * @param {string} input.presence         — resolver output
 * @param {string} input.presenceSource   — 'manual' | 'automatic' | 'none'
 * @param {string} [input.occurredAt]     — ISO; defaults to now
 * @param {string} [input.source]         — one of the bus sources
 */
export const publishPresenceChanged = async (input = {}) => {
  const occurredAt =
    typeof input.occurredAt === 'string' && input.occurredAt
      ? input.occurredAt
      : new Date().toISOString();

  let built;
  try {
    built = buildPresenceChangedEnvelope({
      companyId: input.companyId,
      userId: input.userId,
      presence: input.presence,
      presenceSource: input.presenceSource || 'none',
      occurredAt,
      source: input.source || 'resolver',
    });
  } catch (err) {
    // A coding error (forbidden key, missing field, oversize envelope)
    // is a 500-in-the-caller without breaking the request. Logged once.
    return {
      ok: false,
      delivered: 'none',
      error: err?.message || 'envelope build failed',
    };
  }

  // Product presence events use the dedicated /presence Socket.IO
  // namespace. The namespace's Redis adapter handles cross-instance
  // delivery; REALTIME_ENABLED is the separate infrastructure-only SSE
  // gateway and is intentionally not a prerequisite for this product path.
  return emitPresenceSocketEvent({
    event: PRESENCE_GATEWAY_EVENT_TYPE,
    companyId: built.envelope.companyId,
    envelope: built.envelope,
  });
};

/**
 * Whether the authenticated presence namespace is attached and ready to
 * publish. A missing namespace is a safe no-op for REST callers.
 */
export const presenceBusAvailable = () => isPresenceSocketPublisherReady();

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.5 — INVALIDATION ENVELOPE
//
//  When a work-location request is APPROVED or an APPROVED request is
//  CANCELLED, the affected user's connected client refetches its request
//  and presence state. The invalidation envelope carries the minimum
//  needed for the frontend to act: companyId, userId, and occurredAt.
//  Authorized team rows converge through the page's batched REST refresh.
//  The payload NEVER contains a decision note, reviewer name, requester
//  email, or any other PII (spec §30).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Publish a `presence:invalidated` envelope. Best-effort. Never throws.
 * @param {Object} input
 * @param {string} input.companyId
 * @param {string} input.userId
 * @param {string} [input.source]  — 'approve' | 'cancel' | 'resolver'
 */
export const publishPresenceInvalidated = async (input = {}) => {
  const occurredAt =
    typeof input.occurredAt === 'string' && input.occurredAt
      ? input.occurredAt
      : new Date().toISOString();

  let built;
  try {
    built = buildPresenceInvalidatedEnvelope({
      companyId: input.companyId,
      userId: input.userId,
      source: input.source || 'resolver',
      occurredAt,
    });
  } catch (err) {
    return {
      ok: false,
      delivered: 'none',
      error: err?.message || 'invalidation envelope build failed',
    };
  }

  return emitPresenceSocketEvent({
    event: PRESENCE_INVALIDATED_EVENT_TYPE,
    companyId: built.envelope.companyId,
    envelope: built.envelope,
  });
};
