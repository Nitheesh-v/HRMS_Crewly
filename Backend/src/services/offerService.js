import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Candidate from '../models/Candidate.js';
import CandidateHistory from '../models/CandidateHistory.js';
import Company from '../models/Company.js';
import JobPosting from '../models/JobPosting.js';
import JobRequisition from '../models/JobRequisition.js';
import OfferHistory from '../models/OfferHistory.js';
import OfferLetter, { ACTIVE_OFFER_STATUSES } from '../models/OfferLetter.js';
import OfferTemplate from '../models/OfferTemplate.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import env from '../config/env.js';
import logger from '../config/logger.js';
import { nextOfferCode } from '../utils/offerIdentifiers.js';
import {
  buildOfferTemplateValues,
  renderOfferTemplate,
} from '../utils/offerTemplateRenderer.js';
import { generateOfferPdf } from '../utils/offerPdfService.js';
import { randomToken, hashToken } from '../utils/securityPolicy.js';
import { recordAudit } from '../utils/securityauditService.js';
import { bumpRecruitmentAnalyticsGeneration } from './analyticsCacheInvalidation.js';
import {
  offerCandidateAccessEmail,
  sendMail,
} from '../utils/mailer.js';
import { JOB_NAMES } from '../config/queueConfig.js';
import {
  requestEmailDelivery,
  buildEventKey,
} from './emailDeliveryService.js';
import { transitionCandidateStage } from './candidatePipelineService.js';
import { scheduleOfferJobs, cancelOfferJobs } from './scheduledJobScheduler.js';
import {
  deleteStoredOfferDocument,
  getStoredOfferDocument,
  storeOfferDocument,
} from './offerDocumentStorageService.js';
import {
  issueOfferToken,
  restoreOfferTokensRevokedFor,
  revokeOfferTokens,
} from './offerTokenService.js';
import {
  notifyOfferOwner,
  notifyOfferSubmitted,
} from './offerNotificationService.js';

const FINAL_REPLACEMENT_STATUSES = ['REJECTED', 'EXPIRED', 'WITHDRAWN'];
const OFFER_TOKEN_MAX_DAYS = Math.min(
  365,
  Math.max(1, Number(process.env.OFFER_TOKEN_MAX_DAYS) || 90)
);
const statusConflict = () =>
  ApiError.conflict('Offer changed in another request. Refresh and try again.');

const cleanString = (value, maximum = 1000) =>
  String(value || '').trim().slice(0, maximum);

const endOfUtcDay = (value) => {
  if (!value) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCHours(23, 59, 59, 999);
  return date;
};

const addressSnapshot = (address = {}) =>
  [address.line, address.city, address.state, address.pincode]
    .map((item) => cleanString(item, 160))
    .filter(Boolean)
    .join(', ');

const offerHistory = async ({ offer, action, fromStatus = '', toStatus = '', actor, reason = '', metadata = {} }) =>
  OfferHistory.create({
    companyId: offer.companyId,
    offer: offer._id,
    candidate: offer.candidate,
    job: offer.job,
    action,
    fromStatus,
    toStatus,
    actorType: actor?.type || 'TENANT_USER',
    actor: actor?.id || null,
    actorNameSnapshot: cleanString(actor?.name, 160),
    reason: cleanString(reason, 1000),
    metadata,
    eventAt: new Date(),
  });

export const recordOfferHistory = offerHistory;

export const recordCandidateOfferEvent = async ({ offer, action, actorType, actorId = null, metadata = {} }) =>
  CandidateHistory.create({
    companyId: offer.companyId,
    candidate: offer.candidate,
    job: offer.job,
    action,
    source: 'OFFER',
    actorType,
    actor: actorId,
    metadata: { offerId: offer._id, offerCode: offer.offerCode, ...metadata },
    eventAt: new Date(),
  });

const secureMaterialOfferEvent = async ({
  offer,
  action,
  fromStatus = '',
  toStatus = '',
  actor,
  reason = '',
  historyMetadata = {},
  candidateAction = action,
  candidateMetadata = {},
}) => {
  const candidateEvent = await recordCandidateOfferEvent({
    offer,
    action: candidateAction,
    actorType: actor?.type === 'SYSTEM' ? 'SYSTEM' : 'TENANT_USER',
    actorId: actor?.id || null,
    metadata: candidateMetadata,
  });

  try {
    return await offerHistory({
      offer,
      action,
      fromStatus,
      toStatus,
      actor,
      reason,
      metadata: historyMetadata,
    });
  } catch (error) {
    await CandidateHistory.deleteOne({
      _id: candidateEvent._id,
      companyId: offer.companyId,
      candidate: offer.candidate,
    }).catch(() => {});
    throw error;
  }
};

const templateFor = async ({ companyId, templateId }) => {
  const template = await OfferTemplate.findOne({ _id: templateId, companyId, isActive: true }).lean();
  if (!template) throw ApiError.notFound('Active offer template not found');
  return template;
};

const reportingManagerFor = async ({ companyId, reportingManagerId }) => {
  if (!reportingManagerId) return null;
  const manager = await User.findOne({
    _id: reportingManagerId,
    companyId,
    status: 'ACTIVE',
  })
    .select('_id name')
    .lean();
  if (!manager) throw ApiError.notFound('Reporting manager not found');
  return manager;
};

const renderOffer = (offer) => {
  const rendered = renderOfferTemplate({
    content: offer.templateSnapshot.content,
    values: buildOfferTemplateValues(offer),
  });
  if (rendered.unknownVariables.length) {
    throw ApiError.badRequest('Offer template contains unsupported variables', rendered.unknownVariables);
  }
  offer.renderedContent = rendered.renderedContent;
  offer.unresolvedVariables = rendered.unresolvedVariables;
  return rendered;
};

