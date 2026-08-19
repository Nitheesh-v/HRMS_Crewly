import app from './app.js';
import env from './config/env.js';
import connectDB from './config/db.js';
import logger from './config/logger.js';
import {
  startSubscriptionLifecycle,
} from './utils/subscriptionLifecycle.js';
import {
  ensureDefaultPlans,
} from './utils/platformPlans.js';

const startServer = async () => {
  try {
    // Connect to MongoDB before accepting requests.
    await connectDB();

    // Seed and run one-time migrations for centralized plans.
    await ensureDefaultPlans();

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

    const shutdown = (
      signal
    ) => {
      logger.info(
        `${signal} received. Shutting down gracefully...`
      );

      server.close(() => {
        logger.info(
          'HTTP server closed.'
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