// ============================================================
// PHASE 28.5 — SCHEDULED JOBS TESTS (hermetic, no Redis/Mongo)
//
// Covers the BullMQ scheduled pipeline contracts:
//   - deterministic colon-free versioned job ids
//   - delay calculation + past-timestamp policy (immediate, skip)
//   - strict references-only payloads (no PII/tokens/links)
//   - worker revalidation (stale schedule/expiry, terminal
//     states, tenant scope, already-reminded)
//   - offer expiry ONLY via the atomic transition service
//   - reminder policy (interview 24h/1h/immediate; offer offset)
//   - reconcile selection + bounded windows + idempotency shape
//   - email-job validator (EMAIL_OFFER_REMINDER, REMINDER events)
//   - never-throwing scheduling (queue outage loses no intent)
// Live dev-Redis verification is manual (docs/PHASE_28_5).
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_test';

const [scheduler, scheduledProcessor, emailProcessor, queueConfig, registry, mailer] =
  await Promise.all([
    import('../src/services/scheduledJobScheduler.js'),
    import('../src/workers/scheduledProcessor.js'),
    import('../src/workers/emailProcessor.js'),
    import('../src/config/queueConfig.js'),
    import('../src/workers/registry.js'),
    import('../src/utils/mailer.js'),
  ]);

const {
  buildInterviewReminderJobId,
  buildOfferReminderJobId,
  buildOfferExpireJobId,
  scheduleInterviewReminder,
  scheduleOfferJobs,
  cancelInterviewReminder,
  cancelOfferJobs,
  runScheduledReconcile,
  deliverInterviewReminder,
} = scheduler;
const {
  interviewReminderProcessor,
  offerExpiryReminderProcessor,
  offerExpireProcessor,
} = scheduledProcessor;
const { isInterviewEventStale, validateEmailJobPayload } = emailProcessor;
const {
  JOB_NAMES,
  parseScheduledWorkerConcurrency,
  getOfferReminderOffsetMs,
  getScheduledJobOptions,
} = queueConfig;

const COMPANY_ID = '64c000000000000000000401';
const COMPANY_B = '64c000000000000000000402';
const INTERVIEW_ID = '64c000000000000000000403';
const CANDIDATE_ID = '64c000000000000000000404';
const INTERVIEWER_ID = '64c000000000000000000405';
const OFFER_ID = '64c000000000000000000406';

const H = 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * 24 * H);
const iso = (d) => new Date(d).toISOString();

// FIXED timestamps shared by fixtures AND payloads — version checks
// compare ISO strings, so fixtures must not drift by milliseconds
// between "what Mongo holds" and "what the job references".
const INTERVIEW_START = inDays(3);
const OFFER_EXPIRY = inDays(10);

const fakeInterview = (overrides = {}) => ({
  _id: INTERVIEW_ID,
  companyId: COMPANY_ID,
  candidate: CANDIDATE_ID,
  interviewers: [INTERVIEWER_ID],
  status: 'SCHEDULED',
  scheduledStartAt: INTERVIEW_START,
  reminderDispatch: {
    state: 'PENDING',
    dispatchAfter: new Date(INTERVIEW_START.getTime() - 24 * H),
    claimedAt: null,
    dispatchedAt: null,
    attempts: 0,
    lastError: '',
  },
  ...overrides,
});

const fakeOffer = (overrides = {}) => ({
  _id: OFFER_ID,
  companyId: COMPANY_ID,
  candidate: CANDIDATE_ID,
  status: 'SENT',
  terms: { expiryDate: OFFER_EXPIRY },
  ...overrides,
});

const interviewPayload = (overrides = {}) => ({
  companyId: COMPANY_ID,
  interviewId: INTERVIEW_ID,
  scheduledStartAtIso: iso(INTERVIEW_START),
  correlationId: 'corr-1',
  ...overrides,
});

const offerPayload = (overrides = {}) => ({
  companyId: COMPANY_ID,
  offerId: OFFER_ID,
  expiryDateIso: iso(OFFER_EXPIRY),
  correlationId: 'corr-1',
  ...overrides,
});

const job = (data) => ({ data, name: JOB_NAMES.INTERVIEW_REMINDER });

// ── Job id builders ────────────────────────────────────────────

test('interview reminder job id: deterministic, colon-free, version-aware', () => {
  const startAt = inDays(3);
  const a = buildInterviewReminderJobId(INTERVIEW_ID, startAt);
  const b = buildInterviewReminderJobId(INTERVIEW_ID, startAt);
  assert.equal(a, b);
  assert.match(a, /^interview-reminder-[a-f0-9]{24}-\d+$/);
  assert.ok(!a.includes(':'), 'job id must not contain a colon');
  assert.ok(a.length < 150, 'job id stays well under BullMQ key limits');
  // A different startAt (reschedule) is a different version.
  assert.notEqual(a, buildInterviewReminderJobId(INTERVIEW_ID, inDays(4)));
});

