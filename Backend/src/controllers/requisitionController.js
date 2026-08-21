// ─────────────────────────────────────────────────────────────
// Requisition controller — Phase 27.1 (create/submit) + 27.2 (HR review)
//
// Tenant rule: every query uses req.companyId from the JWT.
// req.body.companyId is never read.
// ─────────────────────────────────────────────────────────────
import JobRequisition from '../models/JobRequisition.js';
import Department from '../models/Department.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { notifyRoles, notifyUser } from '../utils/notify.js';
import {
  requisitionDecisionEmail,
  requisitionSubmittedEmail,
  sendRecruitmentMail,
} from '../utils/recruitmentMailer.js';
import { recordRecruitmentEvent } from '../services/recruitment/recruitmentAudit.js';
import {
  assertCanDecide,
  assertCanEdit,
  assertCanSubmit,
  assertCanView,
  buildHistoryEntry,
  buildScopeFilter,
  findRequisitionOr404,
  generateRequisitionCode,
  summarise,
} from '../services/recruitment/requisitionService.js';

const WRITABLE_FIELDS = [
  'department',
  'team',
  'position',
  'designation',
  'openings',
  'hiringType',
  'minExperience',
  'maxExperience',
  'requiredSkills',
  'preferredSkills',
  'hiringReason',
  'reasonNote',
  'priority',
  'expectedJoiningDate',
  'minSalary',
  'maxSalary',
  'hiringBudget',
  'employmentType',
  'workMode',
  'location',
  'additionalRequirements',
];

const cleanSkills = (value) =>
  (Array.isArray(value) ? value : String(value || '').split(','))
    .map((skill) => String(skill).trim())
    .filter(Boolean)
    .slice(0, 40);

const applyWritableFields = (target, body) => {
  WRITABLE_FIELDS.forEach((field) => {
    if (body[field] === undefined) return;

    if (field === 'requiredSkills' || field === 'preferredSkills') {
      target[field] = cleanSkills(body[field]);
      return;
    }

    if (field === 'department') {
      target.department = body.department || null;
      return;
    }

    if (field === 'expectedJoiningDate') {
      target.expectedJoiningDate = body.expectedJoiningDate || null;
      return;
    }

    target[field] = body[field];
  });
};

const populated = (query) =>
  query
    .populate('department', 'name')
    .populate('requester', 'name email role employeeCode')
    .populate('decidedBy', 'name email role');

// ── GET /api/recruitment/requisitions ───────────────────────────
export const listRequisitions = asyncHandler(async (req, res) => {
  // data from frontend
  const { status, department, priority, search, page = 1, limit = 20 } = req.query;

  // DB Logic
  const extra = {};

  if (status) {
    extra.status = status === 'PENDING_HR' ? { $in: ['PENDING_HR', 'SUBMITTED'] } : status;
  }

  if (department) extra.department = department;

  if (priority) extra.priority = priority;

  if (search) {
    extra.$or = [
      { position: { $regex: String(search).trim(), $options: 'i' } },
      { code: { $regex: String(search).trim(), $options: 'i' } },
      { designation: { $regex: String(search).trim(), $options: 'i' } },
    ];
  }

  const filter = await buildScopeFilter(req, extra);

  const pageNumber = Math.max(Number(page) || 1, 1);

  const pageSize = Math.min(Math.max(Number(limit) || 20, 1), 100);

  const [rows, total, scopeRows] = await Promise.all([
    populated(JobRequisition.find(filter))
      .sort('-createdAt')
      .skip((pageNumber - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    JobRequisition.countDocuments(filter),
    JobRequisition.find(await buildScopeFilter(req)).select('status openings').lean(),
  ]);

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Hiring requests fetched',
    data: rows,
    meta: {
      page: pageNumber,
      limit: pageSize,
      total,
      pages: Math.ceil(total / pageSize) || 1,
      summary: summarise(scopeRows),
    },
  });
});

// ── GET /api/recruitment/requisitions/:id ───────────────────────
export const getRequisition = asyncHandler(async (req, res) => {
  // data from frontend
  const { id } = req.params;

  // DB Logic
  const requisition = await populated(
    JobRequisition.findOne({ _id: id, companyId: req.companyId }),
  ).lean();

  if (!requisition) throw ApiError.notFound('Requisition not found');

  await assertCanView(req, requisition);

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Hiring request fetched',
    data: requisition,
  });
});

