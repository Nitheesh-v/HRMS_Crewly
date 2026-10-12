import Meeting, { MEETING_TYPES, RECURRENCE } from '../models/Meeting.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { getScopedUserIds } from '../utils/scope.js';
import { getSubtreeIds } from '../utils/orgHelpers.js';
import { notifyUser } from '../utils/notify.js';
import { parseMeetingLink } from '../utils/meetingLink.js';

// Per your rule: HR joins meetings when INVITED — creation is for Admin / Manager / Team Lead
const CREATE_ROLES = ['COMPANY_ADMIN', 'MANAGER', 'TEAM_LEAD'];
const MANAGE_ROLES = ['COMPANY_ADMIN']; // edit/cancel/delete: creator or company admin

const ok = (res, status, data, message) =>
  res.status(status).json({ statusCode: status, success: true, data, message });

// notifyUser(companyId, user, payload) — three arguments. Passing only
// (userId, payload) made the third argument `undefined`, so the destructuring
// in notifyUser threw BEFORE its own try/catch and the controller's catch
// swallowed it: every invite, update, cancel and reminder was silently
// dropped. The company id is not decoration, it is half of the notification's
// identity (Notification.companyId is what scopes the bell to a tenant).
const notify = async (companyId, userId, payload) => {
  try {
    if (companyId && userId) await notifyUser(companyId, userId, payload);
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
  // Data from frontend - requests from frontend
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

  // DB Logic - DB logics
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
  // Data to frontend - response to frontend
  ok(res, 200, occurrences, 'Meetings fetched');
});

