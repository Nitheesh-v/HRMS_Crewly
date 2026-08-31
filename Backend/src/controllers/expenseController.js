// ============================================================
// 💸 EXPENSE CONTROLLER — submit → manager → finance → reimburse
// Employee no-manager → skips straight to finance queue.
// Receipts: Cloudinary (field-name agnostic, same as Phase 14).
// ============================================================
import * as ExpenseNS from '../models/Expense.js';
import * as UserNS from '../models/User.js';
import asyncHandler from '../utils/asyncHandler.js';
import { getSubtreeIds } from '../utils/orgHelpers.js';
import { notifySmart } from '../utils/notifyPref.js';
import { cloudinaryReady } from '../config/cloudinary.js';
import cloudinary from '../config/cloudinary.js';

const pickModel = (ns) => (typeof ns.default === 'function' ? ns.default : ns.default || ns);
const Expense = pickModel(ExpenseNS);
const User = pickModel(UserNS);

const ok = (res, status, data, message) =>
  res.status(status).json({ statusCode: status, success: true, data, message });
const fail = (res, status, message) =>
  res.status(status).json({ statusCode: status, success: false, message });

const HR_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER'];
const isHR = (req) => HR_ROLES.includes(req.user.role);
const CATS = ['TRAVEL', 'FOOD', 'ACCOMMODATION', 'CLIENT_MEETING', 'TRANSPORT', 'OTHER'];

const notifyExp = async (userId, payload) => {
  try {
    if (userId) await notifySmart(userId, { category: 'EXPENSE', ...payload });
  } catch {}
};
const notifyFinance = (companyId, payload) => {
  User.find({ companyId, role: { $in: HR_ROLES }, status: 'ACTIVE' })
    .select('_id')
    .lean()
    .then((rows) => rows.forEach((r) => notifyExp(r._id, payload)))
    .catch(() => {});
};

const getFile = (req) => req.file || (Array.isArray(req.files) ? req.files[0] : null) || null;