// ── POST /api/recruitment/requisitions ──────────────────────────
export const createRequisition = asyncHandler(async (req, res) => {
  // data from frontend
  const { submit = false } = req.body;

  // DB Logic
  if (req.body.department) {
    const department = await Department.findOne({
      _id: req.body.department,
      companyId: req.companyId,
    }).select('_id');

    if (!department) throw ApiError.badRequest('Invalid department for your company');
  }

  const payload = {
    companyId: req.companyId,
    requester: req.user._id,
    requesterRole: req.user.role,
    code: await generateRequisitionCode(req.companyId),
    status: submit ? 'PENDING_HR' : 'DRAFT',
    submittedAt: submit ? new Date() : null,
  };

  applyWritableFields(payload, req.body);

  payload.history = [
    buildHistoryEntry({
      req,
      action: 'REQUISITION_CREATED',
      fromStatus: '',
      toStatus: payload.status,
    }),
  ];

  const requisition = await JobRequisition.create(payload);

  await recordRecruitmentEvent({
    req,
    companyId: req.companyId,
    action: submit ? 'REQUISITION_SUBMITTED' : 'REQUISITION_CREATED',
    entityType: 'REQUISITION',
    entityId: requisition._id,
    entityCode: requisition.code,
    newState: { status: requisition.status, position: requisition.position },
  });

  if (submit) await notifyReviewers(req, requisition);

  // Data to frontend
  return ApiResponse.created(res, {
    message: submit ? 'Hiring request submitted to HR' : 'Draft saved',
    data: requisition,
  });
});

// ── PATCH /api/recruitment/requisitions/:id ─────────────────────
export const updateRequisition = asyncHandler(async (req, res) => {
  // data from frontend
  const { id } = req.params;

  // DB Logic
  const requisition = await findRequisitionOr404(req, id);

  await assertCanEdit(req, requisition);

  if (req.body.department) {
    const department = await Department.findOne({
      _id: req.body.department,
      companyId: req.companyId,
    }).select('_id');

    if (!department) throw ApiError.badRequest('Invalid department for your company');
  }

  const previous = { position: requisition.position, openings: requisition.openings };

  applyWritableFields(requisition, req.body);

  requisition.history.push(
    buildHistoryEntry({
      req,
      action: 'REQUISITION_UPDATED',
      fromStatus: requisition.status,
      toStatus: requisition.status,
    }),
  );

  await requisition.save();

  await recordRecruitmentEvent({
    req,
    companyId: req.companyId,
    action: 'REQUISITION_UPDATED',
    entityType: 'REQUISITION',
    entityId: requisition._id,
    entityCode: requisition.code,
    previousState: previous,
    newState: { position: requisition.position, openings: requisition.openings },
  });

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Hiring request updated',
    data: requisition,
  });
});

// ── POST /api/recruitment/requisitions/:id/submit ───────────────
export const submitRequisition = asyncHandler(async (req, res) => {
  // data from frontend
  const { id } = req.params;

  // DB Logic
  const requisition = await findRequisitionOr404(req, id);

  assertCanSubmit(req, requisition);

  const fromStatus = requisition.status;

  requisition.status = 'PENDING_HR';
  requisition.submittedAt = new Date();
  requisition.decisionReason = '';

  requisition.history.push(
    buildHistoryEntry({
      req,
      action: 'REQUISITION_SUBMITTED',
      fromStatus,
      toStatus: 'PENDING_HR',
    }),
  );

  await requisition.save();

  await recordRecruitmentEvent({
    req,
    companyId: req.companyId,
    action: 'REQUISITION_SUBMITTED',
    entityType: 'REQUISITION',
    entityId: requisition._id,
    entityCode: requisition.code,
    previousState: { status: fromStatus },
    newState: { status: 'PENDING_HR' },
  });

  await notifyReviewers(req, requisition);

  // Data to frontend
  return ApiResponse.success(res, {
    message: 'Hiring request submitted to HR',
    data: requisition,
  });
});

