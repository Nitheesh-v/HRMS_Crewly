import NotificationPref, { NOTIFY_CATEGORIES } from '../models/NotificationPref.js';
import asyncHandler from '../utils/asyncHandler.js';

const ok = (res, status, data, message) =>
  res.status(status).json({ statusCode: status, success: true, data, message });

// GET /api/notification-prefs  → my toggles (missing = all ON)
export const getMyPrefs = asyncHandler(async (req, res) => {
  // DB Logic - DB logics
  const pref = await NotificationPref.findOne({ user: req.user._id }).lean();
  // Data to frontend - response to frontend
  ok(res, 200, {
    inapp: pref?.inapp || {},
    email: pref?.email || {},
    categories: NOTIFY_CATEGORIES,
  }, 'Notification preferences fetched');
});

// PUT /api/notification-prefs  { inapp: {LEAVE:false,...}, email: {...} }
export const updateMyPrefs = asyncHandler(async (req, res) => {
  const clean = {};
  for (const key of ['inapp', 'email']) {
    const src = req.body?.[key];
    if (!src || typeof src !== 'object') continue;
    clean[key] = {};
    NOTIFY_CATEGORIES.forEach((c) => {
      if (typeof src[c] === 'boolean') clean[key][c] = src[c];
    });
  }
  // DB Logic - DB logics
  const pref = await NotificationPref.findOneAndUpdate(
    // Data from frontend - requests from frontend
    { user: req.user._id },
    { $set: { company: req.companyId, ...clean } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  // Data to frontend - response to frontend
  ok(res, 200, pref, 'Preferences saved');
});