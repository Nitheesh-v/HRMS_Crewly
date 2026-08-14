import Shift from '../models/Shift.js';
import ShiftAssignment from '../models/ShiftAssignment.js';
import * as engine from '../utils/scheduleEngine.js';
import { notifySmart } from '../utils/notifyPref.js';

const ok = (res, status, data, message) => res.status(status).json({ statusCode: status, success: true, data, message });
const fail = (res, status, message) => res.status(status).json({ statusCode: status, success: false, message });

const notify = async (userId, payload) => {
  try { if (userId) await notifySmart(userId, { category: 'SYSTEM', ...payload }); } catch { /* never block */ }
};

const dto = (s) => ({
  id: String(s._id),
  name: s.name, type: s.type,
  startTime: s.startTime, endTime: s.endTime,
  crossesMidnight: engine.crossesMidnight(s.startTime, s.endTime),
  breakMinutes: s.breakMinutes, graceMinutes: s.graceMinutes,
  overtimeEligible: !!s.overtimeEligible, overtimeRatePerHour: s.overtimeRatePerHour || 0,
  shiftAllowance: s.shiftAllowance || 0, nightAllowance: s.nightAllowance || 0,
  lateRule: s.lateRule, earlyCheckoutRule: s.earlyCheckoutRule,
  branch: s.branch || '',
  departments: (s.departments || []).map((d) => ({ id: String(d._id || d), name: d.name || '' })),
  employees: (s.employees || []).map((u) => ({ id: String(u._id || u), name: u.name || '' })),
  isActive: s.isActive !== false,
});

// GET /api/shifts (HR)
export const listShifts = async (req, res) => {
  try {
    const docs = await Shift.find({ companyId: req.user.companyId })
      .populate('departments', 'name').populate('employees', 'name').sort('-isActive name').lean();
    return ok(res, 200, { shifts: docs.map(dto) }, 'Shifts');
  } catch (e) { return fail(res, 500, e.message); }
};

// POST /api/shifts (HR)
export const createShift = async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name?.trim()) return fail(res, 400, 'Shift name is required');
    const doc = await Shift.create({ ...b, name: b.name.trim(), companyId: req.user.companyId, createdBy: req.user._id, updatedBy: req.user._id });
    await engine.auditSafe({ path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, companyId: req.user.companyId, userId: req.user._id, action: 'SHIFT_CREATED', target: doc.name, next: { startTime: doc.startTime, endTime: doc.endTime } });
    return ok(res, 201, { id: String(doc._id) }, `Shift "${doc.name}" created 🔀`);
  } catch (e) {
    if (e?.name === 'ValidationError') return fail(res, 400, Object.values(e.errors || {}).map((x) => x.message).join(', ') || 'Invalid shift');
    return fail(res, 500, e.message);
  }
};

// PUT /api/shifts/:id (HR)
export const updateShift = async (req, res) => {
  try {
    const doc = await Shift.findOne({ _id: req.params.id, companyId: req.user.companyId });
    if (!doc) return fail(res, 404, 'Shift not found');
    const prev = { name: doc.name, startTime: doc.startTime, endTime: doc.endTime, isActive: doc.isActive };
    const b = req.body || {};
    ['name', 'type', 'startTime', 'endTime', 'breakMinutes', 'graceMinutes', 'overtimeEligible', 'overtimeRatePerHour', 'shiftAllowance', 'nightAllowance', 'lateRule', 'earlyCheckoutRule', 'branch', 'departments', 'employees', 'isActive'].forEach((k) => {
      if (b[k] !== undefined) doc[k] = b[k];
    });
    doc.updatedBy = req.user._id;
    await doc.save();
    await engine.auditSafe({ path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, companyId: req.user.companyId, userId: req.user._id, action: 'SHIFT_MODIFIED', target: doc.name, prev, next: { name: doc.name, startTime: doc.startTime, endTime: doc.endTime, isActive: doc.isActive } });
    return ok(res, 200, { id: String(doc._id) }, 'Shift updated ✅');
  } catch (e) {
    if (e?.name === 'ValidationError') return fail(res, 400, Object.values(e.errors || {}).map((x) => x.message).join(', ') || 'Invalid shift');
    return fail(res, 500, e.message);
  }
};

// DELETE /api/shifts/:id (HR, soft)
export const deleteShift = async (req, res) => {
  try {
    const doc = await Shift.findOne({ _id: req.params.id, companyId: req.user.companyId });
    if (!doc) return fail(res, 404, 'Shift not found');
    doc.isActive = false;
    doc.updatedBy = req.user._id;
    await doc.save();
    return ok(res, 200, {}, 'Shift deactivated 🗑');
  } catch (e) { return fail(res, 500, e.message); }
};

