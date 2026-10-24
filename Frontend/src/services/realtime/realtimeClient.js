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
 *  • Inbound frames are allowlisted; the only product event currently
 *    admitted is the data-less Helpdesk notification invalidation nudge.
 *  • Bounded reconnect: exponential backoff with jitter, reset on a
 *    successful open; the ticket flow re-runs per attempt because every
 *    ticket is single-use (a retry can never replay the old one).
 *  • No new dependency: EventSource is browser-native SSE.
 *  • REST stays authoritative — this client only observes; it sends no
 *    product commands and never transports ticket or message content.
 */

import api from '../api.js';

// Mirrors Backend REALTIME_EVENT_TYPES; Helpdesk nudge payloads are empty.
const INBOUND_EVENT_TYPES = Object.freeze([
  'connection:ready',
  'system:ping',
  'realtime:proof',
  'helpdesk:notifications:changed',
]);

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const STREAM_URL = `${API_BASE}/realtime/stream`;

// Bounded backoff (well inside the 30s ticket TTL; reset on open).
const RECONNECT_BASE_MS = 1000;
const RECONNECT_FACTOR = 2;
const RECONNECT_MAX_MS = 15000;

const jitter = (ms) => ms + Math.floor(Math.random() * Math.min(ms, 500));

// ── Session state (module-local; exactly one connection may exist) ──────
let session = null; // { eventSource, reconnectTimer, attempt, connecting }
const listeners = new Set();

const clearReconnectTimer = () => {
  if (session?.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
};

const emitToListeners = (envelope) => {
  for (const listener of listeners) {
    try {
      listener(envelope);
    } catch {
      /* a faulty listener must never break the stream */
    }
  }
};

/** One connect attempt: HTTP ticket → EventSource. Never throws. */
const openStream = async () => {
  const activeSession = session;
  if (!activeSession || activeSession.disposed || activeSession.connecting) return;

  try {
    activeSession.connecting = true;

    // Normal authenticated HTTP (JWT via the shared api client — cookies /
    // refresh semantics unchanged). Identity is bound server-side.
    const response = await api.post('/realtime/ticket');
    if (session !== activeSession || activeSession.disposed) return;
    // The shared API client unwraps the standard { data: ... } envelope.
    const ticket = response?.ticket;
    if (!ticket) {
      scheduleReconnect();
      return;
    }

    const eventSource = new EventSource(`${STREAM_URL}?ticket=${encodeURIComponent(ticket)}`);
    activeSession.eventSource = eventSource;

    eventSource.onopen = () => {
      if (session === activeSession && !activeSession.disposed) {
        activeSession.attempt = 0; // successful stream — backoff resets
      }
    };

    for (const type of INBOUND_EVENT_TYPES) {
      eventSource.addEventListener(type, (event) => {
        if (session !== activeSession || activeSession.disposed || activeSession.eventSource !== eventSource) return;
        try {
          const envelope = JSON.parse(event.data);
          if (!envelope || typeof envelope !== 'object' || envelope.type !== type) return;
          if (
            type === 'helpdesk:notifications:changed'
            && (!envelope.payload || typeof envelope.payload !== 'object'
              || Array.isArray(envelope.payload) || Object.keys(envelope.payload).length !== 0)
          ) return;
          emitToListeners(envelope);
        } catch {
          /* malformed frame — ignored safely (§34) */
        }
      });
    }

    eventSource.onerror = () => {
      if (session !== activeSession || activeSession.disposed) return;
      // Close immediately: the ticket was single-use, so the browser's
      // native same-URL retry could never succeed. Reconnect runs our own
      // bounded backoff with a FRESH ticket each attempt.
      try {
        eventSource.close();
      } catch {
        /* already closed */
      }
      if (activeSession.eventSource === eventSource) activeSession.eventSource = null;
      scheduleReconnect();
    };
  } catch {
    /* ticket refused (offline / logged out / disabled) — bounded retry */
    if (session === activeSession && !activeSession.disposed) scheduleReconnect();
  } finally {
    if (session === activeSession) activeSession.connecting = false;
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
  session = { eventSource: null, reconnectTimer: null, attempt: 0, connecting: false, disposed: false };
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
 * Observation seam for app-level consumers. Listeners may subscribe before
 * the authenticated shell starts the session; they receive allowlisted,
 * validated envelopes only and must re-read authoritative data over REST.
 */
export const onRealtimeEvent = (listener) => {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
};
