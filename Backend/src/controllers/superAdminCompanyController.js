import crypto from 'crypto';
import mongoose from 'mongoose';
import Company from '../models/Company.js';
import User from '../models/User.js';
import Subscription from '../models/Subscription.js';
import Payment from '../models/Payment.js';
import Document from '../models/Document.js';
import SupportTicket from '../models/SupportTicket.js';
import AuditLog from '../models/AuditLog.js';
import UsageMetric from '../models/UsageMetric.js';
import { getPlan } from '../utils/platformPlans.js';
import { sendMail } from '../utils/mailer.js';

const ok = (res, status, data, message) =>
  res.status(status).json({ statusCode: status, success: true, data, message });

const fail = (res, status, message) =>
  res.status(status).json({ statusCode: status, success: false, message });

const escapeRegex = (value = '') =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const audit = async (
  req,
  action,
  companyId,
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
      targetCompany: companyId,
      targetType: 'Company',
      targetId: companyId,
      previousValue,
      newValue,
    });
  } catch {
    // Audit failure must never block the main workflow.
  }
};

const generateCompanyCode = async (name) => {
  const base =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 12) || 'company';

  let code = base;
  let suffix = 1;

  while (await Company.exists({ code })) {
    code = `${base}${suffix}`;
    suffix += 1;
  }

  return code;
};

// ============================================================
// GET /api/super-admin/companies
// Server-side search, filtering, sorting and pagination.
// ============================================================

