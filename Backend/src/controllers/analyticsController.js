// ============================================================
// Analytics controller
//
// COMPANY_ADMIN / HR_MANAGER → company-wide data
// MANAGER / TEAM_LEAD        → reporting subtree only
// EMPLOYEE                   → own analytics only
// ============================================================

import mongoose from "mongoose";
import * as core from "../utils/reportingCore.js";
import * as engine from "../utils/scheduleEngine.js";

const ok = (res, status, data, message) =>
  res.status(status).json({ statusCode: status, success: true, data, message });

const fail = (res, status, message) =>
  res.status(status).json({ statusCode: status, success: false, message });

// Mongo aggregation does not cast string IDs to ObjectId.
const toObjectIds = (ids = []) =>
  ids
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

// Admin/HR → null means unrestricted inside their company.
// Manager/TL → array containing only their reporting subtree.
const scopeUserIds = async (req) => {
  const isTeamRole =
    req.user.role === "MANAGER" || req.user.role === "TEAM_LEAD";
  if (!isTeamRole) return null;

  return core.safe(async () => {
    const orgHelpers = await import("../utils/orgHelpers.js");
    const getSubtreeIds =
      orgHelpers.getSubtreeIds || orgHelpers.default?.getSubtreeIds;

    if (!getSubtreeIds) return [req.user._id];

    const ids = await getSubtreeIds(req.user.companyId, req.user._id);
    return toObjectIds(ids);
  }, [req.user._id]);
};

const deptUserIds = async (req, departmentId) => {
  if (!departmentId) return null;

  const User = await core.getModel("User");
  const users = await User.find({
    companyId: req.user.companyId,
    department: departmentId,
  })
    .select("_id")
    .lean();

  return users.map((user) => user._id);
};

// Apply team/department IDs to a query.
// When both exist, use their intersection.
const withUserFilter = (match, scopeIds, departmentIds, field = "user") => {
  let ids = scopeIds || departmentIds;

  if (scopeIds && departmentIds) {
    ids = scopeIds.filter((scopeId) =>
      departmentIds.some(
        (departmentUserId) => String(departmentUserId) === String(scopeId),
      ),
    );
  }

  if (ids) match[field] = { $in: ids };
  return match;
};

// ============================================================
// OVERVIEW
// ============================================================

