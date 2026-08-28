// ─────────────────────────────────────────────────────────────
// Application confirmation handoff (28.3)
//
// The public application commits the candidate FIRST, then this
// function persists an EmailDelivery intent and enqueues
// EMAIL_APPLICATION_RECEIVED. The HTTP request returns WITHOUT
// waiting for SMTP; the email worker sends (or MOCKs) later and
// the EmailDelivery record holds the final state.
//
// If Redis/queue is down the delivery becomes FAILED_TO_QUEUE and
// `npm run email:reconcile` re-enqueues it — the application itself
// is never rolled back and there is no sync fallback.
// ─────────────────────────────────────────────────────────────
import CandidateHistory from '../models/CandidateHistory.js';
import { JOB_NAMES } from '../config/queueConfig.js';
import {
  dispatchEmailDelivery,
  buildEventKey,
} from './emailDeliveryService.js';

export const requestApplicationConfirmation = async ({
  candidate,
  company,
  job,
  dispatch = dispatchEmailDelivery,
}) => {
  let outcome = { queued: false, delivery: null };

  try {
    outcome = await dispatch({
      jobName: JOB_NAMES.EMAIL_APPLICATION_RECEIVED,
      eventType: 'APPLICATION_RECEIVED',
      // One confirmation per candidate (ids only — never the email).
      eventKey: buildEventKey('APPLICATION_RECEIVED', candidate._id),
      companyId: company._id,
      entityType: 'CANDIDATE',
      entityId: candidate._id,
      recipientType: 'CANDIDATE',
      recipientReference: candidate._id,
      payload: { candidateId: candidate._id, jobId: job._id },
    });
  } catch {
    // dispatch throws only on invalid arguments (programming error);
    // the application must still succeed.
    outcome = { queued: false, delivery: null };
  }

  const deliveryStatus = outcome.queued ? 'QUEUED' : 'FAILED_TO_QUEUE';
  const action = outcome.queued
    ? 'APPLICATION_CONFIRMATION_REQUESTED'
    : 'APPLICATION_CONFIRMATION_FAILED_TO_QUEUE';

  try {
    await CandidateHistory.create({
      companyId: candidate.companyId,
      candidate: candidate._id,
      job: job._id,
      action,
      source: 'CAREER_PAGE',
      actorType: 'SYSTEM',
      metadata: {
        deliveryStatus,
        deliveryId: outcome.delivery?._id ? String(outcome.delivery._id) : null,
      },
      eventAt: new Date(),
    });
  } catch {
    // A confirmation-record failure must not invalidate the application.
  }

  return {
    queued: Boolean(outcome.queued),
    deliveryStatus,
    deliveryId: outcome.delivery?._id ? String(outcome.delivery._id) : null,
  };
};
