// ─────────────────────────────────────────────────────────────
// Recruitment controller — jobs and candidates (legacy surfaces).
//
// Conversion: use convert-to-employee (Phase 27.13). Legacy convert is retired.
// ─────────────────────────────────────────────────────────────
import JobPosting from '../models/JobPosting.js';
import Candidate from '../models/Candidate.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextJobCode } from '../utils/careerPortalIdentifiers.js';
import { nextCandidateCode } from '../utils/candidateIdentifiers.js';
import { bumpRecruitmentAnalyticsGeneration } from '../services/analyticsCacheInvalidation.js';

const normalizedList = (value, maximum, itemLength) =>
  [...new Set(
    (Array.isArray(value) ? value : String(value || '').split(','))
      .map((item) => String(item || '').trim().slice(0, itemLength))
      .filter(Boolean)
  )].slice(0, maximum);

const validateExperienceRange = ({ minExperience, maxExperience }) => {
  if (
    Number(maxExperience) > 0 &&
    Number(minExperience) > Number(maxExperience)
  ) {
    throw ApiError.badRequest(
      'Maximum experience must be greater than or equal to minimum experience'
    );
  }
};

// GET /api/recruitment/jobs
export const listJobs = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const jobs = await JobPosting.find({ companyId: req.companyId })
    .populate('department', 'name')
    .sort('-createdAt');
  // candidate count per job, in ONE aggregate query
  const counts = await Candidate.aggregate([
    // Data from frontend - requests from frontend
    { $match: { companyId: req.companyId } },
    { $group: { _id: '$job', count: { $sum: 1 } } },
  ]);
  const cmap = new Map(counts.map((c) => [String(c._id), c.count]));
  const data = jobs.map((j) => ({ ...j.toObject(), candidateCount: cmap.get(String(j._id)) || 0 }));
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Jobs fetched', data });
});

// POST /api/recruitment/jobs
export const createJob = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const {
    title,
    department,
    location,
    employmentType,
    openings,
    description,
    workMode,
    experienceLevel,
    minExperience,
    maxExperience,
    requiredSkills,
    preferredSkills,
    educationRequirements,
    maxNoticePeriod,
  } = req.body;

  // DB Logic - DB logics
  validateExperienceRange({ minExperience, maxExperience });
  const jobCode = await nextJobCode(req.companyId);
  const job = await JobPosting.create({
    companyId: req.companyId,
    jobCode,
    title,
    department: department || null,
    location,
    employmentType,
    openings,
    description,
    workMode,
    experienceLevel,
    minExperience,
    maxExperience,
    requiredSkills: normalizedList(requiredSkills, 50, 60),
    preferredSkills: normalizedList(preferredSkills, 50, 60),
    educationRequirements: normalizedList(educationRequirements, 20, 200),
    maxNoticePeriod,
    publicationStatus: 'DRAFT',
    createdBy: req.user._id,
  });

  // 28.7: analytics cache generation bump (fire-and-forget, never throws).
  bumpRecruitmentAnalyticsGeneration(req.companyId).catch(() => {});

  // Data to frontend - response to frontend
  return ApiResponse.created(res, {
    message: 'Job saved as a publication draft',
    data: job,
  });
});

