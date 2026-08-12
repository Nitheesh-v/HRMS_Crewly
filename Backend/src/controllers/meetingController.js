import Meeting from '../models/Meeting.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { getScopedUserIds } from '../utils/scope.js';
import { getSubtreeIds } from '../utils/orgHelpers.js';
import { notifyUser } from '../utils/notify.js';

// Per your rule: HR joins meetings when INVITED — creation is for Admin / Manager / Team Lead
const CREATE_ROLES = ['COMPANY_ADMIN', 'MANAGER', 'TEAM_LEAD'];
const MANAGE_ROLES = ['COMPANY_ADMIN']; // edit/cancel/delete: creator or company admin

const ok = (res, status, data, message) =>
  res.status(status).json({ statusCode: status, success: true, data, message });

const notify = async (userId, payload) => {
  try {
    if (userId) await notifyUser(userId, payload);
  } catch (e) { /* notifications never block */ }
};

const canManage = (req, meeting) =>
  req.user.role === 'COMPANY_ADMIN' || String(meeting.createdBy) === String(req.user._id);

// ── THE VISIBILITY RULE (backend-enforced) ──────────────────────
// Frontend Sprint Meeting → Frontend TL + Frontend employees + Eng Manager.
// Backend employees shouldn't see it. Guaranteed here, not in the UI.
const visibilityFilter = (req) => {
  if (req.user.role === 'COMPANY_ADMIN') return { company: req.companyId };
  const or = [
    { createdBy: req.user._id },
    { participants: req.user._id },
    { type: 'COMPANY' },
  ];
  if (req.user.department) or.push({ type: 'DEPARTMENT', department: req.user.department });
  return { company: req.companyId, $or: or };
};

// ── recurring expansion: one stored meeting → many calendar occurrences ──
const expandOccurrence = (m, from, to) => {
  const base = m.toObject ? m.toObject() : m;
  const dur = new Date(base.endAt).getTime() - new Date(base.startAt).getTime();
  if (base.recurrence === 'NONE') {
    return [{ ...base, occStart: base.startAt, occEnd: base.endAt }];
  }
  const out = [];
  let t = new Date(base.startAt).getTime();
  const horizon = Math.min(to.getTime(), base.recurrenceEnd ? new Date(base.recurrenceEnd).getTime() : to.getTime());
  let guard = 0;
  while (t < horizon && guard++ < 400) {
    if (t + dur > from.getTime()) {
      out.push({ ...base, occStart: new Date(t).toISOString(), occEnd: new Date(t + dur).toISOString() });
    }
    if (base.recurrence === 'DAILY') t += 86400000;
    else if (base.recurrence === 'WEEKLY') t += 7 * 86400000;
    else { const d = new Date(t); d.setMonth(d.getMonth() + 1); t = d.getTime(); }
  }
  return out;
};

// GET /api/meetings?from&to  |  ?view=history
export const listMeetings = asyncHandler(async (req, res) => {
  const vis = visibilityFilter(req);

  if (req.query.view === 'history') {
    const now = new Date();
    const docs = await Meeting.find({
      $and: [vis, { $or: [{ endAt: { $lt: now } }, { status: 'CANCELLED' }] }],
    })
      .populate('participants', 'name role designation avatarUrl')
      .populate('createdBy', 'name role')
      .sort({ startAt: -1 })
      .limit(100);
    return ok(res, 200, docs, 'Meeting history fetched');
  }

  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 86400000);
  const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 45 * 86400000);

  const docs = await Meeting.find({
    $and: [
      vis,
      { status: 'SCHEDULED' },
      {
        $or: [
          { recurrence: 'NONE', startAt: { $lt: to }, endAt: { $gt: from } },
          {
            recurrence: { $ne: 'NONE' },
            startAt: { $lt: to },
            $or: [{ recurrenceEnd: null }, { recurrenceEnd: { $gte: from } }],
          },
        ],
      },
    ],
  })
    .populate('participants', 'name role designation avatarUrl')
    .populate('createdBy', 'name role')
    .sort({ startAt: 1 })
    .limit(200);

  const occurrences = docs.flatMap((m) => expandOccurrence(m, from, to));
  occurrences.sort((a, b) => new Date(a.occStart) - new Date(b.occStart));
  ok(res, 200, occurrences, 'Meetings fetched');
});

