// ============================================================
//  PHASE 30.1 — BGV CHECK SERVICE (Crewly Verifier Workbench)
//  30.1.1 — execution is PLATFORM-OPERATED (ops-only).
//
//  BGV verification is performed by the Crewly team only, never
//  by tenant companies. Callers of this module are the
//  /api/super-admin/bgv routes with req.platformPermissions:
//    bgv:read   — see the whole queue (Crewly visibility)
//    bgv:verify — status / evidence / extend-SLA on any check
//    bgv:assign — assign / reassign, reopen, seed the queue
//  (SUPER_ADMIN's '*' covers everything; the ops pool is small and
//  trusted, so there is deliberately no "own checks only" rule —
//  the permission IS the gate.)
//  Tenant companies keep only the 27.15 layer (request, consent,
//  case decision) plus tenantChecksSummary() below — a bare
//  "how far is Crewly" chip feed: checkType / status / updatedAt.
//
//  assignedVerifierId: platform users live in the SAME User
//  collection (AdminSession/PLATFORM_ROLES pattern — there is no
//  separate admin model), so the field keeps its name and the
//  service enforces role ∈ PLATFORM_ROLES at assign time (tenant
//  User id → 400). Renaming to platformVerifierId would need a
//  data migration for zero additional safety — documented choice.
//
//  Audit contract (30.1.1): every mutation AND every detail read
//  records an audit row with actorRole 'PLATFORM_USER' +
//  metadata.actorType 'PLATFORM_USER' + the record's companyId.
//  recordAudit has no actorType column, hence the metadata marker
//  (documented in PHASE_30_1_1_OPS_WORKBENCH.md).
//
//  Non-negotiables unchanged: every BgvCheck row carries the
//  owning tenant's companyId (data belongs to the customer);
//  per-check writes are scoped by {_id, companyId} using the
//  companyId read from the record (never from the request);
//  verifier decisions are always human; raw identity document
//  numbers are refused (30.2 owns them); audit rows carry safe
//  metadata only; model/storage/cache collaborators are injectable
//  (deps) for hermetic tests.
// ============================================================

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import BgvCheck from '../../models/BgvCheck.js';
import BackgroundVerificationCase from '../../models/BackgroundVerificationCase.js';
import BackgroundVerificationSettings from '../../models/BackgroundVerificationSettings.js';
import Company from '../../models/Company.js';
import User from '../../models/User.js';
import ApiError from '../../utils/ApiError.js';
import { recordAudit } from '../../utils/securityauditService.js';
import { PLATFORM_ROLES } from '../../utils/constants.js';
import { buildTenantCacheKey, getOrSetCache } from '../../services/redisCacheService.js';
import { storeBgvEvidence, getStoredBgvEvidence } from './bgvEvidenceStorage.js';
import { emitBgvCheckEvent } from './bgvCheckEvents.js';
import {
  BGV_CHECK_STATUSES,
  BGV_CHECK_TERMINAL_STATUSES,
  BGV_CHECK_TYPES,
  BGV_EVIDENCE_FILE_KINDS,
  BGV_EVIDENCE_KINDS,
  BGV_EVIDENCE_MIME_ALLOWLIST,
  agingBucketBounds,
  computeSlaDueAt,
  containsRawDocumentNumber,
  isValidTransition,
  maskPhone,
  requiredCheckTypesForSettings,
  rollupCheckStatusFromEntries,
  sanitizeEvidenceMeta,
  roundGeoForAudit,
} from './bgvCheckRules.js';

const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max);

const defaultDeps = {
  checkModel: BgvCheck,
  caseModel: BackgroundVerificationCase,
  settingsModel: BackgroundVerificationSettings,
  userModel: User,
  companyModel: Company,
  store: storeBgvEvidence,
  read: getStoredBgvEvidence,
  emitEvent: emitBgvCheckEvent,
  // Audit must never throw into the request path; safe metadata only.
  audit: (payload) => recordAudit(payload).catch(() => {}),
  cacheThrough: async ({ key, ttlSeconds, loader }) => {
    const cached = await getOrSetCache(key, { ttlSeconds, version: 1, loader });
    return cached?.value;
  },
};

const resolve = (deps = {}) => ({ ...defaultDeps, ...deps });

// actor: { userId, canAssign } — derived from platform permissions
// by the controller (bgv:assign or '*'). Route permits gate the
// per-action permissions; the service re-checks only the
// queue-operations guard (assign/reopen) as defence in depth.
const requireOps = (actor = {}) => {
  if (!actor.canAssign) {
    throw ApiError.forbidden('Assigning, reopening and seeding need the bgv:assign platform permission');
  }
};

// Audit wrapper: marks every BGV write/read row as a platform-actor
// action (actorType lives in metadata — see header) and never lets a
// logging failure break the request path.
const platformAudit = (d, payload) =>
  Promise.resolve(
    d.audit({
      actorRole: 'PLATFORM_USER',
      ...payload,
      metadata: { actorType: 'PLATFORM_USER', ...(payload.metadata || {}) },
    })
  ).catch(() => {});

