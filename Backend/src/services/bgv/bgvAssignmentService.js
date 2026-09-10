// Phase 30.7 — BGV CHECK ASSIGNMENT & verifier workspace service.
//
// Security boundaries (read before changing):
//  - SPECIALIZATION != AUTHORIZATION: a specialization only makes a verifier
//    ELIGIBLE to be assigned; candidate data is reachable only through a
//    CURRENT assignment row for the exact check, plus an ACTIVE account.
//  - CHECK-LEVEL MINIMUM DATA: detail DTOs are projected per check type on
//    the backend — no giant candidate object, no unrelated-check evidence,
//    no payment/pricing fields, no full identity numbers (masked only).
//  - AUTHORITY CHAIN: authenticated platform operator assigns; verifier
//    identity for the workspace is ALWAYS the authenticated session
//    principal, never a client-supplied verifierId.
//  - FORMER / DEACTIVATED VERIFIERS lose access immediately: authorization
//    re-reads the CURRENT assignment + account state on every request;
//    history grants nothing.
//  - CONCURRENCY: one CURRENT row per (order, checkType) via a partial
//    unique index; reassign/unassign/start are atomic conditional updates
//    with appended immutable history.
//  - NO CONCLUSIONS: statuses here are operational (ASSIGNED/IN_PROGRESS);
//    verification results, contacts, DigiLocker, and pipeline changes are
//    Phase 30.8+ and absent here.

import mongoose from 'mongoose';
import BgvOrder from '../../models/BgvOrder.js';
import Candidate from '../../models/Candidate.js';
import Company from '../../models/Company.js';
import BgvConsentAccessToken from '../../models/BgvConsentAccessToken.js';
import BgvCollectionCase from '../../models/BgvCollectionCase.js';
import BgvEvidenceFile from '../../models/BgvEvidenceFile.js';
import BgvVerifier from '../../models/BgvVerifier.js';
import BgvCheckAssignment from '../../models/BgvCheckAssignment.js';
import BgvCheckVerification from '../../models/BgvCheckVerification.js';
import ApiError from '../../utils/ApiError.js';
import { recordAudit } from '../../utils/securityauditService.js';
import { getStoredBgvEvidence } from './bgvEvidenceStorageService.js';
import { isCommerciallyAuthorized } from './bgvOrderRules.js';
import { sanitizeVerifier } from './bgvVerifierRules.js';
import { buildWorkbenchView } from './bgvWorkbenchRules.js';

const isObjectId = (value) => mongoose.isValidObjectId(value);
const FIVE_CHECKS = ['IDENTITY', 'ADDRESS', 'EDUCATION', 'EMPLOYMENT', 'REFERENCE'];

// ── default collaborators ─────────────────────────────────────────
const defaultLoadOrderById = ({ orderId }) =>
  isObjectId(orderId) ? BgvOrder.findOne({ _id: orderId }).lean() : Promise.resolve(null);
const defaultLoadCompany = ({ companyId }) => Company.findOne({ _id: companyId }).select('name').lean();
const defaultLoadCandidate = ({ companyId, candidateId }) =>
  Candidate.findOne({ _id: candidateId, companyId }).select('name email candidateCode').lean();
const defaultLoadLatestToken = ({ companyId, orderId }) =>
  BgvConsentAccessToken.findOne({ companyId, bgvOrder: orderId }).sort({ createdAt: -1 }).lean();
const defaultLoadCase = ({ companyId, orderId }) =>
  BgvCollectionCase.findOne({ companyId, bgvOrder: orderId }).lean();
const defaultListActiveFiles = ({ companyId, caseId }) =>
  BgvEvidenceFile.find({ companyId, bgvCollectionCase: caseId, isActive: true }).lean();
const defaultLoadVerifier = ({ verifierId }) =>
  isObjectId(verifierId) ? BgvVerifier.findById(verifierId).lean() : Promise.resolve(null);
const defaultListActiveVerifiers = () => BgvVerifier.find({ status: 'ACTIVE' }).lean();
const defaultFindAssignment = ({ orderId, checkType }) =>
  BgvCheckAssignment.findOne({ bgvOrder: orderId, checkType, activeKey: 'CURRENT' }).lean();