export const listCompanies = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));

    const allowedSortFields = ['name', 'createdAt', 'status', 'code'];
    const sortBy = allowedSortFields.includes(req.query.sortBy)
      ? req.query.sortBy
      : 'createdAt';
    const sortDirection = req.query.sortDir === 'asc' ? 1 : -1;

    const match = { archivedAt: null };

    if (req.query.search?.trim()) {
      const search = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      match.$or = [{ name: search }, { code: search }, { email: search }];
    }

    if (req.query.status && req.query.status !== 'ALL') {
      match.status = req.query.status;
    }

    if (req.query.createdFrom || req.query.createdTo) {
      match.createdAt = {};

      if (req.query.createdFrom) {
        match.createdAt.$gte = new Date(req.query.createdFrom);
      }

      if (req.query.createdTo) {
        match.createdAt.$lte = new Date(
          `${req.query.createdTo}T23:59:59.999Z`
        );
      }
    }

    const basePipeline = [
      { $match: match },
      {
        $lookup: {
          from: 'subscriptions',
          localField: 'subscription',
          foreignField: '_id',
          as: 'subscriptionDoc',
        },
      },
      {
        $set: {
          subscriptionDoc: { $arrayElemAt: ['$subscriptionDoc', 0] },
        },
      },
    ];

    if (req.query.plan && req.query.plan !== 'ALL') {
      basePipeline.push({
        $match: { 'subscriptionDoc.plan': req.query.plan },
      });
    }

    if (
      req.query.subscriptionStatus &&
      req.query.subscriptionStatus !== 'ALL'
    ) {
      basePipeline.push({
        $match: {
          'subscriptionDoc.status': req.query.subscriptionStatus,
        },
      });
    }

    // DB Logic - DB logics
    const [rows, countRows] = await Promise.all([
      Company.aggregate([
        ...basePipeline,
        { $sort: { [sortBy]: sortDirection } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: 'companyId',
            as: 'users',
          },
        },
        {
          $lookup: {
            from: 'documents',
            localField: '_id',
            foreignField: 'companyId',
            as: 'documents',
          },
        },
        {
          $project: {
            name: 1,
            code: 1,
            email: 1,
            phone: 1,
            status: 1,
            createdAt: 1,
            plan: { $ifNull: ['$subscriptionDoc.plan', 'TRIAL'] },
            subscriptionStatus: {
              $ifNull: ['$subscriptionDoc.status', 'TRIAL'],
            },
            subscriptionStart: '$subscriptionDoc.startDate',
            subscriptionEnd: '$subscriptionDoc.endDate',

            employeeCount: {
              $size: {
                $filter: {
                  input: '$users',
                  as: 'user',
                  cond: {
                    $and: [
                      { $eq: ['$$user.status', 'ACTIVE'] },
                      { $eq: ['$$user.role', 'EMPLOYEE'] },
                    ],
                  },
                },
              },
            },

            userCount: { $size: '$users' },
            lastLogin: { $max: '$users.lastLogin' },
            storageBytes: { $sum: '$documents.size' },
          },
        },
      ]),

      Company.aggregate([...basePipeline, { $count: 'total' }]),
    ]);

    const total = countRows[0]?.total || 0;

    return ok(
      // Data to frontend - response to frontend
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
      'Companies'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// GET /api/super-admin/companies/:companyId
// ============================================================

export const companyDetail = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const { companyId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      return fail(res, 400, 'Invalid company id');
    }

    // DB Logic - DB logics
    const company = await Company.findById(companyId)
      .populate('subscription')
      .lean();

    if (!company || company.archivedAt) {
      return fail(res, 404, 'Company not found');
    }

    const [userStats, users, storage, usageRows, payments, tickets, audits] =
      await Promise.all([
        User.aggregate([
          { $match: { companyId: company._id } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              active: {
                $sum: {
                  $cond: [{ $eq: ['$status', 'ACTIVE'] }, 1, 0],
                },
              },
              inactive: {
                $sum: {
                  $cond: [{ $ne: ['$status', 'ACTIVE'] }, 1, 0],
                },
              },
              employees: {
                $sum: {
                  $cond: [{ $eq: ['$role', 'EMPLOYEE'] }, 1, 0],
                },
              },
              managers: {
                $sum: {
                  $cond: [{ $eq: ['$role', 'MANAGER'] }, 1, 0],
                },
              },
              teamLeads: {
                $sum: {
                  $cond: [{ $eq: ['$role', 'TEAM_LEAD'] }, 1, 0],
                },
              },
              hrManagers: {
                $sum: {
                  $cond: [{ $eq: ['$role', 'HR_MANAGER'] }, 1, 0],
                },
              },
              companyAdmins: {
                $sum: {
                  $cond: [{ $eq: ['$role', 'COMPANY_ADMIN'] }, 1, 0],
                },
              },
              lastLogin: { $max: '$lastLogin' },
            },
          },
        ]),

        // Only non-sensitive user fields are returned.
        User.find({ companyId: company._id })
          .select('name email role status designation lastLogin createdAt')
          .sort('-lastLogin')
          .limit(100)
          .lean(),

        Document.aggregate([
          { $match: { companyId: company._id } },
          {
            $group: {
              _id: null,
              bytes: { $sum: '$size' },
              files: { $sum: 1 },
            },
          },
        ]),

        UsageMetric.find({ companyId: company._id })
          .sort('-date')
          .limit(30)
          .lean(),

        Payment.find({ companyId: company._id })
          .sort('-createdAt')
          .limit(50)
          .lean(),

        SupportTicket.find({ companyId: company._id })
          .select('subject category priority status createdAt updatedAt')
          .sort('-createdAt')
          .limit(25)
          .lean(),

        AuditLog.find({
          $or: [
            { companyId: company._id },
            { targetCompany: company._id },
          ],
        })
          .select('-previousValue -newValue')
          .sort('-createdAt')
          .limit(50)
          .lean(),
      ]);

    const metrics = usageRows.reduce(
      (result, row) => {
        result.apiRequests += row.apiRequests || 0;

        (row.activeUserIds || []).forEach((userId) => {
          result.activeUsers.add(String(userId));
        });

        const modules =
          row.moduleUsage instanceof Map
            ? Object.fromEntries(row.moduleUsage)
            : row.moduleUsage || {};

        Object.entries(modules).forEach(([moduleName, count]) => {
          result.moduleUsage[moduleName] =
            (result.moduleUsage[moduleName] || 0) + Number(count || 0);
        });

        return result;
      },
      {
        apiRequests: 0,
        activeUsers: new Set(),
        moduleUsage: {},
      }
    );

    const stats = userStats[0] || {
      total: 0,
      active: 0,
      inactive: 0,
      employees: 0,
      managers: 0,
      teamLeads: 0,
      hrManagers: 0,
      companyAdmins: 0,
      lastLogin: null,
    };

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        overview: {
          id: company._id,
          name: company.name,
          code: company.code,
          status: company.status,
          plan: company.subscription?.plan || 'TRIAL',
          subscriptionStatus: company.subscription?.status || 'TRIAL',
          employees: stats.employees || 0,
          users: stats.total || 0,
          storageBytes: storage[0]?.bytes || 0,
          lastLogin: stats.lastLogin || null,
          apiRequests: metrics.apiRequests,
          createdAt: company.createdAt,
        },

        company: {
          name: company.name,
          code: company.code,
          logoUrl: company.logoUrl,
          email: company.email,
          phone: company.phone,
          address: company.address,
          country: company.country,
          timezone: company.timezone,
          currency: company.currency,
          industry: company.industry,
          platformNotes: company.platformNotes,
          createdAt: company.createdAt,
        },

        subscription: company.subscription,
        userStats: stats,
        users,

        usage: {
          apiRequests: metrics.apiRequests,
          activeUsers: metrics.activeUsers.size,
          storageBytes: storage[0]?.bytes || 0,
          files: storage[0]?.files || 0,
          moduleUsage: metrics.moduleUsage,
        },

        payments,
        tickets,
        audits,
      },
      'Company detail'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// POST /api/super-admin/companies
