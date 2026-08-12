// src/utils/notifyPref.js  (v3 — bulletproof)
// 🔔 notifySmart(userId, { title, message, link, category, emailText })
//    • checks the user's NotificationPref (missing key = ON)
//    • in-app write via 3-stage self-healing cascade
//    • background email queue — never blocks the API
//    • NEVER throws, NEVER crashes the server, logs everything 📣

let _notifyUser = null, _notifyTried = false;
const resolveNotifyUser = async () => {
  if (_notifyTried) return _notifyUser;
  _notifyTried = true;
  try {
    const ns = await import('./notify.js');
    const fn = ns.notifyUser || (ns.default && ns.default.notifyUser) || ns.default;
    _notifyUser = typeof fn === 'function' ? fn : null;
  } catch (e) {
    _notifyUser = null;
    console.warn('📣 [notifySmart] cannot load utils/notify.js →', e.message);
  }
  return _notifyUser;
};

let _Pref = null, _prefTried = false;
const resolvePrefModel = async () => {
  if (_prefTried) return _Pref;
  _prefTried = true;
  try {
    const ns = await import('../models/NotificationPref.js');
    _Pref = ns.default || ns.NotificationPref || null;
  } catch (e) {
    _Pref = null;
    console.warn('📣 [notifySmart] cannot load NotificationPref model →', e.message);
  }
  return _Pref;
};

let _Notification = null, _notifTried = false;
const resolveNotificationModel = async () => {
  if (_notifTried) return _Notification;
  _notifTried = true;
  try {
    const ns = await import('../models/Notification.js');
    _Notification = ns.default || ns.Notification || null;
  } catch {
    _Notification = null;
    console.warn('📣 [notifySmart] Notification model not found at models/Notification.js');
  }
  return _Notification;
};

let _User = null, _userTried = false;
const resolveUserModel = async () => {
  if (_userTried) return _User;
  _userTried = true;
  try {
    const ns = await import('../models/User.js');
    _User = ns.default || ns.User || null;
  } catch { _User = null; }
  return _User;
};

let _queueEmail = null, _emailTried = false;
const resolveEmailQueue = async () => {
  if (_emailTried) return _queueEmail;
  _emailTried = true;
  try {
    const ns = await import('./emailQueue.js');
    _queueEmail = ns.queueEmail || ns.default || null;
  } catch (e) {
    _queueEmail = null;
    console.warn('📣 [notifySmart] cannot load utils/emailQueue.js →', e.message);
  }
  return _queueEmail;
};

const isOn = (map, category) => {
  if (!map || !category) return true;
  const v = typeof map.get === 'function' ? map.get(category) : map[category];
  return v === undefined ? true : !!v;
};

// ── Stage C: clone a real (meeting-proven) notification as a schema template ──
const writeViaTemplate = async (userId, { title, message, link }) => {
  const Notification = await resolveNotificationModel();
  if (!Notification) return false;
  const sample = await Notification.findOne({}).sort('-createdAt').lean();
  if (!sample) return false;

  const doc = { ...sample };
  delete doc._id; delete doc.__v; delete doc.createdAt; delete doc.updatedAt;

  Object.keys(doc).forEach((k) => {
    const lk = k.toLowerCase();
    if (['user', 'recipient', 'userid', 'to'].includes(lk)) doc[k] = userId;
    else if (lk === 'title' || lk === 'subject') doc[k] = title;
    else if (lk === 'message' || lk === 'body' || lk === 'text') doc[k] = message || title;
    else if (lk === 'link' || lk === 'url' || lk === 'href') doc[k] = link || '';
    else if (lk === 'read' || lk === 'isread' || lk === 'seen' || lk === 'isseen') doc[k] = false;
    else if (lk === 'readat' || lk === 'seenat') doc[k] = null;
  });

  await Notification.create(doc);
  return true;
};

export const notifySmart = async (userId, { title, message, link, category, emailText } = {}) => {
  try {
    if (!userId || !title) return;

    let pref = null;
    const Pref = await resolvePrefModel();
    if (Pref) { try { pref = await Pref.findOne({ user: userId }).lean(); } catch {} }

    // 1️⃣ IN-APP — cascade: A) positional +type → B) object-style → C) template clone
    if (isOn(pref?.inapp, category)) {
      let delivered = null;
      let lastErr = null;

      const notifyUser = await resolveNotifyUser();
      if (notifyUser) {
        const types = [category, 'SYSTEM', 'MEETING'].filter((t, i, a) => t && a.indexOf(t) === i);
        for (const t of types) {
          try {
            await notifyUser(userId, { type: t, title, message, link });
            delivered = `positional type=${t}`;
            break;
          } catch (e) { lastErr = e; }
        }
        if (!delivered) {
          try {
            await notifyUser({ user: userId, type: category || 'SYSTEM', title, message, link });
            delivered = 'object-style';
          } catch (e) { lastErr = e; }
        }
      }

      if (!delivered) {
        try {
          if (await writeViaTemplate(userId, { title, message, link })) delivered = 'template-clone ⚠️';
        } catch (e) { lastErr = e; }
      }

      if (delivered) console.log(`📣 [notifySmart] in-app ✔  → ${userId} "${title}"  (${delivered})`);
      else console.warn(`📣 [notifySmart] in-app ✖  → ${userId} "${title}" →`, lastErr?.message || 'no write path');
    } else {
      console.log(`📣 [notifySmart] in-app muted by prefs → ${userId} "${title}"`);
    }

    // 2️⃣ EMAIL — background queue, never awaited
    if (isOn(pref?.email, category)) {
      try {
        const queueEmail = await resolveEmailQueue();
        const User = await resolveUserModel();
        if (queueEmail && User) {
          const u = await User.findById(userId).select('name email').lean();
          if (u?.email) queueEmail({ to: u.email, subject: title, text: emailText || message || title });
        }
      } catch (e) {
        console.warn('📣 [notifySmart] email ✖ →', e.message);
      }
    }
  } catch (e) {
    console.warn('📣 [notifySmart] failed →', e.message);
  }
};

export default notifySmart;