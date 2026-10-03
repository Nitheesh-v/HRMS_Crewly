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
//    A user closing their final tab does NOT immediately read as
//    "offline" — the live key TTL is set to `graceTtlSeconds` so a
//    reconnect landing on a different instance still sees the user as
//    recently alive. After the grace window the next read returns
//    null (the key is gone) and the resolver returns `offline`.
//
//  FAILURE SEMANTICS (Phase 37.4 §22)
//    · Redis down -> the store returns null, never throws. The
//      resolver treats null as 'unknown'. The HRMS keeps running.
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
//      · lastHeartbeatAt  (ISO)
//      · lastActivityAt   (ISO)
//    It does NOT write mouse coords, key codes, focused element ids,
//    or any PII.
//
//  ANTI-COMMAND LAW
//    The store has no `KEYS *`, no `SCAN MATCH *` (only the bounded
//    readLive(...) on a known key), no `FLUSHDB`, no `FLUSHALL`.
//    Pinned by Backend/test/presenceBoundaries.test.js.
// ═══════════════════════════════════════════════════════════════════════════

import {
  buildLiveSnapshot,
  parseLiveSnapshot,
  stringifyLiveSnapshot,
  PRESENCE_LIVE_SNAPSHOT_KEYS,
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
 * @param {Function} [deps.stringify]        — pure; defaults to stringifyLiveSnapshot
 * @param {Function} [deps.parse]            — pure; defaults to parseLiveSnapshot
 * @param {Function} [deps.build]            — pure; defaults to buildLiveSnapshot
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
  const stringify = deps.stringify || stringifyLiveSnapshot;
  const parse = deps.parse || parseLiveSnapshot;
  const build = deps.build || buildLiveSnapshot;

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
   *   3. HSET <live> connectionCount=<n> connected=true lastHeartbeatAt=now lastActivityAt=now
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
      const ttl = heartbeatTtlSeconds;
      // Pipeline HSET + EXPIRE on the live key.
      await redis
        .multi()
        .hset(liveK, {
          connectionCount: String(count),
          connected: 'true',
          lastHeartbeatAt: at,
          lastActivityAt: at,
        })
        .expire(liveK, ttl)
        .expire(connK, ttl)
        .exec();
      return readRaw(liveK);
    }, null);
  };

  /**
   * Heartbeat refresh. Bumps lastHeartbeatAt and re-extends the TTLs.
   * Does NOT change connectionCount. The bus does NOT publish on a
   * heartbeat (no meaningful state change).
   */
  const refreshHeartbeat = async ({ companyId, userId }) => {
    if (!companyId || !userId) {
      throw new Error('refreshHeartbeat requires companyId, userId');
    }
    const liveK = keyBuilder(companyId, userId, prefix);
    const connK = connSetKeyBuilder(userId, prefix);
    const at = now().toISOString();

    return safeCall(async () => {
      // Only refresh if the user actually has live state (the connection
      // set is the source of truth for "online"). If the user is not
      // connected at all, this is a no-op.
      const exists = await redis.exists(connK);
      if (!exists) return null;
      await redis
        .multi()
        .hset(liveK, { lastHeartbeatAt: at })
        .expire(liveK, heartbeatTtlSeconds)
        .expire(connK, heartbeatTtlSeconds)
        .exec();
      return readRaw(liveK);
    }, null);
  };

  /**
   * Activity bump. Only updates lastActivityAt; the resolver decides
   * if the new freshness implies a meaningful transition (away ->
   * available). The store has no opinion on the precedence — it
   * stores facts, the resolver interprets them.
   */
  const recordActivity = async ({ companyId, userId, at } = {}) => {
    if (!companyId || !userId) {
      throw new Error('recordActivity requires companyId, userId');
    }
    const liveK = keyBuilder(companyId, userId, prefix);
    const connK = connSetKeyBuilder(userId, prefix);
    const ts = (at instanceof Date ? at : new Date(at || now())).toISOString();

    return safeCall(async () => {
      const exists = await redis.exists(connK);
      if (!exists) return null;
      await redis
        .multi()
        .hset(liveK, { lastActivityAt: ts })
        .expire(liveK, heartbeatTtlSeconds)
        .expire(connK, heartbeatTtlSeconds)
        .exec();
      return readRaw(liveK);
    }, null);
  };

  /**
   * One connection closes. SREM <connectionId>. If the set becomes
   * empty, the live key is kept for `graceTtlSeconds` so a fast
   * reconnect doesn't flicker through Offline. If a second tab was
   * open, the set is still non-empty and the live key continues
   * with its heartbeat TTL.
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
        // Last tab closed. Keep the live key for the grace window
        // and mark connected=false so a quick reconnect on any
        // instance can detect "recently online" without seeing
        // "offline" momentarily.
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
   * Read one user's live snapshot. Returns null if the key is absent
   * OR if Redis is down (the resolver treats null as 'unknown' — the
   * honest Phase 37 §20 answer).
   */
  const readLive = async ({ companyId, userId }) => {
    if (!companyId || !userId) return null;
    const liveK = keyBuilder(companyId, userId, prefix);
    return safeCall(async () => readRaw(liveK), null);
  };

  /**
   * Batched read of many users' live snapshots for the team view.
   * ONE Redis round-trip per channel (hashes are pipelined). Returns
   * a Map<userId, snapshot|null>. Missing users map to null.
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
        if (err || !value || Object.keys(value).length === 0) {
          map.set(String(userId), null);
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
    if (!raw || Object.keys(raw).length === 0) return null;
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
