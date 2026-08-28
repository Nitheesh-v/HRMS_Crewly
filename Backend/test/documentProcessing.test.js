// ============================================================
// PHASE 28.6 — DOCUMENT PROCESSING TESTS (hermetic, no Redis)
//
// Covers the DOCUMENTS queue contracts:
//   - deterministic colon-free job ids (Mongo-reconstructable)
//   - strict references-only payload (no PII/paths/bytes in Redis)
//   - worker invariants: tenant scoping, version scoping, stale
//     version skip, atomic lease claim, no fake CLEAN
//     (NOT_CONFIGURED stays honest), integrity check
//   - retry classification: transient → throw (retry), permanent
//     categories → terminal PROCESSING_FAILED (no retry spam)
//   - never-throwing dispatch + bounded reconciliation
//   - concurrency parsing clamps
// Live Redis/Mongo verification is manual (docs/PHASE_28_6).
// ============================================================

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const [qc, dispatcher, processor] = await Promise.all([
  import('../src/config/queueConfig.js'),
  import('../src/services/documentProcessingDispatcher.js'),
  import('../src/workers/documentProcessor.js'),
]);
const {
  QUEUE_NAMES,
  JOB_NAMES,
  parseDocumentWorkerConcurrency,
  getDocumentJobOptions,
} = qc;

const COMPANY_ID = '64d000000000000000000501';
const DOCUMENT_ID = '64d000000000000000000502';
const VERSION_ID = '64d000000000000000000503';
const CANDIDATE_ID = '64d000000000000000000504';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const makeVersion = (over = {}) => ({
  _id: VERSION_ID,
  companyId: COMPANY_ID,
  candidateDocument: DOCUMENT_ID,
  candidate: CANDIDATE_ID,
  processingVersion: 1,
  processingStatus: 'PENDING',
  processingAttempts: 0,
  processingLastError: '',
  processingLeaseId: '',
  processingLeaseExpiresAt: null,
  mimeType: 'application/pdf',
  storageProvider: 'local',
  storageKey: 'private/preonboarding/deadbeef.pdf',
  checksumSha256: sha256(Buffer.from('%PDF-1.4 fake stored bytes')),
  scanStatus: 'NOT_CONFIGURED',
  scanCheckedAt: null,
  uploadedAt: new Date(),
  ...over,
});

const payload = (over = {}) => ({
  companyId: COMPANY_ID,
  documentId: DOCUMENT_ID,
  documentVersionId: VERSION_ID,
  processingVersion: 1,
  correlationId: 'corr-test-0001',
  ...over,
});

const BUFFER = Buffer.from('%PDF-1.4 fake stored bytes');

// Full-DI harness: no Mongo, no Redis, no SMTP.
const runProcessor = (jobData, over = {}) => {
  const calls = { fetch: [], verify: [], finish: [], clearLease: [], notify: [] };
  const version = over.version === undefined ? makeVersion() : over.version;
  const deps = {
    loadVersion: async () => version,
    loadDocument: over.loadDocument || (async () => ({ _id: DOCUMENT_ID, candidate: CANDIDATE_ID })),
    claim:
      over.claim === 'deny'
        ? async () => null
        : async (v) => ({ ...v, processingStatus: 'PROCESSING', processingLeaseId: 'lease-1' }),
    fetchFile:
      over.fetchFile ||
      (async () => {
        calls.fetch.push(1);
        return BUFFER;
      }),
    verify:
      over.verify ||
      (async () => {
        calls.verify.push(1);
        return { status: 'NOT_CONFIGURED', details: 'no scanner configured' };
      }),
    finish: async (v, value, fields) => {
      calls.finish.push({ filter: { _id: v._id, companyId: value.companyId, processingVersion: value.processingVersion }, fields });
      return { modifiedCount: 1 };
    },
    clearLease: async (v, value) => {
      calls.clearLease.push({ _id: v._id, companyId: value.companyId });
      return { modifiedCount: 1 };
    },
    notify: async (companyId, roles, note) => {
      calls.notify.push({ companyId, roles, note });
      return true;
    },
    recordRejectedEvent: async (args) => {
      calls.notify.push({ rejectedEvent: true, versionId: args.version._id });
      return true;
    },
  };
  return {
    promise: processor.documentProcessProcessor({ data: jobData }, deps),
    calls,
  };
};

test('job id is deterministic, colon-free, and Mongo-reconstructable', () => {
  const id = dispatcher.buildDocumentProcessJobId(VERSION_ID, 1);
  assert.equal(id, `document-process-${VERSION_ID}-1`);
  assert.doesNotMatch(id, /:/);
  // Uppercase ids normalize; invalid ids never produce a job id.
  assert.equal(
    dispatcher.buildDocumentProcessJobId(VERSION_ID.toUpperCase(), 2),
    `document-process-${VERSION_ID}-2`
  );
  assert.equal(dispatcher.buildDocumentProcessJobId('nope', 1), null);
  assert.equal(dispatcher.buildDocumentProcessJobId(VERSION_ID, 0), null);
  assert.equal(dispatcher.buildDocumentProcessJobId(VERSION_ID, 1.7), null);
});

