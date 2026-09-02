import { useState } from 'react';
import { UserMinus } from 'lucide-react';

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
  formatDate,
  money,
  monthLabel,
  useDepartments,
  useReport,
  usePayrollMonths,
} from './analyticsShared.js';

// ───────────────────────────────────────────────────────────────────────────
// §20 — F&F Analytics: the cost of people leaving.
//
// Everything here is READ from the finalised settlement register (29.11).
// This page never calculates a settlement — that is the F&F module's job and
// its numbers are the ones the employee was paid on.
//
// A draft settlement is listed but never counted as money spent: it is a
// proposal, not a payment.
// ───────────────────────────────────────────────────────────────────────────

const FnfAnalyticsPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();
  const canRead = hasAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']);

  const departments = useDepartments();
  const months = usePayrollMonths(!permsLoading && canRead);
  const [month, setMonth] = useState(currentMonth());
  const [departmentId, setDepartmentId] = useState('');
  const [banner, setBanner] = useState(null);

  const filters = { month, departmentId };
  const { report, loading, denied, error } = useReport({
    reportKey: 'FNF',
    filters,
    enabled: !permsLoading && canRead,
  });

  const rows = report?.rows || [];
  const totals = report?.totals || {};

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader icon={UserMinus} title="F&F Analytics" subtitle="The cost of people leaving" />
        <AccessDenied />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        icon={UserMinus}
        title="F&F Analytics"
        subtitle={`${monthLabel(month)} · §20 settlements, read from the finalised register`}
        actions={<ExportMenu reportKey="FNF" filters={filters} onQueued={setBanner} />}
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
      {loading ? <p className="text-sm text-crewly-dim">Loading settlement analytics…</p> : null}

      {!loading && report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Settlements" value={count(report.count)} hint={`${count(report.completed?.count)} completed · ${count(report.pending?.count)} in progress`} />
            <KpiCard label="Net settled" value={money(totals.netSettlement)} />
            <KpiCard label="Leave encashment" value={money(totals.leaveEncashment)} tone="info" />
            <KpiCard label="Recoveries" value={money(totals.recoveriesTotal)} tone="warn" hint="notice pay and other dues" />
            <KpiCard label="Pending salary paid" value={money(totals.pendingSalary)} />
            <KpiCard label="Notice recovery" value={money(totals.noticeRecovery)} />
            <KpiCard label="Other recoveries" value={money(totals.otherRecoveries)} />
            <KpiCard
              label="Average settlement"
              value={money(Number(report.count) ? Number(totals.netSettlement) / Number(report.count) : 0)}
            />
          </div>

          <SectionCard className="mt-4" title="Settlement register" subtitle="§20 — every settlement in the period">
            <DataTable
              headers={[
                { key: 'settlementNumber', label: 'Settlement', strong: true },
                { key: 'employeeName', label: 'Employee' },
                { key: 'month', label: 'Month', render: (row) => monthLabel(row.month) },
                { key: 'lastWorkingDate', label: 'Last working day', render: (row) => formatDate(row.lastWorkingDate) },
                { key: 'netSettlement', label: 'Net settlement', align: 'right', render: (row) => money(row.netSettlement) },
                { key: 'leaveEncashment', label: 'Leave encashment', align: 'right', render: (row) => money(row.leaveEncashment) },
                { key: 'noticeRecovery', label: 'Notice recovery', align: 'right', render: (row) => money(row.noticeRecovery) },
                { key: 'status', label: 'Status' },
                { key: 'paidAt', label: 'Paid on', render: (row) => formatDate(row.paidAt) },
              ]}
              rows={rows}
              footer={[
                { value: 'Total', strong: true },
                { value: '' },
                { value: '' },
                { value: '' },
                { value: money(totals.netSettlement), align: 'right', strong: true },
                { value: money(totals.leaveEncashment), align: 'right', strong: true },
                { value: money(totals.noticeRecovery), align: 'right', strong: true },
                { value: '' },
                { value: '' },
              ]}
              empty="No settlements in this period"
            />
            <p className="mt-3 border-t border-white/5 pt-2 text-xs text-crewly-dim">
              Only PAID and CLOSED settlements count as money spent. A draft is listed because it
              exists, but it is not a payment yet.
            </p>
          </SectionCard>
        </>
      ) : null}
    </div>
  );
};

export default FnfAnalyticsPage;
