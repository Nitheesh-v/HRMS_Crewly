import Department from '../models/Department.js';
import JobPosting from '../models/JobPosting.js';
import JobRequisition, {
  REQUISITION_EMPLOYMENT_TYPES,
  REQUISITION_EXPERIENCE_LEVELS,
  REQUISITION_HIRING_REASONS,
  REQUISITION_PRIORITIES,
  REQUISITION_STATUSES,
  REQUISITION_WORK_MODES,
} from '../models/JobRequisition.js';
import TenantSequence from '../models/TenantSequence.js';
import ApiError from '../utils/ApiError.js';
import { notifyRoles, notifyUser } from '../utils/notify.js';
import { nextJobCode } from '../utils/careerPortalIdentifiers.js';
import { hasPermission } from '../utils/permissionService.js';
import { recordAudit } from '../utils/securityauditService.js';

const EDITABLE_FIELDS = [
  'department',
  'team',
  'position',
  'openings',
  'experienceLevel',
  'minExperience',
  'maxExperience',
  'requiredSkills',
  'preferredSkills',
  'salaryMin',
  'salaryMax',
  'hiringBudget',
  'employmentType',
  'workMode',
  'location',
  'hiringReason',
  'hiringReasonDetails',
  'priority',
  'expectedJoiningDate',
];

const EDITABLE_STATUSES = ['DRAFT', 'SENT_BACK'];

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeSkills = (value) => {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(',');

  const unique = new Map();

  values.forEach((item) => {
    const skill = String(item || '').trim();
    if (!skill) return;

    const key = skill.toLowerCase();
    if (!unique.has(key)) unique.set(key, skill.slice(0, 60));
  });

  return [...unique.values()].slice(0, 50);
};