export const overview = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const companyId = req.user.companyId;
    if (!companyId) return fail(res, 400, "Company context required");

    const { from, to, preset } = core.rangeFromQuery(req.query);
    // DB Logic - DB logics
    const scopeIds = await scopeUserIds(req);
    const isTeamScope = Array.isArray(scopeIds);
    const User = await core.getModel("User");

    const baseMatch = isTeamScope
      ? { companyId, _id: { $in: scopeIds } }
      : { companyId };

    const userFilter = isTeamScope ? { user: { $in: scopeIds } } : {};

    // Project stores its physical tenant field as "company".
    const projectFilter = isTeamScope
      ? {
          company: companyId,
          $or: [
            { manager: req.user._id },
            { teamLeads: req.user._id },
            { members: { $in: scopeIds } },
          ],
        }
      : { company: companyId };

    const months = [];

    for (let index = 11; index >= 0; index -= 1) {
      const date = new Date();
      date.setMonth(date.getMonth() - index);
      months.push(new Date(date.getFullYear(), date.getMonth(), 1));
    }

    const monthStart = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1,
    );

    const [
      byStatus,
      newHires,
      exits,
      byDepartment,
      byDesignation,
      hires12,
      exits12,
      activeLastMonth,
      departmentCount,
      pendingLeaves,
      openJobs,
      activeProjects,
    ] = await Promise.all([
      core.safe(
        () =>
          User.aggregate([
            { $match: baseMatch },
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ]),
        [],
      ),

      core.safe(
        () =>
          User.countDocuments({
            ...baseMatch,
            createdAt: { $gte: from, $lte: to },
          }),
        0,
      ),

      core.safe(
        async () =>
          (await core.getModel("Resignation")).countDocuments({
            companyId,
            ...userFilter,
            createdAt: { $gte: from, $lte: to },
          }),
        0,
      ),

      core.safe(
        () =>
          User.aggregate([
            { $match: { ...baseMatch, status: "ACTIVE" } },
            { $group: { _id: "$department", count: { $sum: 1 } } },
            {
              $lookup: {
                from: "departments",
                localField: "_id",
                foreignField: "_id",
                as: "department",
              },
            },
            {
              $project: {
                count: 1,
                name: {
                  $ifNull: [
                    { $arrayElemAt: ["$department.name", 0] },
                    "Unassigned",
                  ],
                },
              },
            },
            { $sort: { count: -1 } },
            { $limit: 10 },
          ]),
        [],
      ),

      core.safe(
        () =>
          User.aggregate([
            {
              $match: {
                ...baseMatch,
                status: "ACTIVE",
                designation: { $nin: [null, ""] },
              },
            },
            { $group: { _id: "$designation", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 8 },
          ]),
        [],
      ),

      core.safe(
        () =>
          User.aggregate([
            {
              $match: {
                ...baseMatch,
                createdAt: { $gte: months[0] },
              },
            },
            {
              $group: {
                _id: {
                  year: { $year: "$createdAt" },
                  month: { $month: "$createdAt" },
                },
                count: { $sum: 1 },
              },
            },
          ]),
        [],
      ),

      core.safe(
        async () =>
          (await core.getModel("Resignation")).aggregate([
            {
              $match: {
                companyId,
                ...userFilter,
                createdAt: { $gte: months[0] },
              },
            },
            {
              $group: {
                _id: {
                  year: { $year: "$createdAt" },
                  month: { $month: "$createdAt" },
                },
                count: { $sum: 1 },
              },
            },
          ]),
        [],
      ),

      core.safe(
        () =>
          User.countDocuments({
            ...baseMatch,
            status: "ACTIVE",
            createdAt: { $lt: monthStart },
          }),
        0,
      ),

      isTeamScope
        ? 0
        : core.safe(
            async () =>
              (await core.getModel("Department")).countDocuments({ companyId }),
            0,
          ),

      core.safe(
        async () =>
          (await core.getModel("Leave")).countDocuments({
            companyId,
            ...userFilter,
            status: "PENDING",
          }),
        0,
      ),

      isTeamScope
        ? 0
        : core.safe(
            async () =>
              (await core.getModel("JobPosting")).countDocuments({
                companyId,
                status: { $in: ["OPEN", "ACTIVE"] },
              }),
            0,
          ),

      core.safe(
        async () =>
          (await core.getModel("Project")).countDocuments({
            ...projectFilter,
            status: { $nin: ["COMPLETED", "CANCELLED", "ARCHIVED"] },
          }),
        0,
      ),
    ]);

    const findCount = (rows, status) =>
      rows.find((row) => row._id === status)?.count || 0;

    const active = findCount(byStatus, "ACTIVE");

    const inactive = byStatus
      .filter((row) => row._id !== "ACTIVE")
      .reduce((sum, row) => sum + row.count, 0);

    const headcountTrend = [];
    let runningCount = active;

    for (let index = 11; index >= 0; index -= 1) {
      const key = `${months[index].getFullYear()}-${months[index].getMonth() + 1}`;

      const hires =
        hires12.find((row) => `${row._id.year}-${row._id.month}` === key)
          ?.count || 0;

      const monthExits =
        exits12.find((row) => `${row._id.year}-${row._id.month}` === key)
          ?.count || 0;

      const trendRow = {
        label: months[index].toLocaleString("en-IN", { month: "short" }),
        headcount: runningCount,
        hires,
      };

      // Exit details are HR/Admin-only.
      if (!isTeamScope) trendRow.exits = monthExits;

      headcountTrend.unshift(trendRow);
      runningCount = runningCount - hires + monthExits;
    }

    const growth =
      activeLastMonth > 0
        ? core.pct(active - activeLastMonth, activeLastMonth)
        : 0;

    const averageHeadcount = Math.max(
      1,
      Math.round((active + activeLastMonth) / 2),
    );

    const commonKpis = {
      headcount: active + inactive,
      active,
      inactive,
      newHires,
      growth,
      pendingLeaves,
      activeProjects,
    };

    // Managers/TLs receive only team-safe KPIs.
    const kpis = isTeamScope
      ? commonKpis
      : {
          ...commonKpis,
          exits,
          attritionRate: core.pct(exits, averageHeadcount),
          departments: departmentCount,
          openJobs,
        };

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        scope: isTeamScope ? "TEAM" : "COMPANY",
        preset,
        from: core.dstr(from),
        to: core.dstr(to),
        kpis,
        headcountTrend,
        byDepartment,
        byDesignation: byDesignation.map((row) => ({
          name: row._id,
          count: row.count,
        })),
        ...(isTeamScope
          ? {}
          : {
              formula: "attrition = exits in period ÷ average headcount × 100",
            }),
      },
      isTeamScope ? "Team overview" : "Company overview",
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// ATTENDANCE
// ============================================================

