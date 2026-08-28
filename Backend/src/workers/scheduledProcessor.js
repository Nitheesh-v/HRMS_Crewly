// ============================================================
//  PHASE 28.5 — SCHEDULED WORKER PROCESSORS
//
// Three delayed-job adapters on the SCHEDULED queue. The worker
// NEVER trusts the queue: it re-fetches Mongo by {_id, companyId},
// revalidates status + schedule/expiry version, and only then acts.
//
// Outcomes (all logged safely, no PII / no job ids in business text):
//   - { processed: true, ... }          → completed
//   - { skipped: true, reason }         → completed as SKIPPED
//     (stale schedule/expiry, terminal state, already done — NO retry)
//   - throw                              → transient Mongo/Redis or
//     email-dispatch failure → BullMQ retry (SCHEDULED_JOB_OPTIONS)
//
// Business rules:
//   - Interview reminder: ONE per schedule (existing
//     reminderDispatchAfter policy), via the 28.3 email queue only.
//   - Offer reminder: non-sensitive nudge (NO token — the token-
//     bearing offer-SEND email stays synchronous by 28.3 policy).
//   - Offer expiry: ALWAYS through the existing atomic
//     expireOfferIfDue service — this worker never sets status.
// ============================================================

import mongoose from 'mongoose';
import logger from '../config/logger.js';
import { JOB_NAMES } from '../config/queueConfig.js';
import Interview from '../models/Interview.js';
import OfferLetter from '../models/OfferLetter.js';
import { buildEventKey, requestEmailDelivery } from '../services/emailDeliveryService.js';
import { deliverInterviewReminder } from '../services/scheduledJobScheduler.js';
import { expireOfferIfDue } from '../services/offerService.js';

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// Strict references-only validation. Unknown keys are rejected —
// payloads must never carry names, emails, links, or tokens (§30/31).
const validateReferences = (data, expectedKeys, timestampKey) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const keys = Object.keys(data).sort();
  const expected = [...expectedKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((k, i) => k !== expected[i])
  ) {
    return false;
  }
  if (
    !OBJECT_ID.test(data.companyId) ||
    !ISO_UTC.test(data[timestampKey]) ||
    Number.isNaN(Date.parse(data[timestampKey]))
  ) {
    return false;
  }
  return true;
};

const validateInterviewReminderPayload = (data) =>
  validateReferences(
    data,
    ['companyId', 'interviewId', 'scheduledStartAtIso', 'correlationId'],
    'scheduledStartAtIso'
  ) && OBJECT_ID.test(data.interviewId);

const validateOfferPayload = (data) =>
  validateReferences(
    data,
    ['companyId', 'offerId', 'expiryDateIso', 'correlationId'],
    'expiryDateIso'
  ) && OBJECT_ID.test(data.offerId);

// ── INTERVIEW_REMINDER ──────────────────────────────────────────

// Claim is crash-safe by construction: a job is active in exactly one
// BullMQ worker, so a leftover CLAIMED can only come from a previous
// attempt of the SAME job that crashed between claim and mark.
// Re-dispatching is safe because the email layer is idempotent by
// eventKey (a replayed reminder collapses onto the existing
// EmailDelivery record). CLAIMED is therefore always reclaimable.
const defaultClaimInterviewReminder = (interview, value) =>
  Interview.findOneAndUpdate(
    {
      _id: interview._id,
      companyId: value.companyId,
      'reminderDispatch.state': { $in: ['PENDING', 'FAILED', 'CLAIMED'] },
    },
    {
      $set: {
        'reminderDispatch.state': 'CLAIMED',
        'reminderDispatch.claimedAt': new Date(),
        'reminderDispatch.lastError': '',
      },
      $inc: { 'reminderDispatch.attempts': 1 },
    },
    { returnDocument: 'after' }
  );

