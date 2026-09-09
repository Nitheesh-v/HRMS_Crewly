import crypto from 'node:crypto';
import BgvOrder from '../../models/BgvOrder.js';
import Company from '../../models/Company.js';
import Candidate from '../../models/Candidate.js';
import BgvCollectionCase from '../../models/BgvCollectionCase.js';
import BgvCheckVerification from '../../models/BgvCheckVerification.js';
import BgvInfoRequest from '../../models/BgvInfoRequest.js';
import BgvFinalReport from '../../models/BgvFinalReport.js';
import BgvVerifierEvidenceFile from '../../models/BgvVerifierEvidenceFile.js';
import BgvVerifier from '../../models/BgvVerifier.js';
import ApiError from '../../utils/ApiError.js';
import { recordAudit } from '../../utils/securityauditService.js';
import { nextBgvReportCode } from '../../utils/bgvIdentifiers.js';
import { storeBgvEvidence, getStoredBgvEvidence } from './bgvEvidenceStorageService.js';
import { buildBgvReportPdf } from '../../utils/bgvReportPdf.js';
import { isCommerciallyAuthorized } from './bgvOrderRules.js';
import {
  computeOverallOutcome,
  evaluateReportReadiness,
  isQaApproved,
  isQaReviewable,
  methodLabel,
  digilockerReportWording,
  REPORT_DISCLAIMER,
  sanitizeQaReturnReason,
} from './bgvQaReportRules.js';

// Phase 30.10 — internal QA review + final report release.
//
// Authorization notes (enforced here AND by route middleware):
//  - every function below takes an explicit actorId that the controller
//    derives from the platform session (req.user._id). Client-supplied
//    actor/verifier/company ids are never trusted.
//  - verifiers (30.6 principals) and tenant HR can NEVER reach these paths:
//    they live behind requireSuperAdmin + permit('bgv:qa') on a separate
//    session middleware stack.
//  - separation of duties: the QA actor is a platform User; a verifier is a
//    BgvVerifier — different principal types, so a verifier cannot QA-approve
//    their own finding.

const defaultAudit = (entry) => recordAudit(entry);
const auditSafe = (audit, entry) => audit(entry).catch(() => {});

const defaultLoadOrderById = ({ orderId }) => BgvOrder.findById(orderId).lean();
const defaultLoadCase = ({ companyId, orderId }) =>
  BgvCollectionCase.findOne({ companyId, bgvOrder: orderId }).lean();
const defaultLoadCompany = ({ companyId }) => Company.findById(companyId).select('name').lean();
const defaultLoadCandidate = ({ companyId, candidateId }) =>
  Candidate.findOne({ _id: candidateId, companyId }).select('name email').lean();
const defaultListVerifications = ({ orderId }) =>
  BgvCheckVerification.find({ bgvOrder: orderId, activeKey: 'CURRENT' }).lean();
const defaultFindVerification = ({ orderId, checkType }) =>
  BgvCheckVerification.findOne({ bgvOrder: orderId, checkType, activeKey: 'CURRENT' }).lean();
const defaultCountOpenInfoRequests = ({ orderId }) =>
  BgvInfoRequest.countDocuments({ bgvOrder: orderId, status: 'OPEN' });
const defaultFindReport = ({ orderId }) =>
  BgvFinalReport.findOne({ bgvOrder: orderId }).sort({ version: -1 }).lean();
const defaultInsertReport = (doc) => BgvFinalReport.create(doc);
const defaultUpdateReport = ({ reportId, filter = {}, set, push }) =>
  BgvFinalReport.findOneAndUpdate(
    { _id: reportId, ...filter },
    { $set: set, ...(push ? { $push: { history: push } } : {}) },
    { returnDocument: 'after' }
  ).lean();