export const attendance = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const companyId = req.user.companyId;
    const { from, to, preset } = core.rangeFromQuery(req.query);
    // DB Logic - DB logics
    const Attendance = await core.getModel("Attendance");
    const scopeIds = await scopeUserIds(req);

    const departmentIds = await deptUserIds(req, req.query.departmentId);

    // Attendance.date is stored as YYYY-MM-DD text.
    const match = withUserFilter(
      {
        companyId,
        date: {
          $gte: core.dstr(from),
          $lte: core.dstr(to),
        },
      },
      scopeIds,
      departmentIds,
    );

    const [byStatus, daily] = await Promise.all([
      core.safe(
        () =>
          Attendance.aggregate([
            { $match: match },
            {
              $group: {
                _id: { $ifNull: ["$status", "UNKNOWN"] },
                count: { $sum: 1 },
              },
            },
          ]),
        [],
      ),

      core.safe(
        () =>
          Attendance.aggregate([
            { $match: match },
            {
              $group: {
                _id: "$date",
                statuses: { $push: "$status" },
              },
            },
            { $sort: { _id: 1 } },
          ]),
        [],
      ),
    ]);

    const countFor = (spellings) =>
      byStatus
        .filter((row) => spellings.includes(String(row._id).toUpperCase()))
        .reduce((sum, row) => sum + row.count, 0);

    const present = countFor(["PRESENT", "ON_TIME", "WFH"]);
    const absent = countFor(["ABSENT"]);
    const late = countFor(["LATE"]);

    const dailyTrend = daily.map((row) => ({
      d: row._id,

      present: row.statuses.filter((status) =>
        ["PRESENT", "ON_TIME", "WFH"].includes(String(status).toUpperCase()),
      ).length,

      absent: row.statuses.filter(
        (status) => String(status).toUpperCase() === "ABSENT",
      ).length,

      late: row.statuses.filter(
        (status) => String(status).toUpperCase() === "LATE",
      ).length,
    }));

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        scope: scopeIds ? "TEAM" : "COMPANY",
        preset,
        from: core.dstr(from),
        to: core.dstr(to),

        counts: {
          present,
          absent,
          late,
          halfDay: countFor(["HALF_DAY", "HALFDAY"]),
          leave: countFor(["LEAVE", "ON_LEAVE"]),
          total: byStatus.reduce((sum, row) => sum + row.count, 0),
          attendancePct: core.pct(present, Math.max(1, present + absent)),
        },

        byStatusRaw: byStatus,
        dailyTrend,
      },
      scopeIds ? "Team attendance analytics" : "Company attendance analytics",
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// LEAVES
// ============================================================