// Company + subscription + Company Admin transaction.
// ============================================================

export const createCompany = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      name,
      email,
      adminName,
      adminEmail,
      plan: requestedPlan = 'TRIAL',
    } = req.body;

    const planKey = String(requestedPlan).toUpperCase();

    if (!name?.trim() || !adminName?.trim() || !adminEmail?.trim()) {
      await session.abortTransaction();

      return fail(
        res,
        400,
        'Company name, admin name and admin email are required'
      );
    }

    // DB Logic - DB logics
    const plan = await getPlan(planKey);

    if (!plan) {
      await session.abortTransaction();
      return fail(res, 400, 'Invalid subscription plan');
    }

    const code =
      // Data from frontend - requests from frontend
      req.body.code?.trim().toLowerCase() ||
      (await generateCompanyCode(name));

    if (await Company.exists({ code })) {
      await session.abortTransaction();
      return fail(res, 409, 'Company code already exists');
    }

    const [company] = await Company.create(
      [
        {
          name: name.trim(),
          code,
          email: String(email || adminEmail).toLowerCase(),
          phone: req.body.phone || '',
          country: req.body.country || 'India',
          timezone: req.body.timezone || 'Asia/Kolkata',
          currency: req.body.currency || 'INR',
          industry: req.body.industry || '',
          status: 'ACTIVE',
        },
      ],
      { session }
    );

    const now = new Date();
    const trialDays = Number(req.body.trialDays) || 14;
    const durationDays = planKey === 'TRIAL' ? trialDays : 30;
    const endDate = new Date(
      now.getTime() + durationDays * 24 * 60 * 60 * 1000
    );

    const [subscription] = await Subscription.create(
      [
        {
          company: company._id,
          plan: plan.key || planKey,
          planRef: plan._id || null,
          status: planKey === 'TRIAL' ? 'TRIAL' : 'ACTIVE',
          startDate: now,
          endDate,
          trialEndDate: planKey === 'TRIAL' ? endDate : null,
          renewalDate: endDate,
          limits: plan.limits,
          enabledModules: plan.enabledModules || [],
        },
      ],
      { session }
    );

    company.subscription = subscription._id;
    await company.save({ session });

    const temporaryPassword =
      `${crypto.randomBytes(8).toString('base64url')}A1!`;

    const [admin] = await User.create(
      [
        {
          name: adminName.trim(),
          email: adminEmail.toLowerCase().trim(),
          password: temporaryPassword,
          role: 'COMPANY_ADMIN',
          companyId: company._id,
        },
      ],
      { session }
    );

    await session.commitTransaction();

    await audit(req, 'PLATFORM_COMPANY_CREATED', company._id, null, {
      name: company.name,
      code,
      plan: subscription.plan,
    });

    // Email is best effort and cannot roll back the company.
    try {
      await sendMail({
        to: admin.email,
        subject: 'Your Crewly company account',
        text:
          `Company code: ${code}\n` +
          `Email: ${admin.email}\n` +
          `Temporary password: ${temporaryPassword}\n` +
          'Please change it after signing in.',
      });
    } catch {
      // Mailer failure does not block company creation.
    }

    return ok(
      // Data to frontend - response to frontend
      res,
      201,
      {
        id: company._id,
        code,
        adminEmail: admin.email,
      },
      'Company created'
    );
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }

    const duplicate = error.code === 11000;

    return fail(
      res,
      duplicate ? 409 : 500,
      duplicate
        ? 'Company or admin already exists'
        : error.message
    );
  } finally {
    session.endSession();
  }
};

// ============================================================
// PATCH /api/super-admin/companies/:companyId
// ============================================================

