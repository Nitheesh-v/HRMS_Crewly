import logger from '../config/logger.js';
import { beginDrain, markStopped } from '../config/lifecycle.js';

// ============================================================
//  PHASE 32.2 — GRACEFUL SHUTDOWN SEQUENCE (API process).
//
//  RUNNING → SIGTERM/SIGINT
//    1. beginDrain()            — readiness flips 503 + drain gate active
//                                 (a load balancer stops routing here)
//    2. bounded hard-stop timer — shutdown can never hang forever
//    3. server.close()          — stop accepting NEW connections
//       closeIdleConnections()  — keep-alive sockets close (Node ≥18.2,
//                                 guarded: older/special servers skip)
//    4. owned resources close   — BullMQ producers → Redis → Mongo
//    5. markStopped() → exit(0)
//
//  Idempotent: repeated signals never double-run cleanup. In-flight
//  requests already on the socket finish or hit the bounded timer;
//  NEW requests on keep-alive sockets get 503 SHUTTING_DOWN from the
//  app-level drain gate.
//
//  Graceful ≠ exactly-once: this only makes exit clean. Business
//  correctness still rests on the Phase 28 at-least-once/idempotent
//  architecture (unchanged).
// ============================================================

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 10000;

// Strict bounded parser (names-only env; value never logged).
export const parseShutdownTimeoutMs = (source = process.env) => {
  const parsed = Math.trunc(Number(source?.GRACEFUL_SHUTDOWN_TIMEOUT_MS));

  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;

  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, parsed));
};

/**
 * Creates THE idempotent shutdown runner for this process.
 * All collaborators are injectable for hermetic tests.
 */
export const createGracefulShutdown = ({
  server,
  closeQueues,
  closeRedis,
  disconnectMongo,
  timeoutMs = parseShutdownTimeoutMs(),
  exit = (code) => process.exit(code),
  log = logger,
} = {}) => {
  let started = false;

  return async (signal = 'SIGTERM') => {
    if (started) {
      log.warn(
        `[Shutdown] ${signal} received again — shutdown already in progress.`
      );

      return;
    }

    started = true;

    log.info(`[Shutdown] ${signal} received — draining gracefully...`);

    // 1. Stop being "ready" FIRST so infrastructure stops routing
    //    new work to this instance while it drains.
    beginDrain(signal);

    // 2. Bounded last resort — never hang the process forever.
    const hardStop = setTimeout(() => {
      log.error(
        `[Shutdown] Graceful shutdown timed out after ` +
          `${timeoutMs}ms — forcing exit.`
      );

      exit(1);
    }, timeoutMs);

    hardStop.unref();

    // 3. HTTP: stop new connections, then close idle keep-alive
    //    sockets so close() is not held open by idle browsers/LBs.
    await new Promise((resolve) => {
      if (!server) return resolve();

      server.close(() => resolve());

      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
    }).catch(() => {});

    // 4. Owned resources (each safe when absent/already closed —
    //    Redis-disabled mode included).
    const safeClose = (close) =>
      Promise.resolve()
        .then(() => close?.())
        .catch(() => {});

    await safeClose(closeQueues);

    await safeClose(closeRedis);

    await safeClose(disconnectMongo);

    clearTimeout(hardStop);

    markStopped();

    log.info('[Shutdown] Connections closed. Bye.');

    exit(0);
  };
};

export default createGracefulShutdown;
