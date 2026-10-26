// ============================================================
// 🎯 PERFORMANCE CONTROLLER (Phase: Performance Management)
// Cycle (HR) → goals → progress → self review → TL review →
// manager review → close = weighted final rating + history.
// Final rating weights: Manager 50% · TL 30% · Self 20%
// ============================================================
import * as CycleNS from '../models/PerformanceCycle.js';
import * as AppraisalNS from '../models/Appraisal.js';
import * as UserNS from '../models/User.js';
import * as LifecycleNS from '../models/EmployeeLifecycle.js';
import asyncHandler from '../utils/asyncHandler.js';
import { getSubtreeIds } from '../utils/orgHelpers.js';
import { notifySmart } from '../utils/notifyPref.js';

const pickModel = (ns) => (typeof ns.default === 'function' ? ns.default : ns.default || ns);
const PerformanceCycle = pickModel(CycleNS);
const Appraisal = pickModel(AppraisalNS);
const User = pickModel(UserNS);
const EmployeeLifecycle = pickModel(LifecycleNS);

const ok = (res, status, data, message) =>
  res.status(status).json({ statusCode: status, success: true, data, message });
const fail = (res, status, message) =>
  res.status(status).json({ statusCode: status, success: false, message });

const HR_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER'];
const SENIORS = ['COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD'];
const isHR = (req) => HR_ROLES.includes(req.user.role);
const PHASES = ['GOAL_SETTING', 'ACTIVE', 'SELF_REVIEW', 'REVIEW', 'CLOSED'];
const CYCLE_METHODOLOGIES = ['STANDARD', 'THREE_SIXTY', 'OKR'];
const RATING_WEIGHTS = [['selfReview', 0.2], ['tlReview', 0.3], ['mgrReview', 0.5]];

const notifyPerf = async (userId, payload) => {
  try {
    if (userId) await notifySmart(userId, { category: 'PERFORMANCE', ...payload });
  } catch {}
};

const validRating = (r) => Number.isFinite(Number(r)) && Number(r) >= 1 && Number(r) <= 5;

const loadCycle = async (req, id) => {
  const cycle = await PerformanceCycle.findOne({ _id: id || req.params.id, companyId: req.companyId });
  return cycle;
};

/* Probation is two facts in this product, and both are real: the lifecycle
   record says the stage, and — when a company has not opened the lifecycle
   page yet — a date of joining inside the first 90 days says the same thing.
   A cohort that only honoured the first would silently include everyone at a
   company that never set a stage. */
const PROBATION_DAYS = 90;
const probationIds = async (companyId) => {
  const [stageRows, joined] = await Promise.all([
    EmployeeLifecycle.find({ companyId, stage: 'PROBATION' }).select('user').lean(),
    User.find({ companyId, status: 'ACTIVE', dateOfJoining: { $ne: null } })
      .select('_id dateOfJoining')
      .lean(),
  ]);
  const ids = new Set((stageRows || []).map((row) => String(row.user)));
  const cutoff = Date.now() - PROBATION_DAYS * 24 * 60 * 60 * 1000;
  for (const user of joined || []) {
    const joinedAt = new Date(user.dateOfJoining).getTime();
    if (Number.isFinite(joinedAt) && joinedAt > cutoff) ids.add(String(user._id));
  }
  return ids;
};

// enroll every ACTIVE company user in a cycle (idempotent)
const enrollAll = async (companyId, cycleId, options = {}) => {
  const skip = options.skip instanceof Set ? options.skip : new Set();
  const users = await User.find({ companyId, status: 'ACTIVE' }).select('_id').lean();
  const have = await Appraisal.find({ companyId, cycle: cycleId }).select('user').lean();
  const set = new Set(have.map((a) => String(a.user)));
  const missing = users.filter((u) => !set.has(String(u._id)) && !skip.has(String(u._id)));
  if (missing.length) {
    await Appraisal.insertMany(
      missing.map((u) => ({ companyId, cycle: cycleId, user: u._id })),
      { ordered: false }
    ).catch(() => {});
  }
};