test('scheduleDocumentProcessing enqueues references-only payload (never throws)', async () => {
  const added = [];
  const res = await dispatcher.scheduleDocumentProcessing(makeVersion(), {
    enqueue: async (jobId, data) => {
      added.push({ jobId, data });
    },
  });
  assert.equal(res.scheduled, true);
  assert.equal(added.length, 1);
  assert.equal(added[0].jobId, `document-process-${VERSION_ID}-1`);
  const data = added[0].data;
  assert.deepEqual(Object.keys(data).sort(), [
    'companyId',
    'correlationId',
    'documentId',
    'documentVersionId',
    'processingVersion',
  ]);
  const serialized = JSON.stringify(data);
  // No PII / storage internals / bytes ever reach Redis.
  assert.doesNotMatch(serialized, /deadbeef|private\/|%PDF|name|email/);
});

test('scheduleDocumentProcessing is ineligible without a valid tenant id', async () => {
  const res = await dispatcher.scheduleDocumentProcessing(
    { _id: VERSION_ID, companyId: 'not-a-tenant', candidateDocument: DOCUMENT_ID },
    { enqueue: async () => assert.fail('must not enqueue') }
  );
  assert.equal(res.scheduled, false);
  assert.equal(res.reason, 'NOT_ELIGIBLE');
});

test('queue outage never throws — intent stays in Mongo for reconcile', async () => {
  const res = await dispatcher.scheduleDocumentProcessing(makeVersion(), {
    enqueue: async () => {
      throw new Error('ECONNREFUSED 10.0.0.1:6379');
    },
  });
  assert.equal(res.scheduled, false);
  assert.match(res.error, /queue unavailable|ECONNREFUSED/);
});

test('worker rejects malformed payloads (strict 5-key shape)', async () => {
  for (const bad of [
    null,
    {},
    payload({ extra: 1 }),
    { ...payload(), documentVersionId: 'bad-id' },
    { ...payload(), companyId: 'zz' },
    payload({ processingVersion: 0 }),
    payload({ processingVersion: 'abc' }),
  ]) {
    await assert.rejects(
      () => processor.documentProcessProcessor({ data: bad }, {
        loadVersion: async () => null,
      }),
      /payload validation failed/
    );
  }
});

test('worker skips on tenant-scoped NOT_FOUND and STALE_VERSION', async () => {
  const notFound = await runProcessor(payload(), { version: null }).promise;
  assert.equal(notFound.skipped, true);
  assert.equal(notFound.reason, 'NOT_FOUND');

  const stale = await runProcessor(payload(), {
    version: makeVersion({ processingVersion: 2 }),
  }).promise;
  assert.equal(stale.reason, 'STALE_VERSION');

  const mismatch = await runProcessor(payload(), {
    loadDocument: async () => ({ _id: '64d000000000000000000999', candidate: CANDIDATE_ID }),
  }).promise;
  assert.equal(mismatch.reason, 'TENANT_MISMATCH');
});

test('worker respects the atomic claim (ALREADY_PROCESSED / IN_FLIGHT)', async () => {
  const done = await runProcessor(payload(), {
    claim: 'deny',
    version: makeVersion({ processingStatus: 'PROCESSED' }),
  }).promise;
  assert.equal(done.reason, 'ALREADY_PROCESSED');

  const inflight = await runProcessor(payload(), { claim: 'deny' }).promise;
  assert.equal(inflight.reason, 'IN_FLIGHT');
});

test('happy path: stored bytes verified, NOT_CONFIGURED stays honest, version-scoped write', async () => {
  const { promise, calls } = runProcessor(payload());
  const res = await promise;
  assert.equal(res.processed, true);
  assert.equal(calls.verify.length, 1);
  assert.equal(calls.finish.length, 1);
  const finish = calls.finish[0];
  assert.equal(finish.fields.scanStatus, 'NOT_CONFIGURED'); // never a fake CLEAN
  assert.equal(finish.fields.processingStatus, 'PROCESSED');
  assert.equal(finish.fields.processingLeaseId, '');
  assert.equal(finish.fields.processingLeaseExpiresAt, null);
  // Writes are scoped to THIS version + tenant + processing version.
  assert.deepEqual(finish.filter, {
    _id: VERSION_ID,
    companyId: COMPANY_ID,
    processingVersion: 1,
  });
  assert.equal(calls.notify.length, 0);
});

