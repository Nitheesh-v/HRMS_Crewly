import mongoose from 'mongoose';
import BackgroundVerificationCase from '../models/BackgroundVerificationCase.js';
import BackgroundVerificationCheck, {
  BGV_TERMINAL_CHECK_STATUSES,
} from '../models/BackgroundVerificationCheck.js';
import BackgroundVerificationCheckType from '../models/BackgroundVerificationCheckType.js';
import BackgroundVerificationHistory from '../models/BackgroundVerificationHistory.js';
import BackgroundVerificationSettings from '../models/BackgroundVerificationSettings.js';
import Candidate from '../models/Candidate.js';
import CandidateHistory from '../models/CandidateHistory.js';
import OfferLetter from '../models/OfferLetter.js';
import PreOnboarding from '../models/PreOnboarding.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import { nextBgvCaseCode } from '../utils/bgvIdentifiers.js';
import { notifyRoles } from '../utils/notify.js';
import { recordAudit } from '../utils/securityauditService.js';
import { dispatchBgvJob } from './bgv/bgvDispatcher.js';

const isObjectId = (value) => mongoose.isValidObjectId(value);
const clean = (value, max = 2000) => String(value || '').trim().slice(0, max);

const DEFAULT_CHECK_TYPES = [
  {
    code: 'IDENTITY',
    name: 'Identity verification',
    category: 'IDENTITY',
    required: true,
    displayOrder: 10,
    instructions: 'Verify government identity against candidate claims and evidence.',
  },
  {
    code: 'EDUCATION',
    name: 'Education verification',
    category: 'EDUCATION',
    required: true,
    displayOrder: 20,
    instructions: 'Verify highest education claims against certificates or institution response.',
  },
  {
    code: 'EMPLOYMENT',
    name: 'Employment verification',
    category: 'EMPLOYMENT',
    required: true,
    displayOrder: 30,
    instructions: 'Verify recent employment company, role, and dates.',
  },
  {
    code: 'REFERENCE',
    name: 'Reference check',
    category: 'REFERENCE',
    required: false,
    displayOrder: 40,
    instructions: 'Optional professional reference confirmation.',
  },
];

const TERMINAL_CHECK = new Set(BGV_TERMINAL_CHECK_STATUSES);

const claimFromCandidate = (candidate, category) => {
  if (category === 'IDENTITY') {
    return [
      `Name: ${candidate.name || ''}`,
      `Email: ${candidate.email || ''}`,
      `Phone: ${candidate.phone || ''}`,
      `Location: ${candidate.location || ''}`,
    ]
      .filter((line) => !line.endsWith(': '))
      .join('\n');
  }
  if (category === 'EDUCATION') {
    const education = candidate.education || {};
    return [
      `Degree: ${education.degree || ''}`,
      `Institution: ${education.institution || ''}`,
      `Graduation year: ${education.graduationYear || ''}`,
    ]
      .filter((line) => !line.endsWith(': '))
      .join('\n');
  }
  if (category === 'EMPLOYMENT') {
    return [
      `Current/last company: ${candidate.currentCompany || ''}`,
      `Title: ${candidate.currentJobTitle || ''}`,
      `Total experience (years): ${candidate.totalExperience ?? ''}`,
      `Relevant experience (years): ${candidate.relevantExperience ?? ''}`,
    ]
      .filter((line) => !line.endsWith(': '))
      .join('\n');
  }
  return '';
};

const recordHistory = async ({
  companyId,
  caseRecord,
  check = null,
  action,
  previousStatus = '',
  newStatus = '',
  actorId = null,
  actorType = 'TENANT_USER',
  reason = '',
  metadata = {},
}) =>
  BackgroundVerificationHistory.create({
    companyId,
    case: caseRecord._id,
    check: check?._id || null,
    candidate: caseRecord.candidate,
    action,
    previousStatus,
    newStatus,
    actorType,
    actor: actorId,
    reason: clean(reason, 1000),
    metadata,
  });

const timeline = async ({
  companyId,
  candidate,
  job,
  action,
  actorId = null,
  metadata = {},
}) =>
  CandidateHistory.create({
    companyId,
    candidate,
    job,
    action,
    source: 'PIPELINE',
    actorType: actorId ? 'TENANT_USER' : 'SYSTEM',
    actor: actorId,
    metadata,
    eventAt: new Date(),
  }).catch(() => null);

const checkDto = (check, { includeInternal = false } = {}) => ({
  id: check._id,
  code: check.code,
  name: check.nameSnapshot,
  description: check.descriptionSnapshot || '',
  category: check.categorySnapshot,
  instructions: check.instructionsSnapshot || '',
  required: Boolean(check.required),
  displayOrder: check.displayOrder,
  status: check.status,
  claimedInformation: check.claimedInformation || '',
  verifiedInformation: includeInternal ? check.verifiedInformation || '' : '',
  resultSummary: check.resultSummary || '',
  discrepancy: includeInternal ? check.discrepancy || '' : '',
  hrComment: includeInternal ? check.hrComment || '' : '',
  candidateComment: check.candidateComment || '',
  source: check.source,
  provider: check.provider,
  requestedAt: check.requestedAt,
  completedAt: check.completedAt,
  verifiedAt: check.verifiedAt,
  verifiedBy: includeInternal ? check.verifiedBy || null : undefined,
});