const currentOrLatestCycle = async (companyId) => {
  const open = await PerformanceCycle.findOne({ companyId, status: { $ne: 'CLOSED' } }).sort('-createdAt');
  if (open) return open;
  return PerformanceCycle.findOne({ companyId }).sort('-createdAt');
};

// employee sees review bodies ONLY after the cycle closes (before: just flags)
const serializeForOwner = (app, cycle) => {
  const a = app.toObject ? app.toObject() : app;
  if (cycle.status === 'CLOSED') return a;
  const flag = (r) => ({ submitted: Boolean(r?.at), rating: null, feedback: '', by: null, at: r?.at || null });
  return { ...a, tlReview: flag(a.tlReview), mgrReview: flag(a.mgrReview), finalRating: null };
};

/* ── GET /perf/cohort — who a new round would enroll (HR only) ──
   The create screen shows a head-count before anything is written, so the
   number on the button is the number of people it will actually enroll. */
export const cycleCohort = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin see the participant cohort');

  // DB Logic - DB logics
  const [active, probation] = await Promise.all([
    User.find({ companyId: req.companyId, status: 'ACTIVE' }).select('_id').lean(),
    probationIds(req.companyId),
  ]);
  const onProbation = (active || []).filter((u) => probation.has(String(u._id)));
  const departments = await User.find({ companyId: req.companyId, status: 'ACTIVE' })
    .populate('department', 'name')
    .select('department')
    .lean();
  const byDepartment = {};
  for (const row of departments || []) {
    const name = row.department?.name || 'No department';
    byDepartment[name] = (byDepartment[name] || 0) + 1;
  }

  // Data to frontend - response to frontend
  ok(res, 200, {
    total: (active || []).length,
    onProbation: onProbation.length,
    byDepartment: Object.entries(byDepartment)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    probationWindowDays: PROBATION_DAYS,
  }, 'Cohort');
});

/* ── POST /perf/cycles — HR starts a cycle ── */
export const createCycle = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin can start a performance cycle');
  const {
    name,
    startDate = '',
    endDate = '',
    methodology = 'STANDARD',
    selfReviewDueAt = '',
    managerReviewDueAt = '',
    calibrationDueAt = '',
    excludeProbation = false,
    notifyParticipants = true,
  } = req.body;
  if (!name?.trim()) return fail(res, 400, 'Cycle name is required (e.g. "H2 2026")');

  /* Every date arrives as a plain 'YYYY-MM-DD' string, the same shape the
     model stores. Anything else is rejected rather than half-saved — a
     milestone that parses as Invalid Date on the client is worse than a
     clear "that date is not a date". */
  const dateFields = { startDate, endDate, selfReviewDueAt, managerReviewDueAt, calibrationDueAt };
  for (const [field, value] of Object.entries(dateFields)) {
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      return fail(res, 400, `${field} must be a date (YYYY-MM-DD)`);
    }
  }
  const methodologyValue = CYCLE_METHODOLOGIES.includes(methodology) ? methodology : 'STANDARD';
  const skipProbation = excludeProbation === true;
  const shouldNotify = notifyParticipants !== false;

  // DB Logic - DB logics
  const skip = skipProbation ? await probationIds(req.companyId) : new Set();
  const cycle = await PerformanceCycle.create({
    companyId: req.companyId,
    name: name.trim(),
    startDate,
    endDate,
    methodology: methodologyValue,
    selfReviewDueAt,
    managerReviewDueAt,
    calibrationDueAt,
    excludeProbation: skipProbation,
    notifyParticipants: shouldNotify,
    createdBy: req.user._id,
  });
  await enrollAll(req.companyId, cycle._id, { skip });

  // 🔔 fan-out — every teammate gets the call to set goals (unless the admin
  // turned the notifications off, or left them out of the cohort)
  if (shouldNotify) {
    const cohort = await Appraisal.find({ companyId: req.companyId, cycle: cycle._id })
      .select('user')
      .lean();
    const recipients = (cohort || [])
      .map((row) => String(row.user))
      .filter((id) => id !== String(req.user._id));
    Promise.all(
      recipients.map((id) =>
        notifyPerf(id, {
          title: '🎯 New performance cycle',
          message: `"${cycle.name}" has started — set your goals & KPIs now`,
          link: '/app/performance',
        })
      )
    ).catch(() => {});
  }

  // Data to frontend - response to frontend
  ok(res, 201, cycle, 'Cycle created — everyone enrolled 🎯');
});