const defaultInsertAssignment = (doc) => BgvCheckAssignment.create(doc);
const defaultUpdateAssignment = ({ assignmentId, onlyStatus, set, push }) =>
  BgvCheckAssignment.findOneAndUpdate(
    { _id: assignmentId, activeKey: 'CURRENT', ...(onlyStatus ? { status: onlyStatus } : {}) },
    { $set: set, ...(push ? { $push: { history: push } } : {}) },
    { returnDocument: 'after' }
  ).lean();
const defaultListAssignmentsForOrders = ({ orderIds }) =>
  orderIds === null || orderIds === undefined
    ? BgvCheckAssignment.find({ activeKey: 'CURRENT' }).lean()
    : BgvCheckAssignment.find({ bgvOrder: { $in: orderIds }, activeKey: 'CURRENT' }).lean();
const defaultListSubmittedCases = () =>
  BgvCollectionCase.find({ status: 'SUBMITTED' }).sort({ submittedAt: 1 }).lean();
const defaultLoadVerification = ({ orderId, checkType }) =>
  BgvCheckVerification.findOne({ bgvOrder: orderId, checkType, activeKey: 'CURRENT' }).lean();
const defaultLoadVerificationsForOrders = ({ orderIds }) =>
  orderIds === null || orderIds === undefined
    ? BgvCheckVerification.find({ activeKey: 'CURRENT' }).lean()
    : BgvCheckVerification.find({ bgvOrder: { $in: orderIds }, activeKey: 'CURRENT' }).lean();
const defaultFetchFile = (args) => getStoredBgvEvidence(args);
const defaultLoadFileFull = ({ fileId }) =>
  isObjectId(fileId) ? BgvEvidenceFile.findOne({ _id: fileId }).select('+storageKey +checksumSha256').lean() : Promise.resolve(null);
const defaultAudit = (entry) => recordAudit(entry);

// ── readiness: backend is authoritative ───────────────────────────
const assertAssignable = async ({ orderId, checkType, verifierId, deps }) => {
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;
  const loadLatestToken = deps.loadLatestToken || defaultLoadLatestToken;
  const loadCase = deps.loadCase || defaultLoadCase;
  const loadVerifier = deps.loadVerifier || defaultLoadVerifier;

  const order = await loadOrderById({ orderId });
  if (!order || !isCommerciallyAuthorized(order)) {
    throw ApiError.conflict('Assignment requires a commercially authorized BGV order');
  }
  if (!FIVE_CHECKS.includes(String(checkType || '').toUpperCase())) {
    throw ApiError.badRequest('Unknown BGV check type');
  }
  // Purchased-check enforcement from the immutable order snapshot.
  if (!(order.items || []).some((item) => item.type === String(checkType).toUpperCase())) {
    throw ApiError.conflict('This check was not purchased for this BGV order');
  }
  const token = await loadLatestToken({ companyId: order.companyId, orderId: order._id });
  if (token?.finalDecision !== 'CONSENTED') {
    throw ApiError.conflict('Assignment requires explicit candidate consent');
  }
  const collectionCase = await loadCase({ companyId: order.companyId, orderId: order._id });
  if (!collectionCase || collectionCase.status !== 'SUBMITTED') {
    throw ApiError.conflict('Assignment requires the candidate to have submitted the BGV information');
  }

  const verifier = await loadVerifier({ verifierId });
  if (!verifier || verifier.status !== 'ACTIVE') {
    throw ApiError.conflict('The selected verifier is not active');
  }
  // Specialization is the eligibility filter — backend revalidated.
  if (!verifier.specializations?.includes(String(checkType).toUpperCase())) {
    throw ApiError.conflict('The selected verifier does not hold the required specialization');
  }
  return { order, collectionCase, verifier };
};

const auditSafe = (audit, entry) => audit(entry).catch(() => {});