const caseDto = (caseRecord, checks = [], { includeInternal = true } = {}) => ({
  id: caseRecord._id,
  caseCode: caseRecord.caseCode,
  status: caseRecord.status,
  triggerStage: caseRecord.triggerStage,
  provider: caseRecord.provider,
  candidate: {
    id: caseRecord.candidate?._id || caseRecord.candidate,
    ...caseRecord.candidateSnapshot,
  },
  job: {
    id: caseRecord.job?._id || caseRecord.job,
    ...caseRecord.jobSnapshot,
  },
  offerId: caseRecord.offer || null,
  preOnboardingId: caseRecord.preOnboarding || null,
  consent: caseRecord.consent,
  requiredCheckCount: caseRecord.requiredCheckCount,
  verifiedRequiredCount: caseRecord.verifiedRequiredCount,
  discrepancyCount: caseRecord.discrepancyCount,
  overallOutcome: caseRecord.overallOutcome || '',
  assignedVerifier: caseRecord.assignedVerifier || null,
  startedAt: caseRecord.startedAt,
  completedAt: caseRecord.completedAt,
  reviewedAt: caseRecord.reviewedAt,
  reviewComment: includeInternal ? caseRecord.reviewComment || '' : '',
  checks: checks
    .slice()
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))
    .map((item) => checkDto(item, { includeInternal })),
  createdAt: caseRecord.createdAt,
  updatedAt: caseRecord.updatedAt,
});

export const evaluateBgvCaseReadiness = (checks = []) => {
  const required = checks.filter((item) => item.required);
  const optional = checks.filter((item) => !item.required);
  const verifiedRequired = required.filter((item) => item.status === 'VERIFIED');
  const discrepancyRequired = required.filter((item) => item.status === 'DISCREPANCY');
  const unableRequired = required.filter((item) => item.status === 'UNABLE_TO_VERIFY');
  const openRequired = required.filter((item) => !TERMINAL_CHECK.has(item.status));
  const discrepancyCount = checks.filter((item) => item.status === 'DISCREPANCY').length;

  const allRequiredTerminal =
    required.length > 0 && openRequired.length === 0;

  return {
    requiredCount: required.length,
    verifiedRequiredCount: verifiedRequired.length,
    discrepancyRequiredCount: discrepancyRequired.length,
    unableRequiredCount: unableRequired.length,
    openRequiredCount: openRequired.length,
    optionalCount: optional.length,
    discrepancyCount,
    allRequiredTerminal,
    reviewable: allRequiredTerminal,
  };
};

const deriveCaseStatus = ({ currentStatus, checks, consent }) => {
  if (['COMPLETED', 'CANCELLED'].includes(currentStatus)) return currentStatus;

  const readiness = evaluateBgvCaseReadiness(checks);
  if (readiness.reviewable) return 'REVIEW_REQUIRED';

  if (consent?.required && consent.status === 'REQUESTED') {
    return 'AWAITING_CANDIDATE';
  }

  const awaitingCandidate = checks.some(
    (item) => item.status === 'AWAITING_CANDIDATE'
  );
  if (awaitingCandidate) return 'AWAITING_CANDIDATE';

  const awaitingVerifier = checks.some((item) =>
    ['AWAITING_VERIFIER', 'IN_PROGRESS', 'NOT_STARTED'].includes(item.status)
  );
  if (awaitingVerifier) {
    const anyStarted = checks.some((item) => item.status !== 'NOT_STARTED');
    return anyStarted ? 'AWAITING_VERIFIER' : 'IN_PROGRESS';
  }

  return currentStatus === 'NOT_STARTED' ? 'NOT_STARTED' : 'IN_PROGRESS';
};

const refreshCaseCounters = async ({ companyId, caseRecord, actorId }) => {
  const checks = await BackgroundVerificationCheck.find({
    companyId,
    case: caseRecord._id,
  })
    .sort({ displayOrder: 1 })
    .lean();

  const readiness = evaluateBgvCaseReadiness(checks);
  const nextStatus = deriveCaseStatus({
    currentStatus: caseRecord.status,
    checks,
    consent: caseRecord.consent,
  });

  const updates = {
    requiredCheckCount: readiness.requiredCount,
    verifiedRequiredCount: readiness.verifiedRequiredCount,
    discrepancyCount: readiness.discrepancyCount,
    updatedBy: actorId || caseRecord.updatedBy,
  };

  if (nextStatus !== caseRecord.status && !['COMPLETED', 'CANCELLED'].includes(caseRecord.status)) {
    updates.status = nextStatus;
  }

  const updated = await BackgroundVerificationCase.findOneAndUpdate(
    { _id: caseRecord._id, companyId },
    { $set: updates },
    { returnDocument: 'after' }
  );

  if (
    updates.status === 'REVIEW_REQUIRED' &&
    caseRecord.status !== 'REVIEW_REQUIRED'
  ) {
    await recordHistory({
      companyId,
      caseRecord: updated,
      action: 'BGV_REVIEW_REQUIRED',
      previousStatus: caseRecord.status,
      newStatus: 'REVIEW_REQUIRED',
      actorId,
      metadata: { readiness },
    });
    await notifyRoles(companyId, ['COMPANY_ADMIN', 'HR_MANAGER'], {
      type: 'RECRUITMENT',
      title: 'BGV review required',
      message: `${updated.caseCode} is ready for human review.`,
      link: `/app/recruitment/background-verification/${updated._id}`,
    }).catch(() => {});
  }

  return { caseRecord: updated, checks, readiness };
};

