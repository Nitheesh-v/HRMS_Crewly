// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.12 — BOUNDED METRICS REGISTRY (§47/§48/§61/§74)
//
// Process-local aggregate counters ONLY. In a multi-instance deployment
// these are per-process truth — NEVER claimed as global aggregates
// (documented limitation; a future vendor-neutral exporter would be the
// aggregation boundary). Low-cardinality labels are enforced by
// allowlist: an unknown metric or an unexpected label KEY is refused;
// label VALUES are bounded and bucketed by the caller (status classes,
// route templates, method allowlist). A series cap prevents a
// pathological route explosion from growing memory unbounded.
// ─────────────────────────────────────────────────────────────────────────────

// Metric → allowed label keys. Fixed set; fixed cardinality per metric
// (methods ≤8, status classes 5, route templates = route count).
const METRIC_LABEL_ALLOWLIST = Object.freeze({
  'http.requests': Object.freeze(['method', 'statusClass', 'route']),
  'http.slow_requests': Object.freeze(['route']),
  'http.errors_5xx': Object.freeze(['route']),
  'realtime.events_published': Object.freeze(['kind']),
  'realtime.connections_refused': Object.freeze(['reason']),
  'rate_limit.degraded_transitions': Object.freeze([]),
  'cache.errors': Object.freeze(['op']),
});

const MAX_SERIES_PER_METRIC = 300;

export const createMetricsRegistry = () => {
  const series = new Map(); // metric -> Map(labelKey -> count)
  let overflowDropped = 0;

  const labelKeyOf = (labels) =>
    Object.keys(labels || {})
      .sort()
      .map((key) => `${key}=${String(labels[key]).slice(0, 80)}`)
      .join('|') || '_';

  return {
    /** Increment a counter; unknown metric/label keys are refused (fail closed). */
    increment(metric, labels = {}) {
      const allowed = METRIC_LABEL_ALLOWLIST[metric];
      if (!allowed) return false;

      const providedKeys = Object.keys(labels);
      if (providedKeys.some((key) => !allowed.includes(key))) return false;

      let bucket = series.get(metric);
      if (!bucket) {
        bucket = new Map();
        series.set(metric, bucket);
      }

      const key = labelKeyOf(labels);
      if (!bucket.has(key) && bucket.size >= MAX_SERIES_PER_METRIC) {
        overflowDropped += 1;
        return false; // bounded memory law: drop rather than grow forever
      }
      bucket.set(key, (bucket.get(key) || 0) + 1);
      return true;
    },

    /**
     * Bounded snapshot for the protected diagnostics surface:
     * { metric: [ { labels, count }, … ] } — label strings are already
     * low-cardinality buckets; nothing here is a raw URL/user/token.
     */
    snapshot() {
      const out = {};
      for (const [metric, bucket] of series.entries()) {
        out[metric] = [...bucket.entries()].map(([labelKey, count]) => {
          const labels = {};
          if (labelKey !== '_') {
            for (const pair of labelKey.split('|')) {
              const eq = pair.indexOf('=');
              labels[pair.slice(0, eq)] = pair.slice(eq + 1);
            }
          }
          return { labels, count };
        });
      }
      if (overflowDropped > 0) out._overflowDropped = overflowDropped;
      return out;
    },

    /** Test/ops seam — resets all counters (never used in production flow). */
    reset() {
      series.clear();
      overflowDropped = 0;
    },
  };
};

// Process singleton (lazy — no import-time side effects).
let singleton = null;
export const getMetricsRegistry = () => {
  if (!singleton) singleton = createMetricsRegistry();
  return singleton;
};
