/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useState } from 'react';
import {
  Link,
  useNavigate,
} from 'react-router-dom';
import useAuth from '../../hooks/useAuth.jsx';
import subscriptionService from '../../services/subscriptionService.js';

const panel =
  'rounded-xl border border-slate-700 bg-slate-900 p-4';

const btn =
  'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50';

const ghost =
  'rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-indigo-500';

const money = (value) =>
  `₹${Number(
    value || 0
  ).toLocaleString('en-IN')}`;

const date = (value) =>
  value
    ? new Date(
        value
      ).toLocaleDateString(
        'en-IN'
      )
    : '—';

const bytes = (mb) => {
  const value =
    Number(mb || 0);

  if (value >= 1024) {
    return `${(
      value / 1024
    ).toFixed(1)} GB`;
  }

  return `${value} MB`;
};

const Progress = ({
  label,
  used,
  limit,
  format = (value) => value,
}) => {
  const percentage =
    limit > 0
      ? Math.min(
          100,
          Math.round(
            (used / limit) * 100
          )
        )
      : 0;

  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span className="text-slate-400">
          {label}
        </span>

        <span>
          {format(used)} /{' '}
          {limit === null
            ? 'Unlimited'
            : format(limit)}
        </span>
      </div>

      <div className="h-2 rounded-full bg-slate-800">
        <div
          className={`h-2 rounded-full ${
            percentage >= 90
              ? 'bg-red-500'
              : percentage >= 70
                ? 'bg-amber-500'
                : 'bg-indigo-500'
          }`}
          style={{
            width: `${percentage}%`,
          }}
        />
      </div>

      <p className="mt-1 text-right text-xs text-slate-500">
        {percentage}% used
      </p>
    </div>
  );
};

