// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — EPHEMERAL PRESENCE SHAPE HELPERS (pure, no I/O)
//
//  The Redis value is a JSON string with a FIXED shape. This module
//  owns the shape and the parse/stringify helpers. The store
//  (presenceLiveStore.js) is the ONLY caller of these helpers and the
//  ONLY writer of the keys — the resolver / service / bus read the
//  store's typed return value, not the raw string.
//
//  ANTI-SURVEILLANCE LAW (re-asserted)
//    The snapshot may carry ONLY:
//      - connectionCount (a non-negative integer)
//      - connected (boolean)
//      - connectedAt (ISO string; when this live session began)
//      - lastHeartbeatAt (ISO string; the server's `now`)
//      - lastActivityAt (ISO string; a server-stamped user interaction)
//    It MUST NOT carry:
//      - mouse / touch coordinates
//      - keystrokes
//      - focused-element identifiers
//      - any PII
//      - any token
//      - any status message text
//      - any leave reason
//      - any attendance detail
//    Pinning: see Backend/test/presenceBoundaries.test.js.
// ═══════════════════════════════════════════════════════════════════════════

import {
  clampGraceTtlSeconds,
  clampHeartbeatTtlSeconds,
  PRESENCE_HEARTBEAT_TTL_SECONDS_DEFAULT,
  PRESENCE_GRACE_TTL_SECONDS_DEFAULT,
} from './presenceConfig.js';

// The ONLY fields the live snapshot may contain. The parse helper
// silently drops anything else; the build helper asserts no extra
// keys are present.
export const PRESENCE_LIVE_SNAPSHOT_KEYS = Object.freeze([
  'connected',
  'connectionCount',
  'connectedAt',
  'lastHeartbeatAt',
  'lastActivityAt',
]);

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

/**
 * Build one normalized snapshot. Pure.
 *
 * @param {Object} input
 * @param {boolean} [input.connected=false]
 * @param {number}  [input.connectionCount=0]
 * @param {string}  [input.connectedAt=null]      ISO connection-session anchor
 * @param {string}  [input.lastHeartbeatAt=null]  ISO
 * @param {string}  [input.lastActivityAt=null]   ISO, server-stamped interaction
 */
export const buildLiveSnapshot = (input = {}) => {
  const snapshot = {
    connected: input.connected === true,
    connectionCount: Math.max(0, Math.trunc(Number(input.connectionCount || 0))),
    connectedAt:
      typeof input.connectedAt === 'string' && ISO_RE.test(input.connectedAt)
        ? input.connectedAt
        : null,
    lastHeartbeatAt:
      typeof input.lastHeartbeatAt === 'string' && ISO_RE.test(input.lastHeartbeatAt)
        ? input.lastHeartbeatAt
        : null,
    lastActivityAt:
      typeof input.lastActivityAt === 'string' && ISO_RE.test(input.lastActivityAt)
        ? input.lastActivityAt
        : null,
  };

  // Strict-shape guard. A drift bug is a coding error.
  for (const key of Object.keys(snapshot)) {
    if (!PRESENCE_LIVE_SNAPSHOT_KEYS.includes(key)) {
      throw new RangeError(`live snapshot forbids key "${key}"`);
    }
  }

  return Object.freeze(snapshot);
};

// A successful Redis read of an absent key means there is no live socket
// session; it is not an infrastructure failure. Keep that distinct from
// `null`, which the store reserves for an unavailable/corrupt live read.
export const NO_CONNECTION_LIVE_SNAPSHOT = buildLiveSnapshot({
  connected: false,
  connectionCount: 0,
  connectedAt: null,
  lastHeartbeatAt: null,
  lastActivityAt: null,
});

/**
 * Parse a Redis string into a normalized snapshot. Returns null on
 * any structural problem; never throws. A snapshot that claims a
 * connectionCount > 0 but is `connected:false` is normalised to
 * `connected:true` (the count is the source of truth for liveness).
 */