// POST /api/shifts/:id/assign  { userIds?: [], departmentId?, effectiveFrom?, reason?, scheduleId? } (HR)
export const assignShift = async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const shift = await Shift.findOne({ _id: req.params.id, companyId, isActive: true }).lean();
    if (!shift) return fail(res, 404, 'Shift not found');
    const { userIds = [], departmentId = null, effectiveFrom, reason = '', scheduleId = null } = req.body || {};
    if (!userIds.length && !departmentId) return fail(res, 400, 'Pick employees or a department');

    const from = new Date(`${engine.dstr(effectiveFrom || new Date())}T00:00:00Z`);
    const dayBefore = new Date(from.getTime() - 86400000);
    let assigned = 0;

    if (departmentId) {
      const prev = await ShiftAssignment.findOne({ companyId, department: departmentId, scope: 'DEPARTMENT', effectiveTo: null }).sort('-effectiveFrom');
      await ShiftAssignment.updateMany({ companyId, department: departmentId, scope: 'DEPARTMENT', effectiveTo: null }, { $set: { effectiveTo: dayBefore } });
      await ShiftAssignment.create({ companyId, shift: shift._id, schedule: scheduleId, scope: 'DEPARTMENT', department: departmentId, effectiveFrom: from, prevShift: prev?.shift || null, reason, changedBy: req.user._id });
      assigned += 1;
    }

    for (const uid of userIds) {
      const prev = await ShiftAssignment.findOne({ companyId, user: uid, scope: 'EMPLOYEE', effectiveTo: null }).sort('-effectiveFrom');
      await ShiftAssignment.updateMany({ companyId, user: uid, scope: 'EMPLOYEE', effectiveTo: null }, { $set: { effectiveTo: dayBefore } });
      await ShiftAssignment.create({ companyId, shift: shift._id, schedule: scheduleId, scope: 'EMPLOYEE', user: uid, effectiveFrom: from, prevShift: prev?.shift || null, reason, changedBy: req.user._id });
      assigned += 1;
      await notify(uid, {
        title: `🔀 New shift: ${shift.name}`,
        message: `Effective ${engine.dstr(from)} · ${shift.startTime}–${shift.endTime}${engine.crossesMidnight(shift.startTime, shift.endTime) ? ' (🌙 crosses midnight)' : ''}${reason ? ` · Reason: ${reason}` : ''}`,
        link: '/app/shifts',
        emailText: `You have been assigned to shift "${shift.name}" (${shift.startTime}–${shift.endTime}) effective ${engine.dstr(from)}.`,
      });
    }

    await engine.auditSafe({ path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, companyId, userId: req.user._id, action: userIds.length > 1 ? 'SHIFT_BULK_ASSIGNED' : 'SHIFT_ASSIGNED', target: shift.name, next: { userIds, departmentId, effectiveFrom: engine.dstr(from), reason } });
    return ok(res, 200, { assigned }, `Assigned "${shift.name}" ✅ (${assigned} record${assigned === 1 ? '' : 's'})`);
  } catch (e) { return fail(res, 500, e.message); }
};

// GET /api/shifts/history/:userId (HR) — full audit trail, prev→new
export const shiftHistory = async (req, res) => {
  try {
    const docs = await ShiftAssignment.find({ companyId: req.user.companyId, user: req.params.userId })
      .populate('shift', 'name type startTime endTime')
      .populate('prevShift', 'name')
      .populate('changedBy', 'name')
      .sort('-effectiveFrom')
      .limit(50)
      .lean();
    return ok(res, 200, {
      history: docs.map((a) => ({
        id: String(a._id),
        shift: a.shift ? { name: a.shift.name, type: a.shift.type, startTime: a.shift.startTime, endTime: a.shift.endTime } : null,
        prevShift: a.prevShift?.name || null,
        effectiveFrom: engine.dstr(a.effectiveFrom),
        effectiveTo: engine.dstr(a.effectiveTo),
        current: !a.effectiveTo,
        reason: a.reason || '',
        changedBy: a.changedBy?.name || '',
      })),
    }, 'Shift history');
  } catch (e) { return fail(res, 500, e.message); }
};

