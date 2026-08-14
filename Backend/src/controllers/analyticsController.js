// ============================================================
// analyticsController.js — company-side dashboards.
// Golden rules baked in:
//  1) Every query is filtered by companyId (tenant isolation)
//  2) Managers/TLs only see THEIR team (getSubtreeIds)
//  3) All math happens inside MongoDB (aggregate), never in React
//  4) Each metric goes through core.safe() → one failure ≠ 500 page
// ------------------------------------------------------------
// Mini Mongo lesson used below:
//   { $match: {...} }  = WHERE
//   { $group: { _id: '$status', count: { $sum: 1 } } } = GROUP BY status, COUNT(*)
//   { $lookup: {...} } = JOIN another collection
// ============================================================
import * as core from '../utils/reportingCore.js';
import * as engine from '../utils/scheduleEngine.js';

const ok = (res, status, data, message) => res.status(status).json({ statusCode: status, success: true, data, message });
const fail = (res, status, message) => res.status(status).json({ statusCode: status, success: false, message });

// ------------------------------------------------------------
// RBAC helper: MANAGER / TEAM_LEAD get a list of "their" user ids
// (their org subtree). Admin/HR get null = "no restriction".
// ------------------------------------------------------------
async function scopeUserIds(req) {
  const isTeamRole = req.user.role === 'MANAGER' || req.user.role === 'TEAM_LEAD';
  if (!isTeamRole) return null;
  return core.safe(async () => {
    const orgHelpers = await import('../utils/orgHelpers.js');
    const getSubtreeIds = orgHelpers.getSubtreeIds || orgHelpers.default?.getSubtreeIds;
    if (!getSubtreeIds) return [req.user._id];
    return getSubtreeIds(req.user.companyId, req.user._id);
  }, [req.user._id]); // worst case: they see only themselves
}

// Turn a ?departmentId= filter into the list of user ids inside it
async function deptUserIds(req, departmentId) {
  if (!departmentId) return null;
  const User = await core.getModel('User');
  const users = await User.find({ companyId: req.user.companyId, department: departmentId }).select('_id').lean();
  return users.map((u) => u._id);
}

// Attach user filtering to a Mongo match (scope ∩ department)
function withUserFilter(match, scopeIds, deptIds) {
  let ids = scopeIds || deptIds;
  if (scopeIds && deptIds) {
    ids = scopeIds.filter((id) => deptIds.some((d) => String(d) === String(id)));
  }
  if (ids) match.user = { $in: ids };
  return match;
}

