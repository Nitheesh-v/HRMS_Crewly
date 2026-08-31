import Holiday from '../models/Holiday.js';
import * as engine from '../utils/scheduleEngine.js';

const ok = (res, status, data, message) => res.status(status).json({ statusCode: status, success: true, data, message });
const fail = (res, status, message) => res.status(status).json({ statusCode: status, success: false, message });

const HR = ['COMPANY_ADMIN', 'HR_MANAGER'];
// ⚙️ Policy knob (moves into Company Settings in the Policies phase):
export const OPTIONAL_HOLIDAY_LIMIT = 3;

// GET /api/holidays  (HR: scope=all → whole company | everyone else: applicable-to-me)
export const listHolidays = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const companyId = req.user.companyId;
    const { year, month, type, branch, departmentId, scope } = req.query;
    const y = parseInt(year, 10) || new Date().getUTCFullYear();
    const m = month ? parseInt(month, 10) : null;
    const from = m ? `${y}-${String(m).padStart(2, '0')}-01` : `${y}-01-01`;
    const toD = m ? new Date(Date.UTC(y, m, 0)).getUTCDate() : 31;
    const to = m ? `${y}-${String(m).padStart(2, '0')}-${toD}` : `${y}-12-31`;

    if (scope === 'all' && HR.includes(req.user.role)) {
      const q = { companyId, date: { $lte: new Date(to) }, endDate: { $gte: new Date(from) } };
      if (type) q.type = type;
      if (branch) q.branch = branch;
      if (departmentId) q.departments = departmentId;
      if (req.query.active === 'false') q.isActive = false; else q.isActive = true;
      const docs = await Holiday.find(q).populate('departments', 'name').populate('createdBy', 'name').sort('date').lean();
      return ok(res, 200, {
        holidays: docs.map((h) => ({
          ...engine && {},
          id: String(h._id),
          name: h.name, type: h.type,
          date: engine.dstr(h.date), endDate: engine.dstr(h.endDate || h.date),
          dates: engine.eachDate(engine.dstr(h.date), engine.dstr(h.endDate || h.date)),
          description: h.description || '', branch: h.branch || '',
          departments: (h.departments || []).map((d) => ({ id: String(d._id || d), name: d.name || '' })),
          applicableCount: (h.applicableEmployees || []).length,
          isOptional: !!h.isOptional, picks: (h.optionalPicks || []).length,
          recurringYearly: !!h.recurringYearly, isActive: h.isActive !== false,
          createdBy: h.createdBy?.name || '',
        })),
      }, 'Holidays');
    }

    // DB Logic - DB logics
    const holidays = await engine.getHolidaysForUser(companyId, req.user, { from, to });
    const filtered = type ? holidays.filter((h) => h.type === type) : holidays;
    // Data to frontend - response to frontend
    return ok(res, 200, { holidays: filtered }, 'Holidays');
  } catch (e) {
    console.error('❌ [holidays]', e?.message || e);
    if (e?.name === 'ValidationError' || e?.name === 'CastError') return fail(res, 400, e.message);
    return fail(res, 500, e.message);
  }
};

// POST /api/holidays  (HR)
export const createHoliday = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const companyId = req.user.companyId;
    const b = req.body || {};
    if (!b.name?.trim() || !b.date) return fail(res, 400, 'name and date are required');
    if (b.type === 'DEPARTMENT' && !(b.departments || []).length) return fail(res, 400, 'Pick at least one department for a DEPARTMENT holiday');
    if (b.type === 'BRANCH' && !b.branch?.trim()) return fail(res, 400, 'Branch name is required for a BRANCH holiday');

    // DB Logic - DB logics
    const doc = await Holiday.create({
      companyId,
      name: b.name.trim(),
      type: b.isOptional ? 'OPTIONAL' : (b.type || 'COMPANY'),
      date: new Date(b.date),
      endDate: b.endDate ? new Date(b.endDate) : new Date(b.date),
      description: b.description || '',
      branch: b.branch || '',
      departments: b.departments || [],
      applicableEmployees: b.applicableEmployees || [],
      isOptional: !!b.isOptional,
      recurringYearly: !!b.recurringYearly,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    await engine.auditSafe({ path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, companyId, userId: req.user._id, action: 'HOLIDAY_CREATED', target: doc.name, next: { date: engine.dstr(doc.date), type: doc.type } });
    // Data to frontend - response to frontend
    return ok(res, 201, { id: String(doc._id) }, `Holiday "${doc.name}" created 🎉`);
  } catch (e) {
    console.error('❌ [holidays]', e?.message || e);
    if (e?.name === 'ValidationError' || e?.name === 'CastError') return fail(res, 400, e.message);
    return fail(res, 500, e.message);
  }
};