// ── platform: assign / reassign / unassign ────────────────────────
export const assignCheck = async ({ actorId, orderId, checkType, verifierId, reason = '', requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const findAssignment = deps.findAssignment || defaultFindAssignment;
  const insertAssignment = deps.insertAssignment || defaultInsertAssignment;

  const safeCheck = String(checkType || '').toUpperCase();
  const { order, verifier } = await assertAssignable({ orderId, checkType: safeCheck, verifierId, deps });

  const existing = await findAssignment({ orderId: order._id, checkType: safeCheck });
  if (existing) {
    if (existing.verifier) {
      if (String(existing.verifier) === String(verifier._id)) {
        return { assignment: existing, idempotent: true }; // duplicate request
      }
      throw ApiError.conflict('This check already has a current assignment — use reassignment');
    }
    // Soft-unassigned placeholder row (verifier: null, activeKey CURRENT):
    // fill it instead of racing a second row against the unique index.
    const updateAssignment = deps.updateAssignment || defaultUpdateAssignment;
    const filled = await updateAssignment({
      assignmentId: existing._id,
      set: {
        verifier: verifier._id,
        status: 'ASSIGNED',
        assignedBy: actorId ?? null,
        assignedAt: new Date(),
        startedAt: null,
      },
      push: { action: 'ASSIGNED', verifierFrom: null, verifierTo: verifier._id, actor: actorId ?? null, reason: String(reason || '').slice(0, 300) },
    });
    if (!filled) throw ApiError.conflict('The assignment changed concurrently — retry');
    await auditSafe(audit, {
      req: requestContext,
      action: 'BGV_CHECK_ASSIGNED',
      actorId,
      resource: 'BgvCheckAssignment',
      resourceId: filled._id,
      metadata: { orderCode: order.orderCode, checkType: safeCheck, verifierId: String(verifier._id), refilled: true, phase: '30.7' },
    });
    return { assignment: filled, idempotent: false };
  }

  try {
    const assignment = await insertAssignment({
      companyId: order.companyId,
      bgvOrder: order._id,
      candidate: order.candidate,
      checkType: safeCheck,
      verifier: verifier._id,
      status: 'ASSIGNED',
      assignedBy: actorId ?? null,
      assignedAt: new Date(),
      history: [{ action: 'ASSIGNED', verifierFrom: null, verifierTo: verifier._id, actor: actorId ?? null, reason: String(reason || '').slice(0, 300) }],
    });
    await auditSafe(audit, {
      req: requestContext,
      action: 'BGV_CHECK_ASSIGNED',
      actorId,
      resource: 'BgvCheckAssignment',
      resourceId: assignment._id,
      metadata: { orderCode: order.orderCode, checkType: safeCheck, verifierId: String(verifier._id), phase: '30.7' },
    });
    return { assignment, idempotent: false };
  } catch (error) {
    if (error?.code === 11000) {
      const raced = await findAssignment({ orderId: order._id, checkType: safeCheck });
      if (raced && String(raced.verifier) === String(verifier._id)) return { assignment: raced, idempotent: true };
      throw ApiError.conflict('A concurrent assignment won this check — review the current assignment');
    }
    throw error;
  }
};

export const reassignCheck = async ({ actorId, orderId, checkType, newVerifierId, reason = '', requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const findAssignment = deps.findAssignment || defaultFindAssignment;
  const updateAssignment = deps.updateAssignment || defaultUpdateAssignment;

  const safeCheck = String(checkType || '').toUpperCase();
  if (!String(reason || '').trim()) throw ApiError.badRequest('A reason is required for reassignment');
  const { order, verifier } = await assertAssignable({ orderId, checkType: safeCheck, verifierId: newVerifierId, deps });

  const existing = await findAssignment({ orderId: order._id, checkType: safeCheck });
  if (!existing || !existing.verifier) throw ApiError.conflict('This check has no current assignment');
  if (String(existing.verifier) === String(verifier._id)) {
    return { assignment: existing, idempotent: true };
  }

  // Atomic conditional update + immutable history append — a concurrent
  // operator's change cannot be silently overwritten without a trace.
  const updated = await updateAssignment({
    assignmentId: existing._id,
    set: { verifier: verifier._id, status: 'ASSIGNED', startedAt: null },
    push: { action: 'REASSIGNED', verifierFrom: existing.verifier, verifierTo: verifier._id, actor: actorId ?? null, reason: String(reason).slice(0, 300) },
  });
  if (!updated) throw ApiError.conflict('The assignment changed concurrently — retry');

  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_CHECK_REASSIGNED',
    actorId,
    resource: 'BgvCheckAssignment',
    resourceId: updated._id,
    metadata: { orderCode: order.orderCode, checkType: safeCheck, from: String(existing.verifier), to: String(verifier._id), phase: '30.7' },
  });
  return { assignment: updated, idempotent: false };
};