const uploadBuffer = async (companyId, file) => {
  const isImage = /^image\//.test(file.mimetype);
  if (cloudinaryReady) {
    try {
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: `crewly/expenses/${companyId}`, resource_type: isImage ? 'image' : 'raw' },
          (err, r) => (err ? reject(err) : resolve(r))
        );
        stream.end(file.buffer);
      });
      return { url: result.secure_url, publicId: result.public_id, mime: file.mimetype };
    } catch { /* inline fallback */ }
  }
  return { url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`, publicId: '', mime: file.mimetype };
};

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/* ── POST /expenses — anyone submits (receipt optional) ── */
export const submitExpense = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { category = 'OTHER', amount, expenseDate = '', description = '' } = req.body;
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 1 || amt > 10000000) return fail(res, 400, 'Enter a valid amount');

  const file = getFile(req);
  let receipt = { url: '', publicId: '', mime: '' };
  // DB Logic - DB logics
  if (file) receipt = await uploadBuffer(req.companyId, file);

  const manager = req.user.reportingTo || null;
  const expense = await Expense.create({
    companyId: req.companyId,
    user: req.user._id,
    category: CATS.includes(category) ? category : 'OTHER',
    amount: amt,
    expenseDate,
    description: description.trim().slice(0, 500),
    receiptUrl: receipt.url,
    receiptPublicId: receipt.publicId,
    receiptMime: receipt.mime,
    status: manager ? 'PENDING_MANAGER' : 'PENDING_FINANCE',
  });

  const payload = {
    title: '💸 Expense to approve',
    message: `${req.user.name} submitted ${money(amt)} (${category.replaceAll('_', ' ')})${description ? ` — "${description}"` : ''}`,
    link: '/app/expenses',
  };
  if (manager) notifyExp(manager, payload);
  else notifyFinance(req.companyId, payload);

  // Data to frontend - response to frontend
  ok(res, 201, expense, 'Expense submitted ✅');
});

/* ── GET /expenses/my ── */
export const myExpenses = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const rows = await Expense.find({ companyId: req.companyId, user: req.user._id })
    .populate('managerApproval.by', 'name')
    .populate('financeApproval.by', 'name')
    .sort('-createdAt')
    .limit(200)
    .lean();
  // Data to frontend - response to frontend
  ok(res, 200, rows, 'My expenses');
});

/* ── GET /expenses/approvals — role-aware queue ── */
export const approvalsQueue = asyncHandler(async (req, res) => {
  let rows;
  // Data from frontend - requests from frontend
  if (isHR(req)) {
    rows = await Expense.find({ companyId: req.companyId, status: 'PENDING_FINANCE' })
      .populate('user', 'name email role designation')
      .populate('managerApproval.by', 'name')
      .sort('createdAt')
      .lean();
  } else if (['MANAGER', 'TEAM_LEAD'].includes(req.user.role)) {
    const scope = await getSubtreeIds(req.companyId, req.user._id);
    rows = await Expense.find({
      companyId: req.companyId,
      status: 'PENDING_MANAGER',
      user: { $in: scope.filter((id) => String(id) !== String(req.user._id)) },
    })
      .populate('user', 'name email role designation')
      .sort('createdAt')
      .lean();
  } else {
    rows = [];
  }
  // Data to frontend - response to frontend
  ok(res, 200, rows, 'Approvals queue');
});

/* ── POST /expenses/:id/manager-decide ── */
export const managerDecide = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const { action, note = '' } = req.body;
  if (!['APPROVE', 'REJECT'].includes(action)) return fail(res, 400, 'action must be APPROVE or REJECT');

  // DB Logic - DB logics
  const exp = await Expense.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!exp) return fail(res, 404, 'Expense not found');
  if (exp.status !== 'PENDING_MANAGER') return fail(res, 409, `Already ${exp.status.toLowerCase().replaceAll('_', ' ')}`);
  if (String(exp.user) === String(req.user._id)) return fail(res, 400, 'You cannot approve your own expense');

  if (!isHR(req)) {
    const scope = await getSubtreeIds(req.companyId, req.user._id);
    if (!scope.map(String).includes(String(exp.user))) return fail(res, 403, 'This employee is not in your team');
  }

  if (action === 'APPROVE') {
    exp.status = 'PENDING_FINANCE';
    exp.managerApproval = { by: req.user._id, at: new Date(), note: note.trim() };
    notifyFinance(req.companyId, {
      title: '💸 Expense awaiting finance approval',
      message: `${req.user.name} approved ${money(exp.amount)} — needs finance sign-off`,
      link: '/app/expenses',
    });
    notifyExp(exp.user, { title: '✅ Manager approved your expense', message: `${money(exp.amount)} — now with finance`, link: '/app/expenses' });
  } else {
    exp.status = 'REJECTED';
    exp.managerApproval = { by: req.user._id, at: new Date(), note: note.trim() };
    exp.rejectNote = note.trim();
    notifyExp(exp.user, { title: '❌ Expense rejected by manager', message: `${money(exp.amount)}${note ? ` — "${note}"` : ''}`, link: '/app/expenses' });
  }

  await exp.save();
  // Data to frontend - response to frontend
  ok(res, 200, exp, `Expense ${action.toLowerCase()}d`);
});

/* ── POST /expenses/:id/finance-decide — HR/Admin ── */
export const financeDecide = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR / Finance can decide at this stage');
  const { action, note = '' } = req.body;
  if (!['APPROVE', 'REJECT'].includes(action)) return fail(res, 400, 'action must be APPROVE or REJECT');

  // DB Logic - DB logics
  const exp = await Expense.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!exp) return fail(res, 404, 'Expense not found');
  if (exp.status !== 'PENDING_FINANCE') return fail(res, 409, `Status is ${exp.status.toLowerCase().replaceAll('_', ' ')}`);

  exp.financeApproval = { by: req.user._id, at: new Date(), note: note.trim() };
  if (action === 'APPROVE') {
    exp.status = 'APPROVED';
    notifyExp(exp.user, { title: '✅ Expense approved', message: `${money(exp.amount)} approved — reimbursement on the way 💸`, link: '/app/expenses' });
  } else {
    exp.status = 'REJECTED';
    exp.rejectNote = note.trim();
    notifyExp(exp.user, { title: '❌ Expense rejected by finance', message: `${money(exp.amount)}${note ? ` — "${note}"` : ''}`, link: '/app/expenses' });
  }

  await exp.save();
  // Data to frontend - response to frontend
  ok(res, 200, exp, `Expense ${action.toLowerCase()}d`);
});

/* ── POST /expenses/:id/reimburse — HR/Admin ── */
export const markReimbursed = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR / Finance can mark reimbursement');

  // DB Logic - DB logics
  const exp = await Expense.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!exp) return fail(res, 404, 'Expense not found');
  if (exp.status !== 'APPROVED') return fail(res, 409, 'Only APPROVED expenses can be reimbursed');

  exp.status = 'REIMBURSED';
  exp.reimbursedAt = new Date();
  exp.reimbursedBy = req.user._id;
  await exp.save();

  notifyExp(exp.user, { title: '💸 Expense reimbursed', message: `${money(exp.amount)} has been reimbursed. Check your account!`, link: '/app/expenses' });
  // Data to frontend - response to frontend
  ok(res, 200, exp, 'Marked as reimbursed 💸');
});

/* ── PATCH /expenses/:id/cancel — owner while pending ── */
export const cancelExpense = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const exp = await Expense.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!exp) return fail(res, 404, 'Expense not found');
  // Data from frontend - requests from frontend
  if (String(exp.user) !== String(req.user._id)) return fail(res, 403, 'You can only cancel your own expenses');
  if (!['PENDING_MANAGER', 'PENDING_FINANCE'].includes(exp.status)) return fail(res, 409, 'Too late to cancel');

  exp.status = 'CANCELLED';
  await exp.save();
  // Data to frontend - response to frontend
  ok(res, 200, exp, 'Expense cancelled');
});

/* ── GET /expenses/all?status= — HR/Admin overview + totals ── */
export const allExpenses = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR / Finance can view all expenses');

  const filter = { companyId: req.companyId };
  if (req.query.status) filter.status = req.query.status;
  // DB Logic - DB logics
  const rows = await Expense.find(filter)
    .populate('user', 'name email role designation')
    .sort('-createdAt')
    .limit(500)
    .lean();

  const all = await Expense.find({ companyId: req.companyId }).select('status amount').lean();
  const totals = all.reduce(
    (acc, e) => {
      acc[e.status] = (acc[e.status] || 0) + e.amount;
      return acc;
    },
    {}
  );
  // Data to frontend - response to frontend
  ok(res, 200, { expenses: rows, totals }, 'All expenses');
});