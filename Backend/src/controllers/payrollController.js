// ─────────────────────────────────────────────────────────────
// Payroll controller
//
// ⚠️ RESPONSE CONTRACTS (PayrollPage / MyPayslipsPage depend on
//    these — do NOT change the shape):
//   GET /payroll?month     → data: { rows: [Payroll+user], month }
//   GET /payroll/structures→ data: [ SalaryStructure+user populated ]
//   POST /payroll/generate → data: { generated: [{name}],
//                                    skipped: [{name, reason}] }
//   GET /payroll/my        → data: [Payroll] (employee's own)
// ─────────────────────────────────────────────────────────────
import Payroll from '../models/Payroll.js';
import { notifySmart } from '../utils/notifyPref.js';
import SalaryStructure from '../models/SalaryStructure.js';
import User from '../models/User.js';
import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ROLES } from '../utils/constants.js';
import { streamPayslipPdf, MONTH_FULL } from '../utils/payslipPdf.js';

const HR = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const LEAVE_QUOTA = { CASUAL: 12, SICK: 6, EARNED: 12 }; // mirrors LEAVE_TYPES

// ── local date helpers (self-contained: 'YYYY-MM-DD' strings) ──
const ymd = (v) => {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
};
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const monthBounds = (month) => {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
};
const isWorkingDay = (s) => {
  const g = new Date(`${s}T00:00:00Z`).getUTCDay();
  return g !== 0 && g !== 6; // Mon–Fri only
};
const countWorkingDays = (start, end) => {
  let n = 0;
  let cur = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cur <= last) {
    if (isWorkingDay(ymd(cur))) n += 1;
    cur = new Date(cur.getTime() + 86400000);
  }
  return n;
};

// ── the money math for one user + one month ─────────────────
async function calculateMonth(companyId, userId, structure, month) {
  const { start, end } = monthBounds(month);
  const currentMonth = todayIST().slice(0, 7);
  // Current month → count only days ELAPSED so far (fair mid-month runs).
  const elapsed = month === currentMonth ? todayIST() : end;

  const workingDays = countWorkingDays(start, end);
  const elapsedWorkingDays = countWorkingDays(start, elapsed);

  // Present days: PRESENT/LATE = 1, HALF_DAY = 0.5
  const attendance = await Attendance.find({
    companyId, user: userId, date: { $gte: start, $lte: elapsed },
  }).select('status');
  let presentDays = 0;
  attendance.forEach((rec) => { presentDays += rec.status === 'HALF_DAY' ? 0.5 : 1; });

  // Approved leave days inside this month are PAID (not loss of pay)
  const leaves = await Leave.find({ companyId, user: userId, status: 'APPROVED' }).select('startDate endDate');
  let paidLeaveDays = 0;
  for (const lv of leaves) {
    const s = ymd(lv.startDate) < start ? start : ymd(lv.startDate);
    const t = ymd(lv.endDate) > elapsed ? elapsed : ymd(lv.endDate);
    if (s <= t) paidLeaveDays += countWorkingDays(s, t);
  }

  const absentDays = Math.max(0, elapsedWorkingDays - presentDays - paidLeaveDays);

  const basic = Number(structure.basic) || 0;
  const hra = Number(structure.hra) || 0;
  const allowances = Number(structure.allowances) || 0;
  const gross = basic + hra + allowances;

  const perDay = workingDays > 0 ? gross / workingDays : 0;
  const attendanceDeduction = Math.round(perDay * absentDays);
  const pf = Math.round((basic * (Number(structure.pfPercent) || 0)) / 100);
  const professionalTax = Math.round(Number(structure.professionalTax) || 0);
  const total = pf + professionalTax + attendanceDeduction;

  return {
    workingDays, presentDays, paidLeaveDays, absentDays,
    earnings: { basic, hra, allowances, gross },
    deductions: { pf, professionalTax, attendanceDeduction, total },
    netPay: gross - total,
  };
}

// GET /api/payroll/my — employee's own payslips
export const getMyPayslips = asyncHandler(async (req, res) => {
  const list = await Payroll.find({ companyId: req.companyId, user: req.user._id }).sort('-month');
  return ApiResponse.success(res, { message: 'Your payslips', data: list });
});

// GET /api/payroll/structures — STRUCTURE DOCS with user populated
// (PayrollPage builds its user×structure table from this + /users)
export const getStructures = asyncHandler(async (req, res) => {
  const structures = await SalaryStructure.find({ companyId: req.companyId })
    .populate('user', 'name email role designation employeeCode')
    .sort('-createdAt');
  return ApiResponse.success(res, { message: 'Salary structures', data: structures });
});

