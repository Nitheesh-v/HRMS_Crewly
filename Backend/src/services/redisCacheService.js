// ============================================================
//  PHASE 28.7 — SAFE REDIS CACHING ABSTRACTION
//
// The ONE place business code talks to Redis for caching.
// Controllers never touch ioredis; services call this module.
//
// GUARANTEES
//   - FAIL-OPEN: every operation degrades to a safe no-op/miss.
//     A dead/timeout Redis can never break a read or a write.
//   - BOUNDED: every operation races against a short timeout
//     (default 500ms) — a slow cache never delays a Mongo read.
//   - TENANT: buildTenantCacheKey requires a valid companyId;
//     keys are always crewly:cache:company:<companyId>:...
//   - NAMESPACE: `crewly:cache:...` — structurally disjoint from
//     BullMQ prefixes (crewly:<env> or BULLMQ_PREFIX). This module
//     only ever GET/SET/DEL/INCR exact keys it built itself.
//     NO FLUSHALL / FLUSHDB / KEYS / SCAN — ever.
//   - SINGLE-FLIGHT: concurrent getOrSetCache calls for the same
//     key in this process share ONE loader promise (bounded
//     stampede protection per instance; multi-instance limitation
//     is documented — the short TTL bounds its window).
//   - NO SECRETS/PII: values are opaque to this module; logs carry
//     result + durationMs + namespace only, never values or keys
//     (keys embed companyId only — logged in a dedicated field).
//
// Pure ESM — matches the rest of the Backend.
// ============================================================

import crypto from 'node:crypto';
import logger from '../config/logger.js';
import { getRedisClient, getRedisHealth } from '../config/redis.js';

// --- Tunables (bounded, clamped) --------------------------------

const MIN_OP_TIMEOUT_MS = 100;
const MAX_OP_TIMEOUT_MS = 2000;
const DEFAULT_OP_TIMEOUT_MS = 500;

const clampOpTimeout = (value) => {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_OP_TIMEOUT_MS;
  return Math.min(MAX_OP_TIMEOUT_MS, Math.max(MIN_OP_TIMEOUT_MS, parsed));
};

export const getCacheOpTimeoutMs = (source = process.env) =>
  clampOpTimeout(source.REDIS_CACHE_OP_TIMEOUT_MS);

// Default max serialized value size (256 KB) — analytics responses
// are bounded aggregates; anything bigger is not cache-worthy.
export const MAX_CACHE_VALUE_BYTES = 256 * 1024;

const OBJECT_ID = /^[a-f0-9]{24}$/i;

// --- Key building ------------------------------------------------

const safeSegment = (value) => {
  const text = String(value ?? '').trim();
  if (!text || text.length > 64 || /[^A-Za-z0-9_\-:.]/.test(text)) return null;
  return text;
};

// Deterministic, tenant-scoped cache key. Returns null (never a
// string) when any part is unsafe — callers fall back to bypass.
export const buildTenantCacheKey = ({ companyId, namespace, version, segments = [] }) => {
  const tenant = safeSegment(companyId);
  if (!tenant || !OBJECT_ID.test(tenant)) return null;
  const ns = safeSegment(namespace);
  if (!ns || ns.includes('..')) return null;
  const ver = Math.trunc(Number(version));
  if (!Number.isInteger(ver) || ver < 1) return null;
  const parts = [];
  for (const segment of segments) {
    const part = safeSegment(segment);
    if (!part || part.includes('..')) return null;
    parts.push(part);
  }
  return `crewly:cache:company:${tenant}:${ns}:v${ver}:${parts.join(':')}`;
};

// --- Bounded, fail-open command runner ---------------------------

// Runs one ioredis command with a hard timeout. Resolves null on
// ANY failure (down, timeout, error) — callers treat null as miss.
const withTimeout = (promise, ms, label) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.debug(`[Cache] ${label} timed out after ${ms}ms — treated as miss`);
      resolve(null);
    }, ms);
    timer.unref();
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        logger.debug(`[Cache] ${label} unavailable (${error?.code || 'error'})`);
        resolve(null);
      });
  });

// Fast bypass when the 28.1 infrastructure already reports the
// connection down/disabled — avoids hammering a known-down Redis.
const isRedisUsable = () => {
  const client = getRedisClient();
  if (!client) return false;
  return getRedisHealth().status === 'up';
};

// --- Primitive operations (all fail-open) -------------------------

export const getCache = async (key, { opTimeoutMs } = {}) => {
  if (!key || !isRedisUsable()) return null;
  const timeout = clampOpTimeout(opTimeoutMs ?? getCacheOpTimeoutMs());
  const raw = await withTimeout(getRedisClient().get(key), timeout, 'GET');
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Corrupt/malformed entry: remove this EXACT key (safe, exact)
    // and treat as a miss. Never log the content.
    await deleteCache(key, { opTimeoutMs: timeout });
    return null;
  }
};

// Raw read (no JSON parse) — used for counter keys that store a
// plain integer (e.g. the analytics generation). Fail-open like get.
export const getCacheRaw = async (key, { opTimeoutMs } = {}) => {
  if (!key || !isRedisUsable()) return null;
  const timeout = clampOpTimeout(opTimeoutMs ?? getCacheOpTimeoutMs());
  return withTimeout(getRedisClient().get(key), timeout, 'GET(raw)');
};