const assertReady = (offer) => {
  const rendered = renderOffer(offer);
  if (!rendered.valid) {
    throw ApiError.badRequest('Resolve every offer template variable before continuing', [
      ...rendered.unknownVariables,
      ...rendered.unresolvedVariables,
    ]);
  }
  const offerDate = new Date(offer.terms.offerDate).getTime();
  const joiningDate = new Date(offer.terms.joiningDate).getTime();
  const expiryDate = new Date(offer.terms.expiryDate).getTime();
  if (![offerDate, joiningDate, expiryDate].every(Number.isFinite)) {
    throw ApiError.badRequest('Offer, joining, and expiry dates must be valid');
  }
  if (expiryDate <= Date.now() || expiryDate <= offerDate) {
    throw ApiError.badRequest('Offer expiry must be after the offer date and in the future');
  }
  if (joiningDate < offerDate) {
    throw ApiError.badRequest('Joining date cannot be before the offer date');
  }
  const maximumExpiry = new Date(offerDate);
  maximumExpiry.setUTCDate(maximumExpiry.getUTCDate() + OFFER_TOKEN_MAX_DAYS);
  maximumExpiry.setUTCHours(23, 59, 59, 999);
  if (expiryDate > maximumExpiry.getTime()) {
    throw ApiError.badRequest(
      `Offer expiry cannot exceed ${OFFER_TOKEN_MAX_DAYS} days from the offer date`
    );
  }
};

const documentDto = (document = {}) => ({
  checksum: document.checksum || '',
  fileName: document.fileName || '',
  mimeType: document.mimeType || '',
  size: document.size || 0,
  version: document.version || 0,
  generatedAt: document.generatedAt || null,
  available: Boolean(document.checksum),
});

export const safeOfferDto = (source) => {
  const offer = source?.toObject ? source.toObject() : source;
  if (!offer) return null;
  const { activeKey, ...safe } = offer;
  safe.document = documentDto(offer.document);
  safe.documentSnapshots = (offer.documentSnapshots || []).map((snapshot) => ({
    ...documentDto(snapshot),
    invalidatedAt: snapshot.invalidatedAt || null,
  }));
  if (safe.delivery) delete safe.delivery.sendClaimHash;
  return safe;
};

const buildOfferDraft = async ({ companyId, actorId, payload, existing = null }) => {
  const candidate = existing
    ? await Candidate.findOne({ _id: existing.candidate, companyId }).lean()
    : await Candidate.findOne({ _id: payload.candidateId, companyId }).lean();
  if (!candidate) throw ApiError.notFound('Candidate not found');

  const candidateStage = candidate.currentStage || candidate.stage;
  if (!['SELECTED', 'OFFER'].includes(candidateStage)) {
    throw ApiError.conflict('Offers can be drafted only after human selection');
  }

  const job = await JobPosting.findOne({ _id: candidate.job, companyId })
    .populate('department', 'name')
    .lean();
  if (!job) throw ApiError.notFound('Candidate job not found');

  const requisitionId = candidate.requisition || job.sourceRequisition || null;
  const requisition = requisitionId
    ? await JobRequisition.findOne({ _id: requisitionId, companyId })
        .select('_id requisitionNumber')
        .lean()
    : null;
  if (requisitionId && !requisition) throw ApiError.notFound('Candidate requisition not found');

  const company = await Company.findOne({ _id: companyId })
    .select('name address currency')
    .lean();
  if (!company) throw ApiError.notFound('Company not found');

  const templateId = payload.templateId || existing?.template;
  const template = await templateFor({ companyId, templateId });
  const managerId = payload.terms?.reportingManagerId ?? existing?.terms?.reportingManager;
  const manager = await reportingManagerFor({ companyId, reportingManagerId: managerId });
  const offerCode = existing?.offerCode || (await nextOfferCode(companyId));
  const terms = payload.terms || {};
  const compensation = payload.compensation || {};

  const draft = {
    companyId,
    offerCode,
    candidate: candidate._id,
    job: job._id,
    requisition: requisition?._id || null,
    template: template._id,
    templateSnapshot: {
      templateId: template._id,
      name: template.name,
      version: template.version,
      content: template.content,
      variables: template.variables,
    },
    candidateSnapshot: {
      name: candidate.name,
      email: candidate.email,
      candidateCode: candidate.candidateCode,
      phone: candidate.phone || '',
    },
    jobSnapshot: {
      title: job.title,
      jobCode: job.jobCode || '',
      departmentName: job.department?.name || '',
      requisitionCode: requisition?.requisitionNumber || '',
    },
    companySnapshot: {
      name: company.name,
      address: addressSnapshot(company.address),
    },
    terms: {
      designation: terms.designation ?? existing?.terms?.designation ?? job.title,
      departmentName: terms.departmentName ?? existing?.terms?.departmentName ?? job.department?.name ?? '',
      location: terms.location ?? existing?.terms?.location ?? job.location,
      employmentType: terms.employmentType ?? existing?.terms?.employmentType ?? job.employmentType,
      workMode: terms.workMode ?? existing?.terms?.workMode ?? job.workMode,
      reportingManager: manager?._id || null,
      reportingManagerName: manager?.name || '',
      joiningDate: terms.joiningDate ?? existing?.terms?.joiningDate,
      offerDate: terms.offerDate ?? existing?.terms?.offerDate ?? new Date(),
      expiryDate: endOfUtcDay(terms.expiryDate ?? existing?.terms?.expiryDate),
      probationMonths: terms.probationMonths ?? existing?.terms?.probationMonths ?? 0,
      noticePeriodDays: terms.noticePeriodDays ?? existing?.terms?.noticePeriodDays ?? 0,
      additionalTerms: terms.additionalTerms ?? existing?.terms?.additionalTerms ?? '',
    },
    compensationSnapshot: {
      currency: compensation.currency ?? existing?.compensationSnapshot?.currency ?? company.currency ?? 'INR',
      annualCTC: compensation.annualCTC ?? existing?.compensationSnapshot?.annualCTC,
      monthly: {
        basic: compensation.monthly?.basic ?? existing?.compensationSnapshot?.monthly?.basic ?? 0,
        hra: compensation.monthly?.hra ?? existing?.compensationSnapshot?.monthly?.hra ?? 0,
        allowances:
          compensation.monthly?.allowances ?? existing?.compensationSnapshot?.monthly?.allowances ?? 0,
      },
      variablePay: compensation.variablePay ?? existing?.compensationSnapshot?.variablePay ?? 0,
      bonus: compensation.bonus ?? existing?.compensationSnapshot?.bonus ?? 0,
    },
  };

  renderOffer(draft);
  return { draft, candidate, job, requisition };
};