// PUT /api/holidays/:id  (HR)
export const updateHoliday = async (req, res) => {
  try {
    // DB Logic - DB logics
    const doc = await Holiday.findOne({ _id: req.params.id, companyId: req.user.companyId });
    if (!doc) return fail(res, 404, 'Holiday not found');
    const prev = { name: doc.name, date: engine.dstr(doc.date), type: doc.type, isActive: doc.isActive };
    // Data from frontend - requests from frontend
    const b = req.body || {};
    ['name', 'description', 'branch'].forEach((k) => { if (b[k] !== undefined) doc[k] = b[k]; });
    if (b.date) doc.date = new Date(b.date);
    if (b.endDate) doc.endDate = new Date(b.endDate);
    if (b.type) doc.type = b.type;
    if (b.departments) doc.departments = b.departments;
    if (b.applicableEmployees) doc.applicableEmployees = b.applicableEmployees;
    if (b.isOptional !== undefined) doc.isOptional = !!b.isOptional;
    if (b.recurringYearly !== undefined) doc.recurringYearly = !!b.recurringYearly;
    if (b.isActive !== undefined) doc.isActive = !!b.isActive;
    doc.updatedBy = req.user._id;
    await doc.save();
    await engine.auditSafe({ path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, companyId: req.user.companyId, userId: req.user._id, action: 'HOLIDAY_MODIFIED', target: doc.name, prev, next: { name: doc.name, date: engine.dstr(doc.date), type: doc.type, isActive: doc.isActive } });
    // Data to frontend - response to frontend
    return ok(res, 200, { id: String(doc._id) }, 'Holiday updated ✅');
  } catch (e) {
    console.error('❌ [holidays]', e?.message || e);
    if (e?.name === 'ValidationError' || e?.name === 'CastError') return fail(res, 400, e.message);
    return fail(res, 500, e.message);
  }
};

// DELETE /api/holidays/:id  (HR, soft deactivate)
export const deleteHoliday = async (req, res) => {
  try {
    // DB Logic - DB logics
    const doc = await Holiday.findOne({ _id: req.params.id, companyId: req.user.companyId });
    if (!doc) return fail(res, 404, 'Holiday not found');
    doc.isActive = false;
    // Data from frontend - requests from frontend
    doc.updatedBy = req.user._id;
    await doc.save();
    await engine.auditSafe({ path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, path: req.originalUrl, method: req.method, companyId: req.user.companyId, userId: req.user._id, action: 'HOLIDAY_DEACTIVATED', target: doc.name });
    // Data to frontend - response to frontend
    return ok(res, 200, { id: String(doc._id) }, 'Holiday deactivated 🗑');
  } catch (e) {
    console.error('❌ [holidays]', e?.message || e);
    if (e?.name === 'ValidationError' || e?.name === 'CastError') return fail(res, 400, e.message);
    return fail(res, 500, e.message);
  }
};

// POST /api/holidays/:id/pick  (self — optional holiday)
export const pickOptional = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const uid = req.user._id;
    // DB Logic - DB logics
    const doc = await Holiday.findOne({ _id: req.params.id, companyId: req.user.companyId, isActive: true, isOptional: true });
    if (!doc) return fail(res, 404, 'Optional holiday not found');
    if (doc.optionalPicks.some((p) => String(p) === String(uid))) return ok(res, 200, {}, 'Already picked ✅');
    const yr = new Date(doc.date).getUTCFullYear();
    const used = await Holiday.countDocuments({
      companyId: req.user.companyId,
      isOptional: true,
      optionalPicks: uid,
      date: { $gte: new Date(Date.UTC(yr, 0, 1)), $lte: new Date(Date.UTC(yr, 11, 31)) },
    });
    if (used >= OPTIONAL_HOLIDAY_LIMIT) return fail(res, 400, `Optional holiday limit reached (${OPTIONAL_HOLIDAY_LIMIT}/year)`);
    doc.optionalPicks.push(uid);
    await doc.save();
    // Data to frontend - response to frontend
    return ok(res, 200, { used: used + 1, limit: OPTIONAL_HOLIDAY_LIMIT }, `Picked "${doc.name}" 🎉 (${used + 1}/${OPTIONAL_HOLIDAY_LIMIT})`);
  } catch (e) {
    console.error('❌ [holidays]', e?.message || e);
    if (e?.name === 'ValidationError' || e?.name === 'CastError') return fail(res, 400, e.message);
    return fail(res, 500, e.message);
  }
};

// DELETE /api/holidays/:id/pick  (self)
export const unpickOptional = async (req, res) => {
  try {
    // DB Logic - DB logics
    const doc = await Holiday.findOneAndUpdate(
      // Data from frontend - requests from frontend
      { _id: req.params.id, companyId: req.user.companyId, isOptional: true },
      { $pull: { optionalPicks: req.user._id } },
      { new: true }
    );
    if (!doc) return fail(res, 404, 'Optional holiday not found');
    // Data to frontend - response to frontend
    return ok(res, 200, {}, 'Optional holiday removed');
  } catch (e) {
    console.error('❌ [holidays]', e?.message || e);
    if (e?.name === 'ValidationError' || e?.name === 'CastError') return fail(res, 400, e.message);
    return fail(res, 500, e.message);
  }
};

// GET /api/holidays/upcoming?days=60  (self)
export const upcomingHolidays = async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const days = Math.min(365, parseInt(req.query.days, 10) || 60);
    const from = engine.dstr(new Date());
    const to = engine.addDays(from, days);
    // DB Logic - DB logics
    const holidays = await engine.getHolidaysForUser(req.user.companyId, req.user, { from, to });
    // Data to frontend - response to frontend
    return ok(res, 200, { holidays: holidays.filter((h) => !(h.isOptional && !h.picked)) }, 'Upcoming holidays');
  } catch (e) {
    console.error('❌ [holidays]', e?.message || e);
    if (e?.name === 'ValidationError' || e?.name === 'CastError') return fail(res, 400, e.message);
    return fail(res, 500, e.message);
  }
};