// PUT /api/payroll/structure/:userId
export const upsertStructure = asyncHandler(async (req, res) => {
  const target = await User.findOne({ _id: req.params.userId, companyId: req.companyId });
  if (!target) throw ApiError.notFound('User not found in your company');

  const { basic, hra, allowances = 0, pfPercent = 12, professionalTax = 0 } = req.body;
  const structure = await SalaryStructure.findOneAndUpdate(
    { companyId: req.companyId, user: target._id },
    { $set: { companyId: req.companyId, basic, hra, allowances, pfPercent, professionalTax } },
    { new: true, upsert: true, runValidators: true }
  );
  return ApiResponse.success(res, { message: `Salary structure saved for ${target.name}`, data: { structure } });
});

// POST /api/payroll/generate
// data = { generated: [{ name }], skipped: [{ name, reason }] }
export const generatePayroll = asyncHandler(async (req, res) => {
  const { month } = req.body;
  if (!MONTH_RE.test(month)) throw ApiError.badRequest('Month must be in YYYY-MM format');
  if (month > todayIST().slice(0, 7)) throw ApiError.badRequest('Cannot generate payroll for a future month');

  const users = await User.find({ companyId: req.companyId, status: 'ACTIVE' }).select('_id name');
  const structures = await SalaryStructure.find({ companyId: req.companyId });
  const byUser = new Map(structures.map((s) => [String(s.user), s]));

  const generated = [];
  const skipped = [];

  for (const user of users) {
    const structure = byUser.get(String(user._id));
    if (!structure) {
      skipped.push({ name: user.name, reason: 'No salary structure set' });
      continue;
    }

    const existing = await Payroll.findOne({ companyId: req.companyId, user: user._id, month });
    if (existing?.status === 'PAID') {
      skipped.push({ name: user.name, reason: 'Already PAID (locked)' });
      continue;
    }

    const numbers = await calculateMonth(req.companyId, user._id, structure, month);
    if (existing) {
      Object.assign(existing, numbers);
      await existing.save();
    } else {
      await Payroll.create({ ...numbers, companyId: req.companyId, user: user._id, month, generatedBy: req.user._id });
    }
    generated.push({ name: user.name });
  }

  return ApiResponse.success(res, {
    message: `Payroll run completed for ${month}`,
    data: { generated, skipped },
  });
});

// GET /api/payroll?month=YYYY-MM
// data = { rows: [...], month }  (PayrollPage reads payroll.rows)
export const listPayroll = asyncHandler(async (req, res) => {
  const month = req.query.month || todayIST().slice(0, 7);
  const rows = await Payroll.find({ companyId: req.companyId, month })
    .populate({
      path: 'user',
      select: 'name email role department employeeCode designation',
      populate: { path: 'department', select: 'name' },
    });
  return ApiResponse.success(res, { message: `Payroll for ${month}`, data: { rows, month } });
});

// PATCH /api/payroll/:id/pay
export const markPaid = asyncHandler(async (req, res) => {
  const payroll = await Payroll.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!payroll) throw ApiError.notFound('Payroll record not found');
  if (payroll.status === 'PAID') throw ApiError.badRequest('This payroll is already marked as PAID');
  payroll.status = 'PAID';
  payroll.paidAt = new Date();
  await payroll.save();
  return ApiResponse.success(res, { message: 'Marked as PAID', data: payroll });
});

// GET /api/payroll/:id/payslip — professional PDF (owner or HR)
export const downloadPayslip = asyncHandler(async (req, res) => {
  const payroll = await Payroll.findOne({ _id: req.params.id, companyId: req.companyId })
    .populate({ path: 'user', select: '-password', populate: { path: 'department', select: 'name' } });
  if (!payroll) throw ApiError.notFound('Payroll record not found');

  const isOwner = String(payroll.user._id) === String(req.user._id);
  if (!isOwner && !HR.includes(req.user.role)) {
    throw ApiError.forbidden('You can only view your own payslip');
  }

  // Leave balance = yearly quotas − APPROVED leave used this year
  const year = payroll.month.slice(0, 4);
  const leaves = await Leave.find({ companyId: req.companyId, user: payroll.user._id, status: 'APPROVED' })
    .select('type startDate endDate totalDays');
  const used = { CASUAL: 0, SICK: 0, EARNED: 0 };
  for (const lv of leaves) {
    const s = ymd(lv.startDate);
    const t = ymd(lv.endDate);
    if (!s.startsWith(year) && !t.startsWith(year)) continue;
    used[lv.type] = (used[lv.type] || 0) + (Number(lv.totalDays) || countWorkingDays(s, t));
  }
  const leaveBalance = Object.keys(LEAVE_QUOTA)
    .reduce((sum, k) => sum + Math.max(0, LEAVE_QUOTA[k] - (used[k] || 0)), 0);

  const [yr, mn] = payroll.month.split('-').map(Number);
  const filename = `Payslip-${payroll.user.name}-${MONTH_FULL[mn - 1]}, ${yr}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  streamPayslipPdf({ payroll, employee: payroll.user, company: req.company, leaveBalance }, res);
});