// ─────────────────────────────────────────────────────────────
// System controller — notification feed, audit log viewer,
// permission matrix and company analytics.
// ─────────────────────────────────────────────────────────────
import Notification from '../models/Notification.js';
import AuditLog from '../models/AuditLog.js';
import User from '../models/User.js';
import Department from '../models/Department.js';
import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import Payroll from '../models/Payroll.js';
import Resignation from '../models/Resignation.js';
import JobPosting from '../models/JobPosting.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { PERMISSION_MATRIX } from '../utils/permissions.js';

// ── 🔔 notifications ─────────────────────────────────────────
export const myNotifications = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const list = await Notification.find({ user: req.user._id }).sort('-createdAt').limit(20);
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Notifications', data: list });
});

export const unreadCount = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const count = await Notification.countDocuments({ user: req.user._id, readAt: null });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Unread count', data: { count } });
});

export const markRead = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  await Notification.updateOne({ _id: req.params.id, user: req.user._id }, { $set: { readAt: new Date() } });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Marked read' });
});

export const markAllRead = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  await Notification.updateMany({ user: req.user._id, readAt: null }, { $set: { readAt: new Date() } });
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'All marked read' });
});

// ── 📜 audit (HR) — filters + pagination, data = ARRAY + meta ──
export const audit = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { search, status } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Number(req.query.limit) || 15);

  const filter = { companyId: req.companyId };
  if (status === 'success') filter.statusCode = { $lt: 400 };
  if (status === 'failed') filter.statusCode = { $gte: 400 };
  if (search) {
    filter.$or = [
      { actorName: { $regex: search, $options: 'i' } },
      { action: { $regex: search, $options: 'i' } },
    ];
  }

  // DB Logic - DB logics
  const [logs, total] = await Promise.all([
    AuditLog.find(filter).sort('-createdAt').skip((page - 1) * limit).limit(limit),
    AuditLog.countDocuments(filter),
  ]);
  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Audit logs', data: logs,
    meta: { page, pages: Math.max(1, Math.ceil(total / limit)), total },
  });
});

// ── 🔐 permission matrix ─────────────────────────────────────
export const permissionMatrix = asyncHandler(async (req, res) => {
  // Data to frontend - response to frontend
  return ApiResponse.success(res, { message: 'Role permission matrix', data: PERMISSION_MATRIX });
});

// ── 📊 company analytics (HR) ────────────────────────────────
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const countWorkingDays = (start, end) => {
  let n = 0;
  let cur = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cur <= last) {
    const d = cur.getUTCDay();
    if (d !== 0 && d !== 6) n += 1;
    cur = new Date(cur.getTime() + 86400000);
  }
  return n;
};
const lastNMonths = (n) => {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7)); // 'YYYY-MM'
  }
  return out;
};

export const analyticsOverview = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const companyId = req.companyId;
  const months = lastNMonths(6);
  const monthStart = `${months[0]}-01`;

  const [
    roleAgg, activeEmployees, departments,
    pendingLeaves, pendingExits, openJobs,
    monthAttendance, leaveAgg, payrollAgg,
  // DB Logic - DB logics
  ] = await Promise.all([
    User.aggregate([{ $match: { companyId, status: 'ACTIVE' } }, { $group: { _id: '$role', count: { $sum: 1 } } }]),
    User.countDocuments({ companyId, status: 'ACTIVE' }),
    Department.countDocuments({ companyId }),
    Leave.countDocuments({ companyId, status: 'PENDING' }),
    Resignation.countDocuments({ companyId, status: 'PENDING' }),
    JobPosting.countDocuments({ companyId, status: 'OPEN' }),
    Attendance.countDocuments({ companyId, date: { $gte: `${months[5]}-01`, $lte: todayIST() } }),
    Leave.aggregate([
      { $match: { companyId, startDate: { $gte: new Date(`${monthStart}T00:00:00Z`) } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$startDate' } }, count: { $sum: 1 } } },
    ]),
    Payroll.aggregate([
      { $match: { companyId, month: { $gte: months[0] } } },
      { $group: { _id: '$month', netPay: { $sum: '$netPay' } } },
    ]),
  ]);

  // attendance rate this month = punch records ÷ (elapsed workdays × headcount)
  const elapsedWD = countWorkingDays(`${months[5]}-01`, todayIST());
  const expected = elapsedWD * Math.max(1, activeEmployees);
  const attendance = {
    records: monthAttendance,
    expected,
    rate: Math.min(100, Math.round((monthAttendance / expected) * 100)) || 0,
  };

  const leaveMap = new Map(leaveAgg.map((x) => [x._id, x.count]));
  const payrollMap = new Map(payrollAgg.map((x) => [x._id, x.netPay]));

  // Data to frontend - response to frontend
  return ApiResponse.success(res, {
    message: 'Analytics overview',
    data: {
      roleHeadcount: roleAgg.map((r) => ({ role: r._id, count: r.count })),
      attendance,
      leaveTrend: months.map((m) => ({ month: m, count: leaveMap.get(m) || 0 })),
      payrollTrend: months.map((m) => ({ month: m, netPay: payrollMap.get(m) || 0 })),
      counts: {
        employees: activeEmployees, departments, pendingLeaves, pendingExits, openJobs,
      },
    },
  });
});