test('offer reminder/expiry job ids: deterministic, version-aware', () => {
  const expiry = inDays(10);
  const r = buildOfferReminderJobId(OFFER_ID, expiry);
  const e = buildOfferExpireJobId(OFFER_ID, expiry);
  assert.match(r, /^offer-reminder-[a-f0-9]{24}-\d+$/);
  assert.match(e, /^offer-expire-[a-f0-9]{24}-\d+$/);
  assert.notEqual(r, e);
  assert.notEqual(r, buildOfferReminderJobId(OFFER_ID, inDays(11)));
  assert.notEqual(e, buildOfferExpireJobId(OFFER_ID, inDays(11)));
  assert.ok(!r.includes(':') && !e.includes(':'));
});

test('job id builders reject malformed ids/dates', () => {
  assert.equal(buildInterviewReminderJobId('nope', inDays(3)), null);
  assert.equal(buildInterviewReminderJobId(INTERVIEW_ID, null), null);
  assert.equal(buildOfferReminderJobId(OFFER_ID, 'garbage'), null);
  assert.equal(buildOfferExpireJobId(null, inDays(10)), null);
});

// ── Scheduling: interview reminders ────────────────────────────

test('scheduleInterviewReminder: future start → delayed job at the policy time', async () => {
  const calls = [];
  const interview = fakeInterview(); // 3 days out → 24h-before = 48h from now
  const res = await scheduleInterviewReminder(interview, {
    enqueue: async (jobId, data, delay) => calls.push({ jobId, data, delay }),
  });
  assert.equal(res.scheduled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].jobId, buildInterviewReminderJobId(INTERVIEW_ID, interview.scheduledStartAt));
  const expectedDelay = interview.reminderDispatch.dispatchAfter.getTime() - Date.now();
  assert.ok(Math.abs(calls[0].delay - expectedDelay) < 5000, 'delay ≈ reminderDispatch.dispatchAfter');
  assert.ok(calls[0].delay > 24 * H, '24h-before policy for a 3-day-out interview');
  const data = calls[0].data;
  assert.deepEqual(Object.keys(data).sort(), ['companyId', 'correlationId', 'interviewId', 'scheduledStartAtIso']);
  assert.equal(data.companyId, COMPANY_ID);
  assert.equal(data.interviewId, INTERVIEW_ID);
  // No PII, tokens, or links in the transport payload.
  const serialized = JSON.stringify(data);
  for (const forbidden of ['@', 'http', 'token', 'Name', 'email', 'link']) {
    assert.ok(!serialized.includes(forbidden), `payload must not contain "${forbidden}"`);
  }
  assert.ok(serialized.length < 512, 'payload stays compact');
});

test('scheduleInterviewReminder: past startAt → NOT_ELIGIBLE, no enqueue', async () => {
  const calls = [];
  const res = await scheduleInterviewReminder(
    fakeInterview({ scheduledStartAt: new Date(Date.now() - H) }),
    { enqueue: async (...args) => calls.push(args) }
  );
  assert.equal(res.scheduled, false);
  assert.equal(res.reason, 'ALREADY_STARTED');
  assert.equal(calls.length, 0);
});

test('scheduleInterviewReminder: terminal statuses are never scheduled', async () => {
  for (const status of ['CANCELLED', 'COMPLETED', 'NO_SHOW', 'IN_PROGRESS']) {
    const calls = [];
    const res = await scheduleInterviewReminder(fakeInterview({ status }), {
      enqueue: async (...args) => calls.push(args),
    });
    assert.equal(res.scheduled, false, `${status} must not schedule`);
    assert.equal(calls.length, 0);
  }
});

// ── Scheduling: offer jobs ─────────────────────────────────────

test('scheduleOfferJobs: 10-day expiry → reminder at expiry−48h + expiry at expiryDate', async () => {
  const calls = [];
  const offer = fakeOffer();
  const res = await scheduleOfferJobs(offer, {
    enqueue: async (jobId, data, delay) => calls.push({ jobId, data, delay }),
  });
  assert.equal(res.reminder.scheduled, true);
  assert.equal(res.expiry.scheduled, true);
  assert.equal(calls.length, 2);
  const [reminder, expiry] = calls;
  assert.equal(reminder.jobId, buildOfferReminderJobId(OFFER_ID, offer.terms.expiryDate));
  assert.equal(expiry.jobId, buildOfferExpireJobId(OFFER_ID, offer.terms.expiryDate));
  const offset = getOfferReminderOffsetMs({});
  assert.ok(
    Math.abs(reminder.delay - (offer.terms.expiryDate.getTime() - Date.now() - offset)) < 5000,
    'reminder delay ≈ expiry − 48h − now'
  );
  assert.ok(expiry.delay > 0 && expiry.delay <= offer.terms.expiryDate.getTime() - Date.now() + 5000);
  for (const c of calls) {
    assert.deepEqual(Object.keys(c.data).sort(), ['companyId', 'correlationId', 'expiryDateIso', 'offerId']);
  }
});