// Atomic QA decision writes: only while the latest submission is still PENDING.
const defaultApproveUpdate = ({ verificationId, revision, actorId, now }) =>
  BgvCheckVerification.findOneAndUpdate(
    { _id: verificationId, activeKey: 'CURRENT', state: 'SUBMITTED', 'qa.status': 'PENDING', 'qa.currentRevision': revision },
    {
      $set: {
        'qa.status': 'APPROVED',
        'qa.reviewedBy': actorId,
        'qa.reviewedAt': now,
        'submissions.$[s].qa.status': 'APPROVED',
        'submissions.$[s].qa.reviewedBy': actorId,
        'submissions.$[s].qa.reviewedAt': now,
      },
    },
    { arrayFilters: [{ 's.revision': revision }], returnDocument: 'after' }
  ).lean();
const defaultReturnUpdate = ({ verificationId, revision, actorId, now, reason }) =>
  BgvCheckVerification.findOneAndUpdate(
    { _id: verificationId, activeKey: 'CURRENT', state: 'SUBMITTED', 'qa.status': 'PENDING', 'qa.currentRevision': revision },
    {
      $set: {
        state: 'QA_RETURNED',
        'qa.status': 'RETURNED',
        'qa.reviewedBy': actorId,
        'qa.reviewedAt': now,
        'qa.returnReason': reason,
        'submissions.$[s].qa.status': 'RETURNED',
        'submissions.$[s].qa.reviewedBy': actorId,
        'submissions.$[s].qa.reviewedAt': now,
        'submissions.$[s].qa.returnReason': reason,
      },
    },
    { arrayFilters: [{ 's.revision': revision }], returnDocument: 'after' }
  ).lean();
const defaultStoreFile = (args) => storeBgvEvidence(args);
const defaultFetchFile = (args) => getStoredBgvEvidence(args);
const defaultLoadEvidenceFiles = ({ ids }) =>
  ids.length ? BgvVerifierEvidenceFile.find({ _id: { $in: ids } }).lean() : Promise.resolve([]);
const defaultNextReportCode = (companyId) => nextBgvReportCode(companyId);

// Phase 30.12 fix: the authoritative QA state is NESTED (qa.status /
// qa.returnReason). The top-level qaStatus/qaReturnReason paths never
// existed on the BgvCheckVerification schema — strict-mode writes dropped
// them and reads saw undefined, so the QA queue stayed empty and the
// approve/return conditional updates never matched. Views read the nested
// fields; a top-level fallback keeps older injected fixtures working.
const qaStatusOf = (verification) => {
  const nested = verification?.qa?.status;
  if (nested && nested !== 'NONE') return nested;
  if (verification?.qaStatus && verification.qaStatus !== 'NONE') return verification.qaStatus;
  return nested || 'NONE';
};
const qaReturnReasonOf = (verification) =>
  verification?.qa?.returnReason || verification?.qaReturnReason || '';

const safeCheckView = (verification) => ({
  checkType: verification.checkType,
  state: verification.state,
  qaStatus: qaStatusOf(verification),
  qaReturnReason: qaReturnReasonOf(verification),
  revision: verification.qa?.currentRevision || (verification.submissions || []).length,
  conclusion: verification.conclusion?.value || null,
  submittedAt: verification.conclusion?.submittedAt || null,
  discrepancyCount: (verification.discrepancies || []).length,
});