// ── DTOs (small + safe; never raw docs) ──────────────────────────

const evidenceDto = (evidence) => ({
  id: String(evidence._id || ''),
  kind: evidence.kind,
  hasFile: Boolean(evidence.storageKey),
  filename: evidence.filename || '',
  mime: evidence.mime || '',
  sizeBytes: evidence.sizeBytes || 0,
  note: evidence.note || '',
  meta: { ...(evidence.meta || {}) },
  addedBy: evidence.addedBy ? String(evidence.addedBy) : '',
  addedAt: evidence.addedAt || null,
});

const entryDto = (entry) => ({
  entryKey: entry.entryKey,
  label: entry.label || '',
  claim: entry.claim || {},
  status: entry.status,
  resultSummary: entry.resultSummary || '',
  discrepancyNote: entry.discrepancyNote || '',
  evidence: (entry.evidence || []).map(evidenceDto),
  updatedAt: entry.updatedAt || null,
});

const checkDto = (check, options = {}) => ({
  id: String(check._id),
  caseId: String(check.bgvCaseId),
  candidateId: String(check.candidateId),
  companyId: String(check.companyId),
  checkType: check.checkType,
  status: check.status,
  isRequired: check.isRequired !== false,
  entries: (check.entries || []).map(entryDto),
  assignedVerifierId: check.assignedVerifierId ? String(check.assignedVerifierId) : '',
  assignedVerifierName: options.verifierName || '',
  assignedVerifierCode: options.verifierCode || '',
  assignedAt: check.assignedAt || null,
  sla: {
    initiatedAt: check.sla?.initiatedAt || null,
    dueAt: check.sla?.dueAt || null,
    extendedOnce: Boolean(check.sla?.extendedOnce),
    extensionReason: check.sla?.extensionReason || '',
    extensionDays: check.sla?.extensionDays || 0,
  },
  followUp: {
    emailAttempts: check.followUp?.emailAttempts || 0,
    callAttempts: check.followUp?.callAttempts || 0,
    lastFollowUpAt: check.followUp?.lastFollowUpAt || null,
    nextFollowUpAt: check.followUp?.nextFollowUpAt || null,
    closedReason: check.followUp?.closedReason || '',
  },
  resultSummary: check.resultSummary || '',
  discrepancyNote: check.discrepancyNote || '',
  closedAt: check.closedAt || null,
  updatedAt: check.updatedAt || null,
  company: options.company || null,
  caseInfo: options.caseInfo || null,
});

const auditSafeEvidenceMeta = (kind, meta) => {
  if (kind === 'CALL_LOG') return { outcome: clean(meta.outcome, 200), phone: maskPhone(meta.phone) };
  if (kind === 'FIELD_VISIT') {
    return {
      geoLat: roundGeoForAudit(meta.geoLat),
      geoLng: roundGeoForAudit(meta.geoLng),
      geoAccuracyM: meta.geoAccuracyM || 0,
    };
  }
  if (kind === 'LINK') return { link: Boolean(meta.url) };
  return {};
};

// ── Case seeding ─────────────────────────────────────────────────

const entriesForType = (checkType, caseDoc) => {
  const one = (label, claim) => [{ entryKey: crypto.randomUUID(), label, claim: claim || {} }];
  if (checkType === 'EMPLOYMENT') {
    const employers = Array.isArray(caseDoc.pastEmployers) ? caseDoc.pastEmployers : [];
    if (!employers.length) return one('Employment', {});
    return employers
      .slice(0, 10)
      .map((employer) => ({
        entryKey: crypto.randomUUID(),
        label: clean(`${employer.orgName || 'Employer'} ${
          employer.fromDate || employer.toDate
            ? `${employer.fromDate ? new Date(employer.fromDate).getFullYear() : '?'}-${
                employer.toDate ? new Date(employer.toDate).getFullYear() : 'now'}`
            : ''}`.trim(), 200),
        claim: {
          orgName: clean(employer.orgName, 160),
          designation: clean(employer.designation, 120),
          employeeId: clean(employer.employeeId, 60),
          fromDate: employer.fromDate || null,
          toDate: employer.toDate || null,
          salaryVisibleOk: Boolean(employer.salaryVisibleOk),
        },
      }));
  }
  if (checkType === 'EDUCATION') {
    const education = Array.isArray(caseDoc.education) ? caseDoc.education : [];
    if (!education.length) return one('Education', {});
    return education
      .slice(0, 10)
      .map((item) => ({
        entryKey: crypto.randomUUID(),
        label: clean(`${item.degree || 'Qualification'}${item.institution ? `, ${item.institution}` : ''}`, 200),
        claim: {
          institution: clean(item.institution, 200),
          university: clean(item.university, 200),
          rollNumber: clean(item.rollNumber, 80),
          yearOfPassing: Number(item.yearOfPassing) || null,
          degree: clean(item.degree, 120),
        },
      }));
  }
  if (checkType === 'ADDRESS') {
    const addresses = Array.isArray(caseDoc.addressHistory) ? caseDoc.addressHistory : [];
    const permanent = addresses.find((item) => item?.kind === 'PERMANENT') || addresses[0] || null;
    return one('Permanent address', permanent ? {
      line: clean(permanent.line, 300),
      city: clean(permanent.city, 120),
      district: clean(permanent.district, 120),
      state: clean(permanent.state, 120),
      pinCode: clean(permanent.pinCode, 10),
    } : {});
  }
  if (checkType === 'COURT_RECORD') {
    const addresses = Array.isArray(caseDoc.addressHistory) ? caseDoc.addressHistory : [];
    return one('Court records (last 7 years)', {
      jurisdictions: addresses.slice(0, 6).map((item) =>
        clean([item.district, item.state].filter(Boolean).join(', '), 160)
      ).filter(Boolean),
    });
  }
  // IDENTITY (and anything else): single uniform entry.
  return one('Identity', {
    name: caseDoc.candidateSnapshot?.name || '',
    dateOfBirth: null,
  });
};

