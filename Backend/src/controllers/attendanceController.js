import Attendance from '../models/Attendance.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ROLES, WORK_START_TIME, LATE_GRACE_MINUTES, HALF_DAY_MINUTES } from '../utils/constants.js';
import { todayString, minutesSinceMidnight, timeToMinutes, monthRange, countWorkingDays } from '../utils/dateHelpers.js';

const SENIOR = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER, ROLES.MANAGER, ROLES.TEAM_LEAD];

// All user ids under a manager (direct + indirect reports) — SaaS team scoping
const getSubtreeIds = async (companyId, managerId) => {
  const users = await User.find({ companyId, status: 'ACTIVE' }).select('_id reportingTo');
  const children = {};
  users.forEach((u) => {
    const parent = String(u.reportingTo || '');
    (children[parent] ||= []).push(String(u._id));
  });
  const result = [];
  const queue = [String(managerId)];
  while (queue.length) {
    const cur = queue.pop();
    (children[cur] || []).forEach((id) => {
      result.push(id);
      queue.push(id);
    });
  }
  return result;
};

// Which users may this requester SEE? Admin/HR → whole company, Manager/TL → subtree
const resolveScopeIds = async (req) => {
  if ([ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER].includes(req.user.role)) {
    const all = await User.find({ companyId: req.companyId, status: 'ACTIVE' }).select('_id');
    return all.map((u) => u._id);
  }
  return getSubtreeIds(req.companyId, req.user._id);
};

const assertCompanyUser = (req) => {
  if (!req.companyId) throw ApiError.forbidden('Only company users can use attendance');
};

/* ---------------- POST /api/attendance/punch-in ---------------- */
export const punchIn = asyncHandler(async (req, res) => {
  assertCompanyUser(req);
  const date = todayString();

  const existing = await Attendance.findOne({ user: req.user._id, date });
  if (existing) throw ApiError.conflict('You have already punched in today');

  const lateAfter = timeToMinutes(WORK_START_TIME) + LATE_GRACE_MINUTES;
  const status = minutesSinceMidnight() > lateAfter ? 'LATE' : 'PRESENT';

  const record = await Attendance.create({
    companyId: req.companyId,
    user: req.user._id,
    date,
    punchIn: new Date(),
    status,
  });

  ApiResponse.created(res, {
    message: status === 'LATE' ? 'Punched in (marked Late)' : 'Punched in. Have a great day! 💪',
    data: record,
  });
});

/* ---------------- POST /api/attendance/punch-out ---------------- */
export const punchOut = asyncHandler(async (req, res) => {
  assertCompanyUser(req);
  const record = await Attendance.findOne({ user: req.user._id, date: todayString() });

  if (!record) throw ApiError.badRequest('You have not punched in today');
  if (record.punchOut) throw ApiError.conflict('You have already punched out today');

  record.punchOut = new Date();
  record.workMinutes = Math.max(0, Math.round((record.punchOut - record.punchIn) / 60000));
  if (record.workMinutes < HALF_DAY_MINUTES) record.status = 'HALF_DAY';
  await record.save();

  ApiResponse.success(res, {
    message: `Punched out. Total: ${(record.workMinutes / 60).toFixed(1)} hours 👏`,
    data: record,
  });
});

/* ---------------- GET /api/attendance/today ---------------- */
export const getMyToday = asyncHandler(async (req, res) => {
  assertCompanyUser(req);
  const record = await Attendance.findOne({ user: req.user._id, date: todayString() });
  ApiResponse.success(res, { message: "Today's attendance", data: record });
});

/* --------- GET /api/attendance/my?month=2026-08 (self) --------- */
export const getMyAttendance = asyncHandler(async (req, res) => {
  assertCompanyUser(req);
  const month = req.query.month || todayString().slice(0, 7);
  const { start, end } = monthRange(month);

  const records = await Attendance.find({
    user: req.user._id,
    date: { $gte: start, $lte: end },
  }).sort('date');

  const present = records.length;
  const late = records.filter((r) => r.status === 'LATE').length;
  const halfDay = records.filter((r) => r.status === 'HALF_DAY').length;
  const totalMinutes = records.reduce((s, r) => s + (r.workMinutes || 0), 0);

  const until = month === todayString().slice(0, 7) ? todayString() : end;
  const workingDays = countWorkingDays(start, until);
  const absent = Math.max(0, workingDays - present);

  ApiResponse.success(res, {
    message: 'My attendance',
    data: {
      records,
      summary: { present, late, halfDay, absent, workingDays, totalHours: (totalMinutes / 60).toFixed(1) },
    },
  });
});

/* ---- GET /api/attendance/company?date=... (Admin/HR/Manager/TL) ---- */
export const getCompanyAttendance = asyncHandler(async (req, res) => {
  const date = req.query.date || todayString();
  const ids = await resolveScopeIds(req);

  const [users, records] = await Promise.all([
    User.find({ _id: { $in: ids }, companyId: req.companyId, status: 'ACTIVE' })
      .select('name email role designation department')
      .populate('department', 'name')
      .sort('name'),
    Attendance.find({ companyId: req.companyId, date, user: { $in: ids } }),
  ]);

  const byUser = {};
  records.forEach((r) => { byUser[String(r.user)] = r; });

  const rows = users.map((u) => ({ user: u, record: byUser[String(u._id)] || null }));
  const counts = {
    total: users.length,
    punchedIn: rows.filter((r) => r.record && !r.record.punchOut).length,
    punchedOut: rows.filter((r) => r.record?.punchOut).length,
    late: rows.filter((r) => r.record?.status === 'LATE').length,
    absent: rows.filter((r) => !r.record).length,
  };

  ApiResponse.success(res, { message: 'Company attendance', data: { date, rows, counts } });
});

/* -- GET /api/attendance/report?month=&department= (HR report) -- */
export const getMonthlyReport = asyncHandler(async (req, res) => {
  const month = req.query.month || todayString().slice(0, 7);
  const { start, end } = monthRange(month);
  const ids = await resolveScopeIds(req);

  const userFilter = { _id: { $in: ids }, companyId: req.companyId, status: 'ACTIVE' };
  if (req.query.department) userFilter.department = req.query.department;

  const users = await User.find(userFilter)
    .select('name email role designation department')
    .populate('department', 'name')
    .sort('name');

  const scopeIds = users.map((u) => u._id);

  const grouped = await Attendance.aggregate([
    { $match: { companyId: req.companyId, user: { $in: scopeIds }, date: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: '$user',
        present: { $sum: 1 },
        late: { $sum: { $cond: [{ $eq: ['$status', 'LATE'] }, 1, 0] } },
        halfDay: { $sum: { $cond: [{ $eq: ['$status', 'HALF_DAY'] }, 1, 0] } },
        totalMinutes: { $sum: '$workMinutes' },
      },
    },
  ]);
  const statMap = {};
  grouped.forEach((g) => { statMap[String(g._id)] = g; });

  const until = month === todayString().slice(0, 7) ? todayString() : end;
  const workingDays = countWorkingDays(start, until);

  const rows = users.map((u) => {
    const g = statMap[String(u._id)] || { present: 0, late: 0, halfDay: 0, totalMinutes: 0 };
    const absent = Math.max(0, workingDays - g.present);
    const attendancePct = workingDays ? Math.round((g.present / workingDays) * 100) : 0;
    return {
      user: u,
      present: g.present,
      late: g.late,
      halfDay: g.halfDay,
      absent,
      totalMinutes: g.totalMinutes,
      attendancePct,
    };
  });

  ApiResponse.success(res, { message: 'Monthly attendance report', data: { month, workingDays, rows } });
});