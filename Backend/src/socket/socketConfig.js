// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.1 — CHAT SOCKET CONFIGURATION (src/socket)
//
//  Infrastructure-only foundation for the future Crewly Chat Hub. Same
//  shape as Phase 32.11's realtimeConfig.js: ONE enablement flag in env,
//  every safety bound code-owned (product safety bounds are not operator
//  tuning, §60/§72).
//
//  Default DISABLED. Nothing opens a listening path in an environment
//  that has not explicitly opted in with CHAT_SOCKET_ENABLED=true.
//
//  NO CHAT PRODUCT SURFACE EXISTS IN 33.1: no rooms, no events, no
//  models, no routes. This module only owns configuration.
// ═══════════════════════════════════════════════════════════════════════════
import { getQueuePrefix } from '../config/queueConfig.js';

/**
 * Explicit enablement parser — never Boolean(env) (repo law, 28.1/32.11).
 * Anything other than the literal 'true' means disabled.
 */
export const parseChatSocketEnabled = (source = process.env) =>
  String(source?.CHAT_SOCKET_ENABLED || '').trim().toLowerCase() === 'true';

// ── Code-owned safety bounds ────────────────────────────────────────────────

/** Default Engine.IO path. Not env-tunable: it is part of the wire contract. */
export const CHAT_SOCKET_PATH = '/socket.io';

/**
 * Hard cap on ONE inbound socket frame (Engine.IO maxHttpBufferSize, also
 * enforced as the ws maxPayload). Engine.IO's default is 1 MB — 100x the
 * API's express.json 10 kb bound, which does NOT apply to socket frames.
 * 33.1 carries no product payload at all, so the cap stays deliberately
 * small; 33.5 raises it only if message send requires it.
 */
export const CHAT_MAX_HTTP_BUFFER_BYTES = 16 * 1024;

/** Handshake must finish (including the Mongo reads) inside this window. */
export const CHAT_CONNECT_TIMEOUT_MS = 20_000;

/** Transport liveness ONLY. Never employee presence — no surveillance. */
export const CHAT_PING_INTERVAL_MS = 25_000;
export const CHAT_PING_TIMEOUT_MS = 20_000;

/** Bounded wait for the adapter's pub/sub clients to become ready. */
export const CHAT_ADAPTER_READY_TIMEOUT_MS = 5_000;

/** Bounded capped reconnect for the adapter's dedicated connections. */
export const CHAT_RECONNECT_BASE_MS = 1_000;
export const CHAT_RECONNECT_MAX_MS = 15_000;

// ── Stable client-facing error contracts ────────────────────────────────────

/**
 * THE degraded-mode contract. Stable code so a client can branch on it
 * without string matching. Deliberately generic: it never reveals whether
 * Redis is disabled, misconfigured, down, or still connecting.
 */
export const CHAT_FEATURE_UNAVAILABLE = Object.freeze({
  code: 'FEATURE_UNAVAILABLE',
  message: 'Chat realtime is not available right now. Please try again later.',
});

/**
 * Single generic auth refusal. Reasons are distinguished INTERNALLY only
 * (metrics/logs) — a socket caller can never enumerate why a token failed
 * (no enumeration oracle, same law as the 32.11 ticket route).
 */
export const CHAT_UNAUTHORIZED = Object.freeze({
  code: 'UNAUTHORIZED',
  message: 'Authentication failed. Please sign in again.',
});

// ── Redis adapter namespace ─────────────────────────────────────────────────

/**
 * Channel prefix for @socket.io/redis-adapter (its `key` option).
 * Env-namespaced with the SAME root as queues/cache/limiter/realtime
 * (`crewly:<env>:`) so staging can never consume production chat fanout.
 * Deliberately distinct from 32.11's `crewly:<env>:realtime:*`, which the
 * SSE foundation still owns (SSE stays as-is — locked decision).
 */
export const chatAdapterKey = (prefix = getQueuePrefix()) =>
  `${prefix}:chat:adapter`;

// ── Origin allowlist ────────────────────────────────────────────────────────

const normalizeOrigin = (entry) =>
  String(entry || '')
    .trim()
    .replace(/\/$/, '');

/** Same source as app.js CORS: the comma-separated CLIENT_URL allowlist. */
export const chatAllowedOrigins = (source = process.env) =>
  String(source?.CLIENT_URL || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);

// Development-only Arena live-preview allowance, mirroring src/app.js.
const DEV_PREVIEW_PATTERN = /^https:\/\/\d+-[a-z0-9-]+\.e2b\.app$/i;

/**
 * Server-side origin gate.
 *
 * Stricter than app.js on purpose: a browser Socket.IO handshake ALWAYS
 * carries an Origin, so an absent Origin is refused here (app.js allows it
 * for non-browser HTTP clients such as Postman). WebSocket upgrades are
 * NOT subject to browser CORS, so the `cors` option alone is decoration —
 * this predicate, wired through Engine.IO's `allowRequest`, is the real
 * gate for both transports.
 *
 * Never a wildcard, in any environment.
 */
export const isChatOriginAllowed = (origin, source = process.env) => {
  const normalized = normalizeOrigin(origin);

  if (!normalized) return false;
  if (chatAllowedOrigins(source).includes(normalized)) return true;

  const isProduction = String(source?.NODE_ENV || 'development') === 'production';

  return !isProduction && DEV_PREVIEW_PATTERN.test(normalized);
};
