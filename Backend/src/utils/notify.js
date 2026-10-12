// ─────────────────────────────────────────────────────────────
// notify helpers — NEVER throw; notification failure must not
// break the main request.
//   notifyUser(companyId, userId, payload)
//   notifyRoles(companyId, [roles], payload)  → everyone w/ role
// ─────────────────────────────────────────────────────────────
import { isValidObjectId } from 'mongoose';
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

// 34.3 — batch variant, for events that fan out to a handful of named people
// (chat mentions). ONE insertMany instead of N round trips, and the same law as
// notifyUser: it NEVER throws, so a bell that cannot ring can never fail the
// action that wanted to ring it.
export const notifyUsers = async (companyId, userIds, { type = 'SYSTEM', title, message = '', link = '' }) => {
  try {
    // Phase 39 — a batch is all-or-nothing at the driver: ONE id that cannot be
    // cast to an ObjectId makes insertMany throw, and the catch below then drops
    // the whole batch (every recipient loses the notification). Ids are trimmed
    // and validated here so a stray value loses only itself.
    const recipients = [
      ...new Set(
        (userIds ?? [])
          .map((value) => String(value?._id ?? value ?? '').trim())
          .filter((value) => isValidObjectId(value)),
      ),
    ];

    if (recipients.length === 0) return 0;

    await Notification.insertMany(
      recipients.map((user) => ({ companyId, user, type, title, message, link }))
    );

    return recipients.length;
  } catch (err) {
    logger.warn(`🔔 notifyUsers failed: ${err.message}`);

    return 0;
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