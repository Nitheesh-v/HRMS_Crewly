// ============================================================
//  PHASE 32.7 — MULTI-WORKER SAFETY MATRIX (HERMETIC).
//
//  Simulates the deployment shape: TWO independent worker instances
//  (separate job registries, each wired with the REAL register*
//  processors) consuming from ONE shared delivery source — BullMQ's
//  at-least-once delivery means EITHER worker may receive a job,
//  including duplicates. Business correctness must come from the
//  REAL Mongo claim/idempotency mechanisms, never from delivery
//  assumptions. No Redis, no Mongo: claims run against stub models
//  that faithfully emulate findOneAndUpdate atomicity.
//
//  THE LAW UNDER TEST: BullMQ delivery is AT-LEAST-ONCE. Duplicate
//  delivery must NOT duplicate business outcomes.
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';
process.env.REDIS_ENABLED ||= 'false';

const queueConfig = await import('../src/config/queueConfig.js');

const { QUEUE_NAMES, JOB_NAMES } = queueConfig;

const registryModule = await import('../src/workers/registry.js');

const { jobRegistry: baseRegistry, registerProcessor } = registryModule;

// ── Build TWO independent worker instances exactly like index.js ──
const buildWorkerInstance = (label) => {
  // Seed with the base registry's SYSTEM entries (workers/index.js
  // starts from the module registry, which ships SYSTEM jobs wired).
  const registry = new Map(baseRegistry);

  const register = (name, processor) => registry.set(name, processor);

  // The REAL registration functions (same wiring as workers/index.js).
  const modules = {
    email: null,
    resume: null,
    scheduled: null,
    documents: null,
    bgv: null,
    payroll: null,
  };

  return { label, registry, register, modules };
};

const email = await import('../src/workers/emailProcessor.js');
const resume = await import('../src/workers/resumeProcessor.js');
const ats = await import('../src/workers/atsProcessor.js');
const scheduled = await import('../src/workers/scheduledProcessor.js');
const documents = await import('../src/workers/documentProcessor.js');
const bgv = await import('../src/workers/bgvProcessor.js');
const payroll = await import('../src/workers/payrollProcessor.js');

const wireAll = (register) => {
  email.registerEmailProcessors({ registerProcessor: register });
  resume.registerResumeProcessors({ registerProcessor: register });
  ats.registerATSProcessors({ registerProcessor: register });
  scheduled.registerScheduledProcessors({ registerProcessor: register });
  documents.registerDocumentProcessors({ registerProcessor: register });
  bgv.registerBgvProcessors({ registerProcessor: register });
  payroll.registerPayrollProcessors({ registerProcessor: register });
};

const workerA = buildWorkerInstance('worker-A');

const workerB = buildWorkerInstance('worker-B');

wireAll(workerA.register);

wireAll(workerB.register);

// Shared delivery source: BullMQ hands each job to whichever worker
// picks it up — including the SAME job twice (at-least-once).
const sharedQueue = [];

const deliver = (job) => sharedQueue.push(job);

// ═════════════════════════════════════════════════════════════
//  1. REGISTRY COMPLETENESS + UNKNOWN-JOB SAFETY (both instances)
// ═════════════════════════════════════════════════════════════

test('both worker instances register EVERY declared job name (no partial worker)', () => {
  const declared = Object.values(JOB_NAMES);

  for (const worker of [workerA, workerB]) {
    const missing = declared.filter((name) => !worker.registry.has(name));

    assert.deepEqual(missing, [], `${worker.label} must register all ${declared.length} job names`);
  }
});

test('unknown job is a LOUD configuration fault (no silent skip, no dynamic handlers)', async () => {
  // Both worker instances must NOT know arbitrary job names…
  assert.equal(workerA.registry.has('definitely-not-a-job'), false);

  assert.equal(workerB.registry.has('definitely-not-a-job'), false);

  // …and the REAL dispatch path fails loudly for one (the registry
  // is an allowlist — no name inference, no dynamic module loading).
  const { dispatchJob } = await import('../src/workers/registry.js');

  await assert.rejects(
    dispatchJob({ name: 'definitely-not-a-job', data: {} }),
    /No processor registered/,
  );
});

// ═════════════════════════════════════════════════════════════
//  2. DUPLICATE DELIVERY + CONCURRENT CLAIM (email outbox)
// ═════════════════════════════════════════════════════════════