export const parseLiveSnapshot = (raw) => {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const connectionCount = Math.max(0, Math.trunc(Number(parsed.connectionCount || 0)));
  // Count is the source of truth for liveness. A snapshot that claims
  // a non-zero count while stored `connected` is false is normalised
  // up; a snapshot that claims a zero count while stored `connected`
  // is true is normalised DOWN. The count wins.
  const connected = connectionCount > 0;

  return buildLiveSnapshot({
    connected,
    connectionCount,
    connectedAt:
      typeof parsed.connectedAt === 'string' && ISO_RE.test(parsed.connectedAt)
        ? parsed.connectedAt
        : null,
    lastHeartbeatAt:
      typeof parsed.lastHeartbeatAt === 'string' && ISO_RE.test(parsed.lastHeartbeatAt)
        ? parsed.lastHeartbeatAt
        : null,
    lastActivityAt:
      typeof parsed.lastActivityAt === 'string' && ISO_RE.test(parsed.lastActivityAt)
        ? parsed.lastActivityAt
        : null,
  });
};

/**
 * Stringify a normalized snapshot for Redis. Returns '' on any
 * structural problem (the store treats '' as a no-op and never
 * writes it). Pure.
 */
export const stringifyLiveSnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== 'object') return '';
  try {
    return JSON.stringify({
      connected: snapshot.connected === true,
      connectionCount: Math.max(0, Math.trunc(Number(snapshot.connectionCount || 0))),
      connectedAt: snapshot.connectedAt || null,
      lastHeartbeatAt: snapshot.lastHeartbeatAt || null,
      lastActivityAt: snapshot.lastActivityAt || null,
    });
  } catch {
    return '';
  }
};

/**
 * Pure freshness check. A snapshot is "fresh" if the last activity
 * is within the away threshold. Used by the resolver + the team
 * service to derive `available` vs `away`.
 */
export const isWithinAwayThreshold = (snapshot, now, awayAfterMinutes) => {
  if (!snapshot) return false;
  // A real interaction is the authoritative signal. Before the first
  // interaction in a session, connectedAt supplies a one-time idle anchor;
  // heartbeats never move either timestamp.
  const lastSignalAt = snapshot.lastActivityAt || snapshot.connectedAt;
  if (!lastSignalAt) return false;
  const last = new Date(lastSignalAt);
  if (Number.isNaN(last.getTime())) return false;
  const ms = now.getTime() - last.getTime();
  if (ms < 0) return true; // clock skew tolerance
  return ms <= awayAfterMinutes * 60_000;
};

/**
 * Pure freshness check for the OFFLINE transition. The user is
 * "not live" when EITHER the connection count is zero OR the last
 * heartbeat is older than the offline threshold. Either signal is
 * sufficient; both together is the unambiguous Offline case.
 */
export const isBeyondOfflineThreshold = (snapshot, now, offlineAfterMinutes) => {
  if (!snapshot) return false;
  if (snapshot.connectionCount === 0) return true;
  if (!snapshot.lastHeartbeatAt) return true; // no heartbeat ever recorded
  const last = new Date(snapshot.lastHeartbeatAt);
  if (Number.isNaN(last.getTime())) return true;
  const ms = now.getTime() - last.getTime();
  if (ms < 0) return false;
  return ms > offlineAfterMinutes * 60_000;
};

/**
 * Pure: derive an effective live presence from one snapshot + tenant
 * config + clock. Returns one of PRESENCE_LIVE_STATES.
 *
 *   connected + recent activity                -> 'available'
 *   connected + activity older than away       -> 'away'
 *   connected + heartbeat older than offline   -> 'offline'
 *   connected + no activity yet                -> use connectedAt as a one-time idle anchor
 *   not connected                              -> 'offline'
 *   live === null (infrastructure unavailable) -> 'unknown'
 */
export const deriveLivePresence = ({ snapshot, config, now } = {}) => {
  if (snapshot === null || snapshot === undefined) return 'unknown';
  if (!snapshot.connected && snapshot.connectionCount === 0) return 'offline';

  const awayAfterMinutes = config?.awayAfterMinutes ?? 5;
  const offlineAfterMinutes = config?.offlineAfterMinutes ?? 15;

  if (isBeyondOfflineThreshold(snapshot, now, offlineAfterMinutes)) return 'offline';
  if (isWithinAwayThreshold(snapshot, now, awayAfterMinutes)) return 'available';
  // Connected, no recent activity, but heartbeats still alive => Away.
  return 'away';
};

// Re-export the clamp helpers so a caller that already imports from
// presenceLive.js does not have to import both modules.
export {
  clampGraceTtlSeconds,
  clampHeartbeatTtlSeconds,
  PRESENCE_HEARTBEAT_TTL_SECONDS_DEFAULT,
  PRESENCE_GRACE_TTL_SECONDS_DEFAULT,
};
