// ─────────────────────────────────────────────────────────────
// Recruitment controller — jobs, candidates, offers, conversion.
//
// ⚠️ RESPONSE CONTRACTS (RecruitmentPage depends on these):
//   GET  /recruitment/jobs        → data: [ job + candidateCount ]
//   GET  /recruitment/candidates  → data: [ candidate + job{title} ]
//   POST /recruitment/candidates/:id/convert
//       → data: { user: {name,email,role,employeeCode}, tempPassword }
// ─────────────────────────────────────────────────────────────
import JobPosting from '../models/JobPosting.js';
import Candidate from '../models/Candidate.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ROLES } from '../utils/constants.js';
import { sendMail, welcomeEmail } from '../utils/mailer.js';
import { notifyUser } from '../utils/notify.js';
import Subscription from '../models/Subscription.js';

// GET /api/recruitment/jobs
export const listJobs = asyncHandler(async (req, res) => {
  const jobs = await JobPosting.find({ companyId: req.companyId })
    .populate('department', 'name')
    .sort('-createdAt');
  // candidate count per job, in ONE aggregate query
  const counts = await Candidate.aggregate([
    { $match: { companyId: req.companyId } },
    { $group: { _id: '$job', count: { $sum: 1 } } },
  ]);
  const cmap = new Map(counts.map((c) => [String(c._id), c.count]));
  const data = jobs.map((j) => ({ ...j.toObject(), candidateCount: cmap.get(String(j._id)) || 0 }));
  return ApiResponse.success(res, { message: 'Jobs fetched', data });
});

// POST /api/recruitment/jobs
export const createJob = asyncHandler(async (req, res) => {
  const { title, department, location, employmentType, openings, description } = req.body;
  const job = await JobPosting.create({
    companyId: req.companyId,
    title, department: department || null, location, employmentType, openings, description,
    createdBy: req.user._id,
  });
  
  return ApiResponse.created(res, { message: 'Job posted', data: job });
});

// PATCH /api/recruitment/jobs/:id  (edit fields, or close/reopen)
export const updateJob = asyncHandler(async (req, res) => {
  const job = await JobPosting.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!job) throw ApiError.notFound('Job not found');
  ['title', 'department', 'location', 'employmentType', 'openings', 'description', 'status']
    .forEach((f) => { if (req.body[f] !== undefined) job[f] = req.body[f] || (f === 'department' ? null : req.body[f]); });
  await job.save();
  return ApiResponse.success(res, { message: 'Job updated', data: job });
});

// GET /api/recruitment/candidates?job=<id>&stage=
export const listCandidates = asyncHandler(async (req, res) => {
  const filter = { companyId: req.companyId };
  if (req.query.job) filter.job = req.query.job;
  if (req.query.stage) filter.stage = req.query.stage;
  const candidates = await Candidate.find(filter).populate('job', 'title').sort('-createdAt');
  return ApiResponse.success(res, { message: 'Candidates fetched', data: candidates });
});

// POST /api/recruitment/candidates
export const addCandidate = asyncHandler(async (req, res) => {
  const { job: jobId, name, email, phone, resumeLink, notes } = req.body;
  const job = await JobPosting.findOne({ _id: jobId, companyId: req.companyId });
  if (!job) throw ApiError.notFound('Job not found in your company');
  if (job.status !== 'OPEN') throw ApiError.badRequest('This job is CLOSED — reopen it to add candidates');

  const dup = await Candidate.findOne({ job: jobId, email: email.toLowerCase() });
  if (dup) throw ApiError.conflict('This email is already added for this job');

  const candidate = await Candidate.create({
    companyId: req.companyId, job: jobId, name, email, phone, resumeLink, notes,
  });
  return ApiResponse.created(res, { message: 'Candidate added', data: candidate });
});

// PATCH /api/recruitment/candidates/:id/stage  { stage }
export const updateStage = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!candidate) throw ApiError.notFound('Candidate not found');

  const { stage } = req.body;
  if (stage === 'HIRED') {
    throw ApiError.badRequest('Use the 🎉 Convert action to hire — it creates the employee account');
  }
  candidate.stage = stage;
  await candidate.save();
  return ApiResponse.success(res, { message: `Moved to ${stage}`, data: candidate });
});