const normalizeNumber = (value) => {
  if (value === '' || value === null || value === undefined) return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const normalizePayload = (payload = {}) => {
  const normalized = {};

  EDITABLE_FIELDS.forEach((field) => {
    if (payload[field] === undefined) return;

    if (['requiredSkills', 'preferredSkills'].includes(field)) {
      normalized[field] = normalizeSkills(payload[field]);
      return;
    }

    if (
      [
        'openings',
        'minExperience',
        'maxExperience',
        'salaryMin',
        'salaryMax',
        'hiringBudget',
      ].includes(field)
    ) {
      normalized[field] = normalizeNumber(payload[field]);
      return;
    }

    if (field === 'expectedJoiningDate') {
      normalized[field] = payload[field] ? new Date(payload[field]) : null;
      return;
    }

    normalized[field] = typeof payload[field] === 'string'
      ? payload[field].trim()
      : payload[field];
  });

  if (normalized.experienceLevel === 'FRESHER') {
    normalized.minExperience = 0;
    normalized.maxExperience = 0;
  }

  return normalized;
};

const requisitionSnapshot = (requisition) => ({
  requisitionNumber: requisition.requisitionNumber,
  department: requisition.department?._id || requisition.department,
  team: requisition.team,
  position: requisition.position,
  openings: requisition.openings,
  experienceLevel: requisition.experienceLevel,
  minExperience: requisition.minExperience,
  maxExperience: requisition.maxExperience,
  requiredSkills: requisition.requiredSkills,
  preferredSkills: requisition.preferredSkills,
  salaryMin: requisition.salaryMin,
  salaryMax: requisition.salaryMax,
  hiringBudget: requisition.hiringBudget,
  employmentType: requisition.employmentType,
  workMode: requisition.workMode,
  location: requisition.location,
  hiringReason: requisition.hiringReason,
  hiringReasonDetails: requisition.hiringReasonDetails,
  priority: requisition.priority,
  expectedJoiningDate: requisition.expectedJoiningDate,
  requester: requisition.requester?._id || requisition.requester,
  status: requisition.status,
  submittedAt: requisition.submittedAt,
  latestReview: {
    decision: requisition.latestReview?.decision || '',
    reviewedBy:
      requisition.latestReview?.reviewedBy?._id ||
      requisition.latestReview?.reviewedBy ||
      null,
    reviewedAt: requisition.latestReview?.reviewedAt || null,
    comment: requisition.latestReview?.comment || '',
  },
  jobPosting: requisition.jobPosting?._id || requisition.jobPosting || null,
  jobCreatedBy:
    requisition.jobCreatedBy?._id || requisition.jobCreatedBy || null,
  jobCreatedAt: requisition.jobCreatedAt || null,
});

const changedFieldNames = (previous, next) =>
  EDITABLE_FIELDS.filter(
    (field) => JSON.stringify(previous[field] ?? null) !== JSON.stringify(next[field] ?? null)
  );

const validateRelationships = (requisition) => {
  if (
    requisition.maxExperience !== null &&
    requisition.minExperience !== null &&
    requisition.maxExperience < requisition.minExperience
  ) {
    throw ApiError.badRequest(
      'Maximum experience cannot be less than minimum experience'
    );
  }

  if (
    requisition.salaryMax !== null &&
    requisition.salaryMin !== null &&
    requisition.salaryMax < requisition.salaryMin
  ) {
    throw ApiError.badRequest(
      'Maximum salary cannot be less than minimum salary'
    );
  }
};

const validateForSubmission = (requisition) => {
  validateRelationships(requisition);

  const missing = [];

  if (!requisition.department) missing.push('department');
  if (!requisition.position?.trim()) missing.push('position');
  if (!requisition.openings) missing.push('number of openings');
  if (!requisition.requiredSkills?.length) missing.push('required skills');
  if (!requisition.location?.trim()) missing.push('location');
  if (!requisition.expectedJoiningDate) missing.push('expected joining date');
  if (requisition.salaryMin === null) missing.push('minimum salary');
  if (requisition.salaryMax === null) missing.push('maximum salary');
  if (requisition.hiringBudget === null || requisition.hiringBudget <= 0) {
    missing.push('hiring budget');
  }
  if (
    requisition.hiringReason === 'OTHER' &&
    !requisition.hiringReasonDetails?.trim()
  ) {
    missing.push('hiring reason details');
  }
  if (
    requisition.experienceLevel === 'EXPERIENCED' &&
    requisition.maxExperience <= 0
  ) {
    missing.push('experienced candidate range');
  }

  if (missing.length) {
    throw ApiError.badRequest(
      `Complete these fields before submitting: ${missing.join(', ')}`
    );
  }
};

const nextRequisitionNumber = async (companyId) => {
  let sequence;

  try {
    sequence = await TenantSequence.findOneAndUpdate(
      { companyId, key: 'JOB_REQUISITION' },
      {
        $inc: { value: 1 },
        $setOnInsert: { companyId, key: 'JOB_REQUISITION' },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;

    sequence = await TenantSequence.findOneAndUpdate(
      { companyId, key: 'JOB_REQUISITION' },
      { $inc: { value: 1 } },
      { new: true }
    );
  }

  return `JR-${String(sequence.value).padStart(4, '0')}`;
};

const hasTenantPermission = (user, action) =>
  hasPermission(user, `REQUISITION_${action}`);

const visibilityFilter = async ({ companyId, user, action }) => {
  const tenantWide = await hasTenantPermission(user, action);

  return tenantWide
    ? { companyId }
    : { companyId, requester: user._id };
};

const findAccessibleRequisition = async ({
  companyId,
  user,
  requisitionId,
  action,
}) => {
  const filter = await visibilityFilter({ companyId, user, action });

  const requisition = await JobRequisition.findOne({
    ...filter,
    _id: requisitionId,
  });

  if (!requisition) {
    throw ApiError.notFound('Requisition not found');
  }

  return requisition;
};

const ensureDepartmentAccess = async ({ companyId, user, departmentId }) => {
  const department = await Department.findOne({
    _id: departmentId,
    companyId,
    // Legacy departments may not have a stored status yet.
    // Only an explicitly inactive department is unavailable.
    status: { $ne: 'INACTIVE' },
  });

  if (!department) {
    throw ApiError.badRequest('Department not found in your company');
  }

  const canUseAnyDepartment = await hasTenantPermission(user, 'READ');

  if (!canUseAnyDepartment && !user.department) {
    throw ApiError.forbidden(
      'An assigned department is required before you can create requisitions'
    );
  }

  if (
    !canUseAnyDepartment &&
    String(user.department) !== String(department._id)
  ) {
    throw ApiError.forbidden(
      'You can create requisitions only for your assigned department'
    );
  }

  return department;
};

export const getRequisitionOptions = async ({ companyId, user }) => {
  const canReadAll = await hasTenantPermission(user, 'READ');
  const filter = {
    companyId,
    // Keep compatibility with departments created before status was stored.
    status: { $ne: 'INACTIVE' },
  };

  if (!canReadAll) {
    filter._id = user.department || { $exists: false };
  }

  const departments = await Department.find(filter)
    .select('name status')
    .sort('name')
    .lean();

  return {
    departments,
    priorities: REQUISITION_PRIORITIES,
    experienceLevels: REQUISITION_EXPERIENCE_LEVELS,
    employmentTypes: REQUISITION_EMPLOYMENT_TYPES,
    workModes: REQUISITION_WORK_MODES,
    hiringReasons: REQUISITION_HIRING_REASONS,
    statuses: REQUISITION_STATUSES,
  };
};

export const listRequisitions = async ({ companyId, user, query = {} }) => {
  const baseFilter = await visibilityFilter({
    companyId,
    user,
    action: 'READ',
  });
  const filter = { ...baseFilter };

  if (query.status) {
    if (!REQUISITION_STATUSES.includes(query.status)) {
      throw ApiError.badRequest('Invalid requisition status');
    }
    filter.status = query.status;
  }

  if (query.priority) {
    if (!REQUISITION_PRIORITIES.includes(query.priority)) {
      throw ApiError.badRequest('Invalid requisition priority');
    }
    filter.priority = query.priority;
  }

  if (query.department) {
    filter.department = query.department;
  }

  if (query.search?.trim()) {
    const search = new RegExp(escapeRegex(query.search.trim()), 'i');
    filter.$or = [
      { requisitionNumber: search },
      { position: search },
      { team: search },
      { location: search },
    ];
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 100));

  const [requisitions, total, summaryRows] = await Promise.all([
    JobRequisition.find(filter)
      .populate('department', 'name')
      .populate('requester', 'name role department')
      .populate('lastModifiedBy', 'name role')
      .populate('latestReview.reviewedBy', 'name role')
      .populate('jobPosting', 'title status')
      .populate('jobCreatedBy', 'name role')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    JobRequisition.countDocuments(filter),
    JobRequisition.aggregate([
      { $match: baseFilter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  const summary = Object.fromEntries(
    REQUISITION_STATUSES.map((status) => [status, 0])
  );
  summaryRows.forEach((row) => {
    summary[row._id] = row.count;
  });

  return {
    requisitions,
    summary,
    meta: {
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      total,
    },
  };
};

export const getRequisition = async ({ companyId, user, requisitionId }) => {
  const filter = await visibilityFilter({
    companyId,
    user,
    action: 'READ',
  });

  const requisition = await JobRequisition.findOne({
    ...filter,
    _id: requisitionId,
  })
    .populate('department', 'name')
    .populate('requester', 'name role department')
    .populate('lastModifiedBy', 'name role')
    .populate('latestReview.reviewedBy', 'name role')
    .populate('jobPosting', 'title status')
    .populate('jobCreatedBy', 'name role')
    .populate('history.actor', 'name role')
    .lean();

  if (!requisition) {
    throw ApiError.notFound('Requisition not found');
  }

  return requisition;
};

export const createRequisition = async ({ req, payload }) => {
  const normalized = normalizePayload(payload);
  validateRelationships(normalized);

  await ensureDepartmentAccess({
    companyId: req.companyId,
    user: req.user,
    departmentId: normalized.department,
  });

  const requisitionNumber = await nextRequisitionNumber(req.companyId);
  const now = new Date();

  const requisition = await JobRequisition.create({
    ...normalized,
    companyId: req.companyId,
    requisitionNumber,
    requester: req.user._id,
    lastModifiedBy: req.user._id,
    status: 'DRAFT',
    history: [
      {
        action: 'REQUISITION_CREATED',
        fromStatus: '',
        toStatus: 'DRAFT',
        actor: req.user._id,
        actorName: req.user.name,
        actorRole: req.user.role,
        at: now,
      },
    ],
  });

  await recordAudit({
    req,
    action: 'REQUISITION_CREATED',
    companyId: req.companyId,
    resource: 'JobRequisition',
    resourceId: requisition._id,
    newValue: requisitionSnapshot(requisition),
    statusCode: 201,
    critical: true,
  });

  return getRequisition({
    companyId: req.companyId,
    user: req.user,
    requisitionId: requisition._id,
  });
};

export const updateRequisition = async ({ req, requisitionId, payload }) => {
  const requisition = await findAccessibleRequisition({
    companyId: req.companyId,
    user: req.user,
    requisitionId,
    action: 'UPDATE',
  });

  if (!EDITABLE_STATUSES.includes(requisition.status)) {
    throw ApiError.conflict(
      'Only draft or sent-back requisitions can be edited'
    );
  }

  const normalized = normalizePayload(payload);

  if (normalized.department) {
    await ensureDepartmentAccess({
      companyId: req.companyId,
      user: req.user,
      departmentId: normalized.department,
    });
  }

  const previous = requisitionSnapshot(requisition);
  Object.assign(requisition, normalized);
  validateRelationships(requisition);

  const next = requisitionSnapshot(requisition);
  const changedFields = changedFieldNames(previous, next);

  if (!changedFields.length) {
    return getRequisition({
      companyId: req.companyId,
      user: req.user,
      requisitionId: requisition._id,
    });
  }

  requisition.lastModifiedBy = req.user._id;
  requisition.history.push({
    action: 'REQUISITION_UPDATED',
    fromStatus: requisition.status,
    toStatus: requisition.status,
    actor: req.user._id,
    actorName: req.user.name,
    actorRole: req.user.role,
    changedFields,
  });

  await requisition.save();

  await recordAudit({
    req,
    action: 'REQUISITION_UPDATED',
    companyId: req.companyId,
    resource: 'JobRequisition',
    resourceId: requisition._id,
    previousValue: previous,
    newValue: requisitionSnapshot(requisition),
    metadata: { changedFields },
    critical: true,
  });

  return getRequisition({
    companyId: req.companyId,
    user: req.user,
    requisitionId: requisition._id,
  });
};

export const submitRequisition = async ({
  req,
  requisitionId,
  comment = '',
}) => {
  const requisition = await findAccessibleRequisition({
    companyId: req.companyId,
    user: req.user,
    requisitionId,
    action: 'SUBMIT',
  });

  if (!EDITABLE_STATUSES.includes(requisition.status)) {
    throw ApiError.conflict(
      'Only draft or sent-back requisitions can be submitted'
    );
  }

  validateForSubmission(requisition);

  const previous = requisitionSnapshot(requisition);
  const previousStatus = requisition.status;
  const now = new Date();

  requisition.status = 'PENDING_HR';
  requisition.submittedAt = now;
  requisition.lastModifiedBy = req.user._id;

  if (previousStatus === 'SENT_BACK') {
    requisition.latestReview = {
      decision: '',
      reviewedBy: null,
      reviewedAt: null,
      comment: '',
    };
  }

  requisition.history.push(
    {
      action: 'REQUISITION_SUBMITTED',
      fromStatus: previousStatus,
      toStatus: 'SUBMITTED',
      actor: req.user._id,
      actorName: req.user.name,
      actorRole: req.user.role,
      comment,
      at: now,
    },
    {
      action: 'REQUISITION_QUEUED_FOR_HR',
      fromStatus: 'SUBMITTED',
      toStatus: 'PENDING_HR',
      actor: req.user._id,
      actorName: req.user.name,
      actorRole: req.user.role,
      comment: 'Queued for HR review',
      at: now,
    }
  );

  await requisition.save();

  await recordAudit({
    req,
    action: 'REQUISITION_SUBMITTED',
    companyId: req.companyId,
    resource: 'JobRequisition',
    resourceId: requisition._id,
    previousValue: previous,
    newValue: requisitionSnapshot(requisition),
    metadata: { comment },
    critical: true,
  });

  await notifyRoles(
    req.companyId,
    ['COMPANY_ADMIN', 'HR_MANAGER'],
    {
      type: 'RECRUITMENT',
      title: 'New requisition awaiting HR review',
      message: `${requisition.requisitionNumber} · ${requisition.position}`,
      link: '/app/recruitment/approvals',
    }
  );

  return getRequisition({
    companyId: req.companyId,
    user: req.user,
    requisitionId: requisition._id,
  });
};

const REVIEW_CONFIG = {
  APPROVED: {
    action: 'REQUISITION_APPROVED',
    notificationTitle: 'Your requisition was approved',
  },
  REJECTED: {
    action: 'REQUISITION_REJECTED',
    notificationTitle: 'Your requisition was rejected',
  },
  SENT_BACK: {
    action: 'REQUISITION_SENT_BACK',
    notificationTitle: 'Changes requested on your requisition',
  },
};

const reviewRequisition = async ({
  req,
  requisitionId,
  decision,
  comment = '',
}) => {
  const config = REVIEW_CONFIG[decision];
  const normalizedComment = String(comment || '').trim();

  if (!config) {
    throw ApiError.badRequest('Invalid requisition review decision');
  }

  if (['REJECTED', 'SENT_BACK'].includes(decision) && !normalizedComment) {
    throw ApiError.badRequest(
      decision === 'REJECTED'
        ? 'A rejection reason is required'
        : 'A send-back comment is required'
    );
  }

  const pending = await JobRequisition.findOne({
    _id: requisitionId,
    companyId: req.companyId,
    status: 'PENDING_HR',
  }).lean();

  if (!pending) {
    const tenantRequisition = await JobRequisition.findOne({
      _id: requisitionId,
      companyId: req.companyId,
    })
      .select('status')
      .lean();

    if (!tenantRequisition) {
      throw ApiError.notFound('Requisition not found');
    }

    throw ApiError.conflict(
      'This requisition is no longer pending HR review'
    );
  }

  const now = new Date();
  const historyEntry = {
    action: config.action,
    fromStatus: 'PENDING_HR',
    toStatus: decision,
    actor: req.user._id,
    actorName: req.user.name,
    actorRole: req.user.role,
    comment: normalizedComment,
    at: now,
  };

  const requisition = await JobRequisition.findOneAndUpdate(
    {
      _id: requisitionId,
      companyId: req.companyId,
      status: 'PENDING_HR',
    },
    {
      $set: {
        status: decision,
        lastModifiedBy: req.user._id,
        latestReview: {
          decision,
          reviewedBy: req.user._id,
          reviewedAt: now,
          comment: normalizedComment,
        },
      },
      $push: { history: historyEntry },
    },
    { new: true, runValidators: true }
  )
    .populate('department', 'name')
    .populate('requester', 'name role department')
    .populate('lastModifiedBy', 'name role')
    .populate('latestReview.reviewedBy', 'name role')
    .populate('history.actor', 'name role');

  if (!requisition) {
    throw ApiError.conflict(
      'Another reviewer has already decided this requisition'
    );
  }

  await recordAudit({
    req,
    action: config.action,
    companyId: req.companyId,
    resource: 'JobRequisition',
    resourceId: requisition._id,
    targetUserId: pending.requester?._id || pending.requester,
    previousValue: requisitionSnapshot(pending),
    newValue: requisitionSnapshot(requisition),
    metadata: {
      decision,
      comment: normalizedComment,
      reviewerId: req.user._id,
      reviewedAt: now,
    },
    critical: true,
  });

  const notificationMessage = [
    `${requisition.requisitionNumber} · ${requisition.position}`,
    normalizedComment,
  ]
    .filter(Boolean)
    .join(' — ')
    .slice(0, 300);

  await notifyUser(
    req.companyId,
    pending.requester?._id || pending.requester,
    {
      type: 'RECRUITMENT',
      title: config.notificationTitle,
      message: notificationMessage,
      link: '/app/recruitment/requisitions',
    }
  );

  return requisition.toObject();
};

export const approveRequisition = (requestContext) =>
  reviewRequisition({ ...requestContext, decision: 'APPROVED' });

export const rejectRequisition = (requestContext) =>
  reviewRequisition({ ...requestContext, decision: 'REJECTED' });

export const sendBackRequisition = (requestContext) =>
  reviewRequisition({ ...requestContext, decision: 'SENT_BACK' });

const defaultJobDescription = (requisition) => {
  const experience = requisition.experienceLevel === 'FRESHER'
    ? 'Fresher'
    : `${requisition.minExperience}–${requisition.maxExperience} years`;

  return [
    `${requisition.position} role${requisition.team ? ` for ${requisition.team}` : ''}.`,
    requisition.requiredSkills?.length
      ? `Required skills: ${requisition.requiredSkills.join(', ')}.`
      : '',
    requisition.preferredSkills?.length
      ? `Preferred skills: ${requisition.preferredSkills.join(', ')}.`
      : '',
    `Experience: ${experience}.`,
    requisition.hiringReasonDetails
      ? `Hiring context: ${requisition.hiringReasonDetails}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 2000);
};

export const createJobFromRequisition = async ({
  req,
  requisitionId,
  payload = {},
}) => {
  const requisition = await JobRequisition.findOne({
    _id: requisitionId,
    companyId: req.companyId,
  });

  if (!requisition) {
    throw ApiError.notFound('Requisition not found');
  }

  if (requisition.status !== 'APPROVED') {
    throw ApiError.conflict(
      'Only an approved requisition can be converted into a job'
    );
  }

  if (requisition.jobPosting) {
    throw ApiError.conflict(
      'A job has already been created from this requisition'
    );
  }

  const existingJob = await JobPosting.findOne({
    companyId: req.companyId,
    sourceRequisition: requisition._id,
  }).select('_id');

  if (existingJob) {
    throw ApiError.conflict(
      'A job has already been created from this requisition'
    );
  }

  const department = await Department.findOne({
    _id: requisition.department,
    companyId: req.companyId,
    status: { $ne: 'INACTIVE' },
  }).select('_id');

  if (!department) {
    throw ApiError.badRequest(
      'The approved requisition department is no longer available'
    );
  }

  const now = new Date();
  const jobCode = await nextJobCode(req.companyId);
  let job;

  try {
    job = await JobPosting.create({
      companyId: req.companyId,
      jobCode,
      sourceRequisition: requisition._id,
      sourceRequisitionNumber: requisition.requisitionNumber,
      title: requisition.position,
      department: department._id,
      team: requisition.team,
      location: requisition.location,
      employmentType: requisition.employmentType,
      openings: requisition.openings,
      description:
        String(payload.description || '').trim() ||
        defaultJobDescription(requisition),
      workMode: requisition.workMode,
      experienceLevel: requisition.experienceLevel,
      minExperience: requisition.minExperience,
      maxExperience: requisition.maxExperience,
      requiredSkills: requisition.requiredSkills,
      preferredSkills: requisition.preferredSkills,
      salaryMin: requisition.salaryMin,
      salaryMax: requisition.salaryMax,
      hiringBudget: requisition.hiringBudget,
      hiringReason: requisition.hiringReason,
      hiringReasonDetails: requisition.hiringReasonDetails,
      priority: requisition.priority,
      expectedJoiningDate: requisition.expectedJoiningDate,
      status: 'OPEN',
      createdBy: req.user._id,
    });
  } catch (error) {
    if (error.code === 11000) {
      throw ApiError.conflict(
        'A job has already been created from this requisition'
      );
    }

    throw error;
  }

  const linkedRequisition = await JobRequisition.findOneAndUpdate(
    {
      _id: requisition._id,
      companyId: req.companyId,
      status: 'APPROVED',
      jobPosting: null,
    },
    {
      $set: {
        jobPosting: job._id,
        jobCreatedBy: req.user._id,
        jobCreatedAt: now,
        lastModifiedBy: req.user._id,
      },
      $push: {
        history: {
          action: 'REQUISITION_JOB_CREATED',
          fromStatus: 'APPROVED',
          toStatus: 'APPROVED',
          actor: req.user._id,
          actorName: req.user.name,
          actorRole: req.user.role,
          comment: `Created job posting ${job.title}`,
          at: now,
        },
      },
    },
    { new: true, runValidators: true }
  );

  if (!linkedRequisition) {
    await JobPosting.deleteOne({
      _id: job._id,
      companyId: req.companyId,
      sourceRequisition: requisition._id,
    });

    throw ApiError.conflict(
      'Another HR user has already created a job from this requisition'
    );
  }

  await recordAudit({
    req,
    action: 'REQUISITION_JOB_CREATED',
    companyId: req.companyId,
    resource: 'JobPosting',
    resourceId: job._id,
    targetUserId: requisition.requester,
    previousValue: requisitionSnapshot(requisition),
    newValue: requisitionSnapshot(linkedRequisition),
    metadata: {
      requisitionId: requisition._id,
      requisitionNumber: requisition.requisitionNumber,
      jobId: job._id,
    },
    statusCode: 201,
    critical: true,
  });

  await notifyUser(req.companyId, requisition.requester, {
    type: 'RECRUITMENT',
    title: 'Job created from your approved requisition',
    message: `${requisition.requisitionNumber} · ${job.title}`,
    link: '/app/recruitment/requisitions',
  });

  await job.populate('department', 'name');
  await job.populate('sourceRequisition', 'requisitionNumber position');

  return job.toObject();
};