const defaultMarkReminderDelivered = (interview, value) =>
  Interview.updateOne(
    { _id: interview._id, companyId: value.companyId, 'reminderDispatch.state': 'CLAIMED' },
    { $set: { 'reminderDispatch.state': 'DELIVERED', 'reminderDispatch.dispatchedAt': new Date() } }
  );

const defaultMarkReminderFailed = (interview, value, message) =>
  Interview.updateOne(
    { _id: interview._id, companyId: value.companyId, 'reminderDispatch.state': 'CLAIMED' },
    {
      $set: {
        'reminderDispatch.state': 'FAILED',
        'reminderDispatch.lastError': `${message}`.slice(0, 200),
      },
    }
  );

export const interviewReminderProcessor = async (job, deps = {}) => {
  const load = deps.load ||
    (async (value) =>
      Interview.findOne({
        _id: value.interviewId,
        companyId: value.companyId,
      })
        // companyId is required for tenant-scoped recipient lookups
        // and the dispatch args below — never rely on document
        // defaults when using select().
        .select('companyId status scheduledStartAt reminderDispatch candidate interviewers')
        .lean());
  const deliver = deps.deliver || deliverInterviewReminder;
  const claim = deps.claim || defaultClaimInterviewReminder;
  const markDelivered = deps.markDelivered || defaultMarkReminderDelivered;
  const markFailed = deps.markFailed || defaultMarkReminderFailed;

  if (!validateInterviewReminderPayload(job.data)) {
    throw new Error('INTERVIEW_REMINDER rejected: payload validation failed');
  }
  const value = job.data;
  const interview = await load(value);
  if (!interview) return { skipped: true, reason: 'NOT_FOUND' };
  if (!['SCHEDULED', 'RESCHEDULED'].includes(interview.status)) {
    return { skipped: true, reason: 'TERMINAL_STATE' };
  }
  const startAtIso = new Date(interview.scheduledStartAt).toISOString();
  if (startAtIso !== value.scheduledStartAtIso) {
    return { skipped: true, reason: 'STALE_SCHEDULE' };
  }
  if (new Date(interview.scheduledStartAt).getTime() <= Date.now()) {
    return { skipped: true, reason: 'INTERVIEW_STARTED' };
  }
  if (interview.reminderDispatch?.state === 'DELIVERED') {
    return { skipped: true, reason: 'ALREADY_REMINDED' };
  }

  // Atomic claim (PENDING/FAILED/CLAIMED). No match means the intent
  // is terminal (DELIVERED) or was cancelled underneath us — skip.
  const claimed = await claim(interview, value);
  if (!claimed) return { skipped: true, reason: 'IN_FLIGHT_OR_DONE' };

  try {
    // Throws when no email intent was accepted → job retries with
    // the intent marked FAILED (reclaimable, reconcile target).
    const result = await deliver(interview, deps);
    // EventKey idempotency + this mark make the reminder one-shot
    // per schedule.
    await markDelivered(interview, value).catch(() => {});
    logger.info(
      `[Scheduled] interview reminder delivered (interview=${interview._id}, ` +
        `recipients=${result.recipients})`
    );
    return { processed: true, recipients: result.recipients };
  } catch (error) {
    await markFailed(interview, value, error?.message || 'dispatch failed').catch(() => {});
    throw error;
  }
};

// ── OFFER_EXPIRY_REMINDER ───────────────────────────────────────