export const leaves = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const companyId = req.user.companyId;
    const { from, to, preset } = core.rangeFromQuery(req.query);
    // DB Logic - DB logics
    const Leave = await core.getModel("Leave");
    const scopeIds = await scopeUserIds(req);

    const departmentIds = await deptUserIds(req, req.query.departmentId);

    const match = withUserFilter(
      {
        companyId,
        createdAt: { $gte: from, $lte: to },
      },
      scopeIds,
      departmentIds,
    );

    const daysPerRow = core.firstNonNull(
      ["$days", "$totalDays", "$numberOfDays", "$dayCount"],
      1,
    );

    const [byStatus, byType, byMonth, topUsers] = await Promise.all([
      core.safe(
        () =>
          Leave.aggregate([
            { $match: match },
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ]),
        [],
      ),

      core.safe(
        () =>
          Leave.aggregate([
            { $match: { ...match, status: "APPROVED" } },
            {
              $group: {
                _id: { $ifNull: ["$type", "OTHER"] },
                count: { $sum: 1 },
                days: { $sum: daysPerRow },
              },
            },
            { $sort: { days: -1 } },
          ]),
        [],
      ),

      core.safe(
        () =>
          Leave.aggregate([
            { $match: match },
            {
              $group: {
                _id: {
                  year: { $year: "$createdAt" },
                  month: { $month: "$createdAt" },
                },
                count: { $sum: 1 },
              },
            },
            { $sort: { "_id.year": 1, "_id.month": 1 } },
          ]),
        [],
      ),

      core.safe(
        () =>
          Leave.aggregate([
            { $match: { ...match, status: "APPROVED" } },
            { $group: { _id: "$user", days: { $sum: daysPerRow } } },
            { $sort: { days: -1 } },
            { $limit: 5 },
            {
              $lookup: {
                from: "users",
                localField: "_id",
                foreignField: "_id",
                as: "user",
              },
            },
            {
              $project: {
                days: 1,
                name: {
                  $ifNull: [{ $arrayElemAt: ["$user.name", 0] }, "—"],
                },
              },
            },
          ]),
        [],
      ),
    ]);

    const findCount = (status) =>
      byStatus.find((row) => row._id === status)?.count || 0;

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        scope: scopeIds ? "TEAM" : "COMPANY",
        preset,
        from: core.dstr(from),
        to: core.dstr(to),

        counts: {
          total: byStatus.reduce((sum, row) => sum + row.count, 0),
          approved: findCount("APPROVED"),
          pending: findCount("PENDING"),
          rejected: findCount("REJECTED"),
        },

        byType: byType.map((row) => ({
          type: row._id,
          count: row.count,
          days: row.days,
        })),

        monthlyTrend: byMonth.map((row) => ({
          label: `${row._id.year}-${String(row._id.month).padStart(2, "0")}`,
          count: row.count,
        })),

        topUsers,
      },
      scopeIds ? "Team leave analytics" : "Company leave analytics",
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// PAYROLL — COMPANY_ADMIN / HR_MANAGER ONLY
// ============================================================

