import Subscription from "../models/Subscription.js";
import PlatformSettings from "../models/PlatformSettings.js";
import SystemEvent from "../models/SystemEvent.js";
import User from "../models/User.js";
import { recordHistory } from "./subscriptionEngine.js";
import { notifySmart } from "./notifyPref.js";

const DAY = 24 * 60 * 60 * 1000;

const DEFAULT_REMINDERS = [30, 15, 7, 3, 1];

const notifyAdmins = async (companyId, payload) => {
  try {
    const admins = await User.find({
      companyId,
      role: "COMPANY_ADMIN",
      status: "ACTIVE",
    })
      .select("_id")
      .lean();

    await Promise.all(
      admins.map((admin) =>
        notifySmart(admin._id, {
          category: "BILLING",

          ...payload,
        }),
      ),
    );
  } catch (error) {
    console.warn("[subscription-notification]", error.message);
  }
};

const sendReminder = async (subscription, daysLeft) => {
  const endDate = new Date(subscription.endDate).toISOString().slice(0, 10);

  const eventKey =
    `${subscription._id}:` + `EXPIRY:${daysLeft}:` + `${endDate}`;

  const history = await recordHistory({
    subscription,
    event: "REMINDER_SENT",

    eventKey,

    reason: `Expiration reminder: ${daysLeft} day(s)`,

    metadata: {
      daysLeft,
      endDate,
    },
  });

  // Duplicate event key means reminder was already sent.
  if (!history) return;

  await notifyAdmins(subscription.company, {
    title: "⏳ Subscription expiring",

    message:
      `Your ${subscription.plan} ` +
      `subscription expires in ` +
      `${daysLeft} day(s).`,

    link: "/app/subscription",
  });

  await SystemEvent.create({
    type: "SUBSCRIPTION_EXPIRING",

    level: daysLeft <= 3 ? "WARNING" : "INFO",

    title: "Subscription expiring",

    message: `${subscription.plan} expires ` + `in ${daysLeft} day(s)`,

    companyId: subscription.company,

    targetType: "Subscription",

    targetId: subscription._id,

    metadata: {
      daysLeft,
      endDate,
    },
  });
};

export const runSubscriptionLifecycle = async () => {
  const settings = await PlatformSettings.findOne({
    key: "GLOBAL",
  }).lean();

  const graceDays = settings?.subscription?.gracePeriodDays ?? 7;

  const pastDueDays = settings?.subscription?.pastDueDays ?? 3;

  const defaultBehavior =
    settings?.subscription?.expirationBehavior || "READ_ONLY";

  const reminders = settings?.subscription?.reminderDays?.length
    ? settings.subscription.reminderDays
    : DEFAULT_REMINDERS;

  const now = Date.now();

  const subscriptions = await Subscription.find({
    status: {
      $nin: ["CANCELLED", "SUSPENDED"],
    },
  });

  for (const subscription of subscriptions) {
    const endTime = new Date(subscription.endDate).getTime();

    if (Number.isNaN(endTime)) {
      continue;
    }

    const daysLeft = Math.ceil((endTime - now) / DAY);

    if (daysLeft > 0) {
      if (
        daysLeft <= 30 &&
        !["TRIAL", "PAST_DUE"].includes(subscription.status)
      ) {
        subscription.status = "EXPIRING";

        await subscription.save();
      }

      if (reminders.includes(daysLeft)) {
        await sendReminder(subscription, daysLeft);
      }

      continue;
    }

    // Failed recurring payment enters PAST_DUE first.
    if (
      subscription.paymentStatus === "FAILED" &&
      subscription.status !== "PAST_DUE"
    ) {
      const previous = subscription.toObject();

      subscription.status = "PAST_DUE";

      subscription.pastDueAt = new Date();

      subscription.pastDueEndsAt = new Date(now + pastDueDays * DAY);

      await subscription.save();

      await recordHistory({
        subscription,
        event: "SUBSCRIPTION_PAST_DUE",

        reason: "Recurring payment failed",

        previousState: previous,

        newState: subscription.toObject(),
      });

      await notifyAdmins(subscription.company, {
        title: "⚠️ Payment failed",

        message:
          "Your payment could not be processed. Please retry from Billing.",

        link: "/app/billing",
      });

      continue;
    }

    if (
      subscription.status === "PAST_DUE" &&
      new Date(subscription.pastDueEndsAt).getTime() > now
    ) {
      continue;
    }

    const graceEndsAt =
      subscription.graceEndsAt || new Date(endTime + graceDays * DAY);

    subscription.graceEndsAt = graceEndsAt;

    subscription.expirationBehavior =
      subscription.expirationBehavior || defaultBehavior;

    if (graceDays > 0 && now <= new Date(graceEndsAt).getTime()) {
      if (subscription.status !== "GRACE_PERIOD") {
        const previous = subscription.toObject();

        subscription.status = "GRACE_PERIOD";

        await subscription.save();

        await recordHistory({
          subscription,
          event: "SUBSCRIPTION_EXPIRED",

          reason: "Subscription entered grace period",

          previousState: previous,

          newState: subscription.toObject(),
        });

        await notifyAdmins(subscription.company, {
          title: "⚠️ Grace period",

          message:
            `Your subscription expired. ` +
            `Renew before ` +
            `${new Date(graceEndsAt).toLocaleDateString("en-IN")}.`,

          link: "/app/subscription",
        });
      }

      continue;
    }

    if (subscription.status !== "EXPIRED") {
      const previous = subscription.toObject();

      subscription.status = "EXPIRED";

      subscription.readOnly = true;

      await subscription.save();

      await recordHistory({
        subscription,
        event: "SUBSCRIPTION_EXPIRED",

        reason: "Grace period ended",

        previousState: previous,

        newState: subscription.toObject(),
      });

      await notifyAdmins(subscription.company, {
        title: "⛔ Subscription expired",

        message: "Your company is now in read-only mode.",

        link: "/app/subscription",
      });

      await SystemEvent.create({
        type: "SUBSCRIPTION_EXPIRED",

        level: "WARNING",

        title: "Subscription expired",

        message: `${subscription.plan} ` + `subscription expired`,

        companyId: subscription.company,

        targetType: "Subscription",

        targetId: subscription._id,
      });
    }
  }
};

export const startSubscriptionLifecycle = () => {
  if (global.__crewlyPhase20Lifecycle) {
    return;
  }

  global.__crewlyPhase20Lifecycle = true;

  setTimeout(() => {
    runSubscriptionLifecycle().catch(() => {});

    setInterval(() => runSubscriptionLifecycle().catch(() => {}), DAY);
  }, 10000);
};