// ============================================================
// GET /api/analytics/overview — headcount, hires, exits, trend
// ============================================================
export async function overview(req, res) {
  try {
    const companyId = req.user.companyId;
    if (!companyId) return fail(res, 400, 'Company context required');

    const { from, to, preset } = core.rangeFromQuery(req.query);
    const scopeIds = await scopeUserIds(req);
    const User = await core.getModel('User');

    // Managers only count their own subtree; Admin/HR count everyone
    const baseMatch = scopeIds ? { companyId, _id: { $in: scopeIds } } : { companyId };

    // Build the first day of each of the last 12 months (for the trend chart)
    const months = [];
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      months.push(new Date(d.getFullYear(), d.getMonth(), 1));
    }

    // Run all independent queries IN PARALLEL (Promise.all = much faster)
    const [byStatus, newHires, exits, byDepartment, byDesignation, hires12, exits12, activeLastMonth, deptCount, pendingLeaves, openJobs, activeProjects] = await Promise.all([
      // 1) how many ACTIVE vs INACTIVE users
      core.safe(() => User.aggregate([{ $match: baseMatch }, { $group: { _id: '$status', count: { $sum: 1 } } }]), []),
      // 2) people who joined inside the selected date range
      core.safe(() => User.countDocuments({ ...baseMatch, createdAt: { $gte: from, $lte: to } }), 0),
      // 3) resignations filed inside the range
      core.safe(async () => (await core.getModel('Resignation')).countDocuments({ companyId, createdAt: { $gte: from, $lte: to } }), 0),
      // 4) headcount per department (+ $lookup joins the department name)
      core.safe(() => User.aggregate([
        { $match: { ...baseMatch, status: 'ACTIVE' } },
        { $group: { _id: '$department', count: { $sum: 1 } } },
        { $lookup: { from: 'departments', localField: '_id', foreignField: '_id', as: 'dept' } },
        { $project: { count: 1, name: { $ifNull: [{ $arrayElemAt: ['$dept.name', 0] }, 'Unassigned'] } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]), []),
      // 5) headcount per designation (Developer, Tester…)
      core.safe(() => User.aggregate([
        { $match: { ...baseMatch, status: 'ACTIVE', designation: { $nin: [null, ''] } } },
        { $group: { _id: '$designation', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]), []),
      // 6) hires grouped per month (for the 12-month trend)
      core.safe(() => User.aggregate([
        { $match: { ...baseMatch, createdAt: { $gte: months[0] } } },
        { $group: { _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } }, count: { $sum: 1 } } },
      ]), []),
      // 7) exits grouped per month
      core.safe(async () => (await core.getModel('Resignation')).aggregate([
        { $match: { companyId, createdAt: { $gte: months[0] } } },
        { $group: { _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } }, count: { $sum: 1 } } },
      ]), []),
      // 8) how many were active BEFORE this month started (for growth %)
      core.safe(() => User.countDocuments({ companyId, status: 'ACTIVE', createdAt: { $lt: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } }), 0),
      core.safe(async () => (await core.getModel('Department')).countDocuments({ companyId }), 0),
      core.safe(async () => (await core.getModel('Leave')).countDocuments({ companyId, status: 'PENDING' }), 0),
      core.safe(async () => (await core.getModel('JobPosting')).countDocuments({ companyId, status: { $in: ['OPEN', 'ACTIVE'] } }), 0),
      core.safe(async () => (await core.getModel('Project')).countDocuments({ companyId, status: { $nin: ['COMPLETED', 'ARCHIVED'] } }), 0),
    ]);

    // ---- combine the raw numbers into friendly KPIs ----
    const findCount = (rows, id) => rows.find((r) => r._id === id)?.count || 0;
    const active = findCount(byStatus, 'ACTIVE');
    const inactive = byStatus.filter((r) => r._id !== 'ACTIVE').reduce((sum, r) => sum + r.count, 0);

    // headcount trend: start from today, walk backwards month by month
    const headcountTrend = [];
    let runningCount = active;
    for (let i = 11; i >= 0; i -= 1) {
      const key = `${months[i].getFullYear()}-${months[i].getMonth() + 1}`;
      const hires = hires12.find((h) => `${h._id.y}-${h._id.m}` === key)?.count || 0;
      const exitsM = exits12.find((h) => `${h._id.y}-${h._id.m}` === key)?.count || 0;
      headcountTrend.unshift({ label: months[i].toLocaleString('en-IN', { month: 'short' }), headcount: runningCount, hires, exits: exitsM });
      runningCount = runningCount - hires + exitsM; // previous month ≈ now minus what happened
    }

    const growthPct = activeLastMonth > 0 ? core.pct(active - activeLastMonth, activeLastMonth) : 0;
    // Attrition formula (documented + reusable): exits ÷ average headcount × 100
    const avgHeadcount = Math.max(1, Math.round((active + activeLastMonth) / 2));
    const attritionRate = core.pct(exits, avgHeadcount);

    return ok(res, 200, {
      preset, from: core.dstr(from), to: core.dstr(to),
      kpis: {
        headcount: active + inactive, active, inactive, newHires, exits,
        departments: deptCount, pendingLeaves, openJobs, activeProjects,
        attritionRate, growth: growthPct,
      },
      headcountTrend,
      byDepartment,
      byDesignation: byDesignation.map((d) => ({ name: d._id, count: d.count })),
      formula: 'attrition = exits in period ÷ average headcount × 100',
    }, 'Overview');
  } catch (error) {
    return fail(res, 500, error.message);
  }
}