export const payroll = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const companyId = req.user.companyId;
    const { from, to, preset } = core.rangeFromQuery(req.query);
    // DB Logic - DB logics
    const Payroll = await core.getModel("Payroll");

    const grossExpression = core.firstNonNull(
      ["$earnings.gross", "$grossSalary", "$gross", "$earnings.total"],
      0,
    );

    const netExpression = core.firstNonNull(
      ["$netPay", "$netSalary", "$net", "$takeHome"],
      0,
    );

    const deductionExpression = core.firstNonNull(
      ["$deductions.total", "$totalDeductions"],
      0,
    );

    const match = {
      companyId,
      createdAt: { $gte: from, $lte: to },
    };

    const [totalRows, monthlyRows, departmentRows] = await Promise.all([
      core.safe(
        () =>
          Payroll.aggregate([
            { $match: match },
            {
              $group: {
                _id: null,
                gross: { $sum: grossExpression },
                net: { $sum: netExpression },
                deductions: { $sum: deductionExpression },
                slips: { $sum: 1 },
              },
            },
          ]),
        [],
      ),

      core.safe(
        () =>
          Payroll.aggregate([
            { $match: match },
            {
              $group: {
                _id: "$month",
                net: { $sum: netExpression },
                slips: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
            { $limit: 24 },
          ]),
        [],
      ),

      core.safe(
        () =>
          Payroll.aggregate([
            { $match: match },
            {
              $lookup: {
                from: "users",
                localField: "user",
                foreignField: "_id",
                as: "user",
              },
            },
            { $unwind: "$user" },
            {
              $group: {
                _id: "$user.department",
                net: { $sum: netExpression },
                slips: { $sum: 1 },
              },
            },
            {
              $lookup: {
                from: "departments",
                localField: "_id",
                foreignField: "_id",
                as: "department",
              },
            },
            {
              $project: {
                net: 1,
                slips: 1,
                name: {
                  $ifNull: [
                    { $arrayElemAt: ["$department.name", 0] },
                    "Unassigned",
                  ],
                },
              },
            },
            { $sort: { net: -1 } },
            { $limit: 10 },
          ]),
        [],
      ),
    ]);

    const totals = totalRows[0] || {
      gross: 0,
      net: 0,
      deductions: 0,
      slips: 0,
    };

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        preset,
        from: core.dstr(from),
        to: core.dstr(to),
        totals,

        monthly: monthlyRows.map((row) => ({
          label: row._id || "Unknown",
          net: row.net,
          slips: row.slips,
        })),

        byDepartment: departmentRows,
      },
      "Payroll analytics",
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// WORK — TASKS, PROJECTS, EXPENSES, ASSETS, PERFORMANCE
// ============================================================

export const work = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const companyId = req.user.companyId;
    // DB Logic - DB logics
    const scopeIds = await scopeUserIds(req);
    const isTeamScope = Array.isArray(scopeIds);
    const now = new Date();
    const Task = await core.getModel("Task");

    // Task uses the physical tenant field "company".
    const taskMatch = isTeamScope
      ? {
          company: companyId,
          assignedTo: { $in: scopeIds },
        }
      : { company: companyId };

    const projectMatch = isTeamScope
      ? {
          company: companyId,
          $or: [
            { manager: req.user._id },
            { teamLeads: req.user._id },
            { members: { $in: scopeIds } },
          ],
        }
      : { company: companyId };

    const expenseMatch = isTeamScope
      ? { companyId, user: { $in: scopeIds } }
      : { companyId };

    const assetMatch = isTeamScope
      ? { companyId, currentHolder: { $in: scopeIds } }
      : { companyId };

    const performanceMatch = isTeamScope
      ? { companyId, user: { $in: scopeIds } }
      : { companyId };

    const [
      taskByStatus,
      overdueTasks,
      tasksPerUser,
      projectByStatus,
      delayedProjects,
      expenseByStatus,
      approvedExpenses,
      assetByStatus,
      performanceRows,
    ] = await Promise.all([
      core.safe(
        () =>
          Task.aggregate([
            { $match: taskMatch },
            {
              $group: {
                _id: { $ifNull: ["$status", "TODO"] },
                count: { $sum: 1 },
              },
            },
          ]),
        [],
      ),

      core.safe(
        () =>
          Task.countDocuments({
            ...taskMatch,
            dueDate: { $lt: now },
            status: { $nin: ["COMPLETED", "DONE"] },
          }),
        0,
      ),

      core.safe(
        () =>
          Task.aggregate([
            { $match: taskMatch },
            {
              $group: {
                _id: "$assignedTo",
                total: { $sum: 1 },
                done: {
                  $sum: {
                    $cond: [{ $in: ["$status", ["COMPLETED", "DONE"]] }, 1, 0],
                  },
                },
              },
            },
            { $match: { _id: { $ne: null } } },
            { $sort: { total: -1 } },
            { $limit: 8 },
            {
              $lookup: {
                from: "users",
                localField: "_id",
                foreignField: "_id",
                as: "user",
              },
            },
            {
              $project: {
                total: 1,
                done: 1,
                name: {
                  $ifNull: [{ $arrayElemAt: ["$user.name", 0] }, "—"],
                },
              },
            },
          ]),
        [],
      ),

      core.safe(
        async () =>
          (await core.getModel("Project")).aggregate([
            { $match: projectMatch },
            {
              $group: {
                _id: { $ifNull: ["$status", "NOT_STARTED"] },
                count: { $sum: 1 },
              },
            },
          ]),
        [],
      ),

      core.safe(
        async () =>
          (await core.getModel("Project")).countDocuments({
            ...projectMatch,
            endDate: { $lt: now },
            status: { $nin: ["COMPLETED", "CANCELLED", "ARCHIVED"] },
          }),
        0,
      ),

      core.safe(
        async () =>
          (await core.getModel("Expense")).aggregate([
            { $match: expenseMatch },
            {
              $group: {
                _id: "$status",
                count: { $sum: 1 },
                amount: { $sum: "$amount" },
              },
            },
          ]),
        [],
      ),

      core.safe(
        async () =>
          (await core.getModel("Expense")).aggregate([
            {
              $match: {
                ...expenseMatch,
                status: { $in: ["APPROVED", "REIMBURSED"] },
              },
            },
            { $group: { _id: null, total: { $sum: "$amount" } } },
          ]),
        [],
      ),

      core.safe(
        async () =>
          (await core.getModel("Asset")).aggregate([
            { $match: assetMatch },
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ]),
        [],
      ),

      core.safe(
        async () =>
          (await core.getModel("Appraisal")).aggregate([
            { $match: performanceMatch },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                avgRating: {
                  $avg: {
                    $cond: [{ $gt: ["$finalRating", 0] }, "$finalRating", null],
                  },
                },
                goalCompletion: { $avg: { $avg: "$goals.progress" } },
              },
            },
          ]),
        [],
      ),
    ]);

    const countFor = (rows, spellings) =>
      rows
        .filter((row) => spellings.includes(String(row._id).toUpperCase()))
        .reduce((sum, row) => sum + row.count, 0);

    const totalTasks = taskByStatus.reduce((sum, row) => sum + row.count, 0);

    const completedTasks = countFor(taskByStatus, ["COMPLETED", "DONE"]);

    const totalProjects = projectByStatus.reduce(
      (sum, row) => sum + row.count,
      0,
    );

    const performance = performanceRows[0] || {
      count: 0,
      avgRating: 0,
      goalCompletion: 0,
    };

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        scope: isTeamScope ? "TEAM" : "COMPANY",

        tasks: {
          total: totalTasks,
          done: completedTasks,
          pending: countFor(taskByStatus, [
            "TODO",
            "PENDING",
            "IN_PROGRESS",
            "INPROGRESS",
          ]),
          overdue: overdueTasks,
          completionPct: core.pct(completedTasks, Math.max(1, totalTasks)),
          byStatusRaw: taskByStatus,
          byUser: tasksPerUser,
        },

        projects: {
          total: totalProjects,
          active: countFor(projectByStatus, [
            "NOT_STARTED",
            "ACTIVE",
            "IN_PROGRESS",
            "ONGOING",
          ]),
          delayed: delayedProjects,
          byStatusRaw: projectByStatus,
        },

        expenses: {
          byStatusRaw: expenseByStatus,
          approvedTotal: approvedExpenses[0]?.total || 0,
        },

        assets: {
          byStatusRaw: assetByStatus,
        },

        performance: {
          appraisals: performance.count,
          avgRating: Math.round((performance.avgRating || 0) * 100) / 100,
          goalCompletion: Math.round(performance.goalCompletion || 0),
        },
      },
      isTeamScope ? "Team work analytics" : "Company work analytics",
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// RECRUITMENT — COMPANY_ADMIN / HR_MANAGER ONLY
// ============================================================

