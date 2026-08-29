// ============================================================
// PHASE 28.4 — PROCESSING QUEUE TESTS (hermetic, no Redis needed)
//
// Covers the BullMQ resume/ATS pipeline contracts:
//   - deterministic colon-free job ids (Mongo-reconstructable)
//   - strict references-only payload validation (no PII/data in Redis)
//   - worker adapter semantics (retryable → throw, terminal → return)
//   - retry-aware failure handling (RETRY_PENDING, no history spam)
//   - never-throwing dispatch (queue outage loses no work)
//   - Mongo-derived recovery (resume leases + ATS intents)
//   - job slot prep (dead FAILED jobs cleared, live jobs deduped)
//   - concurrency parsing with safe clamps
// Live Redis/Mongo verification is manual (docs/PHASE_28_4).
// ============================================================

import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';
process.env.PRIVATE_RESUME_STORAGE_DIR = path.resolve(
  'private_storage/test-processing-queue'
);

const [
  { default: AuditLog },
  { default: CandidateHistory },
  { default: CandidateResume },
  { default: ResumeParseResult },
  dispatcher,
  atsDispatcher,
  processingService,
  resumeProcessor,
  atsProcessor,
  queueFactory,
  queueConfig,
] = await Promise.all([
  import('../src/models/AuditLog.js'),
  import('../src/models/CandidateHistory.js'),
  import('../src/models/CandidateResume.js'),
  import('../src/models/ResumeParseResult.js'),
  import('../src/services/resumeProcessingDispatcher.js'),
  import('../src/services/atsDispatcher.js'),
  import('../src/services/resumeProcessingService.js'),
  import('../src/workers/resumeProcessor.js'),
  import('../src/workers/atsProcessor.js'),
  import('../src/queues/queueFactory.js'),
  import('../src/config/queueConfig.js'),
]);

const COMPANY_ID = '64c000000000000000000301';
const CANDIDATE_ID = '64c000000000000000000303';
const JOB_ID = '64c000000000000000000304';
const RESUME_ID = '64c000000000000000000305';
const PARSE_RESULT_ID = '64c000000000000000000306';
const USER_ID = '64c000000000000000000307';
const PARSER_VERSION = 'deterministic-1.0.0';

const restorable = (...entries) => {
  const originals = entries.map(([target, method]) => [
    target,
    method,
    target[method],
  ]);
  return () => originals.forEach(([target, method, original]) => {
    target[method] = original;
  });
};

const leanQuery = (value) => ({
  select() {
    return this;
  },
  sort() {
    return this;
  },
  limit() {
    return this;
  },
  lean() {
    return Promise.resolve(value);
  },
});

const recordingEnqueue = () => {
  const calls = [];
  const enqueue = async (jobId, payload) => {
    calls.push({ jobId, payload });
    return { id: jobId };
  };
  return { calls, enqueue };
};

test('resume and ATS job ids are deterministic, colon-free and epoch-aware', () => {
  const requestedAt = new Date(1730000000000);
  const resumeId = dispatcher.buildResumeJobId(RESUME_ID, PARSER_VERSION, requestedAt);

  assert.match(resumeId, /^resume-parse-[a-f0-9]{24}-deterministic-1\.0\.0-1730000000000$/);
  assert.ok(!resumeId.includes(':'));
  // Deterministic from Mongo state (same request → same id).
  assert.equal(
    dispatcher.buildResumeJobId(RESUME_ID, PARSER_VERSION, requestedAt),
    resumeId
  );
  // A new parse request (new epoch) → fresh id (reprocess unblocked).
  assert.notEqual(
    dispatcher.buildResumeJobId(RESUME_ID, PARSER_VERSION, new Date(1730000001000)),
    resumeId
  );
  assert.equal(dispatcher.buildResumeJobId('not-an-id', PARSER_VERSION, requestedAt), null);

  const completedAt = new Date(1730000002000);
  const atsId = atsDispatcher.buildATSJobId(CANDIDATE_ID, PARSE_RESULT_ID, completedAt);
  assert.match(atsId, /^ats-process-[a-f0-9]{24}-[a-f0-9]{24}-1730000002000$/);
  assert.ok(!atsId.includes(':'));
  assert.equal(
    atsDispatcher.buildATSJobId(CANDIDATE_ID, PARSE_RESULT_ID, completedAt),
    atsId
  );
  assert.notEqual(
    atsDispatcher.buildATSJobId(CANDIDATE_ID, PARSE_RESULT_ID, new Date(1730000003000)),
    atsId
  );
  assert.equal(atsDispatcher.buildATSJobId(CANDIDATE_ID, PARSE_RESULT_ID, null), null);
});