export const unassignCheck = async ({ actorId, orderId, checkType, reason = '', requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const findAssignment = deps.findAssignment || defaultFindAssignment;
  const updateAssignment = deps.updateAssignment || defaultUpdateAssignment;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;

  const safeCheck = String(checkType || '').toUpperCase();
  const order = await loadOrderById({ orderId });
  if (!order) throw ApiError.notFound('BGV order not found');

  const existing = await findAssignment({ orderId: order._id, checkType: safeCheck });
  if (!existing || !existing.verifier) throw ApiError.conflict('This check has no current assignment');
  // Controlled unassignment only before work materially starts; once
  // IN_PROGRESS, reassignment is the safe path (30.8 tightens further).
  if (existing.status !== 'ASSIGNED') {
    throw ApiError.conflict('Work has started on this check — use reassignment instead');
  }

  const updated = await updateAssignment({
    assignmentId: existing._id,
    onlyStatus: 'ASSIGNED',
    set: { verifier: null, startedAt: null },
    push: { action: 'UNASSIGNED', verifierFrom: existing.verifier, verifierTo: null, actor: actorId ?? null, reason: String(reason || '').slice(0, 300) },
  });
  if (!updated) throw ApiError.conflict('The assignment changed concurrently — retry');

  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_CHECK_UNASSIGNED',
    actorId,
    resource: 'BgvCheckAssignment',
    resourceId: updated._id,
    metadata: { orderCode: order.orderCode, checkType: safeCheck, phase: '30.7' },
  });
  return { assignment: updated };
};

// ── platform: operational queue & eligibility ─────────────────────
export const listOperationsQueue = async ({ deps = {} }) => {
  const listSubmittedCases = deps.listSubmittedCases || defaultListSubmittedCases;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;
  const loadCompany = deps.loadCompany || defaultLoadCompany;
  const loadCandidate = deps.loadCandidate || defaultLoadCandidate;
  const listAssignments = deps.listAssignmentsForOrders || defaultListAssignmentsForOrders;
  const loadVerifier = deps.loadVerifier || defaultLoadVerifier;

  const cases = await listSubmittedCases();
  if (cases.length === 0) return { rows: [] };
  const loadVerifications = deps.loadVerificationsForOrders || defaultLoadVerificationsForOrders;
  const assignments = await listAssignments({ orderIds: cases.map((entry) => entry.bgvOrder) });
  const byOrderCheck = new Map(assignments.map((entry) => [`${entry.bgvOrder}:${entry.checkType}`, entry]));
  const verifications = await loadVerifications({ orderIds: cases.map((entry) => entry.bgvOrder) });
  const verificationByOrderCheck = new Map(verifications.map((entry) => [`${entry.bgvOrder}:${entry.checkType}`, entry]));

  const rows = [];
  for (const collectionCase of cases) {
    const order = await loadOrderById({ orderId: collectionCase.bgvOrder });
    if (!order || !isCommerciallyAuthorized(order)) continue;
    const [company, candidate] = await Promise.all([
      loadCompany({ companyId: order.companyId }),
      loadCandidate({ companyId: order.companyId, candidateId: order.candidate }),
    ]);
    for (const checkType of collectionCase.purchasedChecks || []) {
      const assignment = byOrderCheck.get(`${String(order._id)}:${checkType}`) || null;
      let verifierInfo = null;
      if (assignment?.verifier) {
        const verifier = await loadVerifier({ verifierId: assignment.verifier });
        verifierInfo = verifier
          ? { id: String(verifier._id), name: verifier.name, status: verifier.status }
          : null;
      }
      rows.push({
        orderId: String(order._id),
        orderCode: order.orderCode,
        companyName: company?.name || '',
        // Safe operational context only — never evidence or identifiers.
        candidateName: collectionCase.identity?.legalName || candidate?.name || 'Candidate',
        checkType,
        submittedAt: collectionCase.submittedAt,
        waitingDays: collectionCase.submittedAt
          ? Math.max(0, Math.floor((Date.now() - new Date(collectionCase.submittedAt).getTime()) / 86400000))
          : 0,
        assignment: assignment
          ? { status: assignment.status, assignedAt: assignment.assignedAt, startedAt: assignment.startedAt, verifier: verifierInfo }
          : null,
        // Phase 30.8 — operational workbench state (never a conclusion).
        verificationState: verificationByOrderCheck.get(`${String(order._id)}:${checkType}`)?.state || null,
      });
    }
  }
  return { rows };
};