export const createOffer = async ({ companyId, actor, payload }) => {
  let predecessor = null;
  if (payload.replacesOfferId) {
    predecessor = await OfferLetter.findOne({
      _id: payload.replacesOfferId,
      companyId,
      status: { $in: FINAL_REPLACEMENT_STATUSES },
    }).lean();
    if (!predecessor) throw ApiError.notFound('Replaceable predecessor offer not found');
  }

  const { draft } = await buildOfferDraft({ companyId, actorId: actor.id, payload });
  if (
    predecessor &&
    (String(predecessor.candidate) !== String(draft.candidate) ||
      String(predecessor.job) !== String(draft.job))
  ) {
    throw ApiError.badRequest('Replacement offer must belong to the same candidate and job');
  }

  let createdOffer = null;
  try {
    const offer = await OfferLetter.create({
      ...draft,
      revisionNumber: predecessor ? predecessor.revisionNumber + 1 : 1,
      replacesOffer: predecessor?._id || null,
      createdBy: actor.id,
      updatedBy: actor.id,
    });
    createdOffer = offer;

    if (predecessor) {
      const linked = await OfferLetter.updateOne(
        { _id: predecessor._id, companyId, replacedBy: null },
        { $set: { replacedBy: offer._id, updatedBy: actor.id } }
      );
      if (!linked.modifiedCount) {
        await OfferLetter.deleteOne({ _id: offer._id, companyId, status: 'DRAFT' });
        throw statusConflict();
      }
    }

    await secureMaterialOfferEvent({
      offer,
      action: 'OFFER_CREATED',
      toStatus: 'DRAFT',
      actor,
      historyMetadata: {
        revisionNumber: offer.revisionNumber,
        replacesOfferId: offer.replacesOffer || null,
      },
      candidateAction: 'OFFER_DRAFT_CREATED',
    });
    return safeOfferDto(offer);
  } catch (error) {
    if (createdOffer) {
      await OfferLetter.deleteOne({
        _id: createdOffer._id,
        companyId,
        status: 'DRAFT',
      }).catch(() => {});
      if (predecessor) {
        await OfferLetter.updateOne(
          { _id: predecessor._id, companyId, replacedBy: createdOffer._id },
          { $set: { replacedBy: null } }
        ).catch(() => {});
      }
    }
    if (error.code === 11000) throw ApiError.conflict('An active offer already exists for this candidate and job');
    throw error;
  }
};

export const expireOfferIfDue = async ({ offer: source, requestContext = null }) => {
  const offer = source?.toObject ? source.toObject() : source;
  if (
    !offer ||
    !['SENT', 'VIEWED'].includes(offer.status) ||
    new Date(offer.terms?.expiryDate).getTime() > Date.now()
  ) {
    return source;
  }

  const expiredAt = new Date();
  const updated = await OfferLetter.findOneAndUpdate(
    {
      _id: offer._id,
      companyId: offer.companyId,
      status: offer.status,
      'terms.expiryDate': { $lte: expiredAt },
    },
    {
      $set: {
        status: 'EXPIRED',
        activeKey: null,
        expiredAt,
      },
    },
    { new: true }
  );
  if (!updated) return source;

  let pipelineTransition = null;
  try {
    const candidate = await Candidate.findOne({
      _id: offer.candidate,
      companyId: offer.companyId,
    })
      .select('currentStage stage')
      .lean();
    if ((candidate?.currentStage || candidate?.stage) === 'OFFER') {
      pipelineTransition = await transitionCandidateStage({
        companyId: offer.companyId,
        candidateId: offer.candidate,
        targetStage: 'SELECTED',
        reason: `Offer ${offer.offerCode} expired`,
        actorId: offer.createdBy?._id || offer.createdBy,
        metadata: { source: 'PIPELINE', action: 'OFFER_EXPIRED', actorType: 'SYSTEM' },
        requestContext,
      });
    }

    await revokeOfferTokens({
      companyId: offer.companyId,
      offerId: offer._id,
      reason: 'OFFER_EXPIRED',
    });
    await secureMaterialOfferEvent({
      offer: updated,
      action: 'OFFER_EXPIRED',
      fromStatus: offer.status,
      toStatus: 'EXPIRED',
      actor: { type: 'SYSTEM', name: 'Crewly expiry policy' },
    });
  } catch (error) {
    if (pipelineTransition) {
      await transitionCandidateStage({
        companyId: offer.companyId,
        candidateId: offer.candidate,
        targetStage: 'OFFER',
        reason: `Expiry of ${offer.offerCode} rolled back`,
        actorId: offer.createdBy?._id || offer.createdBy,
        metadata: { source: 'PIPELINE', action: 'OFFER_EXPIRY_ROLLBACK', actorType: 'SYSTEM' },
      }).catch(() => {});
    }
    await restoreOfferTokensRevokedFor({
      companyId: offer.companyId,
      offerId: offer._id,
      reason: 'OFFER_EXPIRED',
    }).catch(() => {});
    await OfferLetter.updateOne(
      { _id: offer._id, companyId: offer.companyId, status: 'EXPIRED', expiredAt },
      { $set: { status: offer.status, activeKey: 'ACTIVE', expiredAt: null } }
    ).catch(() => {});
    throw error;
  }
  await recordAudit({
    req: requestContext,
    action: 'OFFER_EXPIRED',
    companyId: offer.companyId,
    actorId: offer.createdBy?._id || offer.createdBy,
    actorName: 'Crewly expiry policy',
    actorRole: 'SYSTEM',
    resource: 'OfferLetter',
    resourceId: offer._id,
    previousValue: { status: offer.status },
    newValue: { status: 'EXPIRED' },
    metadata: { offerCode: offer.offerCode },
    critical: true,
  });
  await notifyOfferOwner({
    companyId: offer.companyId,
    offer: updated,
    title: 'Offer expired',
    message: `${offer.offerCode} expired without a candidate decision.`,
  });
  // 28.7: analytics cache generation bump — also covers the 28.5
  // offer-expiry worker path (fire-and-forget, never throws).
  bumpRecruitmentAnalyticsGeneration(offer.companyId).catch(() => {});
  return updated;
};

