// ============================================================
//  PHASE 28.6 — DOCUMENT PROCESSING DISPATCHER
//
// Schedules background security/integrity processing for
// pre-onboarding document versions on the reserved DOCUMENTS
// queue (one-time job per version + processingVersion).
//
// INTENT VS TRANSPORT (28.4/28.5 rule):
//   - Mongo is the processing truth:
//     CandidateDocumentVersion.processingStatus (PENDING/FAILED
//     = intent), processingVersion, lease fields.
//   - Redis only knows "run at once". If queue.add fails or
//     Redis is lost, `npm run queue:reconcile` rebuilds jobs
//     from Mongo with the same deterministic ids.
//
// JOB ID (colon-free, deterministic, Mongo-reconstructable):
//   document-process-<documentVersionId>-<processingVersion>
//
// PAYLOAD (references only — validated again by the worker):
//   { companyId, documentId, documentVersionId, processingVersion,
//     correlationId }
// Never: filenames, PII, storage keys, file bytes.
// ============================================================

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import logger from '../config/logger.js';
import { getQueue, enqueueJob, prepareJobSlot } from '../queues/queueFactory.js';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  getDocumentJobOptions,
  redactConnectionSecrets,
} from '../config/queueConfig.js';
import CandidateDocumentVersion from '../models/CandidateDocumentVersion.js';

const safeIdSegment = (value) =>
  /^[a-f0-9]{24}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';

export const buildDocumentProcessJobId = (documentVersionId, processingVersion) => {
  const id = safeIdSegment(documentVersionId);
  const version = Number(processingVersion);
  if (!id || !Number.isInteger(version) || version < 1) return null;
  return `document-process-${id}-${version}`;
};

// Shared never-throwing producer. Returns { scheduled, error? }.
const addDocumentJob = async ({ jobName, jobId, payload, enqueue }) => {
  try {
    const add = enqueue ||
      (async (id, data) => {
        const queue = getQueue(QUEUE_NAMES.DOCUMENTS);
        await prepareJobSlot(queue, id);
        return enqueueJob(QUEUE_NAMES.DOCUMENTS, jobName, data, {
          jobId: id,
          ...getDocumentJobOptions(),
        });
      });
    await add(jobId, payload);
    return { scheduled: true, jobId };
  } catch (error) {
    const safeText = redactConnectionSecrets(
      `${error?.message || 'queue unavailable'}`
    ).slice(0, 160);
    logger.warn(
      `[Document] enqueue failed (${jobName}, jobId=${jobId}) — intent stays in ` +
        `Mongo (npm run queue:reconcile requeues). (${safeText})`
    );
    return { scheduled: false, error: safeText };
  }
};

// Called by the service AFTER the version document is committed.
// `version` needs: _id, companyId, candidateDocument, processingVersion.
export const scheduleDocumentProcessing = async (version, { enqueue } = {}) => {
  if (
    !version?._id ||
    !mongoose.isValidObjectId(version.companyId) ||
    !version.candidateDocument
  ) {
    return { scheduled: false, reason: 'NOT_ELIGIBLE' };
  }
  const jobId = buildDocumentProcessJobId(version._id, version.processingVersion ?? 1);
  if (!jobId) return { scheduled: false, reason: 'INVALID_ID' };

  return addDocumentJob({
    jobName: JOB_NAMES.DOCUMENT_PROCESS,
    jobId,
    payload: {
      companyId: String(version.companyId),
      documentId: String(version.candidateDocument),
      documentVersionId: String(version._id),
      processingVersion: Math.trunc(Number(version.processingVersion) || 1),
      correlationId: crypto.randomUUID(),
    },
    enqueue,
  });
};

// Reconcile scan target (bounded window, trusted internal process).
export const loadDocumentVersionsForReconcile = async ({ now, windowDays = 90, limit = 500 }) =>
  CandidateDocumentVersion.find({
    processingStatus: { $in: ['PENDING', 'PROCESSING', 'PROCESSING_FAILED'] },
    uploadedAt: { $gt: new Date(now.getTime() - windowDays * 86400000), $lte: now },
    // Only RECOVERABLE intent is re-queued:
    //  - PENDING (never started)
    //  - PROCESSING with an EXPIRED lease (worker died mid-run)
    //  - PROCESSING_FAILED with a retryable terminal category
    //    (FILE_NOT_FOUND / STORAGE_UNAVAILABLE — storage may recover;
    //     INTEGRITY_MISMATCH / UNSUPPORTED_FILE / CORRUPT_FILE are
    //     permanent for the stored bytes and stay failed)
    $or: [
      { processingStatus: 'PENDING' },
      {
        processingStatus: 'PROCESSING_FAILED',
        processingLastError: { $in: ['FILE_NOT_FOUND', 'STORAGE_UNAVAILABLE', ''] },
      },
      {
        processingStatus: 'PROCESSING',
        processingLeaseExpiresAt: { $ne: null, $lt: now },
      },
    ],
  })
    .select('companyId candidateDocument processingVersion')
    .sort({ uploadedAt: 1, _id: 1 })
    .limit(Math.min(2000, Math.max(1, limit)))
    .lean();

// Bounded reconciliation runner (CLI). Re-derives jobs from Mongo
// intent with deterministic ids — idempotent; slot-prep clears dead
// FAILED jobs under the same id. Never throws.
export const runDocumentReconcile = async (
  { now = new Date(), windowDays = 90, limit = 500, enqueue, loadVersions = loadDocumentVersionsForReconcile } = {}
) => {
  const summary = { checked: 0, scheduled: 0, skipped: 0, errors: 0 };
  let versions = [];
  try {
    versions = await loadVersions({ now, windowDays, limit });
  } catch {
    summary.errors += 1;
    return summary;
  }
  for (const version of versions) {
    summary.checked += 1;
    try {
      const res = await scheduleDocumentProcessing(version, { enqueue });
      if (res.scheduled) summary.scheduled += 1;
      else summary.skipped += 1;
    } catch {
      summary.errors += 1;
    }
  }
  return summary;
};
