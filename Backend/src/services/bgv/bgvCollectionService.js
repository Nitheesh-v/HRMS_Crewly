// Phase 30.5 — CANDIDATE BGV INFORMATION & DOCUMENT COLLECTION service.
//
// Security boundaries (read before changing):
//  - CONSENT GATE: every candidate action requires the SAME purpose-scoped
//    30.4 portal token with finalDecision === 'CONSENTED'. Opening the
//    portal or paying is NOT sufficient — consent is mandatory and the
//    backend enforces it independently of the frontend.
//  - COMMERCIAL READINESS: authorization flows through the single 30.3/30.4
//    boundary helper isCommerciallyAuthorized(order). No Razorpay/payment
//    provider field is consulted here, so future billing modes (credits,
//    invoice, subscription, postpaid) reach the same boundary unchanged.
//  - PURCHASED CHECKS ONLY: forms/uploads/submission are restricted to the
//    immutable order snapshot checks; unpurchased checks are rejected by
//    the backend, not just hidden in the UI.
//  - PRIVATE STORAGE: evidence bytes live in private storage (no public
//    URL); downloads re-resolve the token → case → file relationship
//    server-side (never from user-supplied ids alone).
//  - MASKING: full identity numbers are NEVER persisted/logged/audited —
//    masked display + select:false fingerprint only.
//  - SUBMISSION LOCK: after explicit POST submit, ordinary edits and
//    replacements are blocked (30.9 will add controlled re-open).
//  - No queue payloads here; no verifier, no BGV case mutation, no
//    pipeline change, no BGV CLEAR — collection only.
//
// All Mongo/storage/audit collaborators are injectable (deps) for hermetic
// tests; defaults are the real implementations.

import mongoose from 'mongoose';
import BgvOrder from '../../models/BgvOrder.js';
import Candidate from '../../models/Candidate.js';
import Company from '../../models/Company.js';
import BgvConsentAccessToken from '../../models/BgvConsentAccessToken.js';
import BgvCollectionCase from '../../models/BgvCollectionCase.js';
import BgvEvidenceFile from '../../models/BgvEvidenceFile.js';
import ApiError from '../../utils/ApiError.js';
import { hashToken } from '../../utils/securityPolicy.js';
import { recordAudit } from '../../utils/securityauditService.js';
import { inspectPreOnboardingFile } from '../preOnboardingDocumentSecurityService.js';
import { storeBgvEvidence, getStoredBgvEvidence } from './bgvEvidenceStorageService.js';
import { BGV_CONSENT_PURPOSE } from './bgvConsentRules.js';
import { isCommerciallyAuthorized } from './bgvOrderRules.js';
import {
  CATEGORY_CHECK_MAP,
  COLLECTION_STATUS,
  EVIDENCE_ALLOWED_MIME_TYPES,
  EVIDENCE_MAX_FILE_BYTES,
  HR_COLLECTION_STATUS,
  RECORD_SCOPED_CATEGORIES,
  SELFIE_ALLOWED_MIME_TYPES,
  computeCollectionReadiness,
  isValidIdentifier,
  maskIdentifier,
  normalizeIdentifier,
  sanitizeCollectionCase,
  sanitizeEvidenceFile,
  validateAddressInput,
  validateEducationRecord,
  validateEmploymentRecord,
  validateIdentityInput,
  validateReferenceRecord,
} from './bgvCollectionRules.js';

const isObjectId = (value) => mongoose.isValidObjectId(value);
const genericFailure = () => ApiError.notFound('BGV collection link is unavailable');
const fingerprintOf = (value) =>
  hashToken(normalizeIdentifier(value)); // sha256 hex — stored select:false

// ── default (Mongo / storage / audit) collaborators ────────────────
const defaultResolveToken = (tokenHash) =>
  BgvConsentAccessToken.findOne({ tokenHash }).select('+tokenHash +activeKey').lean();

const defaultLoadOrder = ({ companyId, orderId }) =>
  isObjectId(orderId) ? BgvOrder.findOne({ _id: orderId, companyId }).lean() : Promise.resolve(null);

