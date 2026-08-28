// ============================================================
// Phase 28.3 — email delivery outbox tests (hermetic)
//
// No live Redis and no MongoDB required. Covers:
//   - event key rules (ids only, safe join)
//   - strict per-job payload validation + secure-token exclusion
//   - SMTP failure classification (retryable vs not)
//   - stale-state predicates (interview events)
//   - dispatch idempotency / FAILED_TO_QUEUE / reconciliation
//   - atomic claim re-entrancy + terminal-state protection
//
// Model access is stubbed via dependency injection; the live
// Queue→Worker→Mailer round-trip is exercised by the manual
// ladder (MOCK mode) and the 28.2 live Redis test.
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import {
  JOB_NAMES,
  EMAIL_JOB_NAMES,
  buildJobId,
} from '../src/config/queueConfig.js';
import {
  buildEventKey,
  buildEmailJobId,
  dispatchEmailDelivery,
  requestEmailDelivery,
  claimEmailDelivery,
  markEmailDelivery,
  reconcileStuckEmailDeliveries,
} from '../src/services/emailDeliveryService.js';
import {
  validateEmailJobPayload,
  classifyEmailSendFailure,
  isInterviewEventStale,
  FAILURE_CATEGORIES,
} from '../src/workers/emailProcessor.js';

const COMP = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const CAND = 'cccccccccccccccccccccccc';
const INTERVIEW = 'dddddddddddddddddddddddd';
const INTERVIEWER = 'eeeeeeeeeeeeeeeeeeeeeeee';
const OFFER = 'ffffffffffffffffffffffff';
const PREONBOARD = '121212121212121212121212';
const DOCUMENT = '343434343434343434343434';
const REQUIREMENT = '565656565656565656565656';
const DELIVERY = '787878787878787878787878';

// ─── Event keys ───────────────────────────────────────────────

test('buildEventKey joins safe parts and rejects unsafe input', () => {
  assert.equal(
    buildEventKey('APPLICATION_RECEIVED', CAND),
    `APPLICATION_RECEIVED:${CAND}`
  );
  assert.throws(() => buildEventKey('X', 'has space'));
  assert.throws(() => buildEventKey('X', ''));
  assert.throws(() => buildEventKey('X', 'bad\ttab'));
  // ISO timestamps (used as schedule versions) are acceptable parts.
  const key = buildEventKey('INTERVIEW_CANDIDATE', INTERVIEW, 'SCHEDULED', '2026-08-28T04:37:39.852Z');
  assert.ok(key.includes('2026-08-28T04'));
});

test('all seven email job names are registered', () => {
  assert.equal(EMAIL_JOB_NAMES.length, 7);
  for (const name of EMAIL_JOB_NAMES) {
    assert.ok(JOB_NAMES && Object.values(JOB_NAMES).includes(name));
    assert.ok(name.startsWith('email-'));
  }
  // There is deliberately no arbitrary-email job.
  assert.ok(!Object.values(JOB_NAMES).some((n) => /arbitrary|generic/i.test(n)));
});

// ─── Payload validation ───────────────────────────────────────

const basePayload = (extra) => ({
  deliveryId: DELIVERY,
  correlationId: 'corr-1',
  companyId: COMP,
  ...extra,
});