// ── QA queue ──────────────────────────────────────────────────────
// Only verifier-submitted work appears. Collection/consent/unpaid/unassigned/
// unfinished work is structurally absent (no verification row or not submitted).
export const qaQueue = async ({ filters = {}, deps = {} }) => {
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;
  const loadCompany = deps.loadCompany || defaultLoadCompany;
  const loadCandidate = deps.loadCandidate || defaultLoadCandidate;
  const loadCase = deps.loadCase || defaultLoadCase;
  const listVerifications = deps.listVerifications || defaultListVerifications;
  const countOpenInfoRequests = deps.countOpenInfoRequests || defaultCountOpenInfoRequests;

  const cases = await (deps.listSubmittedCases ||
    (() => BgvCollectionCase.find({ status: 'SUBMITTED' }).sort({ submittedAt: 1 }).lean()))();
  const rows = [];
  for (const collectionCase of cases) {
    const order = await loadOrderById({ orderId: collectionCase.bgvOrder });
    if (!order || !isCommerciallyAuthorized(order)) continue; // unpaid never enters QA
    const verifications = await listVerifications({ orderId: order._id });
    if (!verifications.length) continue; // unassigned / unfinished work stays out
    const [company, candidate] = await Promise.all([
      loadCompany({ companyId: order.companyId }),
      loadCandidate({ companyId: order.companyId, candidateId: order.candidate }),
    ]);
    const openRequests = await countOpenInfoRequests({ orderId: order._id });
    for (const verification of verifications) {
      const view = safeCheckView(verification);
      // Queue shows submitted (or returned/approved) work only.
      if (view.state !== 'SUBMITTED' && view.state !== 'QA_RETURNED') continue;
      if (filters.status === 'awaiting' && !isQaReviewable(view)) continue;
      if (filters.status === 'returned' && view.qaStatus !== 'RETURNED') continue;
      if (filters.status === 'approved' && !isQaApproved(view)) continue;
      if (filters.checkType && view.checkType !== String(filters.checkType).toUpperCase()) continue;
      if (filters.conclusion && view.conclusion !== String(filters.conclusion).toUpperCase()) continue;
      if (filters.orderCode && !String(order.orderCode || '').includes(String(filters.orderCode))) continue;
      rows.push({
        orderId: String(order._id),
        orderCode: order.orderCode,
        tenantName: company?.name || '',
        candidateName: collectionCase.identity?.legalName || candidate?.name || 'Candidate',
        hasOpenInfoRequests: openRequests > 0,
        ...view,
      });
    }
  }
  return { rows };
};

// ── QA detail (sensitive internal view) ───────────────────────────
export const qaDetail = async ({ orderId, checkType, deps = {} }) => {
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;
  const loadCompany = deps.loadCompany || defaultLoadCompany;
  const loadCase = deps.loadCase || defaultLoadCase;
  const findVerification = deps.findVerification || defaultFindVerification;
  const loadEvidenceFiles = deps.loadEvidenceFiles || defaultLoadEvidenceFiles;
  const listInfoRequests = deps.listInfoRequests ||
    ((args) => BgvInfoRequest.find({ bgvOrder: args.orderId }).sort({ requestedAt: 1 }).lean());

  const order = await loadOrderById({ orderId });
  if (!order || !isCommerciallyAuthorized(order)) throw ApiError.notFound('BGV order not found');
  const safeCheck = String(checkType || '').toUpperCase();
  const verification = await findVerification({ orderId: order._id, checkType: safeCheck });
  if (!verification) throw ApiError.notFound('No verification exists for this check');

  const [company, collectionCase, infoRequests] = await Promise.all([
    loadCompany({ companyId: order.companyId }),
    loadCase({ companyId: order.companyId, orderId: order._id }),
    listInfoRequests({ orderId: order._id }),
  ]);

  const evidenceIds = (verification.activities || [])
    .map((activity) => activity.evidenceFile)
    .filter(Boolean)
    .map((id) => String(id));
  const evidenceFiles = await loadEvidenceFiles({ ids: evidenceIds });

  // Private evidence stays behind controlled download (separate audited
  // route); the detail view carries metadata only — no storage keys, no URLs.
  return {
    order: { orderId: String(order._id), orderCode: order.orderCode },
    tenantName: company?.name || '',
    candidateName: collectionCase?.identity?.legalName || 'Candidate',
    identity: (collectionCase?.identity
      ? [{ documentType: collectionCase.identity.documentType || '', identifierMasked: collectionCase.identity.identifierMasked || '' }]
      : []),
    purchasedChecks: collectionCase?.purchasedChecks || order.items.map((item) => item.type),
    check: {
      ...safeCheckView(verification),
      activities: (verification.activities || []).map((activity) => ({
        seq: activity.seq,
        method: activity.method,
        outcome: activity.outcome,
        at: activity.at,
        hasEvidence: Boolean(activity.evidenceFile),
      })),
      discrepancies: (verification.discrepancies || []).map((entry) => ({
        field: entry.field,
        severity: entry.severity,
        explanation: entry.explanation,
        at: entry.at,
      })),
      submissions: (verification.submissions || []).map((entry) => ({
        revision: entry.revision,
        conclusion: entry.conclusion?.value || null,
        reason: entry.conclusion?.reason || '',
        submittedAt: entry.submittedAt || entry.conclusion?.submittedAt || null,
        qaStatus: entry.qa?.status || 'PENDING',
        qaReturnReason: entry.qa?.returnReason || '',
        reviewedAt: entry.qa?.reviewedAt || null,
      })),
    },
    evidence: evidenceFiles.map((file) => ({
      id: String(file._id),
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes ?? file.size ?? 0,
      createdAt: file.createdAt,
    })),
    infoRequests: infoRequests.map((request) => ({
      id: String(request._id),
      category: request.category,
      status: request.status,
      requestedAt: request.requestedAt,
      respondedAt: request.respondedAt || null,
    })),
  };
};

