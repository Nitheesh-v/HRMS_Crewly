// ============================================================
//  PHASE 28.5 — SCHEDULED JOB RECONCILIATION (dev/ops CLI)
//
//   npm run scheduled:reconcile
//
// Re-derives every pending scheduled job from the Mongo scheduling
// INTENT (the queue is transport only):
//   - Interviews: SCHEDULED/RESCHEDULED, start within the next
//     14 days, reminderDispatch PENDING/FAILED (stale CLAIMED is
//     re-claimed by the worker's 10-minute window).
//   - Offers: SENT/VIEWED, expiry within the next 90 days →
//     reminder job (when the offset window is open) + expiry job.
//
// Re-running is safe:
//   - job ids are deterministic (entity id + canonical timestamp)
//   - BullMQ's job id dedupe keeps a single live job
//   - slot prep clears dead FAILED jobs under the same id
//
// This is a developer/ops tool — it is NOT exposed over HTTP.
// ============================================================

import '../src/config/loadEnv.js'; // FIRST — before env-snapshotting imports
import mongoose from 'mongoose';
import { getRedisConfig } from '../src/config/redis.js';
import { getQueuePrefix } from '../src/config/queueConfig.js';
import { closeAllQueues } from '../src/queues/queueFactory.js';
import { runScheduledReconcile } from '../src/services/scheduledJobScheduler.js';

const main = async () => {
  const config = getRedisConfig();
  if (!config.enabled || !config.hasUrl) {
    console.error(
      'scheduled:reconcile failed: Redis is not configured (REDIS_ENABLED/REDIS_URL). ' +
        'Reconciliation re-enqueues jobs, so it needs Redis.'
    );
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error('scheduled:reconcile failed: MONGO_URI is not set in .env.');
    process.exit(1);
  }

  console.log('Scheduled job reconciliation');
  console.log(`Prefix: ${getQueuePrefix()}`);
  console.log('Windows: interviews next 14 days, offers next 90 days');

  // Standalone script: opens its own MongoDB connection.
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
  });

  const summary = await runScheduledReconcile();

  console.log(
    `Interviews: checked=${summary.interviews.checked}, ` +
      `queued=${summary.interviews.scheduled}, skipped=${summary.interviews.skipped}, ` +
      `errors=${summary.interviews.errors}`
  );
  console.log(
    `Offers: checked=${summary.offers.checked}, ` +
      `reminders=${summary.offers.reminders}, expiries=${summary.offers.expiries}, ` +
      `errors=${summary.offers.errors}`
  );
  if (
    summary.interviews.checked === 0 &&
    summary.offers.checked === 0
  ) {
    console.log('No pending scheduled work found. Nothing to do.');
  }
  process.exit(0);
};

main()
  .catch((error) => {
    console.error(`scheduled:reconcile failed: ${error?.message || 'unexpected error'}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAllQueues().catch(() => {});
    await mongoose.connection.close().catch(() => {});
    process.exit(process.exitCode || 0);
  });
