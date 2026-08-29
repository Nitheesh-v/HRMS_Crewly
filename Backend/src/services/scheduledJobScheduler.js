// ============================================================
// ⏰ PHASE 28.5 — SCHEDULED JOB SCHEDULER (delayed BullMQ jobs)
//
// Single scheduling adapter for time-based recruitment operations
// (§34): domain services call these AFTER their business commit;
// they never touch controllers and never fail a business operation.
//
// INTENT VS TRANSPORT (the 28.3/28.4 rule, applied to scheduling):
//   - MongoDB is the scheduling truth: Interview.scheduledStartAt +
//     reminderDispatch, OfferLetter.terms.expiryDate. Redis only
//     knows "run this at X". Jobs are rebuilt by
//     `npm run scheduled:reconcile` from Mongo state — a queue/Redis
//     failure at schedule time loses nothing.
//   - There is NO synchronous reminder fallback.
//
// One-time future execution uses native BullMQ delayed jobs
// (queue.add with { delay }) — no QueueScheduler (deprecated, and
// 28.5 needs no recurring schedules).
//
// JOB IDS (colon-free, deterministic, Mongo-reconstructable). The
// canonical timestamp IS the version:
//   interview-reminder-<interviewId>-<scheduledStartAtMs>
//   offer-reminder-<offerId>-<expiryDateMs>
//   offer-expire-<offerId>-<expiryDateMs>
// Reschedule / revised expiry → new timestamp → new id; superseded
// jobs are removed best-effort AND validated stale at execution.
//
// PAYLOADS (references only — validated again by the worker):
//   interview-reminder: { companyId, interviewId, scheduledStartAtIso,
//                         correlationId }
//   offer-expiry-reminder / offer-expire:
//     { companyId, offerId, expiryDateIso, correlationId }
// Never: names, emails, meeting links, tokens, compensation.
// ============================================================

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import logger from '../config/logger.js';
import { getQueue, enqueueJob, prepareJobSlot } from '../queues/queueFactory.js';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  getScheduledJobOptions,
  getOfferReminderOffsetMs,
  redactConnectionSecrets,
} from '../config/queueConfig.js';
import { reminderDispatchAfter } from '../utils/interviewDateTime.js';
import {
  buildEventKey,
  requestEmailDelivery,
} from './emailDeliveryService.js';
import Candidate from '../models/Candidate.js';
import Interview from '../models/Interview.js';
import OfferLetter from '../models/OfferLetter.js';

const safeIdSegment = (value) =>
  /^[a-f0-9]{24}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';

