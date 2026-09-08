import mongoose from 'mongoose';
import Candidate from '../models/Candidate.js';
import CandidateHistory from '../models/CandidateHistory.js';
import CandidatePipelineHistory from '../models/CandidatePipelineHistory.js';
import CandidateResume from '../models/CandidateResume.js';
import ResumeParseResult from '../models/ResumeParseResult.js';
import ApiError from '../utils/ApiError.js';
import { getStoredResumeAccess } from './resumeStorageService.js';
import { normalizeCandidateStage } from './candidatePipelineService.js';

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const paginationValues = (query = {}) => ({
  page: Math.min(10000, Math.max(1, Number(query.page) || 1)),
  limit: Math.min(100, Math.max(1, Number(query.limit) || 20)),
});

const candidateReferenceFilter = (candidateRef) =>
  mongoose.isValidObjectId(candidateRef)
    ? { _id: candidateRef }
    : { candidateCode: String(candidateRef || '').trim().toUpperCase() };

const listFilter = ({ companyId, query }) => {
  const filter = { companyId };

  if (query.job) filter.job = query.job;
  if (query.source) filter.source = query.source;
  if (query.stage) filter.currentStage = query.stage;

  if (query.dateFrom || query.dateTo) {
    filter.applicationDate = {};

    if (query.dateFrom) filter.applicationDate.$gte = query.dateFrom;

    if (query.dateTo) {
      const throughDate = new Date(query.dateTo);
      throughDate.setUTCDate(throughDate.getUTCDate() + 1);
      filter.applicationDate.$lt = throughDate;
    }
  }

  if (query.search?.trim()) {
    const search = new RegExp(escapeRegex(query.search.trim()), 'i');
    const searchFields = [
      { candidateCode: search },
      { name: search },
      { email: search },
      { phone: search },
      { location: search },
      { skills: search },
    ];
    if (filter.$and) {
      filter.$and.push({ $or: searchFields });
    } else {
      filter.$or = searchFields;
    }
  }

  return filter;
};

