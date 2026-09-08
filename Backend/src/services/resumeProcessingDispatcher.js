// ============================================================
// ⏱️ PHASE 28.4 — RESUME PARSING DISPATCH (BullMQ)
//
// Phase 27.6/27.8 ran parsing from an in-memory queue inside the
// API process (HTTP request → Express event loop → PDF/DOCX
// extraction). Phase 28.4 moves execution to the dedicated worker
// process on the `resume` queue (28.2 infrastructure):
//
//   dispatch → deterministic BullMQ job (references-only payload)
//   → worker claims via the EXISTING atomic Mongo lease
//   → extraction + deterministic parser (unchanged) → persist
//   → on COMPLETED: chain the ATS job (atsDispatcher).
//
// INTENT VS TRANSPORT (the 28.3 rule, applied to processing):
//   - MongoDB `parsingStatus` (PENDING/RETRY_PENDING) is the durable
//     dispatch intent. `queue.add` is best-effort transport.
//   - A queue/Redis failure never fails the HTTP request and never
//     loses work: the PENDING intent stays in Mongo and worker
//     startup recovery / `npm run processing:reconcile` re-enqueues
//     it (idempotent, deterministic job id).
//   - There is NO synchronous fallback parsing path.
//
// JOB ID (BullMQ custom ids may not contain ':'):
//   resume-parse-<resumeId>-<parserVersion>-<parsingRequestedAtMs>
// Deterministic from Mongo state → reconciliation reconstructs the
// exact id without storing it. A new parse REQUEST (apply, reprocess,
// lease-expiry recovery) sets a new parsingRequestedAt → new id, so
// intentional reprocess is never blocked by the old job. The same
// logical job re-delivered keeps its id (BullMQ dedupe + retries).
//
// PAYLOAD (references only — validated again by the worker):
//   { companyId, candidateId, resumeId, parserVersion, correlationId }
// Never: resume binary/text, file names, PII, storage credentials.
// ============================================================

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import CandidateResume from '../models/CandidateResume.js';
import logger from '../config/logger.js';
import { getQueue, enqueueJob, prepareJobSlot } from '../queues/queueFactory.js';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  getResumeJobOptions,
  redactConnectionSecrets,
} from '../config/queueConfig.js';
import { RESUME_PARSER_VERSION } from './resumeDeterministicParser.js';
import { resumeProcessingConfiguration } from './resumeProcessingService.js';

const RECOVERY_BATCH_SIZE = 100;
// A healthy in-flight job is minutes from its request at most; the
// min-age keeps recovery from racing jobs the API just enqueued.
const DEFAULT_MIN_AGE_MS = 60 * 1000;

const validJob = (job) =>
  mongoose.isValidObjectId(job?.companyId) &&
  mongoose.isValidObjectId(job?.candidateId) &&
  mongoose.isValidObjectId(job?.resumeId);

const safeIdSegment = (value) =>
  /^[a-f0-9]{24}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';

// Deterministic, colon-free, Mongo-reconstructable job id.
export const buildResumeJobId = (resumeId, parserVersion, requestedAt) => {
  const resumeSegment = safeIdSegment(resumeId);
  const versionSegment = String(parserVersion || '')
    .replace(/[^a-z0-9._-]/gi, '-')
    .slice(0, 48);
  const epoch = Math.trunc(Number(requestedAt?.getTime?.() ?? requestedAt));
  if (!resumeSegment || !versionSegment || !Number.isFinite(epoch)) return null;
  return `resume-parse-${resumeSegment}-${versionSegment}-${epoch}`;
};

// Default producer path (API process / CLI). Reconciliation clears a
// dead previous job first — a live one is deduped by BullMQ.
export const defaultResumeEnqueue = async (jobId, payload) => {
  const queue = getQueue(QUEUE_NAMES.RESUME);
  await prepareJobSlot(queue, jobId);
  return enqueueJob(QUEUE_NAMES.RESUME, JOB_NAMES.RESUME_PARSE, payload, {
    jobId,
    ...getResumeJobOptions(),
  });
};

