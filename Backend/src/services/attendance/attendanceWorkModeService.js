// ─────────────────────────────────────────────────────────────
// Phase 31.4 — work-mode request service.
//
// Authorization workflow for non-office work. Requests NEVER
// create attendance, NEVER mark Present, NEVER touch payroll —
// they only authorize a later CLOCK_IN under that mode.
//
// Injectable deps (models / org-scope / notify / audit) keep the
// hermetic suite DB-free. Tenant authority is ALWAYS the
// explicit companyId argument (req.companyId at the edge).
// ─────────────────────────────────────────────────────────────
import ApiError from '../../utils/ApiError.js';
import AttendanceWorkModeRequest from '../../models/AttendanceWorkModeRequest.js';
import AttendanceEvent from '../../models/AttendanceEvent.js';
import Leave from '../../models/Leave.js';
import User from '../../models/User.js';
import { ROLES } from '../../utils/constants.js';
import { resolveScopeIds as defaultResolveScopeIds } from '../../utils/orgHelpers.js';
import { notifySmart } from '../../utils/notifyPref.js';
import { recordAudit } from '../../utils/securityauditService.js';
import { getCurrentPolicy } from './attendancePolicyService.js';
import {
  DAY_PORTION,
  REQUEST_STATUS,
  cancelEligibility,
  findAuthorization,
  findOverlappingRequest,
  modeRequiresApproval,
  requestPolicyCheck,
  requestableModesForPolicy,
  reviewEligibility,
  validateRequestInput,
  validateReviewReason,
} from './attendanceWorkModeRules.js';

const writeAudit = (args) => recordAudit(args);

// Safe notify wrapper (Leave pattern): never throws, never blocks.
const safeNotify = async (notify, userId, payload) => {
  try {
    if (userId) await notify(userId, payload);
  } catch {
    // Fire-and-forget: notification failure never rolls back a
    // committed workflow mutation.
  }
};

const defaultNotify = (userId, payload) => notifySmart(userId, payload);

// Company-calendar day key (same semantics as the 31.2 dayKeyInZone;
// local copy avoids an event-service import cycle).
const dayKeyInZone = (at, timezone) => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at instanceof Date ? at : new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
};

const MODE_LABEL = Object.freeze({
  WFH: 'Work From Home',
  FIELD: 'Field Work',
  CLIENT_SITE: 'Client Site',
  BUSINESS_TRAVEL: 'Business Travel',
});

const rangeLabel = (startDate, endDate) =>
  startDate === endDate ? startDate : `${startDate} → ${endDate}`;

const idOf = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

// ── Serialize ────────────────────────────────────────────

export const serializeWorkModeRequest = (row, options = {}) => {
  if (!row) return null;
  const obj = typeof row.toObject === 'function' ? row.toObject() : row;
  const { viewerId = null, isReviewer = false, usedIds = null, today = null } = options;
  const isOwner = viewerId != null && String(obj.user?._id || obj.user) === String(viewerId);
  const used = usedIds ? usedIds.has(String(obj._id || obj.id)) : false;
  return {
    id: String(obj._id || obj.id || ''),
    mode: obj.mode,
    modeLabel: MODE_LABEL[obj.mode] || obj.mode,
    startDate: obj.startDate,
    endDate: obj.endDate,
    dayPortion: obj.dayPortion || DAY_PORTION.FULL_DAY,
    reason: obj.reason || '',
    placeLabel: obj.placeLabel || null,
    status: obj.status,
    approver: obj.approver
      ? { id: idOf(obj.approver), name: obj.approver?.name || null }
      : null,
    reviewReason: obj.reviewReason || null,
    decidedAt: obj.decidedAt || null,
    cancelledAt: obj.cancelledAt || null,
    createdAt: obj.createdAt || null,
    employee: obj.user && typeof obj.user === 'object' && obj.user.name
      ? {
          id: String(obj.user._id || ''),
          name: obj.user.name || '',
          email: obj.user.email || null,
          designation: obj.user.designation || null,
        }
      : null,
    canCancel:
      cancelEligibility(
        obj,
        { isOwner, isReviewer, usedForAttendance: used, today },
      ) === null,
  };
};

