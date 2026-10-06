// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — PRESENCE SOCKET HANDLERS (3 events, all idempotent)
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
//    presence:activity    — { at: ISO } (throttled; the server stamps Redis)
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
//      presence:changed envelope ONLY if the user's effective
//      presence moved into a non-`unknown` value (first connect for
//      a previously-unknown user).
//    On heartbeat: store.refreshHeartbeat. NO publish (a heartbeat
//      is not a meaningful state change — §9, §16).
//    On activity: store.recordActivity + (if effective presence
//      changed) publish a presence:changed envelope with source='activity'.
//    On disconnect: store.markDisconnected. NO publish here. The
//      grace window keeps the key alive for the reconnect window;
//      when the TTL expires the next read returns null and the
//      resolver returns 'offline'. The bus publish happens at the
//      next resolver transition (or via the resolver noticing the
//      absence on the next /me read).
//
//  ANTI-BANS (re-asserted)
//    · No attendance, no leave, no payroll, no AI side effects.
//    · No Mongo writes (heartbeat history is FORBIDDEN by Phase 37 §19).
//    · No NATS (the bus is the 32.11 SSE gateway re-pointed at
//      presence:changed envelopes).
//    · No KEYS / SCAN / FLUSH* from the store (pinned by tests).
// ═══════════════════════════════════════════════════════════════════════════

import { presenceCompanyRoom, presenceUserRoom } from '../utils/presenceKeys.js';
import {
  PRESENCE_SOCKET_INBOUND_EVENTS,
  PRESENCE_GATEWAY_EVENT_TYPE,
  buildPresenceChangedEnvelope,
  parsePresenceChangedEnvelope,
} from '../services/presence/presenceEvents.js';
import { resolvePresence } from '../services/presence/presenceResolver.js';
import { getPresenceTenantConfigOrThrow } from '../services/presence/presenceTenantConfigService.js';
import { publishPresenceChanged, presenceBusAvailable } from '../services/presence/presenceBus.js';
import { getScopedUserIds } from '../utils/scope.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

const safeActivityAt = (raw) => {
  if (typeof raw !== 'string' || !ISO_RE.test(raw)) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
};

// A tiny per-socket "lastEffectivePresence" memo. Used to suppress a
// redundant publish on connect when the user's previous state is
// already the one we'd publish. The local memo is best-effort; the
// authoritative signal is the bus envelope.
const lastPublishedBySocket = new Map();

/**
 * Resolve the user's effective presence and publish a presence:changed
 * envelope ONLY when the presence value differs from the memo.
 * Pure side effects: a single (best-effort) publish + a memo write.
 * NEVER throws.
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
  const previous = memo?.get(key);
  if (previous === presence) return;
  memo?.set(key, presence);
  if (!presenceBusAvailable()) return;
  try {
    await publishPresenceChanged({
      companyId: String(companyId),
      userId: String(userId),
      presence,
      presenceSource: presenceSource || 'none',
      source,
    });
  } catch {
    /* publish NEVER throws up */
  }
};

/**
 * Resolve the user end-to-end (durable + live) so we know what the
 * effective presence is on connect. This is the ONE place outside
 * the controller where the live store is consulted on a synchronous
 * "what's this user's effective presence" question.
 *
 * NEVER throws. On any failure returns 'unknown'.
 */
const resolveEffectivePresence = async ({
  companyId,
  userId,
  store,
}) => {
  try {
    const config = await getPresenceTenantConfigOrThrow({ companyId });
    const live = store
      ? await store.readLive({ companyId, userId })
      : null;
    // We do NOT fetch the durable row here — the controller already
    // owns that read. The connect-time publish is best-effort and
    // the team page refetches via HTTP. We use the resolver directly
    // to determine if the user is at least not-unknown now.
    const resolved = resolvePresence({
      durable: null,
      config,
      now: new Date(),
      live,
    });
    return resolved;
  } catch {
    return { presence: 'unknown', presenceSource: 'none' };
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
    const resolved = await resolveEffectivePresence({ companyId, userId, store });
    await publishIfChanged({
      companyId,
      userId,
      presence: resolved.presence,
      presenceSource: resolved.presenceSource,
      source: 'connect',
      memo,
    });
  })();

  // ── presence:heartbeat (no payload) ────────────────────────────────
  socket.on('presence:heartbeat', async () => {
    if (typeof store?.refreshHeartbeat !== 'function') return;
    try {
      await store.refreshHeartbeat({ companyId, userId });
    } catch {
      /* store never throws; the safeCall wrapper catches — defensive */
    }
    // Heartbeat NEVER publishes (Phase 37.4 §9, §16). The bus is
    // for meaningful state changes; a heartbeat is liveness
    // assertion, not a transition.
  });

  // ── presence:activity ({at: ISO}) ─────────────────────────────────
  socket.on('presence:activity', async (raw) => {
    if (typeof store?.recordActivity !== 'function') return;
    const at = safeActivityAt(raw?.at);
    if (!at) return; // malformed payload — ignore silently
    try {
      const snap = await store.recordActivity({ companyId, userId, at });
      if (!snap) return;
      const resolved = await resolveEffectivePresence({ companyId, userId, store });
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
      const resolved = await resolveEffectivePresence({ companyId, userId, store });
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
    try {
      await store.markDisconnected({ companyId, userId, connectionId });
    } catch {
      /* defensive */
    }
    // No publish on disconnect. The grace window keeps the key
    // alive; when the TTL expires the next reader resolves 'offline'
    // and the next /me request publishes the transition (or, if
    // the bus is enabled, the resolver's change-detector publishes
    // it). Doing a publish on every disconnect would publish on
    // every tab close even when the user is still on another tab.
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
export const PRESENCE_SOCKET_OUTBOUND = Object.freeze([PRESENCE_GATEWAY_EVENT_TYPE]);

// Test-only: clear the memo between hermetic unit tests.
export const _resetPresenceMemoForTests = () => {
  lastPublishedBySocket.clear();
};