const defaultLoadCompany = ({ companyId }) =>
  Company.findOne({ _id: companyId }).select('name').lean();

const defaultLoadCase = ({ companyId, orderId }) =>
  BgvCollectionCase.findOne({ companyId, bgvOrder: orderId })
    // The fingerprint is select:false; the service needs it only to keep
    // the stored value on blank-identifier re-saves (never returned to UI).
    .select('+identity.identifierFingerprint')
    .lean();

const defaultCreateCase = (doc) => BgvCollectionCase.create(doc);

const defaultPersistCase = ({ companyId, caseId, set }) =>
  BgvCollectionCase.findOneAndUpdate({ _id: caseId, companyId }, { $set: set }, { returnDocument: 'after' }).lean();

const defaultListActiveFiles = ({ companyId, caseId }) =>
  BgvEvidenceFile.find({ companyId, bgvCollectionCase: caseId, isActive: true }).lean();

const defaultCreateFile = (doc) => BgvEvidenceFile.create(doc);

const defaultUpdateFile = ({ fileId, set }) =>
  BgvEvidenceFile.findOneAndUpdate({ _id: fileId }, { $set: set }, { returnDocument: 'after' }).lean();

const defaultLoadFileFull = ({ fileId }) =>
  isObjectId(fileId)
    ? BgvEvidenceFile.findOne({ _id: fileId }).select('+storageKey +checksumSha256').lean()
    : Promise.resolve(null);

const defaultStoreFile = (args) => storeBgvEvidence(args);
const defaultFetchFile = (args) => getStoredBgvEvidence(args);
const defaultAudit = (entry) => recordAudit(entry);
const defaultNewRecordId = () => new mongoose.Types.ObjectId().toString();

