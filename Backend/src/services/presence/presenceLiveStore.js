// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 37.4 — EPHEMERAL PRESENCE STORE (Redis only)
//
//  WHAT THIS MODULE OWNS
//    The single writer of the live-presence Redis keys:
//      crewly:<env>:presence:<companyId>:<userId>     (hash + TTL)
//      crewly:<env>:presence:conn:<userId>            (set of socket ids)
//
//  MULTI-TAB CORRECTNESS
//    markConnected / markDisconnected use SADD / SREM on the connection
//    set; the live key's `connectionCount` mirrors the set cardinality.
//    Closing one of two tabs does NOT clear liveness — the set still
//    has one entry. Only the LAST qualifying disconnect (SREM empties
//    the set) starts the grace window.
//
//  GRACE WINDOW
//    A final-tab disconnect writes an explicit zero-connection snapshot
//    and keeps it through `graceTtlSeconds`, so REST refetches and other
//    instances resolve the same confirmed Offline result. After expiry,
//    a successful missing-key read also resolves Offline; Redis errors
//    remain Unknown.
//
//  FAILURE SEMANTICS (Phase 37.4 §22)
//    · Redis down -> the store returns null, never throws. The
//      resolver treats null as 'unknown'. A successful read of a
//      missing key returns a zero-connection snapshot ('offline').
//    · The store NEVER falls back to in-process memory as authoritative
//      distributed presence (a load-balanced system cannot pretend
//      one process is global truth).
//    · The store NEVER writes to Mongo (no heartbeat history collection;
//      no `PresenceHistory` model).
//    · The store NEVER publishes to NATS or to the bus. The bus
//      publication is the SOCKET HANDLER's responsibility — the store
//      only updates facts; the handler decides when a fact is a
//      meaningful transition.
//
//  ANTI-SURVEILLANCE LAW (re-asserted)
//    The store writes ONLY:
//      · connectionCount  (integer)
//      · connectedAt      (ISO session anchor)
//      · lastHeartbeatAt  (ISO)
//      · lastActivityAt   (ISO, only for server-stamped user interactions)
//    It does NOT write mouse coords, key codes, focused element ids,
//    or any PII.
//
//  ANTI-COMMAND LAW
//    The store has no `KEYS *`, no `SCAN MATCH *` (only the bounded
//    readLive(...) on a known key), no `FLUSHDB`, no `FLUSHALL`.
//    Pinned by Backend/test/presenceBoundaries.test.js.
// ═══════════════════════════════════════════════════════════════════════════

import {
  parseLiveSnapshot,
  PRESENCE_LIVE_SNAPSHOT_KEYS,
  NO_CONNECTION_LIVE_SNAPSHOT,
} from './presenceLive.js';
import {
  clampGraceTtlSeconds,
  clampHeartbeatTtlSeconds,
  PRESENCE_HEARTBEAT_TTL_SECONDS_DEFAULT,
  PRESENCE_GRACE_TTL_SECONDS_DEFAULT,
} from './presenceConfig.js';
import {
  presenceLiveKey,
  presenceConnectionSetKey,
} from '../../utils/presenceKeys.js';

/**
 * Build a presence live store. Every dependency is injectable so the
 * hermetic suite fakes Redis; production wires the real ioredis client.
 *
 * @param {Object} deps
 * @param {Object} deps.redis                — ioredis-shaped client (hset,
 *                                            hget, sadd, srem, scard,
 *                                            smembers, del, expire).
 *                                            The real `redis` from
 *                                            config/redis.js#getRedisClient
 *                                            satisfies this; the real
 *                                            `ioredis` also does.
 * @param {string} [deps.prefix]             — env-namespace prefix
 * @param {number} [deps.heartbeatTtlSeconds]
 * @param {number} [deps.graceTtlSeconds]
 * @param {Function} [deps.now]              — clock; defaults to () => new Date()
 * @param {Object}   [deps.logger]           — pino-shaped logger
 * @param {Function} [deps.keyBuilder]       — injection seam for tests
 * @param {Function} [deps.connSetKeyBuilder]
 * @param {Function} [deps.parse]            — pure; defaults to parseLiveSnapshot
 */
