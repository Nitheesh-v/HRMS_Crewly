// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — PRESENCE SOCKET CHANNEL
//
//  WHAT THIS IS
//    A single shared Socket.IO connection to the /presence namespace,
//    owned by the page-level presenceRuntime. The chat socket (33.x)
//    and the presence socket (37.4) are TWO connections to TWO
//    namespaces on the SAME `io` server — the chat socket still rides
//    `/`; this one rides `/presence`.
//
//  WHAT THIS IS NOT
//    · Not a NATS client. No NATS in the browser. (Phase 36.5.)
//    · Not a Redis client. No Redis in the browser.
//    · Not a presence *value* source. The value is read over REST;
//      this channel carries `presence:changed` / `presence:invalidated` events.
//
//  LIFECYCLE
//    One controlled lifecycle: start once on auth, stop on logout.
//    Re-uses the same short-lived ticket handshake the chat socket
//    uses (33.14). The handshake is a 60-second ticket minted by
//    POST /api/realtime/chat-ticket (which the backend keeps single-
//    purpose; the same endpoint mints a ticket for either namespace).
//
//  FAILURE MODES (re-asserted from 33.1)
//    · Refused handshake (FEATURE_UNAVAILABLE) → close, no retry
//      loop. Runtime flags 'unavailable'.
//    · Unauthorized (ticket expired, session revoked) → one re-mint.
//    · Transport outage → bounded reconnection via socket.io itself.
// ═══════════════════════════════════════════════════════════════════════════

import { io } from 'socket.io-client';

import { resolveSocketUrl } from './socketUrl.js';
import api from '../api.js';

const PRESENCE_TICKET_PATH = '/realtime/chat-ticket';

// Module-scoped state. The runtime decides when to start/stop.
let socket = null;
let connecting = null;

// One authenticated REST call → one short-lived ticket (or '' on refusal).
const fetchPresenceTicket = async () => {
  try {
    const response = await api.post(PRESENCE_TICKET_PATH);
    return (
      response?.ticket ||
      response?.data?.ticket ||
      response?.data?.data?.ticket ||
      ''
    );
  } catch {
    return '';
  }
};

/**
 * Open the /presence socket. Idempotent. Returns the live socket or
 * null. The runtime registers a single listener for `presence:changed`
 * and dispatches into redux.
 */
export const startPresenceChannel = async () => {
  if (socket) return socket;
  if (connecting) return connecting;

  connecting = (async () => {
    const ticket = await fetchPresenceTicket();
    if (!ticket) {
      connecting = null;
      return null; // refused: runtime shows 'unavailable'
    }

    const baseUrl = resolveSocketUrl().replace(/\/+$/, '');
    const namespaceUrl = /\/presence$/i.test(baseUrl)
      ? baseUrl
      : `${baseUrl}/presence`;
    const opts = {
      path: '/socket.io',
      auth: { token: ticket },
      withCredentials: true,
      reconnectionAttempts: 6,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    };

    socket = io(namespaceUrl, opts);
    let reminted = false;
    const channelSocket = socket;
    channelSocket.on('connect', () => {
      reminted = false;
    });
    channelSocket.on('connect_error', async (error) => {
      const code = String(error?.data?.code || error?.message || '');
      if (code.includes('FEATURE_UNAVAILABLE')) {
        channelSocket.close();
        return;
      }
      if (!code.includes('UNAUTHORIZED')) return;
      if (!reminted) {
        reminted = true;
        const fresh = await fetchPresenceTicket();
        if (fresh && socket === channelSocket) {
          channelSocket.auth = { token: fresh };
          // A namespace middleware rejection does not always trigger the
          // manager's automatic retry. Explicitly retry once with the new
          // short-lived ticket; `reminted` bounds this recovery path.
          channelSocket.connect();
          return;
        }
      }
      channelSocket.close();
    });
    connecting = null;
    return socket;
  })();

  return connecting;
};

export const stopPresenceChannel = () => {
  if (socket) {
    try {
      socket.removeAllListeners();
    } catch {
      /* already gone */
    }
    socket.close();
  }
  socket = null;
  connecting = null;
};

/** Bounded manual recovery (mirrors retryChatSocket). */
export const retryPresenceChannel = async () => {
  stopPresenceChannel();
  return startPresenceChannel();
};

/** Bounded-scope getter — the runtime can attach listeners. */
export const getPresenceSocket = () => socket;

/** Live-conn predicate. */
export const isPresenceChannelConnected = () => Boolean(socket?.connected);