export const eligibleVerifiersForCheck = async ({ checkType, deps = {} }) => {
  const listActiveVerifiers = deps.listActiveVerifiers || defaultListActiveVerifiers;
  const safeCheck = String(checkType || '').toUpperCase();
  const verifiers = await listActiveVerifiers();
  return verifiers
    .filter((verifier) => verifier.specializations?.includes(safeCheck))
    .map(sanitizeVerifier);
};

// ── verifier: work queue / detail / start / evidence ──────────────
const loadOwnAssignment = async ({ verifierId, orderId, checkType, deps }) => {
  const findAssignment = deps.findAssignment || defaultFindAssignment;
  const assignment = await findAssignment({ orderId, checkType: String(checkType || '').toUpperCase() });
  // Authorization = CURRENT assignment to THIS authenticated verifier.
  if (!assignment || !assignment.verifier || String(assignment.verifier) !== String(verifierId)) {
    throw ApiError.notFound('This check is not assigned to you');
  }
  return assignment;
};

// Shared with the 30.8 workbench service — the authorization chain must
// stay identical (current assignment = access; former verifiers denied).
export { loadOwnAssignment };

export const verifierWorkQueue = async ({ verifierId, deps = {} }) => {
  const loadVerifier = deps.loadVerifier || defaultLoadVerifier;
  const verifier = await loadVerifier({ verifierId });
  if (!verifier || verifier.status !== 'ACTIVE') {
    throw ApiError.forbidden('Verifier account is not active');
  }
  const listAssignments = deps.listAssignmentsForOrders || defaultListAssignmentsForOrders;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;
  const loadCompany = deps.loadCompany || defaultLoadCompany;
  const loadCase = deps.loadCase || defaultLoadCase;

  // All CURRENT assignments; filter to this verifier server-side (the
  // client never supplies a verifierId).
  const all = await listAssignments({ orderIds: null });
  const mine = (all || []).filter((entry) => String(entry.verifier) === String(verifierId));

  const rows = [];
  for (const assignment of mine) {
    const order = await loadOrderById({ orderId: assignment.bgvOrder });
    if (!order) continue;
    const loadVerification = deps.loadVerification || defaultLoadVerification;
    const [company, collectionCase, verification] = await Promise.all([
      loadCompany({ companyId: order.companyId }),
      loadCase({ companyId: order.companyId, orderId: order._id }),
      loadVerification({ orderId: order._id, checkType: assignment.checkType }),
    ]);
    rows.push({
      orderId: String(order._id),
      orderCode: order.orderCode,
      companyName: company?.name || '',
      candidateName: collectionCase?.identity?.legalName || 'Candidate',
      checkType: assignment.checkType,
      status: assignment.status,
      assignedAt: assignment.assignedAt,
      startedAt: assignment.startedAt,
      // Readiness context only — operational state + QA lifecycle, no
      // evidence, no identifiers beyond the declared legal name, no payment.
      submittedAt: collectionCase?.submittedAt || null,
      workState: verification?.state || 'ASSIGNED',
      qaStatus:
        verification?.qa?.status && verification.qa.status !== 'NONE'
          ? verification.qa.status
          : 'NONE',
    });
  }
  return { rows };
};

export const startCheckWork = async ({ verifierId, orderId, checkType, requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const updateAssignment = deps.updateAssignment || defaultUpdateAssignment;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;

  const assignment = await loadOwnAssignment({ verifierId, orderId, checkType, deps });
  if (assignment.status === 'IN_PROGRESS') {
    return { assignment, idempotent: true };
  }
  // Operational state only: ASSIGNED → IN_PROGRESS. No conclusion, no
  // contact, no pipeline change, no BGV CLEAR.
  const updated = await updateAssignment({
    assignmentId: assignment._id,
    onlyStatus: 'ASSIGNED',
    set: { status: 'IN_PROGRESS', startedAt: new Date() },
    push: { action: 'STARTED', verifierFrom: verifierId, verifierTo: verifierId, actor: null, reason: '' },
  });
  if (!updated) throw ApiError.conflict('The assignment changed concurrently — retry');

  const order = await loadOrderById({ orderId });
  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_CHECK_STARTED',
    resource: 'BgvCheckAssignment',
    resourceId: updated._id,
    metadata: { orderCode: order?.orderCode || '', checkType: updated.checkType, verifierId: String(verifierId), phase: '30.7' },
  });
  return { assignment: updated, idempotent: false };
};

