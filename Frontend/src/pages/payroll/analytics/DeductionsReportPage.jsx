import { useState } from 'react';
import { Scissors } from 'lucide-react';

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
// §12 — Deductions: PF, ESI, PT, TDS, LWF, LOP and everything else.
//
// The split that matters is statutory vs LOP vs other:
//   · statutory is money the company holds and must remit
//   · LOP is salary never earned, so it is not a remittance at all
//   · everything else is a company rule — a fine, an advance, a canteen charge
//
// The total is also shown as a share of gross, because "we deducted 41 lakhs"
// means nothing without knowing the payroll it came out of.
// ───────────────────────────────────────────────────────────────────────────

const DeductionsReportPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();
  const canRead = hasAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']);

  const departments = useDepartments();
  const months = usePayrollMonths(!permsLoading && canRead);
  const [month, setMonth] = useState(currentMonth());
  const [departmentId, setDepartmentId] = useState('');
  const [banner, setBanner] = useState(null);

  const filters = { month, departmentId };
  const { report, loading, denied, error } = useReport({
    reportKey: 'DEDUCTIONS',
    filters,
    enabled: !permsLoading && canRead,
  });

  const rows = report?.rows || [];
  const components = report?.components || [];
  const totals = report?.totals || {};

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader icon={Scissors} title="Deduction Analytics" subtitle="Statutory, LOP and other" />
        <AccessDenied />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        icon={Scissors}
        title="Deduction Analytics"
        subtitle={`${monthLabel(month)} · §12 PF, ESI, PT, TDS, LWF, LOP and the rest`}
        actions={<ExportMenu reportKey="DEDUCTIONS" filters={filters} onQueued={setBanner} />}
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
      {loading ? <p className="text-sm text-crewly-dim">Loading the deduction report…</p> : null}

      {!loading && report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Total deductions" value={money(totals.totalDeductions)} hint={`${percent(totals.percentOfGross)} of gross payroll`} />
            <KpiCard label="Statutory" value={money(totals.statutoryTotal)} tone="info" hint="PF, ESI, PT, TDS and LWF" />
            <KpiCard label="Loss of pay" value={money(totals.lopTotal)} tone="warn" hint="salary never earned" />
            <KpiCard label="Other" value={money(totals.otherTotal)} hint="company rules, fines, inputs" />
          </div>

          <SectionCard className="mt-4" title="By kind" subtitle="§12 — what the deduction is for">
            <DataTable
              headers={[
                { key: 'label', label: 'Deduction', strong: true },
                { key: 'employees', label: 'Employees', align: 'right', render: (row) => count(row.employees) },
                { key: 'amount', label: 'Amount', align: 'right', render: (row) => money(row.amount) },
                { key: 'percentOfGross', label: '% of gross', align: 'right', render: (row) => percent(row.percentOfGross) },
              ]}
              rows={rows}
              empty="No deductions recorded for this period"
            />
          </SectionCard>

          <SectionCard className="mt-4" title="By component" subtitle="§12 — every deduction line, including the ones with no statutory home">
            <DataTable
              headers={[
                { key: 'label', label: 'Component', strong: true },
                { key: 'employees', label: 'Employees', align: 'right', render: (row) => count(row.employees) },
                { key: 'amount', label: 'Amount', align: 'right', render: (row) => money(row.amount) },
                { key: 'percentOfGross', label: '% of gross', align: 'right', render: (row) => percent(row.percentOfGross) },
              ]}
              rows={components}
              empty="No deduction components for this period"
            />
            {Math.abs(Number(totals.snapshotTotal) - Number(totals.totalDeductions)) >= 1 ? (
              <div className="mt-3">
                <Banner
                  type="warn"
                  text={`The payroll runs recorded ${money(totals.snapshotTotal)} of deductions, but only ${money(totals.totalDeductions)} of that has a named line. The difference is company-level — it is shown, not hidden.`}
                  onClose={() => {}}
                />
              </div>
            ) : null}
            <p className="mt-3 border-t border-white/5 pt-2 text-xs text-crewly-dim">
              The totals come from the snapshot&apos;s own deduction figures, not from adding the lines
              up, so a company whose structure deducts without a line is still reported correctly.
            </p>
          </SectionCard>
        </>
      ) : null}
    </div>
  );
};

export default DeductionsReportPage;