test('validateEmailJobPayload accepts well-formed payloads per job', () => {
  const cases = [
    [JOB_NAMES.EMAIL_APPLICATION_RECEIVED, { candidateId: CAND, jobId: INTERVIEW }],
    [JOB_NAMES.EMAIL_PIPELINE_UPDATE, { candidateId: CAND, stage: 'SHORTLISTED' }],
    [
      JOB_NAMES.EMAIL_INTERVIEW_CANDIDATE,
      { interviewId: INTERVIEW, eventType: 'SCHEDULED', scheduleVersion: '2026-08-28T04:37:39.852Z' },
    ],
    [
      JOB_NAMES.EMAIL_INTERVIEW_INTERVIEWER,
      { interviewId: INTERVIEW, interviewerId: INTERVIEWER, eventType: 'RESCHEDULED', scheduleVersion: 'v1' },
    ],
    [JOB_NAMES.EMAIL_OFFER_DECISION, { offerId: OFFER, decision: 'ACCEPTED' }],
    [JOB_NAMES.EMAIL_OFFER_WITHDRAWN, { offerId: OFFER }],
    [
      JOB_NAMES.EMAIL_PREONBOARDING_DOC_DECISION,
      { preOnboardingId: PREONBOARD, documentId: DOCUMENT, requirementId: REQUIREMENT, decision: 'VERIFIED', documentVersion: 2 },
    ],
    [
      JOB_NAMES.EMAIL_PREONBOARDING_DOC_DECISION,
      { preOnboardingId: PREONBOARD, decision: 'READY_TO_JOIN' },
    ],
  ];
  for (const [jobName, extra] of cases) {
    const result = validateEmailJobPayload(jobName, basePayload(extra));
    assert.equal(result.valid, true, `${jobName} should be valid: ${result.reason}`);
  }
});

test('validateEmailJobPayload rejects unknown keys, bad ids and bad enums', () => {
  for (const jobName of EMAIL_JOB_NAMES) {
    // Secure-token / PII exclusion: none of the jobs may accept
    // emails, tokens, rendered content or credentials.
    for (const forbidden of ['candidateEmail', 'secureToken', 'html', 'smtpPassword', 'resume', 'resetToken']) {
      const result = validateEmailJobPayload(jobName, basePayload({ [forbidden]: 'x' }));
      assert.equal(result.valid, false, `${jobName} must reject key ${forbidden}`);
    }
    assert.equal(validateEmailJobPayload(jobName, null).valid, false);
    assert.equal(validateEmailJobPayload(jobName, ['array']).valid, false);
    assert.equal(validateEmailJobPayload(jobName, {}).valid, false, 'missing common keys');
    const noCompany = basePayload({ candidateId: CAND });
    delete noCompany.companyId;
    assert.equal(validateEmailJobPayload(jobName, noCompany).valid, false);
  }

  assert.equal(
    validateEmailJobPayload(JOB_NAMES.EMAIL_INTERVIEW_CANDIDATE,
      basePayload({ interviewId: INTERVIEW, eventType: 'BOGUS', scheduleVersion: 'v' })).valid,
    false
  );
  assert.equal(
    validateEmailJobPayload(JOB_NAMES.EMAIL_OFFER_DECISION,
      basePayload({ offerId: OFFER, decision: 'MAYBE' })).valid,
    false
  );
  assert.equal(
    validateEmailJobPayload(JOB_NAMES.EMAIL_APPLICATION_RECEIVED,
      basePayload({ candidateId: 'not-an-id', jobId: INTERVIEW })).valid,
    false
  );
  assert.equal(
    validateEmailJobPayload(JOB_NAMES.EMAIL_PREONBOARDING_DOC_DECISION,
      basePayload({ preOnboardingId: PREONBOARD, documentId: DOCUMENT, requirementId: REQUIREMENT, decision: 'VERIFIED', documentVersion: 0 })).valid,
    false
  );
  // Unknown job name is rejected, not dispatched.
  assert.equal(validateEmailJobPayload('SEND_ARBITRARY_EMAIL', basePayload({})).valid, false);
});

// ─── Failure classification ───────────────────────────────────

test('classifyEmailSendFailure separates retryable from terminal failures', () => {
  assert.equal(classifyEmailSendFailure('connect ECONNREFUSED 10.0.0.1:587').category, 'SMTP_CONNECTION_ERROR');
  assert.equal(classifyEmailSendFailure('connect ECONNREFUSED 10.0.0.1:587').retryable, true);
  assert.equal(classifyEmailSendFailure('connect ETIMEDOUT').category, 'SMTP_TIMEOUT');
  assert.equal(classifyEmailSendFailure('connect ETIMEDOUT').retryable, true);
  assert.equal(classifyEmailSendFailure('Invalid login: 535 Authentication failed').category, 'SMTP_AUTH_ERROR');
  assert.equal(classifyEmailSendFailure('Invalid login: 535 Authentication failed').retryable, false);
  assert.equal(classifyEmailSendFailure('550 5.1.1 The email account that you tried to reach does not exist').category, 'RECIPIENT_REJECTED');
  assert.equal(classifyEmailSendFailure('550 5.1.1 The email account that you tried to reach does not exist').retryable, false);
  assert.equal(classifyEmailSendFailure('SMTP is not configured').category, 'MAIL_CONFIG_MISSING');
  assert.equal(classifyEmailSendFailure('SMTP is not configured').retryable, false);
  assert.equal(classifyEmailSendFailure('something odd').category, 'UNKNOWN');
  assert.equal(classifyEmailSendFailure('something odd').retryable, true);
  assert.equal(classifyEmailSendFailure('').category, 'UNKNOWN');
});