test('resume processor enforces strict references-only payloads', () => {
  const valid = {
    companyId: COMPANY_ID,
    candidateId: CANDIDATE_ID,
    resumeId: RESUME_ID,
    parserVersion: PARSER_VERSION,
    correlationId: 'corr-1',
  };
  const ok = resumeProcessor.validateResumeJobPayload(valid);
  assert.equal(ok.valid, true);
  assert.equal(ok.value.resumeId, RESUME_ID);

  // PII/data smuggling is rejected as an unknown key.
  assert.equal(resumeProcessor.validateResumeJobPayload({ ...valid, resumeText: 'x' }).valid, false);
  assert.equal(resumeProcessor.validateResumeJobPayload({ ...valid, buffer: 'x' }).valid, false);
  // Forged or malformed ids are rejected.
  assert.equal(
    resumeProcessor.validateResumeJobPayload({ ...valid, resumeId: 'not-an-id' }).valid,
    false
  );
  assert.equal(resumeProcessor.validateResumeJobPayload({ ...valid, parserVersion: '' }).valid, false);
  assert.equal(
    resumeProcessor.validateResumeJobPayload({ ...valid, parserVersion: 'x'.repeat(200) }).valid,
    false
  );
  assert.equal(resumeProcessor.validateResumeJobPayload([valid]).valid, false);
});

test('ats processor enforces strict references-only payloads', () => {
  const valid = {
    companyId: COMPANY_ID,
    candidateId: CANDIDATE_ID,
    jobId: JOB_ID,
    resumeId: RESUME_ID,
    parseResultId: PARSE_RESULT_ID,
    engineVersion: '1.0.0',
    trigger: 'MANUAL_REPROCESS',
    actorId: USER_ID,
    correlationId: 'corr-2',
  };
  const ok = atsProcessor.validateATSJobPayload(valid);
  assert.equal(ok.valid, true);
  assert.equal(ok.value.actorId, USER_ID);

  // Resume/candidate content is never a legal payload key.
  assert.equal(atsProcessor.validateATSJobPayload({ ...valid, resumeContent: 'x' }).valid, false);
  assert.equal(atsProcessor.validateATSJobPayload({ ...valid, jobRequirements: 'x' }).valid, false);
  assert.equal(atsProcessor.validateATSJobPayload({ ...valid, trigger: 'HACK' }).valid, false);
  assert.equal(atsProcessor.validateATSJobPayload({ ...valid, trigger: undefined }).valid, false);
  assert.equal(
    atsProcessor.validateATSJobPayload({ ...valid, actorId: 'not-an-id' }).valid,
    false
  );
  assert.equal(
    atsProcessor.validateATSJobPayload({ ...valid, parseResultId: undefined }).valid,
    false
  );
});

