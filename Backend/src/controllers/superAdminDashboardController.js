import mongoose from "mongoose";
import Company from "../models/Company.js";
import User from "../models/User.js";
import Subscription from "../models/Subscription.js";
import SubscriptionPlan from "../models/SubscriptionPlan.js";
import Payment from "../models/Payment.js";
import UsageMetric from "../models/UsageMetric.js";
import AdminSession from "../models/AdminSession.js";
import SupportTicket from "../models/SupportTicket.js";
import Document from "../models/Document.js";
import { ensureDefaultPlans } from "../utils/platformPlans.js";

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

const startOfMonth = (offset = 0) =>
  new Date(new Date().getFullYear(), new Date().getMonth() + offset, 1);

const dateBucket = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;

// ============================================================
// GET /api/super-admin/dashboard
// ============================================================

export const dashboard = async (req, res) => {
  try {
    // Only inserts plans that do not exist.
    // Super Admin plan edits are never overwritten.
    // DB Logic - DB logics
    await ensureDefaultPlans(req.user._id);

    const now = new Date();

    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const monthStart = startOfMonth();

    const previousMonthStart = startOfMonth(-1);

    const yearStart = new Date(now.getFullYear(), 0, 1);

    const revenueStart =
      previousMonthStart < yearStart ? previousMonthStart : yearStart;

    const expiringHorizon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const [
      companyStatuses,
      userStats,
      subscriptionStats,
      paymentStats,
      activeSubscriptions,
      plans,
      usageStats,
      activeSessions,
      supportStats,
      storageStats,
      newCompanies,
    ] = await Promise.all([
      Company.aggregate([
        {
          $match: {
            archivedAt: null,
          },
        },
        {
          $group: {
            _id: "$status",
            count: {
              $sum: 1,
            },
          },
        },
      ]),

      User.aggregate([
        {
          $match: {
            companyId: {
              $ne: null,
            },
          },
        },
        {
          $group: {
            _id: null,

            total: {
              $sum: 1,
            },

            active: {
              $sum: {
                $cond: [
                  {
                    $eq: ["$status", "ACTIVE"],
                  },
                  1,
                  0,
                ],
              },
            },

            inactive: {
              $sum: {
                $cond: [
                  {
                    $ne: ["$status", "ACTIVE"],
                  },
                  1,
                  0,
                ],
              },
            },

            newThisMonth: {
              $sum: {
                $cond: [
                  {
                    $gte: ["$createdAt", monthStart],
                  },
                  1,
                  0,
                ],
              },
            },

            activeToday: {
              $sum: {
                $cond: [
                  {
                    $gte: ["$lastLogin", today],
                  },
                  1,
                  0,
                ],
              },
            },

            activeThisMonth: {
              $sum: {
                $cond: [
                  {
                    $gte: ["$lastLogin", monthStart],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),

      Subscription.aggregate([
        {
          $group: {
            _id: null,

            total: {
              $sum: 1,
            },

            active: {
              $sum: {
                $cond: [
                  {
                    $eq: ["$status", "ACTIVE"],
                  },
                  1,
                  0,
                ],
              },
            },

            trial: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      {
                        $eq: ["$status", "TRIAL"],
                      },
                      {
                        $eq: ["$plan", "TRIAL"],
                      },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },

            expired: {
              $sum: {
                $cond: [
                  {
                    $eq: ["$status", "EXPIRED"],
                  },
                  1,
                  0,
                ],
              },
            },

            cancelled: {
              $sum: {
                $cond: [
                  {
                    $eq: ["$status", "CANCELLED"],
                  },
                  1,
                  0,
                ],
              },
            },

            expiringSoon: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      {
                        $gt: ["$endDate", now],
                      },
                      {
                        $lte: ["$endDate", expiringHorizon],
                      },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),

      // Revenue totals are calculated inside MongoDB.
      Payment.aggregate([
        {
          $match: {
            status: "SUCCESS",

            createdAt: {
              $gte: revenueStart,
            },
          },
        },
        {
          $group: {
            _id: null,

            monthly: {
              $sum: {
                $cond: [
                  {
                    $gte: ["$createdAt", monthStart],
                  },
                  "$amount",
                  0,
                ],
              },
            },

            previousMonth: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      {
                        $gte: ["$createdAt", previousMonthStart],
                      },
                      {
                        $lt: ["$createdAt", monthStart],
                      },
                    ],
                  },
                  "$amount",
                  0,
                ],
              },
            },

            yearly: {
              $sum: {
                $cond: [
                  {
                    $gte: ["$createdAt", yearStart],
                  },
                  "$amount",
                  0,
                ],
              },
            },
          },
        },
      ]),

      Subscription.find({
        status: {
          $in: ["ACTIVE", "EXPIRING_SOON", "GRACE_PERIOD"],
        },
      })
        .select("plan billingCycle")
        .lean(),

      SubscriptionPlan.find({
        isActive: true,
      })
        .select("key prices")
        .lean(),

      UsageMetric.aggregate([
        {
          $match: {
            date: {
              $gte: dateBucket(monthStart),
            },
          },
        },
        {
          $group: {
            _id: null,

            apiRequests: {
              $sum: "$apiRequests",
            },
          },
        },
      ]),

      AdminSession.countDocuments({
        revokedAt: null,

        expiresAt: {
          $gt: now,
        },
      }),

      SupportTicket.aggregate([
        {
          $group: {
            _id: "$status",
            count: {
              $sum: 1,
            },
          },
        },
      ]),

      // Storage uses the existing Document.size field.
      Document.aggregate([
        {
          $group: {
            _id: null,

            bytes: {
              $sum: "$size",
            },

            files: {
              $sum: 1,
            },
          },
        },
      ]),

      Company.countDocuments({
        archivedAt: null,

        createdAt: {
          $gte: monthStart,
        },
      }),
    ]);

    const companyCount = (status) =>
      companyStatuses.find((row) => row._id === status)?.count || 0;

    const users = userStats[0] || {};

    const subscriptions = subscriptionStats[0] || {};

    const payments = paymentStats[0] || {
      monthly: 0,
      previousMonth: 0,
      yearly: 0,
    };

    const planMap = Object.fromEntries(plans.map((plan) => [plan.key, plan]));

    // MRR uses current active subscriptions and
    // current editable plan prices.
    const mrr = activeSubscriptions.reduce((total, subscription) => {
      const plan = planMap[subscription.plan];

      const monthlyPrice =
        subscription.billingCycle === "YEARLY"
          ? Number(plan?.prices?.yearly || 0) / 12
          : Number(plan?.prices?.monthly || 0);

      return total + monthlyPrice;
    }, 0);

    const monthlyRevenue = payments.monthly || 0;

    const yearlyRevenue = payments.yearly || 0;

    const previousRevenue = payments.previousMonth || 0;

    const revenueGrowth =
      previousRevenue > 0
        ? Math.round(
            ((monthlyRevenue - previousRevenue) / previousRevenue) * 1000,
          ) / 10
        : 0;

    const openTickets = supportStats
      .filter((row) => !["RESOLVED", "CLOSED"].includes(row._id))
      .reduce((total, row) => total + row.count, 0);

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        companies: {
          total: companyStatuses.reduce((total, row) => total + row.count, 0),

          active: companyCount("ACTIVE"),

          suspended: companyCount("SUSPENDED"),

          deactivated: companyCount("DEACTIVATED"),

          trial: subscriptions.trial || 0,

          expired: subscriptions.expired || 0,

          newThisMonth: newCompanies,
        },

        users: {
          total: users.total || 0,

          active: users.active || 0,

          inactive: users.inactive || 0,

          newThisMonth: users.newThisMonth || 0,

          activeToday: users.activeToday || 0,

          activeThisMonth: users.activeThisMonth || 0,
        },

        subscriptions: {
          active: subscriptions.active || 0,

          trial: subscriptions.trial || 0,

          expired: subscriptions.expired || 0,

          cancelled: subscriptions.cancelled || 0,

          expiringSoon: subscriptions.expiringSoon || 0,
        },

        revenue: {
          mrr: Math.round(mrr),

          arr: Math.round(mrr * 12),

          monthly: monthlyRevenue,

          yearly: yearlyRevenue,

          growthPct: revenueGrowth,
        },

        system: {
          apiRequests: usageStats[0]?.apiRequests || 0,

          storageBytes: storageStats[0]?.bytes || 0,

          fileUploads: storageStats[0]?.files || 0,

          activeSessions,

          openTickets,

          database: mongoose.connection.readyState === 1 ? "HEALTHY" : "DOWN",

          backend: "HEALTHY",
        },
      },
      "Platform dashboard",
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// GET /api/super-admin/dashboard/charts
// ============================================================

export const charts = async (req, res) => {
  try {
    const start = startOfMonth(-11);

    const [
      companyGrowth,
      userGrowth,
      subscriptionDistribution,
      revenueTrend,
      companyStatus,
      activity,
      existingCompanies,
    // DB Logic - DB logics
    ] = await Promise.all([
      Company.aggregate([
        {
          $match: {
            createdAt: {
              $gte: start,
            },

            archivedAt: null,
          },
        },
        {
          $group: {
            _id: {
              year: {
                $year: "$createdAt",
              },

              month: {
                $month: "$createdAt",
              },
            },

            newCompanies: {
              $sum: 1,
            },
          },
        },
        {
          $sort: {
            "_id.year": 1,
            "_id.month": 1,
          },
        },
      ]),

      User.aggregate([
        {
          $match: {
            companyId: {
              $ne: null,
            },

            createdAt: {
              $gte: start,
            },
          },
        },
        {
          $group: {
            _id: {
              year: {
                $year: "$createdAt",
              },

              month: {
                $month: "$createdAt",
              },
            },

            newUsers: {
              $sum: 1,
            },

            activeUsers: {
              $sum: {
                $cond: [
                  {
                    $eq: ["$status", "ACTIVE"],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
        {
          $sort: {
            "_id.year": 1,
            "_id.month": 1,
          },
        },
      ]),

      Subscription.aggregate([
        {
          $group: {
            _id: "$plan",

            count: {
              $sum: 1,
            },
          },
        },
        {
          $sort: {
            count: -1,
          },
        },
      ]),

      Payment.aggregate([
        {
          $match: {
            status: "SUCCESS",

            createdAt: {
              $gte: start,
            },
          },
        },
        {
          $group: {
            _id: {
              year: {
                $year: "$createdAt",
              },

              month: {
                $month: "$createdAt",
              },
            },

            revenue: {
              $sum: "$amount",
            },
          },
        },
        {
          $sort: {
            "_id.year": 1,
            "_id.month": 1,
          },
        },
      ]),

      Company.aggregate([
        {
          $match: {
            archivedAt: null,
          },
        },
        {
          $group: {
            _id: "$status",

            count: {
              $sum: 1,
            },
          },
        },
      ]),

      UsageMetric.aggregate([
        {
          $match: {
            date: {
              $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
                .toISOString()
                .slice(0, 10),
            },
          },
        },
        {
          $group: {
            _id: null,

            daily: {
              $addToSet: "$activeUserIds",
            },

            apiRequests: {
              $sum: "$apiRequests",
            },
          },
        },
      ]),

      Company.countDocuments({
        createdAt: {
          $lt: start,
        },

        archivedAt: null,
      }),
    ]);

    let runningCompanies = existingCompanies;

    const months = [];

    for (let index = 0; index < 12; index += 1) {
      const date = new Date(start.getFullYear(), start.getMonth() + index, 1);

      const companyRow = companyGrowth.find(
        (row) =>
          row._id.year === date.getFullYear() &&
          row._id.month === date.getMonth() + 1,
      );

      const userRow = userGrowth.find(
        (row) =>
          row._id.year === date.getFullYear() &&
          row._id.month === date.getMonth() + 1,
      );

      const revenueRow = revenueTrend.find(
        (row) =>
          row._id.year === date.getFullYear() &&
          row._id.month === date.getMonth() + 1,
      );

      runningCompanies += companyRow?.newCompanies || 0;

      months.push({
        label: date.toLocaleString("en-IN", {
          month: "short",
        }),

        newCompanies: companyRow?.newCompanies || 0,

        totalCompanies: runningCompanies,

        newUsers: userRow?.newUsers || 0,

        activeUsers: userRow?.activeUsers || 0,

        revenue: revenueRow?.revenue || 0,
      });
    }

    const activeUsers = new Set((activity[0]?.daily || []).flat().map(String))
      .size;

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        months,

        subscriptions: subscriptionDistribution.map((row) => ({
          label: row._id,
          value: row.count,
        })),

        companyStatus: companyStatus.map((row) => ({
          label: row._id,
          value: row.count,
        })),

        activity: {
          dailyActive: activeUsers,

          apiRequests30d: activity[0]?.apiRequests || 0,
        },
      },
      "Platform charts",
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};