// GET /api/shifts/my  (self)
export const myShift = async (req, res) => {
  try {
    const { shift, schedule, source } = await engine.resolveShiftForUser(req.user.companyId, req.user, new Date());
    const history = await ShiftAssignment.find({ companyId: req.user.companyId, user: req.user._id, scope: 'EMPLOYEE' })
      .populate('shift', 'name type startTime endTime').populate('prevShift', 'name').populate('changedBy', 'name')
      .sort('-effectiveFrom').limit(10).lean();
    return ok(res, 200, {
      current: { shift: shift ? dto(shift) : null, schedule: schedule || null, source },
      history: history.map((a) => ({
        id: String(a._id),
        shift: a.shift?.name || '—',
        prevShift: a.prevShift?.name || null,
        effectiveFrom: engine.dstr(a.effectiveFrom),
        effectiveTo: engine.dstr(a.effectiveTo),
        current: !a.effectiveTo,
        reason: a.reason || '',
        changedBy: a.changedBy?.name || '',
      })),
    }, 'My shift');
  } catch (e) { return fail(res, 500, e.message); }
};

// GET /api/my-roster  (self) — shift + schedule + working days + today + upcoming holidays
export const myRoster = async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const { shift, schedule: asgSchedule, source } = await engine.resolveShiftForUser(companyId, req.user, new Date());
    const schedule = asgSchedule || (await engine.resolveScheduleForUser(companyId, req.user));
    const workingDays = await engine.getWorkingDaysForUser(companyId, req.user, schedule);
    const weeklyOffs = engine.DAY_KEYS.filter((d) => !workingDays.includes(d));
    const today = engine.dstr(new Date());
    const holToday = await engine.holidayOnDate(companyId, req.user, today);
    const upcoming = await engine.getHolidaysForUser(companyId, req.user, { from: today, to: engine.addDays(today, 60) });
    const rule = shift || schedule;
    return ok(res, 200, {
      today: {
        date: today,
        day: engine.dayKey(today),
        isWeeklyOff: !workingDays.includes(engine.dayKey(today)),
        holiday: holToday ? { name: holToday.name, type: holToday.type } : null,
        isWorkingDay: workingDays.includes(engine.dayKey(today)) && !holToday,
        window: rule ? { start: rule.startTime, end: rule.endTime, crossesMidnight: engine.crossesMidnight(rule.startTime, rule.endTime), graceMinutes: rule.lateRule?.graceMinutes ?? rule.graceMinutes ?? 0 } : null,
      },
      shift: shift ? dto(shift) : null,
      shiftSource: source,
      schedule: schedule ? { name: schedule.name, startTime: schedule.startTime, endTime: schedule.endTime, breakMinutes: schedule.breakMinutes } : null,
      workingDays,
      weeklyOffs,
      upcomingHolidays: upcoming.filter((h) => !(h.isOptional && !h.picked)).slice(0, 8),
    }, 'My roster');
  } catch (e) { return fail(res, 500, e.message); }
};

// POST /api/shifts/evaluate  { punchIn, punchOut?, userId? (HR) } — demo/verify engine
export const evaluatePunchApi = async (req, res) => {
  try {
    const { punchIn, punchOut, userId } = req.body || {};
    if (!punchIn) return fail(res, 400, 'punchIn is required');
    let user = req.user;
    if (userId && ['COMPANY_ADMIN', 'HR_MANAGER'].includes(req.user.role) && String(userId) !== String(req.user._id)) {
      const User = (await import('../models/User.js')).default;
      user = await User.findOne({ _id: userId, companyId: req.user.companyId }).lean();
      if (!user) return fail(res, 404, 'User not found');
    }
    const { shift } = await engine.resolveShiftForUser(req.user.companyId, user, new Date(punchIn));
    const rule = shift || (await engine.resolveScheduleForUser(req.user.companyId, user));
    const result = engine.evaluatePunch({ rule, punchIn, punchOut });
    return ok(res, 200, { rule: rule ? { name: rule.name, startTime: rule.startTime, endTime: rule.endTime } : null, result }, 'Evaluation');
  } catch (e) { return fail(res, 500, e.message); }
};

// GET /api/shifts/payroll-inputs?userId=&year=&month= (HR) — payroll consumes THIS
export const payrollInputs = async (req, res) => {
  try {
    const { userId, year, month } = req.query;
    if (!userId) return fail(res, 400, 'userId is required');
    const User = (await import('../models/User.js')).default;
    const user = await User.findOne({ _id: userId, companyId: req.user.companyId }).lean();
    if (!user) return fail(res, 404, 'User not found');
    const data = await engine.buildPayrollInputs(req.user.companyId, user, parseInt(year, 10) || new Date().getUTCFullYear(), parseInt(month, 10) || new Date().getUTCMonth() + 1);
    return ok(res, 200, data, 'Payroll inputs');
  } catch (e) { return fail(res, 500, e.message); }
};