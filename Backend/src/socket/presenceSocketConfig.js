// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — PRESENCE SOCKET CONFIGURATION
//
//  Mirrors socketConfig.js (33.1) for the presence namespace. The
//  namespace shares chat's Socket.IO Engine.IO server when chat has
//  attached one; presence can also own the Engine.IO server when chat
//  is disabled. The HTTP path remains code-owned (/socket.io).
//
//  LAW (re-asserted): the enablement flag is the only env var; every
//  safety bound is code-owned.
// ═══════════════════════════════════════════════════════════════════════════

import { getQueuePrefix } from '../config/queueConfig.js';

export const parsePresenceSocketEnabled = (source = process.env) =>
  String(source?.PRESENCE_SOCKET_ENABLED || '').trim().toLowerCase() === 'true';

// Default Engine.IO path. Same as chat (the chat socket also lives
// at /socket.io). The presence namespace sits at '/presence' (see
// presenceSocket.js#presenceNamespacePath). The chat namespace is
// the Socket.IO default ('/').
export const PRESENCE_SOCKET_PATH = '/socket.io';

export const PRESENCE_NAMESPACE = '/presence';

// Hard cap on ONE inbound socket frame when presence owns Engine.IO.
// Presence events are tiny (empty activity/heartbeat/tick frames), so
// 4 KB is far above product needs and 250x smaller than Engine.IO's default.
export const PRESENCE_MAX_HTTP_BUFFER_BYTES = 4 * 1024;

// Handshake must finish (Mongo reads + ticket validation) inside this
// window. Same as chat.
export const PRESENCE_CONNECT_TIMEOUT_MS = 20_000;

// Transport liveness ONLY. Never employee presence — no surveillance.
export const PRESENCE_PING_INTERVAL_MS = 25_000;
export const PRESENCE_PING_TIMEOUT_MS = 20_000;

// Socket.IO adapter channel prefix. Same env-namespacing law as the
// chat adapter so a shared Redis can never cross namespaces.
export const presenceAdapterKey = (prefix = getQueuePrefix()) =>
  `${prefix}:presence:adapter`;

// Generic FEATURE_UNAVAILABLE contract. Same shape as the chat
// socket — a single code so the client branches without enumeration.
export const PRESENCE_FEATURE_UNAVAILABLE = Object.freeze({
  code: 'FEATURE_UNAVAILABLE',
  message: 'Presence realtime is not available right now.',
});

export const PRESENCE_UNAUTHORIZED = Object.freeze({
  code: 'UNAUTHORIZED',
  message: 'Authentication failed. Please sign in again.',
});

// Server-side origin gate. Mirrors chat's isChatOriginAllowed.
const normalizeOrigin = (entry) =>
  String(entry || '').trim().replace(/\/$/, '');

const LOOPBACK_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const DEV_PREVIEW_PATTERN = /^https:\/\/\d+-[a-z0-9-]+\.e2b\.app$/i;

const parseAllowLocalhostOrigins = (source = process.env) =>
  String(source?.CHAT_ALLOW_LOCALHOST_ORIGINS || '').trim().toLowerCase() === 'true';

const allowedOriginsFromEnv = (source = process.env) =>
  String(source?.CLIENT_URL || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);

export const isPresenceOriginAllowed = (origin, source = process.env) => {
  const normalized = normalizeOrigin(origin);
  if (normalized && allowedOriginsFromEnv(source).includes(normalized)) return true;
  if (parseAllowLocalhostOrigins(source)) {
    if (!normalized) return true;
    if (LOOPBACK_ORIGIN_PATTERN.test(normalized)) return true;
  }
  if (!normalized) return false;
  const isProduction = String(source?.NODE_ENV || 'development') === 'production';
  return !isProduction && DEV_PREVIEW_PATTERN.test(normalized);
};