// Minimum-necessary DTO per check — projected on the backend, never a
// giant candidate object hidden in React.
export const verifierCheckDetail = async ({ verifierId, orderId, checkType, deps = {} }) => {
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;
  const loadCompany = deps.loadCompany || defaultLoadCompany;
  const loadCase = deps.loadCase || defaultLoadCase;
  const listActiveFiles = deps.listActiveFiles || defaultListActiveFiles;

  const assignment = await loadOwnAssignment({ verifierId, orderId, checkType, deps });
  const order = await loadOrderById({ orderId });
  if (!order) throw ApiError.notFound('BGV order not found');
  const [company, collectionCase] = await Promise.all([
    loadCompany({ companyId: order.companyId }),
    loadCase({ companyId: order.companyId, orderId: order._id }),
  ]);
  if (!collectionCase) throw ApiError.notFound('Candidate submission not found');

  const activeFiles = await listActiveFiles({ companyId: order.companyId, caseId: collectionCase._id });
  // Phase 30.8 — workbench (activities/conclusion/registry mirror). The
  // detail stays a minimum-data DTO; the workbench view is derived from
  // the check's own verification record only.
  const loadVerification = deps.loadVerification || defaultLoadVerification;
  const verification = await loadVerification({ orderId: order._id, checkType: assignment.checkType });
  const workbench = buildWorkbenchView(verification, assignment.checkType);
  const filesFor = (type) =>
    activeFiles
      .filter((file) => file.checkType === type)
      .map((file) => ({
        id: String(file._id),
        category: file.category,
        recordId: file.recordId || null,
        fileName: file.originalFileName,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        version: file.version,
        scanStatus: file.scanStatus,
        uploadedAt: file.uploadedAt,
      }));

  const base = {
    orderId: String(order._id),
    orderCode: order.orderCode,
    companyName: company?.name || '',
    checkType: assignment.checkType,
    status: assignment.status,
    assignedAt: assignment.assignedAt,
    startedAt: assignment.startedAt,
    workbench,
    // NOTE: no payment, pricing, gateway, or full-identifier fields here.
  };

  if (assignment.checkType === 'IDENTITY') {
    return {
      ...base,
      identity: {
        legalName: collectionCase.identity?.legalName || '',
        dateOfBirth: collectionCase.identity?.dateOfBirth || null,
        documentType: collectionCase.identity?.documentType || null,
        identifierMasked: collectionCase.identity?.identifierMasked || '',
        // Provenance honesty: uploaded copies are candidate-provided
        // evidence; nothing here is e-KYC/DigiLocker-verified.
        provenance: 'candidate-provided',
      },
      files: filesFor('IDENTITY'), // includes selfie when collected
    };
  }
  if (assignment.checkType === 'ADDRESS') {
    return {
      ...base,
      candidateName: collectionCase.identity?.legalName || '',
      address: collectionCase.address || {},
      files: filesFor('ADDRESS'),
    };
  }
  if (assignment.checkType === 'EDUCATION') {
    return {
      ...base,
      candidateName: collectionCase.identity?.legalName || '',
      educations: (collectionCase.educations || []).map((record) => ({
        id: String(record._id),
        institution: record.institution,
        universityBoard: record.universityBoard || '',
        qualification: record.qualification,
        specialization: record.specialization || '',
        enrollmentNumber: record.enrollmentNumber || '',
        startYear: record.startYear || null,
        endYear: record.endYear || null,
        location: record.location || '',
      })),
      files: filesFor('EDUCATION'),
    };
  }
  if (assignment.checkType === 'EMPLOYMENT') {
    return {
      ...base,
      candidateName: collectionCase.identity?.legalName || '',
      employments: (collectionCase.employments || []).map((record) => ({
        id: String(record._id),
        employer: record.employer,
        designation: record.designation,
        employeeId: record.employeeId || '',
        startDate: record.startDate,
        endDate: record.endDate || null,
        employmentType: record.employmentType || 'PREVIOUS',
        hrContactName: record.hrContactName || '',
        hrContactEmail: record.hrContactEmail || '',
        hrContactPhone: record.hrContactPhone || '',
      })),
      files: filesFor('EMPLOYMENT'),
    };
  }
  if (assignment.checkType === 'REFERENCE') {
    return {
      ...base,
      candidateName: collectionCase.identity?.legalName || '',
      references: (collectionCase.references || []).map((record) => ({
        id: String(record._id),
        name: record.name,
        organization: record.organization || '',
        designation: record.designation || '',
        relationship: record.relationship,
        email: record.email || '',
        phone: record.phone || '',
        context: record.context || '',
      })),
      files: [],
    };
  }
  throw ApiError.notFound('Unknown check type');
};