export const listCandidateInbox = async ({ companyId, query = {} }) => {
  const { page, limit } = paginationValues(query);
  const filter = listFilter({ companyId, query });
  const [candidates, total] = await Promise.all([
    Candidate.find(filter)
      .select(
        'candidateCode name email phone location totalExperience ' +
          'relevantExperience skills source applicationDate applicationStatus currentStage stage status job assignedRecruiter hiringManager'
      )
      .populate({
        path: 'job',
        select: 'jobCode title',
        match: { companyId },
      })
      .populate({
        path: 'assignedRecruiter',
        select: 'name role status',
        match: { companyId },
      })
      .populate({
        path: 'hiringManager',
        select: 'name role status',
        match: { companyId },
      })
      .sort({ applicationDate: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Candidate.countDocuments(filter),
  ]);

  const candidateIds = candidates.map((candidate) => candidate._id);
  const resumeCandidateIds = candidateIds.length
    ? await CandidateResume.find({
        companyId,
        candidate: { $in: candidateIds },
        status: 'UPLOADED',
      }).distinct('candidate')
    : [];
  const resumeSet = new Set(resumeCandidateIds.map(String));

  return {
    candidates: candidates.map((candidate) => ({
      id: candidate._id,
      candidateCode: candidate.candidateCode,
      name: candidate.name,
      email: candidate.email,
      phone: candidate.phone || '',
      location: candidate.location || '',
      experience: {
        total: candidate.totalExperience ?? 0,
        relevant: candidate.relevantExperience ?? 0,
      },
      skills: candidate.skills || [],
      source: candidate.source || 'INTERNAL',
      applicationDate: candidate.applicationDate || null,
      applicationStatus: candidate.applicationStatus || 'APPLIED',
      currentStage: normalizeCandidateStage(
        candidate.currentStage || candidate.stage
      ),
      stage: normalizeCandidateStage(candidate.currentStage || candidate.stage),
      assignedRecruiter: candidate.assignedRecruiter
        ? {
            id: candidate.assignedRecruiter._id,
            name: candidate.assignedRecruiter.name,
            role: candidate.assignedRecruiter.role,
          }
        : null,
      hiringManager: candidate.hiringManager
        ? {
            id: candidate.hiringManager._id,
            name: candidate.hiringManager.name,
            role: candidate.hiringManager.role,
          }
        : null,
      status: candidate.status || 'ACTIVE',
      resumeAvailable: resumeSet.has(String(candidate._id)),
      job: candidate.job
        ? {
            id: candidate.job._id,
            jobCode: candidate.job.jobCode,
            title: candidate.job.title,
          }
        : null,
    })),
    meta: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

export const getCandidateInboxDetail = async ({
  companyId,
  candidateRef,
}) => {
  const candidate = await Candidate.findOne({
    companyId,
    ...candidateReferenceFilter(candidateRef),
  })
    .select(
      'candidateCode name email phone location currentCompany currentJobTitle ' +
        'totalExperience relevantExperience expectedSalary noticePeriod ' +
        'education skills links source applicationDate applicationStatus status currentStage stage job requisition consent assignedRecruiter hiringManager'
    )
    .populate({
      path: 'job',
      select: 'jobCode title location employmentType workMode department sourceRequisition',
      match: { companyId },
      populate: { path: 'department', select: 'name' },
    })
    .populate({
      path: 'assignedRecruiter',
      select: 'name email role status',
      match: { companyId },
    })
    .populate({
      path: 'hiringManager',
      select: 'name email role status',
      match: { companyId },
    })
    .lean();

  if (!candidate) throw ApiError.notFound('Candidate not found');

  const [resume, history, pipelineHistory] = await Promise.all([
    CandidateResume.findOne({
      companyId,
      candidate: candidate._id,
      status: 'UPLOADED',
    })
      .select(
        'originalFileName mimeType fileSize status scanStatus parsingStatus parserVersion parsingAttempts parsingRequestedAt parsingStartedAt parsingCompletedAt uploadedAt'
      )
      .lean(),
    CandidateHistory.find({
      companyId,
      candidate: candidate._id,
    })
      .select('action actor actorType eventAt metadata -_id')
      .populate({ path: 'actor', select: 'name' })
      .sort({ eventAt: -1 })
      .limit(50)
      .lean(),
    CandidatePipelineHistory.find({
      companyId,
      candidateId: candidate._id,
    })
      .select(
        'fromStage toStage changedBy changeReason metadata createdAt -_id'
      )
      .populate({ path: 'changedBy', select: 'name' })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
  ]);

  const timeline = [
    ...history.map((event) => ({
      type: 'ACTIVITY',
      action: event.action,
      actorType: event.actorType,
      actor: event.actor
        ? { id: event.actor._id, name: event.actor.name }
        : null,
      eventAt: event.eventAt,
      fromStage: null,
      toStage: null,
      reason: '',
      metadata: {
        ...(event.metadata?.stage ? { stage: event.metadata.stage } : {}),
        ...(event.metadata?.jobCode
          ? { jobCode: event.metadata.jobCode }
          : {}),
        ...(event.metadata?.offerCode
          ? { offerCode: String(event.metadata.offerCode).slice(0, 40) }
          : {}),
        ...(event.metadata?.deliveryMode
          ? { deliveryMode: event.metadata.deliveryMode }
          : {}),
        ...(event.metadata?.assignmentType
          ? { assignmentType: event.metadata.assignmentType }
          : {}),
        ...(event.metadata?.assigneeName
          ? { assigneeName: String(event.metadata.assigneeName).slice(0, 150) }
          : {}),
        ...(event.metadata?.template
          ? { template: event.metadata.template }
          : {}),
        ...(event.metadata?.delivered !== undefined
          ? { delivered: Boolean(event.metadata.delivered) }
          : {}),
        ...(event.metadata?.parserVersion
          ? { parserVersion: event.metadata.parserVersion }
          : {}),
        ...(event.metadata?.status ? { status: event.metadata.status } : {}),
        ...(event.metadata?.attempt !== undefined
          ? { attempt: Number(event.metadata.attempt) || 0 }
          : {}),
        ...(event.metadata?.failureCategory
          ? { failureCategory: event.metadata.failureCategory }
          : {}),
        ...(event.metadata?.warningCount !== undefined
          ? { warningCount: Number(event.metadata.warningCount) || 0 }
          : {}),
        ...(event.metadata?.score !== undefined
          ? { score: Number(event.metadata.score) || 0 }
          : {}),
        ...(event.metadata?.category
          ? { category: event.metadata.category }
          : {}),
        ...(event.metadata?.engineVersion
          ? { engineVersion: event.metadata.engineVersion }
          : {}),
        ...(event.metadata?.trigger
          ? { trigger: event.metadata.trigger }
          : {}),
        ...(event.metadata?.interviewId
          ? { interviewId: event.metadata.interviewId }
          : {}),
        ...(event.metadata?.interviewCode
          ? { interviewCode: String(event.metadata.interviewCode).slice(0, 30) }
          : {}),
        ...(event.metadata?.roundKey
          ? { roundKey: String(event.metadata.roundKey).slice(0, 80) }
          : {}),
        ...(event.metadata?.roundName
          ? { roundName: String(event.metadata.roundName).slice(0, 120) }
          : {}),
        ...(event.metadata?.recommendation
          ? { recommendation: String(event.metadata.recommendation).slice(0, 40) }
          : {}),
        ...(event.metadata?.overallScore !== undefined
          ? { overallScore: Number(event.metadata.overallScore) || 0 }
          : {}),
        ...(event.metadata?.maxOverallScore !== undefined
          ? { maxOverallScore: Number(event.metadata.maxOverallScore) || 10 }
          : {}),
        ...(event.metadata?.decision
          ? { decision: String(event.metadata.decision).slice(0, 40) }
          : {}),
        ...(event.metadata?.reasonCategory
          ? { reasonCategory: String(event.metadata.reasonCategory).slice(0, 80) }
          : {}),
        ...(event.metadata?.scheduledStartAt
          ? { scheduledStartAt: event.metadata.scheduledStartAt }
          : {}),
        ...(event.metadata?.scheduledEndAt
          ? { scheduledEndAt: event.metadata.scheduledEndAt }
          : {}),
        ...(event.metadata?.previousScheduledStartAt
          ? { previousScheduledStartAt: event.metadata.previousScheduledStartAt }
          : {}),
        ...(event.metadata?.previousScheduledEndAt
          ? { previousScheduledEndAt: event.metadata.previousScheduledEndAt }
          : {}),
        ...(event.metadata?.timezone
          ? { timezone: String(event.metadata.timezone).slice(0, 100) }
          : {}),
      },
    })),
    ...pipelineHistory.map((event) => ({
      type: 'STAGE_TRANSITION',
      action: 'STAGE_CHANGED',
      actorType: event.metadata?.actorType || 'USER',
      actor: event.changedBy
        ? { id: event.changedBy._id, name: event.changedBy.name }
        : null,
      eventAt: event.createdAt,
      fromStage: event.fromStage,
      toStage: event.toStage,
      reason: event.changeReason || '',
      metadata: {
        ...(event.metadata?.source ? { source: event.metadata.source } : {}),
        ...(event.metadata?.action ? { action: event.metadata.action } : {}),
      },
    })),
  ].sort(
    (left, right) =>
      new Date(left.eventAt).getTime() - new Date(right.eventAt).getTime()
  );

  return {
    id: candidate._id,
    candidateCode: candidate.candidateCode,
    overview: {
      id: candidate._id,
      candidateCode: candidate.candidateCode || '',
      name: candidate.name,
      email: candidate.email,
      phone: candidate.phone || '',
      location: candidate.location || '',
      source: candidate.source || 'INTERNAL',
      currentStage: normalizeCandidateStage(
        candidate.currentStage || candidate.stage
      ),
      stage: normalizeCandidateStage(candidate.currentStage || candidate.stage),
      status: candidate.status || 'ACTIVE',
      applicationDate: candidate.applicationDate || null,
      applicationStatus: candidate.applicationStatus || 'APPLIED',
    },
    professional: {
      currentCompany: candidate.currentCompany || '',
      currentTitle: candidate.currentJobTitle || '',
      totalExperience: candidate.totalExperience ?? 0,
      relevantExperience: candidate.relevantExperience ?? 0,
      expectedSalary: candidate.expectedSalary ?? null,
      noticePeriod: candidate.noticePeriod ?? null,
    },
    education: {
      degree: candidate.education?.degree || '',
      institution: candidate.education?.institution || '',
      graduationYear: candidate.education?.graduationYear ?? null,
    },
    skills: candidate.skills || [],
    links: {
      linkedIn: candidate.links?.linkedIn || '',
      github: candidate.links?.github || '',
      portfolio: candidate.links?.portfolio || '',
    },
    assignments: {
      recruiter: candidate.assignedRecruiter
        ? {
            id: candidate.assignedRecruiter._id,
            name: candidate.assignedRecruiter.name,
            email: candidate.assignedRecruiter.email,
            role: candidate.assignedRecruiter.role,
          }
        : null,
      hiringManager: candidate.hiringManager
        ? {
            id: candidate.hiringManager._id,
            name: candidate.hiringManager.name,
            email: candidate.hiringManager.email,
            role: candidate.hiringManager.role,
          }
        : null,
    },
    job: candidate.job
      ? {
          id: candidate.job._id,
          jobCode: candidate.job.jobCode,
          title: candidate.job.title,
          department: candidate.job.department?.name || '',
          location: candidate.job.location || '',
          employmentType: candidate.job.employmentType,
          workMode: candidate.job.workMode,
          requisition:
            candidate.requisition || candidate.job.sourceRequisition || null,
        }
      : null,
    processingStatus: 'NOT_PROCESSED',
    resume: resume
      ? {
          available: true,
          originalFileName: resume.originalFileName,
          mimeType: resume.mimeType,
          fileSize: resume.fileSize,
          scanStatus: resume.scanStatus,
          parsingStatus: resume.parsingStatus,
          parserVersion: resume.parserVersion || '',
          parsingAttempts: resume.parsingAttempts || 0,
          parsingRequestedAt: resume.parsingRequestedAt || null,
          parsingStartedAt: resume.parsingStartedAt || null,
          parsingCompletedAt: resume.parsingCompletedAt || null,
          uploadedAt: resume.uploadedAt,
        }
      : { available: false },
    timeline,
    history: history.map((event) => ({
      action: event.action,
      actorType: event.actorType,
      eventAt: event.eventAt,
      metadata: {
        ...(event.metadata?.stage ? { stage: event.metadata.stage } : {}),
        ...(event.metadata?.jobCode
          ? { jobCode: event.metadata.jobCode }
          : {}),
        ...(event.metadata?.offerCode
          ? { offerCode: String(event.metadata.offerCode).slice(0, 40) }
          : {}),
        ...(event.metadata?.deliveryMode
          ? { deliveryMode: event.metadata.deliveryMode }
          : {}),
        ...(event.metadata?.delivered !== undefined
          ? { delivered: Boolean(event.metadata.delivered) }
          : {}),
        ...(event.metadata?.parserVersion
          ? { parserVersion: event.metadata.parserVersion }
          : {}),
        ...(event.metadata?.status ? { status: event.metadata.status } : {}),
        ...(event.metadata?.attempt !== undefined
          ? { attempt: Number(event.metadata.attempt) || 0 }
          : {}),
        ...(event.metadata?.failureCategory
          ? { failureCategory: event.metadata.failureCategory }
          : {}),
        ...(event.metadata?.warningCount !== undefined
          ? { warningCount: Number(event.metadata.warningCount) || 0 }
          : {}),
        ...(event.metadata?.score !== undefined
          ? { score: Number(event.metadata.score) || 0 }
          : {}),
        ...(event.metadata?.category
          ? { category: event.metadata.category }
          : {}),
        ...(event.metadata?.engineVersion
          ? { engineVersion: event.metadata.engineVersion }
          : {}),
        ...(event.metadata?.trigger
          ? { trigger: event.metadata.trigger }
          : {}),
      },
    })),
  };
};

const currentParsingStatus = (value) =>
  ({
    NOT_REQUESTED: 'PENDING',
    PARSING_PENDING: 'PENDING',
    PARSING: 'PROCESSING',
    PARSED: 'COMPLETED',
  })[value] || value || 'PENDING';

const safeParsedData = (value = {}) => ({
  identity: {
    name: value.identity?.name || '',
    email: value.identity?.email || '',
    phone: value.identity?.phone || '',
    location: value.identity?.location || '',
  },
  summary: value.summary || '',
  skills: Array.isArray(value.skills) ? value.skills : [],
  education: Array.isArray(value.education) ? value.education : [],
  workExperience: Array.isArray(value.workExperience)
    ? value.workExperience
    : [],
  derivedExperienceMonths: value.derivedExperienceMonths || 0,
  certifications: Array.isArray(value.certifications)
    ? value.certifications
    : [],
  projects: Array.isArray(value.projects) ? value.projects : [],
  links: Array.isArray(value.links) ? value.links : [],
  languages: Array.isArray(value.languages) ? value.languages : [],
  awards: Array.isArray(value.awards) ? value.awards : [],
  achievements: Array.isArray(value.achievements) ? value.achievements : [],
  publications: Array.isArray(value.publications) ? value.publications : [],
  volunteering: Array.isArray(value.volunteering) ? value.volunteering : [],
});

export const getCandidateParsedResume = async ({
  companyId,
  candidateRef,
}) => {
  const candidate = await Candidate.findOne({
    companyId,
    ...candidateReferenceFilter(candidateRef),
  })
    .select('_id candidateCode')
    .lean();

  if (!candidate) throw ApiError.notFound('Candidate not found');

  const resume = await CandidateResume.findOne({
    companyId,
    candidate: candidate._id,
    status: 'UPLOADED',
    scanStatus: { $ne: 'REJECTED' },
  })
    .select(
      'parsingStatus parserVersion parsingAttempts parsingRequestedAt parsingStartedAt parsingCompletedAt'
    )
    .lean();

  if (!resume) throw ApiError.notFound('Resume not found');

  const result = await ResumeParseResult.findOne({
    companyId,
    candidate: candidate._id,
    resume: resume._id,
  })
    .select(
      'source parserVersion extractorVersion status structuredData warnings extractionConfidence attemptCount requestedAt startedAt completedAt failedAt nextRetryAllowedAt failureCategory safeErrorMessage processingMetadata createdAt updatedAt'
    )
    .sort({ createdAt: -1 })
    .lean();
  const status = currentParsingStatus(resume.parsingStatus || result?.status);
  const retryBlocked = ['PENDING', 'RETRY_PENDING', 'PROCESSING'].includes(status);
  const cooldownBlocked =
    result?.nextRetryAllowedAt &&
    new Date(result.nextRetryAllowedAt).getTime() > Date.now();

  return {
    candidateCode: candidate.candidateCode,
    source: 'RESUME_PARSER',
    status,
    parserVersion: result?.parserVersion || resume.parserVersion || '',
    extractorVersion: result?.extractorVersion || '',
    attemptCount: result?.attemptCount || resume.parsingAttempts || 0,
    requestedAt: result?.requestedAt || resume.parsingRequestedAt || null,
    startedAt: result?.startedAt || resume.parsingStartedAt || null,
    completedAt: result?.completedAt || resume.parsingCompletedAt || null,
    failedAt: result?.failedAt || null,
    nextRetryAllowedAt: result?.nextRetryAllowedAt || null,
    warnings: Array.isArray(result?.warnings) ? result.warnings : [],
    extractionConfidence: {
      overall: result?.extractionConfidence?.overall || 0,
      textExtraction: result?.extractionConfidence?.textExtraction || 0,
      sectionDetection: result?.extractionConfidence?.sectionDetection || 0,
      dateNormalization: result?.extractionConfidence?.dateNormalization || 0,
    },
    failure:
      ['FAILED', 'UNSUPPORTED'].includes(status) && result
        ? {
            category: result.failureCategory || 'PARSER_FAILED',
            message:
              result.safeErrorMessage ||
              'Resume processing did not complete. Reprocessing can be requested.',
          }
        : null,
    processingMetadata: {
      extractedCharacters: result?.processingMetadata?.extractedCharacters || 0,
      pageCount: result?.processingMetadata?.pageCount || 0,
      processedPageCount: result?.processingMetadata?.processedPageCount || 0,
      processingDurationMs: result?.processingMetadata?.processingDurationMs || 0,
    },
    structuredData: safeParsedData(result?.structuredData),
    reprocessAvailable: !retryBlocked && !cooldownBlocked,
  };
};

export const getCandidateResumeAccess = async ({
  companyId,
  candidateRef,
}) => {
  const candidate = await Candidate.findOne({
    companyId,
    ...candidateReferenceFilter(candidateRef),
  })
    .select('_id candidateCode')
    .lean();

  if (!candidate) throw ApiError.notFound('Candidate not found');

  const resume = await CandidateResume.findOne({
    companyId,
    candidate: candidate._id,
    status: 'UPLOADED',
  })
    .select(
      '+storageKey storageProvider originalFileName mimeType scanStatus status'
    )
    .lean();

  if (!resume || resume.scanStatus === 'REJECTED') {
    throw ApiError.notFound('Resume not found');
  }

  const access = await getStoredResumeAccess({
    storageProvider: resume.storageProvider,
    storageKey: resume.storageKey,
  });

  return {
    candidate,
    resume: {
      originalFileName: resume.originalFileName,
      mimeType: resume.mimeType,
      scanStatus: resume.scanStatus,
    },
    access,
  };
};