/* ── GET /perf/cycles — everyone ── */
export const listCycles = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const cycles = await PerformanceCycle.find({ companyId: req.companyId }).sort('-createdAt').limit(24).lean();
  const current = await currentOrLatestCycle(req.companyId);
  // Data to frontend - response to frontend
  ok(res, 200, { cycles, currentId: current?._id || null }, 'Cycles');
});

/* ── PATCH /perf/cycles/:id/status — HR advances the phase ── */
export const transitionCycle = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin can move a cycle');
  const { to } = req.body;
  // DB Logic - DB logics
  const cycle = await loadCycle(req);
  if (!cycle) return fail(res, 404, 'Cycle not found');

  const next = PHASES[PHASES.indexOf(cycle.status) + 1];
  if (to !== next) return fail(res, 409, `Next phase must be "${next}" (current: ${cycle.status})`);

  cycle.status = to;

  if (to === 'CLOSED') {
    cycle.closedAt = new Date();
    const apps = await Appraisal.find({ companyId: req.companyId, cycle: cycle._id });
    for (const a of apps) {
      const parts = RATING_WEIGHTS.filter(([key]) => a[key]?.rating);
      if (parts.length) {
        const totalW = parts.reduce((s, [, w]) => s + w, 0);
        const score = parts.reduce((s, [key, w]) => s + a[key].rating * w, 0) / totalW;
        a.finalRating = Math.round(score * 10) / 10;
      }
      a.status = 'CLOSED';
      await a.save();
      notifyPerf(a.user, {
        title: '⭐ Final rating published',
        message: a.finalRating
          ? `"${cycle.name}" is closed — your final rating is ${a.finalRating}/5. See the feedback!`
          : `"${cycle.name}" has closed (no completed reviews).`,
        link: '/app/performance',
      });
    }
  } else {
    // phase announcements
    const texts = {
      ACTIVE: ['💼 Work period started', `"${cycle.name}" — track progress on your goals`],
      SELF_REVIEW: ['📝 Self-review open', `"${cycle.name}" — submit your self review`],
      REVIEW: ['🧑‍⚖️ Review phase', `"${cycle.name}" — reviews are with your TL/Manager now`],
    }[to];
    User.find({ companyId: req.companyId, status: 'ACTIVE' })
      .select('_id')
      .lean()
      .then((users) =>
        users.forEach((u) => notifyPerf(u._id, { title: texts[0], message: texts[1], link: '/app/performance' }))
      )
      .catch(() => {});
  }

  await cycle.save();
  // Data to frontend - response to frontend
  ok(res, 200, cycle, `Cycle moved to ${to}`);
});

/* ── POST /perf/cycles/:id/enroll — HR re-syncs new joiners ── */
export const enrollMissing = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!isHR(req)) return fail(res, 403, 'Only HR or the company admin can enroll');
  // DB Logic - DB logics
  const cycle = await loadCycle(req);
  if (!cycle) return fail(res, 404, 'Cycle not found');
  await enrollAll(req.companyId, cycle._id);
  // Data to frontend - response to frontend
  ok(res, 200, { ok: true }, 'Everyone enrolled');
});

/* ── GET /perf/cycles/:id/my — employee's own appraisal (lazy) ── */
export const myAppraisal = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const cycle = (await loadCycle(req)) || (await currentOrLatestCycle(req.companyId));
  if (!cycle) return fail(res, 404, 'No performance cycle yet — HR will start one');

  let app = await Appraisal.findOne({ companyId: req.companyId, cycle: cycle._id, user: req.user._id });
  if (!app) {
    if (cycle.status === 'CLOSED') return fail(res, 404, 'You were not part of this cycle');
    app = await Appraisal.create({ companyId: req.companyId, cycle: cycle._id, user: req.user._id }).catch(async () =>
      Appraisal.findOne({ companyId: req.companyId, cycle: cycle._id, user: req.user._id })
    );
  }
  // Data to frontend - response to frontend
  ok(res, 200, { appraisal: serializeForOwner(app, cycle), cycle }, 'My appraisal');
});

