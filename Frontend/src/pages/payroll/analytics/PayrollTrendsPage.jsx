import { useState } from 'react';
import { LineChart } from 'lucide-react';

import usePermission from '../../../hooks/usePermission.js';

import {
  AccessDenied,
  Banner,
  DataTable,
  ExportMenu,
  FilterBar,
  KpiCard,
  PageHeader,
  SectionCard,
} from './analyticsShared.jsx';
import {
  count,
  currentMonth,
  money,
  monthLabel,
  useDepartments,
  useReport,
  usePayrollMonths,
} from './analyticsShared.js';

// ───────────────────────────────────────────────────────────────────────────
// §11 — Payroll Trends: gross, net, employer contribution, bonus and overtime
// over time, switchable monthly / quarterly / yearly.
//
// Every point is a read of the immutable monthly snapshots (§11: "Use
// historical snapshots. Do not recalculate old payroll.") — a trend line here
// can never disagree with what was actually paid.
// ───────────────────────────────────────────────────────────────────────────

const PERIODS = [
  { key: 'MONTHLY', label: 'Monthly' },
  { key: 'QUARTERLY', label: 'Quarterly' },
  { key: 'YEARLY', label: 'Yearly' },
];

const SERIES = [
  { key: 'grossPayroll', label: 'Gross payroll', tone: 'bg-sky-500/70' },
  { key: 'netSalary', label: 'Net salary', tone: 'bg-emerald-500/70' },
  { key: 'employerContribution', label: 'Employer contribution', tone: 'bg-amber-500/70' },
  { key: 'bonus', label: 'Bonus', tone: 'bg-violet-500/70' },
  { key: 'overtime', label: 'Overtime', tone: 'bg-rose-500/70' },
];

const PayrollTrendsPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();
  const canRead = hasAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']);

  const departments = useDepartments();
  const months = usePayrollMonths(!permsLoading && canRead);
  const [month, setMonth] = useState(currentMonth());
  const [period, setPeriod] = useState('MONTHLY');
  const [departmentId, setDepartmentId] = useState('');
  const [banner, setBanner] = useState(null);

  const filters = { month, departmentId, period };
  const { report, loading, denied, error } = useReport({
    reportKey: 'TREND',
    filters,
    enabled: !permsLoading && canRead,
  });

  const rows = report?.rows || [];
  const latest = rows[rows.length - 1] || {};
  const first = rows[0] || {};
  const change = Number(first.grossPayroll)
    ? ((Number(latest.grossPayroll) - Number(first.grossPayroll)) / Number(first.grossPayroll)) * 100
    : 0;

  // Bars are scaled against the tallest column, so the shape of the year is
  // readable without a chart library.
  const peak = Math.max(1, ...rows.map((row) => Number(row.grossPayroll || 0)));

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader icon={LineChart} title="Payroll Trends" subtitle="Monthly, quarterly and yearly movement" />
        <AccessDenied />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        icon={LineChart}
        title="Payroll Trends"
        subtitle={`${monthLabel(month)} · §11 trends from historical snapshots`}
        actions={<ExportMenu reportKey="TREND" filters={filters} onQueued={setBanner} />}
      />

      {banner ? <div className="mb-4"><Banner {...banner} onClose={() => setBanner(null)} /></div> : null}
      {error ? <div className="mb-4"><Banner type="error" text={error} onClose={() => {}} /></div> : null}

      <FilterBar
        month={month}
        months={months}
        onMonthChange={setMonth}
        departments={departments}
        departmentId={departmentId}
        onDepartmentChange={setDepartmentId}
      >
        <div className="flex overflow-hidden rounded-md border border-white/10">
          {PERIODS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setPeriod(key)}
              className={`px-3 py-1.5 text-sm ${
                period === key ? 'bg-white/10 text-crewly-text' : 'text-crewly-dim hover:bg-white/5'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </FilterBar>

      {denied ? <AccessDenied /> : null}
      {loading ? <p className="text-sm text-crewly-dim">Loading payroll trends…</p> : null}

      {!loading && report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Periods" value={count(rows.length)} hint={PERIODS.find((entry) => entry.key === period)?.label} />
            <KpiCard label="Gross in the last period" value={money(latest.grossPayroll)} />
            <KpiCard label="Net in the last period" value={money(latest.netSalary)} />
            <KpiCard
              label="Change across the window"
              value={`${change > 0 ? '+' : ''}${change.toFixed(1)}%`}
              tone={change > 0 ? 'warn' : 'good'}
            />
          </div>

          <SectionCard className="mt-4" title="Gross payroll across the window" subtitle="Each bar is one period">
            {rows.length ? (
              <div className="flex h-40 items-end gap-1.5">
                {rows.map((row) => (
                  <div key={row.key} className="group flex flex-1 flex-col items-center gap-1">
                    <div
                      className="w-full rounded-t bg-sky-500/70"
                      style={{ height: `${(Number(row.grossPayroll || 0) / peak) * 100}%` }}
                      title={`${row.label}: ${money(row.grossPayroll)}`}
                    />
                    <span className="text-[10px] text-crewly-dim">{row.label}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-crewly-dim">No completed payroll in this window.</p>
            )}
            <div className="mt-3 flex flex-wrap gap-3 border-t border-white/5 pt-3">
              {SERIES.map(({ key, label, tone }) => (
                <span key={key} className="flex items-center gap-1.5 text-xs text-crewly-dim">
                  <span className={`h-2 w-2 rounded-full ${tone}`} />
                  {label}
                </span>
              ))}
            </div>
          </SectionCard>

          <SectionCard className="mt-4" title="Period detail" subtitle="§11 — every measure, period by period">
            <DataTable
              headers={[
                { key: 'label', label: 'Period', strong: true },
                { key: 'employeesPaid', label: 'Paid', align: 'right' },
                { key: 'grossPayroll', label: 'Gross', align: 'right', render: (row) => money(row.grossPayroll) },
                { key: 'netSalary', label: 'Net', align: 'right', render: (row) => money(row.netSalary) },
                { key: 'employerContribution', label: 'Employer', align: 'right', render: (row) => money(row.employerContribution) },
                { key: 'bonus', label: 'Bonus', align: 'right', render: (row) => money(row.bonus) },
                { key: 'overtime', label: 'Overtime', align: 'right', render: (row) => money(row.overtime) },
                { key: 'totalPayrollCost', label: 'Total cost', align: 'right', render: (row) => money(row.totalPayrollCost) },
              ]}
              rows={rows}
              empty="No completed payroll in this window"
            />
          </SectionCard>
        </>
      ) : null}
    </div>
  );
};

export default PayrollTrendsPage;
