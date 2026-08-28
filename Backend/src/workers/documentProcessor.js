// ============================================================
//  PHASE 28.6 — DOCUMENT WORKER PROCESSOR
//
// DOCUMENT_PROCESS — background security/integrity processing for
// a pre-onboarding document version.
//
// Flow (references-only job, everything re-fetched from Mongo):
//   validate payload → tenant-scoped version load → relationship
//   checks → atomic lease claim (version-scoped) → server-side
//   bounded file fetch → sha256 integrity vs stored checksum →
//   EXISTING security abstraction on the stored bytes → update
//   THIS version document only.
//
// Guarantees:
//   - No file bytes/paths/names in Redis or logs.
//   - Old versions can never touch the new version (job targets a
//     single documentVersionId; writes are version-scoped).
//   - No fake CLEAN: without a configured scanner the version's
//     scanStatus stays NOT_CONFIGURED.
//   - Security result is separated from business review state —
//     processing success never marks a document VERIFIED.
//
// Outcomes:
//   { processed: true, documentVersionId }            → completed
//   { skipped: true, reason }                          → completed, NO retry
//   throw (STORAGE_UNAVAILABLE, transient DB, unknown) → BullMQ retry
// ============================================================

import crypto from 'node:crypto';
import logger from '../config/logger.js';
import { JOB_NAMES } from '../config/queueConfig.js';
import CandidateDocumentVersion from '../models/CandidateDocumentVersion.js';
import CandidateDocument from '../models/CandidateDocument.js';
import PreOnboarding from '../models/PreOnboarding.js';
import PreOnboardingHistory from '../models/PreOnboardingHistory.js';
import { recordAudit } from '../utils/securityauditService.js';
import {
  getStoredPreOnboardingDocument,
} from '../services/preOnboardingDocumentStorageService.js';
import { verifyStoredDocumentBuffer } from '../services/preOnboardingDocumentSecurityService.js';
import { notifyRoles } from '../utils/notify.js';

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const PROCESSING_LEASE_MS = 2 * 60 * 1000;

const validateDocumentPayload = (data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const keys = Object.keys(data).sort();
  if (
    keys.length !== 5 ||
    !['companyId', 'correlationId', 'documentId', 'documentVersionId', 'processingVersion'].every(
      (k) => keys.includes(k)
    )
  ) {
    return false;
  }
  if (!OBJECT_ID.test(data.companyId)) return false;
  if (!OBJECT_ID.test(data.documentId)) return false;
  if (!OBJECT_ID.test(data.documentVersionId)) return false;
  const version = Number(data.processingVersion);
  return Number.isInteger(version) && version >= 1 && version < 100000;
};

// ── Default adapters (DI-able in tests) ─────────────────────────

const defaultLoadVersion = (value) =>
  CandidateDocumentVersion.findOne({
    _id: value.documentVersionId,
    companyId: value.companyId,
  })
    .select('+storageKey +checksumSha256')
    .lean();

const defaultLoadDocument = (value) =>
  CandidateDocument.findOne({ _id: value.documentId, companyId: value.companyId })
    .select('_id candidate')
    .lean();

const defaultClaim = (version, value) =>
  CandidateDocumentVersion.findOneAndUpdate(
    {
      _id: version._id,
      companyId: value.companyId,
      processingVersion: value.processingVersion,
      $or: [
        { processingStatus: { $in: ['PENDING', 'PROCESSING_FAILED'] } },
        {
          processingStatus: 'PROCESSING',
          processingLeaseExpiresAt: { $ne: null, $lt: new Date() },
        },
      ],
    },
    {
      $set: {
        processingStatus: 'PROCESSING',
        processingLeaseId: crypto.randomUUID(),
        processingLeaseExpiresAt: new Date(Date.now() + PROCESSING_LEASE_MS),
        processingLastError: '',
      },
      $inc: { processingAttempts: 1 },
    },
    { returnDocument: 'after' }
  );

const defaultFinish = (version, value, fields) =>
  CandidateDocumentVersion.updateOne(
    {
      _id: version._id,
      companyId: value.companyId,
      processingVersion: value.processingVersion,
    },
    { $set: fields }
  );

