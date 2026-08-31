import Leave from '../models/Leave.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ROLES, LEAVE_TYPES } from '../utils/constants.js';
import { todayString, countWorkingDays } from '../utils/dateHelpers.js';
import { resolveScopeIds, getSubtreeIds } from '../utils/orgHelpers.js';
import { notifySmart } from '../utils/notifyPref.js';

// Days already committed per type this year (APPROVED + PENDING)
const committedDays = async (userId, year) => {
  const rows = await Leave.aggregate([
    { $match: { user: userId, status: { $in: ['APPROVED', 'PENDING'] }, startDate: { $gte: `${year}-01-01` } } },
    { $group: { _id: { type: '$type', status: '$status' }, days: { $sum: '$days' } } },
  ]);
  const map = {};
  Object.keys(LEAVE_TYPES).forEach((t) => { map[t] = { approved: 0, pending: 0 }; });
  rows.forEach((r) => {
    map[r._id.type][r._id.status.toLowerCase()] += r.days;
  });
  return map;
};

const buildBalance = (committed) =>
  Object.entries(LEAVE_TYPES).map(([type, cfg]) => {
    const used = committed[type]?.approved || 0;
    const pending = committed[type]?.pending || 0;
    return { type, label: cfg.label, total: cfg.yearly, used, pending, available: cfg.yearly - used - pending };
  });

// 🔔 Phase 13 — safe notify wrapper: never throws, never blocks a workflow
const notifyLeave = async (userId, payload) => {
  try {
    if (userId) await notifySmart(userId, payload);
  } catch {}
};

/* ------------------ POST /api/leaves (apply) ------------------ */
export const applyLeave = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!req.companyId) throw ApiError.forbidden('Only company users can apply for leave');
  const { type, startDate, endDate, reason } = req.body;

  if (!LEAVE_TYPES[type]) throw ApiError.badRequest('Invalid leave type');
  if (endDate < startDate) throw ApiError.badRequest('End date cannot be before start date');
  if (startDate < todayString()) throw ApiError.badRequest('Cannot apply for past dates');

  const days = countWorkingDays(startDate, endDate);
  if (days === 0) throw ApiError.badRequest('Selected dates contain no working days (Sat/Sun are off)');

  // No overlap with an existing PENDING/APPROVED request
  // DB Logic - DB logics
  const overlap = await Leave.findOne({
    user: req.user._id,
    status: { $in: ['PENDING', 'APPROVED'] },
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  });
  if (overlap) {
    throw ApiError.conflict(`Overlaps your ${overlap.status.toLowerCase()} leave (${overlap.startDate} → ${overlap.endDate})`);
  }

  // Balance check (entitlement − approved − pending)
  const year = startDate.slice(0, 4);
  const committed = await committedDays(req.user._id, year);
  const alreadyCommitted = (committed[type].approved || 0) + (committed[type].pending || 0);
  const allowed = LEAVE_TYPES[type].yearly;
  if (alreadyCommitted + days > allowed) {
    throw ApiError.badRequest(
      `Insufficient ${LEAVE_TYPES[type].label} balance — ${allowed - alreadyCommitted} day(s) left, you asked for ${days}`
    );
  }

  const leave = await Leave.create({
    companyId: req.companyId,
    user: req.user._id,
    type, startDate, endDate, days, reason,
  });

  // 🔔 Phase 13 — ping the approver(s): direct manager if set, else Admin + HR (fire-and-forget)
  const applyPayload = {
    title: '🌴 New leave request',
    message: `${req.user.name} applied for ${LEAVE_TYPES[type].label} — ${startDate} → ${endDate} (${days} working day(s))`,
    link: '/app/leaves',
    category: 'LEAVE',
  };
  if (req.user.reportingTo) {
    notifyLeave(req.user.reportingTo, applyPayload);
  } else {
    User.find({
      companyId: req.companyId,
      role: { $in: [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER] },
      _id: { $ne: req.user._id },
    })
      .select('_id')
      .lean()
      .then((bosses) => bosses.forEach((b) => notifyLeave(b._id, applyPayload)))
      .catch(() => {});
  }

  // Data to frontend - response to frontend
  ApiResponse.created(res, { message: `Leave applied — ${days} working day(s). Waiting for approval.`, data: leave });
});