export const ensureDefaultBgvConfiguration = async ({ companyId, actorId }) => {
  let settings = await BackgroundVerificationSettings.findOne({ companyId });
  if (!settings) {
    settings = await BackgroundVerificationSettings.create({
      companyId,
      enabled: true,
      triggerStage: 'PRE_JOINING',
      provider: 'INTERNAL',
      consentRequired: true,
      bgvRequiredBeforeConversion: false,
      bgvRequiredBeforeJoining: false,
      updatedBy: actorId || null,
    });
  }

  const existing = await BackgroundVerificationCheckType.countDocuments({ companyId });
  if (existing === 0 && actorId) {
    await BackgroundVerificationCheckType.insertMany(
      DEFAULT_CHECK_TYPES.map((item) => ({
        companyId,
        ...item,
        description: item.instructions,
        active: true,
        createdBy: actorId,
        updatedBy: actorId,
      })),
      { ordered: false }
    ).catch(() => {});
  }

  return settings;
};

export const getBgvSettings = async ({ companyId, actorId }) => {
  const settings = await ensureDefaultBgvConfiguration({ companyId, actorId });
  return {
    id: settings._id,
    enabled: settings.enabled,
    triggerStage: settings.triggerStage,
    provider: settings.provider,
    consentRequired: settings.consentRequired,
    bgvRequiredBeforeConversion: settings.bgvRequiredBeforeConversion,
    bgvRequiredBeforeJoining: settings.bgvRequiredBeforeJoining,
    updatedAt: settings.updatedAt,
  };
};

export const updateBgvSettings = async ({ companyId, actorId, payload = {} }) => {
  await ensureDefaultBgvConfiguration({ companyId, actorId });
  const updates = { updatedBy: actorId };
  [
    'enabled',
    'consentRequired',
    'bgvRequiredBeforeConversion',
    'bgvRequiredBeforeJoining',
  ].forEach((field) => {
    if (payload[field] !== undefined) updates[field] = Boolean(payload[field]);
  });
  if (payload.triggerStage !== undefined) {
    updates.triggerStage = String(payload.triggerStage).toUpperCase();
  }

  const settings = await BackgroundVerificationSettings.findOneAndUpdate(
    { companyId },
    { $set: updates },
    { returnDocument: 'after', runValidators: true }
  );

  await recordAudit({
    req: null,
    action: 'BGV_SETTINGS_UPDATED',
    companyId,
    actorId,
    resource: 'BackgroundVerificationSettings',
    resourceId: settings._id,
    newValue: {
      enabled: settings.enabled,
      triggerStage: settings.triggerStage,
      bgvRequiredBeforeConversion: settings.bgvRequiredBeforeConversion,
    },
    critical: true,
  });

  return getBgvSettings({ companyId, actorId });
};

export const listBgvCheckTypes = async ({ companyId, actorId }) => {
  await ensureDefaultBgvConfiguration({ companyId, actorId });
  const rows = await BackgroundVerificationCheckType.find({ companyId })
    .sort({ displayOrder: 1, name: 1 })
    .lean();
  return rows.map((row) => ({
    id: row._id,
    code: row.code,
    name: row.name,
    description: row.description,
    category: row.category,
    required: row.required,
    active: row.active,
    displayOrder: row.displayOrder,
    instructions: row.instructions,
  }));
};

export const createBgvCheckType = async ({ companyId, actorId, payload }) => {
  const code = String(payload.code || payload.name || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 40);
  if (!code || !String(payload.name || '').trim()) {
    throw ApiError.badRequest('Check type name is required');
  }
  try {
    const created = await BackgroundVerificationCheckType.create({
      companyId,
      code,
      name: clean(payload.name, 120),
      description: clean(payload.description, 1000),
      category: payload.category || 'OTHER',
      required: payload.required !== false,
      active: payload.active !== false,
      displayOrder: Number(payload.displayOrder) || 100,
      instructions: clean(payload.instructions, 2000),
      createdBy: actorId,
      updatedBy: actorId,
    });
    return (await listBgvCheckTypes({ companyId, actorId })).find(
      (item) => String(item.id) === String(created._id)
    );
  } catch (error) {
    if (error.code === 11000) {
      throw ApiError.conflict('A check type with this code already exists');
    }
    throw error;
  }
};

export const updateBgvCheckType = async ({
  companyId,
  actorId,
  checkTypeId,
  payload = {},
}) => {
  if (!isObjectId(checkTypeId)) throw ApiError.notFound('Check type not found');
  const updates = { updatedBy: actorId };
  if (payload.name !== undefined) updates.name = clean(payload.name, 120);
  if (payload.description !== undefined) {
    updates.description = clean(payload.description, 1000);
  }
  if (payload.category !== undefined) updates.category = payload.category;
  if (payload.required !== undefined) updates.required = Boolean(payload.required);
  if (payload.active !== undefined) updates.active = Boolean(payload.active);
  if (payload.displayOrder !== undefined) {
    updates.displayOrder = Number(payload.displayOrder) || 100;
  }
  if (payload.instructions !== undefined) {
    updates.instructions = clean(payload.instructions, 2000);
  }

  const updated = await BackgroundVerificationCheckType.findOneAndUpdate(
    { _id: checkTypeId, companyId },
    { $set: updates },
    { returnDocument: 'after', runValidators: true }
  ).lean();
  if (!updated) throw ApiError.notFound('Check type not found');
  return (await listBgvCheckTypes({ companyId, actorId })).find(
    (item) => String(item.id) === String(updated._id)
  );
};

