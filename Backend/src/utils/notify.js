// ─────────────────────────────────────────────────────────────
// notify helpers — NEVER throw; notification failure must not
// break the main request.
//   notifyUser(companyId, userId, payload)
//   notifyRoles(companyId, [roles], payload)  → everyone w/ role
// ─────────────────────────────────────────────────────────────
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import logger from '../config/logger.js';

export const notifyUser = async (companyId, user, { type = 'SYSTEM', title, message = '', link = '' }) => {
  try {
    await Notification.create({ companyId, user, type, title, message, link });
  } catch (err) {
    logger.warn(`🔔 notifyUser failed: ${err.message}`);
  }
};

export const notifyRoles = async (companyId, roles, payload) => {
  try {
    const users = await User.find({ companyId, role: { $in: roles }, status: 'ACTIVE' }).select('_id');
    if (!users.length) return;
    await Notification.insertMany(
      users.map((u) => ({ companyId, user: u._id, type: payload.type || 'SYSTEM', title: payload.title, message: payload.message || '', link: payload.link || '' }))
    );
  } catch (err) {
    logger.warn(`🔔 notifyRoles failed: ${err.message}`);
  }
};