export const updateCompany = async (req, res) => {
  try {
    // DB Logic - DB logics
    const company = await Company.findById(req.params.companyId);

    if (!company || company.archivedAt) {
      return fail(res, 404, 'Company not found');
    }

    const previous = company.toObject();

    const allowedFields = [
      'name',
      'email',
      'phone',
      'logoUrl',
      'country',
      'timezone',
      'currency',
      'industry',
      'platformNotes',
    ];

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        company[field] = req.body[field];
      }
    });

    // Data from frontend - requests from frontend
    if (req.body.address) {
      const currentAddress =
        typeof company.address?.toObject === 'function'
          ? company.address.toObject()
          : company.address || {};

      company.address = {
        ...currentAddress,
        ...req.body.address,
      };
    }

    await company.save();

    await audit(
      req,
      'PLATFORM_COMPANY_UPDATED',
      company._id,
      previous,
      company.toObject()
    );

    // Data to frontend - response to frontend
    return ok(res, 200, company, 'Company information updated');
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// PATCH /api/super-admin/companies/:companyId/status
// ============================================================

export const setCompanyStatus = async (req, res) => {
  try {
    const allowedStatuses = [
      'ACTIVE',
      'SUSPENDED',
      'DEACTIVATED',
    ];

    // Data from frontend - requests from frontend
    if (!allowedStatuses.includes(req.body.status)) {
      return fail(
        res,
        400,
        `Status must be ${allowedStatuses.join(', ')}`
      );
    }

    // DB Logic - DB logics
    const company = await Company.findById(req.params.companyId);

    if (!company || company.archivedAt) {
      return fail(res, 404, 'Company not found');
    }

    const previousStatus = company.status;
    company.status = req.body.status;

    await company.save();

    await audit(
      req,
      `PLATFORM_COMPANY_${company.status}`,
      company._id,
      { status: previousStatus },
      { status: company.status }
    );

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        id: company._id,
        status: company.status,
      },
      `Company is now ${company.status}`
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// DELETE /api/super-admin/companies/:companyId
// Archive only — customer records are preserved.
// ============================================================

export const archiveCompany = async (req, res) => {
  try {
    // DB Logic - DB logics
    const company = await Company.findById(req.params.companyId);

    if (!company || company.archivedAt) {
      return fail(res, 404, 'Company not found');
    }

    company.status = 'ARCHIVED';
    company.archivedAt = new Date();

    await company.save();

    await audit(
      // Data from frontend - requests from frontend
      req,
      'PLATFORM_COMPANY_ARCHIVED',
      company._id,
      null,
      { archivedAt: company.archivedAt }
    );

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      { id: company._id },
      'Company archived. Customer data was not deleted.'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};

// ============================================================
// GET /api/super-admin/search?q=
// ============================================================

export const globalSearch = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const query = String(req.query.q || '').trim();

    if (query.length < 2) {
      return ok(
        res,
        200,
        {
          companies: [],
          users: [],
          subscriptions: [],
          payments: [],
          tickets: [],
        },
        'Search'
      );
    }

    const regex = new RegExp(escapeRegex(query), 'i');

    const objectIds = mongoose.Types.ObjectId.isValid(query)
      ? [new mongoose.Types.ObjectId(query)]
      : [];

    const [companies, users, subscriptions, payments, tickets] =
      // DB Logic - DB logics
      await Promise.all([
        Company.find({
          archivedAt: null,
          $or: [{ name: regex }, { code: regex }, { email: regex }],
        })
          .select('name code email status')
          .limit(10)
          .lean(),

        User.find({
          companyId: { $ne: null },
          $or: [
            { name: regex },
            { email: regex },
            { employeeCode: regex },
          ],
        })
          .select('name email role status companyId')
          .limit(10)
          .lean(),

        Subscription.find({
          $or: [
            { plan: regex },
            { status: regex },
            ...(objectIds.length
              ? [{ company: { $in: objectIds } }]
              : []),
          ],
        })
          .select('company plan status endDate')
          .limit(10)
          .lean(),

        Payment.find({
          $or: [
            { orderId: regex },
            { gatewayPaymentId: regex },
          ],
        })
          .select('companyId plan amount status createdAt')
          .limit(10)
          .lean(),

        SupportTicket.find({
          $or: [{ subject: regex }, { message: regex }],
        })
          .select('companyId subject priority status createdAt')
          .limit(10)
          .lean(),
      ]);

    return ok(
      // Data to frontend - response to frontend
      res,
      200,
      {
        companies,
        users,
        subscriptions,
        payments,
        tickets,
      },
      'Global search'
    );
  } catch (error) {
    return fail(res, 500, error.message);
  }
};