test('every failure category is declared with a retry policy', () => {
  for (const value of Object.values(FAILURE_CATEGORIES)) {
    assert.equal(typeof value.retryable, 'boolean');
  }
});

// ─── Stale-state predicates ───────────────────────────────────

const T1 = '2026-08-28T04:00:00.000Z';
const T2 = '2026-08-28T05:00:00.000Z';

test('isInterviewEventStale keeps current events and drops superseded ones', () => {
  // Current scheduled interview, matching version → not stale.
  assert.equal(
    isInterviewEventStale({ currentStatus: 'SCHEDULED', currentStartAtIso: T1, eventType: 'SCHEDULED', scheduleVersion: T1 }),
    false
  );
  // Interview moved on (rescheduled) → old SCHEDULED event is stale.
  assert.equal(
    isInterviewEventStale({ currentStatus: 'RESCHEDULED', currentStartAtIso: T2, eventType: 'SCHEDULED', scheduleVersion: T1 }),
    true
  );
  // Reschedule #2 supersedes reschedule #1 (version mismatch).
  assert.equal(
    isInterviewEventStale({ currentStatus: 'RESCHEDULED', currentStartAtIso: T2, eventType: 'RESCHEDULED', scheduleVersion: T1 }),
    true
  );
  // Current reschedule with matching version → not stale.
  assert.equal(
    isInterviewEventStale({ currentStatus: 'RESCHEDULED', currentStartAtIso: T2, eventType: 'RESCHEDULED', scheduleVersion: T2 }),
    false
  );
  // Cancellation only valid while cancelled.
  assert.equal(
    isInterviewEventStale({ currentStatus: 'CANCELLED', currentStartAtIso: T1, eventType: 'CANCELLED', scheduleVersion: T1 }),
    false
  );
  assert.equal(
    isInterviewEventStale({ currentStatus: 'COMPLETED', currentStartAtIso: T1, eventType: 'CANCELLED', scheduleVersion: T1 }),
    true
  );
  // Terminal event notifications must match the terminal status.
  assert.equal(
    isInterviewEventStale({ currentStatus: 'COMPLETED', currentStartAtIso: T1, eventType: 'COMPLETED', scheduleVersion: T1 }),
    false
  );
  assert.equal(
    isInterviewEventStale({ currentStatus: 'SCHEDULED', currentStartAtIso: T1, eventType: 'COMPLETED', scheduleVersion: T1 }),
    true
  );
  // Unknown event type → treated as stale (safe default).
  assert.equal(
    isInterviewEventStale({ currentStatus: 'SCHEDULED', currentStartAtIso: T1, eventType: 'BOGUS', scheduleVersion: T1 }),
    true
  );
});

// ─── Stub delivery model (DI) ─────────────────────────────────

const matchesFilter = (doc, filter = {}) => {
  for (const [key, cond] of Object.entries(filter)) {
    if (cond === undefined) continue;
    if (key === '_id') {
      if (String(doc._id) !== String(cond)) return false;
    } else if (key === 'status') {
      if (cond.$in && !cond.$in.includes(doc.status)) return false;
      if (cond.$nin && cond.$nin.includes(doc.status)) return false;
      if (!cond.$in && !cond.$nin && doc.status !== cond) return false;
    } else if (key === 'createdAt') {
      if (cond.$lt && !(new Date(doc.createdAt || 0) < cond.$lt)) return false;
    } else if (doc[key] !== cond) {
      return false;
    }
  }
  return true;
};

