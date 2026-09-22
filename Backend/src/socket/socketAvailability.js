// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.1 — CHAT REALTIME AVAILABILITY GATE
//
//  THE honest-degradation contract for chat realtime.
//
//  Crewly's general law is "Redis is coordination, never truth" — cache,
//  limiters and queues all DEGRADE and keep serving. Chat realtime is the
//  documented EXCEPTION: @socket.io/redis-adapter is what makes fanout
//  correct across stateless API replicas, so without Redis there is no
//  truthful way to deliver a message to a socket held by another instance.
//  Half-working realtime is worse than none, so:
//
//      Redis disabled / misconfigured / unreachable
//              ⇒ chat realtime = FEATURE_UNAVAILABLE
//              ⇒ every socket connection is REFUSED
//              ⇒ the HTTP API is completely unaffected
//
//  This exception is contained to this module + initSocketServer.js. It
//  must never be copied into the cache, limiter or queue layers.
//
//  Pure and injectable — no I/O, fully hermetically testable.
// ═══════════════════════════════════════════════════════════════════════════
import { CHAT_FEATURE_UNAVAILABLE } from './socketConfig.js';

export const CHAT_REALTIME_STATES = Object.freeze({
  /** CHAT_SOCKET_ENABLED != true — the feature was never switched on. */
  DISABLED: 'DISABLED',
  /** Enabled but Redis is absent/unreachable — refuses connections. */
  UNAVAILABLE: 'UNAVAILABLE',
  /** Adapter attached — connections are accepted. */
  READY: 'READY',
  /** This instance is draining/stopped. */
  STOPPED: 'STOPPED',
});

/**
 * Safe, secret-free reason vocabulary. Surfaced in LOGS and ops
 * diagnostics only — never in the client-facing refusal, which is always
 * the single generic FEATURE_UNAVAILABLE contract.
 */
export const CHAT_UNAVAILABLE_REASONS = Object.freeze([
  'REDIS_DISABLED',
  'REDIS_MISCONFIGURED',
  'REDIS_CONNECT_TIMEOUT',
  'REDIS_ERROR',
  'ADAPTER_FAILURE',
  'STOPPED',
]);

const isKnownReason = (reason) =>
  CHAT_UNAVAILABLE_REASONS.includes(String(reason || ''));

/**
 * Creates the process-local availability state holder.
 *
 * Process-local BY DESIGN (same reasoning as 32.2's lifecycle state):
 * instance #1 may be UNAVAILABLE while instance #2 is READY, and that is
 * truthful. This must never become shared Mongo/Redis state.
 */
export const createChatSocketAvailability = () => {
  let state = CHAT_REALTIME_STATES.DISABLED;
  let reason = null;

  const set = (nextState, nextReason = null) => {
    state = nextState;
    reason = nextState === CHAT_REALTIME_STATES.UNAVAILABLE ? nextReason : null;
  };

  return {
    markReady: () => set(CHAT_REALTIME_STATES.READY),

    markUnavailable: (nextReason) =>
      set(
        CHAT_REALTIME_STATES.UNAVAILABLE,
        isKnownReason(nextReason) ? String(nextReason) : 'ADAPTER_FAILURE',
      ),

    markDisabled: () => set(CHAT_REALTIME_STATES.DISABLED),

    markStopped: () => set(CHAT_REALTIME_STATES.STOPPED, 'STOPPED'),

    /** The ONLY admission question. */
    isReady: () => state === CHAT_REALTIME_STATES.READY,

    /** Ops/diagnostics view — state + safe reason word, never a URL. */
    getState: () => ({ state, reason }),

    /**
     * The refusal a non-READY state produces, or null when ready.
     * One stable shape for every non-ready state: a caller cannot tell
     * DISABLED from UNAVAILABLE from STOPPED.
     */
    refusal: () =>
      state === CHAT_REALTIME_STATES.READY
        ? null
        : { ...CHAT_FEATURE_UNAVAILABLE, state },
  };
};
