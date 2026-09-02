/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FileSpreadsheet, Loader2, RefreshCcw } from 'lucide-react';

import usePermission from '../../../hooks/usePermission.js';
import payrollAnalyticsService, { saveBlob } from '../../../services/payrollAnalyticsService.js';

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
  formatDateTime,
  money,
  monthLabel,
  useDepartments,
  useReport,
  usePayrollMonths,
} from './analyticsShared.js';

// ───────────────────────────────────────────────────────────────────────────
// §17 — the Payroll Register, the master record: employee ID, name,
// department, gross, deductions, net, payment date and status, exportable to
// Excel / CSV / PDF.
//
// Large registers are generated in the background (§19 / §22), so the page
// also lists the files it has produced.
// ───────────────────────────────────────────────────────────────────────────

const STATUS_STYLES = {
  PAID: 'bg-emerald-500/15 text-emerald-300',
  PENDING: 'bg-amber-500/15 text-amber-300',
  FAILED: 'bg-red-500/15 text-red-300',
  NOT_IN_BATCH: 'bg-slate-500/15 text-slate-300',
};

const statusBadge = (status) => (
  <span className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS_STYLES[status] || STATUS_STYLES.NOT_IN_BATCH}`}>
    {status || 'NOT_IN_BATCH'}
  </span>
);

const PayrollRegisterPage = () => {
  const { loading: permsLoading, hasAnyPermission, hasPermission } = usePermission();
  const canRead = hasAnyPermission(['PAYROLL_REPORT_READ', 'PAYROLL_REPORT_EXPORT', 'PAYROLL_ANALYTICS_FINANCIAL', 'PAYROLL_ANALYTICS_SCHEDULE']);
  const canExport = hasPermission('PAYROLL_REPORT_EXPORT');

  const departments = useDepartments();
  const months = usePayrollMonths(!permsLoading && canRead);
  const [month, setMonth] = useState(currentMonth());
  const [departmentId, setDepartmentId] = useState('');
  const [status, setStatus] = useState('');
  const [designation, setDesignation] = useState('');
  const [banner, setBanner] = useState(null);
  const [files, setFiles] = useState([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [downloading, setDownloading] = useState('');

  const filters = { month, departmentId, status, designation };
  const { report, loading, denied, error, reload } = useReport({
    reportKey: 'REGISTER',
    filters,
    enabled: !permsLoading && canRead,
  });

  const rows = useMemo(() => report?.rows || [], [report]);
  const summary = report?.summary || {};

  // The designation list is whatever this company actually used, so the filter
  // never offers an option that returns nothing.
  const designations = useMemo(
    () => [...new Set(rows.map((row) => row.designation).filter(Boolean))].sort(),
    [rows],
  );

  const loadFiles = useCallback(async () => {
    if (!canExport) return;
    setFilesLoading(true);
    try {
      const data = await payrollAnalyticsService.files('REGISTER');
      setFiles(Array.isArray(data) ? data : data?.files || []);
    } catch {
      setFiles([]);
    } finally {
      setFilesLoading(false);
    }
  }, [canExport]);

  useEffect(() => {
    if (!permsLoading && canRead) loadFiles();
  }, [permsLoading, canRead, loadFiles]);

  const downloadFile = async (file) => {
    setDownloading(file._id);
    try {
      const blob = await payrollAnalyticsService.downloadFile(file._id);
      saveBlob(blob, file.filename || 'payroll-register.xlsx');
    } catch (err) {
      setBanner({ type: 'error', text: err?.message || 'Unable to download this file' });
    } finally {
      setDownloading('');
    }
  };

  if (!permsLoading && !canRead) {
    return (
      <div className="p-6">
        <PageHeader icon={FileSpreadsheet} title="Payroll Register" subtitle="The master record for the month" />
        <AccessDenied />
      </div>
    );
  }

  return (
    <div className="p-6">
      <PageHeader
        icon={FileSpreadsheet}
        title="Payroll Register"
        subtitle={`${monthLabel(month)} · §17 the master payroll record`}
        actions={<ExportMenu reportKey="REGISTER" filters={filters} onQueued={(result) => {
          setBanner(result?.queued
            ? { type: 'success', text: 'Register queued — it will appear under Generated files' }
            : { type: 'success', text: 'Register downloaded' });
          loadFiles();
        }} />}
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
        designations={designations}
        designation={designation}
        onDesignationChange={setDesignation}
        status={status}
        onStatusChange={setStatus}
      >
        <button
          type="button"
          onClick={() => { reload(); loadFiles(); }}
          className="flex items-center gap-1.5 rounded-md border border-white/10 px-3 py-1.5 text-sm text-crewly-text hover:bg-white/5"
        >
          <RefreshCcw size={14} />
          Refresh
        </button>
      </FilterBar>

      {denied ? <AccessDenied /> : null}
      {loading ? <p className="text-sm text-crewly-dim">Loading the payroll register…</p> : null}

      {!loading && report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Employees" value={count(rows.length)} />
            <KpiCard label="Gross" value={money(summary.grossSalary)} />
            <KpiCard label="Deductions" value={money(summary.deductionsTotal)} />
            <KpiCard label="Net paid" value={money(summary.netSalary)} />
          </div>

          <SectionCard className="mt-4" title="Register" subtitle="§17 — every paid employee, in one table">
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
                { key: 'gross', label: 'Gross', align: 'right', render: (row) => money(row.gross) },
                { key: 'totalDeductions', label: 'Deductions', align: 'right', render: (row) => money(row.totalDeductions) },
                { key: 'net', label: 'Net', align: 'right', render: (row) => money(row.net) },
                { key: 'employerCost', label: 'Employer cost', align: 'right', render: (row) => money(row.employerCost) },
                { key: 'paidAt', label: 'Payment date' },
                { key: 'paymentStatus', label: 'Status', render: (row) => statusBadge(row.paymentStatus) },
              ]}
              rows={rows}
              footer={[
                { value: 'Total', strong: true },
                { value: '' },
                { value: '' },
                { value: money(summary.grossSalary), align: 'right', strong: true },
                { value: money(summary.deductionsTotal), align: 'right', strong: true },
                { value: money(summary.netSalary), align: 'right', strong: true },
                { value: money(summary.employerContribution), align: 'right', strong: true },
                { value: '' },
                { value: '' },
              ]}
              empty="No payroll records for this month"
            />
            <p className="mt-3 border-t border-white/5 pt-2 text-xs text-crewly-dim">
              Payment date and status come from the salary payment records. An employee whose transfer
              failed and was retried appears once, with the successful payment (§17).
            </p>
          </SectionCard>

          {/* §19 — queued exports */}
          {canExport ? (
            <SectionCard
              className="mt-4"
              title="Generated files"
              subtitle="§19 — large exports are built in the background"
            >
              {filesLoading ? (
                <p className="text-sm text-crewly-dim">Loading…</p>
              ) : files.length ? (
                <DataTable
                  headers={[
                    { key: 'filename', label: 'File', strong: true },
                    { key: 'format', label: 'Format' },
                    { key: 'month', label: 'Month', render: (row) => monthLabel(row.month) },
                    { key: 'status', label: 'Status', render: (row) => statusBadge(row.status === 'READY' ? 'PAID' : 'PENDING') },
                    { key: 'rowCount', label: 'Rows', align: 'right' },
                    { key: 'createdAt', label: 'Requested', render: (row) => formatDateTime(row.createdAt) },
                    {
                      key: 'actions',
                      label: '',
                      align: 'right',
                      render: (row) => (
                        <button
                          type="button"
                          disabled={row.status !== 'READY' || downloading === row._id}
                          onClick={() => downloadFile(row)}
                          className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-crewly-text hover:bg-white/5 disabled:opacity-40"
                        >
                          {downloading === row._id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                          Download
                        </button>
                      ),
                    },
                  ]}
                  rows={files}
                  empty="No exports yet — use Export to create one"
                />
              ) : (
                <p className="text-sm text-crewly-dim">No exports yet — use Export to create one.</p>
              )}
            </SectionCard>
          ) : null}
        </>
      ) : null}
    </div>
  );
};

export default PayrollRegisterPage;