export const offerExpiryReminderProcessor = async (job, deps = {}) => {
  const load = deps.load ||
    (async (value) =>
      OfferLetter.findOne({
        _id: value.offerId,
        companyId: value.companyId,
      })
        // companyId required for the dispatch args (tenant scope).
        .select('companyId status terms.expiryDate candidate')
        .lean());
  const dispatch = deps.dispatch || requestEmailDelivery;

  if (!validateOfferPayload(job.data)) {
    throw new Error('OFFER_EXPIRY_REMINDER rejected: payload validation failed');
  }
  const value = job.data;
  const offer = await load(value);
  if (!offer) return { skipped: true, reason: 'NOT_FOUND' };
  if (!['SENT', 'VIEWED'].includes(offer.status)) {
    return { skipped: true, reason: 'TERMINAL_STATE' };
  }
  const expiryIso = new Date(offer.terms?.expiryDate).toISOString();
  if (expiryIso !== value.expiryDateIso) {
    return { skipped: true, reason: 'STALE_EXPIRY' };
  }
  if (new Date(offer.terms.expiryDate).getTime() <= Date.now()) {
    return { skipped: true, reason: 'EXPIRED' };
  }

  const outcome = await dispatch({
    jobName: JOB_NAMES.EMAIL_OFFER_REMINDER,
    eventType: 'OFFER_REMINDER',
    eventKey: buildEventKey('OFFER_REMINDER', offer._id, expiryIso),
    companyId: offer.companyId,
    entityType: 'OFFER',
    entityId: offer._id,
    recipientType: 'CANDIDATE',
    recipientReference: offer.candidate,
    payload: { offerId: String(offer._id), expiryDateIso: expiryIso },
  });
  if (!outcome || !(outcome.queued || outcome.duplicate)) {
    throw new Error('offer reminder email dispatch unavailable');
  }

  logger.info(`[Scheduled] offer expiry reminder dispatched (offer=${offer._id})`);
  return { processed: true };
};

// ── OFFER_EXPIRE ────────────────────────────────────────────────

export const offerExpireProcessor = async (job, deps = {}) => {
  const load = deps.load ||
    (async (value) =>
      OfferLetter.findOne({
        _id: value.offerId,
        companyId: value.companyId,
      })
        // companyId is REQUIRED: expireOfferIfDue builds its atomic
        // conditional update from offer.companyId (tenant scope).
        .select('companyId status terms.expiryDate candidate offerCode createdBy')
        .lean());
  const expire = deps.expire || expireOfferIfDue;

  if (!validateOfferPayload(job.data)) {
    throw new Error('OFFER_EXPIRE rejected: payload validation failed');
  }
  const value = job.data;
  const offer = await load(value);
  if (!offer) return { skipped: true, reason: 'NOT_FOUND' };
  if (new Date(offer.terms?.expiryDate).toISOString() !== value.expiryDateIso) {
    return { skipped: true, reason: 'STALE_EXPIRY' };
  }

  // The existing atomic transition service is the ONLY expiry path:
  // status guard + conditional update + pipeline/token/history/audit.
  const result = await expire({ offer, requestContext: null });
  if (result === offer) {
    const reason =
      offer.status === 'EXPIRED'
        ? 'ALREADY_EXPIRED'
        : ['ACCEPTED', 'REJECTED', 'WITHDRAWN'].includes(offer.status)
          ? 'TERMINAL_STATE'
          : 'NOT_DUE';
    return { skipped: true, reason };
  }

  logger.info(`[Scheduled] offer expired via atomic service (offer=${offer._id})`);
  return { processed: true, transitioned: true };
};

export const registerScheduledProcessors = ({ registerProcessor }) => {
  // Thin adapters: the shared registry dispatches by job name.
  for (const [jobName, processor] of Object.entries({
    [JOB_NAMES.INTERVIEW_REMINDER]: interviewReminderProcessor,
    [JOB_NAMES.OFFER_EXPIRY_REMINDER]: offerExpiryReminderProcessor,
    [JOB_NAMES.OFFER_EXPIRE]: offerExpireProcessor,
  })) {
    registerProcessor(jobName, processor);
  }
  logger.info(
    `[Queue] SCHEDULED processors ready (${JOB_NAMES.INTERVIEW_REMINDER}, ` +
      `${JOB_NAMES.OFFER_EXPIRY_REMINDER}, ${JOB_NAMES.OFFER_EXPIRE})`
  );
};
