import logger from '../config/logger.js';
import { getRedisClient } from '../config/redis.js';
import { getQueuePrefix } from '../config/queueConfig.js';

// ============================================================
//  PHASE 32.4 — SHARED RATE-LIMIT COUNTER (ONE primitive).
//
//  Makes security-sensitive limits meaningful across API #1/#2/#N:
//  counters live in Redis under exact, TTL-bounded keys
//
//      crewly:<env>:rl:<sharedName>:<identity>
//
//  (env isolation via the queue prefix — dev/stage/prod and test
//  prefixes never collide; <sharedName> isolates surfaces; tenant
//  isolation comes from the identity itself, e.g. kiosk keys embed
//  companyId/stationId).
//
//  DEGRADED BEHAVIOR (Redis law: coordination, never truth):
//  - Redis disabled / null client → in-process fallback buckets.
//  - Redis error or >250ms op → circuit opens 30s (process-local),
//    the request is served from fallback buckets. Limits NEVER get
//    weaker than the pre-32.4 per-process behavior.
//  - Fallback buckets are bounded (oldest-evicted).
//
//  No KEYS/SCAN/FLUSH — only INCR / EXPIRE NX / GET / DEL exact keys.
// ============================================================

const OP_TIMEOUT_MS = 250;
const CIRCUIT_COOLDOWN_MS = 30 * 1000;
const FALLBACK_MAX_KEYS = 10000;

// Process-local circuit breaker (one Redis → one breaker per process).
let redisDownUntil = 0;

const withTimeout = async (operation) => {
  let timer = null;

  try {
    return await Promise.race([
      operation,

      new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('rate-limit redis op timeout')),
          OP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  };
};

// Bounded in-process fallback (name:identity → {count, resetAt}).
const fallbackBuckets = new Map();

const fallbackHit = (storeKey, windowMs, maximum) => {
  const now = Date.now();

  let bucket = fallbackBuckets.get(storeKey);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };

    fallbackBuckets.set(storeKey, bucket);

    if (fallbackBuckets.size > FALLBACK_MAX_KEYS) {
      fallbackBuckets.delete(fallbackBuckets.keys().next().value);
    }
  }

  bucket.count += 1;

  return {
    limited: bucket.count > maximum,
    count: bucket.count,
    remaining: Math.max(0, maximum - bucket.count),
    resetAt: bucket.resetAt,
    tier: 'local',
  };
};

export const resetRateLimitStoreForTests = () => {
  fallbackBuckets.clear();
  redisDownUntil = 0;
};

export const createRateLimitStore = ({
  sharedName,
  windowMs,
  io = null,
} = {}) => {
  const keyPrefix = `${getQueuePrefix()}:rl:${sharedName}:`;

  const fullKey = (identity) => `${keyPrefix}${identity}`;

  // Real Redis IO (default): exact-key fixed window.
  const defaultIo = {
    incr: async (key, ttlSeconds) => {
      const client = getRedisClient();

      if (!client) return null; // disabled → caller falls back

      const count = await withTimeout(
        client.incr(key),
      );

      await withTimeout(
        client.expire(key, ttlSeconds, 'NX'),
      );

      return count;
    },

    get: async (key) => {
      const client = getRedisClient();

      if (!client) return null;

      const value = await withTimeout(client.get(key));

      return value === null ? null : Number(value);
    },

    del: async (key) => {
      const client = getRedisClient();

      if (!client) return;

      await withTimeout(client.del(key));
    },
  };

  const backend = io || defaultIo;

  const redisHit = async (identity, maximum) => {
    const key = fullKey(identity);

    const ttlSeconds = Math.ceil(windowMs / 1000);

    const count = await backend.incr(key, ttlSeconds);

    if (count === null || count === undefined) return null; // disabled

    return {
      limited: count > maximum,
      count,
      remaining: Math.max(0, maximum - count),
      // Fixed window ends a full window after the first hit; the
      // precise TTL lives in Redis, headers only need a bound.
      resetAt: Date.now() + windowMs,
      tier: 'shared',
    };
  };

  return {
    // Count one hit for this identity. Never throws — degraded mode
    // returns the local fallback result.
    hit: async (identity, maximum) => {
      if (Date.now() >= redisDownUntil) {
        try {
          const result = await redisHit(identity, maximum);

          if (result) return result;

          return fallbackHit(`${sharedName}:${identity}`, windowMs, maximum);
        } catch (error) {
          redisDownUntil = Date.now() + CIRCUIT_COOLDOWN_MS;

          logger.warn(
            '[RateLimit] Redis unavailable — using in-process buckets ' +
              `for ${CIRCUIT_COOLDOWN_MS / 1000}s (${error.message})`
          );
        }
      }

      return fallbackHit(`${sharedName}:${identity}`, windowMs, maximum);
    },

    // Read-only peek (block checks) — null when Redis unavailable.
    peek: async (identity) => {
      if (Date.now() >= redisDownUntil) {
        try {
          return await backend.get(fullKey(identity));
        } catch {
          redisDownUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
        }
      }

      const bucket = fallbackBuckets.get(`${sharedName}:${identity}`);

      return bucket && bucket.resetAt > Date.now() ? bucket.count : 0;
    },

    // Clear a counter (e.g. successful Super Admin login).
    clear: async (identity) => {
      fallbackBuckets.delete(`${sharedName}:${identity}`);

      try {
        if (Date.now() >= redisDownUntil) {
          await backend.del(fullKey(identity));
        }
      } catch {
        redisDownUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      }
    },

    keyPrefix,
  };
};

export default createRateLimitStore;