// ── QA decisions ──────────────────────────────────────────────────
export const qaApprove = async ({ actorId, orderId, checkType, requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const findVerification = deps.findVerification || defaultFindVerification;
  const approve = deps.approveUpdate || defaultApproveUpdate;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;

  const order = await loadOrderById({ orderId });
  if (!order) throw ApiError.notFound('BGV order not found');
  const safeCheck = String(checkType || '').toUpperCase();
  const verification = await findVerification({ orderId: order._id, checkType: safeCheck });
  if (!verification) throw ApiError.notFound('No verification exists for this check');

  if (isQaApproved(verification)) {
    return { verification: safeCheckView(verification), idempotent: true };
  }
  if (verification.state !== 'SUBMITTED') {
    throw ApiError.conflict('QA can only approve submitted findings');
  }
  if (qaStatusOf(verification) !== 'PENDING' && qaStatusOf(verification) !== 'NONE') {
    throw ApiError.conflict('This submission was already reviewed — a resubmission is required');
  }

  const revision = verification.qa?.currentRevision || (verification.submissions || []).length;
  const updated = await approve({ verificationId: verification._id, revision, actorId, now: new Date() });
  if (!updated) throw ApiError.conflict('The check changed concurrently — reload and review again');

  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_QA_APPROVED',
    actorId,
    resource: 'BgvCheckVerification',
    resourceId: updated._id,
    metadata: { orderCode: order.orderCode, checkType: safeCheck, revision, phase: '30.10' },
  });
  return { verification: safeCheckView(updated), idempotent: false };
};

export const qaReturn = async ({ actorId, orderId, checkType, reason, requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const findVerification = deps.findVerification || defaultFindVerification;
  const sendBack = deps.returnUpdate || defaultReturnUpdate;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;

  const cleaned = sanitizeQaReturnReason(reason);
  if (!cleaned.ok) throw ApiError.badRequest(cleaned.error);

  const order = await loadOrderById({ orderId });
  if (!order) throw ApiError.notFound('BGV order not found');
  const safeCheck = String(checkType || '').toUpperCase();
  const verification = await findVerification({ orderId: order._id, checkType: safeCheck });
  if (!verification) throw ApiError.notFound('No verification exists for this check');
  if (verification.state !== 'SUBMITTED' || qaStatusOf(verification) === 'APPROVED') {
    throw ApiError.conflict('Only a PENDING submitted finding can be returned for correction');
  }
  if (qaStatusOf(verification) === 'RETURNED') {
    return { verification: safeCheckView(verification), idempotent: true };
  }

  const revision = verification.qa?.currentRevision || (verification.submissions || []).length;
  const updated = await sendBack({
    verificationId: verification._id,
    revision,
    actorId,
    now: new Date(),
    reason: cleaned.value,
  });
  if (!updated) throw ApiError.conflict('The check changed concurrently — reload and review again');

  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_QA_RETURNED',
    actorId,
    resource: 'BgvCheckVerification',
    resourceId: updated._id,
    metadata: { orderCode: order.orderCode, checkType: safeCheck, revision, phase: '30.10' }, // reason is audited on the doc, not here
  });
  return { verification: safeCheckView(updated), idempotent: false };
};