const makeStubModel = () => {
  const docs = new Map();
  let seq = 0;
  const applyUpdate = (doc, update = {}) => {
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
    }
  };
  const model = {
    docs,
    async findOne(filter) {
      for (const doc of docs.values()) if (matchesFilter(doc, filter)) return { ...doc };
      return null;
    },
    async findById(id) {
      const doc = docs.get(String(id));
      return doc ? { ...doc } : null;
    },
    async create(input) {
      for (const doc of docs.values()) {
        if (input.eventKey && doc.eventKey === input.eventKey) {
          const err = new Error('duplicate key');
          err.code = 11000;
          throw err;
        }
      }
      seq += 1;
      const _id = input._id || new mongoose.Types.ObjectId();
      const doc = { status: 'PENDING', attemptCount: 0, ...input, _id };
      docs.set(String(_id), doc);
      return { ...doc };
    },
    async updateOne(filter, update) {
      let modified = 0;
      for (const doc of docs.values()) {
        if (matchesFilter(doc, filter)) {
          applyUpdate(doc, update);
          modified += 1;
        }
      }
      return { modifiedCount: modified };
    },
    async findOneAndUpdate(filter, update, options) {
      for (const doc of docs.values()) {
        if (matchesFilter(doc, filter)) {
          applyUpdate(doc, update);
          return options?.new ? { ...doc } : { ...doc };
        }
      }
      return null;
    },
    find(filter) {
      return {
        limit: () => ({
          lean: async () => [...docs.values()].filter((d) => matchesFilter(d, filter)).map((d) => ({ ...d })),
        }),
      };
    },
  };
  return model;
};

const okEnqueue = async (jobName, payload, jobId) => ({ id: jobId });
const failEnqueue = async () => {
  const err = new Error('ECONNREFUSED redis');
  err.code = 'ECONNREFUSED';
  throw err;
};

const applicationArgs = (over = {}) => ({
  jobName: JOB_NAMES.EMAIL_APPLICATION_RECEIVED,
  eventType: 'APPLICATION_RECEIVED',
  eventKey: buildEventKey('APPLICATION_RECEIVED', CAND),
  companyId: COMP,
  entityType: 'CANDIDATE',
  entityId: CAND,
  recipientType: 'CANDIDATE',
  recipientReference: CAND,
  payload: { candidateId: CAND, jobId: INTERVIEW },
  ...over,
});

// ─── Dispatch (outbox) ────────────────────────────────────────

test('dispatchEmailDelivery persists intent then queues (PENDING → QUEUED)', async () => {
  const model = makeStubModel();
  const enqueued = [];
  const outcome = await dispatchEmailDelivery({
    ...applicationArgs(),
    DeliveryModel: model,
    enqueue: async (jobName, payload, jobId) => {
      enqueued.push({ jobName, payload, jobId });
      return okEnqueue(jobName, payload, jobId);
    },
  });

  assert.equal(outcome.queued, true);
  assert.equal(outcome.duplicate, false);
  assert.equal(model.docs.size, 1);

  const doc = [...model.docs.values()][0];
  assert.equal(doc.status, 'QUEUED');
  assert.ok(doc.queueJobId);
  assert.ok(doc.queuedAt instanceof Date);
  // Stored payload carries references + deliveryId, never PII.
  assert.equal(doc.payload.candidateId, CAND);
  assert.equal(doc.payload.deliveryId, String(doc._id));
  assert.ok(doc.payload.correlationId);
  assert.ok(!('email' in doc.payload) && !('candidateEmail' in doc.payload));
  // Deterministic job id: email-<deliveryId> (colon-free for BullMQ).
  assert.equal(enqueued[0].jobId, `email-${doc._id}`);
  assert.equal(enqueued[0].jobName, JOB_NAMES.EMAIL_APPLICATION_RECEIVED);

  // The enqueued payload must satisfy the worker's strict validator:
  // references + identity fields, no eventType, no PII.
  assert.equal(enqueued[0].payload.companyId, COMP);
  assert.ok(!('eventType' in enqueued[0].payload));
  const validation = validateEmailJobPayload(enqueued[0].jobName, enqueued[0].payload);
  assert.equal(validation.valid, true, `enqueued payload must validate: ${validation.reason}`);
});

