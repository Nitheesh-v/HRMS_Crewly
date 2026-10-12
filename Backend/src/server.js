import './config/loadEnv.js'; // FIRST — .env must load before env-snapshotting imports
import http from 'node:http';
import mongoose from 'mongoose';
import app from './app.js';
import env from './config/env.js';
import connectDB from './config/db.js';
import logger from './config/logger.js';
import {
  initializeRedis,
  closeRedis,
} from './config/redis.js';
import {
  startSubscriptionLifecycle,
} from './utils/subscriptionLifecycle.js';
import {
  ensureDefaultPlans,
} from './utils/platformPlans.js';
import {
  ensureCareerPortalIdentifiers,
} from './utils/careerPortalIdentifiers.js';
import {
  ensureCandidateIdentifiers,
} from './utils/candidateIdentifiers.js';
import {
  ensureCandidatePipelineStages,
} from './utils/candidatePipelineMigration.js';
import {
  ensurePermissions,
  getSystemPermissionVersion,
} from './utils/permissionService.js';
import {
  markReady,
  beginDrain,
} from './config/lifecycle.js';
import {
  createGracefulShutdown,
} from './utils/gracefulShutdown.js';
import { closeAllQueues } from './queues/queueFactory.js';
import {
  getRealtimeGateway,
} from './infrastructure/realtime/realtimeGateway.js';
import {
  getChatSocketServer,
} from './socket/initSocketServer.js';
import { parsePresenceSocketEnabled } from './socket/presenceSocketConfig.js';
import {
  startProcessDiagnostics,
  stopProcessDiagnostics,
  getInstanceId,
} from './infrastructure/observability/processDiagnostics.js';
import { initAIProvider } from './services/ai/aiProvider.js';