// ── Internal helpers ─────────────────────────────────────

const readPolicy = async ({ companyId, policyReader, RequestPolicyModel }) =>
  policyReader
    ? policyReader({ companyId })
    : getCurrentPolicy({ companyId, AttendancePolicyModel: RequestPolicyModel });

const overlappingActive = async ({ RequestModel, companyId, userId, startDate, endDate, excludeId = null }) => {
  const filter = {
    companyId,
    user: userId,
    status: { $in: [REQUEST_STATUS.PENDING, REQUEST_STATUS.APPROVED] },
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return RequestModel.find(filter).lean();
};

// APPROVED Leave wins over a work-mode authorization for any
// shared day (Leave carries no day portions, so any overlap on a
// day is a conflict). Read-only: Leave is never mutated here.
const findLeaveConflict = async ({ LeaveModel, companyId, userId, startDate, endDate }) => {
  const rows = await LeaveModel.find({
    companyId,
    user: userId,
    status: 'APPROVED',
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  }).lean();
  return rows?.[0] || null;
};

const usedRequestIds = async ({ AttendanceEventModel, companyId, requestIds }) => {
  if (!requestIds.length) return new Set();
  const rows = await AttendanceEventModel.find({
    companyId,
    'authorization.requestId': { $in: requestIds },
  })
    .select('authorization.requestId')
    .lean();
  return new Set((rows || []).map((row) => String(row.authorization?.requestId)));
};

// Resolved approver(s) for submit/cancel notifications: direct
// manager when set, else company Admin + HR (Leave pattern).
const notifyApprovers = async ({ UserModel, notify, companyId, requester, payload }) => {
  if (requester?.reportingTo) {
    await safeNotify(notify, requester.reportingTo, payload);
    return;
  }
  try {
    const bosses = await UserModel.find({
      companyId,
      role: { $in: [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER] },
      _id: { $ne: requester?._id },
    })
      .select('_id')
      .lean();
    await Promise.all(
      (bosses || []).map((boss) => safeNotify(notify, boss._id, payload)),
    );
  } catch {
    // Notification discovery failure never blocks the workflow.
  }
};

// ── Submit ───────────────────────────────────────────────

export const submitWorkModeRequest = async ({
  companyId,
  requester,
  input = {},
  today = null,
  policyReader = null,
  RequestModel = AttendanceWorkModeRequest,
  LeaveModel = Leave,
  UserModel = User,
  AttendancePolicyModel,
  notify = defaultNotify,
  audit = writeAudit,
}) => {
  const userId = requester?._id || requester?.id;
  if (!companyId || !userId) throw ApiError.badRequest('Company and employee context are required');

  const normalized = {
    mode: input.mode,
    startDate: input.startDate,
    endDate: input.endDate || input.startDate,
    dayPortion: input.dayPortion || DAY_PORTION.FULL_DAY,
    reason: typeof input.reason === 'string' ? input.reason.trim() : input.reason,
    placeLabel:
      input.placeLabel === undefined || input.placeLabel === null
        ? null
        : String(input.placeLabel).trim() || null,
  };

  const { policy } = await readPolicy({ companyId, policyReader, RequestPolicyModel: AttendancePolicyModel });
  const day = today || dayKeyInZone(new Date(), policy?.timezone);

  const errors = validateRequestInput(normalized, day);
  const policyRefusal = requestPolicyCheck(normalized.mode, policy);
  if (policyRefusal) errors.push(policyRefusal);
  if (errors.length) throw ApiError.badRequest(errors.join('; '));

  const overlap = findOverlappingRequest(
    normalized,
    await overlappingActive({ RequestModel, companyId, userId, startDate: normalized.startDate, endDate: normalized.endDate }),
  );
  if (overlap) {
    throw ApiError.conflict(
      `Overlaps your ${String(overlap.status).toLowerCase()} ${overlap.mode} request (${rangeLabel(overlap.startDate, overlap.endDate)})`,
    );
  }

  const leave = await findLeaveConflict({
    LeaveModel,
    companyId,
    userId,
    startDate: normalized.startDate,
    endDate: normalized.endDate,
  });
  if (leave) {
    throw ApiError.conflict(
      `Approved leave already covers ${rangeLabel(leave.startDate, leave.endDate)} — a work-mode request cannot share those days`,
    );
  }

  const created = await RequestModel.create({
    companyId,
    user: userId,
    ...normalized,
  });

  await audit({
    action: 'ATTENDANCE_WORK_MODE_SUBMITTED',
    resource: 'AttendanceWorkModeRequest',
    resourceId: String(created._id || created.id),
    companyId,
    actorId: String(userId),
    newValue: {
      mode: normalized.mode,
      startDate: normalized.startDate,
      endDate: normalized.endDate,
      dayPortion: normalized.dayPortion,
      from: null,
      to: REQUEST_STATUS.PENDING,
    },
  });

  // Payload carries identity + period only — never the reason text.
  await notifyApprovers({
    UserModel,
    notify,
    companyId,
    requester,
    payload: {
      title: 'New work-mode request',
      message: `${requester?.name || 'An employee'} requested ${MODE_LABEL[normalized.mode] || normalized.mode} for ${rangeLabel(normalized.startDate, normalized.endDate)}`,
      link: '/app/attendance/work-modes',
      category: 'ATTENDANCE',
    },
  });

  return serializeWorkModeRequest(created, { viewerId: userId, today: day });
};

// ── Read ─────────────────────────────────────────────────

export const listMyWorkModeRequests = async ({
  companyId,
  userId,
  today = null,
  policyReader = null,
  RequestModel = AttendanceWorkModeRequest,
  AttendanceEventModel = AttendanceEvent,
  AttendancePolicyModel,
}) => {
  const { policy } = await readPolicy({ companyId, policyReader, RequestPolicyModel: AttendancePolicyModel });
  const day = today || dayKeyInZone(new Date(), policy?.timezone);
  const rows = await RequestModel.find({ companyId, user: userId }).sort({ createdAt: -1 }).lean();
  const approvedIds = (rows || [])
    .filter((row) => row.status === REQUEST_STATUS.APPROVED)
    .map((row) => row._id);
  const used = await usedRequestIds({ AttendanceEventModel, companyId, requestIds: approvedIds });
  return {
    requests: (rows || []).map((row) =>
      serializeWorkModeRequest(row, { viewerId: userId, today: day, usedIds: used }),
    ),
    // Server-computed so employees never need policy-read rights
    // to see which modes they may request.
    requestableModes: requestableModesForPolicy(policy),
  };
};

export const listPendingWorkModeRequests = async ({
  companyId,
  viewer,
  today = null,
  policyReader = null,
  RequestModel = AttendanceWorkModeRequest,
  AttendancePolicyModel,
  resolveScopeIds = defaultResolveScopeIds,
}) => {
  const { policy } = await readPolicy({ companyId, policyReader, RequestPolicyModel: AttendancePolicyModel });
  const day = today || dayKeyInZone(new Date(), policy?.timezone);
  const scopeIds = await resolveScopeIds({ companyId, user: viewer });
  const rows = await RequestModel.find({
    companyId,
    status: REQUEST_STATUS.PENDING,
    user: { $in: scopeIds },
  })
    .populate({ path: 'user', select: 'name email designation' })
    .sort({ createdAt: 1 })
    .lean();
  return (rows || []).map((row) =>
    serializeWorkModeRequest(row, { viewerId: viewer?._id, isReviewer: true, today: day }),
  );
};

export const getWorkModeRequest = async ({
  companyId,
  viewer,
  requestId,
  asReviewer = false,
  today = null,
  policyReader = null,
  RequestModel = AttendanceWorkModeRequest,
  AttendanceEventModel = AttendanceEvent,
  AttendancePolicyModel,
  resolveScopeIds = defaultResolveScopeIds,
}) => {
  const row = await RequestModel.findOne({ _id: requestId, companyId })
    .populate({ path: 'user', select: 'name email designation' })
    .populate({ path: 'approver', select: 'name' })
    .lean();
  if (!row) throw ApiError.notFound('Work-mode request not found');
  const isOwner = String(row.user?._id || row.user) === String(viewer?._id || viewer?.id);
  if (!isOwner) {
    if (!asReviewer) throw ApiError.notFound('Work-mode request not found');
    const scopeIds = (await resolveScopeIds({ companyId, user: viewer })).map(String);
    if (!scopeIds.includes(String(row.user?._id || row.user))) {
      throw ApiError.forbidden('This employee is not in your team');
    }
  }
  const { policy } = await readPolicy({ companyId, policyReader, RequestPolicyModel: AttendancePolicyModel });
  const day = today || dayKeyInZone(new Date(), policy?.timezone);
  const used =
    row.status === REQUEST_STATUS.APPROVED
      ? await usedRequestIds({ AttendanceEventModel, companyId, requestIds: [row._id] })
      : new Set();
  return serializeWorkModeRequest(row, {
    viewerId: viewer?._id || viewer?.id,
    isReviewer: asReviewer,
    today: day,
    usedIds: used,
  });
};

// ── Decide (approve / reject) ────────────────────────────

export const decideWorkModeRequest = async ({
  companyId,
  viewer,
  requestId,
  action,
  reviewReason = null,
  today = null,
  policyReader = null,
  RequestModel = AttendanceWorkModeRequest,
  LeaveModel = Leave,
  UserModel = User,
  AttendancePolicyModel,
  resolveScopeIds = defaultResolveScopeIds,
  notify = defaultNotify,
  audit = writeAudit,
}) => {
  const reviewerId = viewer?._id || viewer?.id;
  const row = await RequestModel.findOne({ _id: requestId, companyId });
  if (!row) throw ApiError.notFound('Work-mode request not found');

  const eligibility = reviewEligibility(row, reviewerId);
  if (eligibility) {
    const gone = row.status !== REQUEST_STATUS.PENDING;
    throw gone ? ApiError.conflict(eligibility) : ApiError.forbidden(eligibility);
  }
  const scopeIds = (await resolveScopeIds({ companyId, user: viewer })).map(String);
  if (!scopeIds.includes(String(row.user))) {
    throw ApiError.forbidden('This employee is not in your team');
  }

  const approve = action === 'APPROVE';
  if (!approve && action !== 'REJECT') throw ApiError.badRequest('action must be APPROVE or REJECT');

  const reasonError = validateReviewReason(reviewReason, { required: !approve });
  if (reasonError) throw ApiError.badRequest(reasonError);

  const { policy } = await readPolicy({ companyId, policyReader, RequestPolicyModel: AttendancePolicyModel });
  const day = today || dayKeyInZone(new Date(), policy?.timezone);

  let to = REQUEST_STATUS.REJECTED;
  if (approve) {
    // Revalidate everything at decision time: policy may have
    // changed since submission.
    const policyRefusal = requestPolicyCheck(row.mode, policy);
    if (policyRefusal) throw ApiError.conflict(policyRefusal);
    const overlap = findOverlappingRequest(
      row,
      await overlappingActive({
        RequestModel,
        companyId,
        userId: row.user,
        startDate: row.startDate,
        endDate: row.endDate,
        excludeId: row._id,
      }),
    );
    if (overlap) {
      throw ApiError.conflict(
        `Overlaps the employee's ${String(overlap.status).toLowerCase()} ${overlap.mode} request (${rangeLabel(overlap.startDate, overlap.endDate)})`,
      );
    }
    const leave = await findLeaveConflict({
      LeaveModel,
      companyId,
      userId: row.user,
      startDate: row.startDate,
      endDate: row.endDate,
    });
    if (leave) {
      throw ApiError.conflict(
        `Approved leave already covers ${rangeLabel(leave.startDate, leave.endDate)} — cannot approve over it`,
      );
    }
    to = REQUEST_STATUS.APPROVED;
  }

  const decidedAt = new Date();
  const updated = await RequestModel.findOneAndUpdate(
    { _id: row._id, companyId, status: REQUEST_STATUS.PENDING },
    {
      $set: {
        status: to,
        approver: reviewerId,
        reviewReason: typeof reviewReason === 'string' && reviewReason.trim() ? reviewReason.trim() : null,
        decidedAt,
      },
    },
    { new: true },
  );
  // Lost a decide race (or left PENDING concurrently): refuse, never
  // silently double-decide.
  if (!updated) throw ApiError.conflict('Request is no longer pending');

  await audit({
    action: approve ? 'ATTENDANCE_WORK_MODE_APPROVED' : 'ATTENDANCE_WORK_MODE_REJECTED',
    resource: 'AttendanceWorkModeRequest',
    resourceId: String(row._id),
    companyId,
    actorId: String(reviewerId),
    newValue: {
      mode: row.mode,
      startDate: row.startDate,
      endDate: row.endDate,
      dayPortion: row.dayPortion,
      from: REQUEST_STATUS.PENDING,
      to,
    },
  });

  await safeNotify(notify, row.user, {
    title: approve ? 'Work-mode request approved' : 'Work-mode request rejected',
    message: `Your ${MODE_LABEL[row.mode] || row.mode} request (${rangeLabel(row.startDate, row.endDate)}) was ${approve ? 'approved' : 'rejected'} by ${viewer?.name || 'your reviewer'}`,
    link: '/app/attendance/work-modes',
    category: 'ATTENDANCE',
  });

  const plain = typeof updated.toObject === 'function' ? updated.toObject() : updated;
  return serializeWorkModeRequest(
    { ...plain, approver: { _id: reviewerId, name: viewer?.name || null } },
    { viewerId: reviewerId, isReviewer: true, today: day },
  );
};

// ── Cancel ───────────────────────────────────────────────

export const cancelWorkModeRequest = async ({
  companyId,
  viewer,
  requestId,
  asReviewer = false,
  today = null,
  policyReader = null,
  RequestModel = AttendanceWorkModeRequest,
  AttendanceEventModel = AttendanceEvent,
  AttendancePolicyModel,
  resolveScopeIds = defaultResolveScopeIds,
  notify = defaultNotify,
  audit = writeAudit,
}) => {
  const viewerId = viewer?._id || viewer?.id;
  const row = await RequestModel.findOne({ _id: requestId, companyId });
  if (!row) throw ApiError.notFound('Work-mode request not found');

  const isOwner = String(row.user) === String(viewerId);
  let inScope = false;
  if (asReviewer && !isOwner) {
    const scopeIds = (await resolveScopeIds({ companyId, user: viewer })).map(String);
    inScope = scopeIds.includes(String(row.user));
  }
  const used =
    row.status === REQUEST_STATUS.APPROVED
      ? (
          await usedRequestIds({ AttendanceEventModel, companyId, requestIds: [row._id] })
        ).has(String(row._id))
      : false;

  const { policy } = await readPolicy({ companyId, policyReader, RequestPolicyModel: AttendancePolicyModel });
  const day = today || dayKeyInZone(new Date(), policy?.timezone);

  const refusal = cancelEligibility(row, {
    isOwner,
    isReviewer: asReviewer && (inScope || isOwner),
    usedForAttendance: used,
    today: day,
  });
  if (refusal) {
    const forbidden = /not authorized|not in your team/.test(refusal);
    throw forbidden ? ApiError.forbidden(refusal) : ApiError.conflict(refusal);
  }

  // Capture the pre-image BEFORE the update: some stores alias the
  // loaded row, so row.status must not be re-read after this point.
  const fromStatus = row.status;
  const cancelledAt = new Date();
  const updated = await RequestModel.findOneAndUpdate(
    { _id: row._id, companyId, status: fromStatus },
    { $set: { status: REQUEST_STATUS.CANCELLED, cancelledBy: viewerId, cancelledAt } },
    { new: true },
  );
  if (!updated) throw ApiError.conflict('Request changed while cancelling — please retry');

  await audit({
    action: 'ATTENDANCE_WORK_MODE_CANCELLED',
    resource: 'AttendanceWorkModeRequest',
    resourceId: String(row._id),
    companyId,
    actorId: String(viewerId),
    newValue: {
      mode: row.mode,
      startDate: row.startDate,
      endDate: row.endDate,
      dayPortion: row.dayPortion,
      from: fromStatus,
      to: REQUEST_STATUS.CANCELLED,
    },
  });

  // Tell the other party. Owners cancelling their own pending
  // request ping the direct manager when one is set.
  if (isOwner && fromStatus === REQUEST_STATUS.PENDING && viewer?.reportingTo) {
    await safeNotify(notify, viewer.reportingTo, {
      title: 'Work-mode request cancelled',
      message: `${viewer?.name || 'An employee'} cancelled a pending ${MODE_LABEL[row.mode] || row.mode} request (${rangeLabel(row.startDate, row.endDate)})`,
      link: '/app/attendance/work-modes',
      category: 'ATTENDANCE',
    });
  } else if (!isOwner) {
    await safeNotify(notify, row.user, {
      title: 'Work-mode request cancelled',
      message: `Your ${MODE_LABEL[row.mode] || row.mode} request (${rangeLabel(row.startDate, row.endDate)}) was cancelled by ${viewer?.name || 'your reviewer'}`,
      link: '/app/attendance/work-modes',
      category: 'ATTENDANCE',
    });
  }

  const plain = typeof updated.toObject === 'function' ? updated.toObject() : updated;
  return serializeWorkModeRequest(plain, {
    viewerId,
    isReviewer: asReviewer,
    today: day,
  });
};

// ── Attendance integration ───────────────────────────────
// Read-only: matching an authorization NEVER mutates the request.

export const findClockInAuthorization = async ({
  WorkModeRequestModel = AttendanceWorkModeRequest,
  companyId,
  userId,
  mode,
  date,
  policy,
}) => {
  // OFFICE (and legacy-unknown modes) never need a request.
  if (!modeRequiresApproval(mode, policy)) return null;
  const row = await WorkModeRequestModel.findOne({
    companyId,
    user: userId,
    mode,
    status: REQUEST_STATUS.APPROVED,
    startDate: { $lte: date },
    endDate: { $gte: date },
  }).lean();
  if (!row) {
    throw ApiError.forbidden(`Approved ${MODE_LABEL[mode] || mode} request required for ${date}`);
  }
  // Minimal snapshot: enough to interpret history, no workflow data.
  return {
    requestId: row._id,
    mode: row.mode,
    startDate: row.startDate,
    endDate: row.endDate,
    dayPortion: row.dayPortion || DAY_PORTION.FULL_DAY,
  };
};

// Today-card map: may this employee clock in under each non-office
// mode today? Enabled + (approval-free OR approved cover).
export const getWorkModeAuthorization = async ({
  WorkModeRequestModel = AttendanceWorkModeRequest,
  companyId,
  userId,
  date,
  policy,
}) => {
  const modes = ['WFH', 'FIELD', 'CLIENT_SITE', 'BUSINESS_TRAVEL'];
  const map = Object.fromEntries(modes.map((mode) => [mode, false]));
  if (!policy) return map;
  const needLookup = modes.filter(
    (mode) => !requestPolicyCheck(mode, policy) && modeRequiresApproval(mode, policy),
  );
  modes.forEach((mode) => {
    if (!requestPolicyCheck(mode, policy) && !modeRequiresApproval(mode, policy)) {
      map[mode] = true;
    }
  });
  if (!needLookup.length) return map;
  const rows = await WorkModeRequestModel.find({
    companyId,
    user: userId,
    status: REQUEST_STATUS.APPROVED,
    startDate: { $lte: date },
    endDate: { $gte: date },
  }).lean();
  needLookup.forEach((mode) => {
    if (findAuthorization(rows, { mode, date })) map[mode] = true;
  });
  return map;
};

export const isRequestUsedForAttendance = async ({
  AttendanceEventModel = AttendanceEvent,
  companyId,
  requestId,
}) =>
  (await usedRequestIds({ AttendanceEventModel, companyId, requestIds: [requestId] })).has(
    String(requestId),
  );