/* ── PUT /perf/appraisals/:id/goals — owner sets goals (GOAL_SETTING/ACTIVE) ── */
export const saveGoals = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const app = await Appraisal.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!app) return fail(res, 404, 'Appraisal not found');
  // Data from frontend - requests from frontend
  if (String(app.user) !== String(req.user._id) && !isHR(req)) return fail(res, 403, 'Only the owner can set goals');

  const cycle = await PerformanceCycle.findById(app.cycle).lean();
  if (!cycle || !['GOAL_SETTING', 'ACTIVE'].includes(cycle.status)) {
    return fail(res, 409, 'Goals are locked after the work period starts rolling');
  }

  const goals = (Array.isArray(req.body?.goals) ? req.body.goals : [])
    .filter((g) => g?.title?.trim())
    .slice(0, 12)
    .map((g) => ({
      title: g.title.trim(),
      kpi: (g.kpi || '').trim(),
      weight: Math.min(100, Math.max(0, Number(g.weight) || 0)),
      progress: Math.min(100, Math.max(0, Number(g.progress) || 0)),
      note: (g.note || '').trim(),
    }));
  if (!goals.length) return fail(res, 400, 'Add at least one goal');

  app.goals = goals;
  app.status = cycle.status === 'ACTIVE' ? 'IN_PROGRESS' : 'GOALS';
  await app.save();
  // Data to frontend - response to frontend
  ok(res, 200, app, `${goals.length} goal(s) saved`);
});

/* ── PATCH /perf/appraisals/:id/goals/:goalId/progress — owner, work period ── */
export const goalProgress = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const app = await Appraisal.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!app) return fail(res, 404, 'Appraisal not found');
  // Data from frontend - requests from frontend
  if (String(app.user) !== String(req.user._id)) return fail(res, 403, 'Only the owner updates progress');

  const cycle = await PerformanceCycle.findById(app.cycle).lean();
  if (cycle?.status !== 'ACTIVE') return fail(res, 409, 'Progress tracking opens in the work period');

  const goal = app.goals.id(req.params.goalId);
  if (!goal) return fail(res, 404, 'Goal not found');
  goal.progress = Math.min(100, Math.max(0, Number(req.body?.progress) || 0));
  if (req.body?.note !== undefined) goal.note = String(req.body.note).slice(0, 300);
  app.status = 'IN_PROGRESS';
  await app.save();
  // Data to frontend - response to frontend
  ok(res, 200, app, 'Progress updated');
});

/* ── POST /perf/appraisals/:id/self-review — owner, SELF_REVIEW phase ── */
export const submitSelfReview = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const app = await Appraisal.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!app) return fail(res, 404, 'Appraisal not found');
  // Data from frontend - requests from frontend
  if (String(app.user) !== String(req.user._id)) return fail(res, 403, 'Only the owner submits the self review');

  const cycle = await PerformanceCycle.findById(app.cycle).lean();
  if (cycle?.status !== 'SELF_REVIEW') return fail(res, 409, 'Self-review phase is not open');

  const { summary = '', rating } = req.body;
  if (!summary.trim()) return fail(res, 400, 'Write a short summary of your work');
  if (!validRating(rating)) return fail(res, 400, 'Rating must be 1–5');

  app.selfReview = { summary: summary.trim(), rating: Number(rating), submittedAt: new Date() };
  app.status = 'SELF_SUBMITTED';
  await app.save();

  const reviewer = req.user.reportingTo
    ? await User.findById(req.user.reportingTo).select('_id').lean()
    : null;
  notifyPerf(reviewer?._id, {
    title: '📝 Self-review submitted',
    message: `${req.user.name} submitted their self-review for "${cycle.name}"`,
    link: '/app/performance',
  });

  // Data to frontend - response to frontend
  ok(res, 200, app, 'Self-review submitted ✅');
});