// ────────────────────────────────────────────────────────────────────────
//  TICKER — heartbeat + read-only status ticks; activity uses interaction listeners.
//
//  Activity is emitted only from real, visible user signals
//  (pointerdown / keydown / focus). The frame is empty; the server stamps
//  lastActivityAt so a client cannot backdate or future-date activity.
//  Heartbeats and resolver ticks never update the activity timestamp.
//
//  Phase 37.7 — the visibility tick also emits `presence:tick` (read-
//  only re-evaluation request) so the resolver re-runs on its own
//  schedule. Without the tick, the Available → Away transition would
//  only happen on the next HTTP GET (per-employee server intervals are
//  forbidden). The tick carries NO payload and does NOT update
//  lastActivityAt on the server.
//
//  Phase 37.7 — user-driven activity signals (`pointerdown`,
//  `keydown`, `focus`) emit `presence:activity` throttled to 1 / 5s
//  so a frantic typist does not flood the socket. The browser never sends
//  keys, text, mouse coords, focused element ids, or a client timestamp.
// ────────────────────────────────────────────────────────────────────────
const VISIBILITY_HEARTBEAT_MS = 30_000;
const ACTIVITY_THROTTLE_MS = 5_000;
let visibilityTicker = null;
let lastActivityEmitMs = 0;
let activityListenersAttached = false;

const sendHeartbeat = () => {
  const s = socket;
  if (!s?.connected) return;
  try {
    s.emit('presence:heartbeat', {});
  } catch {
    /* emit never throws up */
  }
};

const sendActivity = () => {
  const s = socket;
  if (!s?.connected) return;
  try {
    s.emit('presence:activity', {});
  } catch {
    /* never throws up */
  }
};

const sendTick = () => {
  const s = socket;
  if (!s?.connected) return;
  try {
    // Phase 37.7 §C.3 — read-only re-eval. The server resolver
    // re-runs using the EXISTING live.lastActivityAt. No update to
    // the activity timestamp, no fallback writes.
    s.emit('presence:tick', {});
  } catch {
    /* never throws up */
  }
};

/** Throttled activity emitter. Returns true when the call produced
 *  an emit, false when it was suppressed by the throttle window.
 *  The throttle is per-tab (the runtime owns it). */
const maybeEmitActivity = () => {
  const now = Date.now();
  if (now - lastActivityEmitMs < ACTIVITY_THROTTLE_MS) return false;
  lastActivityEmitMs = now;
  sendActivity();
  return true;
};

const onVisibilityChange = () => {
  if (typeof document === 'undefined') return;
  // Visibility is not activity. Refresh transport liveness and ask the
  // resolver to re-evaluate, but never change lastActivityAt here.
  sendHeartbeat();
  sendTick();
};

const onUserSignal = () => {
  if (typeof document === 'undefined') return;
  if (document.visibilityState !== 'visible') return;
  maybeEmitActivity();
};

const attachActivityListeners = () => {
  if (activityListenersAttached || typeof document === 'undefined') return;
  // pointerdown covers mouse + touch on modern browsers.
  document.addEventListener('pointerdown', onUserSignal, { passive: true });
  // keydown covers keyboard. We capture NO key info, NO text, NO
  // focused element id. The handler is the same single arg-less fn.
  document.addEventListener('keydown', onUserSignal, { passive: true });
  // focus covers window regaining focus (e.g. alt-tab back).
  window.addEventListener('focus', onUserSignal);
  activityListenersAttached = true;
};

const detachActivityListeners = () => {
  if (!activityListenersAttached || typeof document === 'undefined') return;
  document.removeEventListener('pointerdown', onUserSignal);
  document.removeEventListener('keydown', onUserSignal);
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', onUserSignal);
  }
  activityListenersAttached = false;
};

export const startVisibilityTicker = () => {
  if (visibilityTicker || typeof document === 'undefined') return;
  // Immediate heartbeat + tick on attach.
  sendHeartbeat();
  sendTick();
  visibilityTicker = setInterval(() => {
    // Keep connection liveness and Away/Offline re-evaluation independent
    // of visibility. Background browser timers may be throttled, so the
    // store has a bounded TTL cushion. Crucially, this never sends activity.
    sendHeartbeat();
    sendTick();
  }, VISIBILITY_HEARTBEAT_MS);
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  // Real user signals (pointerdown, keydown, focus) are the ONLY
  // activity source. Heartbeat/tick callbacks above never emit activity.
  attachActivityListeners();
};

export const stopVisibilityTicker = () => {
  if (visibilityTicker) clearInterval(visibilityTicker);
  visibilityTicker = null;
  if (typeof document !== 'undefined' && document.removeEventListener) {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
  // Phase 37.7 §C.2 — tear down the user-signal listeners too.
  detachActivityListeners();
  lastActivityEmitMs = 0;
};

// Test-only: reset module state between hermetic unit tests.
export const __resetActivityChannelForTests = () => {
  lastActivityEmitMs = 0;
  detachActivityListeners();
};