export const recruitment = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const companyId = req.user.companyId;
    // DB Logic - DB logics
    const JobPosting = await core.getModel("JobPosting");
    const Candidate = await core.getModel("Candidate");

    const [jobByStatus, candidateByStage] = await Promise.all([
      core.safe(
        () =>
          JobPosting.aggregate([
            { $match: { companyId } },
            {
              $group: {
                _id: { $ifNull: ["$status", "OPEN"] },
                count: { $sum: 1 },
              },
            },
          ]),
        [],
      ),

      core.safe(
        () =>
          Candidate.aggregate([
            { $match: { companyId } },
            {
              $group: {
                _id: { $ifNull: ["$stage", "APPLIED"] },
                count: { $sum: 1 },
              },
            },
          ]),
        [],
      ),
    ]);

    const candidateCount = (stages) =>
      candidateByStage
        .filter((row) => stages.includes(String(row._id).toUpperCase()))
        .reduce((sum, row) => sum + row.count, 0);

    const totalCandidates = candidateByStage.reduce(
      (sum, row) => sum + row.count,
      0,
    );

    const screening = candidateCount(["SCREENING"]);
    const shortlisted = candidateCount(["SHORTLISTED"]);
    const interview = candidateCount(["INTERVIEW"]);
    const offers = candidateCount(["OFFER"]);
    const hires = candidateCount(["HIRED"]);

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        jobs: {
          total: jobByStatus.reduce((sum, row) => sum + row.count, 0),

          open: jobByStatus
            .filter((row) =>
              ["OPEN", "ACTIVE"].includes(String(row._id).toUpperCase()),
            )
            .reduce((sum, row) => sum + row.count, 0),

          byStatusRaw: jobByStatus,
        },

        applications: {
          total: totalCandidates,
          screening,
          shortlisted,
          interview,
          offers,
          hires,
          rejected: candidateCount(["REJECTED"]),

          rates: {
            appToScreening: core.pct(screening, Math.max(1, totalCandidates)),

            screeningToShortlist: core.pct(shortlisted, Math.max(1, screening)),

            interviewToOffer: core.pct(offers, Math.max(1, interview)),

            offerAcceptance: core.pct(hires, Math.max(1, offers)),
          },

          // Candidate model currently has no source field.
          bySource: [],
        },
      },
      "Recruitment analytics",
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// MY STATS — LOGGED-IN USER ONLY
// ============================================================