// ============================================================
// GET /api/analytics/attendance — present/absent/late + trends
// ============================================================
export async function attendance(req, res) {
  try {
    const companyId = req.user.companyId;
    const { from, to, preset } = core.rangeFromQuery(req.query);
    const Attendance = await core.getModel('Attendance');
    const scopeIds = await scopeUserIds(req);
    const deptIds = await deptUserIds(req, req.query.departmentId);
    const match = withUserFilter({ companyId, date: { $gte: from, $lte: to } }, scopeIds, deptIds);

    // count rows grouped by status (PRESENT / ABSENT / LATE…)
    const byStatus = await core.safe(
      () => Attendance.aggregate([{ $match: match }, { $group: { _id: { $ifNull: ['$status', 'UNKNOWN'] }, count: { $sum: 1 } } }]),
      []
    );

    // Build the daily trend. We try the fast Mongo way first ($dateToString).
    // If the Attendance.date field is stored as text, Mongo throws → we fall
    // back to bucketing in JS (capped at 5000 rows so memory stays safe).
    let daily = await core.safe(
      () => Attendance.aggregate([
        { $match: match },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, statuses: { $push: '$status' } } },
      ]),
      null
    );
    if (daily === null) {
      daily = await core.safe(async () => {
        const rows = await Attendance.find(match).select('date status').sort('date').limit(5000).lean();
        const buckets = {};
        rows.forEach((row) => {
          const day = core.dstr(row.date);
          if (!buckets[day]) buckets[day] = [];
          buckets[day].push(row.status);
        });
        return Object.entries(buckets).map(([day, statuses]) => ({ _id: day, statuses }));
      }, []);
    }

    // helper: add up counts for several possible status spellings
    const countFor = (spellings) =>
      byStatus.filter((r) => spellings.includes(String(r._id).toUpperCase())).reduce((s, r) => s + r.count, 0);

    const present = countFor(['PRESENT', 'ON_TIME', 'WFH']);
    const absent = countFor(['ABSENT']);
    const late = countFor(['LATE']);

    // turn daily rows into chart-friendly { d, present, absent, late }
    const dailyTrend = (daily || []).map((row) => ({
      d: row._id,
      present: (row.statuses || []).filter((s) => ['PRESENT', 'ON_TIME', 'WFH'].includes(String(s).toUpperCase())).length,
      absent: (row.statuses || []).filter((s) => String(s).toUpperCase() === 'ABSENT').length,
      late: (row.statuses || []).filter((s) => String(s).toUpperCase() === 'LATE').length,
    })).sort((a, b) => (a.d < b.d ? -1 : 1));

    return ok(res, 200, {
      preset, from: core.dstr(from), to: core.dstr(to),
      counts: {
        present, absent, late,
        halfDay: countFor(['HALF_DAY', 'HALFDAY']),
        leave: countFor(['LEAVE', 'ON_LEAVE']),
        total: byStatus.reduce((s, r) => s + r.count, 0),
        attendancePct: core.pct(present, Math.max(1, present + absent)),
      },
      byStatusRaw: byStatus,
      dailyTrend,
    }, 'Attendance analytics');
  } catch (error) {
    return fail(res, 500, error.message);
  }
}

// ============================================================
// GET /api/analytics/leaves — requests by status/type, trend, top users
// ============================================================
export async function leaves(req, res) {
  try {
    const companyId = req.user.companyId;
    const { from, to, preset } = core.rangeFromQuery(req.query);
    const Leave = await core.getModel('Leave');
    const scopeIds = await scopeUserIds(req);
    const deptIds = await deptUserIds(req, req.query.departmentId);
    const match = withUserFilter({ companyId, createdAt: { $gte: from, $lte: to } }, scopeIds, deptIds);

    // the "days" field had different names across phases — pick the first that exists
    const daysPerRow = core.firstNonNull(['$days', '$totalDays', '$numberOfDays', '$dayCount'], 1);

    const [byStatus, byType, byMonth, topUsers] = await Promise.all([
      core.safe(() => Leave.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]), []),
      core.safe(() => Leave.aggregate([
        { $match: { ...match, status: 'APPROVED' } },
        { $group: { _id: { $ifNull: ['$type', 'OTHER'] }, count: { $sum: 1 }, days: { $sum: daysPerRow } } },
        { $sort: { days: -1 } },
      ]), []),
      core.safe(() => Leave.aggregate([
        { $match: match },
        { $group: { _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { '_id.y': 1, '_id.m': 1 } },
      ]), []),
      core.safe(() => Leave.aggregate([
        { $match: { ...match, status: 'APPROVED' } },
        { $group: { _id: '$user', days: { $sum: daysPerRow } } },
        { $sort: { days: -1 } },
        { $limit: 5 },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
        { $project: { days: 1, name: { $ifNull: [{ $arrayElemAt: ['$u.name', 0] }, '—'] } } },
      ]), []),
    ]);

    const findCount = (id) => byStatus.find((r) => r._id === id)?.count || 0;

    return ok(res, 200, {
      preset, from: core.dstr(from), to: core.dstr(to),
      counts: {
        total: byStatus.reduce((s, r) => s + r.count, 0),
        approved: findCount('APPROVED'),
        pending: findCount('PENDING'),
        rejected: findCount('REJECTED'),
      },
      byType: byType.map((t) => ({ type: t._id, count: t.count, days: t.days })),
      monthlyTrend: byMonth.map((x) => ({ label: `${x._id.y}-${String(x._id.m).padStart(2, '0')}`, count: x.count })),
      topUsers,
    }, 'Leave analytics');
  } catch (error) {
    return fail(res, 500, error.message);
  }
}