test('duplicate logical event collapses on eventKey (no second job)', async () => {
  const model = makeStubModel();
  let calls = 0;
  const enqueue = async (jobName, payload, jobId) => {
    calls += 1;
    return okEnqueue(jobName, payload, jobId);
  };
  const first = await dispatchEmailDelivery({ ...applicationArgs(), DeliveryModel: model, enqueue });
  const second = await dispatchEmailDelivery({ ...applicationArgs(), DeliveryModel: model, enqueue });

  assert.equal(first.queued, true);
  assert.equal(second.duplicate, true);
  assert.equal(model.docs.size, 1);
  assert.equal(calls, 1);
});

test('queue failure marks FAILED_TO_QUEUE without throwing', async () => {
  const model = makeStubModel();
  const outcome = await dispatchEmailDelivery({
    ...applicationArgs(),
    DeliveryModel: model,
    enqueue: failEnqueue,
  });

  assert.equal(outcome.queued, false);
  assert.equal(outcome.duplicate, false);
  assert.ok(outcome.error);
  const doc = [...model.docs.values()][0];
  assert.equal(doc.status, 'FAILED_TO_QUEUE');
  assert.equal(doc.lastFailureCategory, 'QUEUE_UNAVAILABLE');
});

test('requestEmailDelivery never throws (business safety)', async () => {
  const model = makeStubModel();
  // Invalid args would make dispatchEmailDelivery throw — the
  // wrapper must convert that to a safe result.
  const outcome = await requestEmailDelivery({
    ...applicationArgs(),
    DeliveryModel: model,
    enqueue: okEnqueue,
    companyId: 'not-an-objectid',
  });
  assert.equal(outcome.queued, false);
  assert.ok(outcome.error);
  // And a normal failure path (queue down) is also non-throwing.
  const outcome2 = await requestEmailDelivery({
    ...applicationArgs(),
    eventKey: buildEventKey('APPLICATION_RECEIVED', OTHER),
    DeliveryModel: model,
    enqueue: failEnqueue,
  });
  assert.equal(outcome2.queued, false);
});

// ─── Claim + mark (worker side) ───────────────────────────────

test('claimEmailDelivery is re-entrant and stops at terminal states', async () => {
  const model = makeStubModel();
  await dispatchEmailDelivery({ ...applicationArgs(), DeliveryModel: model, enqueue: okEnqueue });
  const doc = [...model.docs.values()][0];

  const first = await claimEmailDelivery(String(doc._id), COMP, { DeliveryModel: model });
  assert.ok(first);
  assert.equal(first.status, 'PROCESSING');
  assert.equal(first.attemptCount, 1);

  // BullMQ retry re-enters the same delivery.
  const second = await claimEmailDelivery(String(doc._id), COMP, { DeliveryModel: model });
  assert.ok(second);
  assert.equal(second.attemptCount, 2);

  await markEmailDelivery(String(doc._id), COMP, { status: 'SENT', deliveryMode: 'MOCK' }, { DeliveryModel: model });

  const third = await claimEmailDelivery(String(doc._id), COMP, { DeliveryModel: model });
  assert.equal(third, null, 'terminal delivery must not be claimed again');
});

test('markEmailDelivery never overwrites a terminal state and respects tenant', async () => {
  const model = makeStubModel();
  await dispatchEmailDelivery({ ...applicationArgs(), DeliveryModel: model, enqueue: okEnqueue });
  const doc = [...model.docs.values()][0];

  await markEmailDelivery(String(doc._id), COMP, { status: 'SENT', deliveryMode: 'SMTP' }, { DeliveryModel: model });
  const stored = await model.findById(doc._id);
  assert.equal(stored.status, 'SENT');
  assert.ok(stored.sentAt instanceof Date);

  // A late FAILED must not clobber SENT.
  const blocked = await markEmailDelivery(
    String(doc._id), COMP, { status: 'FAILED', lastFailureCategory: 'RETRIES_EXHAUSTED' }, { DeliveryModel: model }
  );
  assert.equal(blocked, null);
  assert.equal((await model.findById(doc._id)).status, 'SENT');

  // A different tenant can never touch the record.
  const crossTenant = await markEmailDelivery(
    String(doc._id), OTHER, { status: 'FAILED' }, { DeliveryModel: model }
  );
  assert.equal(crossTenant, null);
});

