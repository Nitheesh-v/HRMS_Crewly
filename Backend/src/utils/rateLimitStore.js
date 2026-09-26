// ============================================================
// Phase 32.4 — THE ONE distributed rate-limit store.
//
// Security-sensitive limiters share ONE counter in Redis so API
// #1/#2/#N enforce a single logical budget
// (crewly:<env>:rl:<family>:<identity>).
//
// LAWS (Phase 32.4 build prompt):
//  - Redis is COORDINATION, never truth. Degradation is never
//    weaker than the pre-32.4 per-process baseline: a bounded
//    in-process bucket always protects the process when Redis is
//    disabled, unreachable, erroring, or slower than OP_TIMEOUT_MS.
//  - Atomicity: the counter is one INCR — never GET-then-SET.
//  - TTL: the window length bounds every key's life. EXPIRE NX is
//    attempted only on the first hit of a window (Redis >= 7);
//    older servers fall back to a plain EXPIRE on count === 1.
//  - Namespace: crewly:<env>:rl:<family>: — isolated from caches,
//    queues, heartbeats and other environments. Exact keys only:
//    no KEYS / SCAN / FLUSH anywhere in this module.
//
//  33.11-fix — NO IDENTITY MAY BE BLOCKED FOREVER. A window whose EXPIRE
//  failed leaves a TTL-less counter that refuses that identity until someone
//  deletes the key by hand; the next refusal re-asserts the TTL through the
//  io contract's optional `expireIfMissing(key, ttlSeconds)`. An injected io
//  without that method simply skips healing (legacy/test doubles).
//  - REDIS_DISABLED (strict parser in config/redis.js) is quiet
//    local mode; REDIS_DOWN opens a short process-local circuit
//    and warns ONCE per open — never per request. No limiter key,
//    identity, or token material is ever logged.
// ============================================================

import { getRedisClient } from '../config/redis.js';

import { getQueuePrefix } from '../config/queueConfig.js';

// Bounded, internal constants — deliberately NOT env-tunable.
const OP_TIMEOUT_MS = 250;

const CIRCUIT_COOLDOWN_MS = 30 * 1000;

const FALLBACK_MAX_KEYS = 10000;

const withTimeout = (promise) =>
  Promise.race([
    promise,

    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('rate-limit redis op timeout')),

        OP_TIMEOUT_MS,
      ),
    ),
  ]);

const fallbackStores = new Map();

const circuitOpenUntil = new Map();

// One bounded warn per circuit-open event, per family.
const warnDegraded = (sharedName) => {
  const last = circuitOpenUntil.get(`warn:${sharedName}`) || 0;

  if (Date.now() - last < CIRCUIT_COOLDOWN_MS) return;

  circuitOpenUntil.set(`warn:${sharedName}`, Date.now());

  console.warn(
    `[RateLimit] Redis unavailable — "${sharedName}" limiting degraded to ` +
      `per-process buckets for ${CIRCUIT_COOLDOWN_MS / 1000}s (protection ` +
      `continues, no longer shared across instances).`,
  );
};

const fallbackMap = (sharedName) => {
  let map = fallbackStores.get(sharedName);

  if (!map) {
    map = new Map();

    fallbackStores.set(sharedName, map);
  }

  return map;
};

// Bounded in-process fixed-window bucket. Oldest-evicted at 10k keys
// so a flood can never grow memory without bound.
const fallbackHit = (sharedName, key, windowMs, maximum) => {
  const map = fallbackMap(sharedName);

  const now = Date.now();

  if (!map.has(key) && map.size >= FALLBACK_MAX_KEYS) {
    const oldest = map.keys().next().value;

    map.delete(oldest);
  }

  const bucket = map.get(key) || { count: 0, resetAt: now + windowMs };

  if (bucket.resetAt <= now) {
    bucket.count = 0;

    bucket.resetAt = now + windowMs;
  }

  bucket.count += 1;

  map.set(key, bucket);

  return {
    limited: bucket.count > maximum,

    count: bucket.count,

    remaining: Math.max(0, maximum - bucket.count),

    resetAt: bucket.resetAt,

    tier: 'local',
  };
};

const fallbackPeek = (sharedName, key) => {
  const bucket = fallbackMap(sharedName).get(key);

  if (!bucket || bucket.resetAt <= Date.now()) return 0;

  return bucket.count;
};