export const downloadVerifierEvidence = async ({ verifierId, fileId, requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const loadFileFull = deps.loadFileFull || defaultLoadFileFull;
  const fetchFile = deps.fetchFile || defaultFetchFile;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;

  const file = await loadFileFull({ fileId });
  if (!file || file.status === 'REMOVED') throw ApiError.notFound('Evidence file not found');

  // The file's case/order must carry a CURRENT assignment to THIS verifier
  // for the file's own check type — guessing ids grants nothing.
  const assignment = await loadOwnAssignment({
    verifierId,
    orderId: file.bgvOrder,
    checkType: file.checkType,
    deps,
  });
  const order = await loadOrderById({ orderId: file.bgvOrder });
  if (!order || !isCommerciallyAuthorized(order)) throw ApiError.notFound('Evidence file not found');

  const buffer = await fetchFile({ storageProvider: file.storageProvider, storageKey: file.storageKey });

  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_EVIDENCE_READ_VERIFIER',
    resource: 'BgvEvidenceFile',
    resourceId: file._id,
    // Safe metadata only: category/version/check — no filename content,
    // no storage keys, no candidate identifiers.
    metadata: { category: file.category, checkType: file.checkType, verifierId: String(verifierId), phase: '30.7' },
  });

  return { fileName: file.originalFileName, mimeType: file.mimeType, checksum: file.checksumSha256, buffer };
};

// ── tenant HR: high-level progress only (no verifier PII) ─────────
export const getHrAssignmentStatus = async ({ companyId, candidateRef, deps = {} }) => {
  const loadCandidateByRef =
    deps.loadCandidateByRef ||
    (({ companyId: company, candidateRef: ref }) => {
      const filter = isObjectId(ref) ? { _id: ref, companyId: company } : { companyId: company, candidateCode: String(ref || '').trim().toUpperCase() };
      return Candidate.findOne(filter).lean();
    });
  const loadLatestOrder =
    deps.loadLatestOrder ||
    (({ companyId: company, candidateId }) => BgvOrder.findOne({ companyId: company, candidate: candidateId, openKey: 'OPEN' }).lean());
  const loadCase = deps.loadCase || defaultLoadCase;
  const listAssignments = deps.listAssignmentsForOrders || defaultListAssignmentsForOrders;

  const candidate = await loadCandidateByRef({ companyId, candidateRef });
  if (!candidate) throw ApiError.notFound('Candidate not found');
  const order = await loadLatestOrder({ companyId, candidateId: candidate._id });
  if (!order || !isCommerciallyAuthorized(order)) {
    return { perCheck: {} };
  }
  const collectionCase = await loadCase({ companyId, orderId: order._id });
  if (!collectionCase || collectionCase.status !== 'SUBMITTED') {
    return { perCheck: {} };
  }
  const loadVerifications = deps.loadVerificationsForOrders || defaultLoadVerificationsForOrders;
  const assignments = await listAssignments({ orderIds: [order._id] });
  const verifications = await loadVerifications({ orderIds: [order._id] });
  const perCheck = {};
  for (const checkType of collectionCase.purchasedChecks || []) {
    const assignment = assignments.find((entry) => entry.checkType === checkType);
    if (!assignment || !assignment.verifier) {
      perCheck[checkType] = 'UNASSIGNED';
      continue;
    }
    // Phase 30.8 — HR sees 'SUBMITTED' once verifier findings are locked;
    // still state-only, never findings/notes (30.10 owns report release).
    const verification = verifications.find((entry) => entry.checkType === checkType);
    // Phase 30.9: an open additional-information request surfaces as
    // AWAITING_CANDIDATE ("waiting for candidate") — state only.
    perCheck[checkType] =
      verification?.state === 'SUBMITTED'
        ? 'SUBMITTED'
        : verification?.state === 'AWAITING_CANDIDATE'
          ? 'AWAITING_CANDIDATE'
          : assignment.status;
  }
  return { perCheck };
};
