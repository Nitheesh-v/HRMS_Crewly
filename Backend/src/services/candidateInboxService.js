import mongoose from 'mongoose';
import Candidate from '../models/Candidate.js';
import CandidateHistory from '../models/CandidateHistory.js';
import CandidateResume from '../models/CandidateResume.js';
import ApiError from '../utils/ApiError.js';
import { getStoredResumeAccess } from './resumeStorageService.js';

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
  if (query.stage) filter.stage = query.stage;

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
    filter.$or = [
      { candidateCode: search },
      { name: search },
      { email: search },
      { phone: search },
      { location: search },
      { skills: search },
    ];
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
          'relevantExperience skills source applicationDate applicationStatus stage status job'
      )
      .populate({
        path: 'job',
        select: 'jobCode title',
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
      stage: candidate.stage,
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
        'education skills links source applicationDate applicationStatus status stage job requisition consent'
    )
    .populate({
      path: 'job',
      select: 'jobCode title location employmentType workMode department sourceRequisition',
      match: { companyId },
      populate: { path: 'department', select: 'name' },
    })
    .lean();

  if (!candidate) throw ApiError.notFound('Candidate not found');

  const [resume, history] = await Promise.all([
    CandidateResume.findOne({
      companyId,
      candidate: candidate._id,
      status: 'UPLOADED',
    })
      .select(
        'originalFileName mimeType fileSize status scanStatus parsingStatus uploadedAt'
      )
      .lean(),
    CandidateHistory.find({
      companyId,
      candidate: candidate._id,
    })
      .select('action actorType eventAt metadata -_id')
      .sort({ eventAt: -1 })
      .limit(20)
      .lean(),
  ]);

  return {
    id: candidate._id,
    candidateCode: candidate.candidateCode,
    overview: {
      name: candidate.name,
      email: candidate.email,
      phone: candidate.phone || '',
      location: candidate.location || '',
      source: candidate.source || 'INTERNAL',
      stage: candidate.stage,
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
          uploadedAt: resume.uploadedAt,
        }
      : { available: false },
    history: history.map((event) => ({
      action: event.action,
      actorType: event.actorType,
      eventAt: event.eventAt,
      metadata: {
        ...(event.metadata?.stage ? { stage: event.metadata.stage } : {}),
        ...(event.metadata?.jobCode
          ? { jobCode: event.metadata.jobCode }
          : {}),
        ...(event.metadata?.deliveryMode
          ? { deliveryMode: event.metadata.deliveryMode }
          : {}),
        ...(event.metadata?.delivered !== undefined
          ? { delivered: Boolean(event.metadata.delivered) }
          : {}),
      },
    })),
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
