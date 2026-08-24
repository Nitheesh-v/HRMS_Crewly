import mongoose from 'mongoose';
import ATSResult from '../models/ATSResult.js';
import CandidateResume from '../models/CandidateResume.js';
import ResumeParseResult from '../models/ResumeParseResult.js';
import { processATSMatch } from './atsMatchingService.js';

const MAX_LOCAL_QUEUE = Math.min(
  1000,
  Math.max(25, Number(process.env.ATS_LOCAL_QUEUE_MAX) || 250)
);
const RECOVERY_BATCH_SIZE = Math.min(250, MAX_LOCAL_QUEUE);
const queue = [];
const queuedJobs = new Map();
let draining = false;

const validJob = (job) =>
  mongoose.isValidObjectId(job?.companyId) &&
  mongoose.isValidObjectId(job?.candidateId) &&
  mongoose.isValidObjectId(job?.jobId) &&
  mongoose.isValidObjectId(job?.resumeId) &&
  mongoose.isValidObjectId(job?.parseResultId);

const queueKey = (job) =>
  `${String(job.companyId)}:${String(job.candidateId)}:${String(job.jobId)}`;

const queueJob = (job) => {
  if (!validJob(job)) return false;

  const key = queueKey(job);
  const existing = queuedJobs.get(key);

  if (existing) {
    if (job.trigger === 'MANUAL_REPROCESS') {
      existing.trigger = 'MANUAL_REPROCESS';
      existing.actorId = job.actorId ? String(job.actorId) : null;
      existing.resumeId = String(job.resumeId);
      existing.parseResultId = String(job.parseResultId);
    }

    return true;
  }

  if (queue.length >= MAX_LOCAL_QUEUE) return false;

  const queued = {
    companyId: String(job.companyId),
    candidateId: String(job.candidateId),
    jobId: String(job.jobId),
    resumeId: String(job.resumeId),
    parseResultId: String(job.parseResultId),
    trigger: ['STARTUP_RECOVERY', 'MANUAL_REPROCESS'].includes(job.trigger)
      ? job.trigger
      : 'RESUME_PARSED',
    actorId: job.actorId ? String(job.actorId) : null,
  };

  queuedJobs.set(key, queued);
  queue.push(queued);
  return true;
};

export const drainATSMatching = async () => {
  if (draining) return;
  draining = true;

  try {
    while (queue.length) {
      const job = queue.shift();
      queuedJobs.delete(queueKey(job));

      try {
        await processATSMatch(job);
      } catch {
        // Matching errors never mutate candidate decisions and expose no resume data.
      }
    }
  } finally {
    draining = false;
  }
};

const scheduleDrain = () => {
  if (process.env.NODE_ENV === 'test') return;

  queueMicrotask(() => {
    drainATSMatching().catch(() => {});
  });
};

export const dispatchATSMatching = (job) => {
  const accepted = queueJob(job);
  if (accepted) scheduleDrain();

  return {
    accepted,
    provider: 'LOCAL',
  };
};

export const recoverPendingATSMatching = async () => {
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
    { $limit: RECOVERY_BATCH_SIZE },
    {
      $project: {
        companyId: 1,
        candidate: 1,
        job: 1,
        pendingATS: { $arrayElemAt: ['$atsResults', 0] },
      },
    },
  ]);

  for (const resume of resumes) {
    const parseResult = await ResumeParseResult.findOne({
      companyId: resume.companyId,
      candidate: resume.candidate,
      resume: resume._id,
      status: 'COMPLETED',
    })
      .select('_id')
      .sort({ completedAt: -1 })
      .lean();

    if (!parseResult) continue;

    queueJob({
      companyId: resume.companyId,
      candidateId: resume.candidate,
      jobId: resume.job,
      resumeId: resume._id,
      parseResultId: parseResult._id,
      trigger: resume.pendingATS?.recalculationPending
        ? 'MANUAL_REPROCESS'
        : 'STARTUP_RECOVERY',
      actorId: resume.pendingATS?.recalculationRequestedBy || null,
    });
  }

  scheduleDrain();

  return {
    provider: 'LOCAL',
    queued: queue.length,
    capacity: MAX_LOCAL_QUEUE,
  };
};

export const atsDispatcherState = () => ({
  provider: 'LOCAL',
  queued: queue.length,
  capacity: MAX_LOCAL_QUEUE,
  draining,
});