export const createPresenceLiveStore = (deps = {}) => {
  if (!deps.redis) {
    throw new Error('createPresenceLiveStore requires deps.redis');
  }
  const redis = deps.redis;
  const prefix = deps.prefix || 'crewly:development';
  const heartbeatTtlSeconds = clampHeartbeatTtlSeconds(
    deps.heartbeatTtlSeconds ?? PRESENCE_HEARTBEAT_TTL_SECONDS_DEFAULT,
  );
  const graceTtlSeconds = clampGraceTtlSeconds(
    deps.graceTtlSeconds ?? PRESENCE_GRACE_TTL_SECONDS_DEFAULT,
  );
  const now = deps.now || (() => new Date());
  const logger = deps.logger || { info() {}, warn() {}, error() {} };
  const keyBuilder = deps.keyBuilder || presenceLiveKey;
  const connSetKeyBuilder = deps.connSetKeyBuilder || presenceConnectionSetKey;
  const parse = deps.parse || parseLiveSnapshot;

  // Bounded try/catch wrapper for any single Redis op. Returns the
  // fallback value (null) on error so the caller treats it as
  // "infrastructure unavailable" without bringing down the request.
  const safeCall = async (op, fallback) => {
    try {
      return await op();
    } catch (error) {
      // Safe log: code only, never the message (which may include
      // host or auth strings). Same discipline as config/redis.js.
      logger.warn(
        `[presence/live] redis ${op?.name || 'op'} failed: ${error?.code || 'error'}`,
      );
      return fallback;
    }
  };

  /**
   * One user connects (or reconnects). The store:
   *   1. SADD <connSet> <connectionId>
   *   2. SCARD <connSet>
   *   3. HSET <live> connectionCount=<n> connected=true connectedAt=<first connect>
   *      lastHeartbeatAt=now; preserve lastActivityAt (connect is not activity)
   *   4. EXPIRE <live> <heartbeatTtl>
   *   5. EXPIRE <connSet> <heartbeatTtl>
   *
   * Returns the new snapshot (or null on Redis failure).
   */
  const markConnected = async ({ companyId, userId, connectionId }) => {
    if (!companyId || !userId || !connectionId) {
      throw new Error('markConnected requires companyId, userId, connectionId');
    }
    const liveK = keyBuilder(companyId, userId, prefix);
    const connK = connSetKeyBuilder(userId, prefix);
    const at = now().toISOString();

    return safeCall(async () => {
      // SADD returns the number of NEW members; SCARD returns the
      // total. We want the total.
      await redis.sadd(connK, String(connectionId));
      const count = await redis.scard(connK);
      const priorConnectedAt = await redis.hget(liveK, 'connectedAt');
      const connectedAt =
        typeof priorConnectedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(priorConnectedAt)
          ? priorConnectedAt
          : at;
      const ttl = heartbeatTtlSeconds;
      // Pipeline HSET + EXPIRE on the live key. Connecting establishes
      // an idle baseline but is not user activity, so lastActivityAt is
      // deliberately left untouched (or absent until real interaction).
      await redis
        .multi()
        .hset(liveK, {
          connectionCount: String(count),
          connected: 'true',
          connectedAt,
          lastHeartbeatAt: at,
        })
        .expire(liveK, ttl)
        .expire(connK, ttl)
        .exec();
      return readRaw(liveK);
    }, null);
  };

  /**
   * Heartbeat refresh. Bumps lastHeartbeatAt, repairs the current
   * connection-set membership, and re-extends the TTLs. It never changes
   * lastActivityAt. The bus does NOT publish on a heartbeat.
   */
  const refreshHeartbeat = async ({ companyId, userId, connectionId }) => {
    if (!companyId || !userId) {
      throw new Error('refreshHeartbeat requires companyId, userId');
    }
    const liveK = keyBuilder(companyId, userId, prefix);
    const connK = connSetKeyBuilder(userId, prefix);
    const at = now().toISOString();

    return safeCall(async () => {
      // Re-register the authenticated socket id before refreshing. This
      // repairs ephemeral keys after a Redis TTL expiry while the Socket.IO
      // connection itself is still alive; heartbeat never changes activity.
      if (connectionId) await redis.sadd(connK, String(connectionId));
      const exists = await redis.exists(connK);
      if (!exists) return null;
      const count = await redis.scard(connK);
      if (count <= 0) return null;
      await redis
        .multi()
        .hset(liveK, {
          connectionCount: String(count),
          connected: 'true',
          lastHeartbeatAt: at,
        })
        .expire(liveK, heartbeatTtlSeconds)
        .expire(connK, heartbeatTtlSeconds)
        .exec();
      return readRaw(liveK);
    }, null);
  };

  /**
   * Activity bump. Updates lastActivityAt (plus the existing connection
   * count/TTL bookkeeping); it never changes lastHeartbeatAt. The resolver
   * decides whether the new freshness implies a meaningful transition.
   */
  const recordActivity = async ({ companyId, userId, connectionId } = {}) => {
    if (!companyId || !userId) {
      throw new Error('recordActivity requires companyId, userId');
    }
    const liveK = keyBuilder(companyId, userId, prefix);
    const connK = connSetKeyBuilder(userId, prefix);
    const ts = now().toISOString();

    return safeCall(async () => {
      if (connectionId) await redis.sadd(connK, String(connectionId));
      const exists = await redis.exists(connK);
      if (!exists) return null;
      const count = await redis.scard(connK);
      if (count <= 0) return null;
      await redis
        .multi()
        .hset(liveK, {
          connectionCount: String(count),
          connected: 'true',
          lastActivityAt: ts,
        })
        .expire(liveK, heartbeatTtlSeconds)
        .expire(connK, heartbeatTtlSeconds)
        .exec();
      return readRaw(liveK);
    }, null);
  };

  /**
   * One connection closes. SREM <connectionId>. If the set becomes
   * empty, the live key is kept for `graceTtlSeconds` as an explicit
   * zero-connection (Offline) snapshot, so refetches agree during a
   * fast reconnect. If a second tab was open, the set remains non-empty
   * and the live key continues with its heartbeat TTL.
   */
  const markDisconnected = async ({ companyId, userId, connectionId }) => {
    if (!companyId || !userId || !connectionId) {
      throw new Error('markDisconnected requires companyId, userId, connectionId');
    }
    const liveK = keyBuilder(companyId, userId, prefix);
    const connK = connSetKeyBuilder(userId, prefix);

    return safeCall(async () => {
      await redis.srem(connK, String(connectionId));
      const count = await redis.scard(connK);
      const at = now().toISOString();
      if (count === 0) {
        // Last tab closed. Keep an explicit zero-connection snapshot
        // through the grace window so REST/refetch callers all resolve
        // the same confirmed Offline value during a quick reconnect.
        await redis
          .multi()
          .hset(liveK, { connectionCount: '0', connected: 'false', lastHeartbeatAt: at })
          .expire(liveK, graceTtlSeconds)
          .expire(connK, graceTtlSeconds)
          .exec();
        return readRaw(liveK);
      }
      // Still at least one tab open — refresh liveness.
      await redis
        .multi()
        .hset(liveK, { connectionCount: String(count), connected: 'true', lastHeartbeatAt: at })
        .expire(liveK, heartbeatTtlSeconds)
        .expire(connK, heartbeatTtlSeconds)
        .exec();
      return readRaw(liveK);
    }, null);
  };

  /**
   * Read one user's live snapshot. A successful Redis read of a
   * missing key returns a zero-connection snapshot (Offline). Redis
   * command failure returns null (Unknown), preserving the distinction
   * required by Phase 37 §20.
   */
  const readLive = async ({ companyId, userId }) => {
    if (!companyId || !userId) return null;
    const liveK = keyBuilder(companyId, userId, prefix);
    return safeCall(async () => readRaw(liveK), null);
  };

  /**
   * Batched read of many users' live snapshots for the team view.
   * ONE Redis round-trip per channel (hashes are pipelined). A missing
   * key maps to the Offline snapshot; command failures map to null so
   * the resolver can report Unknown instead of inventing Offline.
   */
  const readLiveMany = async ({ companyId, userIds } = {}) => {
    if (!companyId || !Array.isArray(userIds) || userIds.length === 0) {
      return new Map();
    }
    const keys = userIds.map((u) => keyBuilder(companyId, u, prefix));
    return safeCall(async () => {
      const pipeline = redis.pipeline();
      for (const k of keys) pipeline.hgetall(k);
      const results = await pipeline.exec();
      const map = new Map();
      results.forEach(([err, value], idx) => {
        const userId = userIds[idx];
        if (err) {
          map.set(String(userId), null);
          return;
        }
        if (!value || Object.keys(value).length === 0) {
          map.set(String(userId), NO_CONNECTION_LIVE_SNAPSHOT);
          return;
        }
        map.set(String(userId), parse(JSON.stringify(value)));
      });
      return map;
    }, new Map());
  };

  /**
   * Internal: read a single hash and parse it.
   */
  const readRaw = async (liveK) => {
    const raw = await redis.hgetall(liveK);
    if (!raw || Object.keys(raw).length === 0) return NO_CONNECTION_LIVE_SNAPSHOT;
    return parse(JSON.stringify(raw));
  };

  /**
   * Diagnostics — counts only, never per-user data. The process-local
   * registry is process-local; multi-instance is N instances of this.
   */
  const describe = () => ({
    heartbeatTtlSeconds,
    graceTtlSeconds,
    keyShape: PRESENCE_LIVE_SNAPSHOT_KEYS,
  });

  return {
    markConnected,
    refreshHeartbeat,
    recordActivity,
    markDisconnected,
    readLive,
    readLiveMany,
    describe,
  };
};
