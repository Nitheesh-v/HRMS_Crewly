/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FileSpreadsheet, History, Loader2, RefreshCcw } from 'lucide-react';
import { Link } from 'react-router-dom';

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
  Pagination,
  SearchBox,
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
//
// 29.13 §22 — the register pages and searches ON THE SERVER. Five thousand
// employees is a spreadsheet, not a web page; the totals beside the pager stay
// the whole period, so paging never looks like the payroll shrank.
//
// 29.13 §22 — the columns Finance asked for: basic, employer cost and payroll
// status, alongside the ones that were already here. The second money column
// is the STRUCTURE gross — the PF/ESI wage base — because analytics' "gross"
// is already total earnings, and printing the same number twice would be a
// lie of omission.
// ───────────────────────────────────────────────────────────────────────────

const PAYMENT_STYLES = {
  PAID: 'bg-emerald-500/15 text-emerald-300',
  PENDING: 'bg-amber-500/15 text-amber-300',
  FAILED: 'bg-red-500/15 text-red-300',
  NOT_IN_BATCH: 'bg-slate-500/15 text-slate-300',
};

const statusBadge = (status) => (
  <span className={`rounded-full px-2 py-0.5 text-[11px] ${PAYMENT_STYLES[status] || PAYMENT_STYLES.NOT_IN_BATCH}`}>
    {status || 'NOT_IN_BATCH'}
  </span>
);

// A generated FILE has its own lifecycle — queued, processing, ready, failed.
// Reusing the payment badge for it would label a ready file "PAID".
const FILE_STYLES = {
  READY: 'bg-emerald-500/15 text-emerald-300',
  QUEUED: 'bg-slate-500/15 text-slate-300',
  PROCESSING: 'bg-sky-500/15 text-sky-300',
  FAILED: 'bg-red-500/15 text-red-300',
};

const fileBadge = (status) => (
  <span className={`rounded-full px-2 py-0.5 text-[11px] ${FILE_STYLES[status] || FILE_STYLES.QUEUED}`}>
    {status || 'QUEUED'}
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
  // §24 — two more filters that have backing data. Pay group, location and
  // cost centre were asked for too, but no collection carries them, so they
  // are not offered: a filter that always returns nothing is worse than no
  // filter.
  const [employmentStatus, setEmploymentStatus] = useState('');
  const [structureId, setStructureId] = useState('');
  // §22 — paging and search live in the query, not in the browser: the server
  // returns one page, and the count stays the whole period.
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const PAGE_SIZE = 25;
  const [banner, setBanner] = useState(null);
  const [files, setFiles] = useState([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [downloading, setDownloading] = useState('');

  const filters = { month, departmentId, status, designation, employmentStatus, structureId, page, limit: PAGE_SIZE, search };
  const { report, loading, denied, error, reload } = useReport({
    reportKey: 'REGISTER',
    filters,
    enabled: !permsLoading && canRead,
  });

  const rows = useMemo(() => report?.rows || [], [report]);
  const summary = report?.summary || {};
  const pagination = report?.pagination || null;

  // The designation list is whatever this company actually used, so the filter
  // never offers an option that returns nothing.
  const designations = useMemo(
    () => [...new Set(rows.map((row) => row.designation).filter(Boolean))].sort(),
    [rows],
  );

  // The salary structures on this page's rows. A filter offering a structure
  // nobody is on would be a filter that always answers "nothing".
  const structures = useMemo(() => {
    const seen = new Map();
    rows.forEach((row) => {
      if (row.structureId && !seen.has(row.structureId)) {
        seen.set(row.structureId, row.structureName || 'Salary structure');
      }
    });
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [rows]);

  // Typing in the search box or changing a filter must go back to page one:
  // staying on page seven of a two-page result is a bug that looks like data
  // loss.
  useEffect(() => { setPage(1); }, [search, month, departmentId, status, designation, employmentStatus, structureId]);

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
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
          Employment
          <select
            className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
            value={employmentStatus}
            onChange={(event) => setEmploymentStatus(event.target.value)}
          >
            <option value="">Everyone</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </label>

        {structures.length ? (
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-crewly-dim">
            Salary structure
            <select
              className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-sm normal-case text-crewly-text"
              value={structureId}
              onChange={(event) => setStructureId(event.target.value)}
            >
              <option value="">All structures</option>
              {structures.map((structure) => (
                <option key={structure.value} value={structure.value}>{structure.label}</option>
              ))}
            </select>
          </label>
        ) : null}

        <SearchBox value={search} onChange={setSearch} />

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
            <KpiCard
              label="Employees"
              value={count(pagination?.total ?? rows.length)}
              hint={pagination?.pages > 1 ? `showing ${count(rows.length)} on this page` : ''}
            />
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
                { key: 'month', label: 'Period', render: (row) => monthLabel(row.month) },
                { key: 'basic', label: 'Basic', align: 'right', render: (row) => money(row.basic) },
                { key: 'gross', label: 'Gross', align: 'right', render: (row) => money(row.gross) },
                { key: 'fixedGross', label: 'Structure gross', align: 'right', render: (row) => money(row.fixedGross) },
                { key: 'totalDeductions', label: 'Deductions', align: 'right', render: (row) => money(row.totalDeductions) },
                { key: 'net', label: 'Net', align: 'right', render: (row) => money(row.net) },
                { key: 'employerCost', label: 'Employer cost', align: 'right', render: (row) => money(row.employerCost) },
                { key: 'paidAt', label: 'Payment date' },
                { key: 'paymentStatus', label: 'Payment', render: (row) => statusBadge(row.paymentStatus) },
                { key: 'payrollStatus', label: 'Payroll', render: (row) => statusBadge(row.payrollStatus) },
                {
                  key: 'history',
                  label: '',
                  align: 'right',
                  render: (row) => (
                    <Link
                      to={`/app/payroll/analytics/salary-history/${row.employeeId}`}
                      className="flex items-center gap-1 text-xs text-sky-300 hover:underline"
                      title="Salary history"
                    >
                      <History size={12} />
                      History
                    </Link>
                  ),
                },
              ]}
              rows={rows}
              footer={[
                { value: 'Whole period', strong: true },
                { value: '' },
                { value: '' },
                { value: '' },
                { value: money(summary.grossSalary), align: 'right', strong: true },
                { value: money(summary.fixedGross ?? 0), align: 'right', strong: true },
                { value: money(summary.deductionsTotal), align: 'right', strong: true },
                { value: money(summary.netSalary), align: 'right', strong: true },
                { value: money(summary.employerContribution), align: 'right', strong: true },
                { value: '' },
                { value: '' },
                { value: '' },
                { value: '' },
              ]}
              empty={search ? 'Nobody matches that search' : 'No payroll records for this month'}
            />
            <Pagination pagination={pagination} onPageChange={setPage} />
            <p className="mt-3 border-t border-white/5 pt-2 text-xs text-crewly-dim">
              Payment date and status come from the salary payment records. An employee whose transfer
              failed and was retried appears once, with the successful payment (§17). &ldquo;Gross&rdquo;
              is total earnings — structure plus variable pay plus overtime — while &ldquo;structure
              gross&rdquo; is the PF and ESI wage base. The footer totals the whole period, not just
              this page.
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
                    {
                      key: 'status',
                      label: 'Status',
                      render: (row) => (
                        <span>
                          {fileBadge(row.status)}
                          {row.error ? <span className="block text-[10px] text-red-300">{row.error}</span> : null}
                        </span>
                      ),
                    },
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