export const seedChecksForCase = async ({ companyId = null, caseId, actorId }, deps = {}) => {
  const d = resolve(deps);
  if (!mongoose.isValidObjectId(caseId)) throw ApiError.badRequest('A valid BGV case is required');

  const lookup = { _id: caseId };
  // Callers that KNOW the tenant (the 27.15 start hook) pass it and
  // get the scoped lookup; the platform repair route may omit it —
  // the case's own companyId then decides (never the request body).
  if (companyId) {
    if (!mongoose.isValidObjectId(companyId)) throw ApiError.badRequest('A valid BGV case is required');
    lookup.companyId = companyId;
  }
  const caseDoc = await d.caseModel
    .findOne(lookup)
    .select('status candidate companyId pastEmployers education addressHistory candidateSnapshot')
    .lean();
  if (!caseDoc) throw ApiError.notFound('BGV case not found');
  const ownerCompanyId = caseDoc.companyId;
  if (['COMPLETED', 'CANCELLED'].includes(caseDoc.status)) {
    return { created: 0, skippedTypes: 0, reason: 'CASE_CLOSED' };
  }

  const settings = (await d.settingsModel.findOne({ companyId: ownerCompanyId }).lean()) || {};
  const plan = requiredCheckTypesForSettings(settings);
  const existing = await d.checkModel
    .find({ companyId: ownerCompanyId, bgvCaseId: caseDoc._id })
    .select('checkType status isRequired')
    .lean();
  const existingTypes = new Set(existing.map((check) => check.checkType));

  let created = 0;
  for (const item of plan) {
    if (!item.required || existingTypes.has(item.checkType)) continue;
    const initiatedAt = new Date();
    try {
      await d.checkModel.create({
        companyId: ownerCompanyId,
        bgvCaseId: caseDoc._id,
        candidateId: caseDoc.candidate,
        checkType: item.checkType,
        status: 'PENDING',
        isRequired: true,
        entries: entriesForType(item.checkType, caseDoc),
        sla: { initiatedAt, dueAt: computeSlaDueAt(settings, item.checkType, initiatedAt) },
        createdBy: actorId || null,
      });
      created += 1;
      await platformAudit(d, {
        action: 'BGV_CHECK_SEEDED',
        companyId: ownerCompanyId,
        actorId: actorId || null,
        resource: 'BgvCheck',
        newValue: { checkType: item.checkType },
        metadata: { caseId: String(caseDoc._id) },
      });
    } catch (error) {
      // Concurrent seed race on the unique index — the row exists, fine.
      if (error?.code !== 11000) throw error;
    }
  }

  // Types the settings snapshot no longer requires: only previously
  // created, still-open checks are marked SKIPPED (never delete, never
  // touch terminal rows).
  let skippedTypes = 0;
  for (const item of plan) {
    if (item.required || !existingTypes.has(item.checkType)) continue;
    const result = await d.checkModel.updateOne(
      { companyId: ownerCompanyId, bgvCaseId: caseDoc._id, checkType: item.checkType, status: { $in: ['PENDING', 'IN_PROGRESS', 'INSUFFICIENT_DATA'] } },
      { $set: { status: 'SKIPPED', closedAt: new Date(), closedBy: actorId || null, 'followUp.closedReason': 'NOT_REQUIRED_BY_SETTINGS' } }
    );
    if (result?.modifiedCount) skippedTypes += 1;
  }

  return { created, skippedTypes };
};

// ── Platform reads (cross-tenant work queue) ─────────────────────