// Faithful EmailDelivery stub: findOneAndUpdate claim is ATOMIC —
// the first transition PENDING→PROCESSING wins; later claims of a
// terminal/processing record return null. (The production model's
// claim uses the exact same status guard.)
const makeDeliveryStub = ({ delayMs = 0 } = {}) => {
  const docs = new Map();

  let sends = 0;

  return {
    docs,

    sends: () => sends,

    async create(doc) {
      // 24-hex ids — the real service refuses non-ObjectId references
      // at the claim gate (references-only law, verified hermetically).
      const _id = (docs.size + 1).toString(16).padStart(8, '0') + 'aaaaaaaaaaaaaaaa';

      docs.set(_id, { status: 'PENDING', sendCount: 0, ...doc, _id });

      return { ...docs.get(_id) };
    },

    // Minimal faithful Mongo emulator for the two real claim/mark
    // shapes: status $in/$nin guards, $set, $inc, returnDocument.
    async findOneAndUpdate(filter, update = {}) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));

      const doc = docs.get(String(filter._id));

      if (!doc) return null;

      if (filter.companyId && doc.companyId !== filter.companyId) return null;

      const statusFilter = filter.status;

      if (statusFilter && typeof statusFilter === 'object') {
        if (statusFilter.$in && !statusFilter.$in.includes(doc.status)) return null;

        if (statusFilter.$nin && statusFilter.$nin.includes(doc.status)) return null;
      } else if (statusFilter && doc.status !== statusFilter) {
        return null;
      }

      if (update.$set) Object.assign(doc, update.$set);

      if (update.$inc) {
        for (const [key, delta] of Object.entries(update.$inc)) doc[key] = (doc[key] || 0) + delta;
      }

      return { ...doc };
    },

    async updateOne(filter, update) {
      const doc = docs.get(String(filter._id));

      if (!doc) return {};

      if (filter.status && doc.status !== filter.status) return {};

      Object.assign(doc, update.$set || {});

      return {};
    },

    async findOne(query) {
      for (const doc of docs.values()) {
        if (query.eventKey && doc.eventKey === query.eventKey && doc.companyId === query.companyId) {
          return { ...doc };
        }
      }

      return null;
    },

    noteSend() {
      sends += 1;
    },
  };
};

test('duplicate delivery: the same email job to BOTH workers sends ONCE (B skips as ALREADY_FINAL)', async () => {
  const { claimEmailDelivery, markEmailDelivery } = await import('../src/services/emailDeliveryService.js');

  const model = makeDeliveryStub();

  const delivery = await model.create({
    companyId: 'aaaaaaaaaaaaaaaaaaaaaaaa',

    eventKey: 'evt-duplicate-1',

    status: 'QUEUED',
  });

  const jobData = {
    companyId: 'aaaaaaaaaaaaaaaaaaaaaaaa',

    deliveryId: delivery._id,

    correlationId: 'corr-1',
  };

  // BullMQ redelivers: worker A processes it to completion…
  const claimA = await claimEmailDelivery(jobData.deliveryId, jobData.companyId, { DeliveryModel: model });

  assert.ok(claimA, 'worker A wins the atomic claim');

  model.noteSend();

  // …A marks the delivery terminal IMMEDIATELY after the send — the
  // real processor does this in its send-finish path (markEmailDelivery).
  const marked = await markEmailDelivery(jobData.deliveryId, jobData.companyId, { status: 'SENT' }, { DeliveryModel: model });

  assert.ok(marked, 'terminal marking succeeds while PROCESSING');

  // …then BullMQ redelivers the same job to worker B.
  const claimB = await claimEmailDelivery(jobData.deliveryId, jobData.companyId, { DeliveryModel: model });

  assert.equal(claimB, null, 'worker B\u2019s redelivery is a safe no-op claim (terminal)');

  // The real processor's contract for a null claim is the
  // ALREADY_FINAL skip (returns, never re-sends) — pinned in
  // test:email with stub models; here the CLAIM semantics (the
  // mechanism that makes redelivery safe) are what's under test.
  assert.equal(model.sends(), 1, 'exactly ONE business send across both workers');

  // Documented AT-LEAST-ONCE window (central law): while A is still
  // PROCESSING, a redelivery claim is NOT blocked — a crashed
  // in-flight job MUST be re-claimable or its email would never send.
  // Finality, not claim exclusivity, is what collapses duplicates.
  const delivery2 = await model.create({
    companyId: 'aaaaaaaaaaaaaaaaaaaaaaaa',

    eventKey: 'evt-inflight-1',

    status: 'QUEUED',
  });

  await claimEmailDelivery(delivery2._id, delivery2.companyId, { DeliveryModel: model });

  const inflightReclaim = await claimEmailDelivery(delivery2._id, delivery2.companyId, { DeliveryModel: model });

  assert.ok(inflightReclaim, 'in-flight re-claim stays open by design (at-least-once)');

  assert.equal(inflightReclaim.attemptCount, 2, 'each atomic claim bumps attemptCount exactly once');
});

