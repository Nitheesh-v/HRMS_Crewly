import { useState } from 'react';
import { Building2 } from 'lucide-react';

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
// §7 — Department Analytics: department / employees / gross / net / employer
// cost / average salary, sorted by the highest payroll cost (the default the
// brief asks for, and the sort a finance head actually wants).
// ───────────────────────────────────────────────────────────────────────────

const DepartmentAnalyticsPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();
  const canRead = hasAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']);

  const departments = useDepartments();
  const months = usePayrollMonths(!permsLoading && canRead);
  const [month, setMonth] = useState(currentMonth());
  const [departmentId, setDepartmentId] = useState('');
  const [banner, setBanner] = useState(null);

  const filters = { month, departmentId };
  const { report, loading, denied, error } = useReport({
    reportKey: 'DEPARTMENT',
    filters,
    enabled: !permsLoading && canRead,
  });

  const summary = report?.summary || {};
  const rows = report?.rows || [];

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader icon={Building2} title="Department Analytics" subtitle="Cost, headcount and average salary by department" />
        <AccessDenied />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        icon={Building2}
        title="Department Analytics"
        subtitle={`${monthLabel(month)} · §7 payroll cost by department`}
        actions={<ExportMenu reportKey="DEPARTMENT" filters={filters} onQueued={setBanner} />}
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
      />

      {denied ? <AccessDenied /> : null}
      {loading ? <p className="text-sm text-crewly-dim">Loading department analytics…</p> : null}

      {!loading && report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Departments" value={count(rows.length)} />
            <KpiCard label="Employees paid" value={count(summary.employeesPaid)} />
            <KpiCard label="Total payroll cost" value={money(summary.totalPayrollCost)} />
            <KpiCard label="Average salary" value={money(summary.averageSalary)} />
          </div>

          <SectionCard className="mt-4" title="By department" subtitle="Highest payroll cost first">
            <DataTable
              headers={[
                { key: 'department', label: 'Department', strong: true },
                { key: 'employees', label: 'Employees', align: 'right' },
                { key: 'gross', label: 'Gross', align: 'right', render: (row) => money(row.gross) },
                { key: 'net', label: 'Net', align: 'right', render: (row) => money(row.net) },
                { key: 'employerCost', label: 'Employer cost', align: 'right', render: (row) => money(row.employerCost) },
                { key: 'totalCost', label: 'Total cost', align: 'right', render: (row) => money(row.totalCost) },
                {
                  key: 'share',
                  label: 'Share',
                  align: 'right',
                  render: (row) =>
                    percent(Number(summary.totalPayrollCost)
                      ? (Number(row.totalCost) / Number(summary.totalPayrollCost)) * 100
                      : 0),
                },
                { key: 'averageSalary', label: 'Average salary', align: 'right', render: (row) => money(row.averageSalary) },
              ]}
              rows={rows}
              footer={[
                { value: 'Total', strong: true },
                { value: count(summary.employeesPaid), align: 'right', strong: true },
                { value: money(summary.grossSalary), align: 'right', strong: true },
                { value: money(summary.netSalary), align: 'right', strong: true },
                { value: money(summary.employerContribution), align: 'right', strong: true },
                { value: money(summary.totalPayrollCost), align: 'right', strong: true },
                { value: '100%', align: 'right', strong: true },
                { value: money(summary.averageSalary), align: 'right', strong: true },
              ]}
              empty="No payroll runs completed for this month"
            />
          </SectionCard>
        </>
      ) : null}
    </div>
  );
};

export default DepartmentAnalyticsPage;
