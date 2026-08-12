import app from './app.js';
import env from './config/env.js';
import connectDB from './config/db.js';
import logger from './config/logger.js';

const startServer = async () => {
  // 1. Connect to MongoDB first — never run the API without a database
  await connectDB();

  // 2. Start HTTP server
  const server = app.listen(env.PORT, () => {
    logger.info(`🚀 Crewly HRMS API running in ${env.NODE_ENV} mode on port ${env.PORT}`);
  });



  
  // 3. Graceful shutdown (cPanel / cloud restarts your app with these signals)
  const shutdown = (signal) => {
    logger.info(`${signal} received. Shutting down gracefully...`);
    server.close(() => {
      logger.info('HTTP server closed.');
      process.exit(0);
    });
  };
  ['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => shutdown(sig)));

  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
    process.exit(1);
  });
};

startServer();