// ── POST /api/recruitment/requisitions/:id/decision ─────────────
export const decideRequisition = asyncHandler(async (req, res) => {
  // data from frontend
  const { id } = req.params;

  const { decision, reason = '' } = req.body;

  // DB Logic
  const requisition = await findRequisitionOr404(req, id);

  const nextStatus = assertCanDecide(requisition, decision);

  if (decision !== 'APPROVE' && !String(reason).trim()) {
    throw ApiError.badRequest('A reason is required when rejecting or sending back a request');
  }

  const fromStatus = requisition.status;

  requisition.status = nextStatus;
  requisition.decidedAt = new Date();
  requisition.decidedBy = req.user._id;
  requisition.decisionReason = String(reason).trim();

  requisition.history.push(
    buildHistoryEntry({
      req,
      action: `REQUISITION_${nextStatus}`,
      fromStatus,
      toStatus: nextStatus,
      reason: requisition.decisionReason,
    }),
  );

  await requisition.save();

  await recordRecruitmentEvent({
    req,
    companyId: req.companyId,
    action: `REQUISITION_${nextStatus}`,
    entityType: 'REQUISITION',
    entityId: requisition._id,
    entityCode: requisition.code,
    previousState: { status: fromStatus },
    newState: { status: nextStatus },
    metadata: { reason: requisition.decisionReason },
  });

  const requester = await User.findOne({
    _id: requisition.requester,
    companyId: req.companyId,
  })
    .select('name email')
    .lean();

  await notifyUser(req.companyId, requisition.requester, {
    type: 'SYSTEM',
    title: `Hiring request ${requisition.code} ${nextStatus.replace('_', ' ').toLowerCase()}`,
    message: requisition.decisionReason || requisition.position,
    link: '/app/recruitment/requisitions',
  });

  await sendRecruitmentMail(
    requester?.email,
    requisitionDecisionEmail({
      code: requisition.code,
      position: requisition.position,
      decision: nextStatus,
      reason: requisition.decisionReason,
      reviewerName: req.user.name,
    }),
  );

  // Data to frontend
  return ApiResponse.success(res, {
    message: `Hiring request ${nextStatus.replace('_', ' ').toLowerCase()}`,
    data: requisition,
  });
});

// ── DELETE /api/recruitment/requisitions/:id  (drafts only) ─────
export const deleteRequisition = asyncHandler(async (req, res) => {
  // data from frontend
  const { id } = req.params;

  // DB Logic
  const requisition = await findRequisitionOr404(req, id);

  if (requisition.status !== 'DRAFT') {
    throw ApiError.badRequest('Only draft hiring requests can be deleted');
  }

  if (String(requisition.requester) !== String(req.user._id)) {
    throw ApiError.forbidden('You can only delete your own draft');
  }

  await JobRequisition.deleteOne({ _id: requisition._id, companyId: req.companyId });

  await recordRecruitmentEvent({
    req,
    companyId: req.companyId,
    action: 'REQUISITION_DELETED',
    entityType: 'REQUISITION',
    entityId: requisition._id,
    entityCode: requisition.code,
    previousState: { status: 'DRAFT' },
  });

  // Data to frontend
  return ApiResponse.success(res, { message: 'Draft deleted', data: { id } });
});

// ── Internal helper: notify HR reviewers ────────────────────────
const notifyReviewers = async (req, requisition) => {
  await notifyRoles(req.companyId, ['HR_MANAGER', 'COMPANY_ADMIN'], {
    type: 'SYSTEM',
    title: `New hiring request ${requisition.code}`,
    message: `${req.user.name} requested ${requisition.openings} × ${requisition.position}`,
    link: '/app/recruitment/requisitions/review',
  });

  const reviewers = await User.find({
    companyId: req.companyId,
    role: { $in: ['HR_MANAGER', 'COMPANY_ADMIN'] },
    status: 'ACTIVE',
  })
    .select('email')
    .lean();

  const department = requisition.department
    ? await Department.findOne({ _id: requisition.department, companyId: req.companyId })
        .select('name')
        .lean()
    : null;

  const template = requisitionSubmittedEmail({
    code: requisition.code,
    position: requisition.position,
    openings: requisition.openings,
    priority: requisition.priority,
    requesterName: req.user.name,
    departmentName: department?.name || '',
    companyName: req.company?.name || 'your company',
  });

  await Promise.all(reviewers.map((reviewer) => sendRecruitmentMail(reviewer.email, template)));
};
