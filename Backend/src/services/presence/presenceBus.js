// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — PRESENCE BUS (thin façade over the 32.11 SSE gateway)
//
//  WHY THIS MODULE EXISTS
//    The socket handler, the team-service batched invalidation, and any
//    future internal caller need a SINGLE place to publish
//    `presence:changed` envelopes. The bus is that place.
//
//  WHY IT IS A FAÇADE
//    The existing 32.11 realtimeGateway already does cross-instance
//    fan-out via dedicated Redis pub/sub connections on the
//    environment-namespaced channel `crewly:<env>:realtime:events`.
//    That gateway:
//      · is the only allowed publish path for envelope-shaped events;
//      · fails closed (no socket connections admitted) when Redis is
//        down — and degrades to local-only delivery when the pub/sub
//        is missing;
//      · has bounded per-process stream + per-user stream caps;
//      · never carries tokens, PII, or status-message text (the
//        gateway is envelope-typed and rejects oversize frames).
//
//    Reusing the gateway means Phase 37.4 does NOT need a second
//    cross-instance bus (e.g. NATS) and does NOT need new env vars.
//    If a future phase ever does require a second bus, swap
//    `publishPresenceChanged` here — every caller goes through this
//    one seam.
//
//  WHAT THIS MODULE DOES NOT DO
//    · Does NOT import socket.io, ioredis, or any transport directly.
//    · Does NOT mutate any Redis key (that's presenceLiveStore).
//    · Does NOT carry PII. The envelope is fixed-shape; the build
//      helper enforces that strictly.
//    · Does NOT crash on publish failure — every failure is logged
//      and swallowed. Presence degradation is allowed; HTTP, leave,
//      attendance, and payroll must never depend on the bus.
// ═══════════════════════════════════════════════════════════════════════════

import { getRealtimeGateway } from '../../infrastructure/realtime/realtimeGateway.js';
import {
  buildPresenceChangedEnvelope,
  PRESENCE_GATEWAY_EVENT_TYPE,
  PRESENCE_INVALIDATED_EVENT_TYPE,
  buildPresenceInvalidatedEnvelope,
} from './presenceEvents.js';

// Test seam: hermetic tests swap the gateway without touching the
// realtime module's exports (ESM live-bindings are read-only).
let gatewayOverride = null;
export const __setRealtimeGatewayForTests = (gateway) => {
  gatewayOverride = gateway || null;
};
export const __resetRealtimeGatewayForTests = () => {
  gatewayOverride = null;
};

const resolveGateway = () => {
  if (gatewayOverride) return gatewayOverride;
  return getRealtimeGateway();
};

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

  // The gateway is the only allowed publish path. If it is not started
  // (REALTIME_ENABLED=false), the publish is a logged no-op.
  let gateway;
  try {
    gateway = resolveGateway();
  } catch (err) {
    return {
      ok: false,
      delivered: 'none',
      error: 'gateway not initialised',
    };
  }

  if (!gateway.isStarted()) {
    return { ok: false, delivered: 'none', error: 'gateway disabled' };
  }

  try {
    const result = await gateway.publish({
      type: PRESENCE_GATEWAY_EVENT_TYPE,
      companyId: built.envelope.companyId,
      userId: built.envelope.userId,
      payload: {
        schemaVersion: built.envelope.schemaVersion,
        presence: built.envelope.presence,
        presenceSource: built.envelope.presenceSource,
        occurredAt: built.envelope.occurredAt,
        source: built.envelope.source,
      },
    });
    return { ok: true, delivered: result?.delivered || 'unknown', error: null };
  } catch (err) {
    // Publish NEVER throws up. Cross-instance fan-out is best-effort;
    // local readers are unaffected by a pub/sub outage.
    return {
      ok: false,
      delivered: 'none',
      error: err?.message || 'gateway publish failed',
    };
  }
};

/**
 * Convenience: is the cross-instance presence fan-out available?
 * The socket handler uses this to decide whether to publish at all
 * (a `false` return is a degraded state, not an error).
 */
export const presenceBusAvailable = () => {
  try {
    return Boolean(resolveGateway().isStarted());
  } catch {
    return false;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.5 — INVALIDATION ENVELOPE
//
//  When a work-location request is APPROVED or an APPROVED request is
//  CANCELLED, the resolver on a connected viewer's machine should
//  re-read the row so the team page reflects the change without a full
//  page refresh. The invalidation envelope carries the minimum needed
//  for the frontend to act: companyId, userId, and occurredAt. The
//  payload NEVER contains the decision note, the reviewer's name, the
//  requester's email, or any other PII (spec §30).
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

  let gateway;
  try {
    gateway = resolveGateway();
  } catch (err) {
    return { ok: false, delivered: 'none', error: 'gateway not initialised' };
  }

  if (!gateway.isStarted()) {
    return { ok: false, delivered: 'none', error: 'gateway disabled' };
  }

  try {
    const result = await gateway.publish({
      type: PRESENCE_INVALIDATED_EVENT_TYPE,
      companyId: built.envelope.companyId,
      userId: built.envelope.userId,
      payload: {
        schemaVersion: built.envelope.schemaVersion,
        occurredAt: built.envelope.occurredAt,
        source: built.envelope.source,
      },
    });
    return { ok: true, delivered: result?.delivered || 'unknown', error: null };
  } catch (err) {
    return {
      ok: false,
      delivered: 'none',
      error: err?.message || 'invalidation publish failed',
    };
  }
};
