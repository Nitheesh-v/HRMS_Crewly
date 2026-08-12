// ============================================================
// 📊 DASHBOARD CONTROLLER (v4 — speaks the REAL models' language)
// GET /api/dashboard/employee  → self widgets (Phase 9)
// GET /api/dashboard/manager   → team/dept widgets (Phase 10)
// Real schema facts: Attendance.punchIn/punchOut · no ABSENT
// records (absent = no record) · Leave.days · LEAVE_TYPES quotas
// ============================================================
import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import Task from '../models/Task.js';
import User from '../models/User.js';
import Meeting from '../models/Meeting.js';
import Announcement from '../models/Announcement.js';
import Payroll from '../models/Payroll.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { LEAVE_TYPES } from '../utils/constants.js';
import { todayString, countWorkingDays } from '../utils/dateHelpers.js';
import { getScopedUserIds } from '../utils/scope.js';

const quotaFor = (type) => LEAVE_TYPES[String(type || '').toUpperCase()]?.yearly ?? 12;

const fmtTime = (d) =>
  d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';

// ── 🙋 EMPLOYEE overview ────────────────────────────────────────────────────
const employeeOverview = asyncHandler(async (req, res) => {
  const me = req.user._id;
  const companyId = req.companyId;

  const todayStr = todayString();              // '2026-08-10'
  const monthKey = todayStr.slice(0, 7);       // '2026-08'
  const monthStart = `${monthKey}-01`;
  const yearStart = `${todayStr.slice(0, 4)}-01-01`;

  // Attendance — one record = one attended day (LATE/HALF_DAY still attended);
  // absent = working days elapsed with NO record (matches getMonthlyReport logic)
  const [monthRecords, todayRecord] = await Promise.all([
    Attendance.find({ user: me, date: { $regex: `^${monthKey}` } }).lean(),
    Attendance.findOne({ user: me, date: todayStr }).lean(),
  ]);
  const marked = monthRecords.length;
  const late = monthRecords.filter((r) => r.status === 'LATE').length;
  const halfDay = monthRecords.filter((r) => r.status === 'HALF_DAY').length;
  const workingDaysElapsed = countWorkingDays(monthStart, todayStr);
  const absent = Math.max(0, workingDaysElapsed - marked);

  // Leave balance — APPROVED days this year vs LEAVE_TYPES[type].yearly
  const approvedLeaves = await Leave.find({
    user: me,
    status: 'APPROVED',
    startDate: { $gte: yearStart },
  }).lean();
  const usedByType = {};
  approvedLeaves.forEach((l) => {
    const t = String(l.type || '').toUpperCase();
    usedByType[t] = (usedByType[t] || 0) + (l.days || 0);
  });
  const leaveBalance = Object.keys(LEAVE_TYPES)
    .filter((t) => (LEAVE_TYPES[t].yearly || 0) > 0)
    .map((type) => {
      const total = quotaFor(type);
      const used = usedByType[type] || 0;
      return { type, total, used, remaining: Math.max(0, total - used) };
    });

  const pendingTasks = await Task.find({
    assignedTo: me,
    status: { $nin: ['DONE', 'COMPLETED'] },
  })
    .select('title status priority dueDate')
    .sort({ dueDate: 1, createdAt: -1 })
    .limit(6)
    .lean();

  const upcomingMeetings = await Meeting.find({
    companyId,
    date: { $gte: todayStr },
    $or: [{ attendees: me }, { createdBy: me }],
  })
    .select('title date startTime endTime meetingLink')
    .sort({ date: 1, startTime: 1 })
    .limit(5)
    .lean();

  const latestPayslip = await Payroll.findOne({ user: me })
    .select('month netPay status')
    .sort({ month: -1 })
    .lean();

  const announcements = await Announcement.find({ companyId })
    .populate('postedBy', 'name role')
    .sort({ pinned: -1, createdAt: -1 })
    .limit(4)
    .lean();

  ApiResponse.success(res, {
    message: 'My dashboard',
    data: {
      month: monthKey,
      attendance: {
        present: marked - late, // frontend adds late back for "days attended"
        late,
        halfDay,
        absent,
        marked,
      },
      today: todayRecord
        ? { status: todayRecord.status, checkIn: fmtTime(todayRecord.punchIn) }
        : null,
      leaveBalance,
      pendingTasks: { count: pendingTasks.length, items: pendingTasks },
      upcomingMeetings,
      latestPayslip: latestPayslip || null,
      announcements,
    },
  });
});

// ── 👥 MANAGER / TEAM-LEAD overview (Phase 10) ──────────────────────────────
const managerOverview = asyncHandler(async (req, res) => {
  const companyId = req.companyId;
  const todayStr = todayString();

  const ids = await getScopedUserIds(req); // null → whole company (Admin/HR)
  const baseUserFilter = ids ? { _id: { $in: ids } } : {};

  const members = await User.find({ companyId, status: 'ACTIVE', ...baseUserFilter })
    .select('name role designation department avatarUrl employeeCode')
    .populate('department', 'name')
    .sort('name')
    .lean();

  const memberIds = members.map((m) => m._id);
  const inScope = { $in: memberIds };

  const [todayAttendance, pendingLeaves, openTasks] = await Promise.all([
    Attendance.find({ date: todayStr, user: inScope }).select('user status').lean(),
    Leave.find({ companyId, status: 'PENDING', user: inScope })
      .select('user type days startDate endDate')
      .lean(),
    Task.find({ assignedTo: inScope, status: { $nin: ['DONE', 'COMPLETED'] } })
      .select('status dueDate')
      .lean(),
  ]);

  // Absent today = scoped member with NO attendance record (their semantics)
  const presentSet = new Set(todayAttendance.map((a) => String(a.user)));
  const statusOf = Object.fromEntries(todayAttendance.map((a) => [String(a.user), a.status]));

  const now = new Date();
  const overdue = openTasks.filter((t) => t.dueDate && new Date(t.dueDate) < now).length;

  ApiResponse.success(res, {
    message: 'Team dashboard',
    data: {
      scopeLabel: ids
        ? req.user.role === 'MANAGER' ? 'Your department' : 'Your team'
        : 'Whole company',
      memberCount: members.length,
      today: {
        present: presentSet.size,
        absent: members.length - presentSet.size, // no punch → absent (matches attendance logic)
        unmarked: 0,
      },
      pendingLeaves: pendingLeaves.length,
      tasks: { open: openTasks.length, overdue },
      members: members.map((m) => ({
        _id: m._id,
        name: m.name,
        role: m.role,
        designation: m.designation || '',
        department: m.department?.name || '',
        employeeCode: m.employeeCode || '',
        avatarUrl: m.avatarUrl || '',
        today: statusOf[String(m._id)] || null,
      })),
    },
  });
});

export { employeeOverview, managerOverview };