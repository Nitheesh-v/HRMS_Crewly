import { useState } from 'react';
import { Receipt } from 'lucide-react';

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
// §18 — Reimbursements: travel, food, internet, fuel, medical, mobile.
//
// These are not salary. They are the company giving an employee back money
// they spent on its behalf, which is why this is its own report: mixing them
// into earnings overstates what the company pays its people.
// ───────────────────────────────────────────────────────────────────────────

const ReimbursementReportPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();
  const canRead = hasAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']);

  const departments = useDepartments();
  const months = usePayrollMonths(!permsLoading && canRead);
  const [month, setMonth] = useState(currentMonth());
  const [departmentId, setDepartmentId] = useState('');
  const [banner, setBanner] = useState(null);

  const filters = { month, departmentId };
  const { report, loading, denied, error } = useReport({
    reportKey: 'REIMBURSEMENT',
    filters,
    enabled: !permsLoading && canRead,
  });

  const categories = report?.categories || [];
  const employees = report?.employees || 0;
  const rows = report?.rows || [];
  const byMonth = report?.byMonth || [];

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader icon={Receipt} title="Reimbursement Analytics" subtitle="Claims paid through payroll" />
        <AccessDenied />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        icon={Receipt}
        title="Reimbursement Analytics"
        subtitle={`${monthLabel(month)} · §18 travel, food, fuel, internet, medical, mobile`}
        actions={<ExportMenu reportKey="REIMBURSEMENT" filters={filters} onQueued={setBanner} />}
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
      {loading ? <p className="text-sm text-crewly-dim">Loading the reimbursement report…</p> : null}

      {!loading && report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Total reimbursed" value={money(report.total)} />
            <KpiCard label="Employees reimbursed" value={count(employees)} />
            <KpiCard
              label="Average per employee"
              value={money(Number(employees) ? Number(report.total) / Number(employees) : 0)}
            />
            <KpiCard label="Categories in use" value={count(categories.length)} />
          </div>

          <SectionCard className="mt-4" title="By category" subtitle="§18 — what the money was spent on">
            <DataTable
              headers={[
                { key: 'label', label: 'Category', strong: true },
                { key: 'employees', label: 'Employees', align: 'right', render: (row) => count(row.employees) },
                { key: 'amount', label: 'Amount', align: 'right', render: (row) => money(row.amount) },
                { key: 'sharePercent', label: 'Share', align: 'right', render: (row) => percent(row.sharePercent) },
              ]}
              rows={categories}
              footer={[
                { value: 'Total', strong: true },
                { value: '' },
                { value: money(report.total), align: 'right', strong: true },
                { value: '' },
              ]}
              empty="No reimbursements were paid this period"
            />
          </SectionCard>

          <SectionCard className="mt-4" title="By employee" subtitle="§18 — who claimed, and what">
            <DataTable
              headers={[
                {
                  key: 'employeeCode',
                  label: 'Employee',
                  strong: true,
                  render: (row) => (
                    <span>
                      {row.employeeCode}
                      <span className="block text-xs text-crewly-dim">{row.employeeName}</span>
                    </span>
                  ),
                },
                { key: 'department', label: 'Department' },
                {
                  key: 'categories',
                  label: 'Categories',
                  render: (row) => (row.categories || []).map((entry) => entry.label).join(', ') || '—',
                },
                { key: 'reimbursements', label: 'Amount', align: 'right', render: (row) => money(row.reimbursements) },
              ]}
              rows={rows}
              empty="No reimbursements were paid this period"
            />
          </SectionCard>

          {byMonth.length > 1 ? (
            <SectionCard className="mt-4" title="By month" subtitle="§18 — the claim pattern over the period">
              <DataTable
                headers={[
                  { key: 'label', label: 'Month', strong: true },
                  { key: 'employees', label: 'Employees', align: 'right', render: (row) => count(row.employees) },
                  { key: 'reimbursements', label: 'Amount', align: 'right', render: (row) => money(row.reimbursements) },
                ]}
                rows={byMonth}
                empty="No reimbursements in this period"
              />
            </SectionCard>
          ) : null}
        </>
      ) : null}
    </div>
  );
};

export default ReimbursementReportPage;