export const createRateLimitStore = ({
  sharedName,

  windowMs,

  io = null,
}) => {
  const ttlSeconds = Math.max(1, Math.ceil(windowMs / 1000));

  const keyPrefix = `${getQueuePrefix()}:rl:${sharedName}:`;

  // Default IO — the repository's own ioredis client (config/redis.js
  // strict enablement; getRedisClient() is null when disabled).
  const defaultIo = {
    incr: async (key) => {
      const client = getRedisClient();

      if (!client) return null; // intentionally disabled → local mode

      const count = await withTimeout(client.incr(key));

      if (count === 1) {
        await withTimeout(
          client.expire(key, ttlSeconds, 'NX'),
        ).catch(() =>
          withTimeout(client.expire(key, ttlSeconds)),
        );
      }

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

    // 33.11-fix — heal a window whose TTL never got set. Deliberately asks for
    // the TTL first instead of using `EXPIRE ... NX`: NX needs Redis 7+ and
    // this product must run against older servers too. One extra round-trip,
    // on the refusal path only.
    expireIfMissing: async (key) => {
      const client = getRedisClient();

      if (!client) return false;

      const ttl = await withTimeout(client.ttl(key));

      // -2 = the key is gone (nothing to heal), > 0 = a healthy live window.
      if (ttl !== -1) return false;

      const applied = await withTimeout(client.expire(key, ttlSeconds));

      return applied === 1;
    },
  };

  const backend = io || defaultIo;

  const fullKey = (identity) => `${keyPrefix}${identity}`;

  // THE hot-path operation. Never throws: every failure mode lands on
  // the bounded local bucket with the same response contract.
  const hit = async (identity, maximum) => {
    const key = fullKey(identity);

    const now = Date.now();

    if ((circuitOpenUntil.get(sharedName) || 0) > now) {
      return fallbackHit(sharedName, key, windowMs, maximum);
    }

    try {
      const count = await backend.incr(key, ttlSeconds);

      if (count === null || count === undefined) {
        // Redis intentionally disabled — quiet local mode, no circuit,
        // no warning (this is a documented deployment shape).
        return fallbackHit(sharedName, key, windowMs, maximum);
      }

      if (count > maximum) {
        // 33.11-fix — IMMORTAL KEY SELF-HEAL.
        //
        // The window's TTL is set on the FIRST hit (EXPIRE NX). If that call
        // fails — a 250 ms op timeout on a loaded Redis is enough — the
        // counter survives with NO TTL, so every later request from that
        // identity is refused FOREVER. Observed in the field as a permanent
        // `POST /api/auth/refresh 429` for one IP that never recovered, twice
        // twelve minutes apart, with no preceding burst in the logs: a
        // limiter quietly became an outage.
        //
        // The refused request repairs it. Best effort by design: healing must
        // never change the refusal, and it only runs on the rare refusal path.
        try {
          await backend.expireIfMissing?.(key, ttlSeconds);
        } catch {
          /* healing is best effort — the refusal stands regardless */
        }
      }

      return {
        limited: count > maximum,

        count,

        remaining: Math.max(0, maximum - count),

        // Exact reset instant — the TTL the first hit of this window set.
        resetAt: now + ttlSeconds * 1000,

        tier: 'shared',
      };
    } catch {
      // Redis expected but down/slow → circuit + ONE bounded warning.
      circuitOpenUntil.set(sharedName, now + CIRCUIT_COOLDOWN_MS);

      warnDegraded(sharedName);

      return fallbackHit(sharedName, key, windowMs, maximum);
    }
  };

  // Read-only count (Super Admin guard block check).
  const peek = async (identity) => {
    const key = fullKey(identity);

    if ((circuitOpenUntil.get(sharedName) || 0) > Date.now()) {
      return fallbackPeek(sharedName, key);
    }

    try {
      const value = await backend.get(key);

      if (value === null || value === undefined) {
        return fallbackPeek(sharedName, key);
      }

      return Number(value) || 0;
    } catch {
      circuitOpenUntil.set(sharedName, Date.now() + CIRCUIT_COOLDOWN_MS);

      warnDegraded(sharedName);

      return fallbackPeek(sharedName, key);
    }
  };

  // Exact-key cleanup (successful Super Admin login). No wildcards.
  const clear = async (identity) => {
    const key = fullKey(identity);

    fallbackMap(sharedName).delete(key);

    try {
      await backend.del(key);
    } catch {
      circuitOpenUntil.set(sharedName, Date.now() + CIRCUIT_COOLDOWN_MS);
    }
  };

  return { sharedName, windowMs, keyPrefix, hit, peek, clear };
};

// Test isolation only — never called in production paths.
export const resetRateLimitStoreForTests = () => {
  fallbackStores.clear();

  circuitOpenUntil.clear();
};