test('scheduleOfferJobs: expiry inside the 48h window → NO reminder, expiry job still scheduled', async () => {
  const calls = [];
  const offer = fakeOffer({ terms: { expiryDate: new Date(Date.now() + 2 * H) } });
  const res = await scheduleOfferJobs(offer, {
    enqueue: async (jobId, data, delay) => calls.push({ jobId, delay }),
  });
  assert.equal(res.reminder.scheduled, false);
  assert.equal(res.reminder.reason, 'WITHIN_OFFSET_WINDOW');
  assert.equal(res.expiry.scheduled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].jobId, buildOfferExpireJobId(OFFER_ID, offer.terms.expiryDate));
});

test('scheduleOfferJobs: expiry already past → immediate expiry job (delay 0), no reminder', async () => {
  const calls = [];
  const offer = fakeOffer({ terms: { expiryDate: new Date(Date.now() - H) } });
  const res = await scheduleOfferJobs(offer, {
    enqueue: async (jobId, data, delay) => calls.push({ jobId, delay }),
  });
  assert.equal(res.reminder.scheduled, false);
  assert.equal(res.expiry.scheduled, true);
  assert.equal(calls[0].delay, 0, 'past expiry runs immediately; the atomic service revalidates');
});

test('scheduleOfferJobs: only SENT/VIEWED are eligible', async () => {
  for (const status of ['DRAFT', 'APPROVED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED']) {
    const calls = [];
    const res = await scheduleOfferJobs(fakeOffer({ status }), {
      enqueue: async (...args) => calls.push(args),
    });
    assert.equal(res.reminder.scheduled, false, `${status}`);
    assert.equal(res.expiry.scheduled, false, `${status}`);
    assert.equal(calls.length, 0);
  }
});

// ── Scheduling: never throws (intent survives outages) ─────────

test('scheduling never throws when the queue is unavailable', async () => {
  const res = await scheduleInterviewReminder(fakeInterview(), {
    enqueue: async () => {
      throw new Error('ECONNREFUSED 10.0.0.5:6379');
    },
  });
  assert.equal(res.scheduled, false);
  assert.match(res.error, /queue unavailable|ECONNREFUSED/i);
});

// ── Worker: INTERVIEW_REMINDER revalidation ────────────────────

test('interview reminder: valid future SCHEDULED → claimed + delivered + marked', async () => {
  const interview = fakeInterview();
  const marks = [];
  const res = await interviewReminderProcessor(job(interviewPayload()), {
    load: async () => interview,
    deliver: async (interviewed) => {
      marks.push('delivered:' + interviewed._id);
      return { recipients: 2 };
    },
    claim: async () => {
      marks.push('claim');
      return interview;
    },
    markDelivered: async () => marks.push('marked-delivered'),
    markFailed: async () => marks.push('marked-failed'),
  });
  assert.deepEqual(res, { processed: true, recipients: 2 });
  assert.deepEqual(marks, ['claim', 'delivered:64c000000000000000000403', 'marked-delivered']);
});

test('interview reminder: in-flight claim (fresh CLAIMED) → skipped, no double delivery', async () => {
  const res = await interviewReminderProcessor(job(interviewPayload()), {
    load: async () => fakeInterview(),
    deliver: async () => assert.fail('must not deliver while in flight'),
    claim: async () => null,
  });
  assert.deepEqual(res, { skipped: true, reason: 'IN_FLIGHT_OR_DONE' });
});

test('interview reminder: reschedule mismatch → STALE_SCHEDULE (old job safe to skip)', async () => {
  const res = await interviewReminderProcessor(
    job(interviewPayload({ scheduledStartAtIso: iso(inDays(2)) })),
    {
      // Mongo now holds the NEW startAt (3 days out) — the job still
      // references the old one (2 days out).
      load: async () => fakeInterview(),
      deliver: async () => assert.fail('must not deliver'),
    }
  );
  assert.deepEqual(res, { skipped: true, reason: 'STALE_SCHEDULE' });
});

test('interview reminder: cancelled/completed/no-show → TERMINAL_STATE', async () => {
  for (const status of ['CANCELLED', 'COMPLETED', 'NO_SHOW']) {
    const res = await interviewReminderProcessor(job(interviewPayload()), {
      load: async () => fakeInterview({ status }),
      deliver: async () => assert.fail('must not deliver'),
    });
    assert.equal(res.skipped, true, status);
    assert.equal(res.reason, 'TERMINAL_STATE', status);
  }
});

test('interview reminder: interview already started → skip', async () => {
  const started = new Date(Date.now() - 5 * 60 * 1000);
  const res = await interviewReminderProcessor(
    job(interviewPayload({ scheduledStartAtIso: iso(started) })),
    {
      load: async () =>
        fakeInterview({ scheduledStartAt: started, reminderDispatch: { state: 'PENDING' } }),
      deliver: async () => assert.fail('must not deliver'),
    }
  );
  assert.equal(res.reason, 'INTERVIEW_STARTED');
});

