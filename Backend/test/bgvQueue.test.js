// ============================================================
// PHASE 28.6 — BGV QUEUE TESTS (hermetic, no Redis)
//
// Covers the BGV queue contracts:
//   - deterministic colon-free job ids (case / case+attempt)
//   - references-only payloads (no PII, no evidence, no keys)
//   - consent gate from the PERSISTED state:
//       not granted  → CONSENT_PENDING (no provider call)
//       DECLINED     → atomic REVIEW_REQUIRED, NO auto-reject
//   - duplicate-submit prevention (atomic providerSubmission claim)
//   - INTERNAL never polls; external poll = bounded delayed ladder
//   - result mapping VERIFIED / DISCREPANCY / UNABLE_TO_VERIFY
//     (unknown skipped; provider FAIL can never reject a candidate)
//   - polling stop on terminal case / max window
//   - never-throwing dispatch + bounded reconciliation
// Live Redis/Mongo verification is manual (docs/PHASE_28_6).
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const [qc, dispatcher, processor, svc, reminders] = await Promise.all([
  import('../src/config/queueConfig.js'),
  import('../src/services/bgvQueueDispatcher.js'),
  import('../src/workers/bgvProcessor.js'),
  import('../src/services/backgroundVerificationService.js'),
  import('../src/services/reminderSchedulingService.js'),
]);
const {
  QUEUE_NAMES,
  JOB_NAMES,
  BGV_POLL_MAX_WINDOW_MS,
  nextBgvPollDelayMs,
  parseBgvWorkerConcurrency,
  getBgvJobOptions,
} = qc;

const COMPANY_ID = '64e000000000000000000601';
const CASE_ID = '64e000000000000000000602';
const CANDIDATE_ID = '64e000000000000000000603';
const CHECK_ID = '64e000000000000000000604';
const VERIFIER_ID = '64e000000000000000000605';

const makeCase = (over = {}) => ({
  _id: CASE_ID,
  companyId: COMPANY_ID,
  candidate: CANDIDATE_ID,
  caseCode: 'BGV-0001',
  status: 'AWAITING_VERIFIER',
  provider: 'INTERNAL',
  consent: { required: false, status: 'NOT_REQUESTED' },
  providerReference: '',
  providerSubmission: { providerRequestId: null, submittedAt: null },
  polling: { status: 'NOT_APPLICABLE', attempts: 0, nextPollAt: null, stopReason: '' },
  assignedVerifier: null,
  startedAt: new Date('2026-08-28T00:00:00.000Z'),
  updatedAt: new Date('2026-08-28T00:00:00.000Z'),
  ...over,
});

const checkPayload = (over = {}) => ({
  companyId: COMPANY_ID,
  caseId: CASE_ID,
  providerKey: 'INTERNAL',
  correlationId: 'corr-bgv-0001',
  ...over,
});

// ── Job ids ─────────────────────────────────────────────────────

test('BGV job ids are deterministic, colon-free, Mongo-reconstructable', () => {
  assert.equal(dispatcher.buildBgvCheckJobId(CASE_ID), `bgv-check-${CASE_ID}`);
  assert.doesNotMatch(dispatcher.buildBgvCheckJobId(CASE_ID), /:/);
  assert.equal(dispatcher.buildBgvCheckJobId('nope'), null);
  assert.equal(dispatcher.buildBgvPollJobId(CASE_ID, 1), `bgv-poll-${CASE_ID}-1`);
  assert.equal(dispatcher.buildBgvPollJobId(CASE_ID, 12), `bgv-poll-${CASE_ID}-12`);
  assert.equal(dispatcher.buildBgvPollJobId(CASE_ID, 0), null);
  assert.equal(dispatcher.buildBgvPollJobId('nope', 1), null);
});

// ── Scheduling (never-throwing, references-only) ────────────────

test('scheduleBgvCaseProcessing enqueues a references-only check job', async () => {
  const added = [];
  const res = await dispatcher.scheduleBgvCaseProcessing(makeCase(), {
    enqueue: async (jobId, data, delay) => added.push({ jobId, data, delay }),
  });
  assert.equal(res.scheduled, true);
  assert.equal(added.length, 1);
  assert.equal(added[0].jobId, `bgv-check-${CASE_ID}`);
  assert.equal(added[0].delay, 0);
  assert.deepEqual(Object.keys(added[0].data).sort(), [
    'caseId',
    'companyId',
    'correlationId',
    'providerKey',
  ]);
  const serialized = JSON.stringify(added[0].data);
  assert.doesNotMatch(serialized, /name|email|passport|api/i);
});

