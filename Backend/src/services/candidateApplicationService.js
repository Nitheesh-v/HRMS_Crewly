import Candidate from '../models/Candidate.js';
import CandidateHistory from '../models/CandidateHistory.js';
import CandidateResume from '../models/CandidateResume.js';
import ApiError from '../utils/ApiError.js';
import { nextCandidateCode } from '../utils/candidateIdentifiers.js';
import { recordAudit } from '../utils/securityauditService.js';
import { checkLimit } from '../utils/subscriptionEngine.js';
import { resolvePublicApplicationTarget } from './publicCareerService.js';
import { sendApplicationConfirmation } from './candidateApplicationJobs.js';
import { dispatchResumeProcessing } from './resumeProcessingDispatcher.js';
import { inspectResumeFile } from './resumeSecurityService.js';
import {
  deleteStoredResume,
  storeResume,
} from './resumeStorageService.js';

const CONSENT_VERSION = '2026-08';

const normalizedSkills = (value) => {
  const seen = new Set();
  const skills = [];

  String(value || '')
    .split(',')
    .map((skill) => skill.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .forEach((skill) => {
      const key = skill.toLowerCase();

      if (!seen.has(key) && skills.length < 20) {
        seen.add(key);
        skills.push(skill.slice(0, 50));
      }
    });

  return skills;
};

const safeCleanup = async ({ storedResume, candidateId }) => {
  await Promise.allSettled([
    ...(candidateId
      ? [
          CandidateHistory.deleteMany({ candidate: candidateId }),
          CandidateResume.deleteMany({ candidate: candidateId }),
          Candidate.deleteOne({ _id: candidateId }),
        ]
      : []),
    ...(storedResume
      ? [deleteStoredResume(storedResume)]
      : []),
  ]);
};

const publicResult = ({ candidateCode, job, submittedAt }) => ({
  applicationReference: candidateCode || 'APPLICATION-RECEIVED',
  job: {
    jobCode: job.jobCode,
    title: job.title,
  },
  submittedAt,
});

export const submitCandidateApplication = async ({
  companySlug,
  jobCode,
  fields,
  file,
  req,
}) => {
  const submittedAt = new Date();
  const [{ company, job }, resumeMetadata] = await Promise.all([
    resolvePublicApplicationTarget({ companySlug, jobCode }),
    inspectResumeFile(file),
  ]);
  const normalizedEmail = String(fields.email || '').trim().toLowerCase();

  const duplicate = await Candidate.findOne({
    companyId: company._id,
    job: job._id,
    email: normalizedEmail,
  })
    .select('candidateCode')
    .lean();

  if (duplicate) {
    return publicResult({
      candidateCode: duplicate.candidateCode,
      job,
      submittedAt,
    });
  }

  const usage = await checkLimit(
    company._id,
    'recruitmentCandidatesMonthly'
  );

  if (!usage.allowed) {
    throw new ApiError(
      429,
      'Applications are temporarily unavailable. Please try again later.'
    );
  }

  if (
    fields.relevantExperience !== undefined &&
    fields.totalExperience !== undefined &&
    fields.relevantExperience > fields.totalExperience
  ) {
    throw ApiError.badRequest(
      'Relevant experience cannot exceed total experience'
    );
  }

  const candidateCode = await nextCandidateCode(company._id);
  let storedResume = null;
  let candidate = null;
  let candidateResume = null;

  try {
    storedResume = await storeResume({ file, companyId: company._id });

    candidate = await Candidate.create({
      companyId: company._id,
      job: job._id,
      requisition: job.sourceRequisition || null,
      candidateCode,
      name: fields.fullName,
      email: normalizedEmail,
      phone: fields.phone,
      location: fields.location || '',
      currentCompany: fields.currentCompany || '',
      currentJobTitle: fields.currentTitle || '',
      totalExperience: fields.totalExperience ?? 0,
      relevantExperience: fields.relevantExperience ?? 0,
      expectedSalary: fields.expectedSalary ?? null,
      noticePeriod: fields.noticePeriod ?? null,
      education: {
        degree: fields.degree || '',
        institution: fields.institution || '',
        graduationYear: fields.graduationYear ?? null,
      },
      skills: normalizedSkills(fields.skills),
      links: {
        linkedIn: fields.linkedIn || '',
        github: fields.github || '',
        portfolio: fields.portfolio || '',
      },
      source: 'CAREER_PAGE',
      stage: 'APPLIED',
      applicationDate: submittedAt,
      applicationStatus: 'APPLIED',
      status: 'ACTIVE',
      consent: {
        acceptedAt: submittedAt,
        version: CONSENT_VERSION,
      },
    });

    candidateResume = await CandidateResume.create({
      companyId: company._id,
      candidate: candidate._id,
      job: job._id,
      ...storedResume,
      ...resumeMetadata,
      status: 'UPLOADED',
      parsingStatus: 'PENDING',
      parsingRequestedAt: submittedAt,
      uploadedAt: submittedAt,
    });

    await CandidateHistory.create({
      companyId: company._id,
      candidate: candidate._id,
      job: job._id,
      action: 'CANDIDATE_APPLIED',
      source: 'CAREER_PAGE',
      actorType: 'PUBLIC_CANDIDATE',
      metadata: {
        stage: 'APPLIED',
        jobCode: job.jobCode,
      },
      eventAt: submittedAt,
    });
  } catch (error) {
    await safeCleanup({ storedResume, candidateId: candidate?._id });

    if (error.code === 11000) {
      const racedDuplicate = await Candidate.findOne({
        companyId: company._id,
        job: job._id,
        email: normalizedEmail,
      })
        .select('candidateCode')
        .lean();

      if (racedDuplicate) {
        return publicResult({
          candidateCode: racedDuplicate.candidateCode,
          job,
          submittedAt,
        });
      }
    }

    throw error;
  }

  await recordAudit({
    req,
    action: 'Public candidate application received',
    companyId: company._id,
    resource: 'Candidate',
    resourceId: candidate._id,
    statusCode: 202,
    metadata: {
      source: 'CAREER_PAGE',
      jobCode: job.jobCode,
      candidateCode: candidate.candidateCode,
      resumeScanStatus: resumeMetadata.scanStatus,
    },
    critical: true,
  });

  await sendApplicationConfirmation({ candidate, company, job });

  // Queue-only handoff: the public application never waits for extraction/parsing.
  dispatchResumeProcessing({
    companyId: company._id,
    candidateId: candidate._id,
    resumeId: candidateResume._id,
  });

  return publicResult({
    candidateCode: candidate.candidateCode,
    job,
    submittedAt,
  });
};