// ─── Reconciliation ───────────────────────────────────────────

test('reconcile re-enqueues stuck deliveries once, idempotently', async () => {
  const model = makeStubModel();
  const past = new Date(Date.now() - 120000);

  // One FAILED_TO_QUEUE and one orphaned PENDING (both >60s old).
  await model.create({
    companyId: COMP,
    jobName: JOB_NAMES.EMAIL_OFFER_WITHDRAWN,
    eventType: 'OFFER_WITHDRAWN',
    eventKey: buildEventKey('OFFER_WITHDRAWN', OFFER),
    entityType: 'OFFER',
    entityId: OFFER,
    recipientType: 'CANDIDATE',
    payload: { offerId: OFFER, deliveryId: 'x' },
    createdAt: past,
    updatedAt: past,
  });
  await model.create({
    companyId: COMP,
    jobName: JOB_NAMES.EMAIL_OFFER_WITHDRAWN,
    eventType: 'OFFER_WITHDRAWN',
    eventKey: buildEventKey('OFFER_WITHDRAWN', 'fffffffffffffffffffffffe'),
    entityType: 'OFFER',
    entityId: 'fffffffffffffffffffffffe',
    recipientType: 'CANDIDATE',
    payload: { offerId: 'fffffffffffffffffffffffe', deliveryId: 'y' },
    createdAt: past,
    updatedAt: past,
  });
  await model.updateOne({ eventKey: buildEventKey('OFFER_WITHDRAWN', OFFER) }, { $set: { status: 'FAILED_TO_QUEUE' } });

  let enqueueCalls = [];
  const enqueue = async (jobName, payload, jobId) => {
    enqueueCalls.push(jobId);
    return okEnqueue(jobName, payload, jobId);
  };

  const first = await reconcileStuckEmailDeliveries({ minAgeMs: 60000, DeliveryModel: model, enqueue });
  assert.equal(first.scanned, 2);
  assert.equal(first.requeued, 2);
  // Reconciliation keeps the deterministic job id (email:<deliveryId>).
  assert.equal(enqueueCalls.length, 2);
  for (const jobId of enqueueCalls) {
    assert.ok(jobId.startsWith('email-'));
  }

  // Re-run: everything is QUEUED now — nothing happens.
  enqueueCalls = [];
  const second = await reconcileStuckEmailDeliveries({ minAgeMs: 60000, DeliveryModel: model, enqueue });
  assert.equal(second.scanned, 0);
  assert.equal(second.requeued, 0);
  assert.equal(enqueueCalls.length, 0);
  assert.ok(first.results.every((r) => r.requeued));
});

// ─── Job ids (BullMQ custom ids) ───────────────────────────────

test('email job ids are deterministic, colon-free and secret-free', () => {
  const id = buildEmailJobId(DELIVERY);
  assert.equal(id, `email-${DELIVERY}`);
  assert.equal(id, buildEmailJobId(DELIVERY));
  // BullMQ rejects custom job ids containing ':' (it uses ':' as its
  // key separator) — the format must stay colon-free.
  assert.ok(!id.includes(':'), 'BullMQ custom ids cannot contain colons');
  // The id is email-<deliveryMongoId> — a Mongo ObjectId — so a
  // candidate's email address can never end up in the job id by
  // construction (spec §13).
  assert.ok(!id.includes('@'));
  // Structural safety of the underlying builder is unchanged.
  assert.throws(() => buildJobId('email', 'bad id'));
  assert.throws(() => buildJobId('email', 'bad\u0001id'));
});