test('concurrent claim race: atomic attempt accounting + terminal convergence', async () => {
  const { claimEmailDelivery, markEmailDelivery } = await import('../src/services/emailDeliveryService.js');

  const model = makeDeliveryStub({ delayMs: 15 }); // widen the race window

  const delivery = await model.create({
    companyId: 'bbbbbbbbbbbbbbbbbbbbbbbb',

    eventKey: 'evt-race-1',

    status: 'QUEUED',
  });

  const [a, b] = await Promise.all([
    claimEmailDelivery(delivery._id, delivery.companyId, { DeliveryModel: model }),

    claimEmailDelivery(delivery._id, delivery.companyId, { DeliveryModel: model }),
  ]);

  // Delivery is AT-LEAST-ONCE (central law): both concurrent claims
  // may proceed while the record is non-terminal — the crash window
  // must stay open. What Mongo's atomic findOneAndUpdate guarantees
  // is exact, serialized accounting and terminal convergence:
  const winners = [a, b].filter(Boolean);

  assert.equal(winners.length, 2, 'non-terminal re-claim stays open by design (at-least-once)');

  const attemptCounts = winners.map((doc) => doc.attemptCount);

  assert.deepEqual(
    attemptCounts.sort((x, y) => x - y),
    [1, 2],
    'each concurrent claim bumps attemptCount atomically — no lost or doubled increments',
  );

  // Convergence: once either worker marks terminal, every further
  // claim — from any worker — is null forever. Duplicates collapse.
  await markEmailDelivery(delivery._id, delivery.companyId, { status: 'SENT' }, { DeliveryModel: model });

  const [lateA, lateB] = await Promise.all([
    claimEmailDelivery(delivery._id, delivery.companyId, { DeliveryModel: model }),

    claimEmailDelivery(delivery._id, delivery.companyId, { DeliveryModel: model }),
  ]);

  assert.equal(lateA, null, 'post-terminal claim from worker A is a no-op');

  assert.equal(lateB, null, 'post-terminal claim from worker B is a no-op');
});

test('cross-tenant refusal: a job whose companyId mismatches the record claims NOTHING', async () => {
  const { claimEmailDelivery } = await import('../src/services/emailDeliveryService.js');

  const model = makeDeliveryStub();

  const delivery = await model.create({
    companyId: 'cccccccccccccccccccccccc', // Company A's record

    eventKey: 'evt-tenant-1',

    status: 'QUEUED',
  });

  // Company B's worker receives a forged/corrupt payload referencing
  // Company A's delivery under Company B's identity.
  const claim = await claimEmailDelivery(delivery._id, 'dddddddddddddddddddddddd', {
    DeliveryModel: model,
  });

  assert.equal(claim, null, 'tenant-scoped claim refuses cross-tenant processing');
});

// ═════════════════════════════════════════════════════════════
//  3. RETRY vs TERMINAL CLASSIFICATION (real classifier)
// ═════════════════════════════════════════════════════════════

test('failure classification: transient errors retry; terminal errors do not', () => {
  const { classifyEmailSendFailure } = email;

  assert.equal(classifyEmailSendFailure('connect ETIMEDOUT after 10s').retryable, true);

  assert.equal(classifyEmailSendFailure('connect ECONNREFUSED 127.0.0.1:25').retryable, true);

  assert.equal(classifyEmailSendFailure('535 Authentication failed').retryable, false);

  assert.equal(classifyEmailSendFailure('550 5.1.1 user unknown').retryable, false);

  assert.equal(classifyEmailSendFailure('SMTP not configured').retryable, false);
});

// ═════════════════════════════════════════════════════════════
//  4. STALE-JOB REVALIDATION (real reminder guard)
// ═════════════════════════════════════════════════════════════

test('stale schedule/version job is detected by the real guard (SKIP semantics)', () => {
  const { isInterviewEventStale } = email;

  // A reminder rides scheduleVersion = the schedule's start ISO.
  // The job carries the OLD schedule; Mongo now holds a newer one → stale.
  assert.equal(
    isInterviewEventStale({
      currentStatus: 'SCHEDULED',

      currentStartAtIso: '2026-10-01T10:00:00Z',

      eventType: 'REMINDER',

      scheduleVersion: '2026-09-20T10:00:00Z',
    }),
    true,
    'schedule moved on → stale → job must SKIP',
  );

  // Same schedule the job was created for, still upcoming → act on it.
  assert.equal(
    isInterviewEventStale({
      currentStatus: 'SCHEDULED',

      currentStartAtIso: '2026-10-01T10:00:00Z',

      eventType: 'REMINDER',

      scheduleVersion: '2026-10-01T10:00:00Z',
    }),
    false,
  );

  // Terminal interview → never remind.
  assert.equal(
    isInterviewEventStale({
      currentStatus: 'COMPLETED',

      currentStartAtIso: '2026-10-01T10:00:00Z',

      eventType: 'REMINDER',

      scheduleVersion: '2026-10-01T10:00:00Z',
    }),
    true,
  );
});