// PATCH /api/recruitment/jobs/:id  (edit, publish, pause, close or reopen)
export const updateJob = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const editableFields = [
    'title',
    'department',
    'location',
    'employmentType',
    'openings',
    'description',
    'workMode',
    'experienceLevel',
    'minExperience',
    'maxExperience',
    'requiredSkills',
    'preferredSkills',
    'educationRequirements',
    'maxNoticePeriod',
    'status',
    'publicationStatus',
    'applicationDeadline',
    'publicSalaryVisible',
  ];

  // DB Logic - DB logics
  const job = await JobPosting.findOne({
    _id: req.params.id,
    companyId: req.companyId,
  });

  if (!job) throw ApiError.notFound('Job not found');

  validateExperienceRange({
    minExperience: req.body.minExperience ?? job.minExperience,
    maxExperience: req.body.maxExperience ?? job.maxExperience,
  });

  const nextOperationalStatus = req.body.status || job.status;
  const publishingNow = req.body.publicationStatus === 'PUBLISHED';
  const deadlineWasProvided = Object.hasOwn(
    req.body,
    'applicationDeadline'
  );
  const nextDeadline = deadlineWasProvided
    ? req.body.applicationDeadline || null
    : job.applicationDeadline;

  if (
    publishingNow &&
    nextOperationalStatus !== 'OPEN'
  ) {
    throw ApiError.badRequest('Reopen the job before publishing it');
  }

  if (
    publishingNow &&
    nextDeadline &&
    new Date(nextDeadline).getTime() <= Date.now()
  ) {
    throw ApiError.badRequest(
      'Application deadline must be in the future when publishing'
    );
  }

  editableFields.forEach((field) => {
    if (req.body[field] === undefined) return;

    if (field === 'department') {
      job[field] = req.body[field] || null;
      return;
    }

    if (field === 'applicationDeadline') {
      job[field] = req.body[field] || null;
      return;
    }

    if (['requiredSkills', 'preferredSkills'].includes(field)) {
      job[field] = normalizedList(req.body[field], 50, 60);
      return;
    }

    if (field === 'educationRequirements') {
      job[field] = normalizedList(req.body[field], 20, 200);
      return;
    }

    job[field] = req.body[field];
  });

  if (
    job.publicationStatus === 'PUBLISHED' &&
    !job.publishedAt
  ) {
    job.publishedAt = new Date();
  }

  await job.save();

  // 28.7: analytics cache generation bump (fire-and-forget, never throws).
  bumpRecruitmentAnalyticsGeneration(req.companyId).catch(() => {});

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Job updated',
    data: job,
  });
});

// GET /api/recruitment/candidates?job=<id>&stage=
export const listCandidates = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const filter = { companyId: req.companyId };
  if (req.query.job) filter.job = req.query.job;
  if (req.query.stage) filter.currentStage = req.query.stage;
  // DB Logic - DB logics
  const candidates = await Candidate.find(filter).populate('job', 'title').sort('-createdAt');
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Candidates fetched', data: candidates });
});

// POST /api/recruitment/candidates
export const addCandidate = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { job: jobId, name, email, phone, resumeLink, notes } = req.body;

  // DB Logic - DB logics
  const job = await JobPosting.findOne({ _id: jobId, companyId: req.companyId });
  if (!job) throw ApiError.notFound('Job not found in your company');
  if (job.status !== 'OPEN') throw ApiError.badRequest('This job is CLOSED — reopen it to add candidates');

  const dup = await Candidate.findOne({
    companyId: req.companyId,
    job: jobId,
    email: email.toLowerCase(),
  });
  if (dup) throw ApiError.conflict('This email is already added for this job');

  const candidateCode = await nextCandidateCode(req.companyId);
  const candidate = await Candidate.create({
    companyId: req.companyId,
    job: jobId,
    candidateCode,
    name,
    email,
    phone,
    resumeLink,
    notes,
    source: 'INTERNAL',
    applicationDate: new Date(),
  });

  // Data to frontend - response to frontend
  return ApiResponse.created(res, { message: 'Candidate added', data: candidate });
});

// Legacy Candidate-embedded offer mutation was retired by Phase 27.11.
// Candidate decisions now exist only on token-authorized OfferLetter endpoints.

// POST /api/recruitment/candidates/:id/convert
// Phase 27.16 — legacy temp-password conversion is retired.
// Use POST /candidates/:candidateId/convert-to-employee (secure account setup).
export const convertCandidate = asyncHandler(async (_req, _res) => {
  throw ApiError.badRequest(
    'Legacy candidate conversion is retired. Use convert-to-employee after READY_TO_JOIN for secure account setup without temporary passwords.'
  );
});