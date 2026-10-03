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
//      - connectionCount (a positive integer)
//      - connected (boolean)
//      - lastHeartbeatAt (ISO string; the gateway's `now`)
//      - lastActivityAt (ISO string; the browser's `at`)
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
 * @param {string}  [input.lastHeartbeatAt=null]  ISO
 * @param {string}  [input.lastActivityAt=null]   ISO
 */
export const buildLiveSnapshot = (input = {}) => {
  const snapshot = {
    connected: input.connected === true,
    connectionCount: Math.max(0, Math.trunc(Number(input.connectionCount || 0))),
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
  if (!snapshot.lastActivityAt) return false; // never recorded => not "recent"
  const last = new Date(snapshot.lastActivityAt);
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
 *   connected + recent activity               -> 'available'
 *   connected + activity older than away      -> 'away'
 *   connected + heartbeat older than offline  -> 'offline'
 *   connected + no activity ever              -> 'available' (recent connect)
 *   not connected                             -> 'offline'
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
