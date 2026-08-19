/* eslint-disable react-hooks/set-state-in-effect */

import {
  useEffect,
  useState,
} from 'react';
import superAdminService from '../../services/superAdminService.js';

const card =
  'rounded-xl border border-slate-800 bg-slate-900 p-4';

const money = (value) =>
  `₹${Number(
    value || 0
  ).toLocaleString('en-IN', {
    maximumFractionDigits: 0,
  })}`;

const bytes = (value) =>
  `${(
    Number(value || 0) /
    1024 /
    1024
  ).toFixed(1)} MB`;

const Metric = ({
  label,
  value,
  tone = 'text-white',
}) => (
  <div className={card}>
    <p className="text-xs text-slate-500">
      {label}
    </p>

    <p
      className={`mt-1 text-2xl font-black ${tone}`}
    >
      {value}
    </p>
  </div>
);

const Bars = ({
  data = [],
  valueKey,
  color = '#f97316',
}) => {
  const max = Math.max(
    1,
    ...data.map((row) =>
      Number(
        row[valueKey] || 0
      )
    )
  );

  return (
    <div className="flex h-44 items-end gap-2">
      {data.map((row) => {
        const value =
          Number(
            row[valueKey] || 0
          );

        return (
          <div
            key={row.label}
            className="flex min-w-0 flex-1 flex-col items-center gap-1"
          >
            <span className="text-[9px] text-slate-500">
              {value || ''}
            </span>

            <div
              className="w-full rounded-t"
              style={{
                height:
                  `${Math.max(
                    3,
                    (value / max) *
                      130
                  )}px`,

                background:
                  color,
              }}
            />

            <span className="text-[9px] text-slate-500">
              {row.label}
            </span>
          </div>
        );
      })}
    </div>
  );
};

const Distribution = ({
  rows = [],
}) => {
  const total = Math.max(
    1,
    rows.reduce(
      (sum, row) =>
        sum + row.value,
      0
    )
  );

  const colors = [
    '#f97316',
    '#22d3ee',
    '#a78bfa',
    '#34d399',
    '#f59e0b',
    '#fb7185',
  ];

  const gradient = rows
    .map((row, index) => {
      const previous =
        rows
          .slice(0, index)
          .reduce(
            (sum, item) =>
              sum +
              item.value,
            0
          );

      return (
        `${
          colors[
            index %
              colors.length
          ]
        } ` +
        `${
          (previous /
            total) *
          100
        }% ` +
        `${
          (
            (previous +
              row.value) /
            total
          ) * 100
        }%`
      );
    })
    .join(', ');

  const value = rows.reduce(
    (sum, row) =>
      sum + row.value,
    0
  );

  return (
    <div className="flex items-center gap-5">
      <div
        className="flex h-32 w-32 items-center justify-center rounded-full"
        style={{
          background:
            `conic-gradient(${
              gradient ||
              '#1e293b 0 100%'
            })`,
        }}
      >
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-slate-900 text-xl font-black">
          {value}
        </div>
      </div>

      <div className="space-y-2 text-sm">
        {rows.map(
          (row, index) => (
            <div
              key={row.label}
              className="flex items-center gap-2"
            >
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{
                  background:
                    colors[
                      index %
                        colors.length
                    ],
                }}
              />

              <span className="text-slate-400">
                {row.label}
              </span>

              <b>{row.value}</b>
            </div>
          )
        )}
      </div>
    </div>
  );
};

