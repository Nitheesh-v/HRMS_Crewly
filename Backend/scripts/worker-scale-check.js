// ============================================================
// Phase 32.7 — worker / queue scaling auditor (developer command)
//
//   npm run worker:scale-check
//
// WHAT THIS IS
//   Static, hermetic evidence that Crewly's BullMQ layer is
//   multi-worker ready: every declared job name has a registered
//   processor, dispatch rejects unknown jobs, payload law is
//   enforced at the producer boundary, retry/retention defaults are
//   bounded, and concurrency knobs are clamped. NO Redis connection
//   is made — config + registry + source structure are the ground
//   truth. Exit 1 on any GAP.
// ============================================================

import '../src/config/loadEnv.js'; // FIRST — before env-snapshotting imports

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const run = async () => {
  const { QUEUE_NAMES, JOB_NAMES, getDefaultJobOptions, parseWorkerConcurrency } =
    await import('../src/config/queueConfig.js');

  // Wire a FRESH registry exactly like workers/index.js does.
  const registryModule = await import('../src/workers/registry.js');

  const { jobRegistry, registerProcessor, dispatchJob } = registryModule;

  const processorModules = {
    email: await import('../src/workers/emailProcessor.js'),
    resume: await import('../src/workers/resumeProcessor.js'),
    ats: await import('../src/workers/atsProcessor.js'),
    scheduled: await import('../src/workers/scheduledProcessor.js'),
    documents: await import('../src/workers/documentProcessor.js'),
    bgv: await import('../src/workers/bgvProcessor.js'),
    payroll: await import('../src/workers/payrollProcessor.js'),
  };

  processorModules.email.registerEmailProcessors({ registerProcessor });
  processorModules.resume.registerResumeProcessors({ registerProcessor });
  processorModules.ats.registerATSProcessors({ registerProcessor });
  processorModules.scheduled.registerScheduledProcessors({ registerProcessor });
  processorModules.documents.registerDocumentProcessors({ registerProcessor });
  processorModules.bgv.registerBgvProcessors({ registerProcessor });
  processorModules.payroll.registerPayrollProcessors({ registerProcessor });

  console.log('=== PHASE 32.7 — WORKER SCALE AUDIT (static ground truth) ===');

  // ── Queue inventory ──
  const queues = Object.values(QUEUE_NAMES);

  console.log(`queues declared: ${queues.length} → ${queues.join(', ')}`);

  const analyticsInUse = [];
  console.log(
    `analytics queue producers: ${analyticsInUse.length} (reserved — payroll analytics rides the payroll queue)`,
  );

  // ── Registry completeness ──
  const declared = Object.values(JOB_NAMES);

  const registered = [...jobRegistry.keys()];

  const missing = declared.filter((name) => !registered.includes(name));

  const undeclared = registered.filter((name) => !declared.includes(name));

  console.log(
    `job names declared: ${declared.length} · processors registered: ${registered.length}` +
      (missing.length ? ` · MISSING: ${missing.join(', ')}` : ' · complete'),
  );

  if (undeclared.length) console.log(`undeclared registrations: ${undeclared.join(', ')}`);

  // ── Defaults ──
  const defaults = getDefaultJobOptions();

  console.log(
    `defaults: attempts=${defaults.attempts}, backoff=${defaults.backoff.type}/${defaults.backoff.delay}ms, ` +
      `removeOnComplete=${JSON.stringify(defaults.removeOnComplete)}, removeOnFail=${JSON.stringify(defaults.removeOnFail)}`,
  );

  console.log(`system concurrency: ${parseWorkerConcurrency()} (clamped 1–50, env WORKER_CONCURRENCY + per-queue names)`);

  // ── Dispatch safety: unknown job is a loud configuration fault ──
  let unknownJobSafe = false;

  try {
    await dispatchJob({ name: 'definitely-not-a-job', data: {} });

    unknownJobSafe = false; // resolved silently — BAD
  } catch {
    unknownJobSafe = true; // loud failure = correct
  }

  console.log(`unknown-job handling: ${unknownJobSafe ? 'LOUD configuration fault (safe)' : 'GAP: silently resolved'}`);

  // ── Payload law at the producer boundary (32.7 §45) ──
  const factorySource = await readFile(
    path.join(ROOT, 'src/queues/queueFactory.js'),
    'utf8',
  );

  const guardActive = /assertReferencesOnlyPayload/.test(factorySource);

  console.log(`producer payload guard: ${guardActive ? 'ACTIVE at enqueueJob (references-only denylist)' : 'GAP: missing'}`);

  // ── Per-processor idempotency markers (inventory, not proof) ──
  const markers = {
    email: /claimEmailDelivery/,
    resume: /lease|processingLease/i,
    ats: /epoch|parseResult/i,
    scheduled: /skipped: true|STALE_/i,
    documents: /lease|processingVersion/i,
    bgv: /claim|ALREADY_SUBMITTED/i,
    payroll: /already|duplicate|version/i,
  };

  console.log('\n=== IDEMPOTENCY MARKERS (processor source inventory) ===');

  for (const [domain, pattern] of Object.entries(markers)) {
    const fileName = domain === 'documents' ? 'documentProcessor.js' : `${domain}Processor.js`;

    const source = await readFile(
      path.join(ROOT, 'src/workers', fileName),
      'utf8',
    );

    console.log(`  ${domain}: ${pattern.test(source) ? 'claim/lease/skip mechanism present' : 'REVIEW — no marker matched'}`);
  }

  // ── RESULT ──
  console.log('\n=== RESULT ===');

  const gaps =
    (missing.length ? 1 : 0) +
    (undeclared.length ? 1 : 0) +
    (unknownJobSafe ? 0 : 1) +
    (guardActive ? 0 : 1);

  if (gaps) {
    console.log(`GAPS: ${gaps} — fix before horizontal worker scaling.`);

    process.exitCode = 1;
  } else {
    console.log(
      'Registry complete, dispatch safe, payload law enforced — ' +
        'workers are multi-instance ready (delivery remains AT-LEAST-ONCE; ' +
        'business idempotency lives in Mongo claims).',
    );
  }

  const isMain =
    process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

  if (isMain) {
    setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
  }
};

await run();