const toEpochMs = (value) => {
  if (value === null || value === undefined) return null;
  const ms = Math.trunc(Number(value?.getTime?.() ?? value));
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

export const buildInterviewReminderJobId = (interviewId, scheduledStartAt) => {
  const id = safeIdSegment(interviewId);
  const epoch = toEpochMs(scheduledStartAt);
  if (!id || epoch === null) return null;
  return `interview-reminder-${id}-${epoch}`;
};

export const buildOfferReminderJobId = (offerId, expiryDate) => {
  const id = safeIdSegment(offerId);
  const epoch = toEpochMs(expiryDate);
  if (!id || epoch === null) return null;
  return `offer-reminder-${id}-${epoch}`;
};

export const buildOfferExpireJobId = (offerId, expiryDate) => {
  const id = safeIdSegment(offerId);
  const epoch = toEpochMs(expiryDate);
  if (!id || epoch === null) return null;
  return `offer-expire-${id}-${epoch}`;
};

// Shared producer path (28.5 + 28.6 reminder families). delayMs is
// clamped at 0 — a past executeAt becomes an immediate job (business
// revalidation at execution still applies). Never throws: returns
// { scheduled, error? }.
export const addScheduledJob = async ({
  jobName,
  jobId,
  payload,
  executeAt,
  enqueue,
}) => {
  const delayMs = Math.max(0, Math.trunc(executeAt.getTime() - Date.now()));
  try {
    const add = enqueue ||
      (async (id, data, delay) => {
        const queue = getQueue(QUEUE_NAMES.SCHEDULED);
        await prepareJobSlot(queue, id);
        return enqueueJob(QUEUE_NAMES.SCHEDULED, jobName, data, {
          jobId: id,
          delay,
          ...getScheduledJobOptions(),
        });
      });
    await add(jobId, payload, delayMs);
    return { scheduled: true, jobId, delayMs };
  } catch (error) {
    // The Mongo intent (reminderDispatch PENDING / expiryDate) is the
    // recovery source; safe text only.
    const safeText = redactConnectionSecrets(
      `${error?.message || 'queue unavailable'}`
    ).slice(0, 160);
    logger.warn(
      `[Scheduled] enqueue failed (${jobName}, jobId=${jobId}) — intent stays ` +
        `in Mongo (npm run scheduled:reconcile requeues). (${safeText})`
    );
    return { scheduled: false, error: safeText };
  }
};

// Best-effort removal of a superseded job (reschedule/cancel/withdraw).
// Only removes jobs that are safely pending (waiting/delayed) — an
// active job finishes and its execution-time validation skips it.
// Defense in depth: removal is NEVER the only stale protection.
export const cancelScheduledJob = async (jobId) => {
  if (!jobId) return 'absent';
  try {
    const queue = getQueue(QUEUE_NAMES.SCHEDULED);
    const existing = await queue.getJob(jobId);
    if (!existing) return 'absent';
    const state = await existing.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'failed') {
      await existing.remove().catch(() => {});
      return `removed-${state}`;
    }
    return state;
  } catch {
    // Queue unavailable: execution-time validation still protects.
    return 'unavailable';
  }
};

// ── Interview reminders ─────────────────────────────────────────

// Schedules the ONE reminder for this interview's current schedule.
// `interview` needs: _id, companyId, status, scheduledStartAt,
// reminderDispatch (PENDING + dispatchAfter from the service).
export const scheduleInterviewReminder = async (interview, { enqueue } = {}) => {
  if (
    !interview?._id ||
    !mongoose.isValidObjectId(interview.companyId) ||
    !['SCHEDULED', 'RESCHEDULED'].includes(interview.status) ||
    !interview.scheduledStartAt
  ) {
    return { scheduled: false, reason: 'NOT_ELIGIBLE' };
  }
  if (new Date(interview.scheduledStartAt).getTime() <= Date.now()) {
    return { scheduled: false, reason: 'ALREADY_STARTED' };
  }
  // Existing business policy: 24h before → 1h before → immediate.
  const executeAt = interview.reminderDispatch?.dispatchAfter
    ? new Date(interview.reminderDispatch.dispatchAfter)
    : reminderDispatchAfter(new Date(interview.scheduledStartAt));
  const jobId = buildInterviewReminderJobId(interview._id, interview.scheduledStartAt);
  if (!jobId) return { scheduled: false, reason: 'INVALID_ID' };

  return addScheduledJob({
    jobName: JOB_NAMES.INTERVIEW_REMINDER,
    jobId,
    payload: {
      companyId: String(interview.companyId),
      interviewId: String(interview._id),
      scheduledStartAtIso: new Date(interview.scheduledStartAt).toISOString(),
      correlationId: crypto.randomUUID(),
    },
    executeAt,
    enqueue,
  });
};

export const cancelInterviewReminder = (interview, scheduledStartAt) =>
  cancelScheduledJob(
    buildInterviewReminderJobId(interview?._id, scheduledStartAt ?? interview?.scheduledStartAt)
  );

