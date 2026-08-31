// ============================================================
// 🧬 LIFECYCLE CONTROLLER (Phase 15)
// Journey view · stage console (HR) · promote · transfer
// Auto-bootstraps records for existing employees (CONFIRMED).
// ============================================================
import * as EmployeeLifecycleNS from '../models/EmployeeLifecycle.js';
import * as UserNS from '../models/User.js';
import * as DepartmentNS from '../models/Department.js';
import asyncHandler from '../utils/asyncHandler.js';
import { notifySmart } from '../utils/notifyPref.js';

const pickModel = (ns) => (typeof ns.default === 'function' ? ns.default : ns.default || ns);
const EmployeeLifecycle = pickModel(EmployeeLifecycleNS);
const User = pickModel(UserNS);
const Department = pickModel(DepartmentNS);

const ok = (res, status, data, message) =>
  res.status(status).json({ statusCode: status, success: true, data, message });
const fail = (res, status, message) =>
  res.status(status).json({ statusCode: status, success: false, message });

const HR_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER'];
const isHR = (req) => HR_ROLES.includes(req.user.role);
const STAGES = ['PRE_JOINING', 'ONBOARDING', 'PROBATION', 'CONFIRMED', 'NOTICE_PERIOD', 'EXITED', 'ALUMNI'];

const canTransition = (from, to) => {
  if (!STAGES.includes(to)) return false;
  if (from === to) return from === 'PROBATION'; // probation → probation = EXTEND
  if (from === 'EXITED') return to === 'ALUMNI';
  if (from === 'ALUMNI') return false;
  if (to === 'ALUMNI') return false;
  if (to === 'EXITED') return ['ONBOARDING', 'PROBATION', 'CONFIRMED', 'NOTICE_PERIOD'].includes(from);
  if (to === 'NOTICE_PERIOD') return ['ONBOARDING', 'PROBATION', 'CONFIRMED'].includes(from);
  return true;
};

const STAGE_EVENT = {
  ONBOARDING: 'ONBOARDING_STARTED',
  PROBATION: 'PROBATION_STARTED',
  CONFIRMED: 'CONFIRMED',
  NOTICE_PERIOD: 'NOTICE_STARTED',
  EXITED: 'EXITED',
  ALUMNI: 'ALUMNI_MARKED',
};

const notifyLife = async (userId, payload) => {
  try {
    if (userId) await notifySmart(userId, { category: 'LIFECYCLE', ...payload });
  } catch {}
};

const addMonths = (n) => new Date(Date.now() + n * 30 * 86400000);
const addDays = (n) => new Date(Date.now() + n * 86400000);

const getOrCreate = async (companyId, userId, actorId = null) => {
  let rec = await EmployeeLifecycle.findOne({ companyId, user: userId });
  if (rec) return rec;
  const u = await User.findById(userId).select('companyId status createdAt').lean();
  if (!u || String(u.companyId) !== String(companyId)) return null;
  rec = await EmployeeLifecycle.create({
    companyId,
    user: userId,
    stage: u.status === 'ACTIVE' ? 'CONFIRMED' : 'ONBOARDING',
    joinedOn: u.createdAt || new Date(),
    events: [{ type: 'JOINED', title: '🤝 Joined the company', at: u.createdAt || new Date(), by: actorId }],
  });
  return rec;
};

// create records for everyone missing one → overview/list show the whole company
const ensureAll = async (companyId) => {
  const [users, recs] = await Promise.all([
    User.find({ companyId }).select('_id status createdAt').lean(),
    EmployeeLifecycle.find({ companyId }).select('user').lean(),
  ]);
  const have = new Set(recs.map((r) => String(r.user)));
  const missing = users.filter((u) => !have.has(String(u._id)));
  if (missing.length) {
    await EmployeeLifecycle.insertMany(
      missing.map((u) => ({
        companyId,
        user: u._id,
        stage: u.status === 'ACTIVE' ? 'CONFIRMED' : 'ONBOARDING',
        joinedOn: u.createdAt || new Date(),
        events: [{ type: 'JOINED', title: '🤝 Joined the company', at: u.createdAt || new Date() }],
      }))
    );
  }
};

const populateJourney = (query) =>
  query
    .populate('user', 'name email role designation department status avatarUrl')
    .populate('events.by', 'name');

/* ── GET /lifecycle/my — employee's own journey ── */
export const myJourney = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const rec = await getOrCreate(req.companyId, req.user._id);
  if (!rec) return fail(res, 404, 'Lifecycle record not found');
  await populateJourney(rec.populate ? EmployeeLifecycle.findById(rec._id) : rec); // noop guard
  const fresh = await populateJourney(EmployeeLifecycle.findById(rec._id)).lean();
  // Data to frontend - response to frontend
  ok(res, 200, fresh, 'My journey');
});

