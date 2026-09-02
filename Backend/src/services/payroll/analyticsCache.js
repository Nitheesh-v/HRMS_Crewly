// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 29.12 — PAYROLL ANALYTICS CACHE KEYS (§21)
//
//  The brief writes the concept as `payroll:analytics:{companyId}:{month}`.
//  Crewly's one key factory (Phase 28.7) already produces exactly that shape
//  plus the tenant prefix and a version, so it is reused — the same call
//  29.5–29.11 made.
//
//  MongoDB remains the source of truth; this is a fail-open read. A dead Redis
//  must never stop a CFO from opening the payroll dashboard.
// ═══════════════════════════════════════════════════════════════════════════
import { createHash } from 'node:crypto';

import { buildTenantCacheKey, deleteCache, noteCacheInvalidation } from '../redisCacheService.js';

export const ANALYTICS_CACHE_NAMESPACE = 'payroll-analytics';
export const ANALYTICS_CACHE_VERSION = 1;

// One suffix per cached read (§21): the executive dashboard, the department
// summary, the trend series and the headcount metrics.
export const ANALYTICS_CACHE_SUFFIXES = ['dashboard', 'department', 'trend', 'headcount'];

/**
 * §18 — a filtered read is a different read.
 *
 * Without this segment the unfiltered dashboard and a department-filtered one
 * share a key, so whichever ran last would be served to both. The segment is
 * readable on purpose: a human debugging Redis should be able to tell which
 * slice of the company a key covers.
 */
/**
 * A cache segment has to survive `safeSegment`, which rejects anything over
 * 64 characters *and* anything outside [A-Za-z0-9_-:.]. A filter value is
 * whatever the caller sent — an employee name, a search string, an ObjectId —
 * so it is sanitised first, then hashed when it would be too long to read.
 *
 * The old version joined filters as `key=value|key=value`. That is two
 * characters `safeSegment` rejects, so EVERY filtered read built a null key
 * and silently bypassed the cache — no error, no log, just no caching.
 */
const digest = (text) => createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
const readable = (text) => String(text ?? '').replace(/[^A-Za-z0-9_\-:.]/g, '.');

const SEGMENT_LIMIT = 48;

const segment = (text) => {
  const value = readable(text);
  if (!value) return '-';
  return value.length > SEGMENT_LIMIT ? `h${digest(value)}` : value;
};

export const filterSegmentOf = (filters = null) => {
  if (!filters || typeof filters !== 'object') return '-';
  const parts = Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => `${readable(key)}-${readable(value)}`)
    .sort();
  return segment(parts.join('_'));
};

/**
 * §25 — WHOM the answer was built for is part of the answer.
 *
 * A manager scoped to twelve employees and a company admin ask for the same
 * month and get different numbers; both must not share a cache entry, or
 * whichever called first serves the other. The ids themselves are hashed —
 * they are only needed to tell one scope from another.
 */
export const scopeSegmentOf = (allowedEmployeeIds = null) => {
  if (!Array.isArray(allowedEmployeeIds) || !allowedEmployeeIds.length) return '-';
  return `s${digest(allowedEmployeeIds.map(String).sort().join(','))}`;
};

export const analyticsCacheKey = (
  companyId,
  month = '',
  suffix = 'dashboard',
  period = '',
  filters = null,
  scope = null,
) =>
  buildTenantCacheKey({
    companyId,
    namespace: ANALYTICS_CACHE_NAMESPACE,
    version: ANALYTICS_CACHE_VERSION,
    segments: [month || 'all', suffix, period || '-', filterSegmentOf(filters), scopeSegmentOf(scope)],
  });

/**
 * §21 — invalidate after payroll completion, a final settlement, a payroll
 * recalculation or a statutory update.
 *
 * Analytics reads across months (a trend is twelve of them), so a change to
 * one month must drop the cross-month keys too — hence the `''` entry beside
 * the specific month.
 */
export const invalidateAnalyticsCache = async (companyId, month = '') => {
  if (!companyId) return 0;

  const keys = new Set();
  ANALYTICS_CACHE_SUFFIXES.forEach((suffix) => {
    keys.add(analyticsCacheKey(companyId, month, suffix));
    keys.add(analyticsCacheKey(companyId, '', suffix));
  });

  let removed = 0;
  for (const key of keys) {
    if (!key) continue;
    const gone = await deleteCache(key).catch(() => false);
    if (gone) {
      removed += 1;
      noteCacheInvalidation();
    }
  }
  return removed;
};

export default { analyticsCacheKey, invalidateAnalyticsCache, filterSegmentOf };
