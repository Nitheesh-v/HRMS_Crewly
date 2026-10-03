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
//  Phase 37.4 §16: "Activity signal: the client MAY send
//  `presence:activity {at: <ISO>}` while the tab is visible. The
//  server throttles (≤1 / 30s). The browser never sends the activity
//  value itself — the resolver decides."
// ────────────────────────────────────────────────────────────────────────
const VISIBILITY_HEARTBEAT_MS = 30_000;
let visibilityTicker = null;

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

const onVisibilityChange = () => {
  if (typeof document === 'undefined') return;
  if (document.visibilityState === 'visible') {
    // Re-tab returns — fire one activity so the resolver flips
    // away→available promptly. Then the ticker takes over.
    sendActivity();
  }
};

export const startVisibilityTicker = () => {
  if (visibilityTicker || typeof document === 'undefined') return;
  // Immediate heartbeat on attach.
  sendHeartbeat();
  visibilityTicker = setInterval(() => {
    if (document.visibilityState === 'visible') {
      sendHeartbeat();
      // Activity piggy-backs on the same tick — one wire frame.
      sendActivity();
    }
  }, VISIBILITY_HEARTBEAT_MS);
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
};

export const stopVisibilityTicker = () => {
  if (visibilityTicker) clearInterval(visibilityTicker);
  visibilityTicker = null;
  if (typeof document !== 'undefined' && document.removeEventListener) {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
};