const resolveCandidate = async ({ companyId, candidateRef }) => {
  const filter = isObjectId(candidateRef)
    ? { _id: candidateRef, companyId }
    : {
        companyId,
        candidateCode: String(candidateRef || '').trim().toUpperCase(),
      };
  const candidate = await Candidate.findOne(filter).lean();
  if (!candidate) throw ApiError.notFound('Candidate not found');
  return candidate;
};

export const startBackgroundVerification = async ({
  companyId,
  candidateRef,
  actorId,
  requestContext = null,
}) => {
  if (!isObjectId(actorId)) throw ApiError.badRequest('A valid actor is required');

  const settings = await ensureDefaultBgvConfiguration({ companyId, actorId });
  if (!settings.enabled) {
    throw ApiError.conflict('Background verification is disabled for this company');
  }

  const candidate = await resolveCandidate({ companyId, candidateRef });

  const existing = await BackgroundVerificationCase.findOne({
    companyId,
    candidate: candidate._id,
    activeKey: 'ACTIVE',
  }).select('+activeKey');

  if (existing) {
    const refreshed = await refreshCaseCounters({
      companyId,
      caseRecord: existing,
      actorId,
    });
    return {
      ...caseDto(refreshed.caseRecord, refreshed.checks),
      idempotent: true,
    };
  }

  const offer = await OfferLetter.findOne({
    companyId,
    candidate: candidate._id,
    status: 'ACCEPTED',
  })
    .sort({ acceptedAt: -1, createdAt: -1 })
    .lean();

  const preOnboarding = await PreOnboarding.findOne({
    companyId,
    candidate: candidate._id,
    activeKey: 'ACTIVE',
  })
    .select('+activeKey')
    .lean();

  // Eligibility soft rules by trigger stage.
  if (settings.triggerStage === 'PRE_JOINING') {
    if (!offer) {
      throw ApiError.conflict('PRE_JOINING BGV requires an accepted offer');
    }
  }
  if (settings.triggerStage === 'POST_OFFER' && !offer) {
    throw ApiError.conflict('POST_OFFER BGV requires an accepted offer');
  }

  const checkTypes = await BackgroundVerificationCheckType.find({
    companyId,
    active: true,
  })
    .sort({ displayOrder: 1, name: 1 })
    .lean();

  if (!checkTypes.length) {
    throw ApiError.badRequest('Configure at least one active BGV check type first');
  }

  let caseRecord;
  try {
    caseRecord = await BackgroundVerificationCase.create({
      companyId,
      caseCode: await nextBgvCaseCode(companyId),
      candidate: candidate._id,
      job: candidate.job,
      offer: offer?._id || null,
      preOnboarding: preOnboarding?._id || null,
      status: 'IN_PROGRESS',
      triggerStage: settings.triggerStage,
      provider: 'INTERNAL',
      candidateSnapshot: {
        name: candidate.name,
        email: candidate.email,
        candidateCode: candidate.candidateCode || '',
        phone: candidate.phone || '',
      },
      jobSnapshot: {
        title: offer?.jobSnapshot?.title || '',
        jobCode: offer?.jobSnapshot?.jobCode || '',
      },
      consent: {
        required: Boolean(settings.consentRequired),
        status: settings.consentRequired ? 'REQUESTED' : 'NOT_REQUESTED',
        requestedAt: settings.consentRequired ? new Date() : null,
        respondedAt: null,
        note: '',
      },
      requiredCheckCount: checkTypes.filter((item) => item.required).length,
      verifiedRequiredCount: 0,
      discrepancyCount: 0,
      startedBy: actorId,
      startedAt: new Date(),
      updatedBy: actorId,
    });
  } catch (error) {
    if (error.code === 11000) {
      const raced = await BackgroundVerificationCase.findOne({
        companyId,
        candidate: candidate._id,
        activeKey: 'ACTIVE',
      }).select('+activeKey');
      if (raced) {
        const refreshed = await refreshCaseCounters({
          companyId,
          caseRecord: raced,
          actorId,
        });
        return {
          ...caseDto(refreshed.caseRecord, refreshed.checks),
          idempotent: true,
        };
      }
    }
    throw error;
  }

  await BackgroundVerificationCheck.insertMany(
    checkTypes.map((item) => ({
      companyId,
      case: caseRecord._id,
      candidate: candidate._id,
      checkType: item._id,
      code: item.code,
      nameSnapshot: item.name,
      descriptionSnapshot: item.description || '',
      categorySnapshot: item.category,
      instructionsSnapshot: item.instructions || '',
      required: item.required,
      displayOrder: item.displayOrder,
      status: 'NOT_STARTED',
      claimedInformation: claimFromCandidate(candidate, item.category),
      source: 'INTERNAL',
      provider: 'INTERNAL',
    }))
  );

  const checks = await BackgroundVerificationCheck.find({
    companyId,
    case: caseRecord._id,
  }).lean();

  await dispatchBgvJob('BGV_START', {
    provider: 'INTERNAL',
    caseRecord,
    checks,
  });

  await recordHistory({
    companyId,
    caseRecord,
    action: 'BGV_CASE_CREATED',
    previousStatus: 'NOT_STARTED',
    newStatus: 'IN_PROGRESS',
    actorId,
    metadata: {
      checkCount: checks.length,
      triggerStage: settings.triggerStage,
    },
  });
  await recordHistory({
    companyId,
    caseRecord,
    action: 'BGV_STARTED',
    previousStatus: 'NOT_STARTED',
    newStatus: 'IN_PROGRESS',
    actorId,
  });

  if (settings.consentRequired) {
    await recordHistory({
      companyId,
      caseRecord,
      action: 'BGV_CONSENT_REQUESTED',
      previousStatus: 'NOT_REQUESTED',
      newStatus: 'REQUESTED',
      actorId,
    });
  }

  await timeline({
    companyId,
    candidate: candidate._id,
    job: candidate.job,
    action: 'BGV_STARTED',
    actorId,
    metadata: {
      caseCode: caseRecord.caseCode,
      checkCount: checks.length,
    },
  });

  await recordAudit({
    req: requestContext,
    action: 'BGV_CASE_CREATED',
    companyId,
    actorId,
    resource: 'BackgroundVerificationCase',
    resourceId: caseRecord._id,
    newValue: { status: 'IN_PROGRESS', caseCode: caseRecord.caseCode },
    metadata: {
      candidateId: candidate._id,
      triggerStage: settings.triggerStage,
      checkCount: checks.length,
    },
    critical: true,
  });

  await notifyRoles(companyId, ['COMPANY_ADMIN', 'HR_MANAGER'], {
    type: 'RECRUITMENT',
    title: 'Background verification started',
    message: `${caseRecord.caseCode} started for ${candidate.name}.`,
    link: `/app/recruitment/background-verification/${caseRecord._id}`,
  }).catch(() => {});

  const refreshed = await refreshCaseCounters({
    companyId,
    caseRecord,
    actorId,
  });

  return {
    ...caseDto(refreshed.caseRecord, refreshed.checks),
    idempotent: false,
  };
};