const decorate = async ({ d, checks }) => {
  if (!checks.length) return [];
  const verifierIds = [...new Set(checks.map((c) => c.assignedVerifierId).filter(Boolean))];
  const caseIds = [...new Set(checks.map((c) => c.bgvCaseId).filter(Boolean))];
  const companyIds = [...new Set(checks.map((c) => c.companyId).filter(Boolean))];
  const [verifiers, cases, companies] = await Promise.all([
    verifierIds.length
      ? d.userModel.find({ _id: { $in: verifierIds } }).select('name employeeCode role').lean()
      : [],
    caseIds.length
      ? d.caseModel.find({ _id: { $in: caseIds } }).select('candidateSnapshot jobSnapshot status companyId').lean()
      : [],
    companyIds.length
      ? d.companyModel.find({ _id: { $in: companyIds } }).select('name').lean()
      : [],
  ]);
  const verifierMap = new Map(verifiers.map((v) => [String(v._id), v]));
  const caseMap = new Map(cases.map((c) => [String(c._id), c]));
  const companyMap = new Map(companies.map((c) => [String(c._id), c]));
  return checks.map((check) => {
    const verifier = check.assignedVerifierId ? verifierMap.get(String(check.assignedVerifierId)) : null;
    const caseRecord = caseMap.get(String(check.bgvCaseId));
    return checkDto(check, {
      verifierName: verifier?.name || '',
      verifierCode: verifier?.employeeCode || '',
      company: companyMap.get(String(check.companyId))
        ? { id: String(check.companyId), name: companyMap.get(String(check.companyId)).name }
        : null,
      caseInfo: caseRecord
        ? {
            candidateName: caseRecord.candidateSnapshot?.name || '',
            candidateCode: caseRecord.candidateSnapshot?.candidateCode || '',
            jobTitle: caseRecord.jobSnapshot?.title || '',
            caseStatus: caseRecord.status || '',
          }
        : null,
    });
  });
};

export const listChecks = async ({ companyId = null, actor = {}, filters = {}, page = 1, limit = 25 }, deps = {}) => {
  const d = resolve(deps);
  const filter = {};
  if (companyId && mongoose.isValidObjectId(companyId)) filter.companyId = companyId;
  else if (filters.companyId && mongoose.isValidObjectId(filters.companyId)) filter.companyId = filters.companyId;

  if (filters.assignedToMe === true || filters.assignedToMe === 'true') {
    filter.assignedVerifierId = actor.userId;
  } else if (filters.assignedVerifierId) {
    filter.assignedVerifierId = filters.assignedVerifierId;
  }

  if (filters.checkType && BGV_CHECK_TYPES.includes(String(filters.checkType).toUpperCase())) {
    filter.checkType = String(filters.checkType).toUpperCase();
  }
  const statuses = (Array.isArray(filters.status) ? filters.status : String(filters.status || '').split(','))
    .map((value) => String(value).trim().toUpperCase())
    .filter((value) => BGV_CHECK_STATUSES.includes(value));
  if (statuses.length) filter.status = { $in: statuses };
  if (mongoose.isValidObjectId(filters.caseId)) filter.bgvCaseId = filters.caseId;
  if (mongoose.isValidObjectId(filters.candidateId)) filter.candidateId = filters.candidateId;
  const bucket = agingBucketBounds(clean(filters.agingBucket, 8), new Date());
  if (bucket) filter['sla.initiatedAt'] = bucket;

  // Candidate search runs against the case snapshot (bounded).
  const search = clean(filters.search, 80);
  if (search) {
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const caseFilter = {
      $or: [
        { 'candidateSnapshot.name': { $regex: safe, $options: 'i' } },
        { 'candidateSnapshot.candidateCode': { $regex: safe, $options: 'i' } },
      ],
    };
    if (filter.companyId) caseFilter.companyId = filter.companyId;
    const cases = await d.caseModel.find(caseFilter).select('_id').limit(200).lean();
    const ids = cases.map((c) => c._id);
    filter.bgvCaseId = ids.length
      ? { $in: ids }
      : { $in: [mongoose.Types.ObjectId.createFromHexString('000000000000000000000000')] };
  }

  // Never an unbounded all-tenant dump: without a narrowing filter
  // (tenant / status / assignee) the server hard-caps the page size
  // so a plain GET /checks cannot exfiltrate the whole queue in bulk.
  const narrowed = Boolean(filter.companyId || filter.status || filter.assignedVerifierId);
  const cap = narrowed ? 100 : 50;
  const limitCount = Math.min(cap, Math.max(1, Number(limit) || 25));
  const pageSafe = Math.max(1, Number(page) || 1);
  const [total, checks] = await Promise.all([
    d.checkModel.countDocuments(filter),
    d.checkModel
      .find(filter)
      .sort({ 'sla.dueAt': 1, createdAt: 1 })
      .skip((pageSafe - 1) * limitCount)
      .limit(limitCount)
      .lean(),
  ]);
  const data = await decorate({ d, checks });
  return {
    checks: data,
    meta: {
      page: pageSafe,
      limit: limitCount,
      total,
      capped: !narrowed,
      ...(narrowed ? {} : { notice: 'Unfiltered queue is capped — add tenant, status or assignee to page deeper.' }),
    },
  };
};