/* -------------- GET /api/leaves/my (history + balance) -------------- */
export const getMyLeaves = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const leaves = await Leave.find({ user: req.user._id })
    .populate('approver', 'name')
    .sort('-createdAt');

  const year = todayString().slice(0, 4);
  const committed = await committedDays(req.user._id, year);
  const balance = buildBalance(committed);

  // Data to frontend - response to frontend
  ApiResponse.success(res, { message: 'My leaves', data: { leaves, balance, year } });
});

/* ------- GET /api/leaves/pending (approvers' queue) ------- */
export const getPendingRequests = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const ids = await resolveScopeIds(req);
  const leaves = await Leave.find({ companyId: req.companyId, status: 'PENDING', user: { $in: ids } })
    .populate({ path: 'user', select: 'name email role designation department', populate: { path: 'department', select: 'name' } })
    .sort('createdAt');
  // Data to frontend - response to frontend
  ApiResponse.success(res, { message: 'Pending leave requests', data: leaves });
});

/* ------- GET /api/leaves/requests?status= (approvers' history) ------- */
export const getLeaveRequests = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const ids = await resolveScopeIds(req);
  // Data from frontend - requests from frontend
  const statusFilter = req.query.status && req.query.status !== 'ALL'
    ? req.query.status
    : ['APPROVED', 'REJECTED', 'CANCELLED'];

  const leaves = await Leave.find({ companyId: req.companyId, status: { $in: [].concat(statusFilter) }, user: { $in: ids } })
    .populate({ path: 'user', select: 'name email role designation' })
    .populate('approver', 'name')
    .sort('-decidedAt');
  // Data to frontend - response to frontend
  ApiResponse.success(res, { message: 'Leave requests', data: leaves });
});

/* --------- PATCH /api/leaves/:id/decide (approve/reject) --------- */
export const decideLeave = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { action, note } = req.body;

  // DB Logic - DB logics
  const leave = await Leave.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!leave) throw ApiError.notFound('Leave request not found');

  if (String(leave.user) === String(req.user._id)) {
    throw ApiError.forbidden('You cannot approve your own leave request');
  }
  if (leave.status !== 'PENDING') {
    throw ApiError.conflict(`This request is already ${leave.status.toLowerCase()}`);
  }

  // Manager/TL may only decide within their subtree; HR/Admin anywhere
  if (![ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER].includes(req.user.role)) {
    const subtree = await getSubtreeIds(req.companyId, req.user._id);
    if (!subtree.map(String).includes(String(leave.user))) {
      throw ApiError.forbidden('This employee is not in your team');
    }
  }

  leave.status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  leave.approver = req.user._id;
  leave.approverNote = note || '';
  leave.decidedAt = new Date();
  await leave.save();

  // 🔔 Phase 13 — tell the employee the verdict
  const approved = leave.status === 'APPROVED';
  const label = LEAVE_TYPES[leave.type]?.label || leave.type;
  notifyLeave(leave.user, {
    title: approved ? '✅ Leave approved' : '❌ Leave rejected',
    message: `Your ${label} (${leave.startDate} → ${leave.endDate}, ${leave.days} day(s)) was ${approved ? 'approved' : 'rejected'} by ${req.user.name}${note ? ` — "${note}"` : ''}`,
    link: '/app/leaves',
    category: 'LEAVE',
    emailText: `Hi, your ${label} leave from ${leave.startDate} to ${leave.endDate} (${leave.days} working day(s)) was ${approved ? 'APPROVED' : 'REJECTED'} by ${req.user.name}.${note ? ` Note: ${note}` : ''}`,
  });

  // Data to frontend - response to frontend
  ApiResponse.success(res, {
    message: `Leave ${leave.status.toLowerCase()} for ${dayCount(leave)} day(s)`,
    data: { id: leave._id, status: leave.status },
  });
});

const dayCount = (leave) => leave.days;

/* --------- PATCH /api/leaves/:id/cancel (own pending) --------- */
export const cancelLeave = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const leave = await Leave.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!leave) throw ApiError.notFound('Leave request not found');
  // Data from frontend - requests from frontend
  if (String(leave.user) !== String(req.user._id)) {
    throw ApiError.forbidden('You can only cancel your own requests');
  }
  if (leave.status !== 'PENDING') {
    throw ApiError.conflict('Only pending requests can be cancelled');
  }

  leave.status = 'CANCELLED';
  await leave.save();
  // Data to frontend - response to frontend
  ApiResponse.success(res, { message: 'Leave request cancelled' });
});