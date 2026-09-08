// Phase 30.8 — BGV verification workbench service.
//
// Authorization chain (every call): authenticated verifier → CURRENT
// explicit assignment to the exact check (30.7 model) → operational state
// allows the action. Specialization alone grants nothing; former verifiers
// lose access the moment the assignment row changes; deactivated accounts
// cannot hold valid sessions (30.6).
//
// History rules: activities and discrepancies are append-only via atomic
// pipeline updates (seq monotonic). Submitted findings are LOCKED by an
// atomic conditional write of `conclusion` — later edits 409. Nothing is
// silently overwritten or deleted.
//
// Human-decision boundary: a conclusion is a BGV finding. This service
// never mutates candidate.currentStage, never rejects/hires, never marks a
// whole BGV CLEAR. Check completion ≠ case completion (30.10 consolidates).

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import BgvOrder from '../../models/BgvOrder.js';
import BgvCollectionCase from '../../models/BgvCollectionCase.js';
import BgvCheckVerification from '../../models/BgvCheckVerification.js';
import BgvVerifierEvidenceFile from '../../models/BgvVerifierEvidenceFile.js';
import ApiError from '../../utils/ApiError.js';
import { recordAudit } from '../../utils/securityauditService.js';
import { isCommerciallyAuthorized } from './bgvOrderRules.js';
import { getStoredBgvEvidence, storeBgvEvidence } from './bgvEvidenceStorageService.js';
import { loadOwnAssignment } from './bgvAssignmentService.js';
import {
  METHOD_OUTCOMES,
  METHOD_REGISTRY,
  VERIFIER_CONCLUSIONS,
  buildWorkbenchView,
  safeActivity,
  evaluateConclusionReadiness,
  sanitizeDiscrepancy,
  sanitizeNotes,
  sanitizeObservations,
} from './bgvWorkbenchRules.js';

const isObjectId = (value) => mongoose.isValidObjectId(value);

// ── default collaborators (DI for hermetic tests) ─────────────────
const defaultLoadOrderById = ({ orderId }) =>
  isObjectId(orderId) ? BgvOrder.findOne({ _id: orderId }).lean() : Promise.resolve(null);
const defaultLoadCase = ({ companyId, orderId }) =>
  BgvCollectionCase.findOne({ companyId, bgvOrder: orderId }).lean();
const defaultFindVerification = ({ orderId, checkType }) =>
  BgvCheckVerification.findOne({ bgvOrder: orderId, checkType, activeKey: 'CURRENT' }).lean();