export const workbenchStats = async ({ companyId = null, actor = {} }, deps = {}) => {
  const d = resolve(deps);
  const scoped = companyId && mongoose.isValidObjectId(companyId);
  const key = buildTenantCacheKey({
    companyId: scoped ? companyId : 'platform',
    namespace: 'bgv-workbench',
    segments: ['stats', scoped ? 'tenant' : 'all'],
  });
  const now = Date.now();
  const compute = async () => {
    const base = scoped ? { companyId } : {};
    const openFilter = { ...base, status: { $nin: [...BGV_CHECK_TERMINAL_STATUSES] } };
    const [open, dueSoon, overdue, awaiting] = await Promise.all([
      d.checkModel.countDocuments(openFilter),
      d.checkModel.countDocuments({
        ...openFilter,
        'sla.dueAt': { $gt: new Date(now), $lte: new Date(now + 48 * 3600 * 1000) },
      }),
      d.checkModel.countDocuments({ ...openFilter, 'sla.dueAt': { $ne: null, $lte: new Date(now) } }),
      d.checkModel.countDocuments({ ...openFilter, 'followUp.lastFollowUpAt': { $ne: null } }),
    ]);
    return { open, dueSoonIn48h: dueSoon, overdue, awaitingResponse: awaiting };
  };
  try {
    return (await d.cacheThrough({ key, ttlSeconds: 60, loader: compute })) ?? (await compute());
  } catch {
    return compute();
  }
};

export const listVerifiers = async (_args = {}, deps = {}) => {
  const d = resolve(deps);
  const users = await d.userModel
    .find({ role: { $in: [...PLATFORM_ROLES] }, status: 'ACTIVE' })
    .select('name email role')
    .sort({ name: 1 })
    .limit(200)
    .lean();
  return users.map((user) => ({
    id: String(user._id),
    name: user.name || 'Crewly admin',
    role: user.role,
  }));
};

export const getCheck = async ({ checkId, actor = {} }, deps = {}) => {
  const d = resolve(deps);
  // Resolution order per 30.1.1: load by _id → take the companyId
  // FROM THE RECORD → all follow-up queries use {_id, companyId}.
  const check = await d.checkModel.findOne({ _id: checkId }).lean();
  if (!check) throw ApiError.notFound('BGV check not found');

  // Audit-on-read: opening a cross-tenant check is itself logged
  // (Crewly staff touching tenant data must leave a trail).
  await platformAudit(d, {
    action: 'BGV_CHECK_VIEWED',
    companyId: check.companyId,
    actorId: actor.userId || null,
    resource: 'BgvCheck',
    resourceId: check._id,
    metadata: { checkId: String(check._id), checkType: check.checkType },
  });

  const [decorated] = await decorate({ d, checks: [check] });
  return decorated;
};

// ── Tenant-facing summary (read-only, masked to the bone) ────────
// Spec 30.1.1 item 3: tenants get ONLY {checkType, status,
// updatedAt} per check — no evidence, no verifier notes, no call
// logs, no assignee names. The final report is a 30.7 deliverable.
export const tenantChecksSummary = async ({ companyId, caseId }, deps = {}) => {
  const d = resolve(deps);
  const checks = await d.checkModel
    .find({ companyId, bgvCaseId: caseId })
    .sort({ 'sla.dueAt': 1 })
    .lean();
  return checks.map((check) => ({
    checkType: check.checkType,
    status: check.status,
    updatedAt: check.updatedAt || null,
  }));
};

// ── Platform mutations ───────────────────────────────────────────

const loadCheck = async ({ d, checkId, companyId = null }) => {
  const filter = { _id: checkId };
  if (companyId) filter.companyId = companyId;
  const check = await d.checkModel.findOne(filter).lean();
  if (!check) throw ApiError.notFound('BGV check not found');
  return check;
};