// ── QA-controlled private evidence read (audited) ─────────────────
export const qaEvidenceDownload = async ({ actorId, orderId, checkType, fileId, requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const findVerification = deps.findVerification || defaultFindVerification;
  const fetchFile = deps.fetchFile || defaultFetchFile;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;

  const order = await loadOrderById({ orderId });
  if (!order) throw ApiError.notFound('BGV order not found');
  const verification = await findVerification({ orderId: order._id, checkType: String(checkType).toUpperCase() });
  if (!verification) throw ApiError.notFound('No verification exists for this check');
  const owns = (verification.activities || []).some((activity) => String(activity.evidenceFile) === String(fileId));
  if (!owns) throw ApiError.notFound('Evidence does not belong to this check');

  const file = await fetchFile({ fileId });
  if (!file) throw ApiError.notFound('Evidence file not found');
  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_QA_EVIDENCE_READ',
    actorId,
    resource: 'BgvVerifierEvidenceFile',
    resourceId: file._id,
    metadata: { orderCode: order.orderCode, checkType: verification.checkType, phase: '30.10' },
  });
  return { file, buffer: file.buffer };
};

// ── report readiness + generation + release ───────────────────────
const buildReadiness = async ({ order, deps }) => {
  const listVerifications = deps.listVerifications || defaultListVerifications;
  const countOpenInfoRequests = deps.countOpenInfoRequests || defaultCountOpenInfoRequests;
  const loadCase = deps.loadCase || defaultLoadCase;
  const collectionCase = await loadCase({ companyId: order.companyId, orderId: order._id });
  const purchasedChecks = collectionCase?.purchasedChecks || (order.items || []).map((item) => item.type);
  const verifications = await listVerifications({ orderId: order._id });
  const openInfoRequests = await countOpenInfoRequests({ orderId: order._id });
  return evaluateReportReadiness({
    purchasedChecks,
    checks: verifications.map((verification) => safeCheckView(verification)),
    openInfoRequests,
  });
};

export const reportReadiness = async ({ orderId, deps = {} }) => {
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;
  const findReport = deps.findReport || defaultFindReport;
  const order = await loadOrderById({ orderId });
  if (!order || !isCommerciallyAuthorized(order)) throw ApiError.notFound('BGV order not found');
  const readiness = await buildReadiness({ order, deps });
  const report = await findReport({ orderId: order._id });
  return {
    ready: readiness.ready,
    missing: readiness.missing,
    report: report
      ? {
          id: String(report._id),
          reportNumber: report.reportNumber,
          version: report.version,
          status: report.status,
          pdfStatus: report.pdf?.status || 'NONE',
          overallOutcome: report.snapshot?.overallOutcome || null,
          releasedAt: report.release?.releasedAt || null,
        }
      : null,
  };
};

const renderAndStorePdf = async ({ report, order, deps }) => {
  const storeFile = deps.storeFile || defaultStoreFile;
  const updateReport = deps.updateReport || defaultUpdateReport;
  const audit = deps.audit || defaultAudit;
  const snapshot = { ...report.snapshot, reportNumber: report.reportNumber, version: report.version };
  try {
    const buffer = await buildBgvReportPdf(snapshot);
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const stored = await storeFile({ buffer, companyId: order.companyId, caseId: String(report._id) });
    const fileName = `${String(report.reportNumber).replace(/[^A-Za-z0-9-]+/g, '-')}-v${report.version}.pdf`;
    const updated = await updateReport({
      reportId: report._id,
      set: {
        'pdf.status': 'GENERATED',
        'pdf.storageProvider': stored.storageProvider,
        'pdf.storageKey': stored.storageKey,
        'pdf.fileName': fileName,
        'pdf.checksumSha256': checksum,
        'pdf.sizeBytes': buffer.length,
        'pdf.generatedAt': new Date(),
      },
      push: { action: 'BGV_REPORT_PDF_GENERATED', actor: null, metadata: { sizeBytes: buffer.length } },
    });
    return { report: updated, pdfFailed: false };
  } catch (error) {
    // PDF/storage failure NEVER falsely releases and never touches findings.
    const updated = await updateReport({
      reportId: report._id,
      set: { 'pdf.status': 'FAILED' },
      push: { action: 'BGV_REPORT_PDF_FAILED', actor: null, metadata: {} },
    });
    await auditSafe(audit, {
      action: 'BGV_REPORT_PDF_FAILED',
      resource: 'BgvFinalReport',
      resourceId: report._id,
      metadata: { orderCode: order.orderCode, phase: '30.10' },
    });
    return { report: updated, pdfFailed: true };
  }
};

