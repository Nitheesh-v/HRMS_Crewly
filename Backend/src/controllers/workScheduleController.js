import WorkSchedule from '../models/WorkSchedule.js';
import * as engine from '../utils/scheduleEngine.js';

const ok = (res, status, data, message) => res.status(status).json({ statusCode: status, success: true, data, message });
const fail = (res, status, message) => res.status(status).json({ statusCode: status, success: false, message });

const dto = (s) => ({
  id: String(s._id),
  name: s.name,
  workingDays: s.workingDays || [],
  weeklyOffs: engine.DAY_KEYS.filter((d) => !(s.workingDays || []).includes(d)),
  startTime: s.startTime, endTime: s.endTime,
  breakMinutes: s.breakMinutes, graceMinutes: s.graceMinutes,
  minWorkingHours: s.minWorkingHours, halfDayHours: s.halfDayHours,
  overtimeEligible: !!s.overtimeEligible,
  lateRule: s.lateRule, earlyCheckoutRule: s.earlyCheckoutRule,
  branch: s.branch || '',
  departments: (s.departments || []).map((d) => ({ id: String(d._id || d), name: d.name || '' })),
  employees: (s.employees || []).map((u) => ({ id: String(u._id || u), name: u.name || '' })),
  isActive: s.isActive !== false,
});

// GET /api/schedules (HR)
export const listSchedules = async (req, res) => {
  try {
    // DB Logic - DB logics
    const docs = await WorkSchedule.find({ companyId: req.user.companyId })
      .populate('departments', 'name').populate('employees', 'name').sort('-isActive name').lean();
    // Data to frontend - response to frontend
    return ok(res, 200, { schedules: docs.map(dto) }, 'Work schedules');
  } catch (e) { return fail(res, 500, e.message); }
};

// POST /api/schedules (HR)
export const createSchedule = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const b = req.body || {};
    if (!b.name?.trim()) return fail(res, 400, 'Schedule name is required');
    if (!(b.workingDays || []).length) return fail(res, 400, 'Pick at least one working day');
    // DB Logic - DB logics
    const doc = await WorkSchedule.create({
      ...b,
      name: b.name.trim(),
      companyId: req.user.companyId,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    await engine.auditSafe({ path: req.originalUrl, method: req.method, companyId: req.user.companyId, userId: req.user._id, action: 'SCHEDULE_CREATED', target: doc.name, next: { workingDays: doc.workingDays, startTime: doc.startTime, endTime: doc.endTime } });
    // Data to frontend - response to frontend
    return ok(res, 201, { id: String(doc._id) }, `Schedule "${doc.name}" created 🗓`);
  } catch (e) {
    if (e?.name === 'ValidationError') return fail(res, 400, Object.values(e.errors || {}).map((x) => x.message).join(', ') || 'Invalid schedule');
    return fail(res, 500, e.message);
  }
};

// PUT /api/schedules/:id (HR)
export const updateSchedule = async (req, res) => {
  try {
    // DB Logic - DB logics
    const doc = await WorkSchedule.findOne({ _id: req.params.id, companyId: req.user.companyId });
    if (!doc) return fail(res, 404, 'Schedule not found');
    const prev = { name: doc.name, workingDays: doc.workingDays, startTime: doc.startTime, endTime: doc.endTime, isActive: doc.isActive };
    // Data from frontend - requests from frontend
    const b = req.body || {};
    ['name', 'workingDays', 'startTime', 'endTime', 'breakMinutes', 'graceMinutes', 'minWorkingHours', 'halfDayHours', 'overtimeEligible', 'lateRule', 'earlyCheckoutRule', 'branch', 'departments', 'employees', 'isActive'].forEach((k) => {
      if (b[k] !== undefined) doc[k] = b[k];
    });
    doc.updatedBy = req.user._id;
    await doc.save();
    await engine.auditSafe({ path: req.originalUrl, method: req.method, companyId: req.user.companyId, userId: req.user._id, action: 'SCHEDULE_MODIFIED', target: doc.name, prev, next: { name: doc.name, workingDays: doc.workingDays, startTime: doc.startTime, endTime: doc.endTime, isActive: doc.isActive } });
    // Data to frontend - response to frontend
    return ok(res, 200, { id: String(doc._id) }, 'Schedule updated ✅');
  } catch (e) {
    if (e?.name === 'ValidationError') return fail(res, 400, Object.values(e.errors || {}).map((x) => x.message).join(', ') || 'Invalid schedule');
    return fail(res, 500, e.message);
  }
};

// DELETE /api/schedules/:id (HR, soft)
export const deleteSchedule = async (req, res) => {
  try {
    // DB Logic - DB logics
    const doc = await WorkSchedule.findOne({ _id: req.params.id, companyId: req.user.companyId });
    if (!doc) return fail(res, 404, 'Schedule not found');
    doc.isActive = false;
    // Data from frontend - requests from frontend
    doc.updatedBy = req.user._id;
    await doc.save();
    // Data to frontend - response to frontend
    return ok(res, 200, {}, 'Schedule deactivated 🗑');
  } catch (e) { return fail(res, 500, e.message); }
};

// POST /api/schedules/:id/assign  { userIds?: [], departmentIds?: [] } (HR)
export const assignSchedule = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const { userIds = [], departmentIds = [] } = req.body || {};
    // DB Logic - DB logics
    const doc = await WorkSchedule.findOne({ _id: req.params.id, companyId: req.user.companyId });
    if (!doc) return fail(res, 404, 'Schedule not found');
    if (userIds.length) doc.employees = [...new Set([...doc.employees.map(String), ...userIds.map(String)])];
    if (departmentIds.length) doc.departments = [...new Set([...doc.departments.map(String), ...departmentIds.map(String)])];
    doc.updatedBy = req.user._id;
    await doc.save();
    await engine.auditSafe({ path: req.originalUrl, method: req.method, companyId: req.user.companyId, userId: req.user._id, action: 'SCHEDULE_ASSIGNED', target: doc.name, next: { userIds, departmentIds } });
    // Data to frontend - response to frontend
    return ok(res, 200, {}, `Schedule assigned to ${userIds.length} employee(s), ${departmentIds.length} department(s) ✅`);
  } catch (e) { return fail(res, 500, e.message); }
};

// POST /api/schedules/:id/unassign  { userIds?: [], departmentIds?: [] } (HR)
export const unassignSchedule = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const { userIds = [], departmentIds = [] } = req.body || {};
    // DB Logic - DB logics
    const doc = await WorkSchedule.findOneAndUpdate(
      { _id: req.params.id, companyId: req.user.companyId },
      { $pull: { employees: { $in: userIds }, departments: { $in: departmentIds } } },
      { new: true }
    );
    if (!doc) return fail(res, 404, 'Schedule not found');
    // Data to frontend - response to frontend
    return ok(res, 200, {}, 'Removed from schedule ✅');
  } catch (e) { return fail(res, 500, e.message); }
};

// GET /api/schedules/my  (self)
export const mySchedule = async (req, res) => {
  try {
    // DB Logic - DB logics
    const s = await engine.resolveScheduleForUser(req.user.companyId, req.user);
    if (!s) return ok(res, 200, { schedule: null, workingDays: engine.DEFAULT_WORKING_DAYS }, 'No schedule configured — using default Mon–Fri');
    // Data to frontend - response to frontend
    return ok(res, 200, { schedule: dto(s), workingDays: s.workingDays }, 'My schedule');
  } catch (e) { return fail(res, 500, e.message); }
};