// ── shared authorization gate ───────────────────────────────────────
// Token authority → commercial readiness → explicit CONSENT → case.
const loadAuthorizedContext = async ({ rawToken, deps }) => {
  const resolveToken = deps.resolveToken || defaultResolveToken;
  const loadOrder = deps.loadOrder || defaultLoadOrder;
  const loadCompany = deps.loadCompany || defaultLoadCompany;
  const loadCase = deps.loadCase || defaultLoadCase;
  const createCase = deps.createCase || defaultCreateCase;
  const newRecordId = deps.newRecordId || defaultNewRecordId;

  if (typeof rawToken !== 'string' || rawToken.length < 40 || rawToken.length > 200) {
    throw genericFailure();
  }
  const token = await resolveToken(hashToken(rawToken));
  // Purpose isolation + revocation: same generic failure as the consent portal.
  if (!token || token.purpose !== BGV_CONSENT_PURPOSE || token.revokedAt) {
    throw genericFailure();
  }
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) {
    throw ApiError.notFound('This link has expired — ask the hiring team to resend it');
  }

  // Commercial readiness: the single 30.3 boundary (payment alone is never
  // re-derived here from provider fields).
  const order = await loadOrder({ companyId: token.companyId, orderId: token.bgvOrder });
  if (!order || !isCommerciallyAuthorized(order)) {
    throw ApiError.conflict('BGV collection requires a commercially authorized BGV order');
  }

  // CONSENT GATE — mandatory, backend-enforced. Payment or portal access
  // alone is not sufficient.
  if (token.finalDecision !== 'CONSENTED') {
    throw ApiError.conflict(
      'Consent is required before providing BGV information — please complete the consent step first'
    );
  }

  // Get-or-create the collection case from the immutable purchased checks.
  let collectionCase = await loadCase({ companyId: token.companyId, orderId: token.bgvOrder });
  if (!collectionCase) {
    const purchasedChecks = [...new Set((order.items || []).map((item) => item.type))];
    try {
      collectionCase = await createCase({
        companyId: token.companyId,
        candidate: token.candidate,
        bgvOrder: order._id,
        consentTokenRecord: token._id,
        purchasedChecks,
        status: COLLECTION_STATUS.NOT_STARTED,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      collectionCase = await loadCase({ companyId: token.companyId, orderId: token.bgvOrder });
    }
  }
  if (!collectionCase) throw genericFailure();

  const company = await loadCompany({ companyId: token.companyId });
  return { token, order, company, collectionCase, newRecordId };
};

// Draft mutation guard — submitted packages are frozen (30.9 later).
const assertEditable = (collectionCase) => {
  if (collectionCase.status === COLLECTION_STATUS.SUBMITTED) {
    throw ApiError.conflict(
      'Your BGV information was already submitted and is now locked — contact the hiring team if something needs correction'
    );
  }
};

const touchDraft = (collectionCase, set) => ({
  ...set,
  ...(collectionCase.status === COLLECTION_STATUS.NOT_STARTED
    ? { status: COLLECTION_STATUS.DRAFT }
    : {}),
});

const persist = async (deps, ctx, set) => {
  const persistCase = deps.persistCase || defaultPersistCase;
  const updated = await persistCase({
    companyId: ctx.token.companyId,
    caseId: ctx.collectionCase._id,
    set,
  });
  return updated || { ...ctx.collectionCase, ...set };
};

// ── public: collection portal summary (read-only) ───────────────────
export const resolveCollectionPortal = async ({ rawToken, deps = {} }) => {
  const listActiveFiles = deps.listActiveFiles || defaultListActiveFiles;
  const ctx = await loadAuthorizedContext({ rawToken, deps });

  const activeFiles = await listActiveFiles({
    companyId: ctx.token.companyId,
    caseId: ctx.collectionCase._id,
  });

  return {
    consentState: 'CONSENTED',
    companyName: ctx.company?.name || 'the requesting organisation',
    orderCode: ctx.order.orderCode,
    // Purchased checks only — the frontend renders exactly these sections.
    purchasedChecks: ctx.collectionCase.purchasedChecks,
    collection: sanitizeCollectionCase(ctx.collectionCase),
    files: activeFiles.map(sanitizeEvidenceFile),
    readiness: computeCollectionReadiness({
      purchasedChecks: ctx.collectionCase.purchasedChecks,
      collectionCase: ctx.collectionCase,
      activeFiles,
    }),
  };
};

// ── IDENTITY (masked identifiers only — full numbers never persist) ─
export const saveIdentityInformation = async ({ rawToken, input = {}, deps = {}, requestContext = null }) => {
  const audit = deps.audit || defaultAudit;
  const ctx = await loadAuthorizedContext({ rawToken, deps });
  assertEditable(ctx.collectionCase);

  // Purchased-check authorization (backend-enforced, not UI-only).
  if (!ctx.collectionCase.purchasedChecks.includes('IDENTITY')) {
    throw ApiError.conflict('Identity verification was not purchased for this BGV order');
  }

  // Blank identifier on re-save keeps the stored masked value (same
  // document type) — the full number never round-trips to the client.
  const requestedType = String(input.documentType).toUpperCase();
  const rawIdentifier = String(input.identifier || '').trim();
  const existingIdentity = ctx.collectionCase.identity || {};
  const keepExisting =
    !rawIdentifier &&
    Boolean(existingIdentity.identifierMasked) &&
    existingIdentity.documentType === requestedType;

  if (!rawIdentifier && !keepExisting) {
    throw ApiError.badRequest('Identity document number is required');
  }
  const problem = validateIdentityInput(input, { allowBlankIdentifier: keepExisting });
  if (problem) throw ApiError.badRequest(problem);

  let identifierMasked;
  let identifierFingerprint;
  if (rawIdentifier) {
    if (!isValidIdentifier(requestedType, rawIdentifier)) {
      throw ApiError.badRequest('The identity document number format is not valid for the selected type');
    }
    identifierMasked = maskIdentifier(requestedType, rawIdentifier);
    identifierFingerprint = fingerprintOf(rawIdentifier);
  } else {
    identifierMasked = existingIdentity.identifierMasked;
    identifierFingerprint = existingIdentity.identifierFingerprint || '';
  }

  // PRIVACY: only the masked display value and a select:false fingerprint
  // are stored. The full identifier never enters Mongo, logs, or audit.
  const updated = await persist(deps, ctx, touchDraft(ctx.collectionCase, {
    identity: {
      legalName: String(input.legalName).trim().slice(0, 160),
      dateOfBirth: new Date(input.dateOfBirth),
      documentType: requestedType,
      identifierMasked,
      identifierFingerprint,
      updatedAt: new Date(),
    },
  }));  await audit({
    req: requestContext,
    action: 'BGV_COLLECTION_SAVED',
    companyId: ctx.token.companyId,
    actorName: 'CANDIDATE',
    resource: 'BgvCollectionCase',
    resourceId: ctx.collectionCase._id,
    metadata: { checkType: 'IDENTITY', orderCode: ctx.order.orderCode, phase: '30.5' }, // no identifiers
  }).catch(() => {});

  return sanitizeCollectionCase(updated);
};

// ── ADDRESS (structured; no phone/field/geolocation verification) ───
export const saveAddressInformation = async ({ rawToken, input = {}, deps = {}, requestContext = null }) => {
  const audit = deps.audit || defaultAudit;
  const ctx = await loadAuthorizedContext({ rawToken, deps });
  assertEditable(ctx.collectionCase);
  if (!ctx.collectionCase.purchasedChecks.includes('ADDRESS')) {
    throw ApiError.conflict('Address verification was not purchased for this BGV order');
  }

  const problem = validateAddressInput(input);
  if (problem) throw ApiError.badRequest(problem);

  const updated = await persist(deps, ctx, touchDraft(ctx.collectionCase, {
    address: {
      line1: String(input.line1).trim().slice(0, 200),
      line2: String(input.line2 || '').trim().slice(0, 200),
      locality: String(input.locality || '').trim().slice(0, 120),
      city: String(input.city).trim().slice(0, 120),
      state: String(input.state).trim().slice(0, 120),
      pincode: String(input.pincode).trim().slice(0, 12),
      country: String(input.country).trim().slice(0, 120),
      residenceType: input.residenceType || null,
      livingSince: input.livingSince ? new Date(input.livingSince) : null,
      evidenceCategory: input.evidenceCategory || null,
      updatedAt: new Date(),
    },
  }));

  await audit({
    req: requestContext,
    action: 'BGV_COLLECTION_SAVED',
    companyId: ctx.token.companyId,
    actorName: 'CANDIDATE',
    resource: 'BgvCollectionCase',
    resourceId: ctx.collectionCase._id,
    metadata: { checkType: 'ADDRESS', orderCode: ctx.order.orderCode, phase: '30.5' },
  }).catch(() => {});

  return sanitizeCollectionCase(updated);
};

// ── repeatable records (education / employment / reference) ─────────
const recordArrayKey = {
  EDUCATION: 'educations',
  EMPLOYMENT: 'employments',
  REFERENCE: 'references',
};

const buildRecordSaver = ({ checkType, validator, mapper }) =>
  async ({ rawToken, recordId = '', record = {}, deps = {}, requestContext = null }) => {
    const audit = deps.audit || defaultAudit;
    const newRecordId = deps.newRecordId || defaultNewRecordId;
    const ctx = await loadAuthorizedContext({ rawToken, deps });
    assertEditable(ctx.collectionCase);
    if (!ctx.collectionCase.purchasedChecks.includes(checkType)) {
      throw ApiError.conflict(`${checkType} verification was not purchased for this BGV order`);
    }

    const problem = validator(record);
    if (problem) throw ApiError.badRequest(problem);

    const key = recordArrayKey[checkType];
    const records = [...(ctx.collectionCase[key] || [])];
    let savedRecordId = recordId;
    if (recordId) {
      const index = records.findIndex((entry) => String(entry._id) === String(recordId));
      if (index === -1) throw ApiError.notFound('Record not found');
      records[index] = { ...records[index], ...mapper(record), _id: records[index]._id };
    } else {
      savedRecordId = newRecordId();
      records.push({ ...mapper(record), _id: savedRecordId });
    }

    const updated = await persist(deps, ctx, touchDraft(ctx.collectionCase, { [key]: records }));

    await audit({
      req: requestContext,
      action: 'BGV_COLLECTION_SAVED',
      companyId: ctx.token.companyId,
      actorName: 'CANDIDATE',
      resource: 'BgvCollectionCase',
      resourceId: ctx.collectionCase._id,
      metadata: { checkType, recordId: savedRecordId, orderCode: ctx.order.orderCode, phase: '30.5' },
    }).catch(() => {});

    return { recordId: savedRecordId, collection: sanitizeCollectionCase(updated) };
  };

const trimTo = (value, max) => String(value || '').trim().slice(0, max);

export const saveEducationRecord = buildRecordSaver({
  checkType: 'EDUCATION',
  validator: validateEducationRecord,
  mapper: (record) => ({
    institution: trimTo(record.institution, 200),
    universityBoard: trimTo(record.universityBoard, 200),
    qualification: trimTo(record.qualification, 120),
    specialization: trimTo(record.specialization, 120),
    enrollmentNumber: trimTo(record.enrollmentNumber, 60),
    startYear: Number(record.startYear) || null,
    endYear: Number(record.endYear) || null,
    location: trimTo(record.location, 160),
  }),
});

export const saveEmploymentRecord = buildRecordSaver({
  checkType: 'EMPLOYMENT',
  validator: validateEmploymentRecord,
  mapper: (record) => ({
    employer: trimTo(record.employer, 200),
    designation: trimTo(record.designation, 120),
    employeeId: trimTo(record.employeeId, 60),
    startDate: new Date(record.startDate),
    endDate: record.endDate ? new Date(record.endDate) : null,
    employmentType: record.employmentType === 'CURRENT' ? 'CURRENT' : 'PREVIOUS',
    hrContactName: trimTo(record.hrContactName, 120),
    hrContactEmail: trimTo(record.hrContactEmail, 160).toLowerCase(),
    hrContactPhone: trimTo(record.hrContactPhone, 20),
  }),
});

export const saveReferenceRecord = buildRecordSaver({
  checkType: 'REFERENCE',
  validator: validateReferenceRecord,
  mapper: (record) => ({
    name: trimTo(record.name, 120),
    organization: trimTo(record.organization, 200),
    designation: trimTo(record.designation, 120),
    relationship: trimTo(record.relationship, 120),
    email: trimTo(record.email, 160).toLowerCase(),
    phone: trimTo(record.phone, 20),
    context: trimTo(record.context, 300),
  }),
});

const buildRecordRemover = (checkType) =>
  async ({ rawToken, recordId, deps = {}, requestContext = null }) => {
    const audit = deps.audit || defaultAudit;
    const ctx = await loadAuthorizedContext({ rawToken, deps });
    assertEditable(ctx.collectionCase);
    if (!ctx.collectionCase.purchasedChecks.includes(checkType)) {
      throw ApiError.conflict(`${checkType} verification was not purchased for this BGV order`);
    }

    const key = recordArrayKey[checkType];
    const records = [...(ctx.collectionCase[key] || [])];
    const index = records.findIndex((entry) => String(entry._id) === String(recordId || ''));
    if (index === -1) throw ApiError.notFound('Record not found');
    records.splice(index, 1);

    const updated = await persist(deps, ctx, touchDraft(ctx.collectionCase, { [key]: records }));

    await audit({
      req: requestContext,
      action: 'BGV_COLLECTION_RECORD_REMOVED',
      companyId: ctx.token.companyId,
      actorName: 'CANDIDATE',
      resource: 'BgvCollectionCase',
      resourceId: ctx.collectionCase._id,
      metadata: { checkType, orderCode: ctx.order.orderCode, phase: '30.5' }, // no record content
    }).catch(() => {});

    return sanitizeCollectionCase(updated);
  };

export const removeEducationRecord = buildRecordRemover('EDUCATION');
export const removeEmploymentRecord = buildRecordRemover('EMPLOYMENT');
export const removeReferenceRecord = buildRecordRemover('REFERENCE');

// ── evidence upload (private storage, honest scan, versioning) ──────
export const uploadBgvEvidence = async ({
  rawToken,
  category,
  recordId = '',
  file,
  deps = {},
  requestContext = null,
}) => {
  const audit = deps.audit || defaultAudit;
  const listActiveFiles = deps.listActiveFiles || defaultListActiveFiles;
  const createFile = deps.createFile || defaultCreateFile;
  const updateFile = deps.updateFile || defaultUpdateFile;
  const storeFile = deps.storeFile || defaultStoreFile;

  const ctx = await loadAuthorizedContext({ rawToken, deps });
  assertEditable(ctx.collectionCase);

  const safeCategory = String(category || '').toUpperCase();
  const checkType = CATEGORY_CHECK_MAP[safeCategory];
  if (!checkType) throw ApiError.badRequest('Choose a valid evidence category');

  // Purchased-check authorization for uploads (backend-enforced).
  if (!ctx.collectionCase.purchasedChecks.includes(checkType)) {
    throw ApiError.conflict(`${checkType} verification was not purchased for this BGV order`);
  }

  // Record-scoped evidence must reference an existing repeatable record.
  let safeRecordId = null;
  if (RECORD_SCOPED_CATEGORIES.includes(safeCategory)) {
    const key = safeCategory === 'EDUCATION_CERTIFICATE' ? 'educations' : 'employments';
    const exists = (ctx.collectionCase[key] || []).some(
      (entry) => String(entry._id) === String(recordId || '')
    );
    if (!exists) throw ApiError.badRequest('Link this file to one of your saved records');
    safeRecordId = String(recordId);
  }

  // Reuse the existing upload security abstraction: allowlist MIME,
  // extension match, magic-byte structure, active-content rejection,
  // size cap, sanitized filename, sha256. Selfies are images only.
  const allowedMimeTypes =
    safeCategory === 'IDENTITY_SELFIE' ? SELFIE_ALLOWED_MIME_TYPES : EVIDENCE_ALLOWED_MIME_TYPES;
  const inspection = await inspectPreOnboardingFile({
    file,
    allowedMimeTypes,
    maxFileSize: EVIDENCE_MAX_FILE_BYTES,
  });

  // PRIVATE storage — never a public URL, never the queue.
  const storage = await storeFile({
    buffer: file.buffer,
    companyId: ctx.token.companyId,
    caseId: ctx.collectionCase._id,
  });

  // Versioning: replacing a draft file deactivates the previous version
  // (history preserved) instead of overwriting storage blindly.
  const activeFiles = await listActiveFiles({
    companyId: ctx.token.companyId,
    caseId: ctx.collectionCase._id,
  });
  const previous = activeFiles.find(
    (entry) =>
      entry.category === safeCategory &&
      (safeRecordId ? String(entry.recordId) === safeRecordId : !entry.recordId)
  );
  if (previous) {
    await updateFile({
      fileId: previous._id,
      set: { isActive: false, status: 'REPLACED', replacedAt: new Date() },
    });
  }

  const created = await createFile({
    companyId: ctx.token.companyId,
    bgvCollectionCase: ctx.collectionCase._id,
    bgvOrder: ctx.order._id,
    candidate: ctx.token.candidate,
    checkType,
    category: safeCategory,
    recordId: safeRecordId,
    version: previous ? (previous.version || 1) + 1 : 1,
    isActive: true,
    status: 'ACTIVE',
    originalFileName: inspection.originalFileName,
    mimeType: inspection.mimeType,
    fileSize: inspection.fileSize,
    storageProvider: storage.storageProvider,
    storageKey: storage.storageKey,
    checksumSha256: inspection.checksumSha256,
    // Honest malware posture — NOT_CONFIGURED is never faked to CLEAN.
    scanStatus: inspection.scanStatus,
    scanCheckedAt: inspection.scanCheckedAt,
  });

  await persist(deps, ctx, touchDraft(ctx.collectionCase, {}));

  await audit({
    req: requestContext,
    action: previous ? 'BGV_EVIDENCE_REPLACED' : 'BGV_EVIDENCE_UPLOADED',
    companyId: ctx.token.companyId,
    actorName: 'CANDIDATE',
    resource: 'BgvEvidenceFile',
    resourceId: created._id,
    // Audit-safe metadata: ids/categories/versions only — no filename,
    // no storage key, no contents, no token.
    metadata: {
      checkType,
      category: safeCategory,
      version: previous ? (previous.version || 1) + 1 : 1,
      scanStatus: inspection.scanStatus,
      orderCode: ctx.order.orderCode,
      phase: '30.5',
    },
  }).catch(() => {});

  return sanitizeEvidenceFile(created);
};

// ── evidence download (server-side relationship resolution only) ────
export const downloadBgvEvidence = async ({ rawToken, fileId, deps = {}, requestContext = null }) => {
  const audit = deps.audit || defaultAudit;
  const loadFileFull = deps.loadFileFull || defaultLoadFileFull;
  const fetchFile = deps.fetchFile || defaultFetchFile;

  const ctx = await loadAuthorizedContext({ rawToken, deps });
  const file = await loadFileFull({ fileId });

  // Cross-candidate / cross-case isolation: the file must belong to THIS
  // token's company AND collection case — user-supplied ids alone never
  // authorize a read.
  if (
    !file ||
    String(file.companyId) !== String(ctx.token.companyId) ||
    String(file.bgvCollectionCase) !== String(ctx.collectionCase._id) ||
    file.status === 'REMOVED'
  ) {
    throw genericFailure();
  }

  const buffer = await fetchFile({
    storageProvider: file.storageProvider,
    storageKey: file.storageKey,
  });

  await audit({
    req: requestContext,
    action: 'BGV_EVIDENCE_DOWNLOADED',
    companyId: ctx.token.companyId,
    actorName: 'CANDIDATE',
    resource: 'BgvEvidenceFile',
    resourceId: file._id,
    metadata: { category: file.category, version: file.version, phase: '30.5' },
  }).catch(() => {});

  return {
    fileName: file.originalFileName,
    mimeType: file.mimeType,
    checksum: file.checksumSha256,
    buffer,
  };
};

// ── evidence removal (draft only) ────────────────────────────────────
export const removeBgvEvidence = async ({ rawToken, fileId, deps = {}, requestContext = null }) => {
  const audit = deps.audit || defaultAudit;
  const updateFile = deps.updateFile || defaultUpdateFile;
  const listActiveFiles = deps.listActiveFiles || defaultListActiveFiles;

  const ctx = await loadAuthorizedContext({ rawToken, deps });
  assertEditable(ctx.collectionCase);

  const activeFiles = await listActiveFiles({
    companyId: ctx.token.companyId,
    caseId: ctx.collectionCase._id,
  });
  const file = activeFiles.find((entry) => String(entry._id) === String(fileId || ''));
  if (!file) throw ApiError.notFound('Evidence file not found');

  await updateFile({
    fileId: file._id,
    set: { isActive: false, status: 'REMOVED', removedAt: new Date() },
  });

  await audit({
    req: requestContext,
    action: 'BGV_EVIDENCE_REMOVED',
    companyId: ctx.token.companyId,
    actorName: 'CANDIDATE',
    resource: 'BgvEvidenceFile',
    resourceId: file._id,
    metadata: { category: file.category, orderCode: ctx.order.orderCode, phase: '30.5' },
  }).catch(() => {});

  return { removed: true };
};

// ── final submission (explicit POST; idempotent; freezes the case) ──
export const submitBgvPackage = async ({ rawToken, deps = {}, requestContext = null }) => {
  const audit = deps.audit || defaultAudit;
  const listActiveFiles = deps.listActiveFiles || defaultListActiveFiles;
  const ctx = await loadAuthorizedContext({ rawToken, deps });

  if (ctx.collectionCase.status === COLLECTION_STATUS.SUBMITTED) {
    // Idempotent replay — a repeat click never creates a second submission.
    return {
      idempotent: true,
      status: COLLECTION_STATUS.SUBMITTED,
      submittedAt: ctx.collectionCase.submittedAt,
    };
  }

  const activeFiles = await listActiveFiles({
    companyId: ctx.token.companyId,
    caseId: ctx.collectionCase._id,
  });
  const readiness = computeCollectionReadiness({
    purchasedChecks: ctx.collectionCase.purchasedChecks,
    collectionCase: ctx.collectionCase,
    activeFiles,
  });

  // Backend readiness decision — the frontend indicator is never the gate.
  if (!readiness.ready) {
    const error = ApiError.conflict('Complete all required information before submitting');
    error.missingRequirements = readiness.missing;
    throw error;
  }

  const submittedAt = new Date();
  await persist(deps, ctx, {
    status: COLLECTION_STATUS.SUBMITTED,
    submittedAt,
  });

  await audit({
    req: requestContext,
    action: 'BGV_PACKAGE_SUBMITTED',
    companyId: ctx.token.companyId,
    actorName: 'CANDIDATE',
    resource: 'BgvCollectionCase',
    resourceId: ctx.collectionCase._id,
    // Counts/statuses only — never form contents, identifiers, or files.
    metadata: {
      orderCode: ctx.order.orderCode,
      purchasedChecks: ctx.collectionCase.purchasedChecks,
      fileCount: activeFiles.length,
      phase: '30.5',
    },
  }).catch(() => {});

  // NOTE: submission starts NO verification, assigns NO verifier, changes
  // NO pipeline stage, and never implies BGV CLEAR.
  return { idempotent: false, status: COLLECTION_STATUS.SUBMITTED, submittedAt };
};

// ── HR: high-level collection visibility (status only) ───────────────
export const getHrCollectionStatus = async ({ companyId, candidateRef, deps = {} }) => {
  const loadCandidateByRef =
    deps.loadCandidateByRef ||
    (({ companyId: company, candidateRef: ref }) => {
      const filter = isObjectId(ref)
        ? { _id: ref, companyId: company }
        : { companyId: company, candidateCode: String(ref || '').trim().toUpperCase() };
      return Candidate.findOne(filter).lean();
    });
  const loadLatestOrder =
    deps.loadLatestOrder ||
    (({ companyId: company, candidateId }) =>
      BgvOrder.findOne({ companyId: company, candidate: candidateId, openKey: 'OPEN' }).lean());
  const loadCase = deps.loadCase || defaultLoadCase;
  const loadLatestToken =
    deps.loadLatestToken ||
    (({ companyId: company, orderId }) =>
      BgvConsentAccessToken.findOne({ companyId: company, bgvOrder: orderId })
        .sort({ createdAt: -1 })
        .lean());

  const candidate = await loadCandidateByRef({ companyId, candidateRef });
  if (!candidate) throw ApiError.notFound('Candidate not found');
  const order = await loadLatestOrder({ companyId, candidateId: candidate._id });

  // Minimum-necessary HR view: status only — never raw evidence files.
  if (!order || !isCommerciallyAuthorized(order)) {
    return { collectionStatus: HR_COLLECTION_STATUS.NOT_APPLICABLE, orderCode: order?.orderCode || '', submittedAt: null };
  }

  const token = await loadLatestToken({ companyId, orderId: order._id });
  if (token?.finalDecision !== 'CONSENTED') {
    return {
      collectionStatus: HR_COLLECTION_STATUS.AWAITING_CANDIDATE,
      orderCode: order.orderCode,
      submittedAt: null,
    };
  }

  const collectionCase = await loadCase({ companyId, orderId: order._id });
  const status =
    collectionCase?.status === COLLECTION_STATUS.SUBMITTED
      ? HR_COLLECTION_STATUS.CANDIDATE_SUBMITTED
      : collectionCase?.status === COLLECTION_STATUS.DRAFT
        ? HR_COLLECTION_STATUS.CANDIDATE_DRAFT
        : HR_COLLECTION_STATUS.AWAITING_CANDIDATE;

  return {
    collectionStatus: status,
    orderCode: order.orderCode,
    submittedAt: collectionCase?.submittedAt || null,
    // Per-check completion only — no field values, no files.
    perCheck:
      collectionCase && status !== HR_COLLECTION_STATUS.CANDIDATE_SUBMITTED
        ? computeCollectionReadiness({
            purchasedChecks: collectionCase.purchasedChecks,
            collectionCase,
            activeFiles: [],
          }).perCheck
        : (collectionCase?.purchasedChecks || []).reduce(
            (acc, type) => ({ ...acc, [type]: 'COMPLETE' }),
            {}
          ),
  };
};