// Dispatch (never throws): Mongo intent already exists at this point
// (PENDING from apply, RETRY_PENDING from reprocess/recovery).
export const dispatchResumeProcessing = async (job, { enqueue } = {}) => {
  if (!validJob(job)) {
    return { accepted: false, queued: false, provider: 'BULLMQ' };
  }

  const parserVersion = RESUME_PARSER_VERSION;
  let requestedAt = job.parsingRequestedAt;

  if (!requestedAt) {
    // Call sites that hold the resume doc pass parsingRequestedAt
    // directly; this point-read keeps the dispatcher self-sufficient.
    try {
      const resume = await CandidateResume.findOne({
        _id: job.resumeId,
        companyId: job.companyId,
      })
        .select('parsingRequestedAt')
        .lean();
      requestedAt = resume?.parsingRequestedAt;
    } catch {
      requestedAt = null;
    }
  }

  const jobId = buildResumeJobId(job.resumeId, parserVersion, requestedAt);
  if (!jobId) {
    return { accepted: false, queued: false, provider: 'BULLMQ' };
  }

  const payload = {
    companyId: String(job.companyId),
    candidateId: String(job.candidateId),
    resumeId: String(job.resumeId),
    parserVersion,
    correlationId: crypto.randomUUID(),
  };

  try {
    await (enqueue || defaultResumeEnqueue)(jobId, payload);
    return { accepted: true, queued: true, provider: 'BULLMQ', jobId };
  } catch (error) {
    // Transport failure: the PENDING/RETRY_PENDING intent remains in
    // Mongo, so recovery will deliver it. Safe text only.
    const safeText = redactConnectionSecrets(
      `${error?.message || 'queue unavailable'}`
    ).slice(0, 160);
    logger.warn(
      `[ResumeDispatch] enqueue failed for resume=${job.resumeId} — ` +
        `intent stays PENDING in Mongo (recovery will requeue). (${safeText})`
    );
    return {
      accepted: true,
      queued: false,
      provider: 'BULLMQ',
      error: safeText,
    };
  }
};

// Startup/reconcile recovery: normalize legacy + lease-expired state
// (Mongo is the source of truth), then re-enqueue every stuck
// PENDING/RETRY_PENDING record with its deterministic job id.
export const recoverPendingResumeProcessing = async ({
  enqueue,
  minAgeMs = DEFAULT_MIN_AGE_MS,
  limit = RECOVERY_BATCH_SIZE,
} = {}) => {
  const now = new Date();

  await Promise.all([
    CandidateResume.updateMany(
      { parsingAttempts: { $exists: false } },
      {
        $set: {
          parsingAttempts: 0,
          parsingRequestedAt: now,
        },
      }
    ),
    CandidateResume.updateMany(
      { parsingStatus: { $in: ['NOT_REQUESTED', 'PARSING_PENDING'] } },
      {
        $set: {
          parsingStatus: 'PENDING',
          parsingRequestedAt: now,
          processingLeaseId: '',
          processingLeaseExpiresAt: null,
        },
      }
    ),
    CandidateResume.updateMany(
      { parsingStatus: 'PARSED' },
      { $set: { parsingStatus: 'COMPLETED' } }
    ),
    CandidateResume.updateMany(
      {
        parsingStatus: { $in: ['PROCESSING', 'PARSING'] },
        $or: [
          { processingLeaseExpiresAt: { $lte: now } },
          { processingLeaseExpiresAt: null },
          { processingLeaseExpiresAt: { $exists: false } },
        ],
      },
      {
        $set: {
          parsingStatus: 'RETRY_PENDING',
          parsingRequestedAt: now,
          processingLeaseId: '',
          processingLeaseExpiresAt: null,
        },
      }
    ),
  ]);

  const staleBefore = new Date(now.getTime() - Math.max(0, minAgeMs));
  const pending = await CandidateResume.find({
    status: 'UPLOADED',
    scanStatus: { $ne: 'REJECTED' },
    parsingStatus: { $in: ['PENDING', 'RETRY_PENDING'] },
    parsingAttempts: { $lt: resumeProcessingConfiguration.maxAttempts },
    parsingRequestedAt: { $lte: staleBefore },
  })
    .select('companyId candidate parsingRequestedAt')
    .sort({ parsingRequestedAt: 1, _id: 1 })
    .limit(Math.min(500, Math.max(1, limit)))
    .lean();

  let queued = 0;
  let skipped = 0;
  for (const resume of pending) {
    const result = await dispatchResumeProcessing(
      {
        companyId: resume.companyId,
        candidateId: resume.candidate,
        resumeId: resume._id,
        parsingRequestedAt: resume.parsingRequestedAt,
      },
      { enqueue }
    );
    if (result.queued) queued += 1;
    else skipped += 1;
  }

  return {
    provider: 'BULLMQ',
    pending: pending.length,
    queued,
    skipped,
  };
};

export const resumeProcessingDispatcherState = () => ({
  provider: 'BULLMQ',
});