/* ── GET /lifecycle/overview — HR: stage census + probation radar ── */
export const overview = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin can view the lifecycle overview');
  // DB Logic - DB logics
  await ensureAll(req.companyId);
  const recs = await EmployeeLifecycle.find({ companyId: req.companyId })
    .populate('user', 'name email role designation status')
    .lean();

  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  recs.forEach((r) => { counts[r.stage] = (counts[r.stage] || 0) + 1; });

  const soon = Date.now() + 30 * 86400000;
  const probationEnding = recs
    .filter((r) => r.stage === 'PROBATION' && r.probationEndsOn && new Date(r.probationEndsOn).getTime() <= soon)
    .map((r) => ({ lifecycleId: r._id, user: r.user, probationEndsOn: r.probationEndsOn }));

  // Data to frontend - response to frontend
  ok(res, 200, { counts, probationEnding, total: recs.length }, 'Lifecycle overview');
});

/* ── GET /lifecycle/company?stage= — HR: full list ── */
export const companyList = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin can view company lifecycles');
  // DB Logic - DB logics
  await ensureAll(req.companyId);
  const filter = { companyId: req.companyId };
  if (req.query.stage && STAGES.includes(req.query.stage)) filter.stage = req.query.stage;
  const recs = await EmployeeLifecycle.find(filter)
    .populate('user', 'name email role designation department status')
    .sort('-updatedAt')
    .limit(500)
    .lean();
  // Data to frontend - response to frontend
  ok(res, 200, recs, 'Company lifecycles');
});

/* ── GET /lifecycle/user/:userId — HR: one journey ── */
export const userJourney = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin can view employee journeys');
  // DB Logic - DB logics
  const rec = await getOrCreate(req.companyId, req.params.userId, req.user._id);
  if (!rec) return fail(res, 404, 'Employee not found in your company');
  const fresh = await populateJourney(EmployeeLifecycle.findById(rec._id)).lean();
  // Data to frontend - response to frontend
  ok(res, 200, fresh, 'Employee journey');
});

/* ── POST /lifecycle/user/:userId/stage — HR: move stage ── */
export const setStage = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin can change lifecycle stages');
  if (String(req.params.userId) === String(req.user._id)) return fail(res, 400, 'You cannot run lifecycle actions on yourself');

  const { to, note = '', probationMonths = 3, noticeDays = 30 } = req.body;
  // DB Logic - DB logics
  const rec = await getOrCreate(req.companyId, req.params.userId, req.user._id);
  if (!rec) return fail(res, 404, 'Employee not found in your company');

  if (!canTransition(rec.stage, to)) {
    return fail(res, 409, `Cannot move from ${rec.stage} → ${to}`);
  }

  const from = rec.stage;
  const isExtend = from === 'PROBATION' && to === 'PROBATION';

  if (to === 'ONBOARDING') { /* date hooks can join work-schedule later */ }
  if (to === 'PROBATION') rec.probationEndsOn = addMonths(Number(probationMonths) || 3);
  if (to === 'CONFIRMED') rec.confirmedOn = new Date();
  if (to === 'NOTICE_PERIOD') { rec.noticeStartedOn = new Date(); rec.noticeEndsOn = addDays(Number(noticeDays) || 30); }
  if (to === 'EXITED') { rec.exitedOn = new Date(); await User.findByIdAndUpdate(rec.user, { status: 'INACTIVE' }); }
  if (to === 'ALUMNI') rec.alumniSince = new Date();

  rec.stage = to;
  rec.events.push({
    type: isExtend ? 'PROBATION_EXTENDED' : STAGE_EVENT[to] || 'NOTE_ADDED',
    title: isExtend ? `⏳ Probation extended by ${probationMonths} month(s)` : `Stage: ${to.replaceAll('_', ' ')}`,
    note: note?.trim?.() || '',
    fromStage: from,
    toStage: to,
    by: req.user._id,
  });
  await rec.save();

  const messages = {
    ONBOARDING: ['🧳 Welcome aboard!', 'Your onboarding has started — watch your documents inbox 📥'],
    PROBATION: ['⏳ Probation started', `Your probation runs ~${probationMonths} month(s). All the best!`],
    CONFIRMED: ['🎉 Congratulations — confirmed!', 'Your employment is now confirmed. 🎓 Well deserved!'],
    NOTICE_PERIOD: ['📄 Notice period started', `Your notice period has started (~${noticeDays} days).`],
    EXITED: ['🚪 Exit completed', 'Your exit has been processed. Wishing you the best ahead!'],
    ALUMNI: ['🎓 Alumni', 'Final settlement completed — you are now part of our alumni network.'],
  }[to];
  notifyLife(rec.user, { title: messages[0], message: note ? `${messages[1]} — "${note}"` : messages[1], link: '/app/lifecycle' });

  const fresh = await populateJourney(EmployeeLifecycle.findById(rec._id)).lean();
  // Data to frontend - response to frontend
  ok(res, 200, fresh, `Moved to ${to}`);
});

