import Subscription from '../models/Subscription.js';
import User from '../models/User.js';
import { notifySmart } from './notifyPref.js';

const DAY = 86400000;

const checkOnce = async () => {
  try {
    const horizon = Date.now() + 3 * DAY;
    const subs = await Subscription.find({}).lean();
    for (const s of subs) {
      // works with whichever expiry field this doc has
      const end = s.currentPeriodEnd || s.endsAt || s.validTill || s.trialEndsAt || s.endDate;
      if (!end) continue;
      const t = new Date(end).getTime();
      if (Number.isNaN(t) || t < Date.now() || t > horizon) continue; // only: alive but expiring ≤3 days

      const companyId = s.company || s.companyId;
      if (!companyId) continue;
      const admins = await User.find({ role: 'COMPANY_ADMIN', companyId }).select('_id').lean();
      const daysLeft = Math.max(1, Math.ceil((t - Date.now()) / DAY));
      admins.forEach((a) => {
        notifySmart(a._id, {
          title: '⏳ Subscription expiring soon',
          message: `Your ${s.plan || 'current'} plan expires in ${daysLeft} day(s) — renew from Billing & Plans.`,
          link: '/app/billing',
          category: 'BILLING',
        });
      });
    }
  } catch (e) { /* watchdog must never crash the app */ }
};

// runs once ~10s after boot, then once a day
if (!global.__crewlySubWatchdog) {
  global.__crewlySubWatchdog = true;
  setTimeout(() => { checkOnce(); setInterval(checkOnce, DAY); }, 10000);
}