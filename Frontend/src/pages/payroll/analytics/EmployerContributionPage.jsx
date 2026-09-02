import { useState } from 'react';
import { Landmark } from 'lucide-react';

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
// §13 — Employer Contribution: what the company pays ON TOP of salary.
//
// PF employer share, ESI employer share, gratuity provision, LWF employer
// share, and whatever else the structure contributes.
//
// The one rule this page exists to defend: employer contributions are NOT
// employee deductions. They never appear in a net-pay figure and they must
// never be added to one.
// ───────────────────────────────────────────────────────────────────────────

const EmployerContributionPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();
  const canRead = hasAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']);

  const departments = useDepartments();
  const months = usePayrollMonths(!permsLoading && canRead);
  const [month, setMonth] = useState(currentMonth());
  const [departmentId, setDepartmentId] = useState('');
  const [banner, setBanner] = useState(null);

  const filters = { month, departmentId };
  const { report, loading, denied, error } = useReport({
    reportKey: 'EMPLOYER',
    filters,
    enabled: !permsLoading && canRead,
  });

  const rows = report?.rows || [];
  const byDepartment = report?.byDepartment || [];

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader icon={Landmark} title="Employer Contribution" subtitle="What the company pays on top" />
        <AccessDenied />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        icon={Landmark}
        title="Employer Contribution"
        subtitle={`${monthLabel(month)} · §13 PF, ESI, gratuity, LWF — never part of an employee's net pay`}
        actions={<ExportMenu reportKey="EMPLOYER" filters={filters} onQueued={setBanner} />}
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
      {loading ? <p className="text-sm text-crewly-dim">Loading employer contributions…</p> : null}

      {!loading && report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <KpiCard label="Total employer cost" value={money(report.total)} />
            <KpiCard label="Snapshot total" value={money(report.snapshotTotal)} hint="what the payroll run recorded" />
            <KpiCard
              label="Unclassified"
              value={money(report.unclassified)}
              tone={Number(report.unclassified) ? 'warn' : 'default'}
              hint={Number(report.unclassified) ? 'contributed without a line — shown, not hidden' : 'every rupee has a name'}
            />
          </div>

          <SectionCard className="mt-4" title="By contribution" subtitle="§13 — every employer-side line">
            <DataTable
              headers={[
                { key: 'label', label: 'Contribution', strong: true },
                { key: 'employees', label: 'Employees', align: 'right', render: (row) => count(row.employees) },
                { key: 'amount', label: 'Amount', align: 'right', render: (row) => money(row.amount) },
              ]}
              rows={rows}
              footer={[
                { value: 'Total', strong: true },
                { value: '' },
                { value: money(report.snapshotTotal), align: 'right', strong: true },
              ]}
              empty="No employer contributions recorded for this period"
            />
          </SectionCard>

          <SectionCard className="mt-4" title="By department" subtitle="§13 — where the employer cost lands">
            <DataTable
              headers={[
                { key: 'department', label: 'Department', strong: true },
                { key: 'employees', label: 'Employees', align: 'right', render: (row) => count(row.employees) },
                { key: 'employerCost', label: 'Employer cost', align: 'right', render: (row) => money(row.employerCost) },
              ]}
              rows={byDepartment}
              empty="No employer cost for this period"
            />
            <p className="mt-3 border-t border-white/5 pt-2 text-xs text-crewly-dim">
              Gratuity is a provision — money set aside against a future liability, not a monthly
              remittance. It is shown here, alongside the remittable contributions, never inside them.
            </p>
          </SectionCard>
        </>
      ) : null}
    </div>
  );
};

export default EmployerContributionPage;
