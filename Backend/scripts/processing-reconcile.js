// ============================================================
//  PHASE 28.4 — PROCESSING RECONCILIATION (dev/ops CLI)
//
//   npm run processing:reconcile
//   npm run processing:reconcile -- --all   (ignore the 60s min-age)
//
// Re-derives stuck processing intents straight from MongoDB (the
// source of truth) and re-enqueues them on the resume/ats queues:
//   - resumes: PENDING/RETRY_PENDING (incl. legacy statuses and
//     lease-expired PROCESSING normalized in the same pass),
//     attempts still below the cap
//   - ATS: COMPLETED parse with no ATSResult yet, or an ATSResult
//     with recalculationPending=true (manual recalculate)
// Re-running is safe (idempotent):
//   - deterministic job ids rebuilt from Mongo state (no stored
//     job id needed)
//   - dead FAILED jobs are cleared from their slot first; live
//     jobs are deduped by BullMQ and left untouched
//   - the 60s min-age (--all to override) skips healthy in-flight
//     jobs the API just enqueued
//
// This is a developer/ops tool — it is NOT exposed over HTTP.
// ============================================================

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getRedisConfig } from '../src/config/redis.js';
import {
  recoverPendingResumeProcessing,
} from '../src/services/resumeProcessingDispatcher.js';
import { recoverPendingATSMatching } from '../src/services/atsDispatcher.js';
import { closeAllQueues } from '../src/queues/queueFactory.js';
import { getQueuePrefix } from '../src/config/queueConfig.js';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: resolve(backendDir, '.env') });

const args = process.argv.slice(2);
const includeYoung = args.includes('--all');

const main = async () => {
  const config = getRedisConfig();
  if (!config.enabled || !config.hasUrl) {
    console.error(
      'processing:reconcile failed: Redis is not configured (REDIS_ENABLED/REDIS_URL). ' +
        'Reconciliation re-enqueues jobs, so it needs Redis.'
    );
    process.exit(1);
  }

  console.log('Processing reconciliation (resume + ATS)');
  console.log(`Prefix: ${getQueuePrefix()}`);
  console.log(
    includeYoung
      ? 'Mode: --all (including <60s old records)'
      : 'Mode: default (records older than 60s only)'
  );

  // This script is standalone: it must open its own MongoDB
  // connection (the API process's connection does not exist here).
  if (!process.env.MONGO_URI) {
    console.error('processing:reconcile failed: MONGO_URI is not set in .env.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
  });

  const [resumeSummary, atsSummary] = await Promise.all([
    recoverPendingResumeProcessing({ minAgeMs: includeYoung ? 0 : 60000 }),
    recoverPendingATSMatching(),
  ]);

  console.log(
    `Resume: pending=${resumeSummary.pending}, queued=${resumeSummary.queued}, skipped=${resumeSummary.skipped}`
  );
  console.log(
    `ATS: pending=${atsSummary.pending}, queued=${atsSummary.queued}, skipped=${atsSummary.skipped}`
  );

  if (resumeSummary.queued === 0 && atsSummary.queued === 0) {
    console.log('No stuck processing found. Nothing to do.');
  }
  process.exit(0);
};

main()
  .catch((error) => {
    console.error(`processing:reconcile failed: ${error?.message || 'unexpected error'}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAllQueues().catch(() => {});
    await mongoose.connection.close().catch(() => {});
    process.exit(process.exitCode || 0);
  });
