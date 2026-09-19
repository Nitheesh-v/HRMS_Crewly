// ============================================================
// insightsAnalyticsController.js — Analytics Hub backend.
//
// Serves the Insights → Analytics page (one endpoint per tab) and the
// SUPER_ADMIN platform tab. Every handler is read-only, tenant-scoped
// via req.companyId, and degrades per-metric (core.safe): one failing
// aggregation renders as "—", never a broken page.
//
// Scope contract (mirrors reportBuilderController.js):
//   COMPANY_ADMIN / HR_MANAGER → whole company
//   MANAGER / TEAM_LEAD        → self + org subtree
//   payroll + recruitment tabs → HR roles only (frontend hides them
//                                from team roles; enforced here too)
//   /my                        → any member, self data only
//   /saas/overview             → SUPER_ADMIN only, platform-wide
// ============================================================
import mongoose from 'mongoose';
import logger from '../config/logger.js';
import { sanitizeText as safeErrorText } from '../infrastructure/observability/redaction.js';
import * as core from '../utils/reportingCore.js';
import { getSubtreeIds } from '../utils/orgHelpers.js';

const ok = (res, status, data, message) =>
  res.status(status).json({
    statusCode: status,
    success: true,
    data,
    message,
  });

const fail = (res, status, message) =>
  res.status(status).json({
    statusCode: status,
    success: false,
    message,
  });

const objectId = (value) => {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) return value;
  return new mongoose.Types.ObjectId(value);
};

const isHR = (role) => role === 'COMPANY_ADMIN' || role === 'HR_MANAGER';
const isTeamRole = (role) => role === 'MANAGER' || role === 'TEAM_LEAD';

// Data from frontend: JWT user + req.companyId (tenant middleware).
// Returns null for HR (whole company) or ObjectIds [self + subtree]
// for team roles. Rejects anything else.
const scopeIdsFor = async (req) => {
  if (isHR(req.user.role)) return null;
  if (!isTeamRole(req.user.role)) return false;
  const companyId = req.companyId || req.user.companyId;
  const subtree = await core.safe(
    () => getSubtreeIds(companyId, req.user._id),
    []
  );
  return [objectId(req.user._id), ...(subtree || []).map(objectId)];
};

const scopedUserMatch = (scopeIds) =>
  scopeIds ? { _id: { $in: scopeIds } } : {};
const scopedRefMatch = (field, scopeIds) =>
  scopeIds ? { [field]: { $in: scopeIds } } : {};

const MONTH_KEY = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
const MONTH_LABEL = (date) =>
  `${date.toLocaleString('en', { month: 'short' })} ${String(
    date.getFullYear()
  ).slice(2)}`;

// Last `count` calendar months, oldest first: [{ key, label, start, end }].
const lastMonths = (count) => {
  const now = new Date();
  const months = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const start = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - back + 1, 1);
    months.push({ key: MONTH_KEY(start), label: MONTH_LABEL(start), start, end });
  }
  return months;
};