const defaultInsertVerification = (doc) => BgvCheckVerification.create(doc);
// Atomic pipeline update: appends one activity with seq = size+1 in a
// single server-side operation (no read-then-save race).
// Mongoose 9 requires `updatePipeline: true` for array-pipeline updates.
export const defaultAppendActivity = ({ verificationId, activity }) =>
  BgvCheckVerification.findOneAndUpdate(
    { _id: verificationId, activeKey: 'CURRENT', conclusion: null },
    [
      {
        $set: {
          activities: {
            $concatArrays: [
              '$activities',
              [{ $mergeObjects: [activity, { seq: { $add: [{ $size: '$activities' }, 1] } }] }],
            ],
          },
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true }
  ).lean();
export const defaultAppendDiscrepancy = ({ verificationId, discrepancy }) =>
  BgvCheckVerification.findOneAndUpdate(
    { _id: verificationId, activeKey: 'CURRENT', conclusion: null },
    [{ $set: { discrepancies: { $concatArrays: ['$discrepancies', [discrepancy]] } } }],
    { returnDocument: 'after', updatePipeline: true }
  ).lean();
const defaultUpdateVerificationState = ({ verificationId, onlyStates, set }) =>
  BgvCheckVerification.findOneAndUpdate(
    {
      _id: verificationId,
      activeKey: 'CURRENT',
      conclusion: null,
      ...(onlyStates ? { state: { $in: onlyStates } } : {}),
    },
    { $set: set },
    { returnDocument: 'after' }
  ).lean();
// Phase 30.10 — submissions are append-only revisions. The conditional filter
// (state NOT SUBMITTED) is the submission lock; QA_RETURNED work re-enters
// here as revision N+1 while v1..vN stay immutable inside `submissions`.
const defaultSubmitConclusion = ({ verificationId, conclusion, revision = 1, discrepancyCount = 0 }) =>
  BgvCheckVerification.findOneAndUpdate(
    { _id: verificationId, activeKey: 'CURRENT', state: { $nin: ['SUBMITTED'] } },
    {
      $set: {
        conclusion,
        state: 'SUBMITTED',
        qaStatus: 'PENDING',
        qaReturnReason: '',
        'qa.status': 'PENDING',
        'qa.currentRevision': revision,
        'qa.reviewedBy': null,
        'qa.reviewedAt': null,
        'qa.returnReason': '',
      },
      $push: {
        submissions: {
          revision,
          conclusion,
          discrepancyCountAtSubmission: discrepancyCount,
          submittedAt: conclusion?.submittedAt || new Date(),
          qa: { status: 'PENDING' },
        },
      },
    },
    { returnDocument: 'after' }
  ).lean();
const defaultInsertEvidenceFile = (doc) => BgvVerifierEvidenceFile.create(doc);
const defaultLoadEvidenceFile = ({ fileId }) =>
  isObjectId(fileId)
    ? BgvVerifierEvidenceFile.findOne({ _id: fileId }).select('+storageKey +checksumSha256').lean()
    : Promise.resolve(null);
const defaultAttachEvidence = ({ verificationId, activitySeq, evidenceFileId }) =>
  BgvCheckVerification.findOneAndUpdate(
    { _id: verificationId, activeKey: 'CURRENT', conclusion: null, 'activities.seq': activitySeq },
    { $set: { 'activities.$[activity].evidenceFile': evidenceFileId } },
    { arrayFilters: [{ 'activity.seq': activitySeq }], returnDocument: 'after' }
  ).lean();
const defaultStoreFile = (args) => storeBgvEvidence(args);
const defaultFetchFile = (args) => getStoredBgvEvidence(args);
const defaultAudit = (entry) => recordAudit(entry);

const auditSafe = (audit, entry) => audit(entry).catch(() => {});


const ensureVerification = async ({ order, deps }) => {
  const findVerification = deps.findVerification || defaultFindVerification;
  const insertVerification = deps.insertVerification || defaultInsertVerification;
  const existing = await findVerification({ orderId: order._id, checkType: order.checkType });
  if (existing) return existing;
  try {
    const created = await insertVerification({
      companyId: order.companyId,
      bgvOrder: order._id,
      candidate: order.candidate,
      checkType: order.checkType,
      state: 'IN_PROGRESS',
      activities: [],
      discrepancies: [],
      conclusion: null,
    });
    return created;
  } catch (error) {
    if (error?.code === 11000) {
      return findVerification({ orderId: order._id, checkType: order.checkType });
    }
    throw error;
  }
};

// Shared gate: assignment + order sanity + verification row.
const openWorkbench = async ({ verifierId, orderId, checkType, deps }) => {
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;
  const assignment = await loadOwnAssignment({ verifierId, orderId, checkType, deps });
  const order = await loadOrderById({ orderId });
  if (!order || !isCommerciallyAuthorized(order)) throw ApiError.notFound('BGV order not found');
  const verification = await ensureVerification({ order: { ...order, checkType: String(checkType).toUpperCase() }, deps });
  if (!verification) throw ApiError.conflict('Verification record could not be created');
  return { assignment, order, verification };
};

// ── activities (append-only attempts) ─────────────────────────────
export const recordActivity = async ({ verifierId, orderId, checkType, method, outcome, observations, notes, requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const appendActivity = deps.appendActivity || defaultAppendActivity;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;

  const safeCheck = String(checkType || '').toUpperCase();
  const { verification } = await openWorkbench({ verifierId, orderId, checkType: safeCheck, deps });
  // Submission locking: history is immutable after final findings.
  if (verification.state === 'SUBMITTED') {
    throw ApiError.conflict('Check findings are submitted — history is locked');
  }

  const safeMethod = String(method || '').toUpperCase();
  if (!(METHOD_REGISTRY[safeCheck] || []).includes(safeMethod)) {
    throw ApiError.badRequest('Method is not allowed for this check type');
  }
  const safeOutcome = String(outcome || '').toUpperCase();
  if (!(METHOD_OUTCOMES[`${safeCheck}:${safeMethod}`] || []).includes(safeOutcome)) {
    throw ApiError.badRequest('Outcome is not allowed for this method');
  }
  // Backend-controlled schema: unknown fields dropped, forbidden rejected.
  const cleanObservations = sanitizeObservations({ checkType: safeCheck, method: safeMethod, observations });

  const activity = {
    method: safeMethod,
    outcome: safeOutcome,
    verifier: verifierId,
    at: new Date(),
    observations: cleanObservations,
    notes: sanitizeNotes(notes),
    evidenceFile: null,
  };

  const updated = await appendActivity({ verificationId: verification._id, activity });
  if (!updated) throw ApiError.conflict('The verification record changed concurrently — retry');

  const order = await loadOrderById({ orderId });
  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_CHECK_ACTIVITY_RECORDED',
    resource: 'BgvCheckVerification',
    resourceId: updated._id,
    // Safe metadata only — never notes content, identifiers, or UANs.
    metadata: { orderCode: order?.orderCode || '', checkType: safeCheck, method: safeMethod, outcome: safeOutcome, verifierId: String(verifierId), phase: '30.8' },
  });

  const created = (updated.activities || []).at(-1);
  return { activity: safeActivity(created), verificationState: updated.state };
};

// ── discrepancies (structured findings, never hiring decisions) ───
export const recordDiscrepancy = async ({ verifierId, orderId, checkType, input = {}, requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const appendDiscrepancy = deps.appendDiscrepancy || defaultAppendDiscrepancy;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;

  const safeCheck = String(checkType || '').toUpperCase();
  const { verification } = await openWorkbench({ verifierId, orderId, checkType: safeCheck, deps });
  if (verification.state === 'SUBMITTED') {
    throw ApiError.conflict('Check findings are submitted — history is locked');
  }

  const discrepancy = {
    ...sanitizeDiscrepancy(input),
    recordedBy: verifierId,
    at: new Date(),
  };
  const updated = await appendDiscrepancy({ verificationId: verification._id, discrepancy });
  if (!updated) throw ApiError.conflict('The verification record changed concurrently — retry');

  const order = await loadOrderById({ orderId });
  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_CHECK_DISCREPANCY_RECORDED',
    resource: 'BgvCheckVerification',
    resourceId: updated._id,
    metadata: { orderCode: order?.orderCode || '', checkType: safeCheck, field: discrepancy.field, severity: discrepancy.severity, phase: '30.8' },
  });
  return { discrepancy: (updated.discrepancies || []).at(-1) };
};