export const assignVerifier = async ({ checkId, verifierId, actor = {} }, deps = {}) => {
  const d = resolve(deps);
  requireOps(actor);
  if (!mongoose.isValidObjectId(verifierId)) throw ApiError.badRequest('Choose a valid verifier');
  const check = await loadCheck({ d, checkId });

  // DB Logic — the verifier must be a Crewly PLATFORM user. Tenant
  // employees are a hard 400 (spec 30.1.1 item 5); unknown ids 404.
  const verifier = await d.userModel
    .findOne({ _id: verifierId })
    .select('_id role status')
    .lean();
  if (!verifier) throw ApiError.notFound('Verifier not found');
  if (!PLATFORM_ROLES.includes(verifier.role) || verifier.status !== 'ACTIVE') {
    throw ApiError.badRequest('BGV verifiers must be active Crewly platform users — tenant accounts cannot verify');
  }

  const updates = {
    assignedVerifierId: verifier._id,
    assignedAt: new Date(),
    assignedBy: actor.userId || null,
  };
  if (!check.followUp?.nextFollowUpAt) updates['followUp.nextFollowUpAt'] = new Date(Date.now() + 2 * 24 * 3600 * 1000);

  const updated = await d.checkModel.findOneAndUpdate(
    { _id: check._id, companyId: check.companyId },
    { $set: updates },
    { returnDocument: 'after' }
  ).lean();

  await platformAudit(d, {
    action: 'BGV_CHECK_ASSIGNED',
    companyId: check.companyId,
    actorId: actor.userId || null,
    resource: 'BgvCheck',
    resourceId: check._id,
    previousValue: { assignedVerifierId: check.assignedVerifierId ? String(check.assignedVerifierId) : '' },
    newValue: { assignedVerifierId: String(verifier._id) },
    metadata: { checkType: check.checkType },
  });

  await d.emitEvent({ type: 'BGV_CHECK_ASSIGNED', companyId: String(check.companyId), checkId: String(check._id), caseId: String(check.bgvCaseId), verifierId: String(verifier._id) });
  return checkDto(updated, {});
};

const applyTransitionUpdate = (check, toStatus, payload, actorId) => {
  const updates = { status: toStatus };
  if (payload.resultSummary !== undefined) updates.resultSummary = clean(payload.resultSummary, 2000);
  if (payload.discrepancyNote !== undefined) updates.discrepancyNote = clean(payload.discrepancyNote, 2000);
  if (toStatus === 'UTV') {
    updates['followUp.closedReason'] = clean(payload.followUp?.closedReason || payload.reason, 200);
  }
  if (toStatus === 'IN_PROGRESS' && check.status === 'VERIFIED') {
    // Reopen: terminal markers are cleared, history stays in audit.
    updates.closedAt = null;
    updates.closedBy = null;
  }
  if (BGV_CHECK_TERMINAL_STATUSES.includes(toStatus)) {
    updates.closedAt = new Date();
    updates.closedBy = actorId;
  }
  return updates;
};

export const updateStatus = async ({ checkId, entryKey = null, toStatus, payload = {}, actor = {} }, deps = {}) => {
  const d = resolve(deps);
  const actorId = actor.userId;
  const check = await loadCheck({ d, checkId });

  if (!BGV_CHECK_STATUSES.includes(String(toStatus).toUpperCase())) {
    throw ApiError.badRequest('Choose a valid target status');
  }
  const target = String(toStatus).toUpperCase();

  // 30.1 refuses raw document numbers anywhere in verifier text.
  for (const value of [payload.resultSummary, payload.discrepancyNote, payload.reason]) {
    if (containsRawDocumentNumber(value)) {
      throw ApiError.badRequest('Raw Aadhaar/PAN/passport numbers are not allowed here — mask them (e.g. XXXX XXXX 9012)');
    }
  }

  const context = {
    isRequired: check.isRequired !== false,
    resultSummary: payload.resultSummary,
    discrepancyNote: payload.discrepancyNote,
    closedReason: payload.followUp?.closedReason,
    reason: payload.reason,
    canReopen: Boolean(actor.canAssign),
  };

  const now = new Date();
  let updated;

  if (entryKey) {
    const entry = (check.entries || []).find((item) => item.entryKey === String(entryKey));
    if (!entry) throw ApiError.notFound('Entry not found on this check');
    const entryCheck = isValidTransition(entry.status, target, context);
    if (!entryCheck.ok) throw ApiError.badRequest(entryCheck.reason);

    const entryUpdates = {
      'entries.$.status': target,
      'entries.$.updatedAt': now,
    };
    if (payload.resultSummary !== undefined) entryUpdates['entries.$.resultSummary'] = clean(payload.resultSummary, 2000);
    if (payload.discrepancyNote !== undefined) entryUpdates['entries.$.discrepancyNote'] = clean(payload.discrepancyNote, 2000);

    updated = await d.checkModel.findOneAndUpdate(
      { _id: check._id, companyId: check.companyId, 'entries.entryKey': String(entryKey) },
      { $set: entryUpdates },
      { returnDocument: 'after' }
    ).lean();

    // Check-level rollup from the entries (never a rejection).
    const rolled = rollupCheckStatusFromEntries(updated.entries || []);
    const rollupPatch = {};
    if (rolled !== updated.status) rollupPatch.status = rolled;
    if (BGV_CHECK_TERMINAL_STATUSES.includes(rolled)) {
      rollupPatch.closedAt = now;
      rollupPatch.closedBy = actorId;
      // An entry-driven UTV closure keeps its written reason at the
      // check level too — that is what 30.3's auto-closure trail reads.
      if (rolled === 'UTV' && !updated.followUp?.closedReason) {
        rollupPatch['followUp.closedReason'] = clean(payload.followUp?.closedReason || '', 200);
      }
    } else if (BGV_CHECK_TERMINAL_STATUSES.includes(updated.status)) {
      rollupPatch.closedAt = null;
      rollupPatch.closedBy = null;
    }
    if (Object.keys(rollupPatch).length) {
      updated = await d.checkModel
        .findOneAndUpdate({ _id: check._id, companyId: check.companyId }, { $set: rollupPatch }, { returnDocument: 'after' })
        .lean();
    }
  } else {
    const transition = isValidTransition(check.status, target, context);
    if (!transition.ok) throw ApiError.badRequest(transition.reason);
    const updates = applyTransitionUpdate(check, target, payload, actorId);
    updated = await d.checkModel
      .findOneAndUpdate({ _id: check._id, companyId: check.companyId }, { $set: updates }, { returnDocument: 'after' })
      .lean();
  }

  await platformAudit(d, {
    action: 'BGV_CHECK_STATUS_CHANGED',
    companyId: check.companyId,
    actorId,
    resource: 'BgvCheck',
    resourceId: check._id,
    previousValue: { status: entryKey ? 'ENTRY' : check.status },
    newValue: { status: target, entryKey: entryKey || '' },
    metadata: { checkType: check.checkType },
  });

  await d.emitEvent({
    type: 'BGV_CHECK_STATUS_CHANGED',
    companyId: String(check.companyId),
    checkId: String(check._id),
    caseId: String(check.bgvCaseId),
    candidateId: String(check.candidateId),
    checkType: check.checkType,
    entryKey: entryKey || null,
    toStatus: target,
    at: now.toISOString(),
  });

  return checkDto(updated, {});
};

