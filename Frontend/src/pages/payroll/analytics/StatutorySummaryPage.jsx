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
  currentFinancialYear,
  currentMonth,
  money,
  monthLabel,
  useDepartments,
  useReport,
  usePayrollMonths,
} from './analyticsShared.js';

// ───────────────────────────────────────────────────────────────────────────
// §15 — Statutory Summary: PF, ESI, PT, TDS and LWF consolidated, monthly and
// across a financial year.
//
// This page COMPLEMENTS Payroll → Statutory Compliance (29.10): that module
// prepares and tracks the filings, this one answers "what is our total
// liability?" Both read the same statutory rules, so the two can never
// disagree about what "PF employer" means.
// ───────────────────────────────────────────────────────────────────────────

const StatutorySummaryPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();
  const canRead = hasAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']);

  const departments = useDepartments();
  const months = usePayrollMonths(!permsLoading && canRead);
  const [month, setMonth] = useState(currentMonth());
  const [departmentId, setDepartmentId] = useState('');
  const [financialYear, setFinancialYear] = useState(currentFinancialYear());
  const [banner, setBanner] = useState(null);

  const filters = { month, departmentId };
  const monthly = useReport({ reportKey: 'STATUTORY', filters, enabled: !permsLoading && canRead });
  const yearly = useReport({
    reportKey: 'STATUTORY',
    filters: { financialYear, departmentId },
    enabled: !permsLoading && canRead,
  });

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader icon={Landmark} title="Statutory Summary" subtitle="PF, ESI, PT, TDS and LWF in one place" />
        <AccessDenied />
      </div>
    );
  }

  const data = monthly.report || {};
  const buckets = data.buckets || [];
  const totals = data.totals || {};
  const yearData = yearly.report || {};
  const yearTotals = yearData.totals || {};

  return (
    <div className="p-6">
      <PageHeader
        icon={Landmark}
        title="Statutory Summary"
        subtitle={`${monthLabel(month)} · §15 consolidated statutory liability`}
        actions={<ExportMenu reportKey="STATUTORY" filters={filters} onQueued={setBanner} />}
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

      {(monthly.denied || yearly.denied) ? <AccessDenied /> : null}
      {monthly.loading ? <p className="text-sm text-crewly-dim">Loading the statutory summary…</p> : null}

      {!monthly.loading && monthly.report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Total liability" value={money(totals.totalLiability)} hint="employee + employer" />
            <KpiCard label="Employee share" value={money(totals.employee)} />
            <KpiCard label="Employer share" value={money(totals.employer)} />
            <KpiCard label="Gratuity provision" value={money(totals.gratuityProvision)} tone="info" />
          </div>

          <SectionCard className="mt-4" title="By component" subtitle="§15 — every bucket, employee and employer">
            <DataTable
              headers={[
                { key: 'label', label: 'Component', strong: true },
                { key: 'employees', label: 'Employees', align: 'right' },
                { key: 'employee', label: 'Employee', align: 'right', render: (row) => money(row.employee) },
                { key: 'employer', label: 'Employer', align: 'right', render: (row) => money(row.employer) },
                { key: 'total', label: 'Total', align: 'right', render: (row) => money(row.total) },
              ]}
              rows={buckets}
              footer={[
                { value: 'Total liability', strong: true },
                { value: count(data.employees), align: 'right', strong: true },
                { value: money(totals.employee), align: 'right', strong: true },
                { value: money(totals.employer), align: 'right', strong: true },
                { value: money(totals.totalLiability), align: 'right', strong: true },
              ]}
              empty="No statutory liability for this month"
            />
            <p className="mt-3 border-t border-white/5 pt-2 text-xs text-crewly-dim">
              Professional tax and TDS are remitted, not matched, so they carry no employer share.
              Gratuity is a provision shown separately, annualised at {money(totals.gratuityAnnualised)}.
            </p>
          </SectionCard>

          {/* §15 — professional tax by state */}
          {data.pt?.byState?.length ? (
            <SectionCard className="mt-4" title="Professional tax by state" subtitle={`${monthLabel(month)}`}>
              <DataTable
                headers={[
                  { key: 'state', label: 'State', strong: true },
                  { key: 'employees', label: 'Employees', align: 'right' },
                  { key: 'amount', label: 'Amount', align: 'right', render: (row) => money(row.amount) },
                ]}
                rows={data.pt.byState}
              />
            </SectionCard>
          ) : null}

          {/* §15 — TDS by department */}
          {data.tds?.byDepartment?.length ? (
            <SectionCard className="mt-4" title="TDS by department" subtitle={`${monthLabel(month)}`}>
              <DataTable
                headers={[
                  { key: 'department', label: 'Department', strong: true },
                  { key: 'employees', label: 'Employees', align: 'right' },
                  { key: 'amount', label: 'TDS', align: 'right', render: (row) => money(row.amount) },
                ]}
                rows={data.tds.byDepartment}
              />
            </SectionCard>
          ) : null}

          {/* §15 — the financial-year view */}
          <SectionCard
            className="mt-4"
            title="Financial year summary"
            subtitle="§15 — the same components across the whole year"
            actions={
              <div className="flex items-center gap-2">
                <select
                  className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm text-crewly-text"
                  value={financialYear}
                  onChange={(event) => setFinancialYear(event.target.value)}
                >
                  {[0, 1, 2].map((back) => {
                    const year = Number(String(currentFinancialYear()).split('-')[0]) - back;
                    const label = `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
                    return <option key={label} value={label}>FY {label}</option>;
                  })}
                </select>
                <ExportMenu
                  reportKey="STATUTORY"
                  filters={{ financialYear, departmentId }}
                  onQueued={setBanner}
                />
              </div>
            }
          >
            {yearly.loading ? (
              <p className="text-sm text-crewly-dim">Loading the year…</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <KpiCard label="Total liability" value={money(yearTotals.totalLiability)} />
                <KpiCard label="Employee share" value={money(yearTotals.employee)} />
                <KpiCard label="Employer share" value={money(yearTotals.employer)} />
                <KpiCard label="Gratuity provision" value={money(yearTotals.gratuityProvision)} />
              </div>
            )}
            <p className="mt-3 text-xs text-crewly-dim">
              The year summary uses the financial year {financialYear}, which starts in April. Each
              month is read from its own snapshot — nothing is annualised by projection (§11).
            </p>
          </SectionCard>
        </>
      ) : null}
    </div>
  );
};

export default StatutorySummaryPage;