// POST /api/meetings  (Admin / Manager / Team Lead only)
export const createMeeting = asyncHandler(async (req, res) => {
  if (!CREATE_ROLES.includes(req.user.role)) {
    throw new ApiError(403, 'Only Company Admin, Managers and Team Leads can create meetings');
  }
  const {
    title, description = '', type = 'PRIVATE', departmentId,
    participantIds = [], startAt, endAt, link = '',
    recurrence = 'NONE', recurrenceEnd = null, reminderMinutes = 15,
  } = req.body;

  if (!title?.trim()) throw new ApiError(400, 'Meeting title is required');
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new ApiError(400, 'Start and end time are required');
  if (end <= start) throw new ApiError(400, 'End time must be after start time');

  // participants: dedupe + always include creator; TEAM type auto-adds the whole team (reports + self)
  let participants = [...new Set(participantIds.map(String))];
  participants.push(String(req.user._id));
  if (type === 'TEAM') {
    const team = await getSubtreeIds(req.companyId, req.user._id);
    participants = [...new Set([...participants, ...team.map(String)])];
  }

  // same-company validation (API-bypass proof)
  const found = await User.countDocuments({ _id: { $in: participants }, companyId: req.companyId });
  if (found !== participants.length) throw new ApiError(400, 'Every participant must belong to your company');

  // scope validation for non-admins: your scope + your own manager only
  if (req.user.role !== 'COMPANY_ADMIN') {
    const scope = await getScopedUserIds(req); // manager→dept, TL→reports+self
    const allowed = new Set([...(scope || []).map(String), String(req.user._id)]);
    if (req.user.reportingTo) allowed.add(String(req.user.reportingTo));
    const bad = participants.filter((p) => !allowed.has(p));
    if (bad.length) throw new ApiError(403, 'You can only invite people inside your team/department (plus your manager)');
  }

  const department = type === 'DEPARTMENT'
    ? (req.user.role === 'COMPANY_ADMIN' ? (departmentId || req.user.department || null) : (req.user.department || null))
    : null;

  const meeting = await Meeting.create({
    title: title.trim(), description, type,
    company: req.companyId, department,
    participants, createdBy: req.user._id,
    startAt: start, endAt: end, link,
    recurrence, recurrenceEnd: recurrenceEnd || null,
    reminderMinutes,
  });

  participants
    .filter((p) => p !== String(req.user._id))
    .forEach((p) => notify(p, {
      title: '📅 Meeting invite',
      message: `"${meeting.title}" — ${start.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
      link: '/app/meetings',
    }));

  ok(res, 201, meeting, 'Meeting created');
});

// PUT /api/meetings/:id  (creator or company admin)
export const updateMeeting = asyncHandler(async (req, res) => {
  const meeting = await Meeting.findOne({ _id: req.params.id, company: req.companyId });
  if (!meeting) throw new ApiError(404, 'Meeting not found');
  if (!canManage(req, meeting)) throw new ApiError(403, 'Only the organizer or company admin can edit this meeting');

  const { title, description, type, departmentId, participantIds, startAt, endAt, link, recurrence, recurrenceEnd, reminderMinutes } = req.body;
  if (title !== undefined) meeting.title = title.trim();
  if (description !== undefined) meeting.description = description;
  if (type) meeting.type = type;
  if (link !== undefined) meeting.link = link;
  if (reminderMinutes !== undefined) meeting.reminderMinutes = reminderMinutes;
  if (recurrence) meeting.recurrence = recurrence;
  if (recurrenceEnd !== undefined) meeting.recurrenceEnd = recurrenceEnd || null;

  if (startAt || endAt) {
    const start = startAt ? new Date(startAt) : meeting.startAt;
    const end = endAt ? new Date(endAt) : meeting.endAt;
    if (end <= start) throw new ApiError(400, 'End time must be after start time');
    meeting.startAt = start;
    meeting.endAt = end;
    meeting.reminderSent = false; // re-arm the reminder for the new time
  }

  if (participantIds !== undefined) {
    let participants = [...new Set(participantIds.map(String))];
    participants.push(String(meeting.createdBy));
    if (meeting.type === 'TEAM') {
      const team = await getSubtreeIds(req.companyId, meeting.createdBy);
      participants = [...new Set([...participants, ...team.map(String)])];
    }
    const found = await User.countDocuments({ _id: { $in: participants }, companyId: req.companyId });
    if (found !== participants.length) throw new ApiError(400, 'Every participant must belong to your company');
    meeting.participants = participants;
  }
  if (meeting.type === 'DEPARTMENT') {
    meeting.department = req.user.role === 'COMPANY_ADMIN' ? (departmentId || meeting.department) : (req.user.department || meeting.department);
  }

  await meeting.save();

  meeting.participants
    .filter((p) => String(p) !== String(req.user._id))
    .forEach((p) => notify(p, { title: '✏️ Meeting updated', message: `"${meeting.title}" details changed`, link: '/app/meetings' }));

  ok(res, 200, meeting, 'Meeting updated');
});

// PATCH /api/meetings/:id/cancel  (creator or company admin) — kept for history
export const cancelMeeting = asyncHandler(async (req, res) => {
  const meeting = await Meeting.findOne({ _id: req.params.id, company: req.companyId });
  if (!meeting) throw new ApiError(404, 'Meeting not found');
  if (!canManage(req, meeting)) throw new ApiError(403, 'Only the organizer or company admin can cancel this meeting');
  if (meeting.status === 'CANCELLED') throw new ApiError(400, 'Meeting is already cancelled');

  meeting.status = 'CANCELLED';
  meeting.cancelledAt = new Date();
  meeting.cancelReason = req.body.reason || '';
  await meeting.save();

  meeting.participants
    .filter((p) => String(p) !== String(req.user._id))
    .forEach((p) => notify(p, { title: '❌ Meeting cancelled', message: `"${meeting.title}"${meeting.cancelReason ? ` — ${meeting.cancelReason}` : ''}`, link: '/app/meetings' }));

  ok(res, 200, meeting, 'Meeting cancelled');
});

// DELETE /api/meetings/:id  (creator or company admin)
export const deleteMeeting = asyncHandler(async (req, res) => {
  const meeting = await Meeting.findOne({ _id: req.params.id, company: req.companyId });
  if (!meeting) throw new ApiError(404, 'Meeting not found');
  if (!canManage(req, meeting)) throw new ApiError(403, 'Only the organizer or company admin can delete this meeting');
  await meeting.deleteOne();
  ok(res, 200, { id: req.params.id }, 'Meeting deleted');
});

// ── ⏰ REMINDER SCHEDULER (starts once with the app; ticks every 60s) ──
if (!global.__crewlyMeetingReminders) {
  global.__crewlyMeetingReminders = true;
  setInterval(async () => {
    try {
      const now = Date.now();
      const candidates = await Meeting.find({
        status: 'SCHEDULED',
        reminderSent: false,
        startAt: { $gte: new Date(now - 3600000), $lte: new Date(now + 3600000) },
      }).select('title participants startAt reminderMinutes createdBy');
      candidates.forEach((m) => {
        const leadMs = (m.reminderMinutes || 15) * 60000;
        const due = new Date(m.startAt).getTime() - leadMs;
        if (now >= due && now < new Date(m.startAt).getTime()) {
          m.participants.forEach((p) => notify(p, {
            title: '⏰ Meeting starting soon',
            message: `"${m.title}" starts at ${new Date(m.startAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`,
            link: '/app/meetings',
          }));
          m.reminderSent = true;
          m.save().catch(() => {});
        }
      });
    } catch (e) { /* scheduler must never crash the app */ }
  }, 60000);
}