export const addEvidence = async ({ checkId, entryKey, kind, note = '', meta = {}, file = null, actor = {}, requestContext = null }, deps = {}) => {
  const d = resolve(deps);
  const actorId = actor.userId;
  const check = await loadCheck({ d, checkId });

  const evidenceKind = String(kind || '').toUpperCase();
  if (!BGV_EVIDENCE_KINDS.includes(evidenceKind)) throw ApiError.badRequest('Choose a valid evidence kind');

  const parsedMeta = typeof meta === 'string' ? (() => { try { return JSON.parse(meta); } catch { return {}; } })() : meta;
  // No raw document numbers in notes or in per-kind metadata.
  if (containsRawDocumentNumber(note) || containsRawDocumentNumber(parsedMeta)) {
    throw ApiError.badRequest('Raw Aadhaar/PAN/passport numbers are not allowed as evidence text — mask them');
  }

  if (BGV_EVIDENCE_FILE_KINDS.includes(evidenceKind) && !file) {
    throw ApiError.badRequest('Screenshots and documents require a file');
  }
  if (file && !BGV_EVIDENCE_MIME_ALLOWLIST.includes(file.mimetype)) {
    throw ApiError.badRequest('Evidence files must be PNG, JPEG, WEBP or PDF');
  }

  let stored = null;
  if (file) {
    stored = await d.store({ buffer: file.buffer, companyId: String(check.companyId) });
  }

  const evidence = {
    kind: evidenceKind,
    note: clean(note, 2000),
    meta: sanitizeEvidenceMeta(evidenceKind, parsedMeta),
    addedBy: actorId,
    addedAt: new Date(),
    ...(stored
      ? {
          fileUrl: stored.fileUrl,
          storageProvider: stored.storageProvider,
          storageKey: stored.storageKey,
          filename: String(file.originalname || '').split(/[\\/]/).pop().slice(0, 160),
          mime: String(file.mimetype || '').slice(0, 120),
          sizeBytes: Number(file.size) || 0,
        }
      : {}),
  };

  // Single-entity checks may omit entryKey — target their only entry.
  let targetKey = clean(entryKey, 40);
  if (!targetKey) {
    if ((check.entries || []).length !== 1) throw ApiError.badRequest('Choose the entry this evidence belongs to');
    targetKey = check.entries[0].entryKey;
  }

  await d.checkModel.findOneAndUpdate(
    { _id: check._id, companyId: check.companyId, 'entries.entryKey': targetKey },
    { $push: { 'entries.$.evidence': evidence }, $set: { 'entries.$.updatedAt': evidence.addedAt } }
  );

  // Audit: file facts only — never note bodies, never file bytes.
  // `req` enriches ip/path/method; platformAudit stamps the actor kind.
  await platformAudit(d, {
    req: requestContext,
    action: 'BGV_CHECK_EVIDENCE_ADDED',
    companyId: check.companyId,
    actorId,
    resource: 'BgvCheck',
    resourceId: check._id,
    metadata: {
      checkId: String(check._id),
      entryKey: targetKey,
      kind: evidenceKind,
      filename: evidence.filename || '',
      mime: evidence.mime || '',
      sizeBytes: evidence.sizeBytes || 0,
      addedAt: evidence.addedAt,
      meta: auditSafeEvidenceMeta(evidenceKind, evidence.meta),
    },
  });

  return { added: true, kind: evidenceKind, entryKey: targetKey };
};

