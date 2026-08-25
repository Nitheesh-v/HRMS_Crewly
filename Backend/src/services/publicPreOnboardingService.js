import PreOnboarding from '../models/PreOnboarding.js';
import CandidateDocument from '../models/CandidateDocument.js';
import CandidateDocumentRequirement from '../models/CandidateDocumentRequirement.js';
import ApiError from '../utils/ApiError.js';
import {
  evaluatePreOnboardingReadiness,
  getCandidateDocumentFile,
  safePreOnboardingDto,
  uploadCandidateRequirementDocument,
} from './preOnboardingService.js';
import {
  recordPreOnboardingTokenView,
  resolvePreOnboardingToken,
} from './preOnboardingTokenService.js';

const genericFailure = () => ApiError.notFound('Pre-onboarding is unavailable');

const authorityFor = async (rawToken) => {
  const tokenRecord = await resolvePreOnboardingToken(rawToken);
  const preOnboarding = await PreOnboarding.findOne({
    _id: tokenRecord.preOnboarding,
    companyId: tokenRecord.companyId,
  });

  if (!preOnboarding) throw genericFailure();
  if (['WITHDRAWN'].includes(preOnboarding.status)) throw genericFailure();

  return { tokenRecord, preOnboarding };
};

const publicBundle = async (preOnboarding) => {
  const requirements = await CandidateDocumentRequirement.find({
    companyId: preOnboarding.companyId,
    preOnboarding: preOnboarding._id,
  })
    .sort({ displayOrder: 1, createdAt: 1 })
    .lean();

  const readiness = evaluatePreOnboardingReadiness(requirements);
  return safePreOnboardingDto(preOnboarding, {
    requirements,
    readiness,
    includeInternal: false,
  });
};

export const getPublicPreOnboarding = async ({ rawToken }) => {
  const { preOnboarding } = await authorityFor(rawToken);
  return publicBundle(preOnboarding);
};

export const recordPublicPreOnboardingView = async ({ rawToken }) => {
  const { tokenRecord, preOnboarding } = await authorityFor(rawToken);
  await recordPreOnboardingTokenView(tokenRecord._id);
  return publicBundle(preOnboarding);
};

export const uploadPublicPreOnboardingDocument = async ({
  rawToken,
  requirementCode,
  file,
  documentNumber = '',
  expiryDate = null,
  requestContext = null,
}) => {
  const { preOnboarding } = await authorityFor(rawToken);
  if (preOnboarding.status === 'READY_TO_JOIN') {
    throw ApiError.conflict('This pre-onboarding case is already complete');
  }

  return uploadCandidateRequirementDocument({
    companyId: preOnboarding.companyId,
    preOnboarding,
    requirementCode,
    file,
    documentNumber,
    expiryDate,
    actorType: 'PUBLIC_CANDIDATE',
    actorId: null,
    requestContext,
  });
};

export const getPublicPreOnboardingDocument = async ({
  rawToken,
  documentCode,
  requestContext = null,
}) => {
  const { tokenRecord, preOnboarding } = await authorityFor(rawToken);
  const code = String(documentCode || '').trim().toUpperCase();

  const document = await CandidateDocument.findOne({
    companyId: preOnboarding.companyId,
    preOnboarding: preOnboarding._id,
    candidate: tokenRecord.candidate,
    documentCode: code,
  }).lean();

  if (!document) throw genericFailure();

  return getCandidateDocumentFile({
    companyId: preOnboarding.companyId,
    preOnboardingId: preOnboarding._id,
    documentId: document._id,
    actorId: null,
    actorType: 'PUBLIC_CANDIDATE',
    requestContext,
  });
};

