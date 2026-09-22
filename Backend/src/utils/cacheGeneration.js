// ============================================================
//  PHASE 32.6 — SHARED CACHE GENERATION OVERLAY
//
//  Closes the 32.1-deferred multi-instance invalidation gap for the
//  two PROCESS-LOCAL caches (subscription gate, permission caches):
//  their exact same-process invalidation stays, and a SHARED Redis
//  generation counter is added as the cross-instance signal.
//
//    crewly:cache:company:<companyId>:<namespace>:generation
//
//  CONTRACT (all fail-open — cache is never business truth):
//    readCacheGeneration  → integer (>=0)  : authoritative shared
//                                            generation; a local entry
//                                            stamped with an older one
//                                            must be treated as stale.
//                         → null           : Redis unusable → the
//                                            caller keeps its local
//                                            TTL semantics (bounded
//                                            staleness, exactly the
//                                            pre-32.6 behavior).
//    bumpCacheGeneration  → true/false     : INCR + refreshed TTL;
//                                            NEVER throws, never
//                                            blocks a business write.
//
//  Key shape matches the 28.7 analytics generations
//  (analyticsCacheInvalidation.js). Exact keys only — no KEYS /
//  SCAN / FLUSH. Logs carry namespaces, never keys or payloads.
// ============================================================

import logger from '../config/logger.js';

import { getRedisClient, getRedisHealth } from '../config/redis.js';

import {
  getCacheRaw,
  incrementWithTtl,
  noteCacheInvalidation,
} from '../services/redisCacheService.js';

const GENERATION_TTL_SECONDS = 24 * 60 * 60; // refreshed on every bump

// Tight bound: this read can sit on hot paths (permission checks),
// so it must never add meaningful latency. Redis-down short-circuits
// via the health flag at zero cost.
const GENERATION_OP_TIMEOUT_MS = 100;

export const cacheGenerationKey = (namespace, companyId) =>
  `crewly:cache:company:${String(companyId).toLowerCase()}:${namespace}:generation`;

const normalizeGeneration = (raw) => {
  const parsed = parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

export const readCacheGeneration = async (namespace, companyId, { io = null } = {}) => {
  const key = cacheGenerationKey(namespace, companyId);

  // Hermetic seam (tests inject a shared fake backend).
  if (io?.get) {
    try {
      return normalizeGeneration(await io.get(key));
    } catch {
      return null; // injected backend failure ≡ Redis down
    }
  }

  const client = getRedisClient();

  if (!client || getRedisHealth().status !== 'up') return null; // down → local TTL mode

  try {
    // getCacheRaw is fail-open + bounded; null here means the key
    // simply does not exist yet — that is generation 0, a valid state.
    return normalizeGeneration(
      await getCacheRaw(key, { opTimeoutMs: GENERATION_OP_TIMEOUT_MS }),
    );
  } catch {
    return null;
  }
};

export const bumpCacheGeneration = async (namespace, companyId, { io = null } = {}) => {
  const key = cacheGenerationKey(namespace, companyId);

  try {
    if (io?.incr) {
      const value = await io.incr(key, GENERATION_TTL_SECONDS);

      if (value === null || value === undefined) return false;

      noteCacheInvalidation();

      return true;
    }

    const value = await incrementWithTtl(key, GENERATION_TTL_SECONDS);

    if (value === null || value === undefined) {
      logger.debug(`[Cache] generation bump skipped — ${namespace} (Redis unavailable)`);

      return false;
    }

    noteCacheInvalidation();

    logger.debug(`[Cache] generation bumped — ${namespace} (generation=${value})`);

    return true;
  } catch (error) {
    // Invalidation must never break a valid business write (§12).
    logger.warn(`[Cache] generation bump failed safely — ${namespace} (${error?.code || 'error'})`);

    return false;
  }
};