// ── operational state (NOT a conclusion) ──────────────────────────
export const setWorkbenchState = async ({ verifierId, orderId, checkType, state, deps = {} }) => {
  const updateState = deps.updateVerificationState || defaultUpdateVerificationState;
  const safeState = String(state || '').toUpperCase();
  if (!['IN_PROGRESS', 'AWAITING_THIRD_PARTY'].includes(safeState)) {
    throw ApiError.badRequest('Only IN_PROGRESS or AWAITING_THIRD_PARTY can be set by a verifier');
  }
  const { verification } = await openWorkbench({ verifierId, orderId, checkType, deps });
  if (verification.state === 'SUBMITTED') {
    throw ApiError.conflict('Check findings are submitted — state is locked');
  }
  const updated = await updateState({
    verificationId: verification._id,
    onlyStates: ['IN_PROGRESS', 'AWAITING_THIRD_PARTY'],
    set: { state: safeState },
  });
  if (!updated) throw ApiError.conflict('The verification record changed concurrently — retry');
  return { state: updated.state };
};

// ── final conclusion (validated + locked) ─────────────────────────
export const submitConclusion = async ({ verifierId, orderId, checkType, conclusion, reason = '', requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const submit = deps.submitConclusion || defaultSubmitConclusion;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;

  const safeCheck = String(checkType || '').toUpperCase();
  const safeConclusion = String(conclusion || '').toUpperCase();
  // CANCELLED is reserved for platform operations — never a verifier choice.
  if (!VERIFIER_CONCLUSIONS.includes(safeConclusion)) {
    throw ApiError.forbidden('This conclusion is not available to verifiers');
  }

  const { verification } = await openWorkbench({ verifierId, orderId, checkType: safeCheck, deps });

  if (verification.state === 'SUBMITTED' && verification.conclusion) {
    const same =
      verification.conclusion.value === safeConclusion &&
      String(verification.conclusion.submittedByVerifier) === String(verifierId);
    if (same) return { conclusion: verification.conclusion, idempotent: true };
    throw ApiError.conflict('Check findings are already submitted and locked');
  }

  // Backend readiness engine — frontend validation is a convenience only.
  const readiness = evaluateConclusionReadiness({
    conclusion: safeConclusion,
    reason,
    activities: verification.activities || [],
    discrepancies: verification.discrepancies || [],
  });
  if (!readiness.ok) {
    throw ApiError.badRequest(readiness.errors.join('; '));
  }

  const conclusionDoc = {
    value: safeConclusion,
    reason: String(reason || '').trim().slice(0, 1000),
    submittedBy: null,
    submittedByVerifier: verifierId,
    submittedAt: new Date(),
    activityCountAtSubmission: (verification.activities || []).length,
  };

  // Phase 30.10 — revision numbering: QA-returned work resubmits as N+1;
  // earlier revisions remain immutable history (never overwritten).
  const revision = (verification.submissions || []).length + 1;

  // Atomic conditional write = submission lock. A racing second submit
  // fails the `state NOT SUBMITTED` filter and lands in the idempotent path.
  const updated = await submit({
    verificationId: verification._id,
    conclusion: conclusionDoc,
    revision,
    discrepancyCount: (verification.discrepancies || []).length,
  });
  if (!updated) {
    const current = await (deps.findVerification || defaultFindVerification)({ orderId, checkType: safeCheck });
    if (
      current?.conclusion?.value === safeConclusion &&
      String(current.conclusion.submittedByVerifier) === String(verifierId)
    ) {
      return { conclusion: current.conclusion, idempotent: true };
    }
    throw ApiError.conflict('Check findings were submitted concurrently — reload');
  }

  const order = await loadOrderById({ orderId });
  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_CHECK_CONCLUSION_SUBMITTED',
    resource: 'BgvCheckVerification',
    resourceId: updated._id,
    metadata: { orderCode: order?.orderCode || '', checkType: safeCheck, conclusion: safeConclusion, revision, verifierId: String(verifierId), phase: '30.10' },
  });
  // NOTE: intentionally NO candidate pipeline mutation, NO case CLEAR,
  // NO tenant report release here — 30.10 owns consolidation.
  return { conclusion: updated.conclusion, idempotent: false };
};

