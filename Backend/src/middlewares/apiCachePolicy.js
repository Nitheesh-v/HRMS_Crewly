// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.16 — API CACHE-POLICY DEFAULT (deny shared caching by default)
//
// Every /api/* response gets `Cache-Control: private, no-store, max-age=0`
// unless the route/controller explicitly sets its own header AFTER this
// middleware (Express headers are last-write-wins at send time, and this
// middleware is mounted before the router — so explicit wins).
//
// Why: until 32.16, payslip PDFs, payroll exports, analytics/timesheet CSVs,
// audit exports, F&F documents, kiosk API responses and public-careers JSON
// carried NO cache directive at all. Absence of Cache-Control is not a safe
// contract — a misconfigured shared cache may store/reuse them. The default
// makes Crewly's real posture explicit instead of implicit.
//
// Already-explicit controllers (BGV, offer, pre-onboarding, document,
// expense, candidate inbox, SSE realtime) are untouched: they overwrite the
// default with the identical or equally private value.
// ═══════════════════════════════════════════════════════════════════════════
import { API_CACHE_POLICY_DEFAULT } from '../config/staticDeliveryPolicy.js';

export const apiCachePolicyMiddleware = (req, res, next) => {
  // Runs before the router; headersSent guard is pure defense.
  if (!res.headersSent && !res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', API_CACHE_POLICY_DEFAULT);
  }
  next();
};

export default apiCachePolicyMiddleware;