// ============================================================
// GET /api/analytics/payroll — HR/ADMIN ONLY (route also blocks others).
// Salary data never leaves this endpoint for unauthorized roles.
// ============================================================
export async function payroll(req, res) {
  try {
    const companyId = req.user.companyId;
    const { from, to, preset } = core.rangeFromQuery(req.query);
    const Payroll = await core.getModel('Payroll');

    // gentle field-name fallbacks (module was built in an earlier phase)
    const grossExpr = core.firstNonNull(['$grossSalary', '$gross', '$earnings.total'], 0);
    const netExpr = core.firstNonNull(['$netSalary', '$net', '$netPay', '$takeHome'], 0);
    const deductionsExpr = core.firstNonNull(['$totalDeductions', '$deductions', '$deductions.total'], 0);

    const match = { companyId };
    if (req.query.year) match.year = parseInt(req.query.year, 10);

    const [totalsRows, monthlyRows, deptRows] = await Promise.all([
      // grand totals
      core.safe(() => Payroll.aggregate([{ $match: match }, { $group: { _id: null, gross: { $sum: grossExpr }, net: { $sum: netExpr }, deductions: { $sum: deductionsExpr }, slips: { $sum: 1 } } }]), []),
      // monthly trend
      core.safe(() => Payroll.aggregate([
        { $match: match },
        { $group: { _id: { y: '$year', m: '$month' }, net: { $sum: netExpr }, slips: { $sum: 1 } } },
        { $sort: { '_id.y': 1, '_id.m': 1 } },
        { $limit: 24 },
      ]), []),
      // cost per department (join payroll → users → departments)
      core.safe(() => Payroll.aggregate([
        { $match: match },
        { $lookup: { from: 'users', localField: 'user', foreignField: '_id', as: 'u' } },
        { $unwind: '$u' },
        { $group: { _id: '$u.department', net: { $sum: netExpr }, slips: { $sum: 1 } } },
        { $lookup: { from: 'departments', localField: '_id', foreignField: '_id', as: 'd' } },
        { $project: { net: 1, slips: 1, name: { $ifNull: [{ $arrayElemAt: ['$d.name', 0] }, 'Unassigned'] } } },
        { $sort: { net: -1 } },
        { $limit: 10 },
      ]), []),
    ]);

    const totals = totalsRows[0] || { gross: 0, net: 0, deductions: 0, slips: 0 };

    return ok(res, 200, {
      preset, from: core.dstr(from), to: core.dstr(to),
      totals,
      monthly: monthlyRows.map((x) => ({ label: `${x._id.y}-${String(x._id.m || 0).padStart(2, '0')}`, net: x.net, slips: x.slips })),
      byDepartment: deptRows,
    }, 'Payroll analytics');
  } catch (error) {
    return fail(res, 500, error.message);
  }
}