// ── platform cancellation (Super Admin only) ──────────────────────
export const cancelCheckByOperations = async ({ actorId, orderId, checkType, reason = '', requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const submit = deps.submitConclusion || defaultSubmitConclusion;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;

  const safeCheck = String(checkType || '').toUpperCase();
  const trimmed = String(reason || '').trim();
  if (trimmed.length < 10) throw ApiError.badRequest('Cancellation requires a business reason (min 10 characters)');

  const loadVerifierlessOrder = await loadOrderById({ orderId });
  if (!loadVerifierlessOrder || !isCommerciallyAuthorized(loadVerifierlessOrder)) {
    throw ApiError.notFound('BGV order not found');
  }
  const findVerification = deps.findVerification || defaultFindVerification;
  let verification = await findVerification({ orderId, checkType: safeCheck });
  if (!verification) {
    const insertVerification = deps.insertVerification || defaultInsertVerification;
    verification = await insertVerification({
      companyId: loadVerifierlessOrder.companyId,
      bgvOrder: loadVerifierlessOrder._id,
      candidate: loadVerifierlessOrder.candidate,
      checkType: safeCheck,
      state: 'IN_PROGRESS',
      activities: [],
      discrepancies: [],
      conclusion: null,
    });
  }
  if (verification.conclusion) throw ApiError.conflict('This check already has a final conclusion');

  const updated = await submit({
    verificationId: verification._id,
    conclusion: {
      value: 'CANCELLED',
      reason: trimmed.slice(0, 1000),
      submittedBy: actorId ?? null,
      submittedByVerifier: null,
      submittedAt: new Date(),
      activityCountAtSubmission: (verification.activities || []).length,
    },
  });
  if (!updated) throw ApiError.conflict('The verification record changed concurrently — retry');

  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_CHECK_CANCELLED',
    actorId,
    resource: 'BgvCheckVerification',
    resourceId: updated._id,
    metadata: { orderCode: loadVerifierlessOrder.orderCode, checkType: safeCheck, phase: '30.8' },
  });
  return { conclusion: updated.conclusion };
};