test('interview reminder: already DELIVERED → ALREADY_REMINDED (idempotent replay)', async () => {
  const res = await interviewReminderProcessor(job(interviewPayload()), {
    load: async () => fakeInterview({ reminderDispatch: { state: 'DELIVERED' } }),
    deliver: async () => assert.fail('must not deliver twice'),
  });
  assert.equal(res.reason, 'ALREADY_REMINDED');
});

test('interview reminder: cross-tenant id → NOT_FOUND (tenant scope)', async () => {
  const res = await interviewReminderProcessor(job(interviewPayload()), {
    // The load simulates a tenant-scoped query: the id exists but in
    // ANOTHER company → findOne({_id, companyId}) returns null.
    load: async () => null,
    deliver: async () => assert.fail('must not deliver'),
  });
  assert.equal(res.reason, 'NOT_FOUND');
});

test('interview reminder: deliver failure marks FAILED and propagates (BullMQ retries)', async () => {
  const marks = [];
  await assert.rejects(
    interviewReminderProcessor(job(interviewPayload()), {
      load: async () => fakeInterview(),
      deliver: async () => {
        throw new Error('email queue unavailable');
      },
      claim: async () => fakeInterview(),
      markDelivered: async () => marks.push('delivered'),
      markFailed: async (interview, value, message) => {
        marks.push(`failed:${message}`);
      },
    }),
    /email queue unavailable/
  );
  assert.deepEqual(marks, ['failed:email queue unavailable']);
});

test('interview reminder: PII or unknown payload keys rejected', async () => {
  for (const bad of [
    { candidateName: 'Jane' },
    { candidateEmail: 'jane@example.com' },
    { meetingLink: 'https://meet.example.com/x' },
    { offerToken: 'raw-token' },
    { extra: 'unknown' },
  ]) {
    await assert.rejects(
      interviewReminderProcessor(job({ ...interviewPayload(), ...bad }), {
        load: async () => fakeInterview(),
        deliver: async () => assert.fail('must not deliver'),
      }),
      /payload validation failed/
    );
  }
  // Missing required reference also rejected.
  const { correlationId: _drop, ...missing } = interviewPayload();
  await assert.rejects(
    interviewReminderProcessor(job(missing), { load: async () => fakeInterview() }),
    /payload validation failed/
  );
});

// ── Worker: OFFER_EXPIRY_REMINDER revalidation ─────────────────

test('offer reminder: SENT + matching future expiry → dispatched via 28.3 email queue', async () => {
  const offer = fakeOffer();
  const dispatchCalls = [];
  const res = await offerExpiryReminderProcessor(job(offerPayload()), {
    load: async () => offer,
    dispatch: async (args) => {
      dispatchCalls.push(args);
      return { queued: true, duplicate: false };
    },
  });
  assert.deepEqual(res, { processed: true });
  const args = dispatchCalls[0];
  assert.equal(args.jobName, JOB_NAMES.EMAIL_OFFER_REMINDER);
  assert.equal(args.eventType, 'OFFER_REMINDER');
  assert.equal(args.companyId, COMPANY_ID);
  assert.equal(args.entityType, 'OFFER');
  assert.equal(args.recipientType, 'CANDIDATE');
  assert.deepEqual(args.payload, {
    offerId: OFFER_ID,
    expiryDateIso: iso(offer.terms.expiryDate),
  });
  // The eventKey makes the reminder idempotent across replays.
  assert.match(args.eventKey, /OFFER_REMINDER/);
});

test('offer reminder: accepted/rejected/withdrawn → TERMINAL_STATE', async () => {
  for (const status of ['ACCEPTED', 'REJECTED', 'WITHDRAWN']) {
    const res = await offerExpiryReminderProcessor(job(offerPayload()), {
      load: async () => fakeOffer({ status }),
      dispatch: async () => assert.fail('must not dispatch'),
    });
    assert.equal(res.reason, 'TERMINAL_STATE', status);
  }
});

test('offer reminder: revised expiry → STALE_EXPIRY; past expiry → EXPIRED', async () => {
  const stale = await offerExpiryReminderProcessor(
    job(offerPayload({ expiryDateIso: iso(inDays(9)) })),
    {
      load: async () => fakeOffer(), // Mongo holds 10 days
      dispatch: async () => assert.fail('must not dispatch'),
    }
  );
  assert.equal(stale.reason, 'STALE_EXPIRY');

  const pastExpiry = new Date(Date.now() - H);
  const past = await offerExpiryReminderProcessor(
    job(offerPayload({ expiryDateIso: iso(pastExpiry) })), // job created for THIS expiry
    {
      load: async () => fakeOffer({ terms: { expiryDate: pastExpiry } }),
      dispatch: async () => assert.fail('must not dispatch'),
    }
  );
  assert.equal(past.reason, 'EXPIRED');
});