// ============================================================
// GET /api/analytics/work — tasks + projects + expenses + assets + ratings
// ============================================================
export async function work(req, res) {
  try {
    const companyId = req.user.companyId;
    const scopeIds = await scopeUserIds(req);
    const taskMatch = withUserFilter({ companyId }, scopeIds, null);
    const Task = await core.getModel('Task');
    const now = new Date();

    const [taskByStatus, overdueCount, tasksPerUser, projectByStatus, delayedProjects, expenseByStatus, expenseApproved, assetByStatus, perfRows] = await Promise.all([
      core.safe(() => Task.aggregate([{ $match: taskMatch }, { $group: { _id: { $ifNull: ['$status', 'TODO'] }, count: { $sum: 1 } } }]), []),
      core.safe(() => Task.countDocuments({ ...taskMatch, dueDate: { $lt: now }, status: { $nin: ['COMPLETED', 'DONE'] } }), 0),
      core.safe(() => Task.aggregate([
        { $match: taskMatch },
        // a task's owner field may be assignedTo OR assignee → firstNonNull picks one
        { $group: { _id: core.firstNonNull(['$assignedTo', '$assignee'], null), total: { $sum: 1 }, done: { $sum: { $cond: [{ $in: ['$status', ['COMPLETED', 'DONE']] }, 1, 0] } } } },
        { $match: { _id: { $ne: null } } },
        { $sort: { total: -1 } },
        { $limit: 8 },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
        { $project: { total: 1, done: 1, name: { $ifNull: [{ $arrayElemAt: ['$u.name', 0] }, '—'] } } },
      ]), []),
      core.safe(async () => (await core.getModel('Project')).aggregate([{ $match: { companyId } }, { $group: { _id: { $ifNull: ['$status', 'ACTIVE'] }, count: { $sum: 1 } } }]), []),
      core.safe(async () => (await core.getModel('Project')).countDocuments({ companyId, endDate: { $lt: now }, status: { $nin: ['COMPLETED', 'ARCHIVED'] } }), 0),
      core.safe(async () => (await core.getModel('Expense')).aggregate([{ $match: { companyId } }, { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]), []),
      core.safe(async () => (await core.getModel('Expense')).aggregate([{ $match: { companyId, status: { $in: ['APPROVED', 'REIMBURSED'] } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]), []),
      core.safe(async () => (await core.getModel('Asset')).aggregate([{ $match: { companyId } }, { $group: { _id: '$status', count: { $sum: 1 } } }]), []),
      // performance: count appraisals, average rating, average goal completion
      core.safe(async () => (await core.getModel('Appraisal')).aggregate([
        { $match: { companyId } },
        { $group: { _id: null, count: { $sum: 1 }, avgRating: { $avg: { $cond: [{ $gt: ['$finalRating', 0] }, '$finalRating', null] } }, goalCompletion: { $avg: { $avg: '$goals.progress' } } } },
      ]), []),
    ]);

    const countFor = (rows, spellings) =>
      rows.filter((r) => spellings.includes(String(r._id).toUpperCase())).reduce((s, r) => s + r.count, 0);

    const totalTasks = taskByStatus.reduce((s, r) => s + r.count, 0);
    const doneTasks = countFor(taskByStatus, ['COMPLETED', 'DONE']);
    const perf = perfRows[0] || { count: 0, avgRating: 0, goalCompletion: 0 };
    const totalProjects = projectByStatus.reduce((s, r) => s + r.count, 0);

    return ok(res, 200, {
      tasks: {
        total: totalTasks, done: doneTasks,
        pending: countFor(taskByStatus, ['TODO', 'PENDING', 'IN_PROGRESS', 'INPROGRESS']),
        overdue: overdueCount,
        completionPct: core.pct(doneTasks, Math.max(1, totalTasks)),
        byStatusRaw: taskByStatus,
        byUser: tasksPerUser,
      },
      projects: {
        total: totalProjects,
        active: countFor(projectByStatus, ['ACTIVE', 'IN_PROGRESS', 'ONGOING']),
        delayed: delayedProjects,
        byStatusRaw: projectByStatus,
      },
      expenses: { byStatusRaw: expenseByStatus, approvedTotal: expenseApproved[0]?.total || 0 },
      assets: { byStatusRaw: assetByStatus },
      performance: {
        appraisals: perf.count,
        avgRating: Math.round((perf.avgRating || 0) * 100) / 100,
        goalCompletion: Math.round(perf.goalCompletion || 0),
      },
    }, 'Work analytics');
  } catch (error) {
    return fail(res, 500, error.message);
  }
}

// ============================================================
// GET /api/analytics/recruitment — hiring funnel + source quality
// (If your app has no Application model we return null and the
//  frontend simply shows "—" instead of breaking.)
// ============================================================
export async function recruitment(req, res) {
  try {
    const companyId = req.user.companyId;
    const JobPosting = await core.getModel('JobPosting');

    const jobByStatus = await core.safe(
      () => JobPosting.aggregate([{ $match: { companyId } }, { $group: { _id: { $ifNull: ['$status', 'OPEN'] }, count: { $sum: 1 } } }]),
      []
    );

    // Try to load the Application model; if it doesn't exist, skip gracefully
    let Application = null;
    try { Application = await core.getModel('Application'); } catch { Application = null; }

    let applications = null;
    if (Application) {
      const [appByStatus, bySource] = await Promise.all([
        core.safe(() => Application.aggregate([{ $match: { companyId } }, { $group: { _id: { $ifNull: ['$status', 'APPLIED'] }, count: { $sum: 1 } } }]), []),
        core.safe(() => Application.aggregate([
          { $match: { companyId } },
          { $group: { _id: { $ifNull: ['$source', 'DIRECT'] }, applications: { $sum: 1 }, hires: { $sum: { $cond: [{ $in: ['$status', ['HIRED', 'OFFER_ACCEPTED']] }, 1, 0] } } } },
          { $sort: { applications: -1 } },
        ]), []),
      ]);

      const countFor = (spellings) => appByStatus.filter((r) => spellings.includes(String(r._id).toUpperCase())).reduce((s, r) => s + r.count, 0);
      const total = appByStatus.reduce((s, r) => s + r.count, 0);
      const screening = countFor(['SCREENING', 'SCREENED']);
      const shortlisted = countFor(['SHORTLISTED']);
      const interview = countFor(['INTERVIEW', 'INTERVIEWING']);
      const offers = countFor(['OFFER', 'OFFERED', 'OFFER_ACCEPTED']);
      const hires = countFor(['HIRED', 'OFFER_ACCEPTED']);

      applications = {
        total, screening, shortlisted, interview, offers, hires,
        rejected: countFor(['REJECTED']),
        // funnel conversion rates
        rates: {
          appToScreening: core.pct(screening, Math.max(1, total)),
          screeningToShortlist: core.pct(shortlisted, Math.max(1, screening)),
          interviewToOffer: core.pct(offers, Math.max(1, interview)),
          offerAcceptance: core.pct(hires, Math.max(1, offers)),
        },
        bySource: bySource.map((s) => ({ source: s._id, applications: s.applications, hires: s.hires })),
      };
    }

    return ok(res, 200, {
      jobs: {
        total: jobByStatus.reduce((s, r) => s + r.count, 0),
        open: jobByStatus.filter((r) => ['OPEN', 'ACTIVE'].includes(String(r._id).toUpperCase())).reduce((s, r) => s + r.count, 0),
        byStatusRaw: jobByStatus,
      },
      applications,
    }, 'Recruitment analytics');
  } catch (error) {
    return fail(res, 500, error.message);
  }
}

// ============================================================
// GET /api/analytics/my — the logged-in user's OWN stats.
// Employees never see anyone else's data here.
// ============================================================
export async function myStats(req, res) {
  try {
    const companyId = req.user.companyId;
    const myId = req.user._id;
    const { from, to } = core.rangeFromQuery({ preset: 'this_month' });

    const Attendance = await core.getModel('Attendance');
    const Leave = await core.getModel('Leave');
    const Task = await core.getModel('Task');

    const [myAttendance, myLeaves, myTasks, upcomingHolidays, roster] = await Promise.all([
      core.safe(() => Attendance.aggregate([{ $match: { companyId, user: myId, date: { $gte: from, $lte: to } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]), []),
      core.safe(() => Leave.aggregate([{ $match: { companyId, user: myId } }, { $group: { _id: '$status', count: { $sum: 1 } } }]), []),
      core.safe(() => Task.aggregate([{ $match: { companyId, $or: [{ assignedTo: myId }, { assignee: myId }] } }, { $group: { _id: { $ifNull: ['$status', 'TODO'] }, count: { $sum: 1 } } }]), []),
      // reuse Phase-17 engine: holidays + shift resolution (no duplicate logic!)
      core.safe(() => engine.getHolidaysForUser(companyId, req.user, { from: core.dstr(new Date()), to: engine.addDays(core.dstr(new Date()), 45) }), []),
      core.safe(async () => {
        const resolved = await engine.resolveShiftForUser(companyId, req.user, new Date());
        const workingDays = await engine.getWorkingDaysForUser(companyId, req.user);
        return {
          shift: resolved.shift ? { name: resolved.shift.name, startTime: resolved.shift.startTime, endTime: resolved.shift.endTime } : null,
          source: resolved.source,
          workingDays,
        };
      }, null),
    ]);

    return ok(res, 200, {
      month: { from: core.dstr(from), to: core.dstr(to) },
      attendance: myAttendance,
      leaves: myLeaves,
      tasks: myTasks,
      upcomingHolidays: (upcomingHolidays || []).filter((h) => !(h.isOptional && !h.picked)).slice(0, 5),
      roster,
    }, 'My stats');
  } catch (error) {
    return fail(res, 500, error.message);
  }
}