// POST /api/meetings  (Admin / Manager / Team Lead only)
export const createMeeting = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!CREATE_ROLES.includes(req.user.role)) {
    throw new ApiError(403, 'Only Company Admin, Managers and Team Leads can create meetings');
  }
  const {
    title, description = '', type = 'PRIVATE', departmentId,
    participantIds = [], startAt, endAt, link = '',
    recurrence = 'NONE', recurrenceEnd = null, reminderMinutes = 15,
  } = req.body;

  if (!title?.trim()) throw new ApiError(400, 'Meeting title is required');
  if (!MEETING_TYPES.includes(type)) throw new ApiError(400, 'Unknown meeting type');
  if (!RECURRENCE.includes(recurrence)) throw new ApiError(400, 'Unknown repeat option');
  if (type === 'COMPANY' && req.user.role !== 'COMPANY_ADMIN') {
    throw new ApiError(403, 'Only a Company Admin can schedule a company-wide meeting');
  }
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new ApiError(400, 'Start and end time are required');
  if (end <= start) throw new ApiError(400, 'End time must be after start time');

  // A scheme-less link ("meet.google.com/abc") is a relative path to a browser,
  // so it is normalised to https before it is ever stored, and anything that is
  // not a normal web address is refused instead of saved broken.
  const parsedLink = parseMeetingLink(link);
  if (parsedLink.error) throw new ApiError(400, parsedLink.error);

  // participants: dedupe + always include creator; TEAM type auto-adds the whole team (reports + self)
  let participants = [...new Set(participantIds.map(String))];
  participants.push(String(req.user._id));
  if (type === 'TEAM') {
    const team = await getSubtreeIds(req.companyId, req.user._id);
    participants = [...new Set([...participants, ...team.map(String)])];
  }

  // same-company validation (API-bypass proof)
  // DB Logic - DB logics
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
    startAt: start, endAt: end, link: parsedLink.link,
    recurrence, recurrenceEnd: recurrenceEnd || null,
    reminderMinutes,
  });

  participants
    .filter((p) => p !== String(req.user._id))
    .forEach((p) => notify(req.companyId, p, {
      title: '📅 Meeting invite',
      message: `"${meeting.title}" — ${start.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
      link: '/app/meetings',
    }));

  // Data to frontend - response to frontend
  ok(res, 201, meeting, 'Meeting created');
});

// PUT /api/meetings/:id  (creator or company admin)
export const updateMeeting = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const meeting = await Meeting.findOne({ _id: req.params.id, company: req.companyId });
  if (!meeting) throw new ApiError(404, 'Meeting not found');
  // Data from frontend - requests from frontend
  if (!canManage(req, meeting)) throw new ApiError(403, 'Only the organizer or company admin can edit this meeting');

  const { title, description, type, departmentId, participantIds, startAt, endAt, link, recurrence, recurrenceEnd, reminderMinutes } = req.body;
  const tenantId = meeting.company || meeting.companyId || req.companyId;

  // The validations createMeeting has always done and updateMeeting never did.
  // Without them an empty title reached save(), where `required` + `trim` threw
  // a Mongoose ValidationError — a 500 the client can only render as "Could not
  // save meeting". A bad request has to answer as a bad request (400), with a
  // message the person editing can act on.
  if (title !== undefined) {
    const trimmed = String(title).trim();
    if (!trimmed) throw new ApiError(400, 'Meeting title is required');
    meeting.title = trimmed;
  }
  if (description !== undefined) meeting.description = description;
  if (type !== undefined) {
    if (!MEETING_TYPES.includes(type)) throw new ApiError(400, 'Unknown meeting type');
    if (type === 'COMPANY' && req.user.role !== 'COMPANY_ADMIN') {
      throw new ApiError(403, 'Only a Company Admin can schedule a company-wide meeting');
    }
    meeting.type = type;
  }
  if (link !== undefined) {
    const parsedLink = parseMeetingLink(link);
    if (parsedLink.error) throw new ApiError(400, parsedLink.error);
    meeting.link = parsedLink.link;
  }
  if (reminderMinutes !== undefined) {
    const minutes = Number(reminderMinutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 10080) {
      throw new ApiError(400, 'Remind minutes must be between 0 and 10080');
    }
    meeting.reminderMinutes = minutes;
  }
  if (recurrence !== undefined) {
    if (!RECURRENCE.includes(recurrence)) throw new ApiError(400, 'Unknown repeat option');
    meeting.recurrence = recurrence;
    // A meeting that stopped repeating must not keep a stale "repeat until".
    if (recurrence === 'NONE') meeting.recurrenceEnd = null;
  }
  if (recurrenceEnd !== undefined) {
    if (recurrenceEnd === null || recurrenceEnd === '') {
      meeting.recurrenceEnd = null;
    } else {
      const parsedRecurrenceEnd = new Date(recurrenceEnd);
      if (Number.isNaN(parsedRecurrenceEnd.getTime())) {
        throw new ApiError(400, 'Repeat-until is not a valid date');
      }
      meeting.recurrenceEnd = parsedRecurrenceEnd;
    }
  }

  if (startAt || endAt) {
    const start = startAt ? new Date(startAt) : meeting.startAt;
    const end = endAt ? new Date(endAt) : meeting.endAt;
    if (Number.isNaN(new Date(start).getTime()) || Number.isNaN(new Date(end).getTime())) {
      throw new ApiError(400, 'Start and end time must be valid dates');
    }
    if (end <= start) throw new ApiError(400, 'End time must be after start time');
    meeting.startAt = start;
    meeting.endAt = end;
    meeting.reminderSent = false; // re-arm the reminder for the new time
  }

  if (participantIds !== undefined) {
    if (!Array.isArray(participantIds)) throw new ApiError(400, 'Participants must be a list of employees');
    let participants = [...new Set(participantIds.map(String))];
    participants.push(String(meeting.createdBy));
    const found = await User.countDocuments({ _id: { $in: participants }, companyId: req.companyId });
    if (found !== participants.length) throw new ApiError(400, 'Every participant must belong to your company');
    meeting.participants = participants;
  }

  // A TEAM meeting owns its roster: the organizer's whole subtree is derived
  // server-side. That used to run only when participants were edited too, so
  // switching a private meeting to TEAM saved the label without the team —
  // while the modal promises "Your whole team is added automatically".
  if (meeting.type === 'TEAM') {
    const team = await getSubtreeIds(req.companyId, meeting.createdBy);
    const merged = [
      ...new Set([...meeting.participants.map(String), String(meeting.createdBy), ...team.map(String)]),
    ];
    if (merged.length !== meeting.participants.length) meeting.participants = merged;
  }

  if (meeting.type === 'DEPARTMENT') {
    meeting.department = req.user.role === 'COMPANY_ADMIN' ? (departmentId || meeting.department) : (req.user.department || meeting.department);
  }

  await meeting.save();

  meeting.participants
    .filter((p) => String(p) !== String(req.user._id))
    .forEach((p) => notify(tenantId, p, { title: '✏️ Meeting updated', message: `"${meeting.title}" details changed`, link: '/app/meetings' }));

  // Data to frontend - response to frontend
  ok(res, 200, meeting, 'Meeting updated');
});

// PATCH /api/meetings/:id/cancel  (creator or company admin) — kept for history
export const cancelMeeting = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const meeting = await Meeting.findOne({ _id: req.params.id, company: req.companyId });
  if (!meeting) throw new ApiError(404, 'Meeting not found');
  // Data from frontend - requests from frontend
  if (!canManage(req, meeting)) throw new ApiError(403, 'Only the organizer or company admin can cancel this meeting');
  if (meeting.status === 'CANCELLED') throw new ApiError(400, 'Meeting is already cancelled');

  meeting.status = 'CANCELLED';
  meeting.cancelledAt = new Date();
  meeting.cancelReason = req.body.reason || '';
  await meeting.save();

  meeting.participants
    .filter((p) => String(p) !== String(req.user._id))
    .forEach((p) => notify(meeting.company || meeting.companyId || req.companyId, p, { title: '❌ Meeting cancelled', message: `"${meeting.title}"${meeting.cancelReason ? ` — ${meeting.cancelReason}` : ''}`, link: '/app/meetings' }));

  // Data to frontend - response to frontend
  ok(res, 200, meeting, 'Meeting cancelled');
});

// DELETE /api/meetings/:id  (creator or company admin)
export const deleteMeeting = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const meeting = await Meeting.findOne({ _id: req.params.id, company: req.companyId });
  if (!meeting) throw new ApiError(404, 'Meeting not found');
  // Data from frontend - requests from frontend
  if (!canManage(req, meeting)) throw new ApiError(403, 'Only the organizer or company admin can delete this meeting');
  await meeting.deleteOne();
  // Data to frontend - response to frontend
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
      }).select('title participants startAt reminderMinutes createdBy company');
      candidates.forEach((m) => {
        const leadMs = (m.reminderMinutes || 15) * 60000;
        const due = new Date(m.startAt).getTime() - leadMs;
        if (now >= due && now < new Date(m.startAt).getTime()) {
          m.participants.forEach((p) => notify(m.company, p, {
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