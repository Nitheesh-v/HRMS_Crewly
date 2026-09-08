// ============================================================
//  PHASE 30.11 — BGV pipeline reminder reconciliation (ops CLI)
//
//   npm run bgv:reminders:reconcile
//   npm run bgv:reminders:reconcile -- --limit=50
//
// Scans the authoritative Phase-30 collections for pending
// milestones (consent, submission, info requests, verifier SLA,
// QA) and enqueues reminder jobs via the EXISTING email-delivery
// architecture. Idempotency: deterministic per-bucket event keys
// (48h cadence; verifier daily) — re-running never spams. Jobs
// that died in Redis are re-enqueued by `npm run email:reconcile`
// (same EmailDelivery pipeline); Mongo remains the source of
// truth and no reminder state is stored anywhere else.
// ============================================================

import '../src/config/loadEnv.js'; // FIRST — before env-snapshotting imports
import mongoose from 'mongoose';
import { runBgvReminderReconciliation } from '../src/services/bgv/bgvReminderService.js';

(async () => {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;
  const report = await runBgvReminderReconciliation({ limit });
  console.log('BGV reminder reconciliation:', JSON.stringify(report, null, 2));
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
})().catch((err) => {
  console.error('BGV reminder reconciliation failed:', err?.message || err);
  process.exit(1);
});