export const setCache = async (key, value, ttlSeconds, { opTimeoutMs } = {}) => {
  if (!key || !ttlSeconds || !isRedisUsable()) return false;
  const timeout = clampOpTimeout(opTimeoutMs ?? getCacheOpTimeoutMs());
  let raw;
  try {
    raw = JSON.stringify(value);
  } catch {
    return false; // unserializable → skip cache, keep the source result
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_CACHE_VALUE_BYTES) {
    logger.debug('[Cache] value exceeds max size — write skipped (source result returned)');
    return false;
  }
  const ttl = Math.max(1, Math.trunc(Number(ttlSeconds)));
  const result = await withTimeout(getRedisClient().set(key, raw, 'EX', ttl), timeout, 'SET');
  return result === 'OK';
};

export const deleteCache = async (key, { opTimeoutMs } = {}) => {
  if (!key || !isRedisUsable()) return false;
  const timeout = clampOpTimeout(opTimeoutMs ?? getCacheOpTimeoutMs());
  const result = await withTimeout(getRedisClient().del(key), timeout, 'DEL');
  return Boolean(result);
};

// Generic counter primitive (used by generation invalidation).
// Returns the new counter value, or null when Redis is unavailable.
export const incrementWithTtl = async (key, ttlSeconds, { opTimeoutMs } = {}) => {
  if (!key || !isRedisUsable()) return null;
  const timeout = clampOpTimeout(opTimeoutMs ?? getCacheOpTimeoutMs());
  const client = getRedisClient();
  const value = await withTimeout(client.incr(key), timeout, 'INCR');
  if (value === null) return null;
  await withTimeout(client.expire(key, Math.max(60, Math.trunc(Number(ttlSeconds)))), timeout, 'EXPIRE');
  return value;
};

// --- Envelope (version-safe payloads) -----------------------------

const buildEnvelope = (version, payload) => ({ v: version, at: Date.now(), payload });

export const parseEnvelope = (raw, expectedVersion) => {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v !== expectedVersion) return null; // old/incompatible generation
  if (raw.payload === undefined || raw.payload === null) return null;
  return raw.payload;
};

// --- getOrSetCache (single-flight) --------------------------------
//
// in-flight map: key -> Promise. Concurrent callers for the same
// key share ONE loader invocation; the entry is always removed in
// finally (success AND failure — no memory leak, no poison state).
const inFlight = new Map();

// `io` is a DI seam ({ get, set, del }) used by hermetic tests; the
// defaults are the real fail-open operations.
// --- In-process status counters (28.8 cache ops) -----------------
// Per-process counters only (multi-instance deploys show their
// own slice — documented). Metadata: counts + timestamps, never
// keys or payloads.
const cacheStats = {
  hits: 0,
  misses: 0,
  bypasses: 0,
  writes: 0,
  writeSkips: 0,
  invalidations: 0,
  lastEventAt: null,
};
const touchStats = () => {
  cacheStats.lastEventAt = Date.now();
};

export const getCacheStats = () => ({ ...cacheStats });

// Called by the analytics invalidation bump so the ops UI can
// show when (in this process) the last invalidation happened.
export const noteCacheInvalidation = () => {
  cacheStats.invalidations += 1;
  touchStats();
};

// --- Read-through with in-process single-flight ------------------

export const getOrSetCache = async (key, { ttlSeconds, version = 1, loader, io = {} } = {}) => {
  const doGet = io.get || getCache;
  const doSet = io.set || setCache;
  const doDelete = io.del || deleteCache;

  if (!key || typeof loader !== 'function') {
    // No cache: run the source directly.
    cacheStats.bypasses += 1;
    touchStats();
    const value = await loader();
    return { value, cache: 'BYPASS' };
  }

  if (inFlight.has(key)) {
    // Share the in-flight run: the result carries the original
    // run's HIT/MISS outcome.
    return inFlight.get(key);
  }

  const run = (async () => {
    const startedAt = Date.now();
    const hit = await doGet(key);
    if (hit !== null && hit !== undefined) {
      const payload = parseEnvelope(hit, version);
      if (payload !== null) {
        cacheStats.hits += 1;
        touchStats();
        logger.info(
          `[Cache] ${keyNs(key)} hit durationMs=${Date.now() - startedAt}`
        );
        return { value: payload, cache: 'HIT' };
      }
      // Malformed envelope: exact delete + fall through to source.
      await doDelete(key);
    }
    cacheStats.misses += 1;
    touchStats();
    logger.info(`[Cache] ${keyNs(key)} miss — loading from source`);
    const value = await loader();
    const stored = await doSet(key, buildEnvelope(version, value), ttlSeconds).catch(
      () => false
    );
    if (stored) {
      cacheStats.writes += 1;
    } else {
      cacheStats.writeSkips += 1;
    }
    logger.info(
      `[Cache] ${keyNs(key)} ${stored ? 'stored' : 'loaded (cache write skipped)'} durationMs=${Date.now() - startedAt}`
    );
    return { value, cache: 'MISS' };
  })();

  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
};

// Log-safe namespace label (never the full key, never tenant id).
const keyNs = (key) => {
  const match = String(key || '').match(/^crewly:cache:company:[a-f0-9]{24}:([^:]+)/i);
  return match ? match[1] : 'cache';
};

// --- Test hook (hermetic suites only) ------------------------------

export const _resetCacheForTests = () => {
  inFlight.clear();
};

// Re-export for convenience in key builders (kept here so key
// building + hashing live beside the abstraction, not scattered).
export const sha256Hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