export const getEvidenceFile = async ({ checkId, evidenceId, actor = {} }, deps = {}) => {
  const d = resolve(deps);
  // Viewing evidence follows queue visibility: any platform role with
  // bgv:read may open files attached to checks they can see (route-gated).
  const check = await loadCheck({ d, checkId });
  for (const entry of check.entries || []) {
    const evidence = (entry.evidence || []).find((item) => String(item._id) === String(evidenceId));
    if (evidence) {
      if (!evidence.storageKey) throw ApiError.notFound('Evidence file not found');
      await platformAudit(d, {
        action: 'BGV_CHECK_EVIDENCE_DOWNLOADED',
        companyId: check.companyId,
        actorId: actor.userId || null,
        resource: 'BgvCheck',
        resourceId: check._id,
        metadata: { checkId: String(check._id), evidenceId: String(evidenceId), kind: evidence.kind },
      });
      const buffer = await d.read({ storageProvider: evidence.storageProvider, storageKey: evidence.storageKey });
      return { buffer, filename: evidence.filename || 'evidence', mime: evidence.mime || 'application/octet-stream' };
    }
  }
  throw ApiError.notFound('Evidence not found');
};

export const extendSla = async ({ checkId, days, reason, actor = {} }, deps = {}) => {
  const d = resolve(deps);
  const actorId = actor.userId;
  const check = await loadCheck({ d, checkId });
  if (check.sla?.extendedOnce) throw ApiError.conflict('SLA can only be extended once per check');
  const boundedDays = Math.trunc(Number(days));
  if (!Number.isInteger(boundedDays) || boundedDays < 1 || boundedDays > 30) {
    throw ApiError.badRequest('Extension must be between 1 and 30 days');
  }
  const note = clean(reason, 500);
  if (!note) throw ApiError.badRequest('An extension reason is required');
  if (containsRawDocumentNumber(note)) throw ApiError.badRequest('Mask any document numbers in the reason');

  const currentDue = check.sla?.dueAt ? new Date(check.sla.dueAt) : new Date();
  const updated = await d.checkModel.findOneAndUpdate(
    { _id: check._id, companyId: check.companyId },
    {
      $set: {
        'sla.dueAt': new Date(currentDue.getTime() + boundedDays * 24 * 3600 * 1000),
        'sla.extendedOnce': true,
        'sla.extensionReason': note,
        'sla.extensionDays': boundedDays,
      },
    },
    { returnDocument: 'after' }
  ).lean();

  await platformAudit(d, {
    action: 'BGV_CHECK_SLA_EXTENDED',
    companyId: check.companyId,
    actorId,
    resource: 'BgvCheck',
    resourceId: check._id,
    previousValue: { dueAt: currentDue },
    newValue: { dueAt: updated.sla?.dueAt, days: boundedDays },
    metadata: { checkType: check.checkType },
  });

  return checkDto(updated, {});
};

export const reopenCheck = async ({ checkId, reason, actor = {} }, deps = {}) => {
  const d = resolve(deps);
  const actorId = actor.userId;
  requireOps(actor);
  const check = await loadCheck({ d, checkId });
  if (!BGV_CHECK_TERMINAL_STATUSES.includes(check.status)) {
    throw ApiError.conflict('Only terminal checks (verified / UTV / skipped) can be reopened');
  }
  const note = clean(reason, 500);
  if (!note) throw ApiError.badRequest('A written reopen reason is required');
  if (containsRawDocumentNumber(note)) throw ApiError.badRequest('Mask any document numbers in the reason');

  const updated = await d.checkModel.findOneAndUpdate(
    { _id: check._id, companyId: check.companyId },
    { $set: { status: 'IN_PROGRESS', closedAt: null, closedBy: null, 'followUp.closedReason': '' } },
    { returnDocument: 'after' }
  ).lean();

  await platformAudit(d, {
    action: 'BGV_CHECK_REOPENED',
    companyId: check.companyId,
    actorId,
    resource: 'BgvCheck',
    resourceId: check._id,
    previousValue: { status: check.status },
    newValue: { status: 'IN_PROGRESS' },
    metadata: { checkType: check.checkType, reason: note },
    critical: true,
  });

  await d.emitEvent({ type: 'BGV_CHECK_REOPENED', companyId: String(check.companyId), checkId: String(check._id), caseId: String(check.bgvCaseId) });
  return checkDto(updated, {});
};
