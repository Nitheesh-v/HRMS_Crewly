// ─────────────────────────────────────────────────────────────
// User controller — user CRUD inside a company.
//
// ⚠️ RESPONSE CONTRACTS (frontend pages depend on these — do NOT
//    change the shape, only add fields inside objects):
//   GET /users  → data: [ user, ... ]          (+ meta at body level)
//   GET /users/:id → data: user
//   POST /users → data: { user }
// ─────────────────────────────────────────────────────────────
import User from '../models/User.js';
import Department from '../models/Department.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { CREATION_RIGHTS } from '../utils/constants.js';
import { sendMail, welcomeEmail } from '../utils/mailer.js';
import { notifyUser } from '../utils/notify.js';
import Subscription from '../models/Subscription.js';
import { scopedUserFilter } from '../utils/scope.js';


// Payroll/statutory fields allowed through create/update
const DETAIL_FIELDS = [
  'employeeCode', 'designation', 'dateOfBirth', 'dateOfJoining',
  'pan', 'uan', 'esic', 'bankAccount', 'ifsc',
];

const canManage = (actorRole, targetRole) =>
  (CREATION_RIGHTS[actorRole] || []).includes(targetRole);

// '' clears a field; date fields become null, text fields become ''
const pickDetails = (body) => {
  const out = {};
  DETAIL_FIELDS.forEach((f) => {
    if (body[f] === undefined) return;
    out[f] = body[f] === '' || body[f] === null ? (f.startsWith('date') ? null : '') : body[f];
  });
  return out;
};

// GET /api/users — filters + pagination
// data = ARRAY of users (PayrollPage/ProjectsPage read res.data directly!)
export const listUsers = asyncHandler(async (req, res) => {
  const { search, role, department, status } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Number(req.query.limit) || 10);

  const filter = { companyId: req.companyId };
    const __scope = await scopedUserFilter(req);
  if (__scope) filter._id = __scope;
  if (role) filter.role = role;
  if (department) filter.department = department;
  if (status) filter.status = status;
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .select('-password')
      .populate('department', 'name')
      .populate('reportingTo', 'name role')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit),
    User.countDocuments(filter),
  ]);

  return ApiResponse.success(res, {
    message: 'Users fetched',
    data: users,
    meta: { page, pages: Math.max(1, Math.ceil(total / limit)), total },
  });
});

// GET /api/users/:id
export const getUser = asyncHandler(async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, companyId: req.companyId })
    .select('-password')
    .populate('department', 'name')
    .populate('reportingTo', 'name role');
  if (!user) throw ApiError.notFound('User not found');
  return ApiResponse.success(res, { message: 'User fetched', data: user });
});

// POST /api/users
export const createUser = asyncHandler(async (req, res) => {
  const { name, email, password, role, department, reportingTo } = req.body;

  if (!canManage(req.user.role, role)) {
    throw ApiError.forbidden(`Your role cannot create a ${role}`);
  }

  // Subscription employee limit (Trial = 10)
  const subscription = await Subscription.findOne({ company: req.companyId });
  const limit = subscription?.limits?.employees;
  if (limit) {
    const active = await User.countDocuments({ companyId: req.companyId, status: 'ACTIVE' });
    if (active >= limit) {
      throw ApiError.forbidden(`Employee limit reached (${limit}) on your plan. Upgrade to add more.`);
    }
  }

  if (department) {
    const dept = await Department.findOne({ _id: department, companyId: req.companyId });
    if (!dept) throw ApiError.badRequest('Invalid department for your company');
  }
  if (reportingTo) {
    const mgr = await User.findOne({ _id: reportingTo, companyId: req.companyId });
    if (!mgr) throw ApiError.badRequest('Invalid reporting manager');
  }

  const exists = await User.findOne({ email: email.toLowerCase(), companyId: req.companyId });
  if (exists) throw ApiError.conflict('A user with this email already exists in your company');

  const user = await User.create({
    name, email, password, role,
    companyId: req.companyId,
    department: department || null,
    reportingTo: reportingTo || null,
    ...pickDetails(req.body),
  });

  const out = await User.findById(user._id).select('-password')
    .populate('department', 'name').populate('reportingTo', 'name role');

  // Phase 8 📧🔔 welcome notification + credentials email (non-fatal)
  notifyUser(req.companyId, user._id, {
    type: 'USER', title: 'Welcome to Crewly HRMS 👋',
    message: `Your account was created as ${role}. Login with your email & password.`,
    link: '/app',
  });
  sendMail({ to: email, ...welcomeEmail({ name, email, password, companyName: req.company?.name, code: req.company?.code }) });

  return ApiResponse.created(res, { message: 'User created', data: { user: out } });
});

