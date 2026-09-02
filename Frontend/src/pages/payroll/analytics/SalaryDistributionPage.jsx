import { useState } from 'react';
import { PieChart, Users } from 'lucide-react';

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
  percent,
  useDepartments,
  useReport,
  usePayrollMonths,
} from './analyticsShared.js';

// ───────────────────────────────────────────────────────────────────────────
// §8 + §10 — Salary Distribution.
//
//   §8   designation analytics — count, average, highest, lowest, total cost
//   §10  salary bands — how headcount and payroll spread across the ranges
//
// The bands come from the server as data, so a company that changes its ranges
// does not need a frontend release.
// ───────────────────────────────────────────────────────────────────────────

const SalaryDistributionPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();
  const canRead = hasAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']);

  const departments = useDepartments();
  const months = usePayrollMonths(!permsLoading && canRead);
  const [month, setMonth] = useState(currentMonth());
  const [departmentId, setDepartmentId] = useState('');
  const [banner, setBanner] = useState(null);

  const filters = { month, departmentId };
  const bands = useReport({ reportKey: 'SALARY_BANDS', filters, enabled: !permsLoading && canRead });
  const designations = useReport({ reportKey: 'DESIGNATION', filters, enabled: !permsLoading && canRead });

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader icon={PieChart} title="Salary Distribution" subtitle="Bands and designations" />
        <AccessDenied />
      </div>
    );
  }

  const bandRows = bands.report?.rows || [];
  const bandTotal = bandRows.reduce((sum, row) => sum + Number(row.payroll || 0), 0);
  const maxBandEmployees = Math.max(1, ...bandRows.map((row) => Number(row.employees || 0)));

  return (
    <div className="p-6">
      <PageHeader
        icon={PieChart}
        title="Salary Distribution"
        subtitle={`${monthLabel(month)} · §10 bands and §8 designation analytics`}
        actions={<ExportMenu reportKey="SALARY_BANDS" filters={filters} onQueued={setBanner} />}
      />

      {banner ? <div className="mb-4"><Banner {...banner} onClose={() => setBanner(null)} /></div> : null}

      <FilterBar
        month={month}
        months={months}
        onMonthChange={setMonth}
        departments={departments}
        departmentId={departmentId}
        onDepartmentChange={setDepartmentId}
      />

      {(bands.denied || designations.denied) ? <AccessDenied /> : null}

      {/* §10 — the bands as bars, not only as numbers */}
      <SectionCard
        title="Salary bands"
        subtitle="§10 — employee count and total payroll in each range"
        actions={<ExportMenu reportKey="SALARY_BANDS" filters={filters} onQueued={setBanner} />}
      >
        {bands.loading ? (
          <p className="text-sm text-crewly-dim">Loading the salary bands…</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard icon={Users} label="Employees in bands" value={count(bandRows.reduce((sum, row) => sum + Number(row.employees || 0), 0))} />
              <KpiCard label="Total payroll" value={money(bandTotal)} />
              <KpiCard label="Bands in use" value={count(bandRows.filter((row) => Number(row.employees) > 0).length)} />
              <KpiCard label="Largest band" value={bandRows.slice().sort((a, b) => b.employees - a.employees)[0]?.label || '—'} />
            </div>

            <ul className="mt-4 space-y-3">
              {bandRows.map((row) => (
                <li key={row.key}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-crewly-text">{row.label}</span>
                    <span className="tabular-nums text-crewly-dim">
                      {count(row.employees)} employee{Number(row.employees) === 1 ? '' : 's'} · {money(row.payroll)}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/5">
                    <div
                      className="h-full rounded-full bg-sky-500/60"
                      style={{ width: `${(Number(row.employees || 0) / maxBandEmployees) * 100}%` }}
                    />
                  </div>
                  <p className="mt-0.5 text-[11px] text-crewly-dim">
                    {percent(row.sharePercent)} of headcount · {money(row.netPayroll)} net
                  </p>
                </li>
              ))}
            </ul>

            <div className="mt-4 border-t border-white/5 pt-3">
              <DataTable
                headers={[
                  { key: 'label', label: 'Band', strong: true },
                  { key: 'employees', label: 'Employees', align: 'right' },
                  { key: 'payroll', label: 'Total payroll', align: 'right', render: (row) => money(row.payroll) },
                  { key: 'netPayroll', label: 'Net payroll', align: 'right', render: (row) => money(row.netPayroll) },
                  { key: 'sharePercent', label: 'Share', align: 'right', render: (row) => percent(row.sharePercent) },
                ]}
                rows={bandRows}
                empty="No salary distribution for this month"
              />
            </div>
          </>
        )}
      </SectionCard>

      {/* §8 — designation analytics */}
      <SectionCard
        className="mt-4"
        title="Designation analytics"
        subtitle="§8 — count, average, highest and lowest by designation"
        actions={<ExportMenu reportKey="DESIGNATION" filters={filters} onQueued={setBanner} />}
      >
        {designations.loading ? (
          <p className="text-sm text-crewly-dim">Loading designation analytics…</p>
        ) : (
          <DataTable
            headers={[
              { key: 'designation', label: 'Designation', strong: true },
              { key: 'employees', label: 'Employees', align: 'right' },
              { key: 'averageSalary', label: 'Average', align: 'right', render: (row) => money(row.averageSalary) },
              { key: 'highest', label: 'Highest', align: 'right', render: (row) => money(row.highest) },
              { key: 'lowest', label: 'Lowest', align: 'right', render: (row) => money(row.lowest) },
              { key: 'totalCost', label: 'Total cost', align: 'right', render: (row) => money(row.totalCost) },
            ]}
            rows={designations.report?.rows || []}
            empty="No designation data for this month"
          />
        )}
      </SectionCard>
    </div>
  );
};

export default SalaryDistributionPage;