/* ── POST /lifecycle/user/:userId/promote — HR: designation/role bump ── */
export const promote = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin can promote');
  if (String(req.params.userId) === String(req.user._id)) return fail(res, 400, 'You cannot promote yourself');

  const { designation = '', role = '', note = '' } = req.body;
  const ASSIGNABLE = ['EMPLOYEE', 'TEAM_LEAD', 'MANAGER', 'HR_MANAGER'];
  if (role && !ASSIGNABLE.includes(role)) return fail(res, 400, 'Invalid role');
  if (role === 'HR_MANAGER' && req.user.role !== 'COMPANY_ADMIN') {
    return fail(res, 403, 'Only the company admin can appoint an HR Manager');
  }
  if (!designation.trim() && !role) return fail(res, 400, 'Give a new designation and/or role');

  // DB Logic - DB logics
  const u = await User.findOne({ _id: req.params.userId, companyId: req.companyId }).select('name role designation');
  if (!u) return fail(res, 404, 'Employee not found in your company');

  const before = { role: u.role, designation: u.designation || '' };
  const $set = {};
  if (designation.trim()) $set.designation = designation.trim();
  if (role) $set.role = role;
  await User.findByIdAndUpdate(u._id, { $set });

  const rec = await getOrCreate(req.companyId, u._id, req.user._id);
  rec.events.push({
    type: 'PROMOTED',
    title: `🚀 Promoted${designation.trim() ? ` → ${designation.trim()}` : ''}${role && role !== before.role ? ` (${role.replace('_', ' ')})` : ''}`,
    note: note?.trim?.() || '',
    meta: { from: before, to: { role: role || before.role, designation: designation.trim() || before.designation } },
    by: req.user._id,
  });
  await rec.save();

  notifyLife(u._id, {
    title: '🚀 You have been promoted!',
    message: `New position: ${designation.trim() || before.designation || role}${note ? ` — "${note}"` : ''}`,
    link: '/app/lifecycle',
  });

  const fresh = await populateJourney(EmployeeLifecycle.findById(rec._id)).lean();
  // Data to frontend - response to frontend
  ok(res, 200, fresh, 'Promotion recorded 🚀');
});

/* ── POST /lifecycle/user/:userId/transfer — HR: department change ── */
export const transfer = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin can transfer');
  if (String(req.params.userId) === String(req.user._id)) return fail(res, 400, 'You cannot transfer yourself');

  const { departmentId, note = '' } = req.body;
  if (!departmentId) return fail(res, 400, 'Pick a department');

  // DB Logic - DB logics
  const [u, dept] = await Promise.all([
    User.findOne({ _id: req.params.userId, companyId: req.companyId }).select('name department'),
    Department.findOne({ _id: departmentId, companyId: req.companyId }).select('name'),
  ]);
  if (!u) return fail(res, 404, 'Employee not found in your company');
  if (!dept) return fail(res, 404, 'Department not found in your company');

  const beforeDept = u.department;
  await User.findByIdAndUpdate(u._id, { $set: { department: dept._id } });

  const rec = await getOrCreate(req.companyId, u._id, req.user._id);
  rec.events.push({
    type: 'TRANSFERRED',
    title: `🔄 Transferred → ${dept.name}`,
    note: note?.trim?.() || '',
    meta: { to: { departmentId: dept._id, department: dept.name }, from: { departmentId: beforeDept || null } },
    by: req.user._id,
  });
  await rec.save();

  notifyLife(u._id, {
    title: '🔄 Department transfer',
    message: `You have been transferred to ${dept.name}${note ? ` — "${note}"` : ''}`,
    link: '/app/lifecycle',
  });

  const fresh = await populateJourney(EmployeeLifecycle.findById(rec._id)).lean();
  // Data to frontend - response to frontend
  ok(res, 200, fresh, 'Transfer recorded 🔄');
});