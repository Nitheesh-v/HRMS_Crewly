// ═══════════════════════════════════════════════════════════════════════════
//  EMPLOYEE REFERRAL SERVICE
//
//  Posted jobs, visible to every employee, for referral.
//
//  VISIBILITY RULE — one truth: a job appears to employees exactly when it is
//  public on the career page (publicationStatus PUBLISHED + publishedAt set +
//  OPEN + deadline in the future), via the same publicVisibilityFilter the
//  public portal uses. HR "publishing" a posting IS the switch that makes it
//  referable; there is no second visibility state to keep in sync.
//
//  REFERRAL = an APPLIED candidate in the normal pipeline, attributed:
//    source: 'REFERRAL' + referredBy: <employee User id>. HR works it with
//  the existing inbox/pipeline permissions; the referrer can watch only
//  their own referrals' stage. The per-job unique email index already
//  guards against duplicates — E11000 surfaces as a friendly 409.
//
//  TENANT RULE — companyId comes from the caller (middleware), never from a
//  payload, and every query carries it. An employee of one tenant can never
//  list, refer into, or read another tenant's openings.
// ═══════════════════════════════════════════════════════════════════════════

import mongoose from 'mongoose';

import ApiError from '../../utils/ApiError.js';
import Candidate from '../../models/Candidate.js';
import CandidateHistory from '../../models/CandidateHistory.js';
import JobPosting from '../../models/JobPosting.js';
import { publicVisibilityFilter } from './publicCareerService.js';
import { nextCandidateCode } from '../../utils/candidateIdentifiers.js';

// Referral-safe projection: what an employee may see about a job. Deliberately
// NOT salary bands / hiring budget / hiring reason — those are HR-only fields.
const REFERRAL_JOB_FIELDS = {
  jobCode: 1,
  title: 1,
  department: 1,
  location: 1,
  workMode: 1,
  employmentType: 1,
  description: 1,
  requiredSkills: 1,
  preferredSkills: 1,
  experienceLevel: 1,
  minExperience: 1,
  maxExperience: 1,
  openings: 1,
  publishedAt: 1,
};

const REFERRAL_LIST_FIELDS = {
  jobCode: 1,
  title: 1,
  location: 1,
  workMode: 1,
  employmentType: 1,
  publishedAt: 1,
  department: 1,
};

const trimTo = (value, max) => String(value ?? '').trim().slice(0, max);

const normaliseReferralInput = (input = {}) => {
  const name = trimTo(input.fullName ?? input.name, 100);
  const email = trimTo(input.email, 200).toLowerCase();
  const phone = trimTo(input.phone, 20);
  const notes = trimTo(input.notes, 500);

  if (name.length < 2) {
    throw ApiError.badRequest("Enter the candidate's full name");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw ApiError.badRequest('Enter a valid candidate email');
  }
  if (phone && !/^[+\d][\d\s-]{5,19}$/.test(phone)) {
    throw ApiError.badRequest('Enter a valid phone number (or leave it empty)');
  }
  return { name, email, phone, notes };
};

// Data from frontend - jobCode + candidate details (identity/company from token)
export const listReferralOpenings = async ({ companyId }) => {
  // DB Logic - posted + open jobs of THIS tenant, referral-safe fields only.
  const jobs = await JobPosting.find(
    { ...publicVisibilityFilter(companyId), publishedAt: { $ne: null } },
    REFERRAL_JOB_FIELDS,
  )
    .populate('department', 'name')
    .sort({ publishedAt: -1, title: 1 })
    .lean();

  // Data to frontend - the openings an employee can refer into
  return { openings: jobs };
};

export const submitReferral = async ({ companyId, userId, jobCode, input = {} }) => {
  const { name, email, phone, notes } = normaliseReferralInput(input);

  const job = await JobPosting.findOne({
    jobCode: String(jobCode || '').toUpperCase(),
    ...publicVisibilityFilter(companyId),
    publishedAt: { $ne: null },
  }).lean();

  if (!job) {
    throw ApiError.notFound('This opening is not open for referrals');
  }

  // Friendlier-than-E11000 pre-check; the unique {job, email} index stays the
  // real guard against a race.
  const existing = await Candidate.findOne({
    companyId,
    job: job._id,
    email,
  })
    .select('_id')
    .lean();
  if (existing) {
    throw ApiError.conflict('This candidate is already in the pipeline for this job');
  }

  const candidateCode = await nextCandidateCode(companyId);

  let candidate;
  try {
    candidate = await Candidate.create({
      companyId,
      job: job._id,
      requisition: job.sourceRequisition || null,
      candidateCode,
      name,
      email,
      phone,
      notes,
      source: 'REFERRAL',
      referredBy: userId,
      stage: 'APPLIED',
      applicationDate: new Date(),
      applicationStatus: 'APPLIED',
      status: 'ACTIVE',
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw ApiError.conflict('This candidate is already in the pipeline for this job');
    }
    throw error;
  }

  await CandidateHistory.create({
    companyId,
    candidate: candidate._id,
    job: job._id,
    action: 'CANDIDATE_APPLIED',
    source: 'REFERRAL',
    actorType: 'TENANT_USER',
    actor: userId,
    metadata: {
      stage: 'APPLIED',
      jobCode: job.jobCode,
      referredBy: userId,
    },
    eventAt: new Date(),
  });

  return {
    referral: {
      _id: candidate._id,
      candidateCode: candidate.candidateCode,
      name: candidate.name,
      email: candidate.email,
      jobCode: job.jobCode,
      jobTitle: job.title,
      stage: 'APPLIED',
    },
  };
};

export const listMyReferrals = async ({ companyId, userId }) => {
  // DB Logic - ONLY the caller's own referrals, tenant-scoped, newest first.
  const referrals = await Candidate.find(
    { companyId, source: 'REFERRAL', referredBy: userId },
    {
      candidateCode: 1,
      name: 1,
      email: 1,
      currentStage: 1,
      stage: 1,
      applicationDate: 1,
      job: 1,
    },
  )
    .populate('job', REFERRAL_LIST_FIELDS)
    .sort({ applicationDate: -1, _id: -1 })
    .lean();

  // Data to frontend - the referrer's own referrals with the live pipeline stage
  return {
    referrals: referrals.map((row) => ({
      _id: row._id,
      candidateCode: row.candidateCode,
      name: row.name,
      email: row.email,
      stage: row.currentStage || row.stage,
      applicationDate: row.applicationDate,
      job: row.job || null,
    })),
  };
};

export const employeeReferralService = {
  listReferralOpenings,
  submitReferral,
  listMyReferrals,
};

export default employeeReferralService;
