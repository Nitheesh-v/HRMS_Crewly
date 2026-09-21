// ============================================================
// 🧭 PHASE 28.9 — MASTER RECONCILIATION COORDINATOR
//
// One bounded entry point that drives the EXISTING domain
// reconcilers (28.3–28.6). It never re-implements reconciliation
// logic — it only validates, orders, bounds, and aggregates.
//
//   reconcileBackgroundWork({ domains, limit, dryRun, actor })
//
//   - domains: subset of the 6 ops areas (or ['all'])
//   - limit:   clamped 1–100 PER DOMAIN on the backend
//   - dryRun:  true → preview counts only (no mutation)
//   - per-domain failures are isolated (one Mongo blip does not
//     stop the remaining domains) and reported safely.
//   - audit: one RECONCILIATION_TRIGGERED entry per domain via
//     the existing runReconcile (no extra audit spam).
//
// Recovery runbook use: after a Redis outage, restore Redis,
// start workers, then `dryRun` → `run all` (bounded).
// ============================================================

import {
  RECONCILE_AREAS,
  RECONCILE_MAX_LIMIT,
  getReconcilePreview,
  runReconcile,
  OpsError,
} from './opsQueueService.js';

const clampInt = (value, fallback, min, max) => {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const normalizeDomains = (domains) => {
  if (domains === 'all' || domains === undefined || domains === null) {
    return Object.keys(RECONCILE_AREAS);
  }
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new OpsError(400, 'domains must be a non-empty array (or "all")');
  }
  const seen = new Set();
  for (const domain of domains) {
    if (!RECONCILE_AREAS[domain]) {
      throw new OpsError(400, `Unknown reconciliation domain: ${String(domain)}`);
    }
    seen.add(domain);
  }
  return [...seen];
};

/**
 * Run (or preview) the master reconciliation.
 *
 * @returns {Promise<{dryRun:boolean, limit:number,
 *   domains: Array<{area,label,checked?,requeued?,skipped?,failed?,error?,
 *   eligible?,estimate?,capped?,unavailable?}>}>}
 */
export const reconcileBackgroundWork = async (
  { domains, limit, dryRun = false, actor = {} } = {},
  deps = {}
) => {
  const areaList = normalizeDomains(domains);
  const l = clampInt(limit, 25, 1, RECONCILE_MAX_LIMIT);

  // --- PREVIEW (dryRun): counts only, no mutation --------------
  if (dryRun) {
    const preview = await getReconcilePreview(deps);
    return {
      dryRun: true,
      limit: l,
      domains: preview.areas.filter((area) => areaList.includes(area.area)),
    };
  }

  // --- RUN: sequential, per-domain error isolation -------------
  const results = [];
  for (const area of areaList) {
    try {
      const result = await runReconcile({ area, limit: l, actor }, deps);
      results.push({ area, ...result });
    } catch (error) {
      if (error instanceof OpsError && error.status === 400) {
        throw error; // invalid input — fail the whole call
      }
      results.push({
        area,
        label: RECONCILE_AREAS[area].label,
        checked: 0,
        requeued: 0,
        skipped: 0,
        failed: 0,
        error: 'This domain could not be reconciled — run it again separately',
      });
    }
  }

  return {
    dryRun: false,
    limit: l,
    domains: results,
    ok: results.every((r) => !r.error),
  };
};