const startServer = async () => {
  let presenceSocketServer = null;
  try {
    // Connect to MongoDB before accepting requests.
    await connectDB();

    // RBAC bootstrap (fresh-database fix): guarantee the system Permission
    // catalogue exists BEFORE any traffic is accepted. Without this, the
    // first guarded request on an empty database 403s at the permission
    // middleware ("Permission X is not registered.") before the lazy
    // in-request bootstrap can ever run — a bootstrap deadlock where the
    // code that would grant authority runs only after the check that
    // requires it. Idempotent $setOnInsert upserts; concurrent API
    // instances converge safely (duplicate-key upserts are a no-op win).
    // A dropped/recreated database requires an API restart so this (and
    // every other startup ensure + process cache) re-runs against it.
    const permissionCount = (await ensurePermissions()).length;

    logger.info(
      `🛡️ System permission catalogue verified: ${permissionCount} permissions (v${getSystemPermissionVersion()})`
    );

    // Phase 28.1 — optional Redis infrastructure. Never throws at the
    // API: unavailability degrades to a safe "down" state with bounded
    // background reconnect (no business workflow depends on Redis yet).
    await initializeRedis();

    // Seed and run one-time migrations for centralized plans.
    await ensureDefaultPlans();

    // Phase 27.4 public identifiers and safe publication defaults.
    await ensureCareerPortalIdentifiers();

    // Phase 27.5 candidate identifiers and compatible legacy defaults.
    await ensureCandidateIdentifiers();

    // Phase 27.8 normalizes the canonical pipeline stage without losing legacy data.
    await ensureCandidatePipelineStages();

    // Phase 28.4: processing recovery (resume leases + missing ATS
    // results) now runs in the WORKER process at startup, and on
    // demand via `npm run processing:reconcile`. The API only
    // enqueues; Mongo holds the durable intent.

    // Phase 36.1 - AI provider foundation (default OFF via AI_ENABLED).
    //
    // FAIL-FAST BY DESIGN: AI_ENABLED=true without AI_API_KEY is a
    // misconfigured deployment, and booting an API that will 503 every
    // /api/ai/chat call is worse than refusing to start. The existing
    // try/catch below logs the message (the KEY name only - AIError never
    // carries a value) and exits 1. With the suite switched off this is a
    // silent, cheap no-op.
    initAIProvider();

    const server = http.createServer(app);

    // Phase 33.1 — chat Socket.IO foundation (default OFF via
    // CHAT_SOCKET_ENABLED). ATTACH ORDER IS A LAW, NOT STYLE: Engine.IO
    // builds its WebSocket engine on the HTTP server's 'listening' event,
    // so attaching after listen() would leave the ws transport silently
    // dead while polling appeared to work. Engine.IO caches and restores
    // Express's request listener, so all existing middleware and Phase-32
    // behaviour (drain gate, default-deny Cache-Control, helmet/CORS) is
    // preserved. Refuses every connection as FEATURE_UNAVAILABLE when
    // Redis is disabled/unreachable — the HTTP API is never affected.
    await getChatSocketServer().attach(server);

    // Phase 37 — presence Socket.IO namespace (opt-in). Attach before
    // listen, sharing chat's Socket.IO engine when chat is enabled. If
    // Redis or its adapter is unavailable, the optional namespace refuses
    // socket connections as FEATURE_UNAVAILABLE; the HTTP API still boots.
    if (parsePresenceSocketEnabled()) {
      try {
        const { getPresenceSocketServer } = await import('./socket/presenceSocket.js');
        presenceSocketServer = getPresenceSocketServer();
        const result = await presenceSocketServer.attach(server, {
          sharedIo: getChatSocketServer().getIo(),
        });
        if (result.pending) {
          logger.warn(
            `[PresenceSocket] namespace mounted with adapter pending (${result.reason || 'FEATURE_UNAVAILABLE'}); socket admission is closed until recovery, REST remains available.`,
          );
        } else if (!result.started) {
          logger.warn(
            `[PresenceSocket] not started (${result.reason || 'FEATURE_UNAVAILABLE'}); REST remains available.`,
          );
        }
      } catch (error) {
        logger.error(
          `[PresenceSocket] optional startup failed (${error?.code || error?.name || 'error'}); REST remains available.`,
        );
        try {
          await presenceSocketServer?.stop();
        } catch {
          /* optional realtime cleanup */
        }
        presenceSocketServer = null;
      }
    }

    server.listen(
      env.PORT,
      () => {
        // Phase 32.2 — startup complete: this instance now reports
        // READY to /api/health/ready (infrastructure may route traffic).
        markReady();

        logger.info(
          `🚀 Crewly HRMS API running in ${env.NODE_ENV} mode on port ${env.PORT} (${getInstanceId()})`
        );
      }
    );

    // Start the daily subscription lifecycle worker.
    startSubscriptionLifecycle();

    // Phase 32.11 — realtime infrastructure foundation (default OFF).
    // Starts only when REALTIME_ENABLED=true; otherwise a logged no-op.
    // Integrated topology: realtime rides this API process and scales
    // with it (multi-instance fan-out is shared Redis pub/sub).
    await getRealtimeGateway().start();

    // Phase 32.12 — coarse process diagnostics sampler (unref'd,
    // explicit lifecycle; never holds the process open).
    startProcessDiagnostics();

    // Phase 32.2 — graceful lifecycle: drain first (readiness 503 +
    // app-level gate), bounded close of HTTP + owned resources.
    // Idempotent across repeated signals; SIGINT (local Ctrl+C) uses
    // the identical safe path.
    const shutdown = createGracefulShutdown({
      server,

      closeQueues: closeAllQueues,

      closeRedis,

      disconnectMongo: () => mongoose.disconnect(),
    });

    // 32.11 drain composition: flip readiness FIRST (idempotent 32.2
    // transition), then end realtime streams + close the gateway's
    // pub/sub connections so server.close() is never held open by SSE
    // responses — then the standard bounded 32.2 shutdown runs unchanged.
    // 33.1: chat sockets drain on the same path. Its stop() deliberately
    // never calls io.close() (that would close the shared HTTP server and
    // kill in-flight requests), so 32.2's bounded HTTP close stays the
    // single owner of the listener.
    const shutdownWithRealtime = (signal) => {
      beginDrain(`realtime-drain:${signal}`);
      Promise.resolve()
        .then(async () => {
          stopProcessDiagnostics();
          // Drain the namespace before its shared chat Engine.IO owner.
          // Keep later shutdown steps running even if an optional realtime
          // cleanup encounters an error.
          try {
            await presenceSocketServer?.stop();
          } catch {
            /* best-effort optional realtime cleanup */
          }
          try {
            await getChatSocketServer().stop();
          } catch {
            /* continue draining the remaining services */
          }
          try {
            await getRealtimeGateway().stop();
          } catch {
            /* continue to HTTP shutdown */
          }
        })
        .finally(() => shutdown(signal));
    };

    [
      'SIGTERM',
      'SIGINT',
    ].forEach((signal) => {
      process.on(signal, () => shutdownWithRealtime(signal));
    });

    process.on(
      'unhandledRejection',
      (reason) => {
        logger.error(
          `Unhandled Rejection: ${reason}`
        );

        // Use the same realtime-aware drain as a signal so the optional
        // presence namespace is closed before the HTTP listener (exit code 1).
        shutdownWithRealtime('unhandledRejection');
      }
    );
  } catch (error) {
    logger.error(
      `Server startup failed: ${error.message}`
    );

    process.exit(1);
  }
};

startServer();