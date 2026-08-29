// ============================================================
//  PHASE 28.7 — RECRUITMENT ANALYTICS GENERATION INVALIDATION
//
// Generation-based invalidation (§27): instead of deleting every
// possible filter key, each tenant owns ONE generation counter.
//
//   crewly:cache:company:<companyId>:recruitment:analytics:generation
//
// Analytics value keys embed the generation:
//   ...:recruitment:analytics:v1:g<generation>:<filterHash>
//
// On any analytics-relevant mutation (AFTER the Mongo commit):
//   INCR generation + refresh its 24h TTL
//
// Consequences:
//   - previous-generation keys become UNREACHABLE immediately and
//     die via their own short TTL (no per-key deletion at all)
//   - no KEYS / SCAN / wildcard — only exact self-built keys
//   - Redis down during a mutation → INCR skipped, Mongo write is
//     UNAFFECTED; worst-case staleness is bounded by the analytics
//     TTL (documented edge case for 28.9)
//
// This function NEVER throws and never blocks a business write —
// call it fire-and-forget at the tail of the mutation.
// ============================================================

import logger from '../config/logger.js';
import { incrementWithTtl, noteCacheInvalidation } from './redisCacheService.js';

const GENERATION_TTL_SECONDS = 24 * 60 * 60; // refreshed on every bump

export const recruitmentAnalyticsGenerationKey = (companyId) =>
  `crewly:cache:company:${String(companyId).toLowerCase()}:recruitment:analytics:generation`;

export const bumpRecruitmentAnalyticsGeneration = async (companyId) => {
  if (!companyId || !/^[a-f0-9]{24}$/i.test(String(companyId))) return false;
  try {
    const generation = await incrementWithTtl(
      recruitmentAnalyticsGenerationKey(companyId),
      GENERATION_TTL_SECONDS
    );
    if (generation !== null) {
      noteCacheInvalidation();
      logger.debug(
        `[Cache] recruitment analytics generation bumped (generation=${generation})`
      );
      return true;
    }
    // Redis unavailable — safe: cache is down too, so no stale
    // value can be served right now; TTL bounds any later residue.
    logger.debug('[Cache] analytics generation bump skipped (Redis unavailable)');
    return false;
  } catch (error) {
    // Cache invalidation must never break a valid business write.
    logger.warn(
      `[Cache] analytics generation bump failed safely (${error?.code || 'error'})`
    );
    return false;
  }
};