// Worker-side delivery: load recipient context UNDER companyId and
// dispatch through the Phase 28.3 email queue (eventKey idempotent).
// Throws when NO email intent could be accepted → the scheduled job
// retries (reminderDispatch stays PENDING for reconciliation).
export const deliverInterviewReminder = async (interview, { dispatch, loadCandidate } = {}) => {
  const doDispatch = dispatch || requestEmailDelivery;
  const doLoadCandidate = loadCandidate ||
    ((candidateId, companyId) =>
      Candidate.findOne({ _id: candidateId, companyId })
        .select('_id')
        .lean());
  const startAtIso = new Date(interview.scheduledStartAt).toISOString();

  const candidate = await doLoadCandidate(interview.candidate, interview.companyId);
  if (!candidate) return { recipients: 0 };

  const outcomes = [];
  outcomes.push(
    await doDispatch({
      jobName: JOB_NAMES.EMAIL_INTERVIEW_CANDIDATE,
      eventType: 'REMINDER',
      eventKey: buildEventKey('INTERVIEW_CANDIDATE_REMINDER', interview._id, startAtIso),
      companyId: interview.companyId,
      entityType: 'INTERVIEW',
      entityId: interview._id,
      recipientType: 'CANDIDATE',
      recipientReference: candidate._id,
      payload: {
        interviewId: String(interview._id),
        eventType: 'REMINDER',
        scheduleVersion: startAtIso,
      },
    })
  );

  for (const interviewer of interview.interviewers || []) {
    outcomes.push(
      await doDispatch({
        jobName: JOB_NAMES.EMAIL_INTERVIEW_INTERVIEWER,
        eventType: 'REMINDER',
        eventKey: buildEventKey(
          'INTERVIEW_INTERVIEWER_REMINDER',
          interview._id,
          interviewer._id || interviewer,
          startAtIso
        ),
        companyId: interview.companyId,
        entityType: 'INTERVIEW',
        entityId: interview._id,
        recipientType: 'INTERVIEWER',
        recipientReference: interviewer._id || interviewer,
        payload: {
          interviewId: String(interview._id),
          interviewerId: String(interviewer._id || interviewer),
          eventType: 'REMINDER',
          scheduleVersion: startAtIso,
        },
      })
    );
  }

  const queued = outcomes.filter((o) => o && (o.queued || o.duplicate)).length;
  if (queued === 0) {
    throw new Error('interview reminder email dispatch unavailable');
  }
  return { recipients: queued };
};

// ── Offer reminder + expiry ─────────────────────────────────────

// Schedules the one reminder (expiry − offset, only when the offset
// window is still open) and the expiry job (at expiryDate).
// `offer` needs: _id, companyId, status, terms.expiryDate.
export const scheduleOfferJobs = async (offer, { enqueue } = {}) => {
  const result = { reminder: { scheduled: false }, expiry: { scheduled: false } };
  if (
    !offer?._id ||
    !mongoose.isValidObjectId(offer.companyId) ||
    !['SENT', 'VIEWED'].includes(offer.status)
  ) {
    result.reason = 'NOT_ELIGIBLE';
    return result;
  }
  const expiryDate = offer.terms?.expiryDate;
  const expiryMs = toEpochMs(expiryDate);
  if (expiryMs === null) {
    result.reason = 'INVALID_EXPIRY';
    return result;
  }

  const reminderAt = new Date(expiryMs - getOfferReminderOffsetMs());
  if (reminderAt.getTime() > Date.now()) {
    result.reminder = await addScheduledJob({
      jobName: JOB_NAMES.OFFER_EXPIRY_REMINDER,
      jobId: buildOfferReminderJobId(offer._id, expiryDate),
      payload: {
        companyId: String(offer.companyId),
        offerId: String(offer._id),
        expiryDateIso: new Date(expiryDate).toISOString(),
        correlationId: crypto.randomUUID(),
      },
      executeAt: reminderAt,
      enqueue,
    });
  } else {
    // Sent inside the offset window: the offer email is the notice —
    // no separate reminder (documented policy).
    result.reminder = { scheduled: false, reason: 'WITHIN_OFFSET_WINDOW' };
  }

  // Expiry job at the canonical expiry (immediate if already past —
  // expireOfferIfDue revalidates eligibility atomically).
  result.expiry = await addScheduledJob({
    jobName: JOB_NAMES.OFFER_EXPIRE,
    jobId: buildOfferExpireJobId(offer._id, expiryDate),
    payload: {
      companyId: String(offer.companyId),
      offerId: String(offer._id),
      expiryDateIso: new Date(expiryDate).toISOString(),
      correlationId: crypto.randomUUID(),
    },
    executeAt: new Date(expiryDate),
    enqueue,
  });

  return result;
};

