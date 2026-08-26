import mongoose from 'mongoose';
import Candidate from '../models/Candidate.js';
import CandidateDocument from '../models/CandidateDocument.js';
import CandidateDocumentRequirement from '../models/CandidateDocumentRequirement.js';
import CandidateDocumentVersion from '../models/CandidateDocumentVersion.js';
import CandidateHistory from '../models/CandidateHistory.js';
import Company from '../models/Company.js';
import OfferLetter from '../models/OfferLetter.js';
import PreOnboarding from '../models/PreOnboarding.js';
import PreOnboardingDocumentRequirement from '../models/PreOnboardingDocumentRequirement.js';
import PreOnboardingHistory from '../models/PreOnboardingHistory.js';
import ApiError from '../utils/ApiError.js';
import env from '../config/env.js';
import logger from '../config/logger.js';
import {
  fingerprintSensitiveValue,
  maskDocumentNumber,
} from '../utils/fieldEncryption.js';
import {
  preOnboardingAccessEmail,
  preOnboardingDocumentDecisionEmail,
  sendMail,
} from '../utils/mailer.js';
import { recordAudit } from '../utils/securityauditService.js';
import {
  nextCandidateDocumentCode,
  nextPreOnboardingCode,
} from '../utils/preOnboardingIdentifiers.js';
import { transitionCandidateStage } from './candidatePipelineService.js';
import { inspectPreOnboardingFile } from './preOnboardingDocumentSecurityService.js';
import {
  getStoredPreOnboardingDocument,
  storePreOnboardingDocument,
} from './preOnboardingDocumentStorageService.js';
import {
  notifyAllMandatorySubmitted,
  notifyDocumentUploaded,
  notifyPreOnboardingReady,
  notifyPreOnboardingStarted,
} from './preOnboardingNotificationService.js';
import {
  issuePreOnboardingToken,
  revokePreOnboardingTokens,
} from './preOnboardingTokenService.js';

const DEFAULT_REQUIREMENTS = [
  {
    code: 'GOVERNMENT_ID',
    name: 'Government ID',
    category: 'IDENTITY',
    required: true,
    displayOrder: 10,
    instructions: 'Upload a clear government-issued photo identity document.',
    requiresDocumentNumber: true,
  },
  {
    code: 'PAN',
    name: 'PAN',
    category: 'TAX',
    required: true,
    displayOrder: 20,
    instructions: 'Upload a clear PAN card or equivalent tax identity document.',
    requiresDocumentNumber: true,
  },
  {
    code: 'DEGREE_CERTIFICATE',
    name: 'Degree Certificate',
    category: 'EDUCATION',
    required: true,
    displayOrder: 30,
    instructions: 'Upload the highest completed education certificate.',
  },
  {
    code: 'PHOTO',
    name: 'Photograph',
    category: 'PHOTO',
    required: false,
    displayOrder: 40,
    instructions: 'Upload a recent passport-style photograph.',
    allowedFileTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
];

const TOKEN_MAX_DAYS = Math.min(
  180,
  Math.max(7, Number(process.env.PRE_ONBOARDING_TOKEN_MAX_DAYS || 90))
);

const isObjectId = (value) => mongoose.isValidObjectId(value);

const sanitizeCode = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 40);

const safeReason = (value) => String(value || '').trim().slice(0, 1000);

const portalBaseUrl = () =>
  String(env.CLIENT_URL || '')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');

const tokenExpiryDate = () =>
  new Date(Date.now() + TOKEN_MAX_DAYS * 24 * 60 * 60 * 1000);

export const ensureDefaultDocumentRequirements = async ({
  companyId,
  actorId,
}) => {
  const existing = await PreOnboardingDocumentRequirement.countDocuments({
    companyId,
  });
  if (existing > 0) return;

  await PreOnboardingDocumentRequirement.insertMany(
    DEFAULT_REQUIREMENTS.map((item) => ({
      companyId,
      ...item,
      description: item.instructions || '',
      active: true,
      allowedFileTypes: item.allowedFileTypes || [
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/webp',
      ],
      maxFileSize: 5 * 1024 * 1024,
      requiresExpiryDate: false,
      requiresDocumentNumber: Boolean(item.requiresDocumentNumber),
      createdBy: actorId,
      updatedBy: actorId,
    })),
    { ordered: false }
  ).catch(() => {});
};

export const evaluatePreOnboardingReadiness = (requirements = []) => {
  const required = requirements.filter((item) => item.required);
  const optional = requirements.filter((item) => !item.required);

  const verifiedRequired = required.filter((item) => item.status === 'VERIFIED');
  const missingRequired = required.filter((item) =>
    ['PENDING'].includes(item.status)
  );
  const underReviewRequired = required.filter((item) =>
    ['UPLOADED', 'UNDER_REVIEW'].includes(item.status)
  );
  const resubmissionRequired = required.filter((item) =>
    ['REJECTED', 'RESUBMISSION_REQUIRED'].includes(item.status)
  );
  const rejectedRequired = required.filter((item) => item.status === 'REJECTED');

  const ready =
    required.length > 0 &&
    verifiedRequired.length === required.length &&
    resubmissionRequired.length === 0 &&
    underReviewRequired.length === 0 &&
    missingRequired.length === 0;

  return {
    totalRequired: required.length,
    verifiedRequired: verifiedRequired.length,
    missingRequired: missingRequired.length,
    underReviewRequired: underReviewRequired.length,
    resubmissionRequired: resubmissionRequired.length,
    rejectedRequired: rejectedRequired.length,
    optionalTotal: optional.length,
    optionalVerified: optional.filter((item) => item.status === 'VERIFIED')
      .length,
    ready,
    blockingReasons: [
      ...(missingRequired.length
        ? [`${missingRequired.length} mandatory document(s) still pending`]
        : []),
      ...(underReviewRequired.length
        ? [`${underReviewRequired.length} mandatory document(s) under review`]
        : []),
      ...(resubmissionRequired.length
        ? [`${resubmissionRequired.length} mandatory document(s) need resubmission`]
        : []),
      ...(required.length === 0
        ? ['No mandatory document requirements are assigned']
        : []),
    ],
  };
};

const deriveCaseStatus = ({ currentStatus, readiness }) => {
  if (['READY_TO_JOIN', 'WITHDRAWN'].includes(currentStatus)) {
    return currentStatus;
  }
  if (readiness.ready) return 'COMPLETED';
  if (readiness.resubmissionRequired > 0) return 'ACTION_REQUIRED';
  if (readiness.underReviewRequired > 0) return 'UNDER_REVIEW';
  if (readiness.verifiedRequired > 0 || readiness.missingRequired < readiness.totalRequired) {
    return 'IN_PROGRESS';
  }
  return currentStatus === 'NOT_STARTED' ? 'NOT_STARTED' : 'IN_PROGRESS';
};

const recordHistory = async ({
  companyId,
  preOnboarding,
  action,
  previousStatus = '',
  newStatus = '',
  actorType = 'SYSTEM',
  actorId = null,
  reason = '',
  metadata = {},
}) =>
  PreOnboardingHistory.create({
    companyId,
    preOnboarding: preOnboarding._id,
    candidate: preOnboarding.candidate,
    job: preOnboarding.job,
    action,
    previousStatus,
    newStatus,
    actorType,
    actor: actorId,
    reason: safeReason(reason),
    metadata,
  });

