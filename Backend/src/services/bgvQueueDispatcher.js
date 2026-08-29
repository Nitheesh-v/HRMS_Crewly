// ============================================================
//  PHASE 28.6 — BGV QUEUE DISPATCHER
//
// Schedules BGV background work on the reserved BGV queue:
//   BGV_PROCESS_CHECK  — case-level provider registration +
//                        consent gate (one logical submission
//                        per case, idempotent via the Mongo
//                        providerReference claim)
//   BGV_PROVIDER_POLL  — delayed poll for providers that poll
//                        (EXTERNAL adapters; INTERNAL never
//                        schedules a poll)
//   BGV_PROCESS_RESULT — provider result normalization (future
//                        webhook entry; the poll processor calls
//                        the same service directly today)
//
// INTENT VS TRANSPORT (28.4/28.5 rule):
//   - Mongo is the BGV truth: case status, consent,
//     providerSubmission, polling sub-document.
//   - Redis only knows "run at X". `npm run queue:reconcile`
//     rebuilds jobs from Mongo with deterministic ids.
//
// JOB IDS (colon-free, deterministic, Mongo-reconstructable):
//   bgv-check-<caseId>                     (one per case)
//   bgv-poll-<caseId>-<pollAttempt>
//   bgv-result-<caseId>-<resultVersionMs>
//
// PAYLOADS (references only — validated again by the worker):
//   { companyId, caseId, providerKey?, pollAttempt?,
//     resultVersionIso?, correlationId }
// Never: candidate PII, evidence, provider credentials.
// ============================================================

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import logger from '../config/logger.js';
import { getQueue, enqueueJob, prepareJobSlot } from '../queues/queueFactory.js';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  getBgvJobOptions,
  nextBgvPollDelayMs,
  redactConnectionSecrets,
} from '../config/queueConfig.js';
import BackgroundVerificationCase from '../models/BackgroundVerificationCase.js';

const safeIdSegment = (value) =>
  /^[a-f0-9]{24}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';

export const buildBgvCheckJobId = (caseId) => {
  const id = safeIdSegment(caseId);
  return id ? `bgv-check-${id}` : null;
};

export const buildBgvPollJobId = (caseId, pollAttempt) => {
  const id = safeIdSegment(caseId);
  const attempt = Math.trunc(Number(pollAttempt));
  if (!id || !Number.isInteger(attempt) || attempt < 1) return null;
  return `bgv-poll-${id}-${attempt}`;
};

// Shared never-throwing producer (immediate or delayed).
const addBgvJob = async ({ jobName, jobId, payload, delayMs = 0, enqueue }) => {
  const delay = Math.max(0, Math.trunc(delayMs));
  try {
    const add = enqueue ||
      (async (id, data, d) => {
        const queue = getQueue(QUEUE_NAMES.BGV);
        await prepareJobSlot(queue, id);
        return enqueueJob(QUEUE_NAMES.BGV, jobName, data, {
          jobId: id,
          ...(d > 0 ? { delay: d } : {}),
          ...getBgvJobOptions(),
        });
      });
    await add(jobId, payload, delay);
    return { scheduled: true, jobId, delayMs: delay };
  } catch (error) {
    const safeText = redactConnectionSecrets(
      `${error?.message || 'queue unavailable'}`
    ).slice(0, 160);
    logger.warn(
      `[BGV] enqueue failed (${jobName}, jobId=${jobId}) — intent stays in ` +
        `Mongo (npm run queue:reconcile requeues). (${safeText})`
    );
    return { scheduled: false, error: safeText };
  }
};

// Called by the BGV service after the case + checks are committed.
// `caseRecord` needs: _id, companyId, provider.
export const scheduleBgvCaseProcessing = async (caseRecord, { enqueue } = {}) => {
  if (!caseRecord?._id || !mongoose.isValidObjectId(caseRecord.companyId)) {
    return { scheduled: false, reason: 'NOT_ELIGIBLE' };
  }
  const jobId = buildBgvCheckJobId(caseRecord._id);
  if (!jobId) return { scheduled: false, reason: 'INVALID_ID' };

  return addBgvJob({
    jobName: JOB_NAMES.BGV_PROCESS_CHECK,
    jobId,
    payload: {
      companyId: String(caseRecord.companyId),
      caseId: String(caseRecord._id),
      providerKey: String(caseRecord.provider || 'INTERNAL'),
      correlationId: crypto.randomUUID(),
    },
    enqueue,
  });
};