export const cancelOfferJobs = async (offer) => {
  const expiryDate = offer?.terms?.expiryDate;
  return Promise.all([
    cancelScheduledJob(buildOfferReminderJobId(offer?._id, expiryDate)),
    cancelScheduledJob(buildOfferExpireJobId(offer?._id, expiryDate)),
  ]);
};

// Reconcile scan target (bounded window, trusted internal process —
// companyId comes from the persisted records, not a request).
export const loadInterviewsForReminderReconcile = async ({ now, windowDays = 14, limit = 500 }) =>
  Interview.find({
    status: { $in: ['SCHEDULED', 'RESCHEDULED'] },
    scheduledStartAt: { $gt: now, $lte: new Date(now.getTime() + windowDays * 86400000) },
    'reminderDispatch.state': { $in: ['PENDING', 'FAILED', 'CLAIMED'] },
  })
    .select('companyId status scheduledStartAt reminderDispatch')
    .sort({ scheduledStartAt: 1, _id: 1 })
    .limit(Math.min(2000, Math.max(1, limit)))
    .lean();

export const loadOffersForReconcile = async ({ now, windowDays = 90, limit = 500 }) =>
  OfferLetter.find({
    status: { $in: ['SENT', 'VIEWED'] },
    'terms.expiryDate': { $gt: now, $lte: new Date(now.getTime() + windowDays * 86400000) },
  })
    .select('companyId status terms.expiryDate')
    .sort({ 'terms.expiryDate': 1, _id: 1 })
    .limit(Math.min(2000, Math.max(1, limit)))
    .lean();

// Bounded reconciliation runner (worker startup + CLI). Re-derives
// every job from Mongo intent with deterministic ids — idempotent,
// and slot-prep clears dead FAILED jobs under the same id.
// Never throws; returns a safe summary.
export const runScheduledReconcile = async (
  {
    now = new Date(),
    windowDays = 14,
    offerWindowDays = 90,
    limit = 500,
    enqueue,
    loadInterviews = loadInterviewsForReminderReconcile,
    loadOffers = loadOffersForReconcile,
  } = {}
) => {
  const summary = {
    interviews: { checked: 0, scheduled: 0, skipped: 0, errors: 0 },
    offers: { checked: 0, reminders: 0, expiries: 0, errors: 0 },
  };
  try {
    const interviews = await loadInterviews({ now, windowDays, limit });
    for (const interview of interviews) {
      summary.interviews.checked += 1;
      try {
        const res = await scheduleInterviewReminder(interview, { enqueue });
        if (res.scheduled) summary.interviews.scheduled += 1;
        else summary.interviews.skipped += 1;
      } catch {
        summary.interviews.errors += 1;
      }
    }
  } catch {
    summary.interviews.errors += 1;
  }
  try {
    const offers = await loadOffers({ now, windowDays: offerWindowDays, limit });
    for (const offer of offers) {
      summary.offers.checked += 1;
      try {
        const res = await scheduleOfferJobs(offer, { enqueue });
        if (res.reminder?.scheduled) summary.offers.reminders += 1;
        if (res.expiry?.scheduled) summary.offers.expiries += 1;
      } catch {
        summary.offers.errors += 1;
      }
    }
  } catch {
    summary.offers.errors += 1;
  }
  return summary;
};
