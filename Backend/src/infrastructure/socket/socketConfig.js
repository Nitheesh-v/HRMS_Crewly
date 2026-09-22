// ─────────────────────────────────────────────────────────────────────────────
// Phase 33.1A — SOCKET.IO FOUNDATION CONFIG (infrastructure/socket)
//
// Chat TRANSPORT foundation only. ONE enablement flag; every safety bound is
// code-owned, because product safety bounds are not operator tuning (the same
// rule the 32.11 SSE foundation follows).
//
// Default DISABLED, exactly like SSE: infrastructure ships before product
// consumers, and a production API must never hold open sockets nobody uses.
// Enable on localhost with:  $env:SOCKET_ENABLED="true"
//
// WHY REDIS IS MANDATORY FOR CHAT
// The adapter fans an event out to the other API replicas. Without it, a
// message published on API #1 reaches only the members connected to API #1 —
// everyone on API #2 silently misses it. That is "half working" realtime, so
// this phase refuses the connection instead (see socketGateway.js): Redis is
// unavailable ⇒ FEATURE_UNAVAILABLE, never a quiet local-only mode.
// ─────────────────────────────────────────────────────────────────────────────

// Explicit parser (never Boolean(env) — "false" is a truthy string).
export const parseSocketEnabled = (source = process.env) =>
  String(source?.SOCKET_ENABLED || '').trim().toLowerCase() === 'true';

// Code-owned bounds (product safety constants — not env-tunable).
export const SOCKET_MAX_PAYLOAD_BYTES = 16 * 1024; // 16 KB command envelope
export const SOCKET_MAX_SOCKETS_PER_PROCESS = 500;
export const SOCKET_MAX_SOCKETS_PER_USER = 5; // multi-device, bounded
export const SOCKET_HANDSHAKE_TIMEOUT_MS = 10_000;
export const SOCKET_PING_INTERVAL_MS = 25_000;
export const SOCKET_PING_TIMEOUT_MS = 20_000;
export const SOCKET_UPGRADE_TIMEOUT_MS = 10_000;
export const SOCKET_ADAPTER_REQUESTS_TIMEOUT_MS = 5_000;

// Infrastructure-only vocabulary for 33.1A — mirrors the 32.11 event law.
// Product families (chat:*, message:*, presence:*, typing:*, user:*) are
// FORBIDDEN here until their own unit defines them (33.5+). Presence and
// typing are OUT of Phase 33 entirely: no availability inference, no
// last-seen, no activity tracking (no-surveillance law).
export const SOCKET_EVENT_TYPES = Object.freeze([
  'connection:ready',
  'system:ping',
  'socket:proof',
]);

// Machine-readable refusal codes. A client NEVER receives a stack trace, a
// connection string, a token, a tenant id or an internal reason word — only
// one of these. The human-readable reason stays server-side for operators
// (and for tests), so a failed handshake is not an enumeration oracle.
export const SOCKET_ERROR_CODES = Object.freeze({
  FEATURE_UNAVAILABLE: 'FEATURE_UNAVAILABLE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  CAPACITY: 'CAPACITY',
});

// Adapter pub/sub namespace: crewly:<env>:chat — the same prefix law as
// queues, cache, rate limits, worker heartbeat and the SSE realtime channel.
// Staging can therefore never receive production chat fan-out.
export const socketAdapterKey = (prefix = 'crewly:development') =>
  `${prefix}:chat`;

// Safe, secret-free description of an unavailable feature (logs + refusals).
export const SOCKET_UNAVAILABLE_MESSAGE =
  'Realtime chat is unavailable on this instance';
