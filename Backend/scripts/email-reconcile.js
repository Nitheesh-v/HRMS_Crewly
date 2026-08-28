// ============================================================
//  PHASE 28.3 — EMAIL DELIVERY RECONCILIATION (dev/ops CLI)
//
//   npm run email:reconcile
//   npm run email:reconcile -- --all      (ignore the 60s min-age)
//
// Finds delivery intents that never reached the queue:
//   - PENDING          (created, enqueue never confirmed)
//   - FAILED_TO_QUEUE  (enqueue failed, e.g. Redis was down)
// and re-enqueues them with their ORIGINAL deterministic job id
// (email:<deliveryId>). Re-running is safe:
//   - already-QUEUED/SENT/... records are skipped
//   - BullMQ's job id dedupe prevents a second job even if one
//     already exists in the queue
//
// This is a developer/ops tool — it is NOT exposed over HTTP.
// ============================================================

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getRedisConfig } from '../src/config/redis.js';
import { reconcileStuckEmailDeliveries } from '../src/services/emailDeliveryService.js';
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
      'email:reconcile failed: Redis is not configured (REDIS_ENABLED/REDIS_URL). ' +
        'Reconciliation re-enqueues jobs, so it needs Redis.'
    );
    process.exit(1);
  }

  console.log('Email delivery reconciliation');
  console.log(`Prefix: ${getQueuePrefix()}`);
  console.log(
    includeYoung
      ? 'Mode: --all (including <60s old records)'
      : 'Mode: default (records older than 60s only)'
  );

  const summary = await reconcileStuckEmailDeliveries({
    minAgeMs: includeYoung ? 0 : 60000,
    limit: 100,
  });

  console.log(`Scanned: ${summary.scanned}, requeued: ${summary.requeued}`);
  for (const result of summary.results) {
    if (result.requeued) {
      console.log(`  ✔ delivery ${result.deliveryId} → queued`);
    } else {
      console.log(`  ✖ delivery ${result.deliveryId} → ${result.error}`);
    }
  }

  if (summary.requeued === 0) {
    console.log('No stuck deliveries found. Nothing to do.');
  }
  process.exit(0);
};

main()
  .catch((error) => {
    console.error(`email:reconcile failed: ${error?.message || 'unexpected error'}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAllQueues().catch(() => {});
    process.exit(process.exitCode || 0);
  });