test('resume processor: retryable failure throws for BullMQ retry, terminal returns', async () => {
  const payload = {
    companyId: COMPANY_ID,
    candidateId: CANDIDATE_ID,
    resumeId: RESUME_ID,
    parserVersion: PARSER_VERSION,
  };
  let seenFinalAttempt;
  const process = async (args) => {
    seenFinalAttempt = args.finalAttempt;
    return { accepted: true, status: 'RETRY_PENDING' };
  };

  // Non-final attempt: retryable → throw (BullMQ backoff + retry).
  await assert.rejects(
    resumeProcessor.resumeParseProcessor({ data: payload, attemptsStarted: 1 }, { process }),
    /RESUME_PARSE retryable failure/
  );
  assert.equal(seenFinalAttempt, false);

  // Final attempt: finalAttempt=true is surfaced to the service.
  const processFinal = async (args) => {
    seenFinalAttempt = args.finalAttempt;
    return { accepted: true, status: 'FAILED' };
  };
  const result = await resumeProcessor.resumeParseProcessor(
    { data: payload, attemptsStarted: queueConfig.RESUME_JOB_OPTIONS.attempts },
    { process: processFinal }
  );
  assert.equal(seenFinalAttempt, true);
  assert.equal(result.processed, true);
  assert.equal(result.status, 'FAILED');

  // Malformed payload → loud failure (job fails per its options).
  await assert.rejects(
    resumeProcessor.resumeParseProcessor({ data: { companyId: 'x' }, attemptsStarted: 1 }, { process }),
    /RESUME_PARSE rejected/
  );
});

test('ats processor: business mismatch is a terminal no-op, success returns small result', async () => {
  const payload = {
    companyId: COMPANY_ID,
    candidateId: CANDIDATE_ID,
    jobId: JOB_ID,
    resumeId: RESUME_ID,
    parseResultId: PARSE_RESULT_ID,
    engineVersion: '1.0.0',
    trigger: 'RESUME_PARSED',
  };
  const mismatch = await atsProcessor.atsProcessProcessor(
    { data: payload, attemptsStarted: 1 },
    { process: async () => ({ accepted: false, reason: 'MATCH_INPUTS_NOT_AVAILABLE' }) }
  );
  // No throw: a tenant/relationship mismatch can never resolve on retry.
  assert.equal(mismatch.processed, false);
  assert.equal(mismatch.action, 'NOOP');
  assert.equal(mismatch.reason, 'MATCH_INPUTS_NOT_AVAILABLE');

  const done = await atsProcessor.atsProcessProcessor(
    { data: payload, attemptsStarted: 1 },
    { process: async () => ({ accepted: true, skipped: false, action: 'ATS_PROCESSED' }) }
  );
  assert.equal(done.processed, true);
  assert.equal(done.action, 'ATS_PROCESSED');
  assert.equal(done.result, undefined); // no business data leaves the worker

  const skipped = await atsProcessor.atsProcessProcessor(
    { data: payload, attemptsStarted: 1 },
    { process: async () => ({ accepted: true, skipped: true, reason: 'UNCHANGED_INPUTS' }) }
  );
  assert.equal(skipped.action, 'SKIPPED');
});

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const claimedResume = (storageKey, mimeType = 'application/pdf') => ({
  _id: RESUME_ID,
  companyId: COMPANY_ID,
  candidate: CANDIDATE_ID,
  job: JOB_ID,
  storageProvider: 'LOCAL_PRIVATE',
  storageKey,
  mimeType,
  fileSize: 1000,
  status: 'UPLOADED',
  parsingStatus: 'PROCESSING',
  parsingAttempts: 1,
  parsingRequestedAt: new Date(1730000000000),
  processingLeaseId: 'lease-1',
  processingLeaseExpiresAt: new Date(1730000000000 + 300000),
});

const stubProcessingModels = () => {
  const restore = restorable(
    [CandidateResume, 'findOneAndUpdate'],
    [CandidateResume, 'updateOne'],
    [ResumeParseResult, 'findOneAndUpdate'],
    [ResumeParseResult, 'updateOne'],
    [CandidateHistory, 'create'],
    [AuditLog, 'create']
  );
  const resumeUpdates = [];
  const resultUpdates = [];
  const history = [];

  CandidateResume.findOneAndUpdate = () =>
    leanQuery(claimedResume('missing-hermetic-file.pdf'));
  CandidateResume.updateOne = async (filter, update) => {
    resumeUpdates.push({ filter, update });
    return { modifiedCount: 1 };
  };
  ResumeParseResult.findOneAndUpdate = async () => ({ _id: PARSE_RESULT_ID });
  ResumeParseResult.updateOne = async (filter, update) => {
    resultUpdates.push({ filter, update });
    return { modifiedCount: 1 };
  };
  CandidateHistory.create = async (payload) => {
    history.push(payload);
    return payload;
  };
  AuditLog.create = async (payload) => payload;

  return { restore, resumeUpdates, resultUpdates, history };
};