test('real scanner verdicts are recorded (CLEAN / REJECTED) — business state untouched', async () => {
  const clean = await runProcessor(payload(), {
    verify: async () => ({ status: 'CLEAN' }),
  }).promise;
  assert.equal(clean.processed, true);

  const rejected = await runProcessor(payload(), {
    verify: async () => ({ status: 'REJECTED', details: 'malware signature' }),
  });
  const res = await rejected.promise;
  assert.equal(res.processed, true);
  assert.equal(rejected.calls.finish[0].fields.scanStatus, 'REJECTED');
  // One business event (history + audit) + one HR in-app notice —
  // never per retry.
  assert.equal(rejected.calls.notify.length, 2);
  assert.ok(rejected.calls.notify.some((n) => n.rejectedEvent));
  assert.match(rejected.calls.notify.find((n) => n.note)?.note.message, /HR review required/);
  // The document's business status is NOT flipped by the worker.
  assert.equal(rejected.calls.finish[0].fields.processingStatus, 'PROCESSED');
});

test('integrity mismatch is terminal (no retry, flagged for review)', async () => {
  const { promise, calls } = runProcessor(payload(), {
    fetchFile: async () => Buffer.from('tampered bytes'),
  });
  const res = await promise;
  assert.equal(res.reason, 'INTEGRITY_MISMATCH');
  assert.equal(calls.finish.length, 1);
  assert.equal(calls.finish[0].fields.processingLastError, 'INTEGRITY_MISMATCH');
  assert.equal(calls.verify.length, 0); // integrity check gates the scan
});

test('fetch 404/413 → terminal categories; 5xx → retryable throw + lease cleared', async () => {
  const notFound = await runProcessor(payload(), {
    fetchFile: async () => {
      const e = new Error('object not found');
      e.statusCode = 404;
      throw e;
    },
  }).promise;
  assert.equal(notFound.reason, 'FILE_NOT_FOUND');

  const tooLarge = await runProcessor(payload(), {
    fetchFile: async () => {
      const e = new Error('payload too large');
      e.statusCode = 413;
      throw e;
    },
  }).promise;
  assert.equal(tooLarge.reason, 'STORAGE_UNAVAILABLE');

  const transient = runProcessor(payload(), {
    fetchFile: async () => {
      const e = new Error('storage 503');
      e.statusCode = 503;
      throw e;
    },
  });
  await assert.rejects(transient.promise, /storage 503/);
  assert.equal(transient.calls.clearLease.length, 1); // retry can re-claim
});

test('verify 400 (unsupported/corrupt) is terminal; scanner 5xx retries', async () => {
  const unsupported = await runProcessor(payload(), {
    verify: async () => {
      const e = new Error('Unsupported or invalid file type for inspection');
      e.statusCode = 400;
      throw e;
    },
  }).promise;
  assert.equal(unsupported.reason, 'UNSUPPORTED_FILE');

  const corrupt = await runProcessor(payload(), {
    verify: async () => {
      const e = new Error('PDF is corrupted or truncated');
      e.statusCode = 400;
      throw e;
    },
  }).promise;
  assert.equal(corrupt.reason, 'CORRUPT_FILE');

  const scannerDown = runProcessor(payload(), {
    verify: async () => {
      const e = new Error('scanner 502');
      e.statusCode = 502;
      throw e;
    },
  });
  await assert.rejects(scannerDown.promise, /scanner 502/);
  assert.equal(scannerDown.calls.clearLease.length, 1);
});

test('reconciliation re-derives jobs with deterministic ids (bounded, never throws)', async () => {
  const added = [];
  const versions = [makeVersion(), makeVersion({ _id: '64d000000000000000000510', processingVersion: 2 })];
  const summary = await dispatcher.runDocumentReconcile({
    now: new Date(),
    enqueue: async (jobId, data) => added.push(jobId),
    loadVersions: async () => versions,
  });
  assert.deepEqual(summary, { checked: 2, scheduled: 2, skipped: 0, errors: 0 });
  assert.deepEqual(added, [
    `document-process-${VERSION_ID}-1`,
    `document-process-64d000000000000000000510-2`,
  ]);

  const loaderDown = await dispatcher.runDocumentReconcile({
    enqueue: async () => {},
    loadVersions: async () => {
      throw new Error('db down');
    },
  });
  assert.equal(loaderDown.errors, 1);
  assert.equal(loaderDown.checked, 0);
});

test('concurrency parser clamps to a safe range', () => {
  assert.equal(parseDocumentWorkerConcurrency({ DOCUMENT_WORKER_CONCURRENCY: '4' }), 4);
  assert.equal(parseDocumentWorkerConcurrency({ DOCUMENT_WORKER_CONCURRENCY: '99' }), 8);
  assert.equal(parseDocumentWorkerConcurrency({ DOCUMENT_WORKER_CONCURRENCY: '0' }), 2);
  assert.equal(parseDocumentWorkerConcurrency({ DOCUMENT_WORKER_CONCURRENCY: 'abc' }), 2);
  assert.equal(parseDocumentWorkerConcurrency({}), 2);
});

test('queue names + job options are conservative and documented', () => {
  assert.equal(QUEUE_NAMES.DOCUMENTS, 'documents');
  assert.equal(JOB_NAMES.DOCUMENT_PROCESS, 'document-process');
  const opts = getDocumentJobOptions();
  assert.equal(opts.attempts, 3);
  assert.equal(opts.backoff.delay, 2000);
});