test('offer reminder: dispatch failure throws (retry); duplicate does not', async () => {
  await assert.rejects(
    offerExpiryReminderProcessor(job(offerPayload()), {
      load: async () => fakeOffer(),
      dispatch: async () => ({ queued: false, duplicate: false, error: 'redis down' }),
    }),
    /email dispatch unavailable/
  );
  const res = await offerExpiryReminderProcessor(job(offerPayload()), {
    load: async () => fakeOffer(),
    dispatch: async () => ({ queued: false, duplicate: true }),
  });
  assert.deepEqual(res, { processed: true }, 'a duplicate event is already handled');
});

// ── Worker: OFFER_EXPIRE (atomic service only) ─────────────────

test('offer expire: due offer → transitioned via expireOfferIfDue, never inline', async () => {
  const offer = fakeOffer({ terms: { expiryDate: new Date(Date.now() - 5 * 60 * 1000) } });
  let expireArgs = null;
  const res = await offerExpireProcessor(
    job(offerPayload({ expiryDateIso: iso(offer.terms.expiryDate) })),
    {
      load: async () => offer,
      expire: async (args) => {
        expireArgs = args;
        return { _id: offer._id, status: 'EXPIRED' }; // a NEW doc (transitioned)
      },
    }
  );
  assert.deepEqual(res, { processed: true, transitioned: true });
  assert.equal(expireArgs.requestContext, null, 'worker passes no HTTP context');
  assert.equal(String(expireArgs.offer._id), OFFER_ID);
});

test('offer expire: ACCEPTED never expires (atomic service no-op → terminal skip)', async () => {
  const res = await offerExpireProcessor(job(offerPayload()), {
    load: async () => fakeOffer({ status: 'ACCEPTED' }),
    expire: async (args) => args.offer, // same ref = no transition
  });
  assert.deepEqual(res, { skipped: true, reason: 'TERMINAL_STATE' });
});

test('offer expire: already EXPIRED → ALREADY_EXPIRED; future due-date → NOT_DUE', async () => {
  const already = await offerExpireProcessor(job(offerPayload()), {
    load: async () => fakeOffer({ status: 'EXPIRED' }),
    expire: async (args) => args.offer,
  });
  assert.equal(already.reason, 'ALREADY_EXPIRED');

  const notDue = await offerExpireProcessor(job(offerPayload()), {
    load: async () => fakeOffer({ terms: { expiryDate: OFFER_EXPIRY } }),
    expire: async (args) => args.offer,
  });
  assert.equal(notDue.reason, 'NOT_DUE');
});

test('offer expire: revised expiry in Mongo → STALE_EXPIRY (new version owns it)', async () => {
  const res = await offerExpireProcessor(
    job(offerPayload({ expiryDateIso: iso(inDays(10)) })),
    {
      load: async () => fakeOffer({ terms: { expiryDate: inDays(12) } }),
      expire: async () => assert.fail('must not expire a stale version'),
    }
  );
  assert.equal(res.reason, 'STALE_EXPIRY');
});

test('offer expire: cross-tenant id → NOT_FOUND', async () => {
  const res = await offerExpireProcessor(job(offerPayload()), {
    load: async () => null,
    expire: async () => assert.fail('must not expire'),
  });
  assert.equal(res.reason, 'NOT_FOUND');
});

// ── Email-queue guards (28.3 surface) ──────────────────────────

test('isInterviewEventStale: REMINDER valid only for active upcoming schedules', () => {
  const version = iso(inDays(3));
  assert.equal(
    isInterviewEventStale({ currentStatus: 'SCHEDULED', currentStartAtIso: version, eventType: 'REMINDER', scheduleVersion: version }),
    false
  );
  assert.equal(
    isInterviewEventStale({ currentStatus: 'RESCHEDULED', currentStartAtIso: version, eventType: 'REMINDER', scheduleVersion: version }),
    false
  );
  // Reschedule superseded the reminder's version.
  assert.equal(
    isInterviewEventStale({ currentStatus: 'RESCHEDULED', currentStartAtIso: iso(inDays(5)), eventType: 'REMINDER', scheduleVersion: version }),
    true
  );
  // Terminal statuses are never reminded.
  for (const status of ['CANCELLED', 'COMPLETED', 'NO_SHOW']) {
    assert.equal(
      isInterviewEventStale({ currentStatus: status, currentStartAtIso: version, eventType: 'REMINDER', scheduleVersion: version }),
      true,
      status
    );
  }
  // Existing behavior preserved.
  assert.equal(
    isInterviewEventStale({ currentStatus: 'SCHEDULED', currentStartAtIso: version, eventType: 'SCHEDULED', scheduleVersion: version }),
    false
  );
  assert.equal(
    isInterviewEventStale({ currentStatus: 'RESCHEDULED', currentStartAtIso: version, eventType: 'SCHEDULED', scheduleVersion: version }),
    true
  );
});

