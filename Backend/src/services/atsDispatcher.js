// ============================================================
// ️ PHASE 28.4 — ATS MATCHING DISPATCH (BullMQ)
//
// Phase 27.7 chained ATS scoring from an in-memory queue inside the
// API process. Phase 28.4 moves execution to the dedicated worker
// process on the `ats` queue (28.2 infrastructure), using the
// EXISTING deterministic ATS engine (unchanged).
//
// INTENT VS TRANSPORT:
//   - Mongo intent: parse result COMPLETED with (no ATSResult yet |
//     ATSResult.recalculationPending=true). `queue.add` is
//     best-effort transport; a queue failure never loses work —
//     worker startup recovery / `npm run processing:reconcile`
//     re-derives the same intent from Mongo and re-enqueues it.
//   - NO synchronous fallback scoring path.
//
// CHAINING (§35/36/37): resume parse COMPLETED → dispatch here. A
// crash between the parse commit and this enqueue is exactly the
// "COMPLETED parse + missing ATSResult" intent that recovery finds.
// REVIEW_REQUIRED/FAILED/UNSUPPORTED parses never dispatch.
//
// JOB ID (BullMQ custom ids may not contain ':'):
//   ats-process-<candidateId>-<parseResultId>-<requestEpochMs>
//   - automatic chain / recovery: requestEpoch = parseResult.completedAt
//   - manual recalculate:         requestEpoch = recalculationRequestedAt
// Deterministic from Mongo state (reconciliation reconstructs it);
// every new logical request carries a new epoch, so intentional
// recalculation is never blocked by the previous job.
//
// PAYLOAD (references only — validated again by the worker):
//   { companyId, candidateId, jobId, resumeId, parseResultId,
//     engineVersion, trigger, actorId?, correlationId }
// Never: resume content, candidate PII, job posting body, secrets.
// ============================================================

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import CandidateResume from '../models/CandidateResume.js';
import ResumeParseResult from '../models/ResumeParseResult.js';
import ATSResult from '../models/ATSResult.js';
import logger from '../config/logger.js';
import { getQueue, enqueueJob, prepareJobSlot } from '../queues/queueFactory.js';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  getATSJobOptions,
  redactConnectionSecrets,
} from '../config/queueConfig.js';
import { getATSScoringConfiguration } from './atsScoringConfig.js';

const RECOVERY_BATCH_SIZE = 100;
const TRIGGERS = ['RESUME_PARSED', 'STARTUP_RECOVERY', 'MANUAL_REPROCESS'];

const validJob = (job) =>
  mongoose.isValidObjectId(job?.companyId) &&
  mongoose.isValidObjectId(job?.candidateId) &&
  mongoose.isValidObjectId(job?.jobId) &&
  mongoose.isValidObjectId(job?.resumeId) &&
  mongoose.isValidObjectId(job?.parseResultId) &&
  TRIGGERS.includes(job.trigger);

const safeIdSegment = (value) =>
  /^[a-f0-9]{24}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';

// null/undefined are NOT valid epochs (Number(null) === 0 trap).
const requestEpochMs = (value) => {
  if (value === null || value === undefined) return null;
  const epoch = Math.trunc(Number(value?.getTime?.() ?? value));
  return Number.isFinite(epoch) && epoch > 0 ? epoch : null;
};

// Deterministic, colon-free, Mongo-reconstructable job id.
export const buildATSJobId = (candidateId, parseResultId, requestEpoch) => {
  const candidateSegment = safeIdSegment(candidateId);
  const parseSegment = safeIdSegment(parseResultId);
  const epoch = requestEpochMs(requestEpoch);
  if (!candidateSegment || !parseSegment || epoch === null) return null;
  return `ats-process-${candidateSegment}-${parseSegment}-${epoch}`;
};

// Default producer path (API process / CLI). Reconciliation clears a
// dead previous job first — a live one is deduped by BullMQ.
export const defaultATSDispatchEnqueue = async (jobId, payload) => {
  const queue = getQueue(QUEUE_NAMES.ATS);
  await prepareJobSlot(queue, jobId);
  return enqueueJob(QUEUE_NAMES.ATS, JOB_NAMES.ATS_PROCESS, payload, {
    jobId,
    ...getATSJobOptions(),
  });
};