export const generateReport = async ({ actorId, orderId, requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;
  const loadCompany = deps.loadCompany || defaultLoadCompany;
  const loadCase = deps.loadCase || defaultLoadCase;
  const listVerifications = deps.listVerifications || defaultListVerifications;
  const findReport = deps.findReport || defaultFindReport;
  const insertReport = deps.insertReport || defaultInsertReport;
  const nextReportCode = deps.nextReportCode || defaultNextReportCode;

  const order = await loadOrderById({ orderId });
  if (!order || !isCommerciallyAuthorized(order)) throw ApiError.notFound('BGV order not found');

  const readiness = await buildReadiness({ order, deps });
  if (!readiness.ready) {
    throw ApiError.conflict(`Final report is not ready: ${readiness.missing.join('; ')}`);
  }

  const existing = await findReport({ orderId: order._id });
  if (existing) {
    return { report: reportSummary(existing), idempotent: true };
  }

  // Snapshot ONLY approved revisions — frozen at generation time.
  const [company, collectionCase, verifications] = await Promise.all([
    loadCompany({ companyId: order.companyId }),
    loadCase({ companyId: order.companyId, orderId: order._id }),
    listVerifications({ orderId: order._id }),
  ]);
  const purchasedChecks = collectionCase?.purchasedChecks || (order.items || []).map((item) => item.type);
  const checks = [];
  const conclusions = [];
  for (const checkType of purchasedChecks) {
    const verification = verifications.find((entry) => entry.checkType === checkType);
    const approved = (verification?.submissions || []).filter((entry) => entry.qa?.status === 'APPROVED').pop();
    if (!verification || !approved) {
      throw ApiError.conflict(`Final report is not ready: ${checkType}: awaiting QA approval`);
    }
    const methods = [...new Set((verification.activities || []).map((activity) => activity.method))];
    const wording = digilockerReportWording(methods);
    checks.push({
      checkType,
      conclusion: approved.conclusion?.value,
      revision: approved.revision,
      methods: wording ? [...methods.filter((method) => method !== 'DIGILOCKER_ISSUER_ASSISTED'), wording] : methods.map((method) => methodLabel(method)),
      discrepancies: (verification.discrepancies || []).map((entry) => ({
        field: entry.field,
        severity: entry.severity,
        explanation: entry.explanation,
      })),
      completionNote: approved.conclusion?.reason || '',
      completedAt: approved.conclusion?.submittedAt || approved.submittedAt || null,
    });
    conclusions.push(approved.conclusion?.value);
  }

  const overallOutcome = computeOverallOutcome(conclusions);
  if (!overallOutcome) throw ApiError.conflict('Final report is not ready: no approved findings');

  const reportNumber = await nextReportCode(order.companyId);
  const report = await insertReport({
    companyId: order.companyId,
    bgvOrder: order._id,
    candidate: order.candidate,
    orderCode: order.orderCode,
    reportNumber,
    version: 1,
    status: 'GENERATED',
    snapshot: {
      generatedAt: new Date(),
      tenantName: company?.name || '',
      candidateName: collectionCase?.identity?.legalName || 'Candidate',
      identity: collectionCase?.identity
        ? [{ documentType: collectionCase.identity.documentType || '', identifierMasked: collectionCase.identity.identifierMasked || '' }]
        : [],
      checks,
      overallOutcome,
      disclaimer: REPORT_DISCLAIMER,
    },
    history: [{ action: 'BGV_REPORT_GENERATED', actor: actorId ?? null, metadata: { version: 1 } }],
  });

  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_REPORT_GENERATED',
    actorId,
    resource: 'BgvFinalReport',
    resourceId: report._id,
    metadata: { orderCode: order.orderCode, reportNumber, outcome: overallOutcome, phase: '30.10' },
  });

  const rendered = await renderAndStorePdf({ report: { ...report.toObject?.() || report }, order, deps });
  return { report: reportSummary(rendered.report), idempotent: false, pdfFailed: rendered.pdfFailed };
};