/* ── POST /perf/appraisals/:id/review — TL/Mgr/HR review (REVIEW phase) ── */
export const submitReview = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!SENIORS.includes(req.user.role)) return fail(res, 403, 'Only reviewers can submit reviews');

  // DB Logic - DB logics
  const app = await Appraisal.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!app) return fail(res, 404, 'Appraisal not found');

  const cycle = await PerformanceCycle.findById(app.cycle).lean();
  if (cycle?.status !== 'REVIEW') return fail(res, 409, 'Review phase is not open');
  if (String(app.user) === String(req.user._id)) return fail(res, 400, 'You cannot review yourself');

  // decide the slot: TEAM_LEAD → tlReview; MANAGER/HR/ADMIN → mgrReview
  const slot = req.user.role === 'TEAM_LEAD' ? 'tlReview' : 'mgrReview';

  // scope enforcement: HR/Admin anywhere; others only within their subtree
  if (!isHR(req)) {
    const subtree = await getSubtreeIds(req.companyId, req.user._id);
    if (!subtree.map(String).includes(String(app.user))) {
      return fail(res, 403, 'This employee is not in your team');
    }
  }

  const { rating, feedback = '' } = req.body;
  if (!validRating(rating)) return fail(res, 400, 'Rating must be 1–5');
  if (app[slot]?.at) return fail(res, 409, 'You already reviewed this employee');

  app[slot] = { rating: Number(rating), feedback: feedback.trim(), by: req.user._id, at: new Date() };
  if (slot === 'tlReview') app.status = app.mgrReview?.at ? 'MGR_DONE' : 'TL_DONE';
  else app.status = 'MGR_DONE';
  await app.save();

  // chain ping: TL reviewed → ping the employee's manager (skip the TL himself)
  if (slot === 'tlReview') {
    const emp = await User.findById(app.user).select('reportingTo').lean();
    let mgrId = emp?.reportingTo;
    if (mgrId && String(mgrId) === String(req.user._id)) {
      const tl = await User.findById(req.user._id).select('reportingTo').lean();
      mgrId = tl?.reportingTo || null;
    }
    notifyPerf(mgrId, {
      title: '🧑‍⚖️ TL review done — your turn',
      message: `${req.user.name} finished a TL review in "${cycle.name}"`,
      link: '/app/performance',
    });
  }

  // Data to frontend - response to frontend
  ok(res, 200, app, `${slot === 'tlReview' ? 'Team Lead' : 'Manager'} review saved ✅`);
});

/* ── GET /perf/cycles/:id/team — seniors' review board ── */
export const teamBoard = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!SENIORS.includes(req.user.role)) return fail(res, 403, 'Only seniors can view the team board');

  // DB Logic - DB logics
  const cycle = await loadCycle(req);
  if (!cycle) return fail(res, 404, 'Cycle not found');

  let filter = { companyId: req.companyId, cycle: cycle._id };
  if (!isHR(req)) {
    const scope = await getSubtreeIds(req.companyId, req.user._id);
    filter.user = { $in: scope.filter((id) => String(id) !== String(req.user._id)) };
  }

  const apps = await Appraisal.find(filter)
    .populate('user', 'name email role designation avatarUrl')
    .sort('status')
    .limit(500)
    .lean();

  // Data to frontend - response to frontend
  ok(res, 200, { appraisals: apps, cycle }, 'Team board');
});

/* ── GET /perf/history?userId= — final ratings across cycles ── */
export const history = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  const targetId = req.query.userId || String(req.user._id);
  if (targetId !== String(req.user._id) && !isHR(req)) {
    return fail(res, 403, 'Only HR can view other people\'s history');
  }
  // DB Logic - DB logics
  const rows = await Appraisal.find({
    companyId: req.companyId,
    user: targetId,
    status: 'CLOSED',
  })
    .populate('cycle', 'name startDate endDate closedAt')
    .sort('-updatedAt')
    .limit(30)
    .lean();
  // Data to frontend - response to frontend
  ok(res, 200, rows, 'Performance history');
});