test('validateEmailJobPayload: EMAIL_OFFER_REMINDER accepts references only', () => {
  const base = {
    deliveryId: '64c000000000000000000407',
    correlationId: 'corr-1',
    companyId: COMPANY_ID,
    offerId: OFFER_ID,
    expiryDateIso: iso(inDays(10)),
  };
  assert.equal(validateEmailJobPayload(JOB_NAMES.EMAIL_OFFER_REMINDER, base).valid, true);
  assert.equal(
    validateEmailJobPayload(JOB_NAMES.EMAIL_OFFER_REMINDER, { ...base, portalUrl: 'https://x/t' }).valid,
    false,
    'token-bearing links are not a valid payload key'
  );
  assert.equal(
    validateEmailJobPayload(JOB_NAMES.EMAIL_OFFER_REMINDER, { ...base, candidateName: 'Jane' }).valid,
    false,
    'PII is not a valid payload key'
  );
  assert.equal(
    validateEmailJobPayload(JOB_NAMES.EMAIL_OFFER_REMINDER, { ...base, expiryDateIso: 12345 }).valid,
    false,
    'the expiry version must be an ISO string'
  );
});

// ── Reconcile selection ────────────────────────────────────────

test('runScheduledReconcile: re-derives jobs from Mongo intent, skips in-window offers', async () => {
  const enqueued = [];
  const now = new Date();
  const interviews = [
    fakeInterview(), // PENDING, 3 days out → schedule
    fakeInterview({ status: 'RESCHEDULED', _id: '64c000000000000000000413' }), // → schedule
  ];
  const offers = [
    fakeOffer({ terms: { expiryDate: inDays(10) } }), // → reminder + expiry
    fakeOffer({ _id: '64c000000000000000000414', terms: { expiryDate: new Date(now.getTime() + 2 * H) } }), // expiry only
  ];
  const summary = await runScheduledReconcile({
    now,
    enqueue: async (jobId, data, delay) => enqueued.push({ jobId, delay }),
    loadInterviews: async () => interviews,
    loadOffers: async () => offers,
  });
  assert.equal(summary.interviews.checked, 2);
  assert.equal(summary.interviews.scheduled, 2);
  assert.equal(summary.offers.checked, 2);
  assert.equal(summary.offers.reminders, 1, 'only the 10-day offer gets a reminder');
  assert.equal(summary.offers.expiries, 2, 'both get an expiry job');
  assert.equal(enqueued.length, 5);
  // Deterministic ids: re-running enqueues the same ids (BullMQ dedupes).
  const again = await runScheduledReconcile({
    now,
    enqueue: async (jobId, data, delay) => enqueued.push({ jobId, delay }),
    loadInterviews: async () => interviews,
    loadOffers: async () => offers,
  });
  const firstIds = enqueued.slice(0, 5).map((e) => e.jobId).sort();
  const secondIds = enqueued.slice(5).map((e) => e.jobId).sort();
  assert.deepEqual(firstIds, secondIds, 'reconciliation is idempotent by job id');
  assert.equal(again.interviews.scheduled, 2);
});

test('runScheduledReconcile: bounded windows are passed to the loaders', async () => {
  const seen = [];
  await runScheduledReconcile({
    now: new Date(),
    windowDays: 14,
    offerWindowDays: 90,
    limit: 100,
    enqueue: async () => {},
    loadInterviews: async (args) => {
      seen.push(['interviews', args.windowDays, args.limit]);
      return [];
    },
    loadOffers: async (args) => {
      seen.push(['offers', args.windowDays, args.limit]);
      return [];
    },
  });
  assert.deepEqual(seen[0], ['interviews', 14, 100]);
  assert.deepEqual(seen[1], ['offers', 90, 100]);
});

// ── Cancellation guards ────────────────────────────────────────

test('cancellation guards: null inputs resolve to absent (no Redis touch)', async () => {
  assert.equal(await cancelInterviewReminder(null, null), 'absent');
  assert.deepEqual(await cancelOfferJobs(null), ['absent', 'absent']);
});

// ── Config: concurrency + offset parsing ───────────────────────

test('parseScheduledWorkerConcurrency: default 4, clamped 1-10', () => {
  assert.equal(parseScheduledWorkerConcurrency({}), 4);
  assert.equal(parseScheduledWorkerConcurrency({ SCHEDULED_WORKER_CONCURRENCY: '7' }), 7);
  assert.equal(parseScheduledWorkerConcurrency({ SCHEDULED_WORKER_CONCURRENCY: '12' }), 10);
  assert.equal(parseScheduledWorkerConcurrency({ SCHEDULED_WORKER_CONCURRENCY: '0' }), 4);
  assert.equal(parseScheduledWorkerConcurrency({ SCHEDULED_WORKER_CONCURRENCY: 'garbage' }), 4);
});