// PATCH /api/recruitment/candidates/:id/offer
// { offerStatus: SENT|ACCEPTED|DECLINED, offerSalary?, offerJoiningDate? }
export const updateOffer = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!candidate) throw ApiError.notFound('Candidate not found');
  if (candidate.stage === 'HIRED') throw ApiError.badRequest('Candidate is already HIRED');

  const { offerStatus, offerSalary, offerJoiningDate } = req.body;

  if (offerStatus === 'SENT') {
    if (!offerSalary || !offerJoiningDate) {
      throw ApiError.badRequest('Offer salary and joining date are required to send an offer');
    }
    candidate.offerSalary = offerSalary;
    candidate.offerJoiningDate = offerJoiningDate;
    candidate.offerStatus = 'SENT';
    candidate.stage = 'OFFER'; // auto-advance
  } else if (['ACCEPTED', 'DECLINED'].includes(offerStatus)) {
    if (candidate.offerStatus !== 'SENT') {
      throw ApiError.badRequest('Send the offer first, then mark it accepted/declined');
    }
    candidate.offerStatus = offerStatus;
  } else {
    throw ApiError.badRequest('Invalid offer status');
  }

  await candidate.save();
  return ApiResponse.success(res, { message: `Offer ${offerStatus.toLowerCase()}`, data: candidate });
});

// POST /api/recruitment/candidates/:id/convert  → creates the employee!
export const convertCandidate = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findOne({ _id: req.params.id, companyId: req.companyId }).populate('job');
  if (!candidate) throw ApiError.notFound('Candidate not found');
  if (candidate.stage === 'HIRED' || candidate.convertedUser) {
    throw ApiError.conflict('This candidate is already converted to an employee');
  }
  if (candidate.offerStatus !== 'ACCEPTED') {
    throw ApiError.badRequest('Convert is allowed only after the candidate ACCEPTS the offer');
  }

  const email = candidate.email.toLowerCase();
  const exists = await User.findOne({ email, companyId: req.companyId });
  if (exists) throw ApiError.conflict('A user with this email already exists in your company');

  // Subscription employee limit (same rule as user creation)
  const subscription = await Subscription.findOne({ company: req.companyId });
  const limit = subscription?.limits?.employees;
  if (limit) {
    const active = await User.countDocuments({ companyId: req.companyId, status: 'ACTIVE' });
    if (active >= limit) {
      throw ApiError.forbidden(`Employee limit reached (${limit}) on your plan. Upgrade to convert more.`);
    }
  }

  // Auto employee code: E001, E002… (skips taken ones)
  let n = await User.countDocuments({ companyId: req.companyId }) + 1;
  let employeeCode = `E${String(n).padStart(3, '0')}`;
  while (await User.exists({ companyId: req.companyId, employeeCode })) {
    n += 1;
    employeeCode = `E${String(n).padStart(3, '0')}`;
  }

  // Temp password shown ONCE to HR — employee must reset after first login
  const tempPassword = `Talent@${Math.floor(1000 + Math.random() * 9000)}`;

  const user = await User.create({
    name: candidate.name,
    email,
    password: tempPassword,
    role: ROLES.EMPLOYEE,
    companyId: req.companyId,
    department: candidate.job?.department || null,
    designation: candidate.job?.title?.slice(0, 80) || '',
    dateOfJoining: candidate.offerJoiningDate || null,
    employeeCode,
  });

  candidate.stage = 'HIRED';
  candidate.convertedUser = user._id;
  await candidate.save();

  // Phase 8 📧🔔 hired: welcome notification + credentials email
  notifyUser(req.companyId, user._id, {
    type: 'USER', title: 'Welcome aboard 🎉',
    message: `You joined as ${candidate.job?.title}. HR will share your temporary password.`,
    link: '/app',
  });
  sendMail({ to: email, ...welcomeEmail({ name: candidate.name, email, password: tempPassword, companyName: req.company?.name, code: req.company?.code }) });

  return ApiResponse.created(res, {
    message: `${candidate.name} is now an employee 🎉`,
    data: {
      user: { id: user._id, name: user.name, email: user.email, role: user.role, employeeCode },
      tempPassword,
    },
  });
});