test('transient storage failure keeps RETRY_PENDING without history spam (non-final)', async () => {
  const stub = stubProcessingModels();
  try {
    // The claimed resume points at a missing local file → the storage
    // layer raises a transient (ApiError) failure, not a content error.
    const result = await processingService.processResumeJob({
      companyId: COMPANY_ID,
      candidateId: CANDIDATE_ID,
      resumeId: RESUME_ID,
      finalAttempt: false,
    });

    assert.equal(result.status, 'RETRY_PENDING');
    assert.equal(result.retryable, true);
    // One STARTED row per attempt (existing behavior) but NO failure
    // history row — retries must not spam the candidate timeline.
    assert.deepEqual(
      stub.history.map((event) => event.action),
      ['RESUME_PARSE_STARTED']
    );
    // Lease released + RETRY_PENDING persisted on both documents.
    const resumeSet = stub.resumeUpdates.find(
      ({ update }) => update.$set?.parsingStatus === 'RETRY_PENDING'
    );
    assert.ok(resumeSet);
    assert.equal(resumeSet.update.$set.processingLeaseId, '');
    const resultSet = stub.resultUpdates.find(
      ({ update }) => update.$set?.status === 'RETRY_PENDING'
    );
    assert.ok(resultSet);
    assert.equal(resultSet.update.$set.failureCategory, 'STORAGE_UNAVAILABLE');
  } finally {
    stub.restore();
  }
});

test('transient storage failure fails terminally on the final attempt', async () => {
  const stub = stubProcessingModels();
  try {
    const result = await processingService.processResumeJob({
      companyId: COMPANY_ID,
      candidateId: CANDIDATE_ID,
      resumeId: RESUME_ID,
      finalAttempt: true,
    });

    assert.equal(result.status, 'FAILED');
    assert.equal(result.retryable, undefined);
    assert.deepEqual(
      stub.history.map((event) => event.action),
      ['RESUME_PARSE_STARTED', 'RESUME_PARSE_FAILED']
    );
    assert.ok(
      stub.resumeUpdates.some(({ update }) => update.$set?.parsingStatus === 'FAILED')
    );
  } finally {
    stub.restore();
  }
});

