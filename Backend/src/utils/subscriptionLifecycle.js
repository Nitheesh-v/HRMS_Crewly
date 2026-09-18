import Subscription from "../models/Subscription.js";
import PlatformSettings from "../models/PlatformSettings.js";
import SystemEvent from "../models/SystemEvent.js";
import User from "../models/User.js";
import { recordHistory } from "./subscriptionEngine.js";
import { notifySmart } from "./notifyPref.js";
import { invalidateSubscriptionGateCache } from "./subscriptionGateCache.js";

const DAY = 24 * 60 * 60 * 1000;

const DEFAULT_REMINDERS = [30, 15, 7, 3, 1];

// ============================================================
//  PHASE 32.1 — MULTI-INSTANCE SAFE SUBSCRIPTION LIFECYCLE.
//
//  This scheduler intentionally runs inside EVERY API process
//  (10s after boot + daily — process-owned by design). With more
//  than one API instance the runs overlap, so every STATUS
//  TRANSITION is now an atomic Mongo compare-and-set claim:
//
//    findOneAndUpdate({ _id, <old-state guard> }, { $set }, { new: true })
//
//  Exactly one instance wins a given transition; the loser reads
//  `null` and silently skips the side effects (SubscriptionHistory,
//  admin notifications, SystemEvent). Reminders were already
//  deduplicated by the unique sparse SubscriptionHistory.eventKey
//  index and stay unchanged.
//
//  Behavioral parity with the previous read-check-save loop is
//  exact for a single instance: same statuses, same history
//  events, same notification copy, same ordering. The only
//  observable difference is that concurrent duplicate runs can no
//  longer produce duplicate audit rows / notifications.
//
//  All collaborators are injectable (hermetic tests); the defaults
//  are the real production dependencies.
// ============================================================

const snapshot = (doc) =>
  typeof doc?.toObject === "function" ? doc.toObject() : { ...doc };

export const runSubscriptionLifecycle = async (collaborators = {}) => {
  const {
    SubscriptionModel = Subscription,
    PlatformSettingsModel = PlatformSettings,
    SystemEventModel = SystemEvent,
    UserModel = User,
    recordHistoryFn = recordHistory,
    notifyFn = notifySmart,
    invalidateGateCacheFn = invalidateSubscriptionGateCache,
    nowMs = null,
  } = collaborators;

  const notifyAdmins = async (companyId, payload) => {
    try {
      const admins = await UserModel.find({
        companyId,
        role: "COMPANY_ADMIN",
        status: "ACTIVE",
      })
        .select("_id")
        .lean();

      await Promise.all(
        admins.map((admin) =>
          notifyFn(admin._id, {
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

    const history = await recordHistoryFn({
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
        `Your ${subscription.plan} ` + `subscription expires in ` +
        `${daysLeft} day(s).`,

      link: "/app/subscription",
    });

    await SystemEventModel.create({
      type: "SUBSCRIPTION_EXPIRING",

      level: daysLeft <= 3 ? "WARNING" : "INFO",

      title: "Subscription expiring",

      message: `${subscription.plan} expires ` + `${daysLeft} day(s)`,

      companyId: subscription.company,

      targetType: "Subscription",

      targetId: subscription._id,

      metadata: {
        daysLeft,
        endDate,
      },
    });
  };

  // Atomic transition claim: wins at most once per (subscription,
  // old-state guard). Returns the updated document for the winner,
  // null when another instance already performed the transition.
  const claimTransition = async (subscriptionId, guard, update) => {
    const claimed = await SubscriptionModel.findOneAndUpdate(
      {
        _id: subscriptionId,

        ...guard,
      },
      {
        $set: update,
      },
      {
        new: true,
      },
    );

    if (claimed) {
      // The document-save hook does not fire on query updates, so the
      // winner re-validates the process gate cache explicitly (same
      // same-process semantics the previous save() path had).
      invalidateGateCacheFn(claimed.company);
    }

    return claimed;
  };

  const settings = await PlatformSettingsModel.findOne({
    key: "GLOBAL",
  }).lean();

  const graceDays = settings?.subscription?.gracePeriodDays ?? 7;

  const pastDueDays = settings?.subscription?.pastDueDays ?? 3;

  const defaultBehavior =
    settings?.subscription?.expirationBehavior || "READ_ONLY";

  const reminders = settings?.subscription?.reminderDays?.length
    ? settings.subscription.reminderDays
    : DEFAULT_REMINDERS;

  const now = nowMs ?? Date.now();

  const subscriptions = await SubscriptionModel.find({
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
        // Winner-only write; no history/notification for EXPIRING
        // (exactly the previous behavior).
        await claimTransition(
          subscription._id,
          {
            status: {
              $nin: ["TRIAL", "PAST_DUE", "EXPIRING"],
            },
          },
          {
            status: "EXPIRING",
          },
        );
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
      const previous = snapshot(subscription);

      const claimed = await claimTransition(
        subscription._id,
        {
          paymentStatus: "FAILED",

          status: {
            $ne: "PAST_DUE",
          },
        },
        {
          status: "PAST_DUE",

          pastDueAt: new Date(now),

          pastDueEndsAt: new Date(now + pastDueDays * DAY),
        },
      );

      // Another instance already claimed this transition — its side
      // effects (history + notification) already happened exactly once.
      if (!claimed) {
        continue;
      }

      await recordHistoryFn({
        subscription: claimed,
        event: "SUBSCRIPTION_PAST_DUE",

        reason: "Recurring payment failed",

        previousState: previous,

        newState: snapshot(claimed),
      });

      await notifyAdmins(claimed.company, {
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

    const expirationBehavior =
      subscription.expirationBehavior || defaultBehavior;

    if (graceDays > 0 && now <= new Date(graceEndsAt).getTime()) {
      if (subscription.status !== "GRACE_PERIOD") {
        const previous = snapshot(subscription);

        const claimed = await claimTransition(
          subscription._id,
          {
            status: {
              $ne: "GRACE_PERIOD",
            },
          },
          {
            status: "GRACE_PERIOD",

            graceEndsAt,

            expirationBehavior,
          },
        );

        if (!claimed) {
          continue;
        }

        await recordHistoryFn({
          subscription: claimed,
          event: "SUBSCRIPTION_EXPIRED",

          reason: "Subscription entered grace period",

          previousState: previous,

          newState: snapshot(claimed),
        });

        await notifyAdmins(claimed.company, {
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
      const previous = snapshot(subscription);

      const claimed = await claimTransition(
        subscription._id,
        {
          status: {
            $ne: "EXPIRED",
          },
        },
        {
          status: "EXPIRED",

          readOnly: true,

          graceEndsAt,

          expirationBehavior,
        },
      );

      if (!claimed) {
        continue;
      }

      await recordHistoryFn({
        subscription: claimed,
        event: "SUBSCRIPTION_EXPIRED",

        reason: "Grace period ended",

        previousState: previous,

        newState: snapshot(claimed),
      });

      await notifyAdmins(claimed.company, {
        title: "⛔ Subscription expired",

        message: "Your company is now in read-only mode.",

        link: "/app/billing",
      });

      await SystemEventModel.create({
        type: "SUBSCRIPTION_EXPIRED",

        level: "WARNING",

        title: "Subscription expired",

        message: `${claimed.plan} ` + `subscription expired`,

        companyId: claimed.company,

        targetType: "Subscription",

        targetId: claimed._id,
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