const expireDueTenantOffers = async (companyId) => {
  const due = await OfferLetter.find({
    companyId,
    status: { $in: ['SENT', 'VIEWED'] },
    'terms.expiryDate': { $lte: new Date() },
  })
    .sort({ 'terms.expiryDate': 1 })
    .limit(100);

  for (const offer of due) {
    await expireOfferIfDue({ offer });
  }
};

export const getOfferOptions = async ({ companyId }) => {
  await expireDueTenantOffers(companyId);
  const [candidates, activeOffers, managers, company] = await Promise.all([
    Candidate.find({
      companyId,
      status: 'ACTIVE',
      currentStage: { $in: ['SELECTED', 'OFFER'] },
    })
      .select('_id candidateCode name email currentStage job hiringManager')
      .populate({ path: 'job', select: 'title jobCode location employmentType workMode department', match: { companyId }, populate: { path: 'department', select: 'name' } })
      .sort({ name: 1 })
      .lean(),
    OfferLetter.find({ companyId, status: { $in: ACTIVE_OFFER_STATUSES } })
      .select('candidate job')
      .lean(),
    User.find({
      companyId,
      status: 'ACTIVE',
      role: { $in: ['COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD'] },
    })
      .select('_id name role')
      .sort({ name: 1 })
      .lean(),
    Company.findOne({ _id: companyId }).select('currency').lean(),
  ]);

  const activeKeys = new Set(activeOffers.map((offer) => `${offer.candidate}:${offer.job}`));
  return {
    candidates: candidates
      .filter((candidate) => candidate.job && !activeKeys.has(`${candidate._id}:${candidate.job._id}`))
      .map((candidate) => ({
        id: candidate._id,
        candidateCode: candidate.candidateCode,
        name: candidate.name,
        email: candidate.email,
        stage: candidate.currentStage,
        hiringManagerId: candidate.hiringManager || null,
        job: {
          id: candidate.job._id,
          title: candidate.job.title,
          jobCode: candidate.job.jobCode,
          location: candidate.job.location,
          employmentType: candidate.job.employmentType,
          workMode: candidate.job.workMode,
          department: candidate.job.department?.name || '',
        },
      })),
    reportingManagers: managers.map((manager) => ({ id: manager._id, name: manager.name, role: manager.role })),
    currency: company?.currency || 'INR',
  };
};