// Call sites pass requestEpoch (the Date that defines this logical
// request). When absent, a point-read derives it — manual requests
// prefer recalculationRequestedAt, otherwise the parse completion.
export const dispatchATSMatching = async (job, { enqueue } = {}) => {
  if (!validJob(job)) {
    return { accepted: false, queued: false, provider: 'BULLMQ' };
  }

  let requestEpoch = job.requestEpoch;
  if (requestEpochMs(requestEpoch) === null) {
    requestEpoch = null;
    try {
      const [existing, parseResult] = await Promise.all([
        ATSResult.findOne({
          companyId: job.companyId,
          candidateId: job.candidateId,
        })
          .select('recalculationRequestedAt')
          .lean(),
        ResumeParseResult.findOne({
          _id: job.parseResultId,
          companyId: job.companyId,
        })
          .select('completedAt')
          .lean(),
      ]);
      requestEpoch =
        existing?.recalculationRequestedAt || parseResult?.completedAt || null;
    } catch {
      requestEpoch = null;
    }
  }

  const jobId = buildATSJobId(job.candidateId, job.parseResultId, requestEpoch);
  if (!jobId) {
    return { accepted: false, queued: false, provider: 'BULLMQ' };
  }

  const payload = {
    companyId: String(job.companyId),
    candidateId: String(job.candidateId),
    jobId: String(job.jobId),
    resumeId: String(job.resumeId),
    parseResultId: String(job.parseResultId),
    engineVersion: getATSScoringConfiguration().engineVersion,
    trigger: job.trigger,
    correlationId: crypto.randomUUID(),
  };
  if (job.actorId) payload.actorId = String(job.actorId);

  try {
    await (enqueue || defaultATSDispatchEnqueue)(jobId, payload);
    return { accepted: true, queued: true, provider: 'BULLMQ', jobId };
  } catch (error) {
    // Transport failure: the Mongo intent (missing result /
    // recalculationPending) remains, so recovery will deliver it.
    const safeText = redactConnectionSecrets(
      `${error?.message || 'queue unavailable'}`
    ).slice(0, 160);
    logger.warn(
      `[ATSDispatch] enqueue failed for candidate=${job.candidateId} — ` +
        `intent stays in Mongo (recovery will requeue). (${safeText})`
    );
    return {
      accepted: true,
      queued: false,
      provider: 'BULLMQ',
      error: safeText,
    };
  }
};

// Startup/reconcile recovery: derive the intent straight from Mongo
// (COMPLETED parse + no ATSResult, or recalculationPending), then
// re-enqueue with deterministic job ids. Idempotent: a healthy
// candidate with a fresh ATS result is excluded; a job already alive
// in the queue is deduped by its id.
export const recoverPendingATSMatching = async ({
  enqueue,
  limit = RECOVERY_BATCH_SIZE,
} = {}) => {
  const resumes = await CandidateResume.aggregate([
    {
      $match: {
        status: 'UPLOADED',
        scanStatus: { $ne: 'REJECTED' },
        parsingStatus: { $in: ['COMPLETED', 'PARSED'] },
      },
    },
    { $sort: { parsingCompletedAt: 1, _id: 1 } },
    {
      $lookup: {
        from: ATSResult.collection.name,
        let: { companyId: '$companyId', candidateId: '$candidate' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$companyId', '$$companyId'] },
                  { $eq: ['$candidateId', '$$candidateId'] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: 'atsResults',
      },
    },
    {
      $match: {
        $or: [
          { atsResults: { $size: 0 } },
          { 'atsResults.recalculationPending': true },
        ],
      },
    },
    { $limit: Math.min(500, Math.max(1, limit)) },
    {
      $project: {
        companyId: 1,
        candidate: 1,
        job: 1,
        pendingATS: { $arrayElemAt: ['$atsResults', 0] },
      },
    },
  ]);

  let queued = 0;
  let skipped = 0;
  for (const resume of resumes) {
    const parseResult = await ResumeParseResult.findOne({
      companyId: resume.companyId,
      candidate: resume.candidate,
      resume: resume._id,
      status: 'COMPLETED',
    })
      .select('_id completedAt')
      .sort({ completedAt: -1 })
      .lean();

    if (!parseResult?.completedAt) continue;

    const isManual = Boolean(resume.pendingATS?.recalculationPending);
    const result = await dispatchATSMatching(
      {
        companyId: resume.companyId,
        candidateId: resume.candidate,
        jobId: resume.job,
        resumeId: resume._id,
        parseResultId: parseResult._id,
        trigger: isManual ? 'MANUAL_REPROCESS' : 'STARTUP_RECOVERY',
        actorId: resume.pendingATS?.recalculationRequestedBy || null,
        requestEpoch: isManual
          ? resume.pendingATS?.recalculationRequestedAt || parseResult.completedAt
          : parseResult.completedAt,
      },
      { enqueue }
    );
    if (result.queued) queued += 1;
    else skipped += 1;
  }

  return {
    provider: 'BULLMQ',
    pending: resumes.length,
    queued,
    skipped,
  };
};

export const atsDispatcherState = () => ({
  provider: 'BULLMQ',
});
