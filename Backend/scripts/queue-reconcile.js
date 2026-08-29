// ============================================================
//  PHASE 28.6 — DOCUMENT + BGV QUEUE RECONCILIATION (dev/ops CLI)
//
//   npm run queue:reconcile
//
// Re-derives the 28.6 execution jobs from Mongo intent (the queue
// is transport only):
//   - DOCUMENTS: versions PENDING / expired LEASE → processing job
//     (90-day window).
//   - BGV: open cases without a provider submission → case
//     processing job; cases mid-poll with an overdue nextPollAt →
//     the next delayed poll job (60-day window).
//
// Reminder families live in `npm run scheduled:reconcile` (same
// SCHEDULED queue) — this command intentionally does NOT touch
// them, keeping each reconcile command scoped to its queues.
//
// Re-running is safe:
//   - job ids are deterministic (document version / case + attempt)
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
import { runDocumentReconcile } from '../src/services/documentProcessingDispatcher.js';
import { runBgvReconcile } from '../src/services/bgvQueueDispatcher.js';

const main = async () => {
  const config = getRedisConfig();
  if (!config.enabled || !config.hasUrl) {
    console.error(
      'queue:reconcile failed: Redis is not configured (REDIS_ENABLED/REDIS_URL). ' +
        'Reconciliation re-enqueues jobs, so it needs Redis.'
    );
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error('queue:reconcile failed: MONGO_URI is not set in .env.');
    process.exit(1);
  }

  console.log('Document + BGV queue reconciliation (28.6)');
  console.log(`Prefix: ${getQueuePrefix()}`);
  console.log('Windows: documents 90 days, BGV cases 60 days');

  // Standalone script: opens its own MongoDB connection.
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
  });

  const [documents, bgv] = await Promise.all([
    runDocumentReconcile(),
    runBgvReconcile(),
  ]);

  console.log(
    `Documents: checked=${documents.checked}, queued=${documents.scheduled}, ` +
      `skipped=${documents.skipped}, errors=${documents.errors}`
  );
  console.log(
    `BGV: cases checked=${bgv.checked}, queued=${bgv.queued}, ` +
      `polls scheduled=${bgv.pollsScheduled}, skipped=${bgv.skipped}, errors=${bgv.errors}`
  );
  if (documents.checked === 0 && bgv.checked === 0) {
    console.log('No pending 28.6 work found. Nothing to do.');
  }
  process.exit(0);
};

main()
  .catch((error) => {
    console.error(`queue:reconcile failed: ${error?.message || 'unexpected error'}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAllQueues().catch(() => {});
    await mongoose.connection.close().catch(() => {});
    process.exit(process.exitCode || 0);
  });
