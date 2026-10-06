// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — PRESENCE SOCKET HANDLERS (activity, heartbeat, tick, disconnect)
//
//  WHAT THIS MODULE IS
//    Per-connection handlers for the three presence events the
//    browser can emit. Authority comes ONLY from `socket.data` (the
//    33.1 handshake re-expression of `protect` + `tenantContext`).
//    Payloads are untrusted; the server never reads a companyId /
//    userId from the client.
//
// EVENTS
//    presence:heartbeat   — { } (no payload; the server stamps `now`)
//    presence:activity    — {} (real interaction signal; the server stamps Redis)
//    presence:tick        — { } (Phase 37.7 §C.3 — read-only re-eval request.
//                              No payload. Does NOT update lastActivityAt.
//                              Re-resolves with the existing live snapshot
//                              and publishes IF the value differs from the
//                              memo. Use this on the 30s visibility ticker
//                              so the resolver actually re-runs after the
//                              threshold expires, without requiring the user
//                              to interact again.)
//
//  WHAT THE SERVER DOES WITH EACH
//    On connect: store.markConnected, then resolve + publish a
//      presence:changed envelope only when the effective value or
//      source differs from the last successfully published snapshot.
//    On heartbeat: store.refreshHeartbeat. NO publish (a heartbeat
//      is not a meaningful state change — §9, §16).
//    On activity: store.recordActivity + (if effective presence
//      changed) publish a presence:changed envelope with source='activity'.
//    On disconnect: store.markDisconnected. Only the last tab (count=0)
//      re-resolves through the shared service and publishes the effective
//      status (Offline unless manual/Leave precedence wins).
//
//  ANTI-BANS (re-asserted)
//    · No attendance, no leave, no payroll, no AI side effects.
//    · No Mongo writes (heartbeat history is FORBIDDEN by Phase 37 §19).
//    · No NATS or infrastructure-SSE product events; the presence bus
//      emits only fixed-shape envelopes on the authenticated namespace.
//    · No KEYS / SCAN / FLUSH* from the store (pinned by tests).
// ═══════════════════════════════════════════════════════════════════════════

import {
  PRESENCE_SOCKET_INBOUND_EVENTS,
  PRESENCE_GATEWAY_EVENT_TYPE,
  PRESENCE_INVALIDATED_EVENT_TYPE,
} from '../services/presence/presenceEvents.js';
import { presenceService } from '../services/presence/presenceService.js';
import { publishPresenceChanged, presenceBusAvailable } from '../services/presence/presenceBus.js';

// Process-local transition memo. The Redis live snapshot + the shared REST
// presence service remain authoritative; this only suppresses duplicate
// socket envelopes for unchanged effective values.
const lastPublishedBySocket = new Map();

/**
 * Resolve through the same service used by GET /presence/me. That service
 * loads durable manual preferences, the live Redis snapshot, and the
 * read-only approved-Leave context before calling the single resolver.
 * The old socket-only `{ durable: null, hrContext: null }` path could
 * incorrectly replace Busy / On Leave with an automatic value.
 */
export const resolveEffectivePresence = async ({
  companyId,
  userId,
  store,
  serviceFactory = presenceService,
} = {}) => {
  try {
    const service = serviceFactory({ liveStore: store || null });
    return await service.getMyPresence({ companyId, userId });
  } catch {
    return { presence: 'unknown', presenceSource: 'none' };
  }
};

/**
 * Resolve the user's effective presence and publish a presence:changed
 * envelope when the value or authoritative source differs from the memo.
 * Only a successful best-effort publish advances the memo. NEVER throws.
 */
const publishIfChanged = async ({
  companyId,
  userId,
  presence,
  presenceSource,
  source,
  memo,
}) => {
  if (!companyId || !userId) return;
  if (!presence) return;
  const key = `${String(companyId)}:${String(userId)}`;
  const resolvedSource = presenceSource || 'none';
  const previous = memo?.get(key);
  if (
    (previous?.presence === presence && previous?.presenceSource === resolvedSource) ||
    !presenceBusAvailable()
  ) return;
  try {
    const result = await publishPresenceChanged({
      companyId: String(companyId),
      userId: String(userId),
      presence,
      presenceSource: resolvedSource,
      source,
    });
    // Keep the memo retryable when the namespace was removed or the
    // envelope could not be delivered. Track source as well as value so
    // automatic Available -> manually selected Available is observable.
    if (result?.ok) {
      memo?.set(key, { presence, presenceSource: resolvedSource });
    }
  } catch {
    /* publish NEVER throws up */
  }
};

/**
 * Public factory. Returns the per-connection handler set.
 *
 * @param {Object} args
 * @param {Object} args.io       — the Socket.IO namespace
 * @param {Object} args.socket   — the connected socket
 * @param {Object} args.store    — the presence live store
 * @param {Object} args.counters — diagnostic counters (optional)
 * @param {Object} args.log      — logger
 */
