import mongoose from 'mongoose';
import CandidateResume from '../models/CandidateResume.js';
import {
  processResumeJob,
  resumeProcessingConfiguration,
} from './resumeProcessingService.js';

const MAX_LOCAL_QUEUE = Math.min(
  1000,
  Math.max(25, Number(process.env.RESUME_LOCAL_QUEUE_MAX) || 250)
);
const REFILL_BATCH_SIZE = Math.min(100, Math.max(5, Math.floor(MAX_LOCAL_QUEUE / 5)));
const queue = [];
const queuedResumeIds = new Set();
let draining = false;
let refillInProgress = false;

const validJob = (job) =>
  mongoose.isValidObjectId(job?.companyId) &&
  mongoose.isValidObjectId(job?.candidateId) &&
  mongoose.isValidObjectId(job?.resumeId);

const queueJob = (job) => {
  if (!validJob(job)) return false;

  const resumeKey = String(job.resumeId);

  if (queuedResumeIds.has(resumeKey)) return true;
  if (queue.length >= MAX_LOCAL_QUEUE) return false;

  queuedResumeIds.add(resumeKey);
  queue.push({
    companyId: String(job.companyId),
    candidateId: String(job.candidateId),
    resumeId: resumeKey,
  });
  return true;
};

const refillPendingJobs = async () => {
  if (refillInProgress || queue.length >= MAX_LOCAL_QUEUE) return;
  refillInProgress = true;

  try {
    const jobs = await CandidateResume.find({
      status: 'UPLOADED',
      scanStatus: { $ne: 'REJECTED' },
      parsingStatus: { $in: ['PENDING', 'RETRY_PENDING'] },
      parsingAttempts: { $lt: resumeProcessingConfiguration.maxAttempts },
    })
      .select('companyId candidate')
      .sort({ parsingRequestedAt: 1, _id: 1 })
      .limit(Math.min(REFILL_BATCH_SIZE, MAX_LOCAL_QUEUE - queue.length))
      .lean();

    jobs.forEach((resume) =>
      queueJob({
        companyId: resume.companyId,
        candidateId: resume.candidate,
        resumeId: resume._id,
      })
    );
  } catch {
    // Persisted PENDING state is the retry mechanism; no sensitive data is logged.
  } finally {
    refillInProgress = false;
  }
};

const drain = async () => {
  if (draining) return;
  draining = true;

  try {
    while (queue.length) {
      const job = queue.shift();
      queuedResumeIds.delete(job.resumeId);

      try {
        await processResumeJob(job);
      } catch {
        // The processing service persists safe failure state when a job was locked.
      }

      if (queue.length < REFILL_BATCH_SIZE) await refillPendingJobs();
    }
  } finally {
    draining = false;
  }
};

const scheduleDrain = () => {
  if (process.env.NODE_ENV === 'test') return;
  queueMicrotask(() => {
    drain().catch(() => {});
  });
};

export const dispatchResumeProcessing = (job) => {
  const accepted = queueJob(job);

  if (accepted) scheduleDrain();

  return {
    accepted,
    provider: 'LOCAL',
  };
};

export const recoverPendingResumeProcessing = async () => {
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

  await refillPendingJobs();
  scheduleDrain();

  return {
    provider: 'LOCAL',
    queued: queue.length,
    capacity: MAX_LOCAL_QUEUE,
  };
};

export const resumeProcessingDispatcherState = () => ({
  provider: 'LOCAL',
  queued: queue.length,
  capacity: MAX_LOCAL_QUEUE,
  draining,
});