// 'YYYY-MM' keys overlapping [from, to] (for payslip/payroll month match).
const monthsInRange = (from, to) => {
  const keys = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
  const last = new Date(to.getFullYear(), to.getMonth(), 1);
  while (cursor <= last && keys.length < 36) {
    keys.push(MONTH_KEY(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return keys;
};

// Working days in [fromKey, toKey] ('YYYY-MM-DD'), Sundays excluded.
// Documented simplification: the company weekend policy is not consulted;
// Sundays-only keeps the estimate stable and explainable.
const workingDaysBetween = (fromKey, toKey) => {
  let count = 0;
  const cursor = new Date(`${fromKey}T00:00:00Z`);
  const end = new Date(`${toKey}T00:00:00Z`);
  while (cursor <= end && count < 370) {
    if (cursor.getUTCDay() !== 0) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
};

// ============================================================
// GET /api/analytics/overview?preset=…
// ============================================================
export const analyticsOverview = async (req, res) => {
  // Data from frontend: ?preset=… (validated). Tenant from req.companyId.
  try {
    const companyId = req.companyId || req.user.companyId;
    if (!companyId) return fail(res, 400, 'Company context required');
    const scopeIds = await scopeIdsFor(req);
    if (scopeIds === false) return fail(res, 403, 'Forbidden');

    const { from, to } = core.rangeFromQuery(req.query || {});
    const User = await core.getModel('User');

    // DB Logic: each metric is independent; core.safe keeps one
    // failure from breaking the whole tab.
    const users = await core.safe(
      () =>
        User.find({ companyId: objectId(companyId), ...scopedUserMatch(scopeIds) })
          .select('_id status createdAt dateOfJoining department designation reportingTo')
          .lean(),
      []
    );
    const userIds = users.map((user) => user._id);
    const inScope = (id) =>
      !scopeIds || scopeIds.some((scopeId) => String(scopeId) === String(id));

    const headcount = users.length;
    const active = users.filter((user) => user.status === 'ACTIVE').length;
    const joinedAt = (user) => new Date(user.dateOfJoining || user.createdAt || 0);
    const newHires = users.filter(
      (user) => joinedAt(user) >= from && joinedAt(user) <= to
    ).length;

    const Resignation = await core.getModel('Resignation');
    const exits = await core.safe(
      () =>
        Resignation.countDocuments({
          companyId: objectId(companyId),
          status: 'APPROVED',
          lastWorkingDate: { $gte: from, $lte: to },
          ...(scopeIds ? { user: { $in: scopeIds } } : {}),
        }),
      0
    );

    const startHeadcount = Math.max(0, headcount - newHires + exits);
    const growth = startHeadcount
      ? Math.round(((headcount - startHeadcount) / startHeadcount) * 1000) / 10
      : 0;
    const avgHeadcount = Math.max(1, headcount - (newHires - exits) / 2);
    const attritionRate = Math.round((exits / avgHeadcount) * 1000) / 10;

    const Leave = await core.getModel('Leave');
    const pendingLeaves = await core.safe(
      () =>
        Leave.countDocuments({
          companyId: objectId(companyId),
          status: 'PENDING',
          ...scopedRefMatch('user', scopeIds),
        }),
      0
    );

    const JobPosting = await core.getModel('JobPosting');
    const openJobs = await core.safe(
      () =>
        JobPosting.countDocuments({
          companyId: objectId(companyId),
          status: 'OPEN',
        }),
      0
    );

    const Project = await core.getModel('Project');
    const activeProjects = await core.safe(
      () =>
        Project.countDocuments({
          company: objectId(companyId),
          status: { $in: ['NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD'] },
          ...(scopeIds
            ? {
                $or: [
                  { manager: { $in: scopeIds } },
                  { members: { $in: scopeIds } },
                ],
              }
            : {}),
        }),
      0
    );

    const Department = await core.getModel('Department');
    const departmentDocs = await core.safe(
      () => Department.find({ companyId: objectId(companyId) }).select('_id name').lean(),
      []
    );
    const departmentNameOf = Object.fromEntries(
      departmentDocs.map((dept) => [String(dept._id), dept.name])
    );

    // 12-month headcount trend: cumulative (joins − exits) at each month end.
    const trendMonths = lastMonths(12);
    const approvedExits = await core.safe(
      () =>
        Resignation.find({
          companyId: objectId(companyId),
          status: 'APPROVED',
          ...(scopeIds ? { user: { $in: scopeIds } } : {}),
        })
          .select('lastWorkingDate')
          .lean(),
      []
    );
    const headcountTrend = trendMonths.map((month) => {
      const joins = users.filter((user) => joinedAt(user) < month.end).length;
      const left = approvedExits.filter(
        (exit) => new Date(exit.lastWorkingDate || 0) < month.end
      ).length;
      return { label: month.label, headcount: Math.max(0, joins - left) };
    });

    const byDepartmentMap = {};
    users.forEach((user) => {
      const name = user.department
        ? departmentNameOf[String(user.department)] || 'Unassigned'
        : 'Unassigned';
      byDepartmentMap[name] = (byDepartmentMap[name] || 0) + 1;
    });
    const byDepartment = Object.entries(byDepartmentMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const byDesignationMap = {};
    users.forEach((user) => {
      const name = (user.designation || '').trim() || 'Unspecified';
      byDesignationMap[name] = (byDesignationMap[name] || 0) + 1;
    });
    const byDesignation = Object.entries(byDesignationMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);

    void userIds;
    void inScope;

    // Data to frontend: the exact shape AnalyticsHubPage requires.
    return ok(
      res,
      200,
      {
        kpis: {
          headcount,
          growth,
          active,
          inactive: headcount - active,
          newHires,
          exits,
          attritionRate,
          pendingLeaves,
          openJobs,
          activeProjects,
          departments: departmentDocs.length,
        },
        headcountTrend,
        byDepartment,
        byDesignation,
      },
      'Analytics overview'
    );
  } catch (error) {
    logger.error(`[analytics/overview] ${safeErrorText(error?.message || error)}`);
    return fail(res, 500, 'Could not load analytics overview');
  }
};

// ============================================================
// GET /api/analytics/attendance?preset=…
// ============================================================
export const analyticsAttendance = async (req, res) => {
  // Data from frontend: ?preset=… (validated). Tenant from req.companyId.
  try {
    const companyId = req.companyId || req.user.companyId;
    if (!companyId) return fail(res, 400, 'Company context required');
    const scopeIds = await scopeIdsFor(req);
    if (scopeIds === false) return fail(res, 403, 'Forbidden');

    const { from, to } = core.rangeFromQuery(req.query || {});
    const fromKey = core.dstr(from);
    const toKey = core.dstr(to);

    // DB Logic.
    const Attendance = await core.getModel('Attendance');
    const match = {
      companyId: objectId(companyId),
      date: { $gte: fromKey, $lte: toKey },
      ...scopedRefMatch('user', scopeIds),
    };
    const byStatusRaw = await core.safe(
      () =>
        Attendance.aggregate([
          { $match: match },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
      []
    );
    const countOf = (status) =>
      byStatusRaw.find((row) => row._id === status)?.count || 0;
    const present = countOf('PRESENT');
    const late = countOf('LATE');
    const halfDay = countOf('HALF_DAY');

    const Leave = await core.getModel('Leave');
    const leaveRows = await core.safe(
      () =>
        Leave.find({
          companyId: objectId(companyId),
          status: 'APPROVED',
          startDate: { $lte: toKey },
          endDate: { $gte: fromKey },
          ...scopedRefMatch('user', scopeIds),
        })
          .select('days')
          .lean(),
      []
    );
    const leave = leaveRows.reduce((sum, row) => sum + (Number(row.days) || 0), 0);

    const User = await core.getModel('User');
    const scopedActive = await core.safe(
      () =>
        User.countDocuments({
          companyId: objectId(companyId),
          status: 'ACTIVE',
          ...scopedUserMatch(scopeIds),
        }),
      0
    );

    // Attendance has no ABSENT rows: absence = expected marks − actual
    // marks, where expected = working days × scoped active headcount.
    const workingDays = workingDaysBetween(fromKey, toKey);
    const marked = present + late + halfDay * 0.5;
    const absent = Math.max(0, Math.round((workingDays * scopedActive - marked) * 100) / 100);
    const attendancePct =
      marked + absent > 0 ? Math.round((marked / (marked + absent)) * 1000) / 10 : 0;

    const dailyTrend = await core.safe(
      () =>
        Attendance.aggregate([
          { $match: match },
          { $group: { _id: '$date', present: { $sum: 1 } } },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, d: '$_id', present: 1 } },
        ]),
      []
    );

    // Data to frontend.
    return ok(
      res,
      200,
      {
        counts: { present, absent, late, halfDay, leave, attendancePct },
        dailyTrend,
        byStatusRaw,
      },
      'Analytics attendance'
    );
  } catch (error) {
    logger.error(`[analytics/attendance] ${safeErrorText(error?.message || error)}`);
    return fail(res, 500, 'Could not load attendance analytics');
  }
};

// ============================================================
// GET /api/analytics/leaves?preset=…
// ============================================================
export const analyticsLeaves = async (req, res) => {
  // Data from frontend: ?preset=… (validated). Tenant from req.companyId.
  try {
    const companyId = req.companyId || req.user.companyId;
    if (!companyId) return fail(res, 400, 'Company context required');
    const scopeIds = await scopeIdsFor(req);
    if (scopeIds === false) return fail(res, 403, 'Forbidden');

    const { from, to } = core.rangeFromQuery(req.query || {});
    const fromKey = core.dstr(from);
    const toKey = core.dstr(to);

    // DB Logic: request counts use createdAt (when asked); day usage
    // uses the approved leave window overlapping the range.
    const Leave = await core.getModel('Leave');
    const base = {
      companyId: objectId(companyId),
      createdAt: { $gte: from, $lte: to },
      ...scopedRefMatch('user', scopeIds),
    };
    const [total, approved, pending, rejected] = await Promise.all([
      core.safe(() => Leave.countDocuments(base), 0),
      core.safe(() => Leave.countDocuments({ ...base, status: 'APPROVED' }), 0),
      core.safe(() => Leave.countDocuments({ ...base, status: 'PENDING' }), 0),
      core.safe(() => Leave.countDocuments({ ...base, status: 'REJECTED' }), 0),
    ]);

    const byType = await core.safe(
      () =>
        Leave.aggregate([
          {
            $match: {
              companyId: objectId(companyId),
              status: 'APPROVED',
              startDate: { $lte: toKey },
              endDate: { $gte: fromKey },
              ...scopedRefMatch('user', scopeIds),
            },
          },
          { $group: { _id: '$type', days: { $sum: '$days' } } },
          { $project: { _id: 0, type: '$_id', days: 1 } },
          { $sort: { days: -1 } },
        ]),
      []
    );

    const monthlyTrend = await Promise.all(
      lastMonths(6).map(async (month) => ({
        label: month.label,
        count: await core.safe(
          () =>
            Leave.countDocuments({
              companyId: objectId(companyId),
              createdAt: { $gte: month.start, $lt: month.end },
              ...scopedRefMatch('user', scopeIds),
            }),
          0
        ),
      }))
    );

    const topUsers = await core.safe(
      () =>
        Leave.aggregate([
          {
            $match: {
              companyId: objectId(companyId),
              status: 'APPROVED',
              startDate: { $lte: toKey },
              endDate: { $gte: fromKey },
              ...scopedRefMatch('user', scopeIds),
            },
          },
          { $group: { _id: '$user', days: { $sum: '$days' } } },
          { $sort: { days: -1 } },
          { $limit: 5 },
          {
            $lookup: {
              from: 'users',
              localField: '_id',
              foreignField: '_id',
              as: 'u',
            },
          },
          {
            $project: {
              _id: 0,
              name: { $ifNull: [{ $arrayElemAt: ['$u.name', 0] }, 'Unknown employee'] },
              days: 1,
            },
          },
        ]),
      []
    );

    // Data to frontend.
    return ok(
      res,
      200,
      { counts: { total, approved, pending, rejected }, byType, monthlyTrend, topUsers },
      'Analytics leaves'
    );
  } catch (error) {
    logger.error(`[analytics/leaves] ${safeErrorText(error?.message || error)}`);
    return fail(res, 500, 'Could not load leave analytics');
  }
};

// ============================================================
// GET /api/analytics/payroll?preset=… (HR roles only)
// ============================================================
export const analyticsPayroll = async (req, res) => {
  // Data from frontend: ?preset=… (validated). Tenant from req.companyId.
  try {
    const companyId = req.companyId || req.user.companyId;
    if (!companyId) return fail(res, 400, 'Company context required');
    if (!isHR(req.user.role)) return fail(res, 403, 'Forbidden');

    const { from, to } = core.rangeFromQuery(req.query || {});
    const months = monthsInRange(from, to);

    // DB Logic: primary source is the real engine output (Payslip
    // snapshots); the legacy Payroll model is the fallback when no
    // payslips exist yet. Never mixes the two for one company.
    const Payslip = await core.getModel('Payslip');
    const slipRows = await core.safe(
      () =>
        Payslip.find({ companyId: objectId(companyId), month: { $in: months } })
          .select('month employeeId salary.totalEarnings salary.totalDeductions salary.netSalary')
          .lean(),
      []
    );

    let source = 'payslip';
    let rows = slipRows.map((row) => ({
      month: row.month,
      userId: row.employeeId,
      gross: Number(row.salary?.totalEarnings) || 0,
      deductions: Number(row.salary?.totalDeductions) || 0,
      net: Number(row.salary?.netSalary) || 0,
    }));

    if (!rows.length) {
      const Payroll = await core.getModel('Payroll');
      const legacyRows = await core.safe(
        () =>
          Payroll.find({ companyId: objectId(companyId), month: { $in: months } })
            .select('month user earnings.gross deductions.total netPay')
            .lean(),
        []
      );
      if (legacyRows.length) {
        source = 'payroll';
        rows = legacyRows.map((row) => ({
          month: row.month,
          userId: row.user,
          gross: Number(row.earnings?.gross) || 0,
          deductions: Number(row.deductions?.total) || 0,
          net: Number(row.netPay) || 0,
        }));
      }
    }

    const totals = {
      net: rows.reduce((sum, row) => sum + row.net, 0),
      gross: rows.reduce((sum, row) => sum + row.gross, 0),
      deductions: rows.reduce((sum, row) => sum + row.deductions, 0),
      slips: rows.length,
    };

    const PayrollModel = source === 'payroll' ? await core.getModel('Payroll') : null;
    const monthly = await Promise.all(
      lastMonths(6).map(async (month) => {
        let net = 0;
        if (source === 'payslip') {
          const monthRows = await core.safe(
            () =>
              Payslip.find({ companyId: objectId(companyId), month: month.key })
                .select('salary.netSalary')
                .lean(),
            []
          );
          net = monthRows.reduce((sum, row) => sum + (Number(row.salary?.netSalary) || 0), 0);
        } else if (PayrollModel) {
          const monthRows = await core.safe(
            () =>
              PayrollModel.find({ companyId: objectId(companyId), month: month.key })
                .select('netPay')
                .lean(),
            []
          );
          net = monthRows.reduce((sum, row) => sum + (Number(row.netPay) || 0), 0);
        }
        return { label: month.label, net };
      })
    );

    const User = await core.getModel('User');
    const Department = await core.getModel('Department');
    const [deptDocs, userDocs] = await Promise.all([
      core.safe(() => Department.find({ companyId: objectId(companyId) }).select('_id name').lean(), []),
      rows.length
        ? core.safe(
            () =>
              User.find({
                companyId: objectId(companyId),
                _id: { $in: rows.map((row) => objectId(row.userId)).filter(Boolean) },
              })
                .select('_id department')
                .lean(),
            []
          )
        : [],
    ]);
    const deptNameOf = Object.fromEntries(deptDocs.map((dept) => [String(dept._id), dept.name]));
    const userDeptOf = Object.fromEntries(userDocs.map((user) => [String(user._id), user.department]));
    const byDeptMap = {};
    rows.forEach((row) => {
      const deptId = userDeptOf[String(row.userId)];
      const name = (deptId && deptNameOf[String(deptId)]) || 'Unassigned';
      byDeptMap[name] = (byDeptMap[name] || 0) + row.net;
    });
    const byDepartment = Object.entries(byDeptMap)
      .map(([name, net]) => ({ name, net }))
      .sort((a, b) => b.net - a.net);

    // Data to frontend.
    return ok(res, 200, { totals, monthly, byDepartment }, 'Analytics payroll');
  } catch (error) {
    logger.error(`[analytics/payroll] ${safeErrorText(error?.message || error)}`);
    return fail(res, 500, 'Could not load payroll analytics');
  }
};

// ============================================================
// GET /api/analytics/work?preset=…
// ============================================================
export const analyticsWork = async (req, res) => {
  // Data from frontend: ?preset=… (validated). Tenant from req.companyId.
  try {
    const companyId = req.companyId || req.user.companyId;
    if (!companyId) return fail(res, 400, 'Company context required');
    const scopeIds = await scopeIdsFor(req);
    if (scopeIds === false) return fail(res, 403, 'Forbidden');

    const { from, to } = core.rangeFromQuery(req.query || {});
    const now = new Date();

    // DB Logic.
    const Task = await core.getModel('Task');
    const taskBase = {
      company: objectId(companyId),
      ...scopedRefMatch('assignedTo', scopeIds),
    };
    const [done, total, overdue, byStatusRaw] = await Promise.all([
      core.safe(() => Task.countDocuments({ ...taskBase, status: 'COMPLETED' }), 0),
      core.safe(() => Task.countDocuments(taskBase), 0),
      core.safe(
        () =>
          Task.countDocuments({
            ...taskBase,
            status: { $ne: 'COMPLETED' },
            dueDate: { $ne: null, $lt: now },
          }),
        0
      ),
      core.safe(
        () =>
          Task.aggregate([
            { $match: taskBase },
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ]),
        []
      ),
    ]);

    const byUser = await core.safe(
      () =>
        Task.aggregate([
          { $match: taskBase },
          { $group: { _id: '$assignedTo', total: { $sum: 1 } } },
          { $sort: { total: -1 } },
          { $limit: 8 },
          {
            $lookup: {
              from: 'users',
              localField: '_id',
              foreignField: '_id',
              as: 'u',
            },
          },
          {
            $project: {
              _id: 0,
              name: { $ifNull: [{ $arrayElemAt: ['$u.name', 0] }, 'Unknown'] },
              total: 1,
            },
          },
        ]),
      []
    );

    const Project = await core.getModel('Project');
    const projectBase = {
      company: objectId(companyId),
      ...(scopeIds
        ? {
            $or: [
              { manager: { $in: scopeIds } },
              { members: { $in: scopeIds } },
            ],
          }
        : {}),
    };
    const [projectTotal, projectActive, projectDelayed] = await Promise.all([
      core.safe(() => Project.countDocuments(projectBase), 0),
      core.safe(
        () =>
          Project.countDocuments({
            ...projectBase,
            status: { $in: ['NOT_STARTED', 'IN_PROGRESS'] },
          }),
        0
      ),
      core.safe(
        () =>
          Project.countDocuments({
            ...projectBase,
            status: { $nin: ['COMPLETED', 'CANCELLED'] },
            endDate: { $ne: null, $lt: now },
          }),
        0
      ),
    ]);

    const Expense = await core.getModel('Expense');
    const approvedExpenses = await core.safe(
      () =>
        Expense.aggregate([
          {
            $match: {
              companyId: objectId(companyId),
              status: { $in: ['APPROVED', 'REIMBURSED'] },
              createdAt: { $gte: from, $lte: to },
              ...scopedRefMatch('user', scopeIds),
            },
          },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
      []
    );

    const Appraisal = await core.getModel('Appraisal');
    const rated = await core.safe(
      () =>
        Appraisal.aggregate([
          {
            $match: {
              companyId: objectId(companyId),
              rating: { $ne: null },
              ...scopedRefMatch('user', scopeIds),
            },
          },
          { $group: { _id: null, avg: { $avg: '$rating' } } },
        ]),
      []
    );

    // Data to frontend (goalCompletion: no goals model exists — honest 0).
    return ok(
      res,
      200,
      {
        tasks: {
          done,
          total,
          completionPct: total ? Math.round((done / total) * 1000) / 10 : 0,
          overdue,
          byUser,
          byStatusRaw,
        },
        projects: { active: projectActive, total: projectTotal, delayed: projectDelayed },
        expenses: { approvedTotal: approvedExpenses[0]?.total || 0 },
        performance: {
          avgRating: rated[0]?.avg != null ? Math.round(rated[0].avg * 10) / 10 : null,
          goalCompletion: 0,
        },
      },
      'Analytics work'
    );
  } catch (error) {
    logger.error(`[analytics/work] ${safeErrorText(error?.message || error)}`);
    return fail(res, 500, 'Could not load work analytics');
  }
};

// ============================================================
// GET /api/analytics/recruitment?preset=… (HR roles only)
// ============================================================
const SCREENING_STAGES = ['ATS_SCREENING', 'HR_SCREENING', 'SCREENING'];
const INTERVIEW_STAGES = ['INTERVIEW_1', 'INTERVIEW_2', 'INTERVIEW_3', 'MANAGER_ROUND', 'HR_FINAL', 'INTERVIEW'];
const OFFER_STAGES = ['OFFER', 'OFFER_ACCEPTED', 'PRE_ONBOARDING', 'JOINED'];
const HIRED_STAGES = ['JOINED'];
const ACCEPTED_STAGES = ['OFFER_ACCEPTED', 'PRE_ONBOARDING', 'JOINED'];

export const analyticsRecruitment = async (req, res) => {
  // Data from frontend: ?preset=… (validated). Tenant from req.companyId.
  try {
    const companyId = req.companyId || req.user.companyId;
    if (!companyId) return fail(res, 400, 'Company context required');
    if (!isHR(req.user.role)) return fail(res, 403, 'Forbidden');

    const { from, to } = core.rangeFromQuery(req.query || {});

    // DB Logic: job totals are cumulative; the candidate funnel only
    // counts candidates created inside the selected range.
    const JobPosting = await core.getModel('JobPosting');
    const [jobTotal, jobOpen] = await Promise.all([
      core.safe(
        () => JobPosting.countDocuments({ companyId: objectId(companyId) }),
        0
      ),
      core.safe(
        () =>
          JobPosting.countDocuments({
            companyId: objectId(companyId),
            status: 'OPEN',
          }),
        0
      ),
    ]);

    const jobs = { total: jobTotal, open: jobOpen };

    let Candidate = null;
    try {
      Candidate = await core.getModel('Candidate');
    } catch (error) {
      // No candidate model: the frontend renders jobs with a
      // "No application model is available" note instead.
      return ok(res, 200, { jobs }, 'Analytics recruitment');
    }

    const funnelBase = {
      companyId: objectId(companyId),
      createdAt: { $gte: from, $lte: to },
    };
    const countStage = (stages) =>
      core.safe(
        () => Candidate.countDocuments({ ...funnelBase, stage: { $in: stages } }),
        0
      );
    const [total, screening, shortlisted, interview, offers, hires, accepted] =
      await Promise.all([
        core.safe(() => Candidate.countDocuments(funnelBase), 0),
        countStage(SCREENING_STAGES),
        countStage(['SHORTLISTED']),
        countStage(INTERVIEW_STAGES),
        countStage(OFFER_STAGES),
        countStage(HIRED_STAGES),
        countStage(ACCEPTED_STAGES),
      ]);

    const bySource = await core.safe(
      () =>
        Candidate.aggregate([
          { $match: funnelBase },
          {
            $group: {
              _id: '$source',
              applications: { $sum: 1 },
              hires: {
                $sum: { $cond: [{ $in: ['$stage', HIRED_STAGES] }, 1, 0] },
              },
            },
          },
          { $project: { _id: 0, source: { $ifNull: ['$_id', 'UNKNOWN'] }, applications: 1, hires: 1 } },
          { $sort: { applications: -1 } },
        ]),
      []
    );

    // Data to frontend.
    return ok(
      res,
      200,
      {
        jobs,
        applications: {
          total,
          screening,
          shortlisted,
          interview,
          hires,
          rates: {
            appToScreening: core.pct(screening, total),
            screeningToShortlist: core.pct(shortlisted, screening),
            interviewToOffer: core.pct(offers, interview),
            offerAcceptance: core.pct(accepted, offers),
          },
          bySource,
        },
      },
      'Analytics recruitment'
    );
  } catch (error) {
    logger.error(`[analytics/recruitment] ${safeErrorText(error?.message || error)}`);
    return fail(res, 500, 'Could not load recruitment analytics');
  }
};

// ============================================================
// GET /api/analytics/my (any member — self data only)
// ============================================================
export const analyticsMy = async (req, res) => {
  // Data from frontend: none. Identity + tenant from JWT/middleware.
  try {
    const companyId = req.companyId || req.user.companyId;
    if (!companyId) return fail(res, 400, 'Company context required');
    const me = objectId(req.user._id);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthStartKey = core.dstr(monthStart);

    // DB Logic: every query is pinned to the requester — there is no
    // code path that can return another employee's rows.
    const Attendance = await core.getModel('Attendance');
    const attendance = await core.safe(
      () =>
        Attendance.aggregate([
          {
            $match: {
              companyId: objectId(companyId),
              user: me,
              date: { $gte: monthStartKey },
            },
          },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
      []
    );

    const Task = await core.getModel('Task');
    const tasks = await core.safe(
      () =>
        Task.aggregate([
          { $match: { company: objectId(companyId), assignedTo: me } },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
      []
    );

    const Leave = await core.getModel('Leave');
    const leaves = await core.safe(
      () =>
        Leave.aggregate([
          { $match: { companyId: objectId(companyId), user: me } },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
      []
    );

    const ShiftAssignment = await core.getModel('ShiftAssignment');
    const assignment = await core.safe(
      () =>
        ShiftAssignment.findOne({
          companyId: objectId(companyId),
          user: me,
          effectiveFrom: { $lte: now },
        })
          .sort({ effectiveFrom: -1 })
          .lean(),
      null
    );
    let roster = null;
    if (assignment?.shift) {
      const Shift = await core.getModel('Shift');
      const shift = await core.safe(
        () => Shift.findById(assignment.shift).select('name startTime endTime').lean(),
        null
      );
      if (shift) {
        roster = {
          shift: { name: shift.name, startTime: shift.startTime, endTime: shift.endTime },
        };
      }
    }

    const Holiday = await core.getModel('Holiday');
    const horizon = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000);
    const upcomingHolidays = await core.safe(
      () =>
        Holiday.find({
          companyId: objectId(companyId),
          date: { $gte: now, $lte: horizon },
        })
          .select('_id name date')
          .sort({ date: 1 })
          .lean(),
      []
    );

    // Data to frontend.
    return ok(
      res,
      200,
      {
        attendance,
        tasks,
        leaves,
        ...(roster ? { roster } : {}),
        upcomingHolidays: upcomingHolidays.map((holiday) => ({
          id: String(holiday._id),
          name: holiday.name,
          date: core.dstr(holiday.date),
        })),
      },
      'My stats'
    );
  } catch (error) {
    logger.error(`[analytics/my] ${safeErrorText(error?.message || error)}`);
    return fail(res, 500, 'Could not load my stats');
  }
};

// ============================================================
// GET /api/saas/overview (SUPER_ADMIN only — platform-wide)
// ============================================================
export const saasOverview = async (req, res) => {
  // Data from frontend: none. Route guard enforces SUPER_ADMIN.
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // DB Logic: platform-wide by design — no tenant filter here.
    const Company = await core.getModel('Company');
    const Subscription = await core.getModel('Subscription');
    const User = await core.getModel('User');

    const [companyTotal, companyNew, trial, usersTotal, usersNew] = await Promise.all([
      core.safe(() => Company.countDocuments({}), 0),
      core.safe(() => Company.countDocuments({ createdAt: { $gte: monthStart } }), 0),
      core.safe(() => Subscription.countDocuments({ status: 'TRIAL' }), 0),
      core.safe(() => User.countDocuments({ role: { $ne: 'SUPER_ADMIN' } }), 0),
      core.safe(
        () =>
          User.countDocuments({
            role: { $ne: 'SUPER_ADMIN' },
            createdAt: { $gte: monthStart },
          }),
        0
      ),
    ]);

    const byPlan = await core.safe(
      () =>
        Subscription.aggregate([
          { $group: { _id: '$plan', count: { $sum: 1 } } },
          { $project: { _id: 0, name: { $ifNull: ['$_id', 'Unknown'] }, count: 1 } },
          { $sort: { count: -1 } },
        ]),
      []
    );
    const byStatus = await core.safe(
      () =>
        Subscription.aggregate([
          { $group: { _id: '$status', count: { $sum: 1 } } },
          { $project: { _id: 0, name: { $ifNull: ['$_id', 'Unknown'] }, count: 1 } },
          { $sort: { count: -1 } },
        ]),
      []
    );

    const PAYING_STATUSES = ['ACTIVE', 'EXPIRING_SOON', 'EXPIRING', 'GRACE_PERIOD'];
    const payingRows = await core.safe(
      () =>
        Subscription.find({
          status: { $in: PAYING_STATUSES },
          plan: { $nin: ['FREE', 'TRIAL'] },
        })
          .select('plan planSnapshot.prices.monthly')
          .lean(),
      []
    );
    const mrrByPlanMap = {};
    payingRows.forEach((row) => {
      const monthly = Number(row.planSnapshot?.prices?.monthly) || 0;
      mrrByPlanMap[row.plan] = (mrrByPlanMap[row.plan] || 0) + monthly;
    });
    const mrrByPlan = Object.entries(mrrByPlanMap)
      .map(([plan, mrr]) => ({ plan, mrr }))
      .sort((a, b) => b.mrr - a.mrr);
    const mrr = mrrByPlan.reduce((sum, row) => sum + row.mrr, 0);

    // Data to frontend (mrrGrowthPct: no revenue history exists —
    // honest 0 until subscription-history tracking lands).
    return ok(
      res,
      200,
      {
        companies: {
          total: companyTotal,
          newThisMonth: companyNew,
          trial,
          byPlan,
          byStatus,
        },
        users: { total: usersTotal, newThisMonth: usersNew },
        revenue: {
          payingCompanies: payingRows.length,
          mrr,
          mrrGrowthPct: 0,
          arr: mrr * 12,
          mrrByPlan,
        },
      },
      'Platform overview'
    );
  } catch (error) {
    logger.error(`[saas/overview] ${safeErrorText(error?.message || error)}`);
    return fail(res, 500, 'Could not load platform overview');
  }
};