test('corrupt resume content fails terminally on the first attempt (no retry)', async () => {
  const directory = process.env.PRIVATE_RESUME_STORAGE_DIR;
  const storageKey = 'corrupt-hermetic.docx';
  const stub = stubProcessingModels();
  try {
    await mkdir(directory, { recursive: true });
    // A garbage "DOCX" has no valid zip central directory — the
    // extractor deterministically classifies CORRUPT_FILE (content
    // error): terminal even on a non-final attempt (no BullMQ retry).
    await writeFile(path.join(directory, storageKey), Buffer.from('%% not a docx %%'));
    CandidateResume.findOneAndUpdate = () =>
      leanQuery(claimedResume(storageKey, DOCX_MIME));

    const result = await processingService.processResumeJob({
      companyId: COMPANY_ID,
      candidateId: CANDIDATE_ID,
      resumeId: RESUME_ID,
      finalAttempt: false,
    });

    assert.equal(result.status, 'FAILED');
    assert.equal(result.retryable, undefined);
    assert.deepEqual(
      stub.history.map((event) => event.action),
      ['RESUME_PARSE_STARTED', 'RESUME_PARSE_FAILED']
    );
  } finally {
    stub.restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test('dispatchResumeProcessing never throws and enqueues references-only payloads', async () => {
  const requestedAt = new Date(1730000000000);
  const { calls, enqueue } = recordingEnqueue();
  const result = await dispatcher.dispatchResumeProcessing(
    {
      companyId: COMPANY_ID,
      candidateId: CANDIDATE_ID,
      resumeId: RESUME_ID,
      parsingRequestedAt: requestedAt,
    },
    { enqueue }
  );

  assert.equal(result.accepted, true);
  assert.equal(result.queued, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    Object.keys(calls[0].payload).sort(),
    ['candidateId', 'companyId', 'correlationId', 'parserVersion', 'resumeId']
  );
  assert.ok(JSON.stringify(calls[0].payload).length < 512);

  // Simulated Redis outage: intent stays in Mongo, result is safe.
  const failing = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
  };
  const outage = await dispatcher.dispatchResumeProcessing(
    {
      companyId: COMPANY_ID,
      candidateId: CANDIDATE_ID,
      resumeId: RESUME_ID,
      parsingRequestedAt: requestedAt,
    },
    { enqueue: failing }
  );
  assert.equal(outage.accepted, true);
  assert.equal(outage.queued, false);
  assert.equal(typeof outage.error, 'string');

  // Forged tenant id is rejected without any enqueue.
  const forged = await dispatcher.dispatchResumeProcessing(
    { companyId: 'not-an-id', candidateId: CANDIDATE_ID, resumeId: RESUME_ID, parsingRequestedAt: requestedAt },
    { enqueue }
  );
  assert.equal(forged.accepted, false);
  assert.equal(calls.length, 1);
});

test('recoverPendingResumeProcessing normalizes state and re-enqueues stuck intents', async () => {
  const restore = restorable(
    [CandidateResume, 'updateMany'],
    [CandidateResume, 'find']
  );
  const requestedAt = new Date(1730000000000);
  const updateManyFilters = [];
  let findFilter;

  try {
    CandidateResume.updateMany = async (filter) => {
      updateManyFilters.push(filter);
      return { matchedCount: 1 };
    };
    CandidateResume.find = (filter) => {
      findFilter = filter;
      return leanQuery([
        {
          _id: RESUME_ID,
          companyId: COMPANY_ID,
          candidate: CANDIDATE_ID,
          parsingRequestedAt: requestedAt,
        },
      ]);
    };

    const { calls, enqueue } = recordingEnqueue();
    const summary = await dispatcher.recoverPendingResumeProcessing({
      enqueue,
      minAgeMs: 0,
    });

    assert.equal(summary.provider, 'BULLMQ');
    assert.equal(summary.pending, 1);
    assert.equal(summary.queued, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(calls.length, 1);

    // Legacy + lease-expiry normalization ran (Mongo is the truth).
    assert.ok(
      updateManyFilters.some((filter) =>
        ['NOT_REQUESTED', 'PARSING_PENDING'].includes(filter.parsingStatus?.$in?.[0] ?? '')
      )
    );
    assert.ok(
      updateManyFilters.some(
        (filter) => filter.parsingStatus?.$in?.includes('PROCESSING')
      )
    );
    // The scan is scoped to stuck, attempt-bounded intents older than
    // the min-age (a just-enqueued healthy job is never re-queued).
    assert.equal(findFilter.status, 'UPLOADED');
    assert.deepEqual(findFilter.parsingStatus.$in, ['PENDING', 'RETRY_PENDING']);
    assert.equal(
      findFilter.parsingAttempts.$lt,
      processingService.resumeProcessingConfiguration.maxAttempts
    );
    assert.ok(findFilter.parsingRequestedAt.$lte instanceof Date);
    // Deterministic id from Mongo state, references-only payload.
    assert.equal(
      calls[0].jobId,
      dispatcher.buildResumeJobId(RESUME_ID, PARSER_VERSION, requestedAt)
    );
    assert.equal(String(calls[0].payload.companyId), COMPANY_ID);
  } finally {
    restore();
  }
});

test('recoverPendingATSMatching derives ATS intent from Mongo (auto + manual)', async () => {
  const restore = restorable([CandidateResume, 'aggregate'], [ResumeParseResult, 'findOne']);
  const completedAt = new Date(1730000002000);
  const manualAt = new Date(1730000004000);

  try {
    CandidateResume.aggregate = async () => [
      {
        _id: RESUME_ID,
        companyId: COMPANY_ID,
        candidate: CANDIDATE_ID,
        job: JOB_ID,
        pendingATS: null,
      },
      {
        _id: '64c000000000000000000309',
        companyId: COMPANY_ID,
        candidate: '64c000000000000000000308',
        job: JOB_ID,
        pendingATS: {
          recalculationPending: true,
          recalculationRequestedAt: manualAt,
          recalculationRequestedBy: USER_ID,
        },
      },
    ];
    ResumeParseResult.findOne = () =>
      leanQuery({ _id: PARSE_RESULT_ID, completedAt });

    const { calls, enqueue } = recordingEnqueue();
    const summary = await atsDispatcher.recoverPendingATSMatching({ enqueue });

    assert.equal(summary.pending, 2);
    assert.equal(summary.queued, 2);
    assert.equal(calls.length, 2);

    // Automatic chain: STARTUP_RECOVERY, id from parse completion.
    assert.equal(calls[0].payload.trigger, 'STARTUP_RECOVERY');
    assert.equal(calls[0].payload.actorId, undefined);
    assert.equal(
      calls[0].jobId,
      atsDispatcher.buildATSJobId(CANDIDATE_ID, PARSE_RESULT_ID, completedAt)
    );
    // Manual recalculate: MANUAL_REPROCESS + actor, id from the request.
    assert.equal(calls[1].payload.trigger, 'MANUAL_REPROCESS');
    assert.equal(calls[1].payload.actorId, USER_ID);
    assert.equal(
      calls[1].jobId,
      atsDispatcher.buildATSJobId('64c000000000000000000308', PARSE_RESULT_ID, manualAt)
    );
    // Payloads stay references-only and small.
    for (const call of calls) {
      assert.ok(!call.jobId.includes(':'));
      assert.ok(JSON.stringify(call.payload).length < 512);
      assert.ok(!/rawText|structuredData|skills|location/.test(JSON.stringify(call.payload)));
    }
  } finally {
    restore();
  }
});

test('prepareJobSlot clears dead failed jobs and leaves live jobs untouched', async () => {
  let removed = false;
  const failedQueue = {
    getJob: async () => ({
      getState: async () => 'failed',
      remove: async () => {
        removed = true;
      },
    }),
  };
  assert.equal(await queueFactory.prepareJobSlot(failedQueue, 'job-1'), 'failed-removed');
  assert.equal(removed, true);

  let touched = false;
  const liveQueue = {
    getJob: async () => ({
      getState: async () => 'waiting',
      remove: async () => {
        touched = true;
      },
    }),
  };
  assert.equal(await queueFactory.prepareJobSlot(liveQueue, 'job-1'), 'waiting');
  assert.equal(touched, false);

  assert.equal(
    await queueFactory.prepareJobSlot({ getJob: async () => null }, 'job-1'),
    'absent'
  );
});

test('processing worker concurrency is parsed with safe clamps', () => {
  assert.equal(queueConfig.parseResumeWorkerConcurrency({}), 1);
  assert.equal(queueConfig.parseResumeWorkerConcurrency({ RESUME_WORKER_CONCURRENCY: '99' }), 4);
  assert.equal(queueConfig.parseResumeWorkerConcurrency({ RESUME_WORKER_CONCURRENCY: '0' }), 1);
  assert.equal(queueConfig.parseResumeWorkerConcurrency({ RESUME_WORKER_CONCURRENCY: 'abc' }), 1);

  assert.equal(queueConfig.parseATSWorkerConcurrency({}), 2);
  assert.equal(queueConfig.parseATSWorkerConcurrency({ ATS_WORKER_CONCURRENCY: '99' }), 10);
  assert.equal(queueConfig.parseATSWorkerConcurrency({ ATS_WORKER_CONCURRENCY: '0' }), 2);
  assert.equal(queueConfig.parseATSWorkerConcurrency({ ATS_WORKER_CONCURRENCY: 'abc' }), 2);

  assert.equal(queueConfig.JOB_NAMES.RESUME_PARSE, 'resume-parse');
  assert.equal(queueConfig.JOB_NAMES.ATS_PROCESS, 'ats-process');
  assert.deepEqual(queueConfig.PROCESSING_JOB_NAMES, ['resume-parse', 'ats-process']);
});