export const listOffers = async ({ companyId, query }) => {
  await expireDueTenantOffers(companyId);
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const filter = { companyId };
  if (query.status) filter.status = query.status;
  if (query.candidateId) filter.candidate = query.candidateId;
  if (query.jobId) filter.job = query.jobId;
  if (query.search) {
    const escaped = cleanString(query.search, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { offerCode: new RegExp(escaped, 'i') },
      { 'candidateSnapshot.name': new RegExp(escaped, 'i') },
      { 'candidateSnapshot.email': new RegExp(escaped, 'i') },
      { 'jobSnapshot.title': new RegExp(escaped, 'i') },
    ];
  }

  const [offers, total, counts] = await Promise.all([
    OfferLetter.find(filter)
      .populate('createdBy', 'name role')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    OfferLetter.countDocuments(filter),
    OfferLetter.aggregate([
      { $match: { companyId: new mongoose.Types.ObjectId(companyId) } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  return {
    offers: offers.map(safeOfferDto),
    meta: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      kpis: Object.fromEntries(counts.map((item) => [item._id, item.count])),
    },
  };
};

export const getOffer = async ({ companyId, offerId }) => {
  const scopedOffer = await OfferLetter.findOne({ _id: offerId, companyId }).lean();
  if (!scopedOffer) throw ApiError.notFound('Offer not found');
  await expireOfferIfDue({ offer: scopedOffer });

  const offer = await OfferLetter.findOne({ _id: offerId, companyId })
    .populate('createdBy', 'name role')
    .populate('approval.submittedBy', 'name role')
    .populate('approval.approvedBy', 'name role')
    .populate('approval.returnedBy', 'name role')
    .lean();
  const history = await OfferHistory.find({ offer: offer._id, companyId })
    .populate('actor', 'name role')
    .sort({ eventAt: 1 })
    .lean();
  return { offer: safeOfferDto(offer), history };
};

export const updateOffer = async ({
  companyId,
  actor,
  offerId,
  payload,
  requestContext = null,
}) => {
  const current = await OfferLetter.findOne({ _id: offerId, companyId })
    .select('+document.storageKey +documentSnapshots.storageKey')
    .lean();
  if (!current) throw ApiError.notFound('Offer not found');
  if (!['DRAFT', 'APPROVED'].includes(current.status)) {
    throw ApiError.conflict('Only Draft or approved-unsent offers can be edited');
  }

  const { draft } = await buildOfferDraft({ companyId, actorId: actor.id, payload, existing: current });
  const wasApproved = current.status === 'APPROVED';
  const set = {
    ...draft,
    status: 'DRAFT',
    activeKey: 'ACTIVE',
    updatedBy: actor.id,
  };
  if (wasApproved) {
    set.approval = {
      ...current.approval,
      approvedBy: null,
      approvedAt: null,
    };
    set.documentSnapshots = [
      ...(current.documentSnapshots || []),
      {
        ...current.document,
        invalidatedAt: new Date(),
      },
    ];
    set.document = {
      checksum: '',
      fileName: '',
      mimeType: '',
      size: 0,
      version: current.document?.version || 0,
      generatedAt: null,
    };
  }

  const updated = await OfferLetter.findOneAndUpdate(
    { _id: current._id, companyId, status: current.status, updatedAt: current.updatedAt },
    { $set: set },
    { new: true, runValidators: true }
  );
  if (!updated) throw statusConflict();

  try {
    await secureMaterialOfferEvent({
      offer: updated,
      action: wasApproved ? 'OFFER_APPROVAL_INVALIDATED' : 'OFFER_UPDATED',
      fromStatus: current.status,
      toStatus: 'DRAFT',
      actor,
      historyMetadata: {
        templateVersion: updated.templateSnapshot.version,
        previousSnapshot: {
          templateSnapshot: current.templateSnapshot,
          renderedContent: current.renderedContent,
          terms: current.terms,
          compensationSnapshot: current.compensationSnapshot,
          document: {
            checksum: current.document?.checksum || '',
            version: current.document?.version || 0,
            generatedAt: current.document?.generatedAt || null,
          },
        },
      },
    });
  } catch (error) {
    await OfferLetter.updateOne(
      { _id: current._id, companyId, status: 'DRAFT' },
      {
        $set: {
          status: current.status,
          activeKey: 'ACTIVE',
          template: current.template,
          templateSnapshot: current.templateSnapshot,
          renderedContent: current.renderedContent,
          unresolvedVariables: current.unresolvedVariables,
          candidateSnapshot: current.candidateSnapshot,
          jobSnapshot: current.jobSnapshot,
          companySnapshot: current.companySnapshot,
          terms: current.terms,
          compensationSnapshot: current.compensationSnapshot,
          approval: current.approval,
          document: current.document,
          documentSnapshots: current.documentSnapshots || [],
          updatedBy: current.updatedBy,
        },
      }
    ).catch(() => {});
    throw error;
  }

  await recordAudit({
    req: requestContext,
    action: wasApproved ? 'OFFER_APPROVAL_INVALIDATED' : 'OFFER_UPDATED',
    companyId,
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    resource: 'OfferLetter',
    resourceId: updated._id,
    previousValue: {
      status: current.status,
      templateSnapshot: current.templateSnapshot,
      renderedContent: current.renderedContent,
      terms: current.terms,
      compensationSnapshot: current.compensationSnapshot,
      document: documentDto(current.document),
    },
    newValue: {
      status: 'DRAFT',
      templateSnapshot: updated.templateSnapshot,
      renderedContent: updated.renderedContent,
      terms: updated.terms,
      compensationSnapshot: updated.compensationSnapshot,
      document: documentDto(updated.document),
    },
    metadata: {
      offerCode: updated.offerCode,
      templateVersion: updated.templateSnapshot.version,
    },
    critical: true,
  });

  // 28.7: analytics cache generation bump (fire-and-forget, never throws).
  bumpRecruitmentAnalyticsGeneration(companyId).catch(() => {});

  return safeOfferDto(updated);
};

export const submitOffer = async ({ companyId, actor, offerId }) => {
  const offer = await OfferLetter.findOne({ _id: offerId, companyId });
  if (!offer) throw ApiError.notFound('Offer not found');
  if (offer.status !== 'DRAFT') throw ApiError.conflict('Only Draft offers can be submitted');
  assertReady(offer);

  const now = new Date();
  const updated = await OfferLetter.findOneAndUpdate(
    { _id: offer._id, companyId, status: 'DRAFT', updatedAt: offer.updatedAt },
    {
      $set: {
        status: 'PENDING_APPROVAL',
        renderedContent: offer.renderedContent,
        unresolvedVariables: [],
        'approval.submittedBy': actor.id,
        'approval.submittedAt': now,
        'approval.returnedBy': null,
        'approval.returnedAt': null,
        'approval.returnReason': '',
        updatedBy: actor.id,
      },
      $inc: { 'approval.attempt': 1 },
    },
    { new: true, runValidators: true }
  );
  if (!updated) throw statusConflict();

  try {
    await secureMaterialOfferEvent({
      offer: updated,
      action: 'OFFER_SUBMITTED',
      fromStatus: 'DRAFT',
      toStatus: 'PENDING_APPROVAL',
      actor,
      historyMetadata: { attempt: updated.approval.attempt },
    });
  } catch (error) {
    await OfferLetter.updateOne(
      { _id: updated._id, companyId, status: 'PENDING_APPROVAL', 'approval.submittedAt': now },
      { $set: { status: 'DRAFT', 'approval.submittedBy': null, 'approval.submittedAt': null }, $inc: { 'approval.attempt': -1 } }
    ).catch(() => {});
    throw error;
  }
  await notifyOfferSubmitted({ companyId, offer: updated });
  return safeOfferDto(updated);
};

export const returnOffer = async ({ companyId, actor, offerId, reason }) => {
  const now = new Date();
  const updated = await OfferLetter.findOneAndUpdate(
    { _id: offerId, companyId, status: 'PENDING_APPROVAL' },
    {
      $set: {
        status: 'DRAFT',
        'approval.returnedBy': actor.id,
        'approval.returnedAt': now,
        'approval.returnReason': cleanString(reason, 1000),
        updatedBy: actor.id,
      },
    },
    { new: true, runValidators: true }
  );
  if (!updated) throw statusConflict();
  try {
    await secureMaterialOfferEvent({
      offer: updated,
      action: 'OFFER_RETURNED',
      fromStatus: 'PENDING_APPROVAL',
      toStatus: 'DRAFT',
      actor,
      reason,
      historyMetadata: { attempt: updated.approval.attempt },
      candidateMetadata: { reason: cleanString(reason, 300) },
    });
  } catch (error) {
    await OfferLetter.updateOne(
      { _id: updated._id, companyId, status: 'DRAFT', 'approval.returnedAt': now },
      { $set: { status: 'PENDING_APPROVAL', 'approval.returnedBy': null, 'approval.returnedAt': null, 'approval.returnReason': '' } }
    ).catch(() => {});
    throw error;
  }
  await notifyOfferOwner({ companyId, offer: updated, title: 'Offer returned for changes', message: `${updated.offerCode} was returned to Draft.` });
  return safeOfferDto(updated);
};

export const approveOffer = async ({ companyId, actor, offerId }) => {
  const offer = await OfferLetter.findOne({ _id: offerId, companyId });
  if (!offer) throw ApiError.notFound('Offer not found');
  if (offer.status !== 'PENDING_APPROVAL') throw ApiError.conflict('Only pending offers can be approved');
  if (
    String(offer.createdBy) === String(actor.id) ||
    String(offer.approval?.submittedBy) === String(actor.id)
  ) {
    throw ApiError.forbidden('Offer creators and submitters cannot approve their own offer');
  }

  const approvedAt = new Date();
  offer.approval.approvedAt = approvedAt;
  offer.approval.approvedBy = actor.id;
  assertReady(offer);
  const buffer = await generateOfferPdf({
    ...offer.toObject(),
    approvalSignatory: {
      name: actor.name,
      role: actor.role,
      approvedAt,
    },
  });
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
  const stored = await storeOfferDocument({
    buffer,
    companyId,
    offerCode: offer.offerCode,
  });

  const document = {
    ...stored,
    checksum,
    fileName: `${offer.offerCode}.pdf`,
    mimeType: 'application/pdf',
    size: buffer.length,
    version: (offer.document?.version || 0) + 1,
    generatedAt: approvedAt,
  };

  try {
    const updated = await OfferLetter.findOneAndUpdate(
      { _id: offer._id, companyId, status: 'PENDING_APPROVAL', updatedAt: offer.updatedAt },
      {
        $set: {
          status: 'APPROVED',
          renderedContent: offer.renderedContent,
          unresolvedVariables: [],
          'approval.approvedBy': actor.id,
          'approval.approvedAt': approvedAt,
          document,
          updatedBy: actor.id,
        },
      },
      { new: true, runValidators: true }
    );
    if (!updated) throw statusConflict();

    await secureMaterialOfferEvent({
      offer: updated,
      action: 'OFFER_APPROVED',
      fromStatus: 'PENDING_APPROVAL',
      toStatus: 'APPROVED',
      actor,
      historyMetadata: {
        attempt: updated.approval.attempt,
        documentChecksum: checksum,
        documentVersion: document.version,
      },
      candidateMetadata: { documentChecksum: checksum },
    });
    await notifyOfferOwner({ companyId, offer: updated, title: 'Offer approved', message: `${updated.offerCode} is approved and ready to send.` });
    return safeOfferDto(updated);
  } catch (error) {
    await OfferLetter.updateOne(
      {
        _id: offer._id,
        companyId,
        status: 'APPROVED',
        'document.checksum': checksum,
      },
      {
        $set: {
          status: 'PENDING_APPROVAL',
          'approval.approvedBy': null,
          'approval.approvedAt': null,
          document: {
            checksum: '',
            fileName: '',
            mimeType: '',
            size: 0,
            version: offer.document?.version || 0,
            generatedAt: null,
          },
          updatedBy: offer.updatedBy,
        },
      }
    ).catch(() => {});
    await deleteStoredOfferDocument(stored).catch(() => {});
    throw error;
  }
};

const clearSendClaim = async ({ offerId, companyId, claimHash, error }) => {
  await OfferLetter.updateOne(
    { _id: offerId, companyId, status: 'APPROVED', 'delivery.sendClaimHash': claimHash },
    {
      $set: {
        'delivery.sendClaimHash': null,
        'delivery.sendClaimedAt': null,
        'delivery.lastAttemptAt': new Date(),
        'delivery.lastError': cleanString(error, 500),
      },
    }
  );
};

export const sendOffer = async ({ companyId, actor, offerId, requestContext }) => {
  const claimHash = hashToken(randomToken(32));
  const now = new Date();
  const offer = await OfferLetter.findOneAndUpdate(
    {
      _id: offerId,
      companyId,
      status: 'APPROVED',
      'document.checksum': { $gt: '' },
      $or: [
        { 'delivery.sendClaimHash': null },
        { 'delivery.sendClaimHash': { $exists: false } },
        { 'delivery.sendClaimedAt': { $lt: new Date(Date.now() - 10 * 60 * 1000) } },
      ],
    },
    {
      $set: {
        'delivery.sendClaimHash': claimHash,
        'delivery.sendClaimedAt': now,
        'delivery.lastAttemptAt': now,
        'delivery.lastError': '',
      },
    },
    { new: true }
  ).select('+delivery.sendClaimHash');
  if (!offer) throw ApiError.conflict('Offer is not approved, has no document, or is already being sent');
  try {
    assertReady(offer);
  } catch (error) {
    await clearSendClaim({
      offerId: offer._id,
      companyId,
      claimHash,
      error: error.message || 'Offer readiness check failed',
    });
    throw error;
  }

  const clientOrigin = String(env.CLIENT_URL || '').split(',')[0].trim().replace(/\/$/, '');
  if (env.NODE_ENV === 'production' && !/^https:\/\//i.test(clientOrigin)) {
    const configurationError = 'A secure candidate portal origin is not configured';
    await clearSendClaim({
      offerId: offer._id,
      companyId,
      claimHash,
      error: configurationError,
    });
    await secureMaterialOfferEvent({
      offer,
      action: 'OFFER_SEND_FAILED',
      fromStatus: 'APPROVED',
      toStatus: 'APPROVED',
      actor,
      reason: configurationError,
      historyMetadata: { mode: 'CONFIGURATION' },
      candidateMetadata: { mode: 'CONFIGURATION' },
    }).catch(() => {});
    await recordAudit({
      req: requestContext,
      action: 'OFFER_SEND_FAILED',
      companyId,
      actorId: actor.id,
      resource: 'OfferLetter',
      resourceId: offer._id,
      metadata: { offerCode: offer.offerCode, reason: configurationError },
      statusCode: 503,
      critical: true,
    });
    throw new ApiError(503, 'Secure candidate portal delivery is not configured');
  }

  const tokenMaximum = new Date(
    Date.now() + OFFER_TOKEN_MAX_DAYS * 24 * 60 * 60 * 1000
  );
  const tokenExpiresAt = new Date(
    Math.min(new Date(offer.terms.expiryDate).getTime(), tokenMaximum.getTime())
  );
  let issuedToken;
  try {
    issuedToken = await issueOfferToken({
      companyId,
      offerId: offer._id,
      expiresAt: tokenExpiresAt,
      actorId: actor.id,
    });
  } catch (error) {
    await clearSendClaim({
      offerId: offer._id,
      companyId,
      claimHash,
      error: 'Secure offer access could not be issued',
    });
    throw error;
  }
  const { rawToken, tokenRecordId } = issuedToken;
  const portalUrl = `${clientOrigin}/candidate/offer/${rawToken}`;
  const message = offerCandidateAccessEmail({ offer, portalUrl });
  const delivery = await sendMail({
    to: offer.candidateSnapshot.email,
    ...message,
    sensitive: true,
  });

  // Local testing only: sensitive MOCK mail intentionally hides the body/link.
  // Print the candidate portal URL once so HR can open it without SMTP.
  if (
    delivery.delivered &&
    delivery.mode === 'MOCK' &&
    ['development', 'test'].includes(String(env.NODE_ENV || 'development'))
  ) {
    logger.info(
      `[DEV ONLY] Offer portal for ${offer.offerCode} → ${offer.candidateSnapshot.email}: ${portalUrl}`
    );
  }

  if (!delivery.delivered) {
    await revokeOfferTokens({
      companyId,
      offerId: offer._id,
      reason: 'DELIVERY_FAILED',
    });
    await clearSendClaim({ offerId: offer._id, companyId, claimHash, error: delivery.error || 'Delivery failed' });
    await secureMaterialOfferEvent({
      offer,
      action: 'OFFER_SEND_FAILED',
      fromStatus: 'APPROVED',
      toStatus: 'APPROVED',
      actor,
      reason: delivery.error || 'Delivery failed',
      historyMetadata: { mode: delivery.mode },
      candidateMetadata: { mode: delivery.mode },
    }).catch(() => {});
    await recordAudit({
      req: requestContext,
      action: 'OFFER_SEND_FAILED',
      companyId,
      actorId: actor.id,
      actorName: actor.name,
      actorRole: actor.role,
      resource: 'OfferLetter',
      resourceId: offer._id,
      metadata: {
        offerCode: offer.offerCode,
        mode: delivery.mode,
        reason: delivery.error || 'Delivery failed',
      },
      statusCode: 503,
      critical: true,
    });
    throw new ApiError(503, 'Offer delivery failed safely; the offer remains approved');
  }

  let pipelineTransition = null;
  const sentAt = new Date();
  try {
    const candidate = await Candidate.findOne({
      _id: offer.candidate,
      companyId,
    })
      .select('currentStage stage')
      .lean();
    if (!candidate) throw ApiError.notFound('Candidate not found');
    const candidateStage = candidate.currentStage || candidate.stage;
    if (!['SELECTED', 'OFFER'].includes(candidateStage)) {
      throw ApiError.conflict('Candidate is no longer eligible for offer delivery');
    }
    if (candidateStage === 'SELECTED') {
      pipelineTransition = await transitionCandidateStage({
        companyId,
        candidateId: offer.candidate,
        targetStage: 'OFFER',
        reason: `Offer ${offer.offerCode} delivered`,
        actorId: actor.id,
        metadata: { source: 'PIPELINE', action: 'OFFER_SENT' },
        requestContext,
      });
    }

    const updated = await OfferLetter.findOneAndUpdate(
      { _id: offer._id, companyId, status: 'APPROVED', 'delivery.sendClaimHash': claimHash },
      {
        $set: {
          status: 'SENT',
          'delivery.sendClaimHash': null,
          'delivery.sendClaimedAt': null,
          'delivery.sentAt': sentAt,
          'delivery.mode': delivery.mode,
          'delivery.lastError': '',
          updatedBy: actor.id,
        },
      },
      { new: true, runValidators: true }
    );
    if (!updated) throw statusConflict();

    await secureMaterialOfferEvent({
      offer: updated,
      action: 'OFFER_SENT',
      fromStatus: 'APPROVED',
      toStatus: 'SENT',
      actor,
      historyMetadata: { mode: delivery.mode, tokenRecordId },
      candidateMetadata: { mode: delivery.mode },
    });
    await notifyOfferOwner({
      companyId,
      offer: updated,
      title: 'Offer sent',
      message: `${updated.offerCode} was delivered to the candidate.`,
    });
    // 28.5: schedule the offer expiry job (+ reminder when the offset
    // window is still open). terms.expiryDate in Mongo is the intent;
    // scheduled:reconcile rebuilds if the queue was unavailable.
    scheduleOfferJobs(updated).catch(() => {});
    return safeOfferDto(updated);
  } catch (error) {
    await revokeOfferTokens({
      companyId,
      offerId: offer._id,
      reason: 'SEND_FINALIZATION_FAILED',
    }).catch(() => {});
    await OfferLetter.updateOne(
      { _id: offer._id, companyId, status: 'SENT', 'delivery.sentAt': sentAt },
      {
        $set: {
          status: 'APPROVED',
          'delivery.sentAt': null,
          'delivery.mode': null,
          'delivery.sendClaimHash': null,
          'delivery.sendClaimedAt': null,
          'delivery.lastError': 'Send finalization failed',
        },
      }
    ).catch(() => {});
    await clearSendClaim({ offerId: offer._id, companyId, claimHash, error: 'Send finalization failed' }).catch(() => {});
    if (pipelineTransition) {
      await transitionCandidateStage({
        companyId,
        candidateId: offer.candidate,
        targetStage: 'SELECTED',
        reason: `Offer ${offer.offerCode} send finalization rolled back`,
        actorId: actor.id,
        metadata: { source: 'PIPELINE', action: 'OFFER_SEND_ROLLBACK', actorType: 'SYSTEM' },
      }).catch(() => {});
    }
    throw error;
  }
};

export const withdrawOffer = async ({ companyId, actor, offerId, reason, requestContext }) => {
  const current = await OfferLetter.findOne({ _id: offerId, companyId }).lean();
  if (!current) throw ApiError.notFound('Offer not found');
  if (!ACTIVE_OFFER_STATUSES.includes(current.status)) throw ApiError.conflict('Final offers cannot be withdrawn');
  const now = new Date();
  const updated = await OfferLetter.findOneAndUpdate(
    { _id: current._id, companyId, status: current.status },
    {
      $set: {
        status: 'WITHDRAWN',
        activeKey: null,
        withdrawnAt: now,
        withdrawalReason: cleanString(reason, 1000),
        updatedBy: actor.id,
      },
    },
    { new: true, runValidators: true }
  );
  if (!updated) throw statusConflict();

  let pipelineTransition = null;
  try {
    await revokeOfferTokens({
      companyId,
      offerId: updated._id,
      reason: 'OFFER_WITHDRAWN',
    });
    const candidate = await Candidate.findOne({ _id: updated.candidate, companyId }).select('currentStage stage').lean();
    if ((candidate?.currentStage || candidate?.stage) === 'OFFER') {
      pipelineTransition = await transitionCandidateStage({
        companyId,
        candidateId: updated.candidate,
        targetStage: 'SELECTED',
        reason: cleanString(reason, 1000),
        actorId: actor.id,
        metadata: { source: 'PIPELINE', action: 'OFFER_WITHDRAWN' },
        requestContext,
      });
    }
    await secureMaterialOfferEvent({
      offer: updated,
      action: 'OFFER_WITHDRAWN',
      fromStatus: current.status,
      toStatus: 'WITHDRAWN',
      actor,
      reason,
      candidateMetadata: { reason: cleanString(reason, 300) },
    });
    await notifyOfferOwner({
      companyId,
      offer: updated,
      title: 'Offer withdrawn',
      message: `${updated.offerCode} was withdrawn.`,
    });
    if (['SENT', 'VIEWED'].includes(current.status)) {
      // 28.3: async email delivery (no portal token in this message).
      await requestEmailDelivery({
        jobName: JOB_NAMES.EMAIL_OFFER_WITHDRAWN,
        eventType: 'OFFER_WITHDRAWN',
        eventKey: buildEventKey('OFFER_WITHDRAWN', updated._id),
        companyId,
        entityType: 'OFFER',
        entityId: updated._id,
        recipientType: 'CANDIDATE',
        recipientReference: updated.candidate,
        payload: { offerId: updated._id },
      });
    }
    // 28.5: retire pending reminder/expiry jobs (best-effort; the
    // expiry worker's atomic guard is the final protection).
    if (['SENT', 'VIEWED'].includes(current.status)) {
      cancelOfferJobs(updated).catch(() => {});
    }
    return safeOfferDto(updated);
  } catch (error) {
    if (pipelineTransition) {
      await transitionCandidateStage({
        companyId,
        candidateId: updated.candidate,
        targetStage: 'OFFER',
        reason: `Withdrawal of ${updated.offerCode} rolled back`,
        actorId: actor.id,
        metadata: { source: 'PIPELINE', action: 'OFFER_WITHDRAWAL_ROLLBACK', actorType: 'SYSTEM' },
      }).catch(() => {});
    }
    await restoreOfferTokensRevokedFor({
      companyId,
      offerId: updated._id,
      reason: 'OFFER_WITHDRAWN',
    }).catch(() => {});
    await OfferLetter.updateOne(
      { _id: updated._id, companyId, status: 'WITHDRAWN', withdrawnAt: now },
      { $set: { status: current.status, activeKey: 'ACTIVE', withdrawnAt: null, withdrawalReason: '' } }
    ).catch(() => {});
    throw error;
  }
};

export const getOfferDocument = async ({ companyId, offerId, actor }) => {
  const offer = await OfferLetter.findOne({ _id: offerId, companyId })
    .select('+document.storageKey')
    .lean();
  if (!offer || !offer.document?.storageKey || !offer.document?.checksum) {
    throw ApiError.notFound('Offer document not found');
  }
  const buffer = await getStoredOfferDocument({
    storageProvider: offer.document.storageProvider,
    storageKey: offer.document.storageKey,
  });
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
  if (checksum !== offer.document.checksum) {
    throw new ApiError(503, 'Offer document integrity check failed');
  }
  await offerHistory({
    offer,
    action: 'OFFER_DOCUMENT_ACCESSED',
    actor,
    metadata: { documentChecksum: checksum },
  });
  return {
    offer: safeOfferDto(offer),
    buffer,
    fileName: offer.document.fileName,
    checksum,
  };
};