// ── verifier evidence (private, activity-scoped) ──────────────────
export const uploadActivityEvidence = async ({ verifierId, orderId, checkType, activitySeq, file, requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const storeFile = deps.storeFile || defaultStoreFile;
  const insertEvidenceFile = deps.insertEvidenceFile || defaultInsertEvidenceFile;
  const attachEvidence = deps.attachEvidence || defaultAttachEvidence;
  const loadCase = deps.loadCase || defaultLoadCase;

  const safeCheck = String(checkType || '').toUpperCase();
  const { order, verification } = await openWorkbench({ verifierId, orderId, checkType: safeCheck, deps });
  if (verification.state === 'SUBMITTED') {
    throw ApiError.conflict('Check findings are submitted — evidence is locked');
  }
  const seq = Number(activitySeq);
  const activity = (verification.activities || []).find((entry) => entry.seq === seq);
  if (!activity) throw ApiError.notFound('Verification activity not found');

  if (!file || !file.buffer || file.buffer.length === 0) {
    throw ApiError.badRequest('Evidence file is required');
  }

  const collectionCase = await loadCase({ companyId: order.companyId, orderId: order._id });
  if (!collectionCase) throw ApiError.notFound('Candidate submission not found');

  // Reuses the 30.5 private storage posture (authenticated/0600; never a
  // public URL). MIME/size validation happens in the hardened uploader.
  const stored = await storeFile({ buffer: file.buffer, companyId: order.companyId, caseId: collectionCase._id });
  const evidenceDoc = await insertEvidenceFile({
    companyId: order.companyId,
    bgvOrder: order._id,
    bgvCollectionCase: collectionCase._id,
    checkType: safeCheck,
    activitySeq: seq,
    uploadedBy: verifierId,
    originalFileName: String(file.originalname || 'evidence').slice(0, 180),
    mimeType: file.mimetype,
    fileSize: file.size,
    storageProvider: stored.storageProvider,
    storageKey: stored.storageKey,
    checksumSha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    scanStatus: 'NOT_CONFIGURED',
    status: 'ACTIVE',
  });

  const updated = await attachEvidence({ verificationId: verification._id, activitySeq: seq, evidenceFileId: evidenceDoc._id });
  if (!updated) throw ApiError.conflict('The verification record changed concurrently — retry');

  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_VERIFIER_EVIDENCE_UPLOADED',
    resource: 'BgvVerifierEvidenceFile',
    resourceId: evidenceDoc._id,
    metadata: { checkType: safeCheck, activitySeq: seq, mimeType: file.mimetype, verifierId: String(verifierId), phase: '30.8' },
  });

  return {
    id: String(evidenceDoc._id),
    fileName: evidenceDoc.originalFileName,
    mimeType: evidenceDoc.mimeType,
    fileSize: evidenceDoc.fileSize,
    activitySeq: seq,
    uploadedAt: evidenceDoc.uploadedAt,
  };
};

export const downloadActivityEvidence = async ({ verifierId, fileId, requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const loadEvidenceFile = deps.loadEvidenceFile || defaultLoadEvidenceFile;
  const fetchFile = deps.fetchFile || defaultFetchFile;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;

  const file = await loadEvidenceFile({ fileId });
  if (!file || file.status === 'REMOVED') throw ApiError.notFound('Evidence file not found');

  // Authorization = CURRENT assignment to THIS verifier for the file's
  // own check; guessing ids grants nothing.
  await loadOwnAssignment({ verifierId, orderId: file.bgvOrder, checkType: file.checkType, deps });
  const order = await loadOrderById({ orderId: file.bgvOrder });
  if (!order || !isCommerciallyAuthorized(order)) throw ApiError.notFound('Evidence file not found');

  const buffer = await fetchFile({ storageProvider: file.storageProvider, storageKey: file.storageKey });
  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_VERIFIER_EVIDENCE_READ',
    resource: 'BgvVerifierEvidenceFile',
    resourceId: file._id,
    metadata: { checkType: file.checkType, verifierId: String(verifierId), phase: '30.8' },
  });
  return { fileName: file.originalFileName, mimeType: file.mimeType, checksum: file.checksumSha256, buffer };
};