export const myStats = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const companyId = req.user.companyId;
    const myId = req.user._id;

    const { from, to } = core.rangeFromQuery({
      preset: "this_month",
    });

    // DB Logic - DB logics
    const Attendance = await core.getModel("Attendance");
    const Leave = await core.getModel("Leave");
    const Task = await core.getModel("Task");

    const [myAttendance, myLeaves, myTasks, upcomingHolidays, roster] =
      await Promise.all([
        core.safe(
          () =>
            Attendance.aggregate([
              {
                $match: {
                  companyId,
                  user: myId,
                  date: {
                    $gte: core.dstr(from),
                    $lte: core.dstr(to),
                  },
                },
              },
              {
                $group: {
                  _id: "$status",
                  count: { $sum: 1 },
                },
              },
            ]),
          [],
        ),

        core.safe(
          () =>
            Leave.aggregate([
              { $match: { companyId, user: myId } },
              {
                $group: {
                  _id: "$status",
                  count: { $sum: 1 },
                },
              },
            ]),
          [],
        ),

        // Task uses the physical tenant field "company".
        core.safe(
          () =>
            Task.aggregate([
              {
                $match: {
                  company: companyId,
                  assignedTo: myId,
                },
              },
              {
                $group: {
                  _id: { $ifNull: ["$status", "TODO"] },
                  count: { $sum: 1 },
                },
              },
            ]),
          [],
        ),

        core.safe(
          () =>
            engine.getHolidaysForUser(companyId, req.user, {
              from: core.dstr(new Date()),
              to: engine.addDays(core.dstr(new Date()), 45),
            }),
          [],
        ),

        core.safe(async () => {
          const resolved = await engine.resolveShiftForUser(
            companyId,
            req.user,
            new Date(),
          );

          const workingDays = await engine.getWorkingDaysForUser(
            companyId,
            req.user,
          );

          return {
            shift: resolved.shift
              ? {
                  name: resolved.shift.name,
                  startTime: resolved.shift.startTime,
                  endTime: resolved.shift.endTime,
                }
              : null,

            source: resolved.source,
            workingDays,
          };
        }, null),
      ]);

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        month: {
          from: core.dstr(from),
          to: core.dstr(to),
        },

        attendance: myAttendance,
        leaves: myLeaves,
        tasks: myTasks,

        upcomingHolidays: (upcomingHolidays || [])
          .filter((holiday) => !(holiday.isOptional && !holiday.picked))
          .slice(0, 5),

        roster,
      },
      "My stats",
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};
