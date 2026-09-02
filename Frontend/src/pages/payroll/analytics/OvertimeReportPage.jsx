import { useState } from 'react';
import { CalendarRange } from 'lucide-react';

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
  money2,
  monthLabel,
  useDepartments,
  useReport,
  usePayrollMonths,
} from './analyticsShared.js';

// ───────────────────────────────────────────────────────────────────────────
// §13 — Overtime: total OT hours, OT cost, department OT and an employee
// ranking.
//
// "Read data from Attendance and Payroll snapshots. Do not calculate OT here."
// The hours come from the snapshot's attendance block and the cost from its
// totals; the only thing this page divides is cost by hours, to show a rate.
// ───────────────────────────────────────────────────────────────────────────

const OvertimeReportPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();
  const canRead = hasAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']);

  const departments = useDepartments();
  const months = usePayrollMonths(!permsLoading && canRead);
  const [month, setMonth] = useState(currentMonth());
  const [departmentId, setDepartmentId] = useState('');
  const [banner, setBanner] = useState(null);

  const filters = { month, departmentId };
  const { report, loading, denied, error } = useReport({
    reportKey: 'OVERTIME',
    filters,
    enabled: !permsLoading && canRead,
  });

  const rows = report?.rows || [];
  const totals = report?.totals || {};
  const byDepartment = report?.byDepartment || [];

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader icon={CalendarRange} title="Overtime Report" subtitle="Hours, cost and who worked them" />
        <AccessDenied />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        icon={CalendarRange}
        title="Overtime Report"
        subtitle={`${monthLabel(month)} · §13 hours and cost, read from the snapshots`}
        actions={<ExportMenu reportKey="OVERTIME" filters={filters} onQueued={setBanner} />}
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
      {loading ? <p className="text-sm text-crewly-dim">Loading the overtime report…</p> : null}

      {!loading && report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Total OT hours" value={count(totals.overtimeHours)} />
            <KpiCard label="Total OT cost" value={money(totals.overtimeTotal)} tone="warn" />
            <KpiCard label="Employees with OT" value={count(rows.length)} hint={`of ${count(totals.employeesPaid)} paid`} />
            <KpiCard
              label="Average cost per hour"
              value={money2(Number(totals.overtimeHours) ? Number(totals.overtimeTotal) / Number(totals.overtimeHours) : 0)}
            />
          </div>

          <SectionCard className="mt-4" title="By department" subtitle="§13 — where the overtime lands">
            <DataTable
              headers={[
                { key: 'department', label: 'Department', strong: true },
                { key: 'employees', label: 'Employees', align: 'right' },
                { key: 'otHours', label: 'OT hours', align: 'right', render: (row) => count(row.otHours) },
                { key: 'overtimeCost', label: 'OT cost', align: 'right', render: (row) => money(row.overtimeCost) },
              ]}
              rows={byDepartment}
              empty="No overtime recorded for this month"
            />
          </SectionCard>

          <SectionCard className="mt-4" title="Employee ranking" subtitle="§13 — highest overtime use first">
            <DataTable
              headers={[
                { key: 'employeeCode', label: 'Employee', strong: true, render: (row) => (
                  <span>
                    {row.employeeCode}
                    <span className="block text-xs text-crewly-dim">{row.employeeName}</span>
                  </span>
                ) },
                { key: 'department', label: 'Department' },
                { key: 'designation', label: 'Designation' },
                { key: 'otHours', label: 'OT hours', align: 'right', render: (row) => count(row.otHours) },
                { key: 'overtimeCost', label: 'OT cost', align: 'right', render: (row) => money(row.overtimeCost) },
                { key: 'costPerHour', label: 'Cost per hour', align: 'right', render: (row) => money2(row.costPerHour) },
              ]}
              rows={rows}
              footer={[
                { value: 'Total', strong: true },
                { value: '' },
                { value: '' },
                { value: count(totals.overtimeHours), align: 'right', strong: true },
                { value: money(totals.overtimeTotal), align: 'right', strong: true },
                { value: '' },
              ]}
              empty="No overtime recorded for this month"
            />
            <p className="mt-3 border-t border-white/5 pt-2 text-xs text-crewly-dim">
              Hours and cost are read from the payroll snapshot as stored — overtime is never
              recalculated here (§13).
            </p>
          </SectionCard>
        </>
      ) : null}
    </div>
  );
};

export default OvertimeReportPage;