test('getOfferReminderOffsetMs: default 48h, clamped 1-168h', () => {
  assert.equal(getOfferReminderOffsetMs({}), 48 * H);
  assert.equal(getOfferReminderOffsetMs({ OFFER_REMINDER_OFFSET_HOURS: '12' }), 12 * H);
  assert.equal(getOfferReminderOffsetMs({ OFFER_REMINDER_OFFSET_HOURS: '1' }), 1 * H);
  assert.equal(getOfferReminderOffsetMs({ OFFER_REMINDER_OFFSET_HOURS: '999' }), 168 * H);
  assert.equal(getOfferReminderOffsetMs({ OFFER_REMINDER_OFFSET_HOURS: '0' }), 48 * H);
  assert.equal(getOfferReminderOffsetMs({ OFFER_REMINDER_OFFSET_HOURS: 'x' }), 48 * H);
});

test('SCHEDULED job options: bounded retries with exponential backoff', () => {
  const options = getScheduledJobOptions();
  assert.equal(options.attempts, 3);
  assert.equal(options.backoff.type, 'exponential');
  assert.ok(options.backoff.delay > 0);
  assert.equal(options.removeOnComplete.count, 100);
});

// ── Worker wiring (registry dispatch path) ─────────────────────

test('wiring: scheduled + email processors register into the shared dispatch registry', () => {
  scheduledProcessor.registerScheduledProcessors({ registerProcessor: registry.registerProcessor });
  emailProcessor.registerEmailProcessors({ registerProcessor: registry.registerProcessor });

  for (const name of [
    JOB_NAMES.INTERVIEW_REMINDER,
    JOB_NAMES.OFFER_EXPIRY_REMINDER,
    JOB_NAMES.OFFER_EXPIRE,
  ]) {
    assert.ok(registry.jobRegistry.has(name), `registry must route ${name}`);
  }
  for (const name of queueConfig.EMAIL_JOB_NAMES) {
    assert.ok(registry.jobRegistry.has(name), `registry must route ${name}`);
  }
  // dispatchJob resolves by job name (what the Worker calls).
  assert.equal(typeof registry.dispatchJob, 'function');
});

test('wiring: dispatchJob rejects unknown job names (no silent no-op)', async () => {
  await assert.rejects(
    registry.dispatchJob({ name: 'bogus-job', data: {} }),
    /No processor registered/
  );
});

// ── deliverInterviewReminder dispatch contract ─────────────────

test('deliverInterviewReminder: candidate + each interviewer → one 28.3 dispatch, distinct eventKeys', async () => {
  const secondInterviewer = '64c000000000000000000415';
  const interview = fakeInterview({ interviewers: [INTERVIEWER_ID, secondInterviewer] });
  const calls = [];
  const res = await deliverInterviewReminder(interview, {
    loadCandidate: async () => ({ _id: CANDIDATE_ID }),
    dispatch: async (args) => {
      calls.push(args);
      return { queued: true, duplicate: false };
    },
  });
  assert.equal(res.recipients, 3); // candidate + 2 interviewers
  assert.equal(calls.length, 3);
  const [candidateCall, interviewerCall] = calls;
  assert.equal(calls[2].payload.interviewerId, secondInterviewer);
  // Candidate + both interviewers: three distinct idempotency keys.
  const keys = calls.map((c) => c.eventKey);
  assert.equal(new Set(keys).size, 3);
  assert.equal(candidateCall.jobName, JOB_NAMES.EMAIL_INTERVIEW_CANDIDATE);
  assert.equal(candidateCall.recipientType, 'CANDIDATE');
  assert.equal(interviewerCall.jobName, JOB_NAMES.EMAIL_INTERVIEW_INTERVIEWER);
  assert.equal(interviewerCall.recipientType, 'INTERVIEWER');
  for (const call of calls) {
    assert.equal(call.eventType, 'REMINDER');
    assert.equal(call.entityType, 'INTERVIEW');
    assert.equal(call.companyId, COMPANY_ID);
    assert.equal(call.payload.eventType, 'REMINDER');
    assert.equal(call.payload.scheduleVersion, iso(interview.scheduledStartAt));
    // References only in the email job payload.
    const serialized = JSON.stringify(call.payload);
    assert.ok(!/http|@|token/i.test(serialized));
  }
  assert.notEqual(candidateCall.eventKey, interviewerCall.eventKey);
  assert.match(candidateCall.eventKey, /INTERVIEW_CANDIDATE_REMINDER/);
  assert.match(interviewerCall.eventKey, /INTERVIEW_INTERVIEWER_REMINDER/);
});

test('deliverInterviewReminder: no candidate → no dispatch, zero recipients', async () => {
  const res = await deliverInterviewReminder(fakeInterview(), {
    loadCandidate: async () => null,
    dispatch: async () => assert.fail('must not dispatch'),
  });
  assert.deepEqual(res, { recipients: 0 });
});