const recordCandidateTimeline = async ({
  companyId,
  candidate,
  job,
  action,
  actorType = 'SYSTEM',
  actorId = null,
  metadata = {},
}) =>
  CandidateHistory.create({
    companyId,
    candidate,
    job,
    action,
    source: 'PRE_ONBOARDING',
    actorType,
    actor: actorId,
    metadata,
    eventAt: new Date(),
  });

const requirementDto = (item, { includeInternal = false } = {}) => ({
  id: item._id,
  code: item.code,
  name: item.nameSnapshot || item.name,
  description: item.descriptionSnapshot || item.description || '',
  category: item.categorySnapshot || item.category,
  required: Boolean(item.required),
  instructions: item.instructionsSnapshot || item.instructions || '',
  fileRules: item.fileRulesSnapshot || {
    allowedFileTypes: item.allowedFileTypes,
    maxFileSize: item.maxFileSize,
    requiresExpiryDate: item.requiresExpiryDate,
    requiresDocumentNumber: item.requiresDocumentNumber,
  },
  displayOrder: item.displayOrder,
  status: item.status,
  rejectionReason: item.rejectionReason || '',
  activeDocumentId: item.activeDocument || null,
  verifiedAt: item.verifiedAt || null,
  lastUploadedAt: item.lastUploadedAt || null,
  ...(includeInternal
    ? {
        verifiedBy: item.verifiedBy || null,
        requirementId: item.requirement || item._id,
        active: item.active,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }
    : {}),
});

const documentDto = (document, version = null) => ({
  id: document._id,
  documentCode: document.documentCode,
  requirementCode: document.requirementCode,
  status: document.status,
  currentVersion: document.currentVersion,
  documentNumberMasked: document.documentNumberMasked || '',
  expiryDate: document.expiryDate || null,
  uploadedAt: document.uploadedAt,
  reviewedAt: document.reviewedAt,
  rejectionReason: document.rejectionReason || '',
  activeVersion: version
    ? {
        id: version._id,
        version: version.version,
        originalFileName: version.originalFileName,
        mimeType: version.mimeType,
        fileSize: version.fileSize,
        scanStatus: version.scanStatus,
        status: version.status,
        uploadedAt: version.uploadedAt,
        rejectionReason: version.rejectionReason || '',
      }
    : null,
});

export const safePreOnboardingDto = (
  preOnboarding,
  {
    requirements = [],
    readiness = null,
    includeInternal = false,
  } = {}
) => {
  const computed =
    readiness || evaluatePreOnboardingReadiness(requirements);

  return {
    id: preOnboarding._id,
    preOnboardingCode: preOnboarding.preOnboardingCode,
    status: preOnboarding.status,
    candidate: {
      id: preOnboarding.candidate?._id || preOnboarding.candidate,
      ...preOnboarding.candidateSnapshot,
    },
    offer: {
      id: preOnboarding.offer?._id || preOnboarding.offer,
      ...preOnboarding.offerSnapshot,
    },
    job: {
      id: preOnboarding.job?._id || preOnboarding.job,
      ...preOnboarding.jobSnapshot,
    },
    company: preOnboarding.companySnapshot,
    startedAt: preOnboarding.startedAt,
    invitedAt: preOnboarding.invitedAt,
    completedAt: preOnboarding.completedAt,
    readyToJoinAt: preOnboarding.readyToJoinAt,
    requiredDocumentCount: computed.totalRequired,
    verifiedRequiredDocumentCount: computed.verifiedRequired,
    readiness: computed,
    requirements: requirements
      .slice()
      .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0))
      .map((item) => requirementDto(item, { includeInternal })),
    canMarkReady: computed.ready && preOnboarding.status !== 'READY_TO_JOIN',
    ...(includeInternal
      ? {
          readyToJoinBy: preOnboarding.readyToJoinBy || null,
          createdBy: preOnboarding.createdBy,
          updatedBy: preOnboarding.updatedBy,
          invite: {
            lastSentAt: preOnboarding.invite?.lastSentAt || null,
            mode: preOnboarding.invite?.mode || null,
          },
          createdAt: preOnboarding.createdAt,
          updatedAt: preOnboarding.updatedAt,
        }
      : {}),
  };
};

const refreshCaseCounters = async ({
  companyId,
  preOnboarding,
  actorId = null,
  actorType = 'SYSTEM',
}) => {
  const requirements = await CandidateDocumentRequirement.find({
    companyId,
    preOnboarding: preOnboarding._id,
  })
    .sort({ displayOrder: 1, createdAt: 1 })
    .lean();

  const readiness = evaluatePreOnboardingReadiness(requirements);
  const nextStatus = deriveCaseStatus({
    currentStatus: preOnboarding.status,
    readiness,
  });

  const updates = {
    requiredDocumentCount: readiness.totalRequired,
    verifiedRequiredDocumentCount: readiness.verifiedRequired,
    updatedBy: actorId || preOnboarding.updatedBy,
  };

  if (nextStatus !== preOnboarding.status) {
    updates.status = nextStatus;
    if (nextStatus === 'COMPLETED' && !preOnboarding.completedAt) {
      updates.completedAt = new Date();
    }
  }

  const updated = await PreOnboarding.findOneAndUpdate(
    { _id: preOnboarding._id, companyId },
    { $set: updates },
    { returnDocument: 'after' }
  );

  if (
    nextStatus !== preOnboarding.status &&
    nextStatus === 'COMPLETED'
  ) {
    await recordHistory({
      companyId,
      preOnboarding: updated,
      action: 'PRE_ONBOARDING_COMPLETED',
      previousStatus: preOnboarding.status,
      newStatus: nextStatus,
      actorType,
      actorId,
      metadata: { readiness },
    });
    await recordCandidateTimeline({
      companyId,
      candidate: updated.candidate,
      job: updated.job,
      action: 'PRE_ONBOARDING_COMPLETED',
      actorType,
      actorId,
      metadata: {
        preOnboardingCode: updated.preOnboardingCode,
        verifiedRequired: readiness.verifiedRequired,
        totalRequired: readiness.totalRequired,
      },
    });
  }

  return { preOnboarding: updated, requirements, readiness };
};

const loadCaseBundle = async ({ companyId, preOnboardingId }) => {
  if (!isObjectId(preOnboardingId)) {
    throw ApiError.notFound('Pre-onboarding case not found');
  }

  const preOnboarding = await PreOnboarding.findOne({
    _id: preOnboardingId,
    companyId,
  });
  if (!preOnboarding) throw ApiError.notFound('Pre-onboarding case not found');

  const requirements = await CandidateDocumentRequirement.find({
    companyId,
    preOnboarding: preOnboarding._id,
  })
    .sort({ displayOrder: 1, createdAt: 1 })
    .lean();

  const readiness = evaluatePreOnboardingReadiness(requirements);
  return { preOnboarding, requirements, readiness };
};