const SuperAdminDashboardPage =
  () => {
    const [
      dashboard,
      setDashboard,
    ] = useState(null);

    const [charts, setCharts] =
      useState(null);

    const [error, setError] =
      useState('');

    const load = async () => {
      setError('');

      try {
        const [
          summary,
          chartData,
        ] = await Promise.all([
          superAdminService
            .dashboard(),

          superAdminService
            .charts(),
        ]);

        setDashboard(summary);
        setCharts(chartData);
      } catch (
        requestError
      ) {
        setError(
          requestError?.message ||
            'Could not load dashboard'
        );
      }
    };

    useEffect(() => {
      load();
    }, []);

    if (
      !dashboard ||
      !charts
    ) {
      return (
        <div className="text-slate-400">
          Loading SaaS
          control center…
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-orange-400">
              SaaS Control Center
            </p>

            <h1 className="text-2xl font-black">
              Platform Dashboard
            </h1>
          </div>

          <button
            type="button"
            onClick={load}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm hover:border-orange-500"
          >
            🔄 Refresh
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-red-300">
            {error}
          </div>
        )}

        <section>
          <h2 className="mb-3 font-semibold text-slate-300">
            🏢 Companies
          </h2>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Metric
              label="Total"
              value={
                dashboard
                  .companies.total
              }
            />

            <Metric
              label="Active"
              value={
                dashboard
                  .companies.active
              }
              tone="text-emerald-300"
            />

            <Metric
              label="Trial"
              value={
                dashboard
                  .companies.trial
              }
              tone="text-cyan-300"
            />

            <Metric
              label="Expired"
              value={
                dashboard
                  .companies.expired
              }
              tone="text-amber-300"
            />

            <Metric
              label="Suspended"
              value={
                dashboard
                  .companies.suspended
              }
              tone="text-red-300"
            />

            <Metric
              label="New this month"
              value={
                dashboard
                  .companies
                  .newThisMonth
              }
              tone="text-orange-300"
            />
          </div>
        </section>

        <section>
          <h2 className="mb-3 font-semibold text-slate-300">
            👥 Users
          </h2>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Metric
              label="Total users"
              value={
                dashboard.users
                  .total
              }
            />

            <Metric
              label="Active"
              value={
                dashboard.users
                  .active
              }
              tone="text-emerald-300"
            />

            <Metric
              label="Inactive"
              value={
                dashboard.users
                  .inactive
              }
            />

            <Metric
              label="New users"
              value={
                dashboard.users
                  .newThisMonth
              }
              tone="text-cyan-300"
            />

            <Metric
              label="Active today"
              value={
                dashboard.users
                  .activeToday
              }
              tone="text-orange-300"
            />

            <Metric
              label="Active this month"
              value={
                dashboard.users
                  .activeThisMonth
              }
            />
          </div>
        </section>

        <section>
          <h2 className="mb-3 font-semibold text-slate-300">
            💳 Subscriptions
            & Revenue
          </h2>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Metric
              label="Active subs"
              value={
                dashboard
                  .subscriptions
                  .active
              }
              tone="text-emerald-300"
            />

            <Metric
              label="Expiring soon"
              value={
                dashboard
                  .subscriptions
                  .expiringSoon
              }
              tone="text-amber-300"
            />

            <Metric
              label="Expired"
              value={
                dashboard
                  .subscriptions
                  .expired
              }
              tone="text-red-300"
            />

            <Metric
              label="Cancelled"
              value={
                dashboard
                  .subscriptions
                  .cancelled
              }
            />

            <Metric
              label="MRR"
              value={money(
                dashboard.revenue
                  .mrr
              )}
              tone="text-emerald-300"
            />

            <Metric
              label="ARR"
              value={money(
                dashboard.revenue
                  .arr
              )}
              tone="text-cyan-300"
            />

            <Metric
              label="Monthly revenue"
              value={money(
                dashboard.revenue
                  .monthly
              )}
            />

            <Metric
              label="Growth"
              value={`${
                dashboard.revenue
                  .growthPct
              }%`}
              tone="text-orange-300"
            />
          </div>
        </section>

        <div className="grid gap-4 xl:grid-cols-2">
          <div className={card}>
            <h3 className="mb-3 font-semibold">
              Company growth
            </h3>

            <Bars
              data={charts.months}
              valueKey="newCompanies"
            />
          </div>

          <div className={card}>
            <h3 className="mb-3 font-semibold">
              User growth
            </h3>

            <Bars
              data={charts.months}
              valueKey="newUsers"
              color="#22d3ee"
            />
          </div>

          <div className={card}>
            <h3 className="mb-4 font-semibold">
              Subscription
              distribution
            </h3>

            <Distribution
              rows={
                charts.subscriptions
              }
            />
          </div>

          <div className={card}>
            <h3 className="mb-4 font-semibold">
              Company status
            </h3>

            <Distribution
              rows={
                charts.companyStatus
              }
            />
          </div>

          <div className={card}>
            <h3 className="mb-3 font-semibold">
              Revenue trend
            </h3>

            <Bars
              data={charts.months}
              valueKey="revenue"
              color="#34d399"
            />
          </div>

          <div className={card}>
            <h3 className="mb-4 font-semibold">
              System snapshot
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <Metric
                label="API requests"
                value={
                  dashboard.system
                    .apiRequests
                    .toLocaleString(
                      'en-IN'
                    )
                }
              />

              <Metric
                label="Storage"
                value={bytes(
                  dashboard.system
                    .storageBytes
                )}
              />

              <Metric
                label="Active sessions"
                value={
                  dashboard.system
                    .activeSessions
                }
              />

              <Metric
                label="Open tickets"
                value={
                  dashboard.system
                    .openTickets
                }
              />
            </div>
          </div>
        </div>
      </div>
    );
  };

export default SuperAdminDashboardPage;