test('deliverInterviewReminder: zero accepted intents → throw (job retries)', async () => {
  await assert.rejects(
    deliverInterviewReminder(fakeInterview(), {
      loadCandidate: async () => ({ _id: CANDIDATE_ID }),
      dispatch: async () => ({ queued: false, duplicate: false, error: 'redis down' }),
    }),
    /email dispatch unavailable/
  );
});

test('deliverInterviewReminder: duplicates count as accepted (idempotent replay)', async () => {
  const res = await deliverInterviewReminder(fakeInterview({ interviewers: [] }), {
    loadCandidate: async () => ({ _id: CANDIDATE_ID }),
    dispatch: async () => ({ queued: false, duplicate: true }),
  });
  assert.equal(res.recipients, 1); // candidate only, replayed via eventKey dedupe
});

// ── dispatchAfter fallback (policy re-derivation) ──────────────

test('scheduleInterviewReminder: missing dispatchAfter falls back to the policy', async () => {
  const calls = [];
  const interview = fakeInterview({ reminderDispatch: { state: 'PENDING', dispatchAfter: null } });
  await scheduleInterviewReminder(interview, {
    enqueue: async (jobId, data, delay) => calls.push({ delay }),
  });
  // 3 days out → 24h-before → ~48h from now.
  const expected = interview.scheduledStartAt.getTime() - 24 * H - Date.now();
  assert.ok(Math.abs(calls[0].delay - expected) < 5000, 'policy fallback ≈ 24h-before');
});

// ── Reconcile error accounting ─────────────────────────────────

test('runScheduledReconcile: loader failures are counted, never fatal', async () => {
  const summary = await runScheduledReconcile({
    enqueue: async () => {},
    loadInterviews: async () => {
      throw new Error('mongo blip');
    },
    loadOffers: async () => [fakeOffer()],
  });
  assert.ok(summary.interviews.errors >= 1);
  assert.equal(summary.offers.checked, 1);
  assert.equal(summary.offers.expiries, 1);
});

// ── Mailer templates (REMINDER variants + offer nudge) ─────────

test('candidateInterviewEmail: REMINDER renders as a reminder, SCHEDULED unchanged', () => {
  const base = {
    candidateName: 'Jane',
    companyName: 'Acme',
    jobTitle: 'Engineer',
    interviewCode: 'INT-1',
    roundName: 'Technical',
    scheduleLabel: 'Mon, 1 Sep 2026, 03:00 pm (Asia/Kolkata)',
    interviewType: 'ONLINE',
  };
  const reminder = mailer.candidateInterviewEmail({ ...base, event: 'REMINDER' });
  assert.match(reminder.subject, /^Interview reminder — Acme$/);
  assert.match(reminder.text, /This is a reminder that your Technical interview/);
  assert.match(reminder.html, /Interview reminder/);

  const scheduled = mailer.candidateInterviewEmail({ ...base, event: 'SCHEDULED' });
  assert.match(scheduled.subject, /^Interview scheduled — Acme$/);
  assert.match(scheduled.text, /has been scheduled/);
});

test('interviewerAssignmentEmail: REMINDER says "is scheduled" (no "has been reminder")', () => {
  const base = {
    interviewerName: 'Bob',
    candidateName: 'Jane',
    candidateEmail: 'jane@example.com',
    companyName: 'Acme',
    jobTitle: 'Engineer',
    interviewCode: 'INT-1',
    roundName: 'Technical',
    scheduleLabel: 'Mon, 1 Sep 2026, 03:00 pm (Asia/Kolkata)',
    interviewType: 'ONLINE',
  };
  const reminder = mailer.interviewerAssignmentEmail({ ...base, event: 'REMINDER' });
  assert.match(reminder.subject, /^Interview reminder — Technical$/);
  assert.match(reminder.text, /is scheduled/);
  assert.ok(!/has been reminder/i.test(reminder.text + reminder.html));
});

test('offerReminderEmail: non-sensitive nudge — no token, no URL, no compensation', () => {
  const offer = fakeOffer();
  offer.candidateSnapshot = { name: 'Jane' };
  offer.companySnapshot = { name: 'Acme' };
  offer.terms = { ...offer.terms, designation: 'Engineer' };
  offer.offerCode = 'OF-1';
  const msg = mailer.offerReminderEmail({ offer });
  assert.match(msg.subject, /^Offer response reminder — Acme$/);
  assert.match(msg.text, /OF-1/);
  assert.match(msg.text, /Engineer/);
  assert.match(msg.text, /secure link from your original offer email/);
  const all = msg.text + msg.html;
  assert.ok(!/https?:\/\//i.test(all), 'no portal URL (token would ride on it)');
  assert.ok(!/token/i.test(all), 'no token language');
  assert.ok(!/\$|₹|INR|salary|CTC/i.test(all), 'no compensation figures');
});
