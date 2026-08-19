import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import useAuth from '../hooks/useAuth.jsx';
import subscriptionService from '../services/subscriptionService.js';

const DAY =
  24 * 60 * 60 * 1000;

const SubscriptionStatusBanner = () => {
  const { user } = useAuth();

  const [subscription, setSubscription] =
    useState(null);

  const [dismissed, setDismissed] =
    useState(false);

  useEffect(() => {
    let active = true;

    subscriptionService
      .current()
      .then((result) => {
        if (active) {
          setSubscription(
            result?.subscription ||
              null
          );
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  if (
    dismissed ||
    !subscription ||
    ![
      'COMPANY_ADMIN',
      'HR_MANAGER',
    ].includes(user?.role)
  ) {
    return null;
  }

  const status =
    subscription.status;

  const endTime =
    new Date(
      subscription.endDate
    ).getTime();

  const daysLeft =
    Number.isNaN(endTime)
      ? null
      : Math.ceil(
          (endTime -
            Date.now()) /
            DAY
        );

  const graceTime =
    subscription.graceEndsAt
      ? new Date(
          subscription.graceEndsAt
        ).getTime()
      : null;

  const graceDays =
    graceTime
      ? Math.max(
          0,
          Math.ceil(
            (graceTime -
              Date.now()) /
              DAY
          )
        )
      : null;

  let message = '';
  let tone =
    'border-amber-500/40 bg-amber-500/10 text-amber-200';

  if (
    [
      'EXPIRING',
      'EXPIRING_SOON',
    ].includes(status)
  ) {
    message =
      daysLeft === 1
        ? 'Your subscription expires tomorrow.'
        : `Your subscription expires in ${daysLeft} days.`;
  }

  if (status === 'PAST_DUE') {
    message =
      'Your payment could not be processed. Retry payment to avoid interruption.';

    tone =
      'border-red-500/40 bg-red-500/10 text-red-200';
  }

  if (
    status === 'GRACE_PERIOD'
  ) {
    message =
      `Your subscription has expired. ` +
      `You have ${graceDays ?? 0} day(s) remaining in the grace period.`;

    tone =
      'border-orange-500/40 bg-orange-500/10 text-orange-200';
  }

  if (status === 'EXPIRED') {
    message =
      'Your subscription has expired. Your company is currently in restricted mode.';

    tone =
      'border-red-500/40 bg-red-500/10 text-red-200';
  }

  if (status === 'SUSPENDED') {
    message =
      'Your subscription is suspended. Please contact Crewly support.';

    tone =
      'border-red-500/40 bg-red-500/10 text-red-200';
  }

  if (!message) return null;

  return (
    <div
      className={`mx-6 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${tone}`}
    >
      <div>
        <b>Subscription notice</b>
        <p>{message}</p>
      </div>

      <div className="flex gap-2">
        <Link
          to="/app/subscription"
          className="rounded-lg bg-white/10 px-3 py-2 font-semibold hover:bg-white/20"
        >
          Manage plan
        </Link>

        <button
          type="button"
          onClick={() =>
            setDismissed(true)
          }
          className="rounded-lg px-2 text-lg opacity-70 hover:opacity-100"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
};

export default SubscriptionStatusBanner;