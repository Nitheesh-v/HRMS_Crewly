// ============================================================
//  PHASE 30.1 — BGV CHECK SERVICE (Verifier Workbench backend)
//
//  Every rule lives in bgvCheckRules.js (pure); this module is
//  I/O + scoping only. Non-negotiables enforced here:
//   - tenant scoping: EVERY query is { _id, companyId } style —
//     cross-tenant reads return NOT_FOUND (never leaks existence)
//   - verifier decisions are always human: transitions validate
//     against the machine, guards require written justification
//   - no raw identity document numbers in 30.1 payloads (400)
//   - audit rows carry safe metadata only (masked phones,
//     rounded geo, no note bodies, no file bytes)
//   - model/storage/cache collaborators are injectable (deps)
//     for hermetic tests — exactly like the Phase 28 workers
// ============================================================

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import BgvCheck from '../../models/BgvCheck.js';
import BackgroundVerificationCase from '../../models/BackgroundVerificationCase.js';
import BackgroundVerificationSettings from '../../models/BackgroundVerificationSettings.js';
import User from '../../models/User.js';
import ApiError from '../../utils/ApiError.js';
import { recordAudit } from '../../utils/securityauditService.js';
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

const isOpenStatus = (status) => !BGV_CHECK_TERMINAL_STATUSES.includes(status);
const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max);

