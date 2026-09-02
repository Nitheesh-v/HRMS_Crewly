import { useState } from 'react';
import { Wallet } from 'lucide-react';

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
// §12 — Bonus & Incentive: total bonus, incentives, commissions, festival
// bonus and performance bonus, filterable by department / month / employee /
// designation.
//
// Only employees who actually drew variable pay appear: a report about rewards
// is not improved by hundreds of rows of zeroes.
// ───────────────────────────────────────────────────────────────────────────

const BonusReportPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();
  const canRead = hasAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']);

  const departments = useDepartments();
  const months = usePayrollMonths(!permsLoading && canRead);
  const [month, setMonth] = useState(currentMonth());
  const [departmentId, setDepartmentId] = useState('');
  const [banner, setBanner] = useState(null);

  const filters = { month, departmentId };
  const { report, loading, denied, error } = useReport({
    reportKey: 'BONUS',
    filters,
    enabled: !permsLoading && canRead,
  });

  const rows = report?.rows || [];
  const summary = report?.summary || {};
  const totalVariable = rows.reduce((sum, row) => sum + Number(row.totalVariable || 0), 0);

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader icon={Wallet} title="Bonus Report" subtitle="Bonuses, incentives and commissions" />
        <AccessDenied />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        icon={Wallet}
        title="Bonus Report"
        subtitle={`${monthLabel(month)} · §12 variable pay, highest first`}
        actions={<ExportMenu reportKey="BONUS" filters={filters} onQueued={setBanner} />}
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
      {loading ? <p className="text-sm text-crewly-dim">Loading the bonus report…</p> : null}

      {!loading && report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Employees rewarded" value={count(rows.length)} hint={`of ${count(summary.employeesPaid)} paid`} />
            <KpiCard label="Total variable pay" value={money(totalVariable)} tone="good" />
            <KpiCard label="Variable earnings" value={money(summary.variableTotal)} />
            <KpiCard label="Overtime in payroll" value={money(summary.overtimeTotal)} />
          </div>

          <SectionCard className="mt-4" title="By employee" subtitle="§12 — bonus, incentive and commission detail">
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
                { key: 'bonus', label: 'Bonus', align: 'right', render: (row) => money(row.bonus) },
                { key: 'variableEarnings', label: 'Variable', align: 'right', render: (row) => money(row.variableEarnings) },
                { key: 'overtime', label: 'Overtime', align: 'right', render: (row) => money(row.overtime) },
                { key: 'reimbursements', label: 'Reimbursements', align: 'right', render: (row) => money(row.reimbursements) },
                { key: 'totalVariable', label: 'Total variable', align: 'right', render: (row) => money(row.totalVariable) },
                { key: 'net', label: 'Net salary', align: 'right', render: (row) => money(row.net) },
              ]}
              rows={rows}
              footer={[
                { value: 'Total', strong: true },
                { value: '' },
                { value: '' },
                { value: money(rows.reduce((sum, row) => sum + Number(row.bonus || 0), 0)), align: 'right', strong: true },
                { value: money(summary.variableTotal), align: 'right', strong: true },
                { value: money(summary.overtimeTotal), align: 'right', strong: true },
                { value: money(summary.reimbursements), align: 'right', strong: true },
                { value: money(totalVariable), align: 'right', strong: true },
                { value: money(summary.netSalary), align: 'right', strong: true },
              ]}
              empty="No variable pay was processed for this month"
            />
          </SectionCard>
        </>
      ) : null}
    </div>
  );
};

export default BonusReportPage;
