import { useState } from 'react';
import { BarChart3, Wallet } from 'lucide-react';

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
// §6 — Payroll Overview, plus §14 leave impact and §16 cost to company.
//
// The three sections the brief describes but does not give their own page:
//   §14  leave impact — LOP days and what they cost, by department
//   §16  CTC — Finance only, so the block is permission-gated here as well as
//        on the server (§25: never hidden by a tab alone)
// ───────────────────────────────────────────────────────────────────────────

const PayrollOverviewPage = () => {
  const { loading: permsLoading, hasAnyPermission, hasPermission } = usePermission();
  const canRead = hasAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']);
  const canSeeFinancial = hasPermission('PAYROLL_ANALYTICS_FINANCIAL');

  const departments = useDepartments();
  const months = usePayrollMonths(!permsLoading && canRead);
  const [month, setMonth] = useState(currentMonth());
  const [departmentId, setDepartmentId] = useState('');
  const [banner, setBanner] = useState(null);

  const filters = { month, departmentId };

  const overview = useReport({ reportKey: 'OVERVIEW', filters, enabled: !permsLoading && canRead });
  const leave = useReport({ reportKey: 'LEAVE', filters, enabled: !permsLoading && canRead });
  const ctc = useReport({
    reportKey: 'CTC',
    filters,
    enabled: !permsLoading && canRead && canSeeFinancial,
  });

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader icon={BarChart3} title="Payroll Overview" subtitle="Gross, net, deductions, employer cost and settlements" />
        <AccessDenied />
      </div>
    );
  }

  const summary = overview.report?.summary || {};
  const leaveData = leave.report || {};
  const ctcData = ctc.report || {};

  const summaryCards = [
    ['Gross salary', money(summary.grossSalary)],
    ['Total earnings', money(summary.earningsTotal)],
    ['Deductions', money(summary.deductionsTotal)],
    ['Net salary', money(summary.netSalary)],
    ['Employer cost', money(summary.employerContribution)],
    ['Total payroll cost', money(summary.totalPayrollCost)],
    ['Paid employees', count(summary.employeesPaid)],
    ['Average salary', money(summary.averageSalary)],
  ];

  return (
    <div className="p-6">
      <PageHeader
        icon={BarChart3}
        title="Payroll Overview"
        subtitle={`${monthLabel(month)} · §6 payroll summary`}
        actions={<ExportMenu reportKey="OVERVIEW" filters={filters} onQueued={setBanner} />}
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

      {overview.loading ? <p className="text-sm text-crewly-dim">Loading the payroll overview…</p> : null}

      {!overview.loading && overview.report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {summaryCards.map(([label, value]) => (
              <KpiCard key={label} label={label} value={value} />
            ))}
          </div>

          <SectionCard className="mt-4" title="By department" subtitle="§6 — where the money went">
            <DataTable
              headers={[
                { key: 'department', label: 'Department', strong: true },
                { key: 'employees', label: 'Employees', align: 'right' },
                { key: 'gross', label: 'Gross', align: 'right', render: (row) => money(row.gross) },
                { key: 'net', label: 'Net', align: 'right', render: (row) => money(row.net) },
                { key: 'employerCost', label: 'Employer cost', align: 'right', render: (row) => money(row.employerCost) },
                { key: 'totalCost', label: 'Total cost', align: 'right', render: (row) => money(row.totalCost) },
                { key: 'averageSalary', label: 'Average', align: 'right', render: (row) => money(row.averageSalary) },
              ]}
              rows={overview.report.rows || []}
            />
          </SectionCard>
        </>
      ) : null}

      {/* §14 — leave impact */}
      <SectionCard
        className="mt-4"
        title="Leave Impact"
        subtitle="§14 — loss of pay and the cost of paid leave"
      >
        {leave.loading ? (
          <p className="text-sm text-crewly-dim">Loading leave impact…</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard label="Total LOP days" value={count(leaveData.lopDays)} />
              <KpiCard label="LOP deduction" value={money(leaveData.lopDeduction)} tone="warn" />
              <KpiCard label="Paid leave days" value={count(leaveData.paidLeaveDays)} />
              <KpiCard label="Paid leave cost" value={money(leaveData.paidLeaveCost)} />
            </div>
            {leaveData.derived ? (
              <p className="mt-3 text-xs text-crewly-dim">
                The engine stores leave in days, not rupees. These amounts are derived from the daily
                rate the payroll snapshot implies (gross ÷ working days) and are flagged as derived in
                the export.
              </p>
            ) : null}
            <div className="mt-3">
              <DataTable
                headers={[
                  { key: 'department', label: 'Department', strong: true },
                  { key: 'employees', label: 'Employees', align: 'right' },
                  { key: 'lopDays', label: 'LOP days', align: 'right' },
                  { key: 'lopDeduction', label: 'LOP deduction', align: 'right', render: (row) => money(row.lopDeduction) },
                  { key: 'paidLeaveCost', label: 'Paid leave cost', align: 'right', render: (row) => money(row.paidLeaveCost) },
                ]}
                rows={leaveData.byDepartment || []}
                empty="No leave impact for this month"
              />
            </div>
          </>
        )}
      </SectionCard>

      {/* §16 — cost to company, Finance only */}
      <SectionCard
        className="mt-4"
        title="Cost to Company"
        subtitle="§16 — what each employee really costs the company"
        actions={canSeeFinancial ? <ExportMenu reportKey="CTC" filters={filters} onQueued={setBanner} /> : null}
      >
        {!canSeeFinancial ? (
          <p className="text-sm text-crewly-dim">
            This report is restricted to Finance (§16). Ask a Company Admin for financial analytics
            access if you need it.
          </p>
        ) : ctc.loading ? (
          <p className="text-sm text-crewly-dim">Loading the CTC breakdown…</p>
        ) : ctc.denied ? (
          <AccessDenied message="Your role does not include financial analytics access." />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard icon={Wallet} label="Gross salary" value={money(ctcData.grossSalary)} />
              <KpiCard label="Employer PF" value={money(ctcData.employerPf)} />
              <KpiCard label="Employer ESI" value={money(ctcData.employerEsi)} />
              <KpiCard label="Gratuity" value={money(ctcData.gratuity)} />
            </div>
            <div className="mt-3">
              <DataTable
                headers={[
                  { key: 'label', label: 'Component', strong: true },
                  { key: 'amount', label: 'Amount', align: 'right', render: (row) => money(row.amount) },
                  {
                    key: 'share',
                    label: 'Share',
                    align: 'right',
                    render: (row) =>
                      percent(Number(ctcData.totalCompanyPayrollCost)
                        ? (Number(row.amount) / Number(ctcData.totalCompanyPayrollCost)) * 100
                        : 0),
                  },
                ]}
                rows={ctcData.buckets || []}
                footer={[
                  { value: 'Total company payroll cost', strong: true },
                  { value: money(ctcData.totalCompanyPayrollCost), align: 'right', strong: true },
                  { value: '100%', align: 'right', strong: true },
                ]}
              />
            </div>
            {ctcData.reconciled === false ? (
              <div className="mt-3">
                <Banner
                  type="warn"
                  text="The employer contribution recorded on these snapshots does not cover the PF, ESI, LWF and gratuity identified in them, so the 'other benefits' line is negative. Check the salary structure's employer components."
                />
              </div>
            ) : null}
          </>
        )}
      </SectionCard>
    </div>
  );
};

export default PayrollOverviewPage;