export const retryReportPdf = async ({ actorId, orderId, requestContext = null, deps = {} }) => {
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;
  const findReport = deps.findReport || defaultFindReport;
  const order = await loadOrderById({ orderId });
  if (!order) throw ApiError.notFound('BGV order not found');
  const report = await findReport({ orderId: order._id });
  if (!report) throw ApiError.notFound('No report exists for this order');
  if (report.pdf?.status === 'GENERATED') {
    return { report: reportSummary(report), pdfFailed: false, idempotent: true };
  }
  // Deterministic re-render from the STORED snapshot — findings untouched.
  const rendered = await renderAndStorePdf({ report, order, deps });
  return { report: reportSummary(rendered.report), pdfFailed: rendered.pdfFailed, idempotent: false };
};

export const releaseReport = async ({ actorId, orderId, requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const loadOrderById = deps.loadOrderById || defaultLoadOrderById;
  const findReport = deps.findReport || defaultFindReport;
  const updateReport = deps.updateReport || defaultUpdateReport;

  const order = await loadOrderById({ orderId });
  if (!order || !isCommerciallyAuthorized(order)) throw ApiError.notFound('BGV order not found');

  // Backend re-enforces readiness even if a client fakes the frontend state.
  const readiness = await buildReadiness({ order, deps });
  if (!readiness.ready) {
    throw ApiError.conflict(`Final report cannot be released: ${readiness.missing.join('; ')}`);
  }

  const report = await findReport({ orderId: order._id });
  if (!report) throw ApiError.conflict('Generate the report before releasing it');
  if (report.status === 'RELEASED') {
    return { report: reportSummary(report), idempotent: true };
  }
  if (report.pdf?.status !== 'GENERATED') {
    throw ApiError.conflict('The report PDF is not ready — retry generation first');
  }

  const released = await updateReport({
    reportId: report._id,
    filter: { status: 'GENERATED' },
    set: { status: 'RELEASED', 'release.releasedBy': actorId ?? null, 'release.releasedAt': new Date() },
    push: { action: 'BGV_REPORT_RELEASED', actor: actorId ?? null, metadata: {} },
  });
  if (!released) throw ApiError.conflict('The report changed concurrently — reload');

  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_REPORT_RELEASED',
    actorId,
    resource: 'BgvFinalReport',
    resourceId: released._id,
    metadata: { orderCode: order.orderCode, reportNumber: released.reportNumber, phase: '30.10' },
  });
  return { report: reportSummary(released), idempotent: false };
};

const reportSummary = (report) => ({
  id: String(report._id),
  reportNumber: report.reportNumber,
  version: report.version,
  status: report.status,
  pdfStatus: report.pdf?.status || 'NONE',
  fileName: report.pdf?.fileName || '',
  checksum: report.pdf?.checksumSha256 || '',
  overallOutcome: report.snapshot?.overallOutcome || null,
  checks: (report.snapshot?.checks || []).map((check) => ({
    checkType: check.checkType,
    conclusion: check.conclusion,
    revision: check.revision,
  })),
  releasedAt: report.release?.releasedAt || null,
});

// ── platform report view / download ───────────────────────────────
export const platformReportView = async ({ orderId, deps = {} }) => {
  const findReport = deps.findReport || defaultFindReport;
  const report = await findReport({ orderId });
  if (!report) throw ApiError.notFound('No report exists for this order');
  return { report: { ...reportSummary(report), snapshot: safeSnapshot(report.snapshot) } };
};

