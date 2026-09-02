import { useState } from 'react';
import { Coins } from 'lucide-react';

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
// §11 — Earnings: every component the company pays, split into fixed pay,
// variable pay, overtime and reimbursements.
//
// "Break down earnings by component and type." The components come from the
// 29.6 snapshot's own earning lines; nothing is recomputed here.
//
// The report says whether its own parts add up to its whole (`reconciled`).
// If they ever do not, the page says so instead of printing a total nobody
// can tie.
// ───────────────────────────────────────────────────────────────────────────

const EarningsReportPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();
  const canRead = hasAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']);

  const departments = useDepartments();
  const months = usePayrollMonths(!permsLoading && canRead);
  const [month, setMonth] = useState(currentMonth());
  const [departmentId, setDepartmentId] = useState('');
  const [banner, setBanner] = useState(null);

  const filters = { month, departmentId };
  const { report, loading, denied, error } = useReport({
    reportKey: 'EARNINGS',
    filters,
    enabled: !permsLoading && canRead,
  });

  const rows = report?.rows || [];
  const totals = report?.totals || {};

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader icon={Coins} title="Earnings Analytics" subtitle="Every component, by type" />
        <AccessDenied />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        icon={Coins}
        title="Earnings Analytics"
        subtitle={`${monthLabel(month)} · §11 components split into fixed, variable, overtime and reimbursements`}
        actions={<ExportMenu reportKey="EARNINGS" filters={filters} onQueued={setBanner} />}
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
      {loading ? <p className="text-sm text-crewly-dim">Loading the earnings report…</p> : null}

      {!loading && report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Gross payroll" value={money(totals.grossPayroll)} />
            <KpiCard label="Fixed earnings" value={money(totals.fixedEarnings)} tone="info" />
            <KpiCard label="Variable pay" value={money(totals.variableEarnings)} tone="warn" />
            <KpiCard label="Overtime" value={money(totals.overtime)} />
            <KpiCard label="Bonus" value={money(totals.bonus)} hint="performance, festival and the like" />
            <KpiCard label="Incentive" value={money(totals.incentive)} />
            <KpiCard label="Commission" value={money(totals.commission)} />
            <KpiCard label="Reimbursements" value={money(totals.reimbursements)} hint="paid on top of salary, not part of it" />
          </div>

          {totals.reconciled === false ? (
            <div className="mt-4">
              <Banner
                type="warn"
                text="The earnings components do not add up to the gross payroll for this period. The figures below are still what the snapshots hold — check the payroll run before quoting them."
              />
            </div>
          ) : null}

          <SectionCard className="mt-4" title="By component" subtitle="§11 — every earning line the engine wrote">
            <DataTable
              headers={[
                { key: 'label', label: 'Component', strong: true },
                { key: 'categoryLabel', label: 'Type' },
                { key: 'kind', label: 'Kind', render: (row) => (row.kind && row.kind !== 'OTHER_VARIABLE' ? String(row.kind).toLowerCase() : '—') },
                { key: 'employees', label: 'Employees', align: 'right', render: (row) => count(row.employees) },
                { key: 'amount', label: 'Amount', align: 'right', render: (row) => money(row.amount) },
                {
                  key: 'share',
                  label: 'Share',
                  align: 'right',
                  render: (row) => percent(Number(totals.total) ? (Number(row.amount) / Number(totals.total)) * 100 : 0),
                },
              ]}
              rows={rows}
              footer={[
                { value: 'Total', strong: true },
                { value: '' },
                { value: '' },
                { value: count(report?.summary?.employeesPaid), align: 'right', strong: true },
                { value: money(totals.total), align: 'right', strong: true },
                { value: '' },
              ]}
              empty="No earnings recorded for this period"
            />
            <p className="mt-3 border-t border-white/5 pt-2 text-xs text-crewly-dim">
              Reimbursements are shown with earnings because they are paid through payroll, but they
              are not salary — they are the company giving an employee their own money back.
            </p>
          </SectionCard>
        </>
      ) : null}
    </div>
  );
};

export default EarningsReportPage;