export const registerPresenceSocketHandlers = ({
  io,
  socket,
  store,
  counters = {},
  log = console,
  resolveEffective = resolveEffectivePresence,
} = {}) => {
  const companyId = String(socket.data?.companyId || '');
  const userId = String(socket.data?.userId || '');

  if (!companyId || !userId) {
    // Defense in depth — the handshake should have already refused.
    // If it didn't, kill the socket now.
    try {
      socket.disconnect(true);
    } catch {
      /* already gone */
    }
    return;
  }

  const connectionId = socket.id;
  const memo = lastPublishedBySocket;

  // ── connect ────────────────────────────────────────────────────────
  (async () => {
    const snap = await store?.markConnected({
      companyId,
      userId,
      connectionId,
    });
    if (!snap) return; // store down — degraded mode, no publish
    const resolved = await resolveEffective({ companyId, userId, store });
    await publishIfChanged({
      companyId,
      userId,
      presence: resolved.presence,
      presenceSource: resolved.presenceSource,
      source: 'connect',
      memo,
    });
  })();

  // ── presence:heartbeat (no payload; transport liveness only) ─────────
  socket.on('presence:heartbeat', async () => {
    if (typeof store?.refreshHeartbeat !== 'function') return;
    try {
      await store.refreshHeartbeat({ companyId, userId, connectionId });
    } catch {
      /* store never throws; the safeCall wrapper catches — defensive */
    }
    // Heartbeat NEVER publishes (Phase 37.4 §9, §16). The bus is
    // for meaningful state changes; a heartbeat is liveness
    // assertion, not a transition.
  });

  // ── presence:activity (user interaction; server-stamped) ────────────
  socket.on('presence:activity', async () => {
    if (typeof store?.recordActivity !== 'function') return;
    try {
      const snap = await store.recordActivity({ companyId, userId, connectionId });
      if (!snap) return;
      const resolved = await resolveEffective({ companyId, userId, store });
      // The activity event may flip away -> available. The memo
      // suppresses no-op transitions.
      await publishIfChanged({
        companyId,
        userId,
        presence: resolved.presence,
        presenceSource: resolved.presenceSource,
        source: 'activity',
        memo,
      });
    } catch {
      /* store never throws; defensive */
    }
  });

  // ── presence:tick (read-only re-eval, no payload) ────────────────
  // Phase 37.7 §C.3 — the visibility ticker asks the server to
  // re-resolve now using the EXISTING live snapshot. We do NOT call
  // recordActivity or refreshHeartbeat. We do NOT take a new
  // lastActivityAt. We DO call resolveEffectivePresence and publish
  // ONLY if the memo'd value differs (memo-suppressed no-op).
  //
  // This is the only way the resolver's `now - lastActivityAt >
  // awayAfterMinutes` branch actually fires without requiring the
  // user to interact again or another user to hit the team page.
  socket.on('presence:tick', async () => {
    try {
      const resolved = await resolveEffective({ companyId, userId, store });
      await publishIfChanged({
        companyId,
        userId,
        presence: resolved.presence,
        presenceSource: resolved.presenceSource,
        source: 'tick',
        memo,
      });
    } catch {
      /* store / resolver never throws; defensive */
    }
  });

  // ── disconnect ─────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    if (typeof store?.markDisconnected !== 'function') return;
    let snapshot = null;
    try {
      snapshot = await store.markDisconnected({ companyId, userId, connectionId });
    } catch {
      return; // Redis failure is Unknown, never a fabricated Offline.
    }

    // A closing tab must not mark the user Offline while another tab is
    // connected. The final disconnect is authoritative and is published
    // immediately; Redis retains the zero-connection snapshot briefly so
    // REST refetches see the same effective value.
    if (!snapshot || Number(snapshot.connectionCount) !== 0) return;
    try {
      const resolved = await resolveEffective({ companyId, userId, store });
      await publishIfChanged({
        companyId,
        userId,
        presence: resolved.presence,
        presenceSource: resolved.presenceSource,
        source: 'disconnect',
        memo,
      });
    } catch {
      /* resolver / publisher failures never escape a disconnect */
    }
  });

  return {
    onUnbind: () => {
      // No-op for now; the memo is module-scoped and bounded by
      // process lifetime. Tests reset it.
    },
  };
};

// Public seam: the test/inspection hook.
export const PRESENCE_SOCKET_INBOUND = PRESENCE_SOCKET_INBOUND_EVENTS;
export const PRESENCE_SOCKET_OUTBOUND = Object.freeze([
  PRESENCE_GATEWAY_EVENT_TYPE,
  PRESENCE_INVALIDATED_EVENT_TYPE,
]);

// Test-only: clear the memo between hermetic unit tests.
export const _resetPresenceMemoForTests = () => {
  lastPublishedBySocket.clear();
};