const safeSnapshot = (snapshot = {}) => ({
  generatedAt: snapshot.generatedAt,
  tenantName: snapshot.tenantName,
  candidateName: snapshot.candidateName,
  identity: snapshot.identity || [],
  overallOutcome: snapshot.overallOutcome,
  disclaimer: snapshot.disclaimer,
  checks: (snapshot.checks || []).map((check) => ({
    checkType: check.checkType,
    conclusion: check.conclusion,
    revision: check.revision,
    methods: check.methods || [],
    discrepancies: check.discrepancies || [],
    completedAt: check.completedAt,
  })),
});

export const platformReportDownload = async ({ actorId, orderId, requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const findReport = deps.findReport || defaultFindReport;
  const fetchFile = deps.fetchFile || defaultFetchFile;
  const report = await findReport({ orderId });
  if (!report) throw ApiError.notFound('No report exists for this order');
  if (report.pdf?.status !== 'GENERATED' || !report.pdf?.storageKey) {
    throw ApiError.conflict('The report PDF is not available');
  }
  const stored = await fetchFile({ storageProvider: report.pdf.storageProvider, storageKey: report.pdf.storageKey });
  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_REPORT_DOWNLOADED_INTERNAL',
    actorId,
    resource: 'BgvFinalReport',
    resourceId: report._id,
    metadata: { reportNumber: report.reportNumber, phase: '30.10' },
  });
  return { buffer: stored.buffer, fileName: report.pdf.fileName || 'bgv-report.pdf', checksum: report.pdf.checksumSha256 };
};

// ── tenant HR access (req.companyId is the ONLY authority) ────────
const loadTenantReport = async ({ companyId, candidateId, deps }) => {
  const findReportForTenant = deps.findReportForTenant ||
    ((args) => BgvFinalReport.findOne({ companyId: args.companyId, candidate: args.candidateId }).sort({ version: -1 }).lean());
  const report = await findReportForTenant({ companyId, candidateId });
  if (!report) return null;
  return report;
};

export const tenantReportSummary = async ({ companyId, candidateId, deps = {} }) => {
  const report = await loadTenantReport({ companyId, candidateId, deps });
  // Unreleased reports are invisible to tenant HR — generated ≠ released.
  if (!report || report.status !== 'RELEASED') return { report: null };
  return {
    report: {
      reportNumber: report.reportNumber,
      version: report.version,
      overallOutcome: report.snapshot?.overallOutcome || null,
      releasedAt: report.release?.releasedAt || null,
      checks: (report.snapshot?.checks || []).map((check) => ({
        checkType: check.checkType,
        conclusion: check.conclusion,
        methods: check.methods || [],
        discrepancies: check.discrepancies || [],
        completionNote: check.completionNote || '',
      })),
      disclaimer: report.snapshot?.disclaimer || '',
      candidateName: report.snapshot?.candidateName || '',
      tenantName: report.snapshot?.tenantName || '',
      identity: report.snapshot?.identity || [],
    },
  };
};

export const tenantReportDownload = async ({ companyId, candidateId, requestContext = null, deps = {} }) => {
  const audit = deps.audit || defaultAudit;
  const fetchFile = deps.fetchFile || defaultFetchFile;
  const report = await loadTenantReport({ companyId, candidateId, deps });
  if (!report || report.status !== 'RELEASED') {
    throw ApiError.notFound('No released BGV report is available for this candidate');
  }
  if (report.pdf?.status !== 'GENERATED' || !report.pdf?.storageKey) {
    throw ApiError.conflict('The report PDF is not available');
  }
  const stored = await fetchFile({ storageProvider: report.pdf.storageProvider, storageKey: report.pdf.storageKey });
  await auditSafe(audit, {
    req: requestContext,
    action: 'BGV_FINAL_REPORT_DOWNLOADED',
    companyId,
    resource: 'BgvFinalReport',
    resourceId: report._id,
    metadata: { reportNumber: report.reportNumber, phase: '30.10' },
  });
  return { buffer: stored.buffer, fileName: report.pdf.fileName || 'bgv-report.pdf', checksum: report.pdf.checksumSha256 };
};
