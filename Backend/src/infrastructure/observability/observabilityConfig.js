// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.12 — OBSERVABILITY CONFIGURATION (infrastructure/observability)
//
// Minimum configuration per law: bounds are CODE-OWNED; only the one
// genuinely deployment-dependent number (the slow-request warning
// threshold) is env-tunable. Strict explicit parsing — never
// Boolean(env), never silent garbage acceptance (§60/§72 house rules).
//
// There is deliberately NO vendor/export configuration here: no external
// observability vendor was approved or installed (§2/§78). A future
// exporter would read the bounded counters/process snapshots through a
// provider-neutral seam, not through env in this file.
// ─────────────────────────────────────────────────────────────────────────────

export const OBSERVABILITY_SLOW_REQUEST_MIN_MS = 100;
export const OBSERVABILITY_SLOW_REQUEST_MAX_MS = 60000;
export const OBSERVABILITY_SLOW_REQUEST_DEFAULT_MS = 1500;

/**
 * Strict parse for the slow-request threshold. Anything that is not a
 * finite integer inside [min, max] falls back to the default — the
 * threshold can never be disabled or set absurdly via env.
 */
export const parseSlowRequestThresholdMs = (source = process.env) => {
  const parsed = Math.trunc(Number(source?.OBSERVABILITY_SLOW_REQUEST_MS));
  if (!Number.isFinite(parsed)) return OBSERVABILITY_SLOW_REQUEST_DEFAULT_MS;
  return Math.min(
    OBSERVABILITY_SLOW_REQUEST_MAX_MS,
    Math.max(OBSERVABILITY_SLOW_REQUEST_MIN_MS, parsed),
  );
};

// Bounded status classes for counter labels — never the raw status code
// as an unbounded label; class buckets keep cardinality fixed (§47/§61).
export const statusClassOf = (statusCode) => {
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  if (statusCode >= 300) return '3xx';
  if (statusCode >= 200) return '2xx';
  return '1xx';
};

// Method label allowlist (anything else is 'OTHER' — fixed cardinality).
export const methodLabelOf = (method) =>
  ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)
    ? method
    : 'OTHER';
