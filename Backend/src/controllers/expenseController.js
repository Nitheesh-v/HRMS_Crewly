// ============================================================
// 💸 EXPENSE CONTROLLER — submit → manager → finance → reimburse
// Employee no-manager → skips straight to finance queue.
// Receipts: Cloudinary (field-name agnostic, same as Phase 14).
// ============================================================
import * as ExpenseNS from '../models/Expense.js';
import logger from '../config/logger.js';
import { sanitizeText as safeErrorText } from '../infrastructure/observability/redaction.js';
import * as UserNS from '../models/User.js';
import asyncHandler from '../utils/asyncHandler.js';
import { getSubtreeIds } from '../utils/orgHelpers.js';
import { notifySmart } from '../utils/notifyPref.js';
import { cloudinaryReady } from '../config/cloudinary.js';
import crypto from 'node:crypto';
import { uploadPrivateAsset, getPrivateAssetSignedUrl } from '../infrastructure/storage/privateCloudinaryAsset.js';
import { classifyUploadedAsset, legacyRowDeliveryInput, resolvePrivateFileDelivery } from '../services/privateFileDelivery.js';
import ApiError from '../utils/ApiError.js';

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

// Phase 32.8 — receipts are PRIVATE (Cloudinary `authenticated`, no public
// URL). Dev keeps the inline fallback (never a 500); production fails loud.
// Bytes are delivered via the gated GET /api/expenses/:id/receipt/file.
const uploadBuffer = async (companyId, file) => {
  const isImage = /^image\//.test(file.mimetype);
  if (cloudinaryReady) {
    try {
      const stored = await uploadPrivateAsset({
        buffer: file.buffer,
        storageKey: `crewly-private-expense-receipts/${companyId}/${crypto.randomUUID()}`,
        resourceType: isImage ? 'image' : 'raw',
      });
      return { url: '', publicId: '', mime: file.mimetype, storageProvider: stored.storageProvider, storageKey: stored.storageKey };
    } catch (cloudErr) {
      if (process.env.NODE_ENV === 'production') {
        throw new ApiError(503, 'Secure receipt storage is temporarily unavailable');
      }
            logger.warn(`[storage] private receipt upload failed, inline fallback used (${safeErrorText(cloudErr)})`);
    }
  } else if (process.env.NODE_ENV === 'production') {
    throw new ApiError(503, 'Secure receipt storage is unavailable');
  }
  return {
    url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
    publicId: '',
    mime: file.mimetype,
    storageProvider: 'INLINE_DEV_FALLBACK',
    storageKey: '',
  };
};

// §63 authorization predicate — pure + exported for hermetic tests.
// A receipt is visible to its OWNER or to HR/Finance of the same company.
export const canViewExpenseReceipt = (actor, expense) => {
  if (!actor || !expense) return false;
  if (expense.companyId && String(expense.companyId) !== String(actor.companyId || '')) return false;
  if (expense.user && actor._id && String(expense.user) === String(actor._id)) return true;
  return HR_ROLES.includes(actor.role);
};

const safeReceiptName = (raw) =>
  String(raw || 'receipt')
    .replace(/[\r\n"\\]/g, '_')
    .replace(/[/\\?%*:|<>]/g, '_')
    .slice(0, 120) || 'receipt';

/* ── GET /expenses/:id/receipt/file — gated receipt delivery ── */
export const getExpenseReceipt = asyncHandler(async (req, res) => {
  const expense = await Expense.findOne({ _id: req.params.id, companyId: req.companyId }).select('+receiptStorageKey');

  if (!expense || !canViewExpenseReceipt(req.user, expense)) throw ApiError.notFound('Expense not found');
  if (!expense.receiptUrl && !expense.receiptStorageProvider && !expense.receiptStorageKey) {
    throw ApiError.notFound('No receipt attached');
  }

  const delivery = resolvePrivateFileDelivery({
    ...legacyRowDeliveryInput(expense, { legacyUrlField: 'receiptUrl', keyField: 'receiptStorageKey', providerField: 'receiptStorageProvider' }),
    signedUrlResolver: ({ storageKey, resourceType }) =>
      getPrivateAssetSignedUrl({ storageKey, resourceType, attachment: true }),
  });

  if (delivery.kind === 'SIGNED_URL' || delivery.kind === 'REDIRECT') {
    res.set('Cache-Control', 'private, no-store');
    return res.redirect(302, delivery.url);
  }

  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Type', delivery.contentType || expense.receiptMime || 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="${safeReceiptName('receipt-' + expense._id)}"`);
  return res.status(200).send(delivery.bytes);
});

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
    receiptStorageProvider: receipt.storageProvider || '',
    receiptStorageKey: receipt.storageKey || '',
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