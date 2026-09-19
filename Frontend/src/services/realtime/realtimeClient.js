/*
 * Phase 32.11 — REALTIME CLIENT (isolated service boundary, SSE)
 * ─────────────────────────────────────────────────────────────
 * ONE EventSource connection per app-session, owned ONLY by the
 * authenticated shell (AppLayout). Public and kiosk pages never import
 * this module, so nothing auto-connects outside a logged-in user shell.
 *
 * Laws honoured here:
 *  • Import-time side-effect law (§86): this module only exports
 *    functions — no connection is opened on import. start/stop are
 *    explicit and idempotent (React Strict Mode double-invoke safe;
 *    Strict Mode is never disabled anywhere for this).
 *  • Identity/tenant are 100% server-derived: the client NEVER sends a
 *    companyId/userId. The stream URL carries an opaque single-use
 *    ticket — never a JWT (§15/§13).
 *  • Infrastructure-only event vocabulary: inbound frames whose type is
 *    not on the allowlist are ignored (forward-safe for Phase 33+).
 *  • Bounded reconnect: exponential backoff with jitter, reset on a
 *    successful open; the ticket flow re-runs per attempt because every
 *    ticket is single-use (a retry can never replay the old one).
 *  • No new dependency: EventSource is browser-native SSE.
 *  • REST stays authoritative — this client only observes; it sends no
 *    product commands and no future Chat/Presence/AI vocabulary exists
 *    anywhere in this file.
 */

import api from '../api.js';

// Mirrors Backend REALTIME_EVENT_TYPES (infrastructure-only vocabulary).
const INBOUND_EVENT_TYPES = Object.freeze([
  'connection:ready',
  'system:ping',
  'realtime:proof',
]);

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const STREAM_URL = `${API_BASE}/realtime/stream`;

// Bounded backoff (well inside the 30s ticket TTL; reset on open).
const RECONNECT_BASE_MS = 1000;
const RECONNECT_FACTOR = 2;
const RECONNECT_MAX_MS = 15000;

const jitter = (ms) => ms + Math.floor(Math.random() * Math.min(ms, 500));

// ── Session state (module-local; exactly one connection may exist) ──────
let session = null; // { eventSource, reconnectTimer, attempt, connecting, listeners }

const clearReconnectTimer = () => {
  if (session?.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
};

const emitToListeners = (envelope) => {
  for (const listener of session?.listeners ?? []) {
    try {
      listener(envelope);
    } catch {
      /* a faulty listener must never break the stream */
    }
  }
};

/** One connect attempt: HTTP ticket → EventSource. Never throws. */
const openStream = async () => {
  if (!session || session.disposed) return;

  try {
    session.connecting = true;

    // Normal authenticated HTTP (JWT via the shared api client — cookies /
    // refresh semantics unchanged). Identity is bound server-side.
    const response = await api.post('/realtime/ticket');
    const ticket = response?.data?.data?.ticket;
    if (!ticket || session.disposed) return;

    const eventSource = new EventSource(`${STREAM_URL}?ticket=${encodeURIComponent(ticket)}`);
    session.eventSource = eventSource;

    eventSource.onopen = () => {
      session.attempt = 0; // successful stream — backoff resets
    };

    for (const type of INBOUND_EVENT_TYPES) {
      eventSource.addEventListener(type, (event) => {
        try {
          const envelope = JSON.parse(event.data);
          if (envelope && typeof envelope === 'object') emitToListeners(envelope);
        } catch {
          /* malformed frame — ignored safely (§34) */
        }
      });
    }

    eventSource.onerror = () => {
      if (!session || session.disposed) return;
      // Close immediately: the ticket was single-use, so the browser's
      // native same-URL retry could never succeed. Reconnect runs our own
      // bounded backoff with a FRESH ticket each attempt.
      try {
        eventSource.close();
      } catch {
        /* already closed */
      }
      if (session.eventSource === eventSource) session.eventSource = null;
      scheduleReconnect();
    };
  } catch {
    /* ticket refused (offline / logged out / disabled) — bounded retry */
    scheduleReconnect();
  } finally {
    if (session) session.connecting = false;
  }
};

const scheduleReconnect = () => {
  if (!session || session.disposed || session.reconnectTimer) return;
  const delay = jitter(Math.min(RECONNECT_BASE_MS * RECONNECT_FACTOR ** session.attempt, RECONNECT_MAX_MS));
  session.attempt = Math.min(session.attempt + 1, 10); // bounded exponent
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    openStream();
  }, delay);
};

/**
 * Open the app-session realtime connection. Idempotent — concurrent or
 * repeated calls (Strict Mode, fast navigation) yield ONE connection.
 * Explicit create/start/stop lifecycle; nothing runs at import time.
 */
export const startRealtimeSession = () => {
  if (session && !session.disposed) return; // already running — never a second connection

  clearReconnectTimer();
  session = { eventSource: null, reconnectTimer: null, attempt: 0, connecting: false, disposed: false, listeners: new Set() };
  openStream();
};

/**
 * Close the app-session connection and all pending reconnects. Idempotent.
 * Called by the shell on unmount, logout, and account switch — the stream
 * never outlives the user session it belongs to.
 */
export const stopRealtimeSession = () => {
  if (!session) return;
  session.disposed = true;
  clearReconnectTimer();
  if (session.eventSource) {
    try {
      session.eventSource.close();
    } catch {
      /* already closed */
    }
  }
  session = null;
};

/** True while the app-session connection (or a bounded reconnect) is live. */
export const isRealtimeSessionActive = () => Boolean(session && !session.disposed);

/**
 * Observation seam for FUTURE phases (33+: Chat/Notifications subscribe
 * here — none exist today). Returns an unsubscribe function. Listeners
 * receive validated envelope objects only.
 */
export const onRealtimeEvent = (listener) => {
  if (typeof listener !== 'function' || !session) return () => {};
  session.listeners.add(listener);
  return () => session?.listeners.delete(listener);
};