// One business event per security rejection (never per retry):
// pre-onboarding history entry + audit record.
const defaultRecordRejectedEvent = async ({ version, document, value }) => {
  const preOnboarding = await PreOnboarding.findOne({
    _id: version.preOnboarding,
    companyId: value.companyId,
  })
    .select('candidate job status')
    .lean();
  if (preOnboarding) {
    await PreOnboardingHistory.create({
      companyId: value.companyId,
      preOnboarding: preOnboarding._id,
      candidate: preOnboarding.candidate,
      job: preOnboarding.job,
      action: 'PRE_ONBOARDING_DOC_SECURITY_REJECTED',
      previousStatus: preOnboarding.status,
      newStatus: preOnboarding.status,
      actorType: 'SYSTEM',
      actor: null,
      metadata: {
        documentId: document._id,
        documentVersionId: version._id,
        category: 'BACKGROUND_SECURITY_SCAN',
      },
    });
  }
  await recordAudit({
    req: null,
    action: 'PREONBOARDING_DOC_SECURITY_REJECTED',
    companyId: value.companyId,
    actorId: null,
    resource: 'CandidateDocumentVersion',
    resourceId: version._id,
    metadata: { documentId: document._id, documentVersionId: version._id },
    critical: true,
  });
};

// Retryable transport/storage failures throw; permanent categories
// complete as PROCESSING_FAILED (no retry spam, §16).
const isTransientStorageError = (error) => {
  const msg = String(error?.message || '').toLowerCase();
  if (error?.statusCode === 404 || /not found/i.test(msg)) return false;
  if (error?.statusCode === 413) return false;
  return true; // 503, network, timeout, transient DB
};

const defaultClearLease = (version, value) =>
  CandidateDocumentVersion.updateOne(
    { _id: version._id, companyId: value.companyId },
    { $set: { processingLeaseId: '', processingLeaseExpiresAt: null } }
  );

// verify() throws ApiError(400) for unsupported/corrupt content —
// permanent (the stored bytes never change), so the worker records
// a terminal category instead of retrying.
const classifyVerifyError = (error) => {
  const msg = String(error?.message || '').toLowerCase();
  if (error?.statusCode === 400 || /unsupported|invalid|corrupt|malformed/i.test(msg)) {
    return /corrupt|truncated|unreadable/i.test(msg) ? 'CORRUPT_FILE' : 'UNSUPPORTED_FILE';
  }
  return null; // transient (scanner 5xx, network) → retry
};

