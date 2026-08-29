import './config/loadEnv.js'; // FIRST — .env must load before env-snapshotting imports
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
import { closeAllQueues } from './queues/queueFactory.js';

const startServer = async () => {
  try {
    // Connect to MongoDB before accepting requests.
    await connectDB();

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

    const server = app.listen(
      env.PORT,
      () => {
        logger.info(
          `🚀 Crewly HRMS API running in ${env.NODE_ENV} mode on port ${env.PORT}`
        );
      }
    );

    // Start the daily subscription lifecycle worker.
    startSubscriptionLifecycle();

    let shuttingDown = false;

    const shutdown = (
      signal
    ) => {
      if (shuttingDown) return;
      shuttingDown = true;

      logger.info(
        `${signal} received. Shutting down gracefully...`
      );

      // Hard stop so shutdown can never hang the process.
      const hardStop = setTimeout(
        () => {
          logger.error(
            'Graceful shutdown timed out after 10s — forcing exit.'
          );
          process.exit(1);
        },
        10000
      );
      hardStop.unref();

      server.close(async () => {
        logger.info(
          'HTTP server closed.'
        );

        // Phase 28.3/28.4 — the API opens producer-side queues
        // (email + processing dispatch). Close BullMQ queues first,
        // then the shared 28.1 client. Safe when Redis is disabled.
        await closeAllQueues().catch(() => {});
        await closeRedis();

        await mongoose.disconnect().catch(() => {});
        clearTimeout(hardStop);

        logger.info(
          'Databases closed. Bye.'
        );

        process.exit(0);
      });
    };

    [
      'SIGTERM',
      'SIGINT',
    ].forEach((signal) => {
      process.on(
        signal,
        () =>
          shutdown(signal)
      );
    });

    process.on(
      'unhandledRejection',
      (reason) => {
        logger.error(
          `Unhandled Rejection: ${reason}`
        );

        server.close(() => {
          process.exit(1);
        });
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