test('scheduleBgvPoll enqueues a DELAYED job with the attempt in the id', async () => {
  const added = [];
  const res = await dispatcher.scheduleBgvPoll(makeCase({ provider: 'EXTERNAL' }), 2, 900000, {
    enqueue: async (jobId, data, delay) => added.push({ jobId, data, delay }),
  });
  assert.equal(res.scheduled, true);
  assert.equal(added[0].jobId, `bgv-poll-${CASE_ID}-2`);
  assert.equal(added[0].delay, 900000);
  assert.equal(added[0].data.pollAttempt, 2);
  assert.equal(added[0].data.providerKey, 'EXTERNAL');
});

test('queue outage never throws — Mongo intent survives for reconcile', async () => {
  const res = await dispatcher.scheduleBgvCaseProcessing(makeCase(), {
    enqueue: async () => {
      throw new Error('ECONNREFUSED 10.0.0.1:6379');
    },
  });
  assert.equal(res.scheduled, false);
  assert.match(res.error, /ECONNREFUSED|queue unavailable/);
});

// ── BGV_PROCESS_CHECK processor ─────────────────────────────────

const runCheck = (data, over = {}) => {
  const calls = { submit: [], claim: [], release: [], persist: [], persistPolling: [], poll: [], review: [], event: [] };
  const caseRecord = over.caseRecord || makeCase();
  const deps = {
    load: over.load || (async () => caseRecord),
    submit:
      over.submit ||
      (async (key, c, checks) => {
        calls.submit.push({ key, caseId: c._id, checkCount: checks.length });
        return { providerReference: `INTERNAL:${c.caseCode}`, results: [] };
      }),
    loadChecks: over.loadChecks || (async () => [{ _id: CHECK_ID, code: 'EMPLOYMENT' }]),
    claimSubmission:
      over.claimSubmission ||
      (async (c) => {
        calls.claim.push(c._id);
        return { ...c, providerSubmission: { ...c.providerSubmission, submittedAt: new Date() } };
      }),
    releaseSubmission: async (c) => {
      calls.release.push(c._id);
      return { modifiedCount: 1 };
    },
    persistReference: async (c, ref) => {
      calls.persist.push(ref);
      return { modifiedCount: 1 };
    },
    markReviewRequired: async (c, prev) => {
      calls.review.push({ status: prev });
      return { ...c, status: 'REVIEW_REQUIRED' };
    },
    systemEvent: async (args) => {
      calls.event.push(args.action);
      return true;
    },
    schedulePoll: async (c, attempt, delay) => {
      calls.poll.push({ caseId: c._id, attempt, delay });
      return { scheduled: true };
    },
    persistPollingState: async (c, firstPollAt) => {
      calls.persistPolling.push(firstPollAt);
      return { modifiedCount: 1 };
    },
    supportsPolling: over.supportsPolling,
  };
  return { promise: processor.bgvProcessCheckProcessor({ data }, deps), calls, caseRecord };
};

test('check processor rejects malformed payloads', async () => {
  for (const bad of [
    null,
    {},
    checkPayload({ extra: 1 }),
    { ...checkPayload(), caseId: 'bad' },
    checkPayload({ providerKey: 7 }),
  ]) {
    await assert.rejects(
      () => processor.bgvProcessCheckProcessor({ data: bad }, { load: async () => null }),
      /payload validation failed/
    );
  }
});

test('check processor: NOT_FOUND and closed cases skip without retry', async () => {
  const notFound = await runCheck(checkPayload(), { load: async () => null }).promise;
  assert.equal(notFound.reason, 'NOT_FOUND');

  const closed = await runCheck(checkPayload(), {
    caseRecord: makeCase({ status: 'COMPLETED' }),
  }).promise;
  assert.equal(closed.reason, 'CASE_CLOSED');
});

