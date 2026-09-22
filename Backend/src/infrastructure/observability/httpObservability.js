// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.12 — HTTP OBSERVABILITY (§25/§26/§64)
//
// ONE structured completion event per request (replaces morgan):
//   info  http.request.complete { requestId, method, route, status,
//                                 durationMs, bytes, userId?, companyId? }
//   warn  http.request.slow     (same safe fields, threshold-bounded)
//
// Safe fields ONLY: normalized route template (never raw token URLs),
// status CLASS for counters, monotonic duration, response byte count,
// server-derived safe identity ids when already attached by auth. NEVER:
// request/response bodies, query strings, authorization headers, GPS,
// salary/private content (§12–§14/§18–§22).
//
// Overhead law (§92): one randomUUID per request, one Date.now-free
// monotonic duration (perf_hooks), one counter increment, one log line.
// No DB write, no Redis write, no body serialization.
// ─────────────────────────────────────────────────────────────────────────────
import { performance } from 'node:perf_hooks';
import logger from '../../config/logger.js';
import { parseSlowRequestThresholdMs, statusClassOf, methodLabelOf } from './observabilityConfig.js';
import { routeTemplateOf } from './redaction.js';
import { getMetricsRegistry } from './metricsRegistry.js';

const metrics = () => getMetricsRegistry();

const safeIdentity = (req) => {
  const meta = {};
  // Server-derived AFTER auth only; never client-supplied; ids are
  // internal opaque values already used across safe operational logs.
  const userId = req.user?._id || req.user?.id;
  if (userId) meta.userId = String(userId);
  if (req.companyId) meta.companyId = String(req.companyId);
  return meta;
};

/**
 * Express middleware: attach monotonic start, emit the completion event
 * and bounded counters on 'finish'. Idempotent-safe (guard against
 * accidental double mount).
 */
export const httpObservabilityMiddleware = (req, res, next) => {
  if (req.httpObservabilityDone) return next();
  req.httpObservabilityDone = true;

  const startedNs = performance.now();
  const slowThresholdMs = parseSlowRequestThresholdMs();

  res.on('finish', () => {
    try {
      const durationMs = Math.round((performance.now() - startedNs) * 10) / 10;
      const route = routeTemplateOf(req);
      const status = res.statusCode;
      const bytes = Number(res.getHeader('Content-Length')) || undefined;
      const method = methodLabelOf(req.method);

      const meta = {
        requestId: req.id,
        method,
        route,
        status,
        durationMs,
        ...(bytes !== undefined ? { bytes } : {}),
        ...safeIdentity(req),
      };

      metrics().increment('http.requests', {
        method,
        statusClass: statusClassOf(status),
        route,
      });

      if (status >= 500) {
        metrics().increment('http.errors_5xx', { route });
      }

      logger.info('http.request.complete', meta);

      if (durationMs > slowThresholdMs) {
        metrics().increment('http.slow_requests', { route });
        logger.warn('http.request.slow', {
          requestId: req.id,
          method,
          route,
          status,
          durationMs,
          thresholdMs: slowThresholdMs,
        });
      }
    } catch {
      /* observability must never break the response path */
    }
  });

  next();
};

export default httpObservabilityMiddleware;
