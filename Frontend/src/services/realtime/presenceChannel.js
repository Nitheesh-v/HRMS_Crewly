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
//      this channel only carries `presence:changed` events.
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

    const url = resolveSocketUrl();
    const opts = {
      path: '/socket.io',
      namespace: '/presence',
      auth: { token: ticket },
      withCredentials: true,
      reconnectionAttempts: 6,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    };

    socket = url ? io(url, opts) : io(opts);
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
//  TICKER — fire activity signals while a tab is visible.
//
//  Phase 37.4 §16 + 37.7 §C.3 — "Activity signal: the client MAY send
//  `presence:activity {at: <ISO>}` while the tab is visible. The
//  server throttles (≤1 / 30s). The browser never sends the activity
//  value itself — the resolver decides."
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
//  so a frantic typist does not flood the bus. The browser never sends
//  keys, text, mouse coords, or focused element ids — only the
//  timestamp.
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
    s.emit('presence:activity', { at: new Date().toISOString() });
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
  if (document.visibilityState === 'visible') {
    // Re-tab returns — fire one activity so the resolver flips
    // away→available promptly. Then the ticker takes over.
    maybeEmitActivity();
  }
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
    if (document.visibilityState === 'visible') {
      sendHeartbeat();
      // Phase 37.7 — emit the read-only tick alongside the heartbeat
      // so the resolver re-runs on a 30s cadence without requiring
      // the user to interact again. Activity piggy-backs on the same
      // tick if the user happened to be active since the last tick,
      // but the activity is also driven by real user signals.
      sendTick();
      sendActivity();
    }
  }, VISIBILITY_HEARTBEAT_MS);
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  // Phase 37.7 §C.2 — also listen for real user signals (pointerdown,
  // keydown, focus). The presence:activity the server receives is
  // what sets lastActivityAt. Without these, an active user with a
  // focused tab would still show stale activity after 30s.
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
