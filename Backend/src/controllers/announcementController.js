// ============================================================
// 📢 ANNOUNCEMENT CONTROLLER
// POST /api/announcements  (COMPANY_ADMIN / HR_MANAGER)
// GET  /api/announcements  (everyone in the company)
// DELETE /api/announcements/:id (poster or company admin)
// 🔔 Phase 13 — fans out to every teammate via notifySmart (respects mute prefs)
// ============================================================

import * as AnnouncementNS from '../models/Announcement.js';
import * as UserNS from '../models/User.js';
import * as asyncHandlerNS from '../utils/asyncHandler.js';
import { notifySmart } from '../utils/notifyPref.js';

const pickModel = (ns) => (typeof ns.default === 'function' ? ns.default : ns.default || ns);
const mergeExports = (ns) => ({ ...ns, ...(ns.default && typeof ns.default === 'object' ? ns.default : {}) });

const Announcement = pickModel(AnnouncementNS);
const User = pickModel(UserNS);
const asyncHandler = typeof asyncHandlerNS.default === 'function' ? asyncHandlerNS.default : asyncHandlerNS.asyncHandler;

// 🔔 safe wrapper — never throws, never blocks the workflow
const notifyAnn = async (userId, payload) => {
  try {
    if (userId) await notifySmart(userId, payload);
  } catch {}
};

const POSTERS = ['COMPANY_ADMIN', 'HR_MANAGER'];

const createAnnouncement = asyncHandler(async (req, res) => {
  // Data from frontend - requests from frontend
  if (!POSTERS.includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Only HR or the company admin can post announcements' });
  }
  const { title, body, pinned = false } = req.body;
  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ success: false, message: 'title and body are required' });
  }
  // DB Logic - DB logics
  const ann = await Announcement.create({
    companyId: req.companyId,
    title: title.trim(),
    body: body.trim(),
    pinned: Boolean(pinned),
    postedBy: req.user._id,
  });

  // 🔔 Phase 13 — per-user fan-out (skips the poster + deactivated accounts)
  User.find({
    companyId: req.companyId,
    _id: { $ne: req.user._id },
    status: { $nin: ['INACTIVE', 'DEACTIVATED', 'DISABLED', 'SUSPENDED'] },
  })
    .select('_id')
    .lean()
    .then((users) =>
      users.forEach((u) =>
        notifyAnn(u._id, {
          title: '📢 New announcement',
          message: ann.title,
          link: '/app/announcements',
          category: 'ANNOUNCEMENT',
          emailText: `${req.user.name || 'Your company'} posted a new announcement: ${ann.title}`,
        })
      )
    )
    .catch(() => {});

  const populated = await ann.populate('postedBy', 'name role');
  // Data to frontend - response to frontend
  res.status(201).json(
    { success: true, 
      message: 'Announcement posted 📢',
      data: populated }
  );
});

const listAnnouncements = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const list = await Announcement.find({ companyId: req.companyId })
    .populate('postedBy', 'name role')
    .sort({ pinned: -1, createdAt: -1 })
    .limit(50)
    .lean();
  // Data to frontend - response to frontend
  res.json({ success: true, data: list });
});

const deleteAnnouncement = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const ann = await Announcement.findOne({ _id: req.params.id, companyId: req.companyId });
  if (!ann) return res.status(404).json({ success: false, message: 'Announcement not found' });
  // Data from frontend - requests from frontend
  const isPoster = String(ann.postedBy) === String(req.user._id);
  if (!isPoster && req.user.role !== 'COMPANY_ADMIN') {
    return res.status(403).json({ success: false, message: 'Only the poster or company admin can delete' });
  }
  await ann.deleteOne();
  // Data to frontend - response to frontend
  res.json({ success: true, message: 'Announcement deleted', data: { id: ann._id } });
});

export { createAnnouncement, listAnnouncements, deleteAnnouncement };
export default { createAnnouncement, listAnnouncements, deleteAnnouncement };