const defaultDeps = {
  checkModel: BgvCheck,
  caseModel: BackgroundVerificationCase,
  settingsModel: BackgroundVerificationSettings,
  userModel: User,
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

// ── DTOs (small + safe; never raw docs) ──────────────────────────

const evidenceDto = (evidence, { fullPhone }) => {
  const meta = { ...(evidence.meta || {}) };
  if (evidence.kind === 'CALL_LOG' && !fullPhone) meta.phone = maskPhone(meta.phone);
  if (evidence.kind === 'FIELD_VISIT') {
    // Exact geo is shown to the reader; reduced precision applies
    // to AUDIT rows (see auditSafeEvidenceMeta). Rounding here is
    // display-safe: 6-decimal precision ~10cm, no privacy change.
    meta.geoLat = Number.isFinite(meta.geoLat) ? meta.geoLat : null;
  }
  return {
    id: String(evidence._id || ''),
    kind: evidence.kind,
    hasFile: Boolean(evidence.storageKey),
    filename: evidence.filename || '',
    mime: evidence.mime || '',
    sizeBytes: evidence.sizeBytes || 0,
    note: evidence.note || '',
    meta,
    addedBy: evidence.addedBy ? String(evidence.addedBy) : '',
    addedAt: evidence.addedAt || null,
  };
};

const entryDto = (entry, options) => ({
  entryKey: entry.entryKey,
  label: entry.label || '',
  claim: entry.claim || {},
  status: entry.status,
  resultSummary: entry.resultSummary || '',
  discrepancyNote: entry.discrepancyNote || '',
  evidence: (entry.evidence || []).map((evidence) => evidenceDto(evidence, options)),
  updatedAt: entry.updatedAt || null,
});

const checkDto = (check, options = {}) => ({
  id: String(check._id),
  caseId: String(check.bgvCaseId),
  candidateId: String(check.candidateId),
  checkType: check.checkType,
  status: check.status,
  isRequired: check.isRequired !== false,
  entries: (check.entries || []).map((entry) => entryDto(entry, options)),
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

const auditSafe = (payload) => {
  // Audit rows never throw into the request path, never carry PII.
  return Promise.resolve(payload).catch(() => {});
};

// ── Case seeding ─────────────────────────────────────────────────

const entriesForType = (checkType, caseDoc) => {
  const one = (label, claim) => [{ entryKey: crypto.randomUUID(), label, claim: claim || {} }];
  if (checkType === 'EMPLOYMENT') {
    const employers = Array.isArray(caseDoc.pastEmployers) ? caseDoc.pastEmployers : [];
    if (!employers.length) return one('Employment', {});
    return employers.map((employer, index) => ({
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
    })).slice(0, 10) || one('Employment', {});
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

export const seedChecksForCase = async ({ companyId, caseId, actorId }, deps = {}) => {
  const d = resolve(deps);
  if (!mongoose.isValidObjectId(caseId) || !mongoose.isValidObjectId(companyId)) {
    throw ApiError.badRequest('A valid BGV case is required');
  }

  const caseDoc = await d.caseModel
    .findOne({ _id: caseId, companyId })
    .select('status candidate pastEmployers education addressHistory candidateSnapshot')
    .lean();
  if (!caseDoc) throw ApiError.notFound('BGV case not found');
  if (['COMPLETED', 'CANCELLED'].includes(caseDoc.status)) {
    return { created: 0, skippedTypes: 0, reason: 'CASE_CLOSED' };
  }

  const settings =
    (await d.settingsModel.findOne({ companyId }).lean()) || {};
  const plan = requiredCheckTypesForSettings(settings);
  const existing = await d.checkModel
    .find({ companyId, bgvCaseId: caseDoc._id })
    .select('checkType status isRequired')
    .lean();
  const existingTypes = new Set(existing.map((check) => check.checkType));

  let created = 0;
  for (const item of plan) {
    if (!item.required || existingTypes.has(item.checkType)) continue;
    const initiatedAt = new Date();
    try {
      await d.checkModel.create({
        companyId,
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
      await auditSafe(
        d.audit
          ? d.audit({
              action: 'BGV_CHECK_SEEDED',
              companyId,
              actorId: actorId || null,
              resource: 'BgvCheck',
              newValue: { checkType: item.checkType },
              metadata: { caseId: String(caseDoc._id) },
            })
          : null
      );
    } catch (error) {
      // Concurrent seed race on the unique index — the row exists, fine.
      if (error?.code !== 11000) throw error;
    }
  }

  // Types the settings snapshot no longer requires: only previously
  // created, still-open checks are marked SKIPPED (spec — never
  // delete, never touch terminal rows).
  let skippedTypes = 0;
  for (const item of plan) {
    if (item.required || !existingTypes.has(item.checkType)) continue;
    const result = await d.checkModel.updateOne(
      { companyId, bgvCaseId: caseDoc._id, checkType: item.checkType, status: { $in: ['PENDING', 'IN_PROGRESS', 'INSUFFICIENT_DATA'] } },
      { $set: { status: 'SKIPPED', closedAt: new Date(), closedBy: actorId || null, 'followUp.closedReason': 'NOT_REQUIRED_BY_SETTINGS' } }
    );
    if (result?.modifiedCount) skippedTypes += 1;
  }

  return { created, skippedTypes };
};

// ── Reads (workbench scoping) ────────────────────────────────────

const buildScopeFilter = ({ d, companyId, actor, filters }) => {
  const filter = { companyId };
  const privileged = Boolean(actor?.canReadAll);
  const assignedOnly = !privileged || filters.assignedToMe === true || filters.assignedToMe === 'true';
  if (assignedOnly) filter.assignedVerifierId = actor.userId;
  else if (filters.assignedVerifierId) filter.assignedVerifierId = filters.assignedVerifierId;

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
  return filter;
};

const decorate = async ({ d, companyId, checks, actor }) => {
  if (!checks.length) return [];
  const verifierIds = [...new Set(checks.map((c) => c.assignedVerifierId).filter(Boolean))];
  const caseIds = [...new Set(checks.map((c) => c.bgvCaseId).filter(Boolean))];
  const [verifiers, cases] = await Promise.all([
    verifierIds.length
      ? d.userModel
          .find({ _id: { $in: verifierIds }, companyId })
          .select('name employeeCode')
          .lean()
      : [],
    caseIds.length
      ? d.caseModel
          .find({ _id: { $in: caseIds }, companyId })
          .select('candidateSnapshot jobSnapshot status')
          .lean()
      : [],
  ]);
  const verifierMap = new Map(verifiers.map((v) => [String(v._id), v]));
  const caseMap = new Map(cases.map((c) => [String(c._id), c]));
  return checks.map((check) => {
    const verifier = check.assignedVerifierId ? verifierMap.get(String(check.assignedVerifierId)) : null;
    const caseRecord = caseMap.get(String(check.bgvCaseId));
    return checkDto(check, {
      fullPhone: Boolean(actor?.canReadAll),
      verifierName: verifier?.name || '',
      verifierCode: verifier?.employeeCode || '',
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

export const listChecks = async ({ companyId, actor, filters = {}, page = 1, limit = 25 }, deps = {}) => {
  const d = resolve(deps);
  const filter = buildScopeFilter({ d, companyId, actor, filters });

  // Candidate search runs against the case snapshot (bounded).
  const search = clean(filters.search, 80);
  if (search) {
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cases = await d.caseModel
      .find({
        companyId,
        $or: [
          { 'candidateSnapshot.name': { $regex: safe, $options: 'i' } },
          { 'candidateSnapshot.candidateCode': { $regex: safe, $options: 'i' } },
        ],
      })
      .select('_id')
      .limit(200)
      .lean();
    const ids = cases.map((c) => c._id);
    filter.bgvCaseId = ids.length ? { $in: ids } : { $in: [mongoose.Types.ObjectId.createFromHexString('000000000000000000000000')] };
  }

  const limitCount = Math.min(100, Math.max(1, Number(limit) || 25));
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
  const data = await decorate({ d, companyId, checks, actor });
  return { checks: data, meta: { page: pageSafe, limit: limitCount, total } };
};

export const workbenchStats = async ({ companyId, actor }, deps = {}) => {
  const d = resolve(deps);
  const privileged = Boolean(actor?.canReadAll);
  const base = privileged ? { companyId } : { companyId, assignedVerifierId: actor.userId };
  const key = buildTenantCacheKey({
    companyId,
    namespace: 'bgv-workbench',
    segments: ['stats', privileged ? 'all' : String(actor.userId)],
  });
  const now = Date.now();
  const compute = async () => {
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

export const getCheck = async ({ companyId, checkId, actor }, deps = {}) => {
  const d = resolve(deps);
  const check = await d.checkModel.findOne({ _id: checkId, companyId }).lean();
  // Cross-tenant AND unassigned-actor reads both return NOT_FOUND —
  // the workbench never leaks that a check exists.
  if (!check || (!actor?.canReadAll && String(check.assignedVerifierId || '') !== String(actor?.userId))) {
    throw ApiError.notFound('BGV check not found');
  }

  await auditSafe(
    d.audit
      ? d.audit({
          action: 'BGV_CHECK_VIEWED',
          companyId,
          actorId: actor?.userId || null,
          resource: 'BgvCheck',
          resourceId: check._id,
          metadata: { checkId: String(check._id), checkType: check.checkType },
        })
      : null
  );

  const [decorated] = await decorate({ d, companyId, checks: [check], actor });
  return decorated;
};

// ── Mutations ────────────────────────────────────────────────────

const loadActionableCheck = async ({ d, companyId, checkId, actor }) => {
  const check = await d.checkModel.findOne({ _id: checkId, companyId }).lean();
  if (!check || (!actor?.canReadAll && String(check.assignedVerifierId || '') !== String(actor?.userId))) {
    throw ApiError.notFound('BGV check not found');
  }
  return check;
};

export const assignVerifier = async ({ companyId, checkId, verifierId, actorId }, deps = {}) => {
  const d = resolve(deps);
  if (!mongoose.isValidObjectId(verifierId)) throw ApiError.badRequest('Choose a valid verifier');
  const check = await loadActionableCheck({ d, companyId, checkId, actor: { userId: actorId, canReadAll: true } });

  // DB Logic — the verifier must be an ACTIVE user of THIS tenant;
  // a foreign id reads as "not found", never as "wrong tenant".
  const verifier = await d.userModel
    .findOne({ _id: verifierId, companyId, status: 'ACTIVE' })
    .select('_id')
    .lean();
  if (!verifier) throw ApiError.notFound('Verifier not found in this company');

  const updates = {
    assignedVerifierId: verifier._id,
    assignedAt: new Date(),
    assignedBy: actorId,
  };
  if (!check.followUp?.nextFollowUpAt) updates['followUp.nextFollowUpAt'] = new Date(Date.now() + 2 * 24 * 3600 * 1000);

  const updated = await d.checkModel.findOneAndUpdate({ _id: check._id, companyId }, { $set: updates }, { returnDocument: 'after' }).lean();

  await auditSafe(
    d.audit
      ? d.audit({
          action: 'BGV_CHECK_ASSIGNED',
          companyId,
          actorId,
          resource: 'BgvCheck',
          resourceId: check._id,
          previousValue: { assignedVerifierId: check.assignedVerifierId ? String(check.assignedVerifierId) : '' },
          newValue: { assignedVerifierId: String(verifier._id) },
          metadata: { checkType: check.checkType },
        })
      : null
  );

  await d.emitEvent({ type: 'BGV_CHECK_ASSIGNED', companyId, checkId: String(check._id), caseId: String(check.bgvCaseId), verifierId: String(verifier._id) });
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

export const updateStatus = async ({ companyId, checkId, entryKey = null, toStatus, payload = {}, actor = {} }, deps = {}) => {
  const d = resolve(deps);
  const actorId = actor.userId;
  const check = await loadActionableCheck({ d, companyId, checkId, actor });

  if (!BGV_CHECK_STATUSES.includes(String(toStatus).toUpperCase())) {
    throw ApiError.badRequest('Choose a valid target status');
  }
  const target = String(toStatus).toUpperCase();

  // 30.1 refuses raw document numbers anywhere in human text.
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
    canReopen: Boolean(actor.canReopen),
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
      { _id: check._id, companyId, 'entries.entryKey': String(entryKey) },
      { $set: entryUpdates },
      { returnDocument: 'after' }
    ).lean();

    // Check-level rollup from the entries (never a rejection).
    const rolled = rollupCheckStatusFromEntries((updated.entries || []));
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
      updated = await d.checkModel.findOneAndUpdate({ _id: check._id, companyId }, { $set: rollupPatch }, { returnDocument: 'after' }).lean();
    }
  } else {
    const transition = isValidTransition(check.status, target, context);
    if (!transition.ok) throw ApiError.badRequest(transition.reason);
    const updates = applyTransitionUpdate(check, target, payload, actorId);
    updated = await d.checkModel.findOneAndUpdate({ _id: check._id, companyId }, { $set: updates }, { returnDocument: 'after' }).lean();
  }

  await auditSafe(
    d.audit
      ? d.audit({
          action: 'BGV_CHECK_STATUS_CHANGED',
          companyId,
          actorId,
          resource: 'BgvCheck',
          resourceId: check._id,
          previousValue: { status: entryKey ? 'ENTRY' : check.status },
          newValue: { status: target, entryKey: entryKey || '' },
          metadata: { checkType: check.checkType },
        })
      : null
  );

  await d.emitEvent({
    type: 'BGV_CHECK_STATUS_CHANGED',
    companyId,
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

export const addEvidence = async ({ companyId, checkId, entryKey, kind, note = '', meta = {}, file = null, actor = {}, requestContext = null }, deps = {}) => {
  const d = resolve(deps);
  const actorId = actor.userId;
  const check = await loadActionableCheck({ d, companyId, checkId, actor });

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
    stored = await d.store({ buffer: file.buffer, companyId });
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
    { _id: check._id, companyId, 'entries.entryKey': targetKey },
    { $push: { 'entries.$.evidence': evidence }, $set: { 'entries.$.updatedAt': evidence.addedAt } }
  );

  // Audit: file facts only — never note bodies, never file bytes.
  await auditSafe(
    d.audit
      ? d.audit({
          req: requestContext,
          action: 'BGV_CHECK_EVIDENCE_ADDED',
          companyId,
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
        })
      : null
  );

  return { added: true, kind: evidenceKind, entryKey: targetKey };
};

export const getEvidenceFile = async ({ companyId, checkId, evidenceId, actor = {} }, deps = {}) => {
  const d = resolve(deps);
  const actorId = actor.userId;
  const check = await loadActionableCheck({ d, companyId, checkId, actor });
  for (const entry of check.entries || []) {
    const evidence = (entry.evidence || []).find((item) => String(item._id) === String(evidenceId));
    if (evidence) {
      if (!evidence.storageKey) throw ApiError.notFound('Evidence file not found');
      await auditSafe(
        d.audit
          ? d.audit({
              action: 'BGV_CHECK_EVIDENCE_DOWNLOADED',
              companyId,
              actorId,
              resource: 'BgvCheck',
              resourceId: check._id,
              metadata: { checkId: String(check._id), evidenceId: String(evidenceId), kind: evidence.kind },
            })
          : null
      );
      const buffer = await d.read({ storageProvider: evidence.storageProvider, storageKey: evidence.storageKey });
      return { buffer, filename: evidence.filename || 'evidence', mime: evidence.mime || 'application/octet-stream' };
    }
  }
  throw ApiError.notFound('Evidence not found');
};

export const extendSla = async ({ companyId, checkId, days, reason, actor = {} }, deps = {}) => {
  const d = resolve(deps);
  const actorId = actor.userId;
  const check = await loadActionableCheck({ d, companyId, checkId, actor });
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
    { _id: check._id, companyId },
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

  await auditSafe(
    d.audit
      ? d.audit({
          action: 'BGV_CHECK_SLA_EXTENDED',
          companyId,
          actorId,
          resource: 'BgvCheck',
          resourceId: check._id,
          previousValue: { dueAt: currentDue },
          newValue: { dueAt: updated.sla?.dueAt, days: boundedDays },
          metadata: { checkType: check.checkType },
        })
      : null
  );

  return checkDto(updated, {});
};

export const reopenCheck = async ({ companyId, checkId, reason, actor = {} }, deps = {}) => {
  const d = resolve(deps);
  const actorId = actor.userId;
  const check = await loadActionableCheck({ d, companyId, checkId, actor });
  if (!BGV_CHECK_TERMINAL_STATUSES.includes(check.status)) {
    throw ApiError.conflict('Only terminal checks (verified / UTV / skipped) can be reopened');
  }
  const note = clean(reason, 500);
  if (!note) throw ApiError.badRequest('A written reopen reason is required');
  if (containsRawDocumentNumber(note)) throw ApiError.badRequest('Mask any document numbers in the reason');

  const updated = await d.checkModel.findOneAndUpdate(
    { _id: check._id, companyId },
    { $set: { status: 'IN_PROGRESS', closedAt: null, closedBy: null, 'followUp.closedReason': '' } },
    { returnDocument: 'after' }
  ).lean();

  await auditSafe(
    d.audit
      ? d.audit({
          action: 'BGV_CHECK_REOPENED',
          companyId,
          actorId,
          resource: 'BgvCheck',
          resourceId: check._id,
          previousValue: { status: check.status },
          newValue: { status: 'IN_PROGRESS' },
          metadata: { checkType: check.checkType, reason: note },
          critical: true,
        })
      : null
  );

  await d.emitEvent({ type: 'BGV_CHECK_REOPENED', companyId, checkId: String(check._id), caseId: String(check.bgvCaseId) });
  return checkDto(updated, {});
};