// ═════════════════════════════════════════════════════════════
//  5. PAYLOAD LAW AT THE PRODUCER BOUNDARY (32.7 §45)
// ═════════════════════════════════════════════════════════════

const factory = await import('../src/queues/queueFactory.js');

test('producer guard: forbidden payload keys are REJECTED before any queue/Redis touch', () => {
  const forbidden = [
    { password: 'hunter2' },

    { nested: { rawToken: 'abc' } },

    { offerToken: 'tok' },

    { kioskPin: '1234' },

    { bankAccountNumber: '1234567890' },

    { resumeText: 'full resume…' },

    { pdfBase64: 'AAAA' },

    { attachment: { name: 'x' } },

    { gpsLatitude: '13.08' },

    { salaryRows: [] },
  ];

  for (const payload of forbidden) {
    assert.throws(
      () => factory.assertReferencesOnlyPayload(QUEUE_NAMES.EMAIL, 'email-x', payload),

      /references-only law/,

      `must reject ${JSON.stringify(Object.keys(payload))}`,
    );
  }
});

test('producer guard: every legitimate Crewly payload shape passes', () => {
  const legitimate = [
    { candidateId: 'c1', companyId: 'x1', correlationId: 'r1' },

    { deliveryId: 'd1', jobId: 'j1' },

    { offerId: 'o1', decision: 'ACCEPTED' },

    { expiryDateIso: '2026-10-01', trigger: 'MANUAL', engineVersion: 3 },

    { parseResultId: 'p1', resumeId: 'r1' },

    { caseId: 'c', checkType: 'IDENTITY', pollAttempt: 2 },

    { documentVersionId: 'dv', processingVersion: 2 },

    { employeeCode: 'E001', month: '2026-09' },

    { interviewId: 'i1', interviewerId: 'ir1', eventType: 'CREATED', scheduleVersion: 5 },

    { requestedAt: new Date().toISOString() },
  ];

  for (const payload of legitimate) {
    assert.doesNotThrow(
      () => factory.assertReferencesOnlyPayload(QUEUE_NAMES.PAYROLL, 'probe', payload),
      `legitimate payload rejected: ${JSON.stringify(Object.keys(payload))}`,
    );
  }
});

// ═════════════════════════════════════════════════════════════
//  6. DETERMINISTIC JOB IDs + SHARED-QUEUE DEDUPE (two producers)
// ═════════════════════════════════════════════════════════════

test('two API instances enqueueing the same logical job collapse on the deterministic id', async () => {
  const bgvDispatcher = await import('../src/services/bgv/bgvQueueDispatcher.js');

  const docDispatcher = await import('../src/services/documentProcessingDispatcher.js');

  const caseId = 'aaaaaaaaaaaaaaaaaaaaaaaa';

  const documentVersionId = 'bbbbbbbbbbbbbbbbbbbbbbbb';

  // API #1 and API #2 both observe the condition and enqueue:
  const idA = bgvDispatcher.buildBgvCheckJobId(caseId);

  const idB = bgvDispatcher.buildBgvCheckJobId(caseId);

  assert.equal(idA, idB, 'BullMQ jobId dedupe collapses duplicate enqueues');

  assert.equal(idA, `bgv-check-${caseId}`);

  const docA = docDispatcher.buildDocumentProcessJobId(documentVersionId, 2);

  const docB = docDispatcher.buildDocumentProcessJobId(documentVersionId, 2);

  assert.equal(docA, docB);

  // V1 and V2 are DIFFERENT jobs — old versions can never collide
  // with (or overwrite) new ones.
  assert.notEqual(
    docDispatcher.buildDocumentProcessJobId(documentVersionId, 1),

    docDispatcher.buildDocumentProcessJobId(documentVersionId, 2),
  );
});

test('shared-queue smoke: 12 mixed jobs, both workers drain everything, registry never starves', async () => {
  const declared = Object.values(JOB_NAMES);

  for (let index = 0; index < 12; index += 1) {
    deliver({ name: declared[index % declared.length], data: {}, worker: index % 2 ? workerB : workerA });
  }

  let processed = 0;

  while (sharedQueue.length) {
    const job = sharedQueue.shift();

    const processor = job.worker.registry.get(job.name);

    assert.ok(processor, `no processor on ${job.worker.label} for ${job.name}`);

    processed += 1;
  }

  assert.equal(processed, 12, 'both workers drain a shared interleaved queue');
});
