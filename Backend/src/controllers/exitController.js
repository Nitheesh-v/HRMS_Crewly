// ─────────────────────────────────────────────────────────────
// Exit process controller — resignation submit / approve / reject.
//
// ⚠️ RESPONSE CONTRACTS (ExitProcessPage depends on these):
//   GET /exit/my       → data: [ resignation ]            (own)
//   GET /exit/requests → data: [ resignation + user populated ]
//
// 💡 Auto-deactivation without cron: every time HR opens the
//    requests list, we sweep APPROVED resignations whose last
//    working date has passed and set user.status = INACTIVE.
// ─────────────────────────────────────────────────────────────
import Resignation from '../models/Resignation.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ROLES } from '../utils/constants.js';
import { notifyUser, notifyRoles } from '../utils/notify.js';



const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const ymd = (v) => {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
};
const startOfDayUTC = (s) => new Date(`${s}T00:00:00Z`);

// POST /api/exit/resign — any employee submits their own
export const resign = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { reason, lastWorkingDate } = req.body;
  const today = todayIST();

  const lwd = ymd(lastWorkingDate);
  if (lwd < today) throw ApiError.badRequest('Last working date cannot be in the past');

  // Only ONE active resignation at a time
  // DB Logic - DB logics
  const existing = await Resignation.findOne({
    companyId: req.companyId,
    user: req.user._id,
    $or: [
      { status: 'PENDING' },
      { status: 'APPROVED', lastWorkingDate: { $gte: startOfDayUTC(today) } },
    ],
  });
  if (existing) throw ApiError.conflict('You already have an active resignation request');

  const resignation = await Resignation.create({
    companyId: req.companyId,
    user: req.user._id,
    reason,
    lastWorkingDate: startOfDayUTC(lwd),
  });

  // Phase 8 🔔 alert all HR staff about the new resignation
  notifyRoles(req.companyId, [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER], {
    type: 'EXIT', title: 'New resignation received 📨',
    message: `${req.user.name} submitted a resignation (last day: ${ymd(resignation.lastWorkingDate)})`,
    link: '/app/exit',
  });

  // Data to frontend - response to frontend
  return ApiResponse.created(res, { message: 'Resignation submitted. HR will review it.', data: resignation });
});

// GET /api/exit/my — own history
export const myResignations = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const list = await Resignation.find({ companyId: req.companyId, user: req.user._id })
    .populate('decidedBy', 'name')
    .sort('-createdAt');
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Your resignations', data: list });
});

// GET /api/exit/requests?status=PENDING — HR view (+ lazy sweep)
export const listRequests = asyncHandler(async (req, res) => {
  const today = todayIST();

  // 🧹 Lazy sweep: deactivate accounts whose last working date passed
  // DB Logic - DB logics
  const approved = await Resignation.find({ companyId: req.companyId, status: 'APPROVED' })
    .populate('user', 'status');
  for (const r of approved) {
    if (ymd(r.lastWorkingDate) < today && r.user?.status === 'ACTIVE') {
      await User.updateOne({ _id: r.user._id }, { $set: { status: 'INACTIVE' } });
    }
  }

  // Data from frontend - requests from frontend
  const filter = { companyId: req.companyId };
  if (req.query.status) filter.status = req.query.status;
  const list = await Resignation.find(filter)
    .populate('user', 'name email role status employeeCode')
    .populate('decidedBy', 'name')
    .sort('-createdAt');
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Resignation requests', data: list });
});

// PATCH /api/exit/:id/decide { action: APPROVE|REJECT, note? } — HR
export const decideResignation = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { action, note } = req.body;
  // DB Logic - DB logics
  const resignation = await Resignation.findOne({ _id: req.params.id, companyId: req.companyId })
    .populate('user', 'name status');
  if (!resignation) throw ApiError.notFound('Resignation not found');
  if (resignation.status !== 'PENDING') throw ApiError.badRequest('This request is already decided');
  if (String(resignation.user._id) === String(req.user._id)) {
    throw ApiError.badRequest("You cannot decide on your own resignation — ask another admin/HR");
  }

  resignation.status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  resignation.decisionNote = note || '';
  resignation.decidedBy = req.user._id;
  resignation.decidedAt = new Date();
  await resignation.save();

  let msg = `Resignation ${resignation.status.toLowerCase()}`;
  if (resignation.status === 'APPROVED') {
    if (ymd(resignation.lastWorkingDate) <= todayIST()) {
      await User.updateOne({ _id: resignation.user._id }, { $set: { status: 'INACTIVE' } });
      msg += ' — account deactivated (last working date reached)';
    } else {
      msg += ' — account will auto-deactivate after the last working date';
    }
  }

  // Phase 8 🔔 tell the employee the decision
  notifyUser(req.companyId, resignation.user._id, {
    type: 'EXIT', title: `Resignation ${resignation.status.toLowerCase()}`,
    message: msg, link: '/app/exit',
  });

  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: msg, data: resignation });
});

// PATCH /api/exit/:id/withdraw — owner only, while PENDING
export const withdrawResignation = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const resignation = await Resignation.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!resignation) throw ApiError.notFound('Resignation not found');
  // Data from frontend - requests from frontend
  if (String(resignation.user) !== String(req.user._id)) {
    throw ApiError.forbidden('You can only withdraw your own resignation');
  }
  if (resignation.status !== 'PENDING') throw ApiError.badRequest('Only PENDING requests can be withdrawn');

  resignation.status = 'WITHDRAWN';
  await resignation.save();
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Resignation withdrawn', data: resignation });
});