export const listDocumentRequirements = async ({ companyId, actorId }) => {
  await ensureDefaultDocumentRequirements({ companyId, actorId });
  const rows = await PreOnboardingDocumentRequirement.find({ companyId })
    .sort({ displayOrder: 1, name: 1 })
    .lean();

  return rows.map((row) => ({
    id: row._id,
    name: row.name,
    code: row.code,
    description: row.description,
    category: row.category,
    required: row.required,
    active: row.active,
    allowedFileTypes: row.allowedFileTypes,
    maxFileSize: row.maxFileSize,
    instructions: row.instructions,
    requiresExpiryDate: row.requiresExpiryDate,
    requiresDocumentNumber: row.requiresDocumentNumber,
    displayOrder: row.displayOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
};

export const createDocumentRequirement = async ({
  companyId,
  actorId,
  payload,
}) => {
  const code = sanitizeCode(payload.code || payload.name);
  if (!code) throw ApiError.badRequest('Requirement code is required');
  if (!String(payload.name || '').trim()) {
    throw ApiError.badRequest('Requirement name is required');
  }

  try {
    const created = await PreOnboardingDocumentRequirement.create({
      companyId,
      name: String(payload.name).trim().slice(0, 120),
      code,
      description: String(payload.description || '').trim().slice(0, 1000),
      category: payload.category || 'OTHER',
      required: payload.required !== false,
      active: payload.active !== false,
      allowedFileTypes:
        payload.allowedFileTypes?.length > 0
          ? payload.allowedFileTypes
          : undefined,
      maxFileSize: payload.maxFileSize || undefined,
      instructions: String(payload.instructions || '').trim().slice(0, 2000),
      requiresExpiryDate: Boolean(payload.requiresExpiryDate),
      requiresDocumentNumber: Boolean(payload.requiresDocumentNumber),
      displayOrder: Number(payload.displayOrder) || 100,
      createdBy: actorId,
      updatedBy: actorId,
    });

    await recordAudit({
      req: null,
      action: 'DOCUMENT_REQUIREMENT_CREATED',
      companyId,
      actorId,
      resource: 'PreOnboardingDocumentRequirement',
      resourceId: created._id,
      newValue: { code: created.code, required: created.required },
      critical: true,
    });

    return (await listDocumentRequirements({ companyId, actorId })).find(
      (item) => String(item.id) === String(created._id)
    );
  } catch (error) {
    if (error.code === 11000) {
      throw ApiError.conflict('A requirement with this code already exists');
    }
    throw error;
  }
};

export const updateDocumentRequirement = async ({
  companyId,
  actorId,
  requirementId,
  payload,
}) => {
  if (!isObjectId(requirementId)) {
    throw ApiError.notFound('Document requirement not found');
  }

  const updates = { updatedBy: actorId };
  if (payload.name !== undefined) {
    updates.name = String(payload.name).trim().slice(0, 120);
  }
  if (payload.description !== undefined) {
    updates.description = String(payload.description || '').trim().slice(0, 1000);
  }
  if (payload.category !== undefined) updates.category = payload.category;
  if (payload.required !== undefined) updates.required = Boolean(payload.required);
  if (payload.active !== undefined) updates.active = Boolean(payload.active);
  if (payload.allowedFileTypes !== undefined) {
    updates.allowedFileTypes = payload.allowedFileTypes;
  }
  if (payload.maxFileSize !== undefined) {
    updates.maxFileSize = Number(payload.maxFileSize);
  }
  if (payload.instructions !== undefined) {
    updates.instructions = String(payload.instructions || '').trim().slice(0, 2000);
  }
  if (payload.requiresExpiryDate !== undefined) {
    updates.requiresExpiryDate = Boolean(payload.requiresExpiryDate);
  }
  if (payload.requiresDocumentNumber !== undefined) {
    updates.requiresDocumentNumber = Boolean(payload.requiresDocumentNumber);
  }
  if (payload.displayOrder !== undefined) {
    updates.displayOrder = Number(payload.displayOrder) || 100;
  }

  const updated = await PreOnboardingDocumentRequirement.findOneAndUpdate(
    { _id: requirementId, companyId },
    { $set: updates },
    { returnDocument: 'after', runValidators: true }
  ).lean();

  if (!updated) throw ApiError.notFound('Document requirement not found');

  await recordAudit({
    req: null,
    action: 'DOCUMENT_REQUIREMENT_UPDATED',
    companyId,
    actorId,
    resource: 'PreOnboardingDocumentRequirement',
    resourceId: updated._id,
    newValue: {
      code: updated.code,
      active: updated.active,
      required: updated.required,
    },
    critical: true,
  });

  return (await listDocumentRequirements({ companyId, actorId })).find(
    (item) => String(item.id) === String(updated._id)
  );
};

export const deactivateDocumentRequirement = async ({
  companyId,
  actorId,
  requirementId,
}) =>
  updateDocumentRequirement({
    companyId,
    actorId,
    requirementId,
    payload: { active: false },
  });

const sendInviteEmail = async ({
  preOnboarding,
  rawToken,
  companyId,
}) => {
  const portalUrl = `${portalBaseUrl()}/candidate/pre-onboarding/${rawToken}`;
  const message = preOnboardingAccessEmail({
    candidateName: preOnboarding.candidateSnapshot.name,
    companyName: preOnboarding.companySnapshot.name,
    jobTitle: preOnboarding.jobSnapshot.title,
    designation: preOnboarding.offerSnapshot.designation,
    joiningDate: preOnboarding.offerSnapshot.joiningDate,
    preOnboardingCode: preOnboarding.preOnboardingCode,
    portalUrl,
    expiryDays: TOKEN_MAX_DAYS,
  });

  const delivery = await sendMail({
    to: preOnboarding.candidateSnapshot.email,
    ...message,
    sensitive: true,
  });

  // Local testing only: sensitive MOCK mail intentionally hides the body/link.
  if (
    delivery.delivered &&
    delivery.mode === 'MOCK' &&
    ['development', 'test'].includes(String(env.NODE_ENV || 'development'))
  ) {
    logger.info(
      `[DEV ONLY] Pre-onboarding portal for ${preOnboarding.preOnboardingCode} → ${preOnboarding.candidateSnapshot.email}: ${portalUrl}`
    );
  }

  await PreOnboarding.updateOne(
    { _id: preOnboarding._id, companyId },
    {
      $set: {
        invitedAt: new Date(),
        'invite.lastSentAt': new Date(),
        'invite.mode': delivery.mode,
        'invite.lastError': delivery.delivered
          ? ''
          : String(delivery.error || 'Delivery failed').slice(0, 500),
      },
    }
  );

  return delivery;
};

export const startPreOnboarding = async ({
  companyId,
  candidateId,
  actorId,
  requestContext = null,
  sendInvite = true,
}) => {
  if (!isObjectId(candidateId) || !isObjectId(actorId)) {
    throw ApiError.badRequest('A valid candidate and actor are required');
  }

  const existing = await PreOnboarding.findOne({
    companyId,
    candidate: candidateId,
    activeKey: 'ACTIVE',
  }).select('+activeKey');

  if (existing) {
    const refreshed = await refreshCaseCounters({
      companyId,
      preOnboarding: existing,
      actorId,
      actorType: 'TENANT_USER',
    });
    return {
      ...safePreOnboardingDto(refreshed.preOnboarding, {
        requirements: refreshed.requirements,
        readiness: refreshed.readiness,
        includeInternal: true,
      }),
      idempotent: true,
    };
  }

  const candidate = await Candidate.findOne({
    _id: candidateId,
    companyId,
  }).lean();
  if (!candidate) throw ApiError.notFound('Candidate not found');

  if (candidate.currentStage !== 'OFFER_ACCEPTED') {
    throw ApiError.conflict(
      'Pre-onboarding can start only after the candidate accepts an offer'
    );
  }

  const offer = await OfferLetter.findOne({
    companyId,
    candidate: candidateId,
    status: 'ACCEPTED',
  })
    .sort({ acceptedAt: -1, createdAt: -1 })
    .lean();

  if (!offer) {
    throw ApiError.conflict('An accepted offer is required to start pre-onboarding');
  }

  await ensureDefaultDocumentRequirements({ companyId, actorId });

  const company = await Company.findById(companyId)
    .select('name address country')
    .lean();
  if (!company) throw ApiError.notFound('Company not found');

  const activeRequirements = await PreOnboardingDocumentRequirement.find({
    companyId,
    active: true,
  })
    .sort({ displayOrder: 1, name: 1 })
    .lean();

  if (!activeRequirements.length) {
    throw ApiError.badRequest(
      'Configure at least one active document requirement before starting pre-onboarding'
    );
  }

  const companyAddress = [
    company.address?.line1 || company.address?.street || '',
    company.address?.city || '',
    company.address?.state || '',
    company.address?.postalCode || company.address?.zip || '',
    company.country || company.address?.country || '',
  ]
    .filter(Boolean)
    .join(', ');

  let preOnboarding;
  try {
    preOnboarding = await PreOnboarding.create({
      companyId,
      preOnboardingCode: await nextPreOnboardingCode(companyId),
      candidate: candidate._id,
      offer: offer._id,
      job: offer.job || candidate.job,
      requisition: offer.requisition || candidate.requisition || null,
      status: 'IN_PROGRESS',
      candidateSnapshot: {
        name: candidate.name,
        email: candidate.email,
        candidateCode: candidate.candidateCode || '',
        phone: candidate.phone || '',
      },
      offerSnapshot: {
        offerId: offer._id,
        offerCode: offer.offerCode,
        joiningDate: offer.terms.joiningDate,
        designation: offer.terms.designation || '',
        departmentName: offer.terms.departmentName || '',
        location: offer.terms.location || '',
        employmentType: offer.terms.employmentType || '',
        workMode: offer.terms.workMode || '',
      },
      jobSnapshot: {
        title: offer.jobSnapshot?.title || 'Open role',
        jobCode: offer.jobSnapshot?.jobCode || '',
      },
      companySnapshot: {
        name: company.name,
        address: companyAddress,
      },
      startedAt: new Date(),
      requiredDocumentCount: activeRequirements.filter((item) => item.required)
        .length,
      verifiedRequiredDocumentCount: 0,
      createdBy: actorId,
      updatedBy: actorId,
    });
  } catch (error) {
    if (error.code === 11000) {
      const raced = await PreOnboarding.findOne({
        companyId,
        candidate: candidateId,
        activeKey: 'ACTIVE',
      }).select('+activeKey');
      if (raced) {
        const refreshed = await refreshCaseCounters({
          companyId,
          preOnboarding: raced,
          actorId,
          actorType: 'TENANT_USER',
        });
        return {
          ...safePreOnboardingDto(refreshed.preOnboarding, {
            requirements: refreshed.requirements,
            readiness: refreshed.readiness,
            includeInternal: true,
          }),
          idempotent: true,
        };
      }
    }
    throw error;
  }

  await CandidateDocumentRequirement.insertMany(
    activeRequirements.map((item) => ({
      companyId,
      candidate: candidate._id,
      preOnboarding: preOnboarding._id,
      requirement: item._id,
      code: item.code,
      nameSnapshot: item.name,
      descriptionSnapshot: item.description || '',
      categorySnapshot: item.category,
      required: item.required,
      instructionsSnapshot: item.instructions || '',
      fileRulesSnapshot: {
        allowedFileTypes: item.allowedFileTypes,
        maxFileSize: item.maxFileSize,
        requiresExpiryDate: item.requiresExpiryDate,
        requiresDocumentNumber: item.requiresDocumentNumber,
      },
      displayOrder: item.displayOrder,
      status: 'PENDING',
    }))
  );

  let pipelineTransition = null;
  try {
    pipelineTransition = await transitionCandidateStage({
      companyId,
      candidateId: candidate._id,
      targetStage: 'PRE_ONBOARDING',
      reason: `${preOnboarding.preOnboardingCode} started after offer acceptance`,
      actorId,
      metadata: {
        source: 'PIPELINE',
        action: 'PRE_ONBOARDING_STARTED',
        actorType: 'TENANT_USER',
      },
      requestContext,
    });
  } catch (error) {
    await CandidateDocumentRequirement.deleteMany({
      companyId,
      preOnboarding: preOnboarding._id,
    }).catch(() => {});
    await PreOnboarding.deleteOne({ _id: preOnboarding._id, companyId }).catch(
      () => {}
    );
    throw error;
  }

  await recordHistory({
    companyId,
    preOnboarding,
    action: 'PRE_ONBOARDING_STARTED',
    previousStatus: 'NOT_STARTED',
    newStatus: 'IN_PROGRESS',
    actorType: 'TENANT_USER',
    actorId,
    metadata: {
      offerCode: offer.offerCode,
      requirementCount: activeRequirements.length,
    },
  });

  await recordCandidateTimeline({
    companyId,
    candidate: candidate._id,
    job: preOnboarding.job,
    action: 'PRE_ONBOARDING_STARTED',
    actorType: 'TENANT_USER',
    actorId,
    metadata: {
      preOnboardingCode: preOnboarding.preOnboardingCode,
      offerCode: offer.offerCode,
      requirementCount: activeRequirements.length,
    },
  });

  await recordAudit({
    req: requestContext,
    action: 'PRE_ONBOARDING_STARTED',
    companyId,
    actorId,
    resource: 'PreOnboarding',
    resourceId: preOnboarding._id,
    newValue: { status: 'IN_PROGRESS' },
    metadata: {
      preOnboardingCode: preOnboarding.preOnboardingCode,
      candidateId: candidate._id,
      offerId: offer._id,
      pipelineHistoryId: pipelineTransition?.pipelineHistoryId,
    },
    critical: true,
  });

  const { rawToken } = await issuePreOnboardingToken({
    companyId,
    preOnboardingId: preOnboarding._id,
    candidateId: candidate._id,
    expiresAt: tokenExpiryDate(),
    actorId,
  });

  if (sendInvite) {
    const delivery = await sendInviteEmail({
      preOnboarding,
      rawToken,
      companyId,
    });
    await recordHistory({
      companyId,
      preOnboarding,
      action: 'PRE_ONBOARDING_INVITED',
      previousStatus: 'IN_PROGRESS',
      newStatus: 'IN_PROGRESS',
      actorType: 'TENANT_USER',
      actorId,
      metadata: {
        delivered: Boolean(delivery.delivered),
        mode: delivery.mode,
      },
    });
    await recordCandidateTimeline({
      companyId,
      candidate: candidate._id,
      job: preOnboarding.job,
      action: 'DOCUMENT_REQUESTED',
      actorType: 'TENANT_USER',
      actorId,
      metadata: {
        preOnboardingCode: preOnboarding.preOnboardingCode,
        requirementCount: activeRequirements.length,
      },
    });
  }

  await notifyPreOnboardingStarted({ companyId, preOnboarding });

  const refreshed = await refreshCaseCounters({
    companyId,
    preOnboarding,
    actorId,
    actorType: 'TENANT_USER',
  });

  return {
    ...safePreOnboardingDto(refreshed.preOnboarding, {
      requirements: refreshed.requirements,
      readiness: refreshed.readiness,
      includeInternal: true,
    }),
    idempotent: false,
  };
};

export const resendPreOnboardingInvite = async ({
  companyId,
  preOnboardingId,
  actorId,
  requestContext = null,
}) => {
  const { preOnboarding, requirements, readiness } = await loadCaseBundle({
    companyId,
    preOnboardingId,
  });

  if (['READY_TO_JOIN', 'WITHDRAWN'].includes(preOnboarding.status)) {
    throw ApiError.conflict('Invite cannot be resent for this pre-onboarding case');
  }

  const { rawToken } = await issuePreOnboardingToken({
    companyId,
    preOnboardingId: preOnboarding._id,
    candidateId: preOnboarding.candidate,
    expiresAt: tokenExpiryDate(),
    actorId,
  });

  const delivery = await sendInviteEmail({
    preOnboarding,
    rawToken,
    companyId,
  });

  await recordHistory({
    companyId,
    preOnboarding,
    action: 'PRE_ONBOARDING_INVITED',
    previousStatus: preOnboarding.status,
    newStatus: preOnboarding.status,
    actorType: 'TENANT_USER',
    actorId,
    metadata: {
      delivered: Boolean(delivery.delivered),
      mode: delivery.mode,
      resend: true,
    },
  });

  await recordAudit({
    req: requestContext,
    action: 'PRE_ONBOARDING_INVITED',
    companyId,
    actorId,
    resource: 'PreOnboarding',
    resourceId: preOnboarding._id,
    metadata: {
      preOnboardingCode: preOnboarding.preOnboardingCode,
      delivered: Boolean(delivery.delivered),
    },
    critical: true,
  });

  return safePreOnboardingDto(preOnboarding, {
    requirements,
    readiness,
    includeInternal: true,
  });
};

export const listPreOnboardings = async ({ companyId, query = {} }) => {
  const filter = { companyId };
  if (query.status) filter.status = String(query.status).toUpperCase();
  if (query.jobId && isObjectId(query.jobId)) filter.job = query.jobId;

  if (query.search) {
    const term = String(query.search).trim();
    filter.$or = [
      { 'candidateSnapshot.name': new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
      { 'candidateSnapshot.email': new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
      { 'candidateSnapshot.candidateCode': new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
      { preOnboardingCode: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
      { 'jobSnapshot.title': new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    ];
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const skip = (page - 1) * limit;

  const [rows, total, kpiRows] = await Promise.all([
    PreOnboarding.find(filter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    PreOnboarding.countDocuments(filter),
    PreOnboarding.aggregate([
      { $match: { companyId: new mongoose.Types.ObjectId(String(companyId)) } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  const kpis = Object.fromEntries(kpiRows.map((row) => [row._id, row.count]));
  const acceptedOfferCount = await Candidate.countDocuments({
    companyId,
    currentStage: 'OFFER_ACCEPTED',
  });

  const requirementGroups = await CandidateDocumentRequirement.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(String(companyId)),
        preOnboarding: { $in: rows.map((row) => row._id) },
      },
    },
    {
      $group: {
        _id: '$preOnboarding',
        items: { $push: '$$ROOT' },
      },
    },
  ]);
  const requirementMap = new Map(
    requirementGroups.map((group) => [String(group._id), group.items])
  );

  return {
    cases: rows.map((row) => {
      const requirements = requirementMap.get(String(row._id)) || [];
      const readiness = evaluatePreOnboardingReadiness(requirements);
      return safePreOnboardingDto(row, {
        requirements,
        readiness,
        includeInternal: true,
      });
    }),
    meta: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      kpis: {
        offerAccepted: acceptedOfferCount,
        inProgress: kpis.IN_PROGRESS || 0,
        actionRequired: kpis.ACTION_REQUIRED || 0,
        underReview: kpis.UNDER_REVIEW || 0,
        completed: kpis.COMPLETED || 0,
        readyToJoin: kpis.READY_TO_JOIN || 0,
      },
    },
  };
};

export const getPreOnboarding = async ({ companyId, preOnboardingId }) => {
  const { preOnboarding, requirements, readiness } = await loadCaseBundle({
    companyId,
    preOnboardingId,
  });

  const documents = await CandidateDocument.find({
    companyId,
    preOnboarding: preOnboarding._id,
  })
    .sort({ updatedAt: -1 })
    .lean();

  const versions = await CandidateDocumentVersion.find({
    companyId,
    preOnboarding: preOnboarding._id,
    isActive: true,
  })
    .select('-storageKey -checksumSha256')
    .lean();

  const versionMap = new Map(
    versions.map((version) => [String(version.candidateDocument), version])
  );

  const history = await PreOnboardingHistory.find({
    companyId,
    preOnboarding: preOnboarding._id,
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  return {
    case: safePreOnboardingDto(preOnboarding, {
      requirements,
      readiness,
      includeInternal: true,
    }),
    documents: documents.map((document) =>
      documentDto(document, versionMap.get(String(document._id)))
    ),
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

export const verifyCandidateDocument = async ({
  companyId,
  preOnboardingId,
  documentId,
  actorId,
  requestContext = null,
}) => {
  if (!isObjectId(documentId)) throw ApiError.notFound('Document not found');

  const { preOnboarding } = await loadCaseBundle({
    companyId,
    preOnboardingId,
  });

  if (['READY_TO_JOIN', 'WITHDRAWN'].includes(preOnboarding.status)) {
    throw ApiError.conflict('Documents cannot be reviewed in this state');
  }

  const document = await CandidateDocument.findOne({
    _id: documentId,
    companyId,
    preOnboarding: preOnboarding._id,
  });
  if (!document) throw ApiError.notFound('Document not found');

  if (!['UPLOADED', 'UNDER_REVIEW', 'REJECTED', 'RESUBMISSION_REQUIRED'].includes(document.status)) {
    if (document.status === 'VERIFIED') {
      const refreshed = await refreshCaseCounters({
        companyId,
        preOnboarding,
        actorId,
        actorType: 'TENANT_USER',
      });
      return {
        case: safePreOnboardingDto(refreshed.preOnboarding, {
          requirements: refreshed.requirements,
          readiness: refreshed.readiness,
          includeInternal: true,
        }),
        document: documentDto(document),
        idempotent: true,
      };
    }
    throw ApiError.conflict('Only uploaded documents can be verified');
  }

  const now = new Date();
  document.status = 'VERIFIED';
  document.reviewedAt = now;
  document.reviewedBy = actorId;
  document.rejectionReason = '';
  await document.save();

  await CandidateDocumentVersion.updateOne(
    {
      _id: document.activeVersion,
      companyId,
      candidateDocument: document._id,
    },
    {
      $set: {
        status: 'VERIFIED',
        reviewedAt: now,
        reviewedBy: actorId,
        rejectionReason: '',
      },
    }
  );

  await CandidateDocumentRequirement.updateOne(
    {
      _id: document.candidateRequirement,
      companyId,
      preOnboarding: preOnboarding._id,
    },
    {
      $set: {
        status: 'VERIFIED',
        verifiedAt: now,
        verifiedBy: actorId,
        rejectionReason: '',
        activeDocument: document._id,
      },
    }
  );

  await recordHistory({
    companyId,
    preOnboarding,
    action: 'DOCUMENT_VERIFIED',
    previousStatus: preOnboarding.status,
    newStatus: preOnboarding.status,
    actorType: 'TENANT_USER',
    actorId,
    metadata: {
      documentCode: document.documentCode,
      requirementCode: document.requirementCode,
    },
  });

  await recordCandidateTimeline({
    companyId,
    candidate: preOnboarding.candidate,
    job: preOnboarding.job,
    action: 'DOCUMENT_VERIFIED',
    actorType: 'TENANT_USER',
    actorId,
    metadata: {
      requirementCode: document.requirementCode,
      documentCode: document.documentCode,
    },
  });

  await recordAudit({
    req: requestContext,
    action: 'DOCUMENT_VERIFIED',
    companyId,
    actorId,
    resource: 'CandidateDocument',
    resourceId: document._id,
    previousValue: { status: 'UNDER_REVIEW' },
    newValue: { status: 'VERIFIED' },
    metadata: {
      preOnboardingCode: preOnboarding.preOnboardingCode,
      requirementCode: document.requirementCode,
    },
    critical: true,
  });

  const requirement = await CandidateDocumentRequirement.findOne({
    _id: document.candidateRequirement,
    companyId,
  }).lean();

  await sendMail({
    to: preOnboarding.candidateSnapshot.email,
    ...preOnboardingDocumentDecisionEmail({
      candidateName: preOnboarding.candidateSnapshot.name,
      companyName: preOnboarding.companySnapshot.name,
      requirementName: requirement?.nameSnapshot || document.requirementCode,
      decision: 'VERIFIED',
    }),
    sensitive: true,
  });

  const refreshed = await refreshCaseCounters({
    companyId,
    preOnboarding,
    actorId,
    actorType: 'TENANT_USER',
  });

  if (
    refreshed.readiness.ready &&
    refreshed.readiness.totalRequired > 0
  ) {
    await notifyAllMandatorySubmitted({
      companyId,
      preOnboarding: refreshed.preOnboarding,
    }).catch(() => {});
  }

  return {
    case: safePreOnboardingDto(refreshed.preOnboarding, {
      requirements: refreshed.requirements,
      readiness: refreshed.readiness,
      includeInternal: true,
    }),
    document: documentDto(document),
    idempotent: false,
  };
};

export const rejectCandidateDocument = async ({
  companyId,
  preOnboardingId,
  documentId,
  actorId,
  reason,
  requestContext = null,
}) => {
  const rejectionReason = safeReason(reason);
  if (!rejectionReason) {
    throw ApiError.badRequest('A rejection reason is required');
  }
  if (!isObjectId(documentId)) throw ApiError.notFound('Document not found');

  const { preOnboarding } = await loadCaseBundle({
    companyId,
    preOnboardingId,
  });

  if (['READY_TO_JOIN', 'WITHDRAWN'].includes(preOnboarding.status)) {
    throw ApiError.conflict('Documents cannot be reviewed in this state');
  }

  const document = await CandidateDocument.findOne({
    _id: documentId,
    companyId,
    preOnboarding: preOnboarding._id,
  });
  if (!document) throw ApiError.notFound('Document not found');

  if (!['UPLOADED', 'UNDER_REVIEW', 'VERIFIED'].includes(document.status)) {
    throw ApiError.conflict('This document cannot be rejected in its current state');
  }

  const now = new Date();
  document.status = 'RESUBMISSION_REQUIRED';
  document.reviewedAt = now;
  document.reviewedBy = actorId;
  document.rejectionReason = rejectionReason;
  await document.save();

  await CandidateDocumentVersion.updateOne(
    {
      _id: document.activeVersion,
      companyId,
      candidateDocument: document._id,
    },
    {
      $set: {
        status: 'RESUBMISSION_REQUIRED',
        reviewedAt: now,
        reviewedBy: actorId,
        rejectionReason,
      },
    }
  );

  await CandidateDocumentRequirement.updateOne(
    {
      _id: document.candidateRequirement,
      companyId,
      preOnboarding: preOnboarding._id,
    },
    {
      $set: {
        status: 'RESUBMISSION_REQUIRED',
        rejectionReason,
        verifiedAt: null,
        verifiedBy: null,
        activeDocument: document._id,
      },
    }
  );

  await recordHistory({
    companyId,
    preOnboarding,
    action: 'DOCUMENT_RESUBMISSION_REQUIRED',
    previousStatus: preOnboarding.status,
    newStatus: preOnboarding.status,
    actorType: 'TENANT_USER',
    actorId,
    reason: rejectionReason,
    metadata: {
      documentCode: document.documentCode,
      requirementCode: document.requirementCode,
    },
  });

  await recordCandidateTimeline({
    companyId,
    candidate: preOnboarding.candidate,
    job: preOnboarding.job,
    action: 'DOCUMENT_RESUBMISSION_REQUIRED',
    actorType: 'TENANT_USER',
    actorId,
    metadata: {
      requirementCode: document.requirementCode,
      documentCode: document.documentCode,
      reason: rejectionReason,
    },
  });

  await recordAudit({
    req: requestContext,
    action: 'DOCUMENT_REJECTED',
    companyId,
    actorId,
    resource: 'CandidateDocument',
    resourceId: document._id,
    previousValue: { status: 'UNDER_REVIEW' },
    newValue: { status: 'RESUBMISSION_REQUIRED' },
    metadata: {
      preOnboardingCode: preOnboarding.preOnboardingCode,
      requirementCode: document.requirementCode,
      reason: rejectionReason,
    },
    critical: true,
  });

  const requirement = await CandidateDocumentRequirement.findOne({
    _id: document.candidateRequirement,
    companyId,
  }).lean();

  await sendMail({
    to: preOnboarding.candidateSnapshot.email,
    ...preOnboardingDocumentDecisionEmail({
      candidateName: preOnboarding.candidateSnapshot.name,
      companyName: preOnboarding.companySnapshot.name,
      requirementName: requirement?.nameSnapshot || document.requirementCode,
      decision: 'RESUBMISSION_REQUIRED',
      reason: rejectionReason,
    }),
    sensitive: true,
  });

  const refreshed = await refreshCaseCounters({
    companyId,
    preOnboarding,
    actorId,
    actorType: 'TENANT_USER',
  });

  return {
    case: safePreOnboardingDto(refreshed.preOnboarding, {
      requirements: refreshed.requirements,
      readiness: refreshed.readiness,
      includeInternal: true,
    }),
    document: documentDto(document),
  };
};

export const markPreOnboardingReady = async ({
  companyId,
  preOnboardingId,
  actorId,
  requestContext = null,
}) => {
  const { preOnboarding, requirements, readiness } = await loadCaseBundle({
    companyId,
    preOnboardingId,
  });

  if (preOnboarding.status === 'READY_TO_JOIN') {
    return {
      ...safePreOnboardingDto(preOnboarding, {
        requirements,
        readiness,
        includeInternal: true,
      }),
      idempotent: true,
    };
  }

  if (preOnboarding.status === 'WITHDRAWN') {
    throw ApiError.conflict('A withdrawn pre-onboarding case cannot be marked ready');
  }

  const liveReadiness = evaluatePreOnboardingReadiness(requirements);
  if (!liveReadiness.ready) {
    throw ApiError.conflict(
      liveReadiness.blockingReasons[0] ||
        'All mandatory documents must be verified before marking ready to join'
    );
  }

  const candidate = await Candidate.findOne({
    _id: preOnboarding.candidate,
    companyId,
  })
    .select('currentStage')
    .lean();

  if (!candidate || candidate.currentStage !== 'PRE_ONBOARDING') {
    throw ApiError.conflict(
      'Candidate must remain in PRE_ONBOARDING to be marked ready to join'
    );
  }

  const offer = await OfferLetter.findOne({
    _id: preOnboarding.offer,
    companyId,
    status: 'ACCEPTED',
  })
    .select('_id status')
    .lean();
  if (!offer) {
    throw ApiError.conflict('The accepted offer is no longer valid');
  }

  const now = new Date();
  const updated = await PreOnboarding.findOneAndUpdate(
    {
      _id: preOnboarding._id,
      companyId,
      status: { $in: ['COMPLETED', 'UNDER_REVIEW', 'IN_PROGRESS', 'ACTION_REQUIRED'] },
    },
    {
      $set: {
        status: 'READY_TO_JOIN',
        readyToJoinAt: now,
        readyToJoinBy: actorId,
        completedAt: preOnboarding.completedAt || now,
        updatedBy: actorId,
        requiredDocumentCount: liveReadiness.totalRequired,
        verifiedRequiredDocumentCount: liveReadiness.verifiedRequired,
      },
    },
    { returnDocument: 'after' }
  );

  if (!updated) {
    throw ApiError.conflict(
      'Pre-onboarding readiness changed in another request. Refresh and try again.'
    );
  }

  await revokePreOnboardingTokens({
    companyId,
    preOnboardingId: updated._id,
    reason: 'READY_TO_JOIN',
  });

  await recordHistory({
    companyId,
    preOnboarding: updated,
    action: 'PRE_ONBOARDING_READY',
    previousStatus: preOnboarding.status,
    newStatus: 'READY_TO_JOIN',
    actorType: 'TENANT_USER',
    actorId,
    metadata: { readiness: liveReadiness },
  });

  await recordCandidateTimeline({
    companyId,
    candidate: updated.candidate,
    job: updated.job,
    action: 'READY_TO_JOIN',
    actorType: 'TENANT_USER',
    actorId,
    metadata: {
      preOnboardingCode: updated.preOnboardingCode,
      verifiedRequired: liveReadiness.verifiedRequired,
      totalRequired: liveReadiness.totalRequired,
    },
  });

  await recordAudit({
    req: requestContext,
    action: 'PRE_ONBOARDING_READY',
    companyId,
    actorId,
    resource: 'PreOnboarding',
    resourceId: updated._id,
    previousValue: { status: preOnboarding.status },
    newValue: { status: 'READY_TO_JOIN' },
    metadata: {
      preOnboardingCode: updated.preOnboardingCode,
      candidateId: updated.candidate,
    },
    critical: true,
  });

  await notifyPreOnboardingReady({
    companyId,
    preOnboarding: updated,
    actorId,
  });

  await sendMail({
    to: updated.candidateSnapshot.email,
    ...preOnboardingDocumentDecisionEmail({
      candidateName: updated.candidateSnapshot.name,
      companyName: updated.companySnapshot.name,
      requirementName: 'Pre-onboarding',
      decision: 'READY_TO_JOIN',
    }),
    sensitive: true,
  });

  return {
    ...safePreOnboardingDto(updated, {
      requirements,
      readiness: liveReadiness,
      includeInternal: true,
    }),
    idempotent: false,
  };
};

export const getCandidateDocumentFile = async ({
  companyId,
  preOnboardingId,
  documentId,
  actorId = null,
  requestContext = null,
  actorType = 'TENANT_USER',
}) => {
  if (!isObjectId(documentId)) throw ApiError.notFound('Document not found');

  const document = await CandidateDocument.findOne({
    _id: documentId,
    companyId,
    preOnboarding: preOnboardingId,
  }).lean();
  if (!document) throw ApiError.notFound('Document not found');

  const version = await CandidateDocumentVersion.findOne({
    _id: document.activeVersion,
    companyId,
    candidateDocument: document._id,
  }).select('+storageKey +checksumSha256');

  if (!version) throw ApiError.notFound('Document file not found');

  const buffer = await getStoredPreOnboardingDocument({
    storageProvider: version.storageProvider,
    storageKey: version.storageKey,
  });

  const { createHash } = await import('node:crypto');
  const actualChecksum = createHash('sha256').update(buffer).digest('hex');
  if (version.checksumSha256 && version.checksumSha256 !== actualChecksum) {
    throw new ApiError(500, 'Stored document failed integrity verification');
  }

  await recordAudit({
    req: requestContext,
    action: 'DOCUMENT_ACCESSED',
    companyId,
    actorId,
    resource: 'CandidateDocument',
    resourceId: document._id,
    metadata: {
      documentCode: document.documentCode,
      requirementCode: document.requirementCode,
      actorType,
      version: version.version,
    },
    critical: true,
  });

  return {
    buffer,
    fileName: version.originalFileName,
    mimeType: version.mimeType,
    checksum: actualChecksum,
  };
};

export const uploadCandidateRequirementDocument = async ({
  companyId,
  preOnboarding,
  requirementCode,
  file,
  documentNumber = '',
  expiryDate = null,
  actorType = 'PUBLIC_CANDIDATE',
  actorId = null,
  requestContext = null,
}) => {
  if (['READY_TO_JOIN', 'WITHDRAWN'].includes(preOnboarding.status)) {
    throw ApiError.conflict('Documents can no longer be uploaded for this case');
  }

  const code = sanitizeCode(requirementCode);
  const requirement = await CandidateDocumentRequirement.findOne({
    companyId,
    preOnboarding: preOnboarding._id,
    code,
  });
  if (!requirement) throw ApiError.notFound('Document requirement not found');

  if (requirement.status === 'VERIFIED') {
    throw ApiError.conflict(
      'Verified documents cannot be replaced unless HR requests resubmission'
    );
  }

  if (
    !['PENDING', 'UPLOADED', 'UNDER_REVIEW', 'REJECTED', 'RESUBMISSION_REQUIRED'].includes(
      requirement.status
    )
  ) {
    throw ApiError.conflict('This requirement cannot accept uploads right now');
  }

  const rules = requirement.fileRulesSnapshot || {};
  const inspection = await inspectPreOnboardingFile({
    file,
    allowedMimeTypes: rules.allowedFileTypes,
    maxFileSize: rules.maxFileSize,
  });

  let maskedNumber = '';
  let numberFingerprint = '';
  if (rules.requiresDocumentNumber) {
    const rawNumber = String(documentNumber || '').trim();
    if (!rawNumber) {
      throw ApiError.badRequest('Document number is required for this requirement');
    }
    maskedNumber = maskDocumentNumber(rawNumber);
    numberFingerprint = fingerprintSensitiveValue(rawNumber);
  }

  let parsedExpiry = null;
  if (rules.requiresExpiryDate) {
    parsedExpiry = expiryDate ? new Date(expiryDate) : null;
    if (!parsedExpiry || Number.isNaN(parsedExpiry.getTime())) {
      throw ApiError.badRequest('Expiry date is required for this requirement');
    }
  } else if (expiryDate) {
    const maybe = new Date(expiryDate);
    if (!Number.isNaN(maybe.getTime())) parsedExpiry = maybe;
  }

  let document = await CandidateDocument.findOne({
    companyId,
    preOnboarding: preOnboarding._id,
    candidateRequirement: requirement._id,
  });

  const isResubmission = Boolean(
    document &&
      ['REJECTED', 'RESUBMISSION_REQUIRED', 'UPLOADED', 'UNDER_REVIEW'].includes(
        document.status
      ) &&
      document.currentVersion >= 1 &&
      requirement.status !== 'PENDING'
  );

  if (!document) {
    document = await CandidateDocument.create({
      companyId,
      candidate: preOnboarding.candidate,
      offer: preOnboarding.offer,
      preOnboarding: preOnboarding._id,
      candidateRequirement: requirement._id,
      requirementCode: requirement.code,
      documentCode: await nextCandidateDocumentCode(companyId),
      currentVersion: 0,
      status: 'UPLOADED',
      documentNumberMasked: maskedNumber,
      documentNumberFingerprint: numberFingerprint,
      expiryDate: parsedExpiry,
      uploadedAt: new Date(),
      submittedAt: new Date(),
    });
  }

  const nextVersionNumber = (document.currentVersion || 0) + 1;
  const storage = await storePreOnboardingDocument({
    buffer: file.buffer,
    companyId,
    documentCode: document.documentCode,
  });

  if (document.activeVersion) {
    await CandidateDocumentVersion.updateMany(
      {
        companyId,
        candidateDocument: document._id,
        isActive: true,
      },
      { $set: { isActive: false } }
    );
  }

  const version = await CandidateDocumentVersion.create({
    companyId,
    candidateDocument: document._id,
    preOnboarding: preOnboarding._id,
    candidate: preOnboarding.candidate,
    version: nextVersionNumber,
    isActive: true,
    originalFileName: inspection.originalFileName,
    mimeType: inspection.mimeType,
    fileSize: inspection.fileSize,
    storageProvider: storage.storageProvider,
    storageKey: storage.storageKey,
    checksumSha256: inspection.checksumSha256,
    scanStatus: inspection.scanStatus,
    scanCheckedAt: inspection.scanCheckedAt,
    status: 'UNDER_REVIEW',
    uploadedByType: actorType === 'TENANT_USER' ? 'TENANT_USER' : 'CANDIDATE',
    uploadedBy: actorId,
    documentNumberMasked: maskedNumber,
    expiryDate: parsedExpiry,
    uploadedAt: new Date(),
  });

  document.currentVersion = nextVersionNumber;
  document.activeVersion = version._id;
  document.status = 'UNDER_REVIEW';
  document.uploadedAt = version.uploadedAt;
  document.submittedAt = version.uploadedAt;
  document.reviewedAt = null;
  document.reviewedBy = null;
  document.rejectionReason = '';
  document.documentNumberMasked = maskedNumber;
  document.documentNumberFingerprint = numberFingerprint;
  document.expiryDate = parsedExpiry;
  await document.save();

  await CandidateDocumentRequirement.updateOne(
    { _id: requirement._id, companyId },
    {
      $set: {
        status: 'UNDER_REVIEW',
        activeDocument: document._id,
        lastUploadedAt: version.uploadedAt,
        rejectionReason: '',
        verifiedAt: null,
        verifiedBy: null,
      },
    }
  );

  const action = isResubmission ? 'DOCUMENT_RESUBMITTED' : 'DOCUMENT_UPLOADED';

  await recordHistory({
    companyId,
    preOnboarding,
    action,
    previousStatus: preOnboarding.status,
    newStatus: preOnboarding.status,
    actorType,
    actorId,
    metadata: {
      requirementCode: requirement.code,
      documentCode: document.documentCode,
      version: nextVersionNumber,
      scanStatus: inspection.scanStatus,
    },
  });

  await recordCandidateTimeline({
    companyId,
    candidate: preOnboarding.candidate,
    job: preOnboarding.job,
    action,
    actorType,
    actorId,
    metadata: {
      requirementCode: requirement.code,
      documentCode: document.documentCode,
      version: nextVersionNumber,
    },
  });

  await recordAudit({
    req: requestContext,
    action,
    companyId,
    actorId,
    resource: 'CandidateDocument',
    resourceId: document._id,
    newValue: {
      status: 'UNDER_REVIEW',
      version: nextVersionNumber,
    },
    metadata: {
      preOnboardingCode: preOnboarding.preOnboardingCode,
      requirementCode: requirement.code,
      scanStatus: inspection.scanStatus,
      actorType,
    },
    critical: true,
  });

  await notifyDocumentUploaded({
    companyId,
    preOnboarding,
    requirementName: requirement.nameSnapshot,
    resubmission: isResubmission,
  });

  const refreshed = await refreshCaseCounters({
    companyId,
    preOnboarding,
    actorId,
    actorType,
  });

  if (
    refreshed.readiness.missingRequired === 0 &&
    refreshed.readiness.resubmissionRequired === 0 &&
    refreshed.readiness.underReviewRequired > 0
  ) {
    await notifyAllMandatorySubmitted({
      companyId,
      preOnboarding: refreshed.preOnboarding,
    }).catch(() => {});
  }

  return {
    case: safePreOnboardingDto(refreshed.preOnboarding, {
      requirements: refreshed.requirements,
      readiness: refreshed.readiness,
      includeInternal: actorType === 'TENANT_USER',
    }),
    document: documentDto(document, version),
    requirement: requirementDto(
      refreshed.requirements.find(
        (item) => String(item._id) === String(requirement._id)
      ) || requirement
    ),
  };
};