test('consent gate: not granted → no provider call; DECLINED → human review, never auto-reject', async () => {
  const pending = runCheck(checkPayload(), {
    caseRecord: makeCase({ consent: { required: true, status: 'REQUESTED' } }),
  });
  const r1 = await pending.promise;
  assert.equal(r1.reason, 'CONSENT_PENDING');
  assert.equal(pending.calls.submit.length, 0);

  const declined = runCheck(checkPayload(), {
    caseRecord: makeCase({
      status: 'AWAITING_CANDIDATE',
      consent: { required: true, status: 'DECLINED' },
    }),
  });
  const r2 = await declined.promise;
  assert.equal(r2.reason, 'CONSENT_DECLINED');
  assert.equal(declined.calls.submit.length, 0);
  assert.equal(declined.calls.review.length, 1);
  assert.equal(declined.calls.event.length, 1);
  assert.match(declined.calls.event[0], /CONSENT_DECLINED/);
  // No rejection / pipeline mutation anywhere in the worker.
  const src = await import('node:fs');
  const file = src.readFileSync(
    new URL('../src/workers/bgvProcessor.js', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(file, /rejectCandidate|REJECTED\s*[,)]/);
});

test('idempotent submit: an already-submitted case never calls the provider again', async () => {
  const { promise, calls } = runCheck(checkPayload(), {
    claimSubmission: async () => {
      calls.claim.push(CASE_ID);
      return null; // set-if-empty failed → already submitted
    },
  });
  const res = await promise;
  assert.equal(res.reason, 'ALREADY_SUBMITTED');
  assert.equal(calls.submit.length, 0);
});

test('INTERNAL happy path: claim → submit → reference persisted → NO poll scheduled', async () => {
  const { promise, calls } = runCheck(checkPayload(), {
    caseRecord: makeCase({ consent: { required: true, status: 'GRANTED' } }),
  });
  const res = await promise;
  assert.equal(res.processed, true);
  assert.equal(calls.claim.length, 1);
  assert.equal(calls.submit.length, 1);
  assert.equal(calls.persist[0], `INTERNAL:${CASE_ID === CASE_ID ? 'BGV-0001' : ''}`);
  assert.equal(calls.poll.length, 0); // INTERNAL never polls
});

test('external provider: bounded delayed first poll + polling state persisted', async () => {
  const { promise, calls } = runCheck(checkPayload({ providerKey: 'EXTERNAL' }), {
    caseRecord: makeCase({
      provider: 'EXTERNAL',
      consent: { required: true, status: 'GRANTED' },
    }),
    supportsPolling: true,
  });
  const res = await promise;
  assert.equal(res.processed, true);
  assert.equal(calls.persistPolling.length, 1); // Mongo polling state persisted
  assert.equal(calls.poll.length, 1);
  assert.equal(calls.poll[0].attempt, 1);
  assert.equal(calls.poll[0].delay, nextBgvPollDelayMs(1));
});

test('provider submit failure releases the claim and retries', async () => {
  const { promise, calls } = runCheck(checkPayload(), {
    submit: async () => {
      const e = new Error('vendor 502');
      e.statusCode = 502;
      throw e;
    },
  });
  await assert.rejects(promise, /vendor 502/);
  assert.equal(calls.release.length, 1); // claim released → reconcile can retry
  assert.equal(calls.persist.length, 0);
});

// ── BGV_PROVIDER_POLL processor ─────────────────────────────────

const runPoll = (data, over = {}) => {
  const calls = { status: [], advance: [], poll: [], record: [], stop: [] };
  const caseRecord = over.caseRecord || makeCase({
    status: 'IN_PROGRESS',
    provider: 'EXTERNAL',
    polling: { status: 'POLLING', attempts: 1, nextPollAt: new Date(), stopReason: '' },
  });
  const deps = {
    load: over.load || (async () => caseRecord),
    getStatus:
      over.getStatus ||
      (async (key, c) => {
        calls.status.push({ key, caseId: c._id });
        return { status: over.providerStatus || 'PENDING' };
      }),
    advance: async (c, next, nextPollAt) => {
      calls.advance.push({ next, nextPollAt });
      return { modifiedCount: 1 };
    },
    schedulePoll: async (c, attempt, delay) => {
      calls.poll.push({ caseId: c._id, attempt, delay });
      return { scheduled: true };
    },
    record: async (args) => {
      calls.record.push(args);
      return { processed: true, updated: 1 };
    },
    stop: async (args) => {
      calls.stop.push(args.reason);
      return true;
    },
  };
  return { promise: processor.bgvPollProcessor({ data }, deps), calls };
};

const pollPayload = (over = {}) => ({
  companyId: COMPANY_ID,
  caseId: CASE_ID,
  providerKey: 'EXTERNAL',
  pollAttempt: 1,
  correlationId: 'corr-bgv-0002',
  ...over,
});

test('poll processor: closed case / stopped polling / stale attempt all skip', async () => {
  const closed = await runPoll(pollPayload(), {
    caseRecord: makeCase({ status: 'CANCELLED' }),
  }).promise;
  assert.equal(closed.reason, 'CASE_CLOSED');

  const stopped = await runPoll(pollPayload(), {
    caseRecord: makeCase({
      status: 'IN_PROGRESS',
      polling: { status: 'STOPPED', attempts: 1, nextPollAt: null, stopReason: 'RESULT_RECEIVED' },
    }),
  }).promise;
  assert.equal(stopped.reason, 'POLLING_STOPPED');

  const stale = await runPoll(pollPayload(), {}).promise.then(() =>
    runPoll(pollPayload({ pollAttempt: 9 })).promise
  );
  assert.equal(stale.reason, 'STALE_POLL');
});

test('poll beyond the max window stops polling (bounded by design)', async () => {
  const { promise, calls } = runPoll(pollPayload({ pollAttempt: 5 }), {
    caseRecord: makeCase({
      status: 'IN_PROGRESS',
      provider: 'EXTERNAL',
      startedAt: new Date(Date.now() - BGV_POLL_MAX_WINDOW_MS - 60000),
      polling: { status: 'POLLING', attempts: 5, nextPollAt: new Date(), stopReason: '' },
    }),
  });
  const res = await promise;
  assert.equal(res.stopped, 'MAX_POLL_WINDOW');
  assert.deepEqual(calls.stop, ['MAX_POLL_WINDOW']);
  assert.equal(calls.status.length, 0); // provider not queried
});

test('still-pending poll advances the attempt on the bounded backoff ladder', async () => {
  const h = runPoll(pollPayload({ pollAttempt: 1 }));
  const r = await h.promise;
  assert.equal(r.pending, true);
  assert.equal(r.nextPollAttempt, 2);
  assert.equal(h.calls.advance.length, 1);
  assert.equal(h.calls.poll.length, 1);
  assert.equal(h.calls.poll[0].attempt, 2);
  assert.equal(h.calls.poll[0].delay, nextBgvPollDelayMs(1));
});

test('final provider result is recorded and polling stops', async () => {
  const { promise, calls } = runPoll(pollPayload(), {
    providerStatus: 'COMPLETED',
    getStatus: async () => ({
      status: 'COMPLETED',
      results: [
        { checkCode: 'EMPLOYMENT', providerStatus: 'VERIFIED', summary: 'ok' },
        { checkCode: 'EDUCATION', providerStatus: 'MISMATCH', summary: 'dates differ' },
      ],
    }),
  });
  const res = await promise;
  assert.equal(res.processed, true);
  assert.equal(calls.record.length, 1);
  assert.equal(calls.record[0].results.length, 2);
  assert.deepEqual(calls.stop, ['RESULT_RECEIVED']);
});

test('poll payload validation (strict shape + positive attempt)', async () => {
  for (const bad of [
    pollPayload({ pollAttempt: 0 }),
    pollPayload({ pollAttempt: 'x' }),
    { ...pollPayload(), extra: 1 },
  ]) {
    await assert.rejects(
      () => processor.bgvPollProcessor({ data: bad }, { load: async () => null }),
      /rejected/
    );
  }
});

// ── Result mapping (explicit, conservative, never auto-reject) ──

test('provider→domain mapping is explicit and provider FAIL can never reject a candidate', () => {
  const map = svc.PROVIDER_RESULT_MAP;
  assert.equal(map.VERIFIED, 'VERIFIED');
  assert.equal(map.PASS, 'VERIFIED');
  assert.equal(map.CLEAR, 'VERIFIED');
  assert.equal(map.MISMATCH, 'DISCREPANCY');
  assert.equal(map.FAIL, 'DISCREPANCY'); // discrepancy = human review, NOT rejection
  assert.equal(map.DISCREPANCY, 'DISCREPANCY');
  assert.equal(map.INCONCLUSIVE, 'UNABLE_TO_VERIFY');
  assert.equal(map.UNABLE_TO_VERIFY, 'UNABLE_TO_VERIFY');
  assert.equal(map.UNKNOWN, 'UNABLE_TO_VERIFY');
  assert.equal(map.TOTALLY_UNRECOGNIZED, undefined); // unknown → skipped
});

test('recordProviderBgvResult: service source never auto-rejects', async () => {
  const src = await import('node:fs');
  const file = src.readFileSync(
    new URL('../src/services/backgroundVerificationService.js', import.meta.url),
    'utf8'
  );
  // The mapping target set is the ONLY domain state provider results
  // can produce.
  assert.match(file, /PROVIDER_RESULT_MAP/);
  assert.doesNotMatch(file, /recordProviderBgvResult[\s\S]{0,4000}status:\s*['"]REJECTED['"]/);
});

// ── Polling backoff ladder + worker concurrency ─────────────────

test('poll backoff ladder is bounded 5→15→30→60 min and clamps', () => {
  assert.equal(nextBgvPollDelayMs(1), 5 * 60 * 1000);
  assert.equal(nextBgvPollDelayMs(2), 15 * 60 * 1000);
  assert.equal(nextBgvPollDelayMs(3), 30 * 60 * 1000);
  assert.equal(nextBgvPollDelayMs(4), 60 * 60 * 1000);
  assert.equal(nextBgvPollDelayMs(99), 60 * 60 * 1000); // clamped, bounded
});

test('BGV queue names + conservative job options', () => {
  assert.equal(QUEUE_NAMES.BGV, 'bgv');
  assert.equal(JOB_NAMES.BGV_PROCESS_CHECK, 'bgv-process-check');
  assert.equal(JOB_NAMES.BGV_PROVIDER_POLL, 'bgv-provider-poll');
  assert.equal(JOB_NAMES.BGV_PROCESS_RESULT, 'bgv-process-result');
  const opts = getBgvJobOptions();
  assert.equal(opts.attempts, 3);
  assert.equal(opts.backoff.delay, 3000);
});

test('BGV worker concurrency clamps to a safe range', () => {
  assert.equal(parseBgvWorkerConcurrency({ BGV_WORKER_CONCURRENCY: '3' }), 3);
  assert.equal(parseBgvWorkerConcurrency({ BGV_WORKER_CONCURRENCY: '99' }), 8);
  assert.equal(parseBgvWorkerConcurrency({ BGV_WORKER_CONCURRENCY: '0' }), 2);
  assert.equal(parseBgvWorkerConcurrency({}), 2);
});

// ── Reconciliation (bounded, idempotent, DI) ────────────────────

test('BGV reconcile re-queues missing submissions + due polls only', async () => {
  const added = [];
  const data = {
    missingSubmission: [makeCase()],
    duePolls: [
      makeCase({ _id: '64e000000000000000000610', polling: { status: 'POLLING', attempts: 3, nextPollAt: new Date() } }),
    ],
  };
  const summary = await dispatcher.runBgvReconcile({
    now: new Date(),
    enqueue: async (jobId, d, delay) => added.push({ jobId, delay }),
    loadCases: async () => data,
  });
  assert.equal(summary.checked, 2);
  assert.equal(summary.queued, 1);
  assert.equal(summary.pollsScheduled, 1);
  assert.equal(summary.errors, 0);
  assert.deepEqual(added.map((a) => a.jobId), [
    `bgv-check-${CASE_ID}`,
    `bgv-poll-64e000000000000000000610-3`,
  ]);
  // The due poll uses the persisted attempt's backoff step.
  assert.equal(added[1].delay, nextBgvPollDelayMs(3));

  const loaderDown = await dispatcher.runBgvReconcile({
    enqueue: async () => {},
    loadCases: async () => {
      throw new Error('db down');
    },
  });
  assert.equal(loaderDown.errors, 1);
  assert.equal(loaderDown.checked, 0);
});

test('cancelBgvJobs never throws when the queue is unreachable', async () => {
  const results = await dispatcher.cancelBgvJobs(makeCase({ polling: { attempts: 2 } }));
  assert.equal(Array.isArray(results), true);
  assert.ok(results.length >= 1);
  for (const r of results) {
    assert.match(r, /^absent|removed-|active|completed|failed|unavailable/);
  }
});

// ── Reminder job ids + eligibility (28.6 reminder families) ─────

const PO_ID = '64f000000000000000000701';
const CASE2_ID = '64f000000000000000000702';
const T = new Date('2026-08-28T10:00:00.000Z');

test('reminder job ids are deterministic per state version (colon-free)', () => {
  const id = reminders.buildPreOnboardingReminderJobId(PO_ID, 'DOCUMENTS_PENDING', T);
  assert.equal(id, `preonboarding-reminder-${PO_ID}-documents_pending-${T.getTime()}`);
  assert.doesNotMatch(id, /:/);
  // Same state version → same id (dedupe); different version → different id.
  assert.equal(id, reminders.buildPreOnboardingReminderJobId(PO_ID, 'DOCUMENTS_PENDING', T.toISOString()));
  assert.notEqual(
    id,
    reminders.buildPreOnboardingReminderJobId(PO_ID, 'DOCUMENTS_PENDING', new Date(T.getTime() + 1000))
  );
  assert.equal(reminders.buildPreOnboardingReminderJobId('bad', 'DOCUMENTS_PENDING', T), null);

  const bgvId = reminders.buildBgvReminderJobId(CASE2_ID, 'VERIFIER', T);
  assert.equal(bgvId, `bgv-reminder-${CASE2_ID}-verifier-${T.getTime()}`);
  assert.equal(reminders.buildBgvReminderJobId(CASE2_ID, 'VERIFIER', null), null);
});

test('reminder scheduling refuses terminal workflows (NOT_ELIGIBLE)', async () => {
  let enqueued = 0;
  const po = {
    _id: PO_ID,
    companyId: COMPANY_ID,
    status: 'COMPLETED',
    candidate: CANDIDATE_ID,
    startedAt: T,
    offerSnapshot: { joiningDate: new Date('2026-09-15T00:00:00.000Z') },
  };
  const res = await reminders.schedulePreOnboardingReminder({
    preOnboarding: po,
    reminderType: 'DOCUMENTS_PENDING',
    stateVersion: T,
    dueAt: new Date(T.getTime() + 3600000),
    enqueue: async () => {
      enqueued += 1;
    },
  });
  assert.equal(res.scheduled, false);
  assert.equal(res.reason, 'NOT_ELIGIBLE');
  assert.equal(enqueued, 0);

  const caseRes = await reminders.scheduleBgvReminder({
    caseRecord: { _id: CASE2_ID, companyId: COMPANY_ID, status: 'COMPLETED', startedAt: T },
    reminderType: 'CANDIDATE_INFO',
    stateVersion: T,
    dueAt: new Date(T.getTime() + 3600000),
    enqueue: async () => {
      enqueued += 1;
    },
  });
  assert.equal(caseRes.scheduled, false);
  assert.equal(caseRes.reason, 'NOT_ELIGIBLE');
  assert.equal(enqueued, 0);
});

test('reminder scheduling enqueues references-only payloads (no tokens, no PII)', async () => {
  const added = [];
  const po = {
    _id: PO_ID,
    companyId: COMPANY_ID,
    status: 'IN_PROGRESS',
    candidate: CANDIDATE_ID,
    startedAt: T,
    offerSnapshot: { joiningDate: new Date('2026-09-15T00:00:00.000Z') },
    candidateSnapshot: { name: 'Someone', email: 'x@y.z' },
  };
  const res = await reminders.schedulePreOnboardingReminder({
    preOnboarding: po,
    reminderType: 'DOCUMENTS_PENDING',
    stateVersion: T,
    dueAt: new Date(T.getTime() + 3600000),
    enqueue: async (jobId, data, delay) => added.push({ jobId, data, delay }),
  });
  assert.equal(res.scheduled, true);
  assert.deepEqual(Object.keys(added[0].data).sort(), [
    'companyId',
    'correlationId',
    'preOnboardingId',
    'reminderType',
    'stateVersionIso',
  ]);
  const serialized = JSON.stringify(added[0].data);
  assert.doesNotMatch(serialized, /Someone|x@y\.z|token/i);
});

test('BGV ensure* derives the right reminder set from case state (DI enqueue)', async () => {
  const added = [];
  const caseRecord = makeCase({
    _id: CASE2_ID,
    status: 'AWAITING_VERIFIER',
    consent: { required: true, status: 'GRANTED' },
    assignedVerifier: VERIFIER_ID,
  });
  const results = await reminders.ensureBgvReminders(caseRecord, {
    enqueue: async (jobId, data) => added.push({ jobId, data }),
  });
  const types = [];
  results.forEach((r, i) => {
    if (r.scheduled) types.push(added[i].data.reminderType);
  });
  assert.ok(types.includes('CANDIDATE_INFO'));
  assert.ok(types.includes('VERIFIER'));
  assert.ok(!types.includes('REVIEW_REQUIRED'));

  const reviewCase = makeCase({ _id: CASE2_ID, status: 'REVIEW_REQUIRED', assignedVerifier: null });
  await reminders.ensureBgvReminders(reviewCase, {
    enqueue: async (jobId, data) => added.push({ jobId, data }),
  });
  assert.ok(added.some((a) => a.data.reminderType === 'REVIEW_REQUIRED'));
});