// Delayed poll for provider-driven cases (external adapters only).
export const scheduleBgvPoll = async (caseRecord, pollAttempt, delayMs, { enqueue } = {}) => {
  if (!caseRecord?._id || !mongoose.isValidObjectId(caseRecord.companyId)) {
    return { scheduled: false, reason: 'NOT_ELIGIBLE' };
  }
  const jobId = buildBgvPollJobId(caseRecord._id, pollAttempt);
  if (!jobId) return { scheduled: false, reason: 'INVALID_ID' };

  return addBgvJob({
    jobName: JOB_NAMES.BGV_PROVIDER_POLL,
    jobId,
    payload: {
      companyId: String(caseRecord.companyId),
      caseId: String(caseRecord._id),
      providerKey: String(caseRecord.provider || 'INTERNAL'),
      pollAttempt: Math.trunc(Number(pollAttempt)),
      correlationId: crypto.randomUUID(),
    },
    delayMs,
    enqueue,
  });
};

// Best-effort retirement of the case's queued jobs (cancel/complete).
// Execution-time validation is the final guard (remove can race).
export const cancelBgvJobs = async (caseRecord) => {
  const jobId = buildBgvCheckJobId(caseRecord?._id);
  const results = [];
  if (jobId) results.push(await removeBgvJob(jobId));
  // Poll job ids carry the attempt number; the dispatcher removes
  // the CURRENT attempt tracked in Mongo.
  if (caseRecord?.polling?.attempts) {
    const current = buildBgvPollJobId(caseRecord._id, caseRecord.polling.attempts);
    if (current) results.push(await removeBgvJob(current));
  }
  return results;
};

const removeBgvJob = async (jobId) => {
  if (!jobId) return 'absent';
  try {
    const queue = getQueue(QUEUE_NAMES.BGV);
    const existing = await queue.getJob(jobId);
    if (!existing) return 'absent';
    const state = await existing.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'failed') {
      await existing.remove().catch(() => {});
      return `removed-${state}`;
    }
    return state;
  } catch {
    return 'unavailable';
  }
};

// Reconcile scan targets (bounded windows, trusted internal process).
export const loadCasesForBgvReconcile = async ({ now, windowDays = 60, limit = 500 }) => {
  const limitCount = Math.min(2000, Math.max(1, limit));
  const activeStatuses = ['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_CANDIDATE', 'AWAITING_VERIFIER', 'REVIEW_REQUIRED'];
  const [missingSubmission, duePolls] = await Promise.all([
    BackgroundVerificationCase.find({
      status: { $in: activeStatuses },
      createdAt: { $gt: new Date(now.getTime() - windowDays * 86400000), $lte: now },
      'providerSubmission.submittedAt': null,
    })
      .select('companyId provider')
      .sort({ createdAt: 1, _id: 1 })
      .limit(limitCount)
      .lean(),
    BackgroundVerificationCase.find({
      status: { $in: activeStatuses },
      'polling.status': 'POLLING',
      'polling.nextPollAt': { $ne: null, $lte: now },
    })
      .select('companyId provider polling')
      .sort({ 'polling.nextPollAt': 1, _id: 1 })
      .limit(limitCount)
      .lean(),
  ]);
  return { missingSubmission, duePolls };
};

// Bounded reconciliation runner (CLI). Never throws.
export const runBgvReconcile = async (
  {
    now = new Date(),
    windowDays = 60,
    limit = 500,
    enqueue,
    loadCases = loadCasesForBgvReconcile,
  } = {}
) => {
  const summary = { checked: 0, queued: 0, pollsScheduled: 0, skipped: 0, errors: 0 };
  let data = { missingSubmission: [], duePolls: [] };
  try {
    data = await loadCases({ now, windowDays, limit });
  } catch {
    summary.errors += 1;
    return summary;
  }
  for (const c of data.missingSubmission) {
    summary.checked += 1;
    try {
      const res = await scheduleBgvCaseProcessing(c, { enqueue });
      if (res.scheduled) summary.queued += 1;
      else summary.skipped += 1;
    } catch {
      summary.errors += 1;
    }
  }
  for (const c of data.duePolls) {
    summary.checked += 1;
    try {
      // nextBgvPollDelayMs keeps the cadence; the attempt is already
      // persisted, so the job id stays deterministic.
      const res = await scheduleBgvPoll(c, c.polling.attempts, nextBgvPollDelayMs(c.polling.attempts), { enqueue });
      if (res.scheduled) summary.pollsScheduled += 1;
      else summary.skipped += 1;
    } catch {
      summary.errors += 1;
    }
  }
  return summary;
};
