// ─────────────────────────────────────────────────────────────
// notifySmart(userId, { title, message, link, category, emailText })
//
//   • resolves the RECIPIENT once (tenant + name + email)
//   • checks the user's NotificationPref (a missing key means ON)
//   • writes the in-app bell row through utils/notify.js — the one
//     owner of that write — with the recipient's OWN companyId
//   • queues background email, never awaited
//   • NEVER throws, NEVER blocks the request that raised it
//
// ── PHASE 39: WHAT THIS FILE USED TO DO, AND WHY THAT WAS WRONG ──
//
// The in-app path was a three-stage "self-healing cascade":
//
//   1. notifyUser(userId, payload)          ← wrong arity → throws
//   2. notifyUser({ user: userId, ... })    ← wrong arity → throws
//   3. writeViaTemplate()                   ← clone the newest
//                                             Notification row in the
//                                             ENTIRE DATABASE and
//                                             overwrite only
//                                             user/title/message/link
//
// notifyUser is `(companyId, user, payload)`. Both attempts passed two
// arguments, so the third destructured `undefined` and threw BEFORE
// notifyUser's own try/catch. Stage 3 therefore ran for EVERY in-app
// notification on the platform (31 call sites), and it copied whatever it
// found: another tenant's `companyId`, another category's `type`, another
// user's `eventKey`. It looked like it worked only because the bell reads by
// `user` alone.
//
// Two consequences were not cosmetic:
//   · `{ companyId, eventKey }` is a UNIQUE index — an inherited eventKey can
//     make a legitimate notification fail as a duplicate and vanish;
//   · with an empty notifications collection the template write returns false,
//     so every notifySmart notification on the platform stopped entirely.
//
// There is no safe version of "clone some existing row": a notification's
// tenant is not a default, it is identity. This file now resolves it.
// ─────────────────────────────────────────────────────────────

import logger from '../config/logger.js';

// ── lazy resolvers ───────────────────────────────────────────
// Kept from the original design: importing the models lazily means a missing
// model can never take down the process that merely wanted to ring a bell.
let _notifyUser = null;
let _notifyTried = false;
const resolveNotifyUser = async () => {
  if (_notifyTried) return _notifyUser;
  _notifyTried = true;
  try {
    const ns = await import('./notify.js');
    const fn = ns.notifyUser || (ns.default && ns.default.notifyUser) || ns.default;
    _notifyUser = typeof fn === 'function' ? fn : null;
  } catch (error) {
    _notifyUser = null;
    logger.warn(`📣 [notifySmart] cannot load utils/notify.js → ${error.message}`);
  }
  return _notifyUser;
};

let _Pref = null;
let _prefTried = false;
const resolvePrefModel = async () => {
  if (_prefTried) return _Pref;
  _prefTried = true;
  try {
    const ns = await import('../models/NotificationPref.js');
    _Pref = ns.default || ns.NotificationPref || null;
  } catch (error) {
    _Pref = null;
    logger.warn(`📣 [notifySmart] cannot load NotificationPref model → ${error.message}`);
  }
  return _Pref;
};

let _User = null;
let _userTried = false;
const resolveUserModel = async () => {
  if (_userTried) return _User;
  _userTried = true;
  try {
    const ns = await import('../models/User.js');
    _User = ns.default || ns.User || null;
  } catch {
    _User = null;
  }
  return _User;
};

let _queueEmail = null;
let _emailTried = false;
const resolveEmailQueue = async () => {
  if (_emailTried) return _queueEmail;
  _emailTried = true;
  try {
    const ns = await import('./emailQueue.js');
    _queueEmail = ns.queueEmail || ns.default || null;
  } catch (error) {
    _queueEmail = null;
    logger.warn(`📣 [notifySmart] cannot load utils/emailQueue.js → ${error.message}`);
  }
  return _queueEmail;
};

// A missing preference key means ON; only an explicit false mutes.
const isOn = (map, category) => {
  if (!map || !category) return true;
  const value = typeof map.get === 'function' ? map.get(category) : map[category];
  return value === undefined ? true : Boolean(value);
};

// Callers pass ids, but a populated document (or a raw ObjectId) reaches some
// of them; the write needs a plain id either way.
const normalizeUserId = (value) => String(value?._id || value || '').trim();

/**
 * Notify one person: in-app bell (respecting their preferences) + background email.
 *
 * @param {string|{_id:string}} userId  the RECIPIENT — their tenant is used
 * @param {{title:string, message?:string, link?:string, category?:string, emailText?:string}} payload
 * @returns {Promise<void>} always resolves; failures are logged, never thrown
 */
/**
 * The email decision for one recipient, as a pure function: what would be
 * queued, or null when there is nowhere to send it. Kept separate from the
 * queue so the decision is testable without starting the mail worker.
 */
export const buildEmailJob = ({ recipient, title, message, emailText } = {}) => {
  if (!recipient?.email || !title) return null;

  return { to: recipient.email, subject: title, text: emailText || message || title };
};

export const notifySmart = async (userId, { title, message, link, category, emailText } = {}) => {
  try {
    const recipientId = normalizeUserId(userId);

    if (!recipientId || !title) return;

    // ONE read answers both questions: which tenant does this row belong to,
    // and where would an email go. Phase 39 — the tenant is not optional, so a
    // recipient we cannot resolve is skipped instead of written with a guess.
    const User = await resolveUserModel();
    const recipient = User
      ? await User.findById(recipientId).select('name email companyId').lean()
      : null;

    if (!recipient?.companyId) {
      logger.warn(
        `📣 [notifySmart] no tenant for recipient ${recipientId} → notification skipped ("${title}")`,
      );
      return;
    }

    const companyId = recipient.companyId;

    let pref = null;
    const Pref = await resolvePrefModel();
    if (Pref) {
      try {
        pref = await Pref.findOne({ user: recipientId }).lean();
      } catch {
        // A preference lookup that fails means "no preferences" → everything on,
        // which is the same default as a user who never opened the settings page.
      }
    }

    // ── 1️⃣ IN-APP ────────────────────────────────────────────
    if (isOn(pref?.inapp, category)) {
      const notifyUser = await resolveNotifyUser();

      if (!notifyUser) {
        logger.warn(`📣 [notifySmart] in-app ✖ → ${recipientId} "${title}" (writer unavailable)`);
      } else {
        // The one and only write path. notifyUser swallows its own failures
        // (a bell that cannot ring must never fail the action that rang it),
        // so there is nothing to catch here.
        await notifyUser(companyId, recipientId, {
          type: category || 'SYSTEM',
          title,
          message,
          link,
        });
      }
    }

    // ── 2️⃣ EMAIL — background queue, never awaited ───────────
    if (isOn(pref?.email, category)) {
      try {
        const queueEmail = await resolveEmailQueue();
        const job = buildEmailJob({ recipient, title, message, emailText });

        if (queueEmail && job) queueEmail(job);
      } catch (error) {
        logger.warn(`📣 [notifySmart] email ✖ → ${error.message}`);
      }
    }
  } catch (error) {
    logger.warn(`📣 [notifySmart] failed → ${error.message}`);
  }
};

export default notifySmart;
