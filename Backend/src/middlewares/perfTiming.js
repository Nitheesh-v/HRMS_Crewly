// ─────────────────────────────────────────────────────────────
// Perf RCA timing instrumentation — DEVELOPMENT DIAGNOSTIC ONLY.
//
// Enabled explicitly with PERF_TIMING=true (default off). When off,
// this middleware and every markPerf() call are a single boolean
// check + immediate next() — zero behavior change, zero overhead.
//
// When on, each request logs ONE line:
//   [Perf] METHOD /redacted/path -> status totalMs=N mongoQueries=N
//   marks={"auth":12,"tenant":40,"rbac":120} collections=users.find=2,...
//
// Marks are CUMULATIVE milliseconds since request start, so the cost
// of a phase = its mark minus the previous mark; controller + service
// + serialization = totalMs minus the last middleware mark.
//
// Safety:
// - operation name + elapsed ms ONLY. Never bodies, tokens, cookies,
//   connection strings, PII, payroll figures, candidate docs, or BGV
//   evidence. Query arguments are never read — the Mongoose debug hook
//   counts (collection, method) pairs only.
// - AsyncLocalStorage attributes query counts to the correct request
//   under concurrency; the finish log uses a closure, not the store.
// ─────────────────────────────────────────────────────────────
import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';
import logger from '../config/logger.js';
import { redactRequestUrl } from './requestLogger.js';

const perfStore = new AsyncLocalStorage();
let debugInstalled = false;

// Explicit parser (house rule: never Boolean(env)).
export const parsePerfTimingEnabled = (source = process.env) =>
  String(source?.PERF_TIMING || '')
    .trim()
    .toLowerCase() === 'true';

export const isPerfTimingEnabled = () => parsePerfTimingEnabled(process.env);

const installMongooseCounter = () => {
  if (debugInstalled) return;
  debugInstalled = true;

  // Mongoose debug signature: (collection, method, query, doc, options).
  // Only the first two are read — arguments are never inspected/logged.
  mongoose.set('debug', (collectionName, method) => {
    const state = perfStore.getStore();
    if (!state) return;

    state.mongoQueries += 1;

    const key = `${collectionName}.${method}`;
    state.byCollection[key] = (state.byCollection[key] || 0) + 1;
  });
};

// Called once from app.js. No-op unless PERF_TIMING=true.
export const initPerfTiming = () => {
  if (isPerfTimingEnabled()) {
    installMongooseCounter();
    logger.info('[Perf] request timing instrumentation ENABLED (PERF_TIMING=true)');
  }
};

// Zero-cost no-op on requests that carry no perf state.
export const markPerf = (req, name) => {
  const state = req?.perf;
  if (!state) return;
  state.marks[name] = Date.now() - state.startedAt;
};

export const perfTiming = (req, res, next) => {
  if (!isPerfTimingEnabled()) return next();

  const state = {
    startedAt: Date.now(),
    marks: {},
    mongoQueries: 0,
    byCollection: {},
  };

  req.perf = state;

  res.on('finish', () => {
    const totalMs = Date.now() - state.startedAt;

    const topCollections = Object.entries(state.byCollection)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([key, count]) => `${key}=${count}`)
      .join(',');

    logger.info(
      `[Perf] ${req.method} ${redactRequestUrl(req.originalUrl || '')} -> ` +
        `${res.statusCode} totalMs=${totalMs} ` +
        `mongoQueries=${state.mongoQueries} ` +
        `marks=${JSON.stringify(state.marks)}` +
        (topCollections ? ` collections=${topCollections}` : ''),
    );
  });

  perfStore.run(state, () => next());
};

export default perfTiming;