// PATCH /api/users/:id
export const updateUser = asyncHandler(async (req, res) => {
  const target = await User.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!target) throw ApiError.notFound('User not found');

  const isSelf = String(target._id) === String(req.user._id);
  if (!isSelf && !canManage(req.user.role, target.role)) {
    throw ApiError.forbidden('You cannot edit this user');
  }

  // Role change: never on yourself, and only into roles you may create
  if (req.body.role && !isSelf) {
    if (req.body.role !== target.role && !canManage(req.user.role, req.body.role)) {
      throw ApiError.forbidden('Your role cannot assign this role');
    }
    target.role = req.body.role;
  }

  if (req.body.name !== undefined) target.name = req.body.name;
  if (req.body.department !== undefined) target.department = req.body.department || null;
  if (req.body.reportingTo !== undefined) target.reportingTo = req.body.reportingTo || null;
  if (req.body.status !== undefined && !isSelf) target.status = req.body.status;

  if (target.department) {
    const dept = await Department.findOne({ _id: target.department, companyId: req.companyId });
    if (!dept) throw ApiError.badRequest('Invalid department for your company');
  }
  if (target.reportingTo) {
    // Circular reporting guard: walk up the manager chain —
    // if we meet the user being edited, the chain is a loop.
    let cur = target.reportingTo;
    const seen = new Set();
    while (cur) {
      if (String(cur) === String(target._id)) {
        throw ApiError.badRequest('Circular reporting: a user cannot report to themselves (directly or indirectly)');
      }
      if (seen.has(String(cur))) break;
      seen.add(String(cur));
      const mgr = await User.findById(cur).select('reportingTo companyId');
      if (!mgr || String(mgr.companyId) !== String(req.companyId)) break;
      cur = mgr.reportingTo;
    }
  }

  Object.assign(target, pickDetails(req.body));
  await target.save();

  const out = await User.findById(target._id).select('-password')
    .populate('department', 'name').populate('reportingTo', 'name role');
  return ApiResponse.success(res, { message: 'User updated', data: { user: out } });
});

// POST /api/users/:id/reset-password
export const resetPassword = asyncHandler(async (req, res) => {
  const target = await User.findOne({ _id: req.params.id, companyId: req.companyId }).select('+password');
  if (!target) throw ApiError.notFound('User not found');
  if (!canManage(req.user.role, target.role)) {
    throw ApiError.forbidden('You cannot reset this user\'s password');
  }
  target.password = req.body.newPassword; // pre-save hook hashes it
  await target.save();
  return ApiResponse.success(res, { message: `Password reset for ${target.name}` });
});



// ============================================================
// 🌳 GET /api/users/hierarchy — Org Chart tree (role-scoped)
// COMPANY_ADMIN & HR_MANAGER → whole company
// MANAGER / TEAM_LEAD / EMPLOYEE → their own department only
//   (no department assigned? → fallback: self + own report chain)
// Tree rule: if a person's manager isn't in the visible set,
// they automatically become a root — so scoped views still work.
// ============================================================
const FULL_ORG_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER'];

const getOrgHierarchy = async (req, res, next) => {
  try {
    // Always fetch within THIS company only (multi-tenant safety)
    const all = await User.find({ companyId: req.companyId, status: { $ne: 'INACTIVE' } })
      .select('name role designation department employeeCode avatarUrl reportingTo status email')
      .populate('department', 'name')
      .lean();

    let users = all;

    // ── 🔒 Department scoping for non-admin roles ─────────────────────────
    if (!FULL_ORG_ROLES.includes(req.user.role)) {
      const myDept = req.user.department ? String(req.user.department) : null;

      if (myDept) {
        // e.g. Testing manager → only Testing department users
        users = all.filter((u) => String(u.department?._id || u.department || '') === myDept);
      } else {
        // No department set → show "me + everyone who (in)directly reports to me"
        const childrenOf = new Map();
        all.forEach((u) => {
          const p = u.reportingTo ? String(u.reportingTo) : null;
          if (p) {
            if (!childrenOf.has(p)) childrenOf.set(p, []);
            childrenOf.get(p).push(u);
          }
        });
        const keep = new Set([String(req.user._id)]);
        const queue = [String(req.user._id)];
        while (queue.length) {
          const cur = queue.shift();
          (childrenOf.get(cur) || []).forEach((child) => {
            const id = String(child._id);
            if (!keep.has(id)) { keep.add(id); queue.push(id); }
          });
        }
        users = all.filter((u) => keep.has(String(u._id)));
      }
    }

    // ── 🌳 Build the tree ─────────────────────────────────────────────────
    const nodeOf = (u) => ({
      _id: u._id,
      id: u._id,
      name: u.name,
      email: u.email,
      role: u.role,
      designation: u.designation || '',
      department: u.department?.name || '',
      employeeCode: u.employeeCode || '',
      avatarUrl: u.avatarUrl || '',
      reportingTo: u.reportingTo || null,
      children: [],
    });

    const byId = new Map(users.map((u) => [String(u._id), nodeOf(u)]));
    const roots = [];
    users.forEach((u) => {
      const node = byId.get(String(u._id));
      const parent = u.reportingTo ? byId.get(String(u.reportingTo)) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    });

    res.json({ success: true, data: roots });
  } catch (err) {
    next(err);
  }
};
export { getOrgHierarchy };