const SubscriptionPage = () => {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [current, setCurrent] =
    useState(null);

  const [plans, setPlans] =
    useState([]);

  const [history, setHistory] =
    useState([]);

  const [invoices, setInvoices] =
    useState([]);

  const [quote, setQuote] =
    useState(null);

  const [busy, setBusy] =
    useState(false);

  const [message, setMessage] =
    useState('');

  const isCompanyAdmin =
    user?.role ===
    'COMPANY_ADMIN';

  const load = async () => {
    setMessage('');

    try {
      const [
        currentResult,
        planResult,
        invoiceResult,
        historyResult,
      ] = await Promise.all([
        subscriptionService.current(),

        subscriptionService.plans(),

        subscriptionService
          .invoices()
          .catch(() => []),

        subscriptionService
          .history()
          .catch(() => []),
      ]);

      setCurrent(
        currentResult
      );

      setPlans(
        Array.isArray(
          planResult?.plans
        )
          ? planResult.plans
          : []
      );

      setInvoices(
        Array.isArray(
          invoiceResult
        )
          ? invoiceResult
          : []
      );

      setHistory(
        Array.isArray(
          historyResult
        )
          ? historyResult
          : []
      );
    } catch (error) {
      setMessage(
        error?.message ||
          'Could not load subscription'
      );
    }
  };

  useEffect(() => {
    load();
  }, []);

  const requestPlan = async (
    plan
  ) => {
    setBusy(true);
    setMessage('');

    try {
      const result =
        await subscriptionService
          .quote({
            plan:
              plan.internalCode,

            billingCycle:
              current.subscription
                .billingCycle,
          });

      setQuote({
        ...result,
        selectedPlan:
          plan,
      });
    } catch (error) {
      const violations =
        error?.response?.data
          ?.data?.violations;

      setMessage(
        violations?.length
          ? violations
              .map(
                (item) =>
                  `${item.resource}: ${item.used}/${item.limit}`
              )
              .join(', ')
          : error?.message ||
              'Plan change unavailable'
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmPlanChange =
    async () => {
      if (!quote) return;

      if (
        quote.proceedToPayment
      ) {
        navigate(
          '/app/billing',
          {
            state: {
              selectedPlan:
                quote.selectedPlan
                  .internalCode,

              billingCycle:
                quote.billingCycle,
            },
          }
        );

        return;
      }

      if (
        !window.confirm(
          `Downgrade to ${quote.newPlan}?`
        )
      ) {
        return;
      }

      setBusy(true);

      try {
        await subscriptionService
          .downgrade({
            plan:
              quote.selectedPlan
                .internalCode,

            reason:
              'Company requested downgrade',
          });

        setQuote(null);
        setMessage(
          'Plan downgraded successfully'
        );

        await load();
      } catch (error) {
        setMessage(
          error?.message ||
            'Downgrade failed'
        );
      } finally {
        setBusy(false);
      }
    };

  const changeAutoRenew =
    async () => {
      const enabled =
        !current.subscription
          .autoRenew;

      await subscriptionService
        .setAutoRenew(enabled);

      setMessage(
        `Auto-renew ${
          enabled
            ? 'enabled'
            : 'disabled'
        }`
      );

      await load();
    };

  const cancelSubscription =
    async () => {
      const reason =
        window.prompt(
          'Why are you cancelling?'
        );

      if (reason === null) return;

      if (
        !window.confirm(
          'Cancel this subscription? Existing company data will remain stored.'
        )
      ) {
        return;
      }

      await subscriptionService
        .cancel(reason);

      setMessage(
        'Subscription cancelled'
      );

      await load();
    };

  const restoreSubscription =
    async () => {
      await subscriptionService
        .restore(
          'Company requested restoration'
        );

      setMessage(
        'Subscription restored'
      );

      await load();
    };

  if (!current) {
    return (
      <div className="p-6 text-slate-400">
        Loading subscription…
      </div>
    );
  }

  const subscription =
    current.subscription;

  const plan =
    current.plan;

  const usage =
    current.usage || {};

  const features =
    current.features || {};

  return (
    <div className="space-y-6 p-6 text-slate-100">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            💳 Subscription
          </h1>

          <p className="text-sm text-slate-400">
            Current plan, features,
            usage and billing history.
          </p>
        </div>

        <div className="flex gap-2">
          <Link
            to="/app/billing"
            className={ghost}
          >
            View Billing
          </Link>
        </div>
      </div>

      {message && (
        <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-3 text-indigo-200">
          {message}
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className={panel}>
          <p className="text-xs text-slate-500">
            Current Plan
          </p>

          <p className="mt-1 text-2xl font-black text-indigo-300">
            {plan.name ||
              plan.key}
          </p>
        </div>

        <div className={panel}>
          <p className="text-xs text-slate-500">
            Status
          </p>

          <p className="mt-1 text-2xl font-black text-emerald-300">
            {subscription.status}
          </p>
        </div>

        <div className={panel}>
          <p className="text-xs text-slate-500">
            Renewal
          </p>

          <p className="mt-1 text-xl font-bold">
            {date(
              subscription.renewalDate ||
                subscription.endDate
            )}
          </p>
        </div>

        <div className={panel}>
          <p className="text-xs text-slate-500">
            Billing Cycle
          </p>

          <p className="mt-1 text-xl font-bold">
            {
              subscription.billingCycle
            }
          </p>
        </div>
      </section>

      <section className={panel}>
        <h2 className="mb-4 text-lg font-semibold">
          Usage
        </h2>

        <div className="grid gap-5 md:grid-cols-2">
          {usage.employees && (
            <Progress
              label="Employees"
              used={
                usage.employees
                  .used
              }
              limit={
                usage.employees
                  .limit
              }
            />
          )}

          {usage.users && (
            <Progress
              label="Users"
              used={
                usage.users.used
              }
              limit={
                usage.users.limit
              }
            />
          )}

          {usage.storageMB && (
            <Progress
              label="Storage"
              used={
                usage.storageMB
                  .used
              }
              limit={
                usage.storageMB
                  .limit
              }
              format={bytes}
            />
          )}

          {usage.apiRequestsMonthly && (
            <Progress
              label="API requests"
              used={
                usage
                  .apiRequestsMonthly
                  .used
              }
              limit={
                usage
                  .apiRequestsMonthly
                  .limit
              }
              format={(value) =>
                Number(
                  value || 0
                ).toLocaleString(
                  'en-IN'
                )
              }
            />
          )}
        </div>
      </section>

      <section className={panel}>
        <h2 className="mb-4 text-lg font-semibold">
          Features
        </h2>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Object.entries(
            features
          ).map(
            ([
              featureName,
              enabled,
            ]) => (
              <div
                key={featureName}
                className={`rounded-lg border px-3 py-2 text-sm ${
                  enabled
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-slate-700 bg-slate-800 text-slate-500'
                }`}
              >
                {enabled
                  ? '✓'
                  : '✕'}{' '}
                {featureName}
              </div>
            )
          )}
        </div>
      </section>

      {isCompanyAdmin && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">
              Available Plans
            </h2>

            <button
              type="button"
              onClick={
                changeAutoRenew
              }
              className={ghost}
            >
              Auto-renew:{' '}
              {subscription.autoRenew
                ? 'ON'
                : 'OFF'}
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {plans.map(
              (availablePlan) => (
                <div
                  key={
                    availablePlan
                      .internalCode
                  }
                  className={`${panel} ${
                    availablePlan.current
                      ? 'border-indigo-500'
                      : ''
                  }`}
                >
                  <h3 className="text-lg font-bold">
                    {
                      availablePlan.name
                    }
                  </h3>

                  <p className="mt-2 text-2xl font-black">
                    {money(
                      availablePlan
                        .prices
                        ?.monthly
                    )}
                    <span className="text-xs font-normal text-slate-500">
                      {' '}
                      / month
                    </span>
                  </p>

                  <p className="mt-3 text-xs text-slate-500">
                    {
                      availablePlan
                        .limits
                        ?.employees
                    }{' '}
                    employees ·{' '}
                    {bytes(
                      availablePlan
                        .limits
                        ?.storageMB
                    )}
                  </p>

                  <button
                    type="button"
                    disabled={
                      availablePlan.current ||
                      busy
                    }
                    onClick={() =>
                      requestPlan(
                        availablePlan
                      )
                    }
                    className={`${btn} mt-4 w-full`}
                  >
                    {availablePlan.current
                      ? 'Current Plan'
                      : 'Compare Plan'}
                  </button>
                </div>
              )
            )}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {subscription.status ===
            'CANCELLED' ? (
              <button
                type="button"
                onClick={
                  restoreSubscription
                }
                className={btn}
              >
                Restore Subscription
              </button>
            ) : (
              <button
                type="button"
                onClick={
                  cancelSubscription
                }
                className="rounded-lg bg-red-500/15 px-4 py-2 text-sm text-red-300"
              >
                Cancel Subscription
              </button>
            )}
          </div>
        </section>
      )}

      <section className={panel}>
        <h2 className="mb-4 text-lg font-semibold">
          Invoices
        </h2>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="pb-2">
                  Invoice
                </th>
                <th>Plan</th>
                <th>Total</th>
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-800">
              {invoices.map(
                (invoice) => (
                  <tr
                    key={
                      invoice._id
                    }
                  >
                    <td className="py-2">
                      {
                        invoice.invoiceNumber
                      }
                    </td>

                    <td>
                      {
                        invoice.plan
                      }
                    </td>

                    <td>
                      {money(
                        invoice.total
                      )}
                    </td>

                    <td>
                      {
                        invoice.status
                      }
                    </td>

                    <td>
                      {date(
                        invoice.createdAt
                      )}
                    </td>
                  </tr>
                )
              )}

              {!invoices.length && (
                <tr>
                  <td
                    colSpan="5"
                    className="py-8 text-center text-slate-500"
                  >
                    No invoices yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className={panel}>
        <h2 className="mb-4 text-lg font-semibold">
          Subscription History
        </h2>

        <div className="space-y-2">
          {history.map(
            (historyRow) => (
              <div
                key={
                  historyRow._id
                }
                className="flex flex-wrap justify-between gap-2 border-b border-slate-800 py-2 text-sm"
              >
                <div>
                  <b>
                    {
                      historyRow.event
                    }
                  </b>

                  <p className="text-xs text-slate-500">
                    {historyRow.oldPlan &&
                      `${historyRow.oldPlan} → `}

                    {
                      historyRow.newPlan
                    }

                    {historyRow.reason &&
                      ` · ${historyRow.reason}`}
                  </p>
                </div>

                <span className="text-slate-500">
                  {date(
                    historyRow.createdAt
                  )}
                </span>
              </div>
            )
          )}

          {!history.length && (
            <p className="text-sm text-slate-500">
              No subscription history
              yet.
            </p>
          )}
        </div>
      </section>

      {quote && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6">
            <h2 className="text-xl font-bold">
              Confirm Plan Change
            </h2>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className={panel}>
                <p className="text-xs text-slate-500">
                  Current
                </p>

                <b>
                  {
                    quote.currentPlan
                  }
                </b>

                <p>
                  {money(
                    quote.currentPrice
                  )}
                </p>
              </div>

              <div className={panel}>
                <p className="text-xs text-slate-500">
                  New
                </p>

                <b>
                  {
                    quote.newPlan
                  }
                </b>

                <p>
                  {money(
                    quote.newPrice
                  )}
                </p>
              </div>
            </div>

            <p className="mt-4 text-sm text-slate-400">
              Price difference:{' '}
              {money(
                quote.priceDifference
              )}
            </p>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() =>
                  setQuote(null)
                }
                className={ghost}
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={
                  confirmPlanChange
                }
                disabled={busy}
                className={btn}
              >
                {quote.proceedToPayment
                  ? 'Proceed to Payment'
                  : 'Confirm Downgrade'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SubscriptionPage;