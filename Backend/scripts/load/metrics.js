// ═══════════════════════════════════════════════════════════════════════════
// Phase 32.13 — LOAD METRICS (pure, dependency-free)
//
// Percentiles (nearest-rank on the sorted sample), throughput, and error
// classification for the load harness. Pure functions — unit-tested in
// test/loadTooling.test.js. The runner stores the full bounded latency
// sample (runs are clamped to ≤20,000 operations; ≤20k numbers is fine)
// — documented limitation rather than a reservoir approximation.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Nearest-rank percentile: value at ceil(p/100 * N) of the sorted sample.
 * Returns null for an empty sample (never 0 — zero is a real latency).
 */
export const percentile = (sorted, p) => {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
};

/** Summarize a latency array (ms). Percentiles null when empty. */
export const latencySummary = (latencies = []) => {
  const sorted = [...latencies].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null };
  }
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    mean: Math.round((sum / n) * 10) / 10,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
};

// Error buckets — fixed taxonomy (§52). Network failures are their own
// classes so a dead target can never masquerade as "5xx".
export const ERROR_CLASSES = Object.freeze([
  'http_5xx',
  'http_4xx',
  'http_429',
  'timeout',
  'conn_refused',
  'network',
  'aborted',
  'unknown',
]);

/**
 * Classify one failed operation from a caught error / response status.
 * Returns the bucket name. Never inspects request configs — only safe
 * error shapes (name/code/message prefix) — so no header/token can leak.
 */
export const classifyFailure = (error, statusCode) => {
  if (Number.isFinite(statusCode)) {
    if (statusCode === 429) return 'http_429';
    if (statusCode >= 500) return 'http_5xx';
    if (statusCode >= 400) return 'http_4xx';
    return 'unknown';
  }
  const name = error?.name || '';
  const code = error?.code || '';
  const message = typeof error?.message === 'string' ? error.message : '';
  if (name === 'AbortError' || /aborted/i.test(message)) return 'aborted';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || /timeout/i.test(message)) return 'timeout';
  if (code === 'ECONNREFUSED') return 'conn_refused';
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ENOTFOUND' || name === 'FetchError' || name === 'TypeError') return 'network';
  return 'unknown';
};

/**
 * Bounded, integer-clamped CLI value parser. Everything that is not a
 * finite integer falls back to the default; every knob is clamped to a
 * developer-machine-safe maximum (§84 — no unbounded generation).
 */
export const clampInt = (value, fallback, min, max) => {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

/** Compact one-number rate: operations per second (2 decimals). */
export const operationsPerSecond = (operations, elapsedMs) => {
  if (!(elapsedMs > 0) || !(operations >= 0)) return 0;
  return Math.round((operations / (elapsedMs / 1000)) * 100) / 100;
};
