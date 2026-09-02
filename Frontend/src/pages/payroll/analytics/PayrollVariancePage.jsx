import { useState } from 'react';
import { GitCompareArrows } from 'lucide-react';

import usePermission from '../../../hooks/usePermission.js';

import {
  AccessDenied,
  Banner,
  DataTable,
  ExportMenu,
  FilterBar,
  PageHeader,
  PeriodSelect,
  SectionCard,
} from './analyticsShared.jsx';
import {
  DIRECTION_TONES,
  count,
  currentMonth,
  directionWord,
  money,
  monthLabel,
  percent,
  useDepartments,
  useReport,
  usePayrollMonths,
} from './analyticsShared.js';

// ───────────────────────────────────────────────────────────────────────────
// §21 — Payroll Variance: this period against the one before it.
//
// "Compare payroll between periods." The window's twin is chosen by the
// server, and it is the same LENGTH as the window: a quarter is compared to
// the quarter before it, a year to the year before it. Comparing a quarter to
// the single month preceding it would be arithmetic, not insight.
//
// Every line carries a direction — increasing, decreasing or stable — because
// "+2,000" leaves the reader to work out whether that is a lot.
// ───────────────────────────────────────────────────────────────────────────

const PayrollVariancePage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();
  const canRead = hasAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']);

  const departments = useDepartments();
  const months = usePayrollMonths(!permsLoading && canRead);
  const [month, setMonth] = useState(currentMonth());
  const [preset, setPreset] = useState('CURRENT_MONTH');
  const [fromMonth, setFromMonth] = useState(currentMonth());
  const [toMonth, setToMonth] = useState(currentMonth());
  const [departmentId, setDepartmentId] = useState('');
  const [banner, setBanner] = useState(null);

  const filters = preset === 'CUSTOM'
    ? { preset, fromMonth, toMonth, departmentId }
    : { month, preset, departmentId };

  const { report, loading, denied, error } = useReport({
    reportKey: 'VARIANCE',
    filters,
    enabled: !permsLoading && canRead,
  });

  const rows = report?.rows || [];

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader icon={GitCompareArrows} title="Payroll Variance" subtitle="This period against the last" />
        <AccessDenied />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        icon={GitCompareArrows}
        title="Payroll Variance"
        subtitle={`§21 ${monthLabel(month)} · every line carries a direction, not just a difference`}
        actions={<ExportMenu reportKey="VARIANCE" filters={filters} onQueued={setBanner} />}
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
        <PeriodSelect
          preset={preset}
          onPresetChange={setPreset}
          fromMonth={fromMonth}
          toMonth={toMonth}
          onFromMonthChange={setFromMonth}
          onToMonthChange={setToMonth}
          months={months}
        />
      </FilterBar>

      {denied ? <AccessDenied /> : null}
      {loading ? <p className="text-sm text-crewly-dim">Loading the variance report…</p> : null}

      {!loading && report ? (
        <>
          <SectionCard
            title="Period against period"
            subtitle={`§21 · compared with ${(report.previousMonths || []).length} month(s) before — the same length, so the comparison is fair`}
          >
            <DataTable
              headers={[
                { key: 'label', label: 'Metric', strong: true },
                { key: 'previous', label: 'Previous', align: 'right', render: (row) => money(row.previous) },
                { key: 'current', label: 'Current', align: 'right', render: (row) => money(row.current) },
                { key: 'difference', label: 'Difference', align: 'right', render: (row) => money(row.difference) },
                { key: 'changePercent', label: 'Change', align: 'right', render: (row) => percent(row.changePercent) },
                {
                  key: 'direction',
                  label: 'Direction',
                  align: 'right',
                  render: (row) => (
                    <span className={DIRECTION_TONES[row.direction] || ''}>{directionWord(row.direction)}</span>
                  ),
                },
              ]}
              rows={rows}
              empty="Nothing to compare yet — variance needs two periods of payroll"
            />
            <p className="mt-3 border-t border-white/5 pt-2 text-xs text-crewly-dim">
              &ldquo;Stable&rdquo; means the figure moved by less than half a percent. Headcount is
              shown as a count, not as money, so it is never mistaken for a cost.
            </p>
          </SectionCard>

          {report.direction ? (
            <SectionCard className="mt-4" title="The headline" subtitle="§5 — the direction of total payroll cost">
              <p className={`text-2xl font-semibold ${DIRECTION_TONES[report.direction] || ''}`}>
                {directionWord(report.direction)}
              </p>
              <p className="mt-1 text-xs text-crewly-dim">
                Total payroll cost moved from {money(report.previous?.totalPayrollCost)} to{' '}
                {money(report.current?.totalPayrollCost)}.
              </p>
            </SectionCard>
          ) : null}

          <SectionCard className="mt-4" title="What it is not" subtitle="§21 — two things this report will not do">
            <ul className="list-disc space-y-1 pl-5 text-xs text-crewly-dim">
              <li>It never recalculates old payroll — both sides are read from stored snapshots.</li>
              <li>
                It never compares a window to a period of a different length: the previous window is
                always the same size as the one you asked for.
              </li>
            </ul>
          </SectionCard>
        </>
      ) : null}
    </div>
  );
};

export default PayrollVariancePage;