export const listBackgroundVerifications = async ({ companyId, query = {} }) => {
  const filter = { companyId };
  if (query.status) filter.status = String(query.status).toUpperCase();
  if (query.jobId && isObjectId(query.jobId)) filter.job = query.jobId;
  if (query.verifierId && isObjectId(query.verifierId)) {
    filter.assignedVerifier = query.verifierId;
  }
  if (query.search) {
    const term = String(query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { caseCode: new RegExp(term, 'i') },
      { 'candidateSnapshot.name': new RegExp(term, 'i') },
      { 'candidateSnapshot.candidateCode': new RegExp(term, 'i') },
      { 'jobSnapshot.title': new RegExp(term, 'i') },
    ];
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const skip = (page - 1) * limit;

  const [rows, total, kpiRows] = await Promise.all([
    BackgroundVerificationCase.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('assignedVerifier', 'name role')
      .lean(),
    BackgroundVerificationCase.countDocuments(filter),
    BackgroundVerificationCase.aggregate([
      { $match: { companyId: new mongoose.Types.ObjectId(String(companyId)) } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  const kpis = Object.fromEntries(kpiRows.map((row) => [row._id, row.count]));
  const discrepancyCases = await BackgroundVerificationCase.countDocuments({
    companyId,
    discrepancyCount: { $gt: 0 },
    status: { $ne: 'CANCELLED' },
  });

  return {
    cases: rows.map((row) => ({
      id: row._id,
      caseCode: row.caseCode,
      status: row.status,
      triggerStage: row.triggerStage,
      candidateName: row.candidateSnapshot?.name || '',
      candidateCode: row.candidateSnapshot?.candidateCode || '',
      jobTitle: row.jobSnapshot?.title || '',
      requiredCheckCount: row.requiredCheckCount,
      verifiedRequiredCount: row.verifiedRequiredCount,
      discrepancyCount: row.discrepancyCount,
      overallOutcome: row.overallOutcome || '',
      assignedVerifierName: row.assignedVerifier?.name || '',
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      updatedAt: row.updatedAt,
    })),
    meta: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      kpis: {
        notStarted: kpis.NOT_STARTED || 0,
        inProgress: kpis.IN_PROGRESS || 0,
        awaitingCandidate: kpis.AWAITING_CANDIDATE || 0,
        awaitingVerifier: kpis.AWAITING_VERIFIER || 0,
        reviewRequired: kpis.REVIEW_REQUIRED || 0,
        completed: kpis.COMPLETED || 0,
        cancelled: kpis.CANCELLED || 0,
        discrepancies: discrepancyCases,
      },
    },
  };
};

export const getBackgroundVerification = async ({ companyId, caseId }) => {
  if (!isObjectId(caseId)) throw ApiError.notFound('BGV case not found');
  const caseRecord = await BackgroundVerificationCase.findOne({
    _id: caseId,
    companyId,
  })
    .populate('assignedVerifier', 'name role email')
    .populate('reviewedBy', 'name role')
    .lean();
  if (!caseRecord) throw ApiError.notFound('BGV case not found');

  const [checks, history] = await Promise.all([
    BackgroundVerificationCheck.find({ companyId, case: caseRecord._id })
      .sort({ displayOrder: 1 })
      .lean(),
    BackgroundVerificationHistory.find({ companyId, case: caseRecord._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean(),
  ]);

  const readiness = evaluateBgvCaseReadiness(checks);

  return {
    case: caseDto(caseRecord, checks, { includeInternal: true }),
    readiness,
    history: history.map((item) => ({
      id: item._id,
      action: item.action,
      previousStatus: item.previousStatus,
      newStatus: item.newStatus,
      reason: item.reason,
      actorType: item.actorType,
      metadata: item.metadata,
      createdAt: item.createdAt,
    })),
  };
};

const loadCaseOrThrow = async ({ companyId, caseId }) => {
  if (!isObjectId(caseId)) throw ApiError.notFound('BGV case not found');
  const caseRecord = await BackgroundVerificationCase.findOne({
    _id: caseId,
    companyId,
  });
  if (!caseRecord) throw ApiError.notFound('BGV case not found');
  return caseRecord;
};

export const assignBgvVerifier = async ({
  companyId,
  caseId,
  actorId,
  verifierId,
  requestContext = null,
}) => {
  const caseRecord = await loadCaseOrThrow({ companyId, caseId });
  if (['COMPLETED', 'CANCELLED'].includes(caseRecord.status)) {
    throw ApiError.conflict('Completed or cancelled cases cannot be reassigned');
  }
  if (!isObjectId(verifierId)) throw ApiError.badRequest('Choose a valid verifier');

  const verifier = await User.findOne({
    _id: verifierId,
    companyId,
    status: 'ACTIVE',
    role: { $in: ['COMPANY_ADMIN', 'HR_MANAGER'] },
  })
    .select('_id name role')
    .lean();
  if (!verifier) {
    throw ApiError.badRequest('Verifier must be an active HR user in your company');
  }

  caseRecord.assignedVerifier = verifier._id;
  caseRecord.updatedBy = actorId;
  await caseRecord.save();

  await recordHistory({
    companyId,
    caseRecord,
    action: 'BGV_ASSIGNED',
    previousStatus: caseRecord.status,
    newStatus: caseRecord.status,
    actorId,
    metadata: { verifierId: verifier._id, verifierName: verifier.name },
  });

  await recordAudit({
    req: requestContext,
    action: 'BGV_ASSIGNED',
    companyId,
    actorId,
    resource: 'BackgroundVerificationCase',
    resourceId: caseRecord._id,
    metadata: { verifierId: verifier._id },
    critical: true,
  });

  return getBackgroundVerification({ companyId, caseId });
};

export const updateBgvCheck = async ({
  companyId,
  caseId,
  checkId,
  actorId,
  payload = {},
  requestContext = null,
}) => {
  const caseRecord = await loadCaseOrThrow({ companyId, caseId });
  if (['COMPLETED', 'CANCELLED'].includes(caseRecord.status)) {
    throw ApiError.conflict('Checks cannot be updated on a closed BGV case');
  }
  if (!isObjectId(checkId)) throw ApiError.notFound('BGV check not found');

  const check = await BackgroundVerificationCheck.findOne({
    _id: checkId,
    companyId,
    case: caseRecord._id,
  });
  if (!check) throw ApiError.notFound('BGV check not found');

  const action = String(payload.action || '').toUpperCase();
  const previousStatus = check.status;
  const now = new Date();
  let historyAction = 'BGV_CHECK_STARTED';
  let timelineAction = null;

  if (action === 'START') {
    if (!['NOT_STARTED', 'AWAITING_CANDIDATE'].includes(check.status)) {
      throw ApiError.conflict('Only pending checks can be started');
    }
    check.status = 'IN_PROGRESS';
    check.requestedAt = check.requestedAt || now;
    historyAction = 'BGV_CHECK_STARTED';
  } else if (action === 'REQUEST_INFORMATION') {
    check.status = 'AWAITING_CANDIDATE';
    check.requestedAt = now;
    check.candidateComment = '';
    if (payload.hrComment !== undefined) {
      check.hrComment = clean(payload.hrComment, 2000);
    }
    historyAction = 'BGV_INFORMATION_REQUESTED';
    timelineAction = 'BGV_INFORMATION_REQUESTED';
  } else if (action === 'MARK_VERIFIED') {
    check.status = 'VERIFIED';
    check.verifiedInformation = clean(
      payload.verifiedInformation || check.claimedInformation,
      4000
    );
    check.resultSummary = clean(payload.resultSummary || 'Verified against available evidence', 2000);
    check.discrepancy = '';
    check.hrComment = clean(payload.hrComment, 2000);
    check.verifiedBy = actorId;
    check.verifiedAt = now;
    check.completedAt = now;
    historyAction = 'BGV_CHECK_VERIFIED';
  } else if (action === 'RECORD_DISCREPANCY') {
    const discrepancy = clean(payload.discrepancy, 2000);
    if (!discrepancy) {
      throw ApiError.badRequest('A discrepancy explanation is required');
    }
    check.status = 'DISCREPANCY';
    check.verifiedInformation = clean(payload.verifiedInformation, 4000);
    check.resultSummary = clean(payload.resultSummary || 'Discrepancy recorded', 2000);
    check.discrepancy = discrepancy;
    check.hrComment = clean(payload.hrComment, 2000);
    check.verifiedBy = actorId;
    check.verifiedAt = now;
    check.completedAt = now;
    historyAction = 'BGV_DISCREPANCY_RECORDED';
  } else if (action === 'UNABLE_TO_VERIFY') {
    check.status = 'UNABLE_TO_VERIFY';
    check.resultSummary = clean(
      payload.resultSummary || 'Unable to verify with available evidence',
      2000
    );
    check.hrComment = clean(payload.hrComment, 2000);
    check.verifiedBy = actorId;
    check.verifiedAt = now;
    check.completedAt = now;
    historyAction = 'BGV_CHECK_UNABLE_TO_VERIFY';
  } else {
    throw ApiError.badRequest('Unsupported BGV check action');
  }

  if (payload.claimedInformation !== undefined && action === 'START') {
    check.claimedInformation = clean(payload.claimedInformation, 4000);
  }

  await check.save();

  await recordHistory({
    companyId,
    caseRecord,
    check,
    action: historyAction,
    previousStatus,
    newStatus: check.status,
    actorId,
    reason: check.discrepancy || check.resultSummary || '',
    metadata: {
      checkCode: check.code,
      required: check.required,
    },
  });

  if (timelineAction) {
    await timeline({
      companyId,
      candidate: caseRecord.candidate,
      job: caseRecord.job,
      action: timelineAction,
      actorId,
      metadata: {
        caseCode: caseRecord.caseCode,
        checkCode: check.code,
      },
    });
  }

  await recordAudit({
    req: requestContext,
    action: historyAction,
    companyId,
    actorId,
    resource: 'BackgroundVerificationCheck',
    resourceId: check._id,
    previousValue: { status: previousStatus },
    newValue: { status: check.status },
    metadata: {
      caseCode: caseRecord.caseCode,
      checkCode: check.code,
    },
    critical: true,
  });

  // Never auto-reject candidate on discrepancy.
  await refreshCaseCounters({ companyId, caseRecord, actorId });
  return getBackgroundVerification({ companyId, caseId });
};

export const completeBackgroundVerification = async ({
  companyId,
  caseId,
  actorId,
  payload = {},
  requestContext = null,
}) => {
  const caseRecord = await loadCaseOrThrow({ companyId, caseId });
  if (caseRecord.status === 'COMPLETED') {
    return {
      ...(await getBackgroundVerification({ companyId, caseId })),
      idempotent: true,
    };
  }
  if (caseRecord.status === 'CANCELLED') {
    throw ApiError.conflict('A cancelled BGV case cannot be completed');
  }

  const checks = await BackgroundVerificationCheck.find({
    companyId,
    case: caseRecord._id,
  }).lean();
  const readiness = evaluateBgvCaseReadiness(checks);
  if (!readiness.reviewable) {
    throw ApiError.conflict(
      'All required checks must reach a terminal verification state before completion'
    );
  }

  if (caseRecord.consent?.required && caseRecord.consent.status === 'DECLINED') {
    throw ApiError.conflict('Candidate declined BGV consent; cancel or obtain consent first');
  }

  const outcome = String(payload.overallOutcome || '').toUpperCase();
  if (!['CLEAR', 'CLEAR_WITH_DISCREPANCIES', 'HOLD'].includes(outcome)) {
    throw ApiError.badRequest(
      'Choose overall outcome: CLEAR, CLEAR_WITH_DISCREPANCIES, or HOLD'
    );
  }
  if (outcome === 'CLEAR' && readiness.discrepancyCount > 0) {
    throw ApiError.badRequest(
      'Use CLEAR_WITH_DISCREPANCIES when one or more checks have discrepancies'
    );
  }

  const previousStatus = caseRecord.status;
  const now = new Date();
  caseRecord.status = 'COMPLETED';
  caseRecord.overallOutcome = outcome;
  caseRecord.reviewedBy = actorId;
  caseRecord.reviewedAt = now;
  caseRecord.completedAt = now;
  caseRecord.reviewComment = clean(payload.reviewComment, 2000);
  caseRecord.requiredCheckCount = readiness.requiredCount;
  caseRecord.verifiedRequiredCount = readiness.verifiedRequiredCount;
  caseRecord.discrepancyCount = readiness.discrepancyCount;
  caseRecord.updatedBy = actorId;
  await caseRecord.save();

  await recordHistory({
    companyId,
    caseRecord,
    action: 'BGV_COMPLETED',
    previousStatus,
    newStatus: 'COMPLETED',
    actorId,
    reason: caseRecord.reviewComment,
    metadata: { overallOutcome: outcome, readiness },
  });

  await timeline({
    companyId,
    candidate: caseRecord.candidate,
    job: caseRecord.job,
    action: 'BGV_COMPLETED',
    actorId,
    metadata: {
      caseCode: caseRecord.caseCode,
      overallOutcome: outcome,
      discrepancyCount: readiness.discrepancyCount,
    },
  });

  await recordAudit({
    req: requestContext,
    action: 'BGV_COMPLETED',
    companyId,
    actorId,
    resource: 'BackgroundVerificationCase',
    resourceId: caseRecord._id,
    previousValue: { status: previousStatus },
    newValue: { status: 'COMPLETED', overallOutcome: outcome },
    metadata: { caseCode: caseRecord.caseCode },
    critical: true,
  });

  await notifyRoles(companyId, ['COMPANY_ADMIN', 'HR_MANAGER'], {
    type: 'RECRUITMENT',
    title: 'Background verification completed',
    message: `${caseRecord.caseCode} completed with outcome ${outcome}.`,
    link: `/app/recruitment/background-verification/${caseRecord._id}`,
  }).catch(() => {});

  return {
    ...(await getBackgroundVerification({ companyId, caseId })),
    idempotent: false,
  };
};

export const cancelBackgroundVerification = async ({
  companyId,
  caseId,
  actorId,
  reason = '',
  requestContext = null,
}) => {
  const caseRecord = await loadCaseOrThrow({ companyId, caseId });
  if (caseRecord.status === 'CANCELLED') {
    return {
      ...(await getBackgroundVerification({ companyId, caseId })),
      idempotent: true,
    };
  }
  if (caseRecord.status === 'COMPLETED') {
    throw ApiError.conflict('Completed BGV cases cannot be cancelled');
  }

  const cancellationReason = clean(reason, 1000);
  if (!cancellationReason) {
    throw ApiError.badRequest('A cancellation reason is required');
  }

  const previousStatus = caseRecord.status;
  caseRecord.status = 'CANCELLED';
  caseRecord.overallOutcome = 'CANCELLED';
  caseRecord.cancelledAt = new Date();
  caseRecord.cancellationReason = cancellationReason;
  caseRecord.updatedBy = actorId;
  await caseRecord.save();

  await recordHistory({
    companyId,
    caseRecord,
    action: 'BGV_CANCELLED',
    previousStatus,
    newStatus: 'CANCELLED',
    actorId,
    reason: cancellationReason,
  });

  await recordAudit({
    req: requestContext,
    action: 'BGV_CANCELLED',
    companyId,
    actorId,
    resource: 'BackgroundVerificationCase',
    resourceId: caseRecord._id,
    previousValue: { status: previousStatus },
    newValue: { status: 'CANCELLED' },
    metadata: { caseCode: caseRecord.caseCode, reason: cancellationReason },
    critical: true,
  });

  return {
    ...(await getBackgroundVerification({ companyId, caseId })),
    idempotent: false,
  };
};

/**
 * Conversion/joining eligibility hook for Phase 27.13.
 * Returns { required, satisfied, blockingReasons, caseSummary }
 */
export const evaluateBgvForConversion = async ({ companyId, candidateId }) => {
  const settings = await BackgroundVerificationSettings.findOne({ companyId }).lean();
  if (!settings?.enabled || !settings.bgvRequiredBeforeConversion) {
    return {
      required: false,
      satisfied: true,
      blockingReasons: [],
      caseSummary: null,
    };
  }

  const caseRecord = await BackgroundVerificationCase.findOne({
    companyId,
    candidate: candidateId,
    activeKey: 'ACTIVE',
  })
    .select('+activeKey')
    .lean();

  if (!caseRecord) {
    return {
      required: true,
      satisfied: false,
      blockingReasons: ['Background verification is required before conversion'],
      caseSummary: null,
    };
  }

  if (caseRecord.status !== 'COMPLETED') {
    return {
      required: true,
      satisfied: false,
      blockingReasons: [
        `Background verification case ${caseRecord.caseCode} is ${caseRecord.status}`,
      ],
      caseSummary: {
        id: caseRecord._id,
        caseCode: caseRecord.caseCode,
        status: caseRecord.status,
        overallOutcome: caseRecord.overallOutcome || '',
      },
    };
  }

  if (!['CLEAR', 'CLEAR_WITH_DISCREPANCIES'].includes(caseRecord.overallOutcome)) {
    return {
      required: true,
      satisfied: false,
      blockingReasons: [
        `Background verification outcome ${caseRecord.overallOutcome || 'unknown'} blocks conversion`,
      ],
      caseSummary: {
        id: caseRecord._id,
        caseCode: caseRecord.caseCode,
        status: caseRecord.status,
        overallOutcome: caseRecord.overallOutcome || '',
      },
    };
  }

  return {
    required: true,
    satisfied: true,
    blockingReasons: [],
    caseSummary: {
      id: caseRecord._id,
      caseCode: caseRecord.caseCode,
      status: caseRecord.status,
      overallOutcome: caseRecord.overallOutcome,
    },
  };
};

export const getCandidateBgvSummary = async ({ companyId, candidateRef }) => {
  const candidate = await resolveCandidate({ companyId, candidateRef });
  const caseRecord = await BackgroundVerificationCase.findOne({
    companyId,
    candidate: candidate._id,
    activeKey: 'ACTIVE',
  })
    .select('+activeKey')
    .lean();

  if (!caseRecord) {
    return { hasCase: false, case: null };
  }

  return {
    hasCase: true,
    case: {
      id: caseRecord._id,
      caseCode: caseRecord.caseCode,
      status: caseRecord.status,
      overallOutcome: caseRecord.overallOutcome || '',
      requiredCheckCount: caseRecord.requiredCheckCount,
      verifiedRequiredCount: caseRecord.verifiedRequiredCount,
      discrepancyCount: caseRecord.discrepancyCount,
      completedAt: caseRecord.completedAt,
    },
  };
};
