// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — PRESENCE REDIS KEY NAMESPACE (pure, no I/O)
//
//  Single source of truth for every Redis key the presence stack uses.
//  Mirrors utils/chatKeys.js so the two feature trees share the same
//  naming convention.
//
//  LAW (re-asserted): the prefix is env-namespaced and comes from
//  config/queueConfig.js#getQueuePrefix() — the SAME helper chat,
//  realtime, queues, and the rate-limit store use. A deployment that
//  sets BULLMQ_PREFIX=crewly:production will therefore end up with
//  crewly:production:presence:<companyId>:<userId> for live liveness
//  keys. That keeps dev / staging / production from sharing one
//  namespace when they share a Redis (the common shape).
//
//  WHAT THIS MODULE DOES NOT DO
//    · No Redis call. No connection. Just the string shape.
//    · No tenant-id validation (server-derived identity always).
// ═══════════════════════════════════════════════════════════════════════════

import { getQueuePrefix } from '../config/queueConfig.js';

const PREFIX_FALLBACK = 'crewly:development';

const safePrefix = () => {
  try {
    const p = getQueuePrefix();
    if (typeof p === 'string' && p.trim().length > 0) return p.trim();
  } catch {
    /* unit tests without queueConfig loaded — fall through */
  }
  return PREFIX_FALLBACK;
};

/**
 * The liveness key for one (company, user) pair. The Redis value is a
 * JSON string (see presenceLive.js#stringifyLiveSnapshot).
 *
 *   crewly:<env>:presence:<companyId>:<userId>
 */
export const presenceLiveKey = (companyId, userId, prefix = safePrefix()) =>
  `${prefix}:presence:${String(companyId)}:${String(userId)}`;

/**
 * The connection set for one tenant/user pair. Each value is a Socket.IO
 * socket id. Scoping both dimensions prevents a shared principal from
 * inheriting another tenant's live sockets.
 *
 *   crewly:<env>:presence:conn:<companyId>:<userId>
 */
export const presenceConnectionSetKey = (companyId, userId, prefix = safePrefix()) =>
  `${prefix}:presence:conn:${String(companyId)}:${String(userId)}`;

/**
 * Bounded expiry index for currently/recently connected users. Members are
 * JSON tuples of server-derived companyId/userId; a sorted-set range by due
 * time lets the shared observer reconcile expiries without KEYS/SCAN.
 */
export const presenceExpiryIndexKey = (prefix = safePrefix()) =>
  `${prefix}:presence:expiry-index`;

export const presenceExpiryIndexMember = (companyId, userId) =>
  JSON.stringify([String(companyId), String(userId)]);

export const parsePresenceExpiryIndexMember = (member) => {
  try {
    const parsed = JSON.parse(String(member));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((part) => typeof part === 'string' && part.length > 0)
    ) {
      return { companyId: parsed[0], userId: parsed[1] };
    }
  } catch {
    /* malformed members are ignored, never interpreted as keys */
  }
  return null;
};

/**
 * The Socket.IO room name for one company. Server-derived only; the
 * client never sends a "join" event for this room.
 *
 *   presence:company:<companyId>
 *
 * (NOT env-namespaced — the room name is logical; cross-instance
 * fan-out happens in the gateway, not in the room key.)
 */
export const presenceCompanyRoom = (companyId) =>
  `presence:company:${String(companyId)}`;

/**
 * The Socket.IO room name for one user in one tenant. Both identifiers
 * are server-derived; scoping both prevents a reused principal from
 * receiving another tenant's private presence invalidation.
 *
 *   presence:user:<companyId>:<userId>
 */
export const presenceUserRoom = (companyId, userId) =>
  `presence:user:${String(companyId)}:${String(userId)}`;

/**
 * The Socket.IO namespace path the presence socket mounts on. Mirrors
 * the constant in services/presence/presenceConfig.js so a renaming
 * search lands on both. (Imported lazily to avoid a circular
 * dependency at module load.)
 */
export const presenceSocketPath = () => '/socket.io';

export const presenceNamespace = () => '/presence';
