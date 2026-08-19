import mongoose from 'mongoose';
import User from '../models/User.js';
import Company from '../models/Company.js';
import UsageMetric from '../models/UsageMetric.js';
import Document from '../models/Document.js';
import SupportTicket from '../models/SupportTicket.js';
import AuditLog from '../models/AuditLog.js';
import PlatformSettings from '../models/PlatformSettings.js';
import SystemEvent from '../models/SystemEvent.js';
import AdminSession from '../models/AdminSession.js';
import {
  getPlan,
  usagePercent,
} from '../utils/platformPlans.js';

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

const escapeRegex = (value = '') =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const auditAction = async (
  req,
  action,
  targetCompany = null,
  previousValue = null,
  newValue = null
) => {
  try {
    await AuditLog.create({
      companyId: null,
      actor: req.user._id,
      actorName: req.user.name,
      actorRole: req.user.role,
      action,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      statusCode: 200,
      ip: req.ip || '',
      targetCompany,
      targetType: 'Platform',
      previousValue,
      newValue,
    });
  } catch {
    // Audit is best effort.
  }
};

// ============================================================
// PLATFORM USERS
// ============================================================

export const platformUsers = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));
    const match = { companyId: { $ne: null } };

    if (req.query.role && req.query.role !== 'ALL') {
      match.role = req.query.role;
    }

    if (req.query.status && req.query.status !== 'ALL') {
      match.status = req.query.status;
    }

    if (
      req.query.companyId &&
      mongoose.Types.ObjectId.isValid(req.query.companyId)
    ) {
      match.companyId = req.query.companyId;
    }

    if (req.query.search?.trim()) {
      const search = new RegExp(
        escapeRegex(req.query.search.trim()),
        'i'
      );

      match.$or = [
        { name: search },
        { email: search },
        { employeeCode: search },
      ];
    }

    const [rows, total] = await Promise.all([
      User.find(match)
        .select(
          'name email role status companyId designation ' +
            'employeeCode lastLogin createdAt'
        )
        .populate('companyId', 'name code')
        .sort('-createdAt')
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      User.countDocuments(match),
    ]);

    return ok(
      res,
      200,
      {
        rows,
        meta: {
          page,
          limit,
          total,
          pages: Math.max(1, Math.ceil(total / limit)),
        },
      },
      'Platform users'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// USAGE MONITORING
// ============================================================

export const usage = async (req, res) => {
  try {
    const monthStart = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      1
    )
      .toISOString()
      .slice(0, 10);

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));
    const companyMatch = { archivedAt: null };

    if (
      req.query.companyId &&
      mongoose.Types.ObjectId.isValid(req.query.companyId)
    ) {
      companyMatch._id = new mongoose.Types.ObjectId(
        req.query.companyId
      );
    }

    const [companies, total] = await Promise.all([
      Company.find(companyMatch)
        .select('name code subscription status')
        .populate('subscription')
        .sort('name')
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      Company.countDocuments(companyMatch),
    ]);

    const companyIds = companies.map((company) => company._id);

    const [userRows, metricRows, storageRows] =
      await Promise.all([
        User.aggregate([
          { $match: { companyId: { $in: companyIds } } },
          {
            $group: {
              _id: '$companyId',
              total: { $sum: 1 },
              active: {
                $sum: {
                  $cond: [{ $eq: ['$status', 'ACTIVE'] }, 1, 0],
                },
              },
            },
          },
        ]),

        UsageMetric.aggregate([
          {
            $match: {
              companyId: { $in: companyIds },
              date: { $gte: monthStart },
            },
          },
          {
            $group: {
              _id: '$companyId',
              apiRequests: { $sum: '$apiRequests' },
              fileUploads: { $sum: '$fileUploads' },
              moduleRows: { $push: '$moduleUsage' },
            },
          },
        ]),

        Document.aggregate([
          { $match: { companyId: { $in: companyIds } } },
          {
            $group: {
              _id: '$companyId',
              storageBytes: { $sum: '$size' },
              files: { $sum: 1 },
            },
          },
        ]),
      ]);

    const byId = (rows) =>
      Object.fromEntries(
        rows.map((row) => [String(row._id), row])
      );

    const userMap = byId(userRows);
    const metricMap = byId(metricRows);
    const storageMap = byId(storageRows);
    const rows = [];

    for (const company of companies) {
      const id = String(company._id);
      const plan = await getPlan(
        company.subscription?.plan || 'TRIAL'
      );
      const users = userMap[id] || {};
      const metrics = metricMap[id] || {};
      const storage = storageMap[id] || {};
      const moduleUsage = {};

      (metrics.moduleRows || []).forEach((moduleRow) => {
        Object.entries(moduleRow || {}).forEach(
          ([moduleName, count]) => {
            moduleUsage[moduleName] =
              (moduleUsage[moduleName] || 0) +
              Number(count || 0);
          }
        );
      });

      const employeeLimit =
        plan?.limits?.employees ||
        company.subscription?.limits?.employees ||
        0;

      const storageLimitBytes =
        (plan?.limits?.storageMB ||
          company.subscription?.limits?.storageMB ||
          0) *
        1024 *
        1024;

      const apiLimit =
        plan?.limits?.apiRequestsMonthly ||
        company.subscription?.limits?.apiRequestsMonthly ||
        0;

      rows.push({
        company: {
          id: company._id,
          name: company.name,
          code: company.code,
          status: company.status,
        },
        plan: company.subscription?.plan || 'TRIAL',
        users: {
          used: users.total || 0,
          active: users.active || 0,
          limit: employeeLimit,
        },
        storage: {
          usedBytes: storage.storageBytes || 0,
          files: storage.files || 0,
          limitBytes: storageLimitBytes,
        },
        api: {
          used: metrics.apiRequests || 0,
          limit: apiLimit,
        },
        fileUploads: metrics.fileUploads || 0,
        percentages: {
          users: usagePercent(users.total, employeeLimit),
          storage: usagePercent(
            storage.storageBytes,
            storageLimitBytes
          ),
          api: usagePercent(metrics.apiRequests, apiLimit),
        },
        moduleUsage,
        enabledModules:
          company.subscription?.enabledModules?.length
            ? company.subscription.enabledModules
            : plan?.enabledModules || [],
      });
    }

    const alerts = rows.flatMap((row) => {
      const items = [];

      if (row.percentages.storage >= 90) {
        items.push({
          type: 'STORAGE_LIMIT',
          metric: 'storage',
          percent: row.percentages.storage,
        });
      }

      if (
        row.percentages.api >= 90 ||
        row.percentages.users >= 90
      ) {
        items.push({
          type: 'HIGH_USAGE',
          metric:
            row.percentages.api >= 90 ? 'api' : 'users',
          percent: Math.max(
            row.percentages.api,
            row.percentages.users
          ),
        });
      }

      return items.map((item) =>
        SystemEvent.updateOne(
          {
            type: item.type,
            companyId: row.company.id,
            resolvedAt: null,
            'metadata.metric': item.metric,
          },
          {
            $set: {
              level: 'WARNING',
              title: `${item.metric} usage is high`,
              message: `${item.percent}% of the plan limit is used`,
              targetType: 'UsageMetric',
              metadata: item,
            },
          },
          { upsert: true }
        )
      );
    });

    await Promise.all(alerts);

    const adoption = {};

    rows.forEach((row) => {
      Object.entries(row.moduleUsage).forEach(
        ([moduleName, count]) => {
          if (count > 0) {
            adoption[moduleName] =
              (adoption[moduleName] || 0) + 1;
          }
        }
      );
    });

    return ok(
      res,
      200,
      {
        rows,
        featureAdoption: Object.entries(adoption)
          .map(([moduleName, companiesUsing]) => ({
            moduleName,
            companiesUsing,
          }))
          .sort((first, second) =>
            second.companiesUsing - first.companiesUsing
          ),
        meta: {
          page,
          limit,
          total,
          pages: Math.max(1, Math.ceil(total / limit)),
        },
      },
      'Usage monitoring'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// SUPPORT
// ============================================================

export const support = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));
    const match = {};

    if (req.query.status && req.query.status !== 'ALL') {
      match.status = req.query.status;
    }

    if (req.query.priority && req.query.priority !== 'ALL') {
      match.priority = req.query.priority;
    }

    if (
      req.query.companyId &&
      mongoose.Types.ObjectId.isValid(req.query.companyId)
    ) {
      match.companyId = req.query.companyId;
    }

    const [rows, total, counts] = await Promise.all([
      SupportTicket.find(match)
        .populate('companyId', 'name code')
        .populate('user', 'name email role')
        .populate('assignedSupportAgent', 'name email')
        .sort('-createdAt')
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      SupportTicket.countDocuments(match),

      SupportTicket.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    return ok(
      res,
      200,
      {
        rows,
        counts,
        meta: {
          page,
          limit,
          total,
          pages: Math.max(1, Math.ceil(total / limit)),
        },
      },
      'Support tickets'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

export const updateSupport = async (req, res) => {
  try {
    const ticket = await SupportTicket.findById(
      req.params.ticketId
    );

    if (!ticket) {
      return fail(res, 404, 'Ticket not found');
    }

    const previous = ticket.toObject();

    const statuses = [
      'OPEN',
      'IN_PROGRESS',
      'WAITING_FOR_CUSTOMER',
      'RESOLVED',
      'CLOSED',
    ];

    const priorities = [
      'LOW',
      'MEDIUM',
      'HIGH',
      'CRITICAL',
    ];

    if (
      req.body.status &&
      !statuses.includes(req.body.status)
    ) {
      return fail(res, 400, 'Invalid support status');
    }

    if (
      req.body.priority &&
      !priorities.includes(req.body.priority)
    ) {
      return fail(res, 400, 'Invalid priority');
    }

    if (req.body.status) ticket.status = req.body.status;
    if (req.body.priority) ticket.priority = req.body.priority;

    if (req.body.assignedSupportAgent !== undefined) {
      ticket.assignedSupportAgent =
        req.body.assignedSupportAgent || null;
    }

    if (req.body.platformNote !== undefined) {
      ticket.platformNote = req.body.platformNote;
    }

    await ticket.save();

    if (
      ticket.priority === 'CRITICAL' &&
      previous.priority !== 'CRITICAL'
    ) {
      await SystemEvent.create({
        type: 'CRITICAL_TICKET',
        level: 'CRITICAL',
        title: 'Critical support ticket',
        message: ticket.subject,
        companyId: ticket.companyId,
        targetType: 'SupportTicket',
        targetId: ticket._id,
      });
    }

    await auditAction(
      req,
      'PLATFORM_SUPPORT_TICKET_UPDATED',
      ticket.companyId,
      previous,
      ticket.toObject()
    );

    return ok(res, 200, ticket, 'Support ticket updated');
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// SYSTEM HEALTH
// ============================================================

export const health = async (req, res) => {
  try {
    const databaseConnected =
      mongoose.connection.readyState === 1;

    const checks = {
      backend: {
        status: 'HEALTHY',
        message: 'API is responding',
      },
      database: {
        status: databaseConnected ? 'HEALTHY' : 'DOWN',
        message: databaseConnected
          ? 'MongoDB connected'
          : 'MongoDB disconnected',
      },
      authentication: {
        status: process.env.JWT_SECRET
          ? 'HEALTHY'
          : 'WARNING',
        message: process.env.JWT_SECRET
          ? 'JWT configured'
          : 'JWT is not configured',
      },
      storage: {
        status: process.env.CLOUDINARY_CLOUD_NAME
          ? 'HEALTHY'
          : 'WARNING',
        message: process.env.CLOUDINARY_CLOUD_NAME
          ? 'Cloudinary configured'
          : 'Cloud storage not configured',
      },
      email: {
        status: process.env.SMTP_HOST
          ? 'HEALTHY'
          : 'WARNING',
        message: process.env.SMTP_HOST
          ? 'SMTP configured'
          : 'Mailer running in mock mode',
      },
      payment: {
        status: process.env.RAZORPAY_KEY_ID
          ? 'HEALTHY'
          : 'WARNING',
        message: process.env.RAZORPAY_KEY_ID
          ? 'Payment gateway configured'
          : 'Payment gateway running in mock mode',
      },
    };

    const overall = Object.values(checks).some(
      (check) => check.status === 'DOWN'
    )
      ? 'DOWN'
      : Object.values(checks).some(
            (check) => check.status === 'WARNING'
          )
        ? 'WARNING'
        : 'HEALTHY';

    return ok(
      res,
      200,
      {
        overall,
        checks,
        checkedAt: new Date(),
      },
      'System health'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// AUDIT LOGS
// ============================================================

export const auditLogs = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));
    const match = {};

    if (
      req.query.companyId &&
      mongoose.Types.ObjectId.isValid(req.query.companyId)
    ) {
      match.$or = [
        { companyId: req.query.companyId },
        { targetCompany: req.query.companyId },
      ];
    }

    if (req.query.action) {
      match.action = new RegExp(
        escapeRegex(req.query.action),
        'i'
      );
    }

    const [rows, total] = await Promise.all([
      AuditLog.find(match)
        .populate('actor', 'name email role')
        .populate('targetCompany', 'name code')
        .sort('-createdAt')
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      AuditLog.countDocuments(match),
    ]);

    return ok(
      res,
      200,
      {
        rows,
        meta: {
          page,
          limit,
          total,
          pages: Math.max(1, Math.ceil(total / limit)),
        },
      },
      'Immutable audit logs'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// SETTINGS
// ============================================================

export const getSettings = async (req, res) => {
  try {
    const settings =
      await PlatformSettings.findOneAndUpdate(
        { key: 'GLOBAL' },
        {
          $setOnInsert: {
            key: 'GLOBAL',
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      ).lean();

    return ok(res, 200, settings, 'Platform settings');
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

export const updateSettings = async (req, res) => {
  try {
    const previous = await PlatformSettings.findOne({
      key: 'GLOBAL',
    }).lean();

    const update = {};

    [
      'platform',
      'subscription',
      'notifications',
      'security',
    ].forEach((section) => {
      if (!req.body[section]) return;

      Object.entries(req.body[section]).forEach(
        ([key, value]) => {
          update[`${section}.${key}`] = value;
        }
      );
    });

    update.updatedBy = req.user._id;

    const settings =
      await PlatformSettings.findOneAndUpdate(
        { key: 'GLOBAL' },
        {
          $set: update,
          $setOnInsert: {
            key: 'GLOBAL',
          },
        },
        {
          upsert: true,
          new: true,
          runValidators: true,
        }
      );

    await auditAction(
      req,
      'PLATFORM_SETTINGS_UPDATED',
      null,
      previous,
      settings.toObject()
    );

    return ok(
      res,
      200,
      settings,
      'Platform settings updated'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// NOTIFICATIONS
// ============================================================

export const notifications = async (req, res) => {
  try {
    const match =
      req.query.unread === 'true'
        ? {
            readBy: {
              $ne: req.user._id,
            },
          }
        : {};

    const [rows, unread] = await Promise.all([
      SystemEvent.find(match)
        .populate('companyId', 'name code')
        .sort('-createdAt')
        .limit(100)
        .lean(),

      SystemEvent.countDocuments({
        readBy: {
          $ne: req.user._id,
        },
      }),
    ]);

    return ok(
      res,
      200,
      { rows, unread },
      'Platform notifications'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

export const markNotification = async (req, res) => {
  try {
    await SystemEvent.updateOne(
      { _id: req.params.eventId },
      {
        $addToSet: {
          readBy: req.user._id,
        },
      }
    );

    return ok(res, 200, {}, 'Notification marked read');
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

export const markAllNotifications = async (req, res) => {
  try {
    await SystemEvent.updateMany(
      {
        readBy: {
          $ne: req.user._id,
        },
      },
      {
        $addToSet: {
          readBy: req.user._id,
        },
      }
    );

    return ok(res, 200, {}, 'All notifications marked read');
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// PLATFORM ADMINISTRATORS
// ============================================================

export const platformAdmins = async (req, res) => {
  try {
    const roles = [
      'SUPER_ADMIN',
      'PLATFORM_ADMIN',
      'SUPPORT_ADMIN',
      'BILLING_ADMIN',
    ];

    const [rows, sessions] = await Promise.all([
      User.find({
        companyId: null,
        role: { $in: roles },
      })
        .select(
          'name email role status platformPermissions ' +
            'twoFactorEnabled lastLogin createdAt'
        )
        .lean(),

      AdminSession.aggregate([
        {
          $match: {
            revokedAt: null,
            expiresAt: { $gt: new Date() },
          },
        },
        {
          $group: {
            _id: '$user',
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const sessionMap = Object.fromEntries(
      sessions.map((row) => [
        String(row._id),
        row.count,
      ])
    );

    return ok(
      res,
      200,
      rows.map((row) => ({
        ...row,
        activeSessions:
          sessionMap[String(row._id)] || 0,
      })),
      'Platform administrators'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};