export const documentProcessProcessor = async (job, deps = {}) => {
  const loadVersion = deps.loadVersion || defaultLoadVersion;
  const loadDocument = deps.loadDocument || defaultLoadDocument;
  const claim = deps.claim || defaultClaim;
  const fetchFile = deps.fetchFile || getStoredPreOnboardingDocument;
  const verify = deps.verify || verifyStoredDocumentBuffer;
  const finish = deps.finish || defaultFinish;
  const clearLease = deps.clearLease || defaultClearLease;
  const notify = deps.notify || notifyRoles;
  const recordRejectedEvent = deps.recordRejectedEvent || defaultRecordRejectedEvent;

  if (!validateDocumentPayload(job.data)) {
    throw new Error('DOCUMENT_PROCESS rejected: payload validation failed');
  }
  const value = job.data;

  // Tenant-scoped version lookup (storageKey/checksum are select:false).
  const version = await loadVersion(value);
  if (!version) return { skipped: true, reason: 'NOT_FOUND' };

  // Version scoping: the job must match the version's processing
  // version (a reconcile re-versioned job supersedes stale ones).
  if (Math.trunc(Number(version.processingVersion)) !== value.processingVersion) {
    return { skipped: true, reason: 'STALE_VERSION' };
  }
  // Relationship: the version belongs to the referenced document,
  // which belongs to this tenant.
  const document = await loadDocument(value);
  if (!document) return { skipped: true, reason: 'NOT_FOUND' };
  if (String(version.candidateDocument) !== String(document._id)) {
    return { skipped: true, reason: 'TENANT_MISMATCH' };
  }

  const claimed = await claim(version, value);
  if (!claimed) {
    if (version.processingStatus === 'PROCESSED') {
      return { skipped: true, reason: 'ALREADY_PROCESSED' };
    }
    return { skipped: true, reason: 'IN_FLIGHT' };
  }

  try {
    // Server-side bounded fetch (never exposed, never logged).
    let buffer;
    try {
      buffer = await fetchFile({
        storageProvider: version.storageProvider,
        storageKey: version.storageKey,
      });
    } catch (error) {
      if (!isTransientStorageError(error)) {
        await finish(version, value, {
          processingStatus: 'PROCESSING_FAILED',
          processingLastError:
            error?.statusCode === 404 ? 'FILE_NOT_FOUND' : 'STORAGE_UNAVAILABLE',
          processingLeaseId: '',
          processingLeaseExpiresAt: null,
        }).catch(() => {});
        return { skipped: true, reason: error?.statusCode === 404 ? 'FILE_NOT_FOUND' : 'STORAGE_UNAVAILABLE' };
      }
      throw error; // retryable
    }

    // Integrity: the STORED bytes must match the checksum recorded
    // at upload. A mismatch is a security signal — terminal, no retry.
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    if (checksum !== String(version.checksumSha256 || '').toLowerCase()) {
      await finish(version, value, {
        processingStatus: 'PROCESSING_FAILED',
        processingLastError: 'INTEGRITY_MISMATCH',
        processingLeaseId: '',
        processingLeaseExpiresAt: null,
      }).catch(() => {});
      logger.warn(
        `[Document] integrity mismatch (version=${version._id}) — flagged PROCESSING_FAILED`
      );
      return { skipped: true, reason: 'INTEGRITY_MISMATCH' };
    }

    // Existing security abstraction on the stored bytes.
    let scan;
    try {
      scan = await verify({ buffer, mimeType: version.mimeType });
    } catch (error) {
      const terminalCategory = classifyVerifyError(error);
      if (terminalCategory) {
        // Permanent: stored bytes cannot change — no retry.
        await finish(version, value, {
          processingStatus: 'PROCESSING_FAILED',
          processingLastError: terminalCategory,
          processingLeaseId: '',
          processingLeaseExpiresAt: null,
        }).catch(() => {});
        return { skipped: true, reason: terminalCategory };
      }
      throw error; // transient scanner failure → BullMQ retry
    }

    let scanStatus = version.scanStatus; // default: keep (NOT_CONFIGURED stays honest)
    let scanCheckedAt = null;
    if (scan.status === 'CLEAN') {
      scanStatus = 'CLEAN';
      scanCheckedAt = new Date();
    } else if (scan.status === 'REJECTED') {
      scanStatus = 'REJECTED';
      scanCheckedAt = new Date();
    }
    // ERROR from a real scanner → keep visible, terminal.

    await finish(version, value, {
      scanStatus,
      ...(scanCheckedAt ? { scanCheckedAt } : {}),
      processingStatus: 'PROCESSED',
      processedAt: new Date(),
      processingLastError: '',
      processingLeaseId: '',
      processingLeaseExpiresAt: null,
    });

    if (scanStatus === 'REJECTED') {
      // Business event (not a retry): one history entry + audit +
      // HR in-app notice. The business review state is untouched —
      // a security verdict is separate from HR verification.
      await recordRejectedEvent({ version, document, value }).catch(() => {});
      await notify(value.companyId, ['COMPANY_ADMIN', 'HR_MANAGER'], {
        type: 'RECRUITMENT',
        title: 'Document security rejection',
        message: `A pre-onboarding document failed background security validation (document ${document._id}). HR review required.`,
        link: '/app/recruitment/pre-onboarding',
      }).catch(() => {});
      logger.info(
        `[Document] security REJECTED (version=${version._id}) — HR notified, business status untouched`
      );
    }

    logger.info(`[Document] processed (version=${version._id}, scan=${scanStatus})`);
    return { processed: true, documentVersionId: String(version._id) };
  } catch (error) {
    // Retryable: clear the lease so the retry can re-claim. The
    // business scan/status is untouched.
    await clearLease(version, value).catch(() => {});
    throw error;
  }
};

export const registerDocumentProcessors = ({ registerProcessor }) => {
  registerProcessor(JOB_NAMES.DOCUMENT_PROCESS, documentProcessProcessor);
  logger.info(`[Queue] DOCUMENTS processor ready (${JOB_NAMES.DOCUMENT_PROCESS})`);
};
