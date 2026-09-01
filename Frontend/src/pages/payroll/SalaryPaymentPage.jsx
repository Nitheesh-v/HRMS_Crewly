/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Ban,
  Banknote,
  Building2,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  History,
  Loader2,
  Lock,
  RefreshCcw,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Users,
  Wallet,
  XCircle,
} from 'lucide-react';

import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import payrollPaymentService from '../../services/payrollPaymentService.js';

// ─────────────────────────────────────────────────────────────
// Phase 29.8 — Salary Payment (bank transfer file preparation)
//
//   1. Month + KPI cards                    (§17)
//   2. Payment batch list                   (§18)
//   3. Create a batch from approved payroll (§5 / §6)
//   4. Bank validation report               (§7)
//   5. Generate CSV / XLSX                  (§10 / §20)
//   6. Employee payment table               (§9)
//   7. Failed transactions + retry batch    (§14 / §16)
//   8. Download history                     (§12)
//   9. Confirm / fail / cancel / reopen     (§13 / §4)
//
// CREWLY PREPARES, THE BANK PAYS. This page never talks to a bank
// and never generates a payslip (§25).
// ─────────────────────────────────────────────────────────────

const currentMonth = () => new Date().toISOString().slice(0, 7);

const formatMoney = (value) => `Rs ${Number(value || 0).toLocaleString('en-IN')}`;

const formatNumber = (value) => Number(value || 0).toLocaleString('en-IN');

const formatMonth = (month) => {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return month || '—';
  const [year, part] = String(month).split('-');
  return new Date(Number(year), Number(part) - 1, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
};

const formatStamp = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
};

const STATUS_LABELS = {
  DRAFT: 'Draft',
  READY: 'Ready',
  FILE_GENERATED: 'File generated',
  DOWNLOADED: 'Downloaded',
  PROCESSING: 'Processing',
  PAID: 'Paid',
  PARTIALLY_PAID: 'Partially paid',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const STATUS_STYLES = {
  DRAFT: 'bg-slate-500/15 text-slate-300',
  READY: 'bg-sky-500/15 text-sky-300',
  FILE_GENERATED: 'bg-indigo-500/15 text-indigo-300',
  DOWNLOADED: 'bg-violet-500/15 text-violet-300',
  PROCESSING: 'bg-amber-500/15 text-amber-300',
  PAID: 'bg-emerald-500/15 text-emerald-300',
  PARTIALLY_PAID: 'bg-orange-500/15 text-orange-300',
  FAILED: 'bg-red-500/15 text-red-300',
  CANCELLED: 'bg-slate-600/20 text-slate-400',
};

const statusBadge = (status) => (
  <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${STATUS_STYLES[status] || STATUS_STYLES.DRAFT}`}>
    {STATUS_LABELS[status] || status || 'Draft'}
  </span>
);

const PAYMENT_STATUS_STYLES = {
  PENDING: 'bg-slate-500/15 text-slate-300',
  PAID: 'bg-emerald-500/15 text-emerald-300',
  FAILED: 'bg-red-500/15 text-red-300',
};

const paymentBadge = (status) => (
  <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${PAYMENT_STATUS_STYLES[status] || PAYMENT_STATUS_STYLES.PENDING}`}>
    {String(status || 'PENDING').toLowerCase()}
  </span>
);

// §14 — the reasons finance may record for a returned salary.
const FAILURE_REASONS = [
  { key: 'INVALID_ACCOUNT', label: 'Invalid account' },
  { key: 'ACCOUNT_CLOSED', label: 'Account closed' },
  { key: 'IFSC_ERROR', label: 'IFSC error' },
  { key: 'BANK_REJECTED', label: 'Bank rejected' },
  { key: 'AMOUNT_FAILED', label: 'Amount failed' },
];

const KpiCard = ({ icon: Icon, label, value, hint, tone = 'default' }) => {
  const tones = {
    default: 'text-crewly-text',
    good: 'text-emerald-300',
    bad: 'text-red-300',
    warn: 'text-amber-300',
  };
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-crewly-dim">{label}</span>
        <Icon size={16} className="text-crewly-dim" />
      </div>
      <p className={`mt-2 text-xl font-semibold ${tones[tone] || tones.default}`}>{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-crewly-dim">{hint}</p> : null}
    </div>
  );
};

const SalaryPaymentPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();

  // §4 — permissions, never role names.
  const canRead = hasAnyPermission(['PAYROLL_PAYMENT_READ', 'PAYROLL_PAYMENT_GENERATE', 'PAYROLL_PAYMENT_CONFIRM']);
  const canGenerate = hasAnyPermission(['PAYROLL_PAYMENT_GENERATE']);
  const canConfirm = hasAnyPermission(['PAYROLL_PAYMENT_CONFIRM']);
  const canMark = hasAnyPermission(['PAYROLL_PAYMENT_MARK_PAID']);

  const [month, setMonth] = useState(currentMonth());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);
  const [accessDenied, setAccessDenied] = useState(false);

  const [kpis, setKpis] = useState({});
  const [batches, setBatches] = useState([]);
  const [detailId, setDetailId] = useState(null);
  const [prompt, setPrompt] = useState(null);

  const flash = useCallback((type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 6000);
  }, []);

  const load = useCallback(async () => {
    try {
      const dashboard = await payrollPaymentService.dashboard(month);
      setKpis(dashboard?.kpis || {});
      setBatches(dashboard?.batches || []);
      setAccessDenied(false);
    } catch (error) {
      if (error?.status === 403) setAccessDenied(true);
      else flash('error', error?.message || 'Unable to load salary payments');
    } finally {
      setLoading(false);
    }
  }, [month, flash]);

  useEffect(() => {
    if (!permsLoading && canRead) load();
    if (!permsLoading && !canRead) setLoading(false);
  }, [permsLoading, canRead, load]);

  const run = async (action, successText) => {
    setBusy(true);
    try {
      await action();
      flash('success', successText);
      await load();
      return true;
    } catch (error) {
      flash('error', error?.message || 'Unable to complete the action');
      await load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = () =>
    run(() => payrollPaymentService.createBatch(month), 'Payment batch created');

  const handleDownload = async (fileId) => {
    setBusy(true);
    try {
      // The endpoint streams the file (CSV text or an XLSX binary).
      const blob = await payrollPaymentService.downloadFile(fileId);
      const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]));
      const link = document.createElement('a');
      link.href = url;
      link.download = `salary-payment-${month}.${blob?.type?.includes('spreadsheet') ? 'xlsx' : 'csv'}`;
      link.click();
      URL.revokeObjectURL(url);
      flash('success', 'Bank file downloaded');
      await load();
    } catch (error) {
      flash('error', error?.message || 'Unable to download the file');
    } finally {
      setBusy(false);
    }
  };

  if ((!permsLoading && !canRead) || accessDenied) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Salary Payment</h1>
        <div className="card space-y-2">
          <h2 className="text-lg font-semibold">Payment access required</h2>
          <p className="text-sm text-crewly-dim">
            You don&apos;t have permission to view salary payments. Contact your Company Admin or
            Finance Manager.
          </p>
        </div>
      </div>
    );
  }

  const monthBatches = useMemo(() => batches, [batches]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Salary Payment</h1>
          <p className="mt-1 text-sm text-crewly-dim">
            Prepare the bank transfer file for an approved payroll. Crewly builds the file — your
            finance team uploads it to the company bank, and the bank pays (§1).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="month"
            className="input"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          />
          <button
            className="btn-primary"
            disabled={busy || !canGenerate}
            onClick={() =>
              setPrompt({
                kind: 'create',
                title: `Create a payment batch for ${formatMonth(month)}?`,
                body: 'Crewly reads the approved payroll snapshot, validates every bank account and creates one payment line per employee. Employees with broken bank details are listed in the validation report instead of being paid.',
                actionLabel: 'Create batch',
              })
            }
          >
            <Banknote size={15} /> Create payment batch
          </button>
        </div>
      </div>

      {banner ? (
        <div
          className={`card border-l-4 text-sm ${
            banner.type === 'error' ? 'border-red-500 text-red-200' : 'border-emerald-500 text-emerald-200'
          }`}
        >
          {banner.text}
        </div>
      ) : null}

      {/* §17 — KPI cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          icon={Wallet}
          label="Total payroll"
          value={formatMoney(kpis.totalPayroll)}
          hint={formatMonth(month)}
        />
        <KpiCard
          icon={Users}
          label="Paid employees"
          value={formatNumber(kpis.paidEmployees)}
          tone="good"
          hint="Transactions confirmed"
        />
        <KpiCard
          icon={XCircle}
          label="Failed payments"
          value={formatNumber(kpis.failedPayments)}
          tone={kpis.failedPayments > 0 ? 'bad' : 'default'}
          hint="Need a retry batch"
        />
        <KpiCard
          icon={Loader2}
          label="Pending payments"
          value={formatNumber(kpis.pendingPayments)}
          tone={kpis.pendingPayments > 0 ? 'warn' : 'default'}
          hint="Not confirmed yet"
        />
        <KpiCard
          icon={ShieldCheck}
          label="Total amount paid"
          value={formatMoney(kpis.totalAmountPaid)}
          tone="good"
          hint="Confirmed by finance"
        />
        <KpiCard
          icon={RotateCcw}
          label="Retry required"
          value={formatNumber(kpis.retryRequired)}
          tone={kpis.retryRequired > 0 ? 'warn' : 'default'}
          hint="Batches with failures"
        />
      </div>

      {/* §18 — batch list */}
      <div className="card overflow-x-auto p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">
            Payment batches
          </h2>
          <span className="text-xs text-crewly-dim">
            {monthBatches.length} batch(es) · {formatMonth(month)}
          </span>
        </div>

        <table className="w-full text-left text-sm">
          <thead className="bg-white/5 text-xs uppercase tracking-wide text-crewly-dim">
            <tr>
              <th className="px-3 py-2">Batch</th>
              <th className="px-3 py-2">Month</th>
              <th className="px-3 py-2">Employees</th>
              <th className="px-3 py-2">Total net salary</th>
              <th className="px-3 py-2">Paid / Failed</th>
              <th className="px-3 py-2">Payment date</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-crewly-dim">
                  <Loader2 className="mx-auto animate-spin" size={18} /> Loading payments…
                </td>
              </tr>
            ) : monthBatches.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-crewly-dim">
                  No payment batch for {formatMonth(month)} yet. Approve the payroll in{' '}
                  <Link className="text-indigo-300 hover:underline" to="/app/payroll/review">
                    Review Payroll
                  </Link>{' '}
                  first, then create a batch.
                </td>
              </tr>
            ) : (
              monthBatches.map((batch) => (
                <tr key={batch._id} className="border-t border-white/5 hover:bg-white/5">
                  <td className="px-3 py-2">
                    <p className="font-medium">{batch.batchNumber}</p>
                    {batch.attempt > 1 ? (
                      <p className="text-xs text-crewly-dim">retry #{formatNumber(batch.attempt)}</p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{formatMonth(batch.month)}</td>
                  <td className="px-3 py-2">{formatNumber(batch.summary?.totalEmployees)}</td>
                  <td className="px-3 py-2 font-semibold">
                    {formatMoney(batch.summary?.totalNetSalary)}
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-emerald-300">
                      {formatNumber(batch.summary?.successfulTransactions)}
                    </span>
                    {' / '}
                    <span className={batch.summary?.failedTransactions ? 'text-red-300' : ''}>
                      {formatNumber(batch.summary?.failedTransactions)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-crewly-dim">
                    {batch.paymentDate ? formatStamp(batch.paymentDate).split(',')[0] : '—'}
                  </td>
                  <td className="px-3 py-2">{statusBadge(batch.status)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      className="text-sm text-indigo-300 hover:underline"
                      onClick={() => setDetailId(batch._id)}
                    >
                      Open batch
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-crewly-dim">
        Every generation, download, confirmation and failure is written to the audit log (§22).
        Account numbers are masked everywhere except inside the generated file (§23).
      </p>

      {detailId ? (
        <BatchDetail
          batchId={detailId}
          busy={busy}
          canGenerate={canGenerate}
          canConfirm={canConfirm}
          canMark={canMark}
          onClose={() => setDetailId(null)}
          onChanged={load}
          onDownload={handleDownload}
          flash={flash}
        />
      ) : null}

      {prompt ? (
        <Modal title={prompt.title} onClose={() => setPrompt(null)}>
          <div className="space-y-3 text-sm">
            <p className="text-crewly-dim">{prompt.body}</p>
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setPrompt(null)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={busy}
                onClick={async () => {
                  setPrompt(null);
                  await handleCreate();
                }}
              >
                {busy ? <Loader2 className="animate-spin" size={15} /> : <Banknote size={15} />}
                {prompt.actionLabel}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// §18 — batch detail: employees, failures, downloads, validation
// ─────────────────────────────────────────────────────────────
const TABS = [
  { key: 'employees', label: 'Employees' },
  { key: 'failed', label: 'Failed' },
  { key: 'excluded', label: 'Validation' },
  { key: 'downloads', label: 'Downloads' },
  // §18 / §22 — every payment activity, newest first.
  { key: 'audit', label: 'Audit' },
];

const BatchDetail = ({
  batchId,
  busy,
  canGenerate,
  canConfirm,
  canMark,
  onClose,
  onChanged,
  onDownload,
  flash,
}) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('employees');
  const [validation, setValidation] = useState(null);
  const [failurePrompt, setFailurePrompt] = useState(null);
  const [failureReason, setFailureReason] = useState('INVALID_ACCOUNT');
  const [failureRemarks, setFailureRemarks] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [format, setFormat] = useState('CSV');
  // §18 — "everything should be searchable".
  const [search, setSearch] = useState('');
  // §18 / §22 — the batch's audit trail, loaded when the tab is opened.
  const [auditRows, setAuditRows] = useState(null);

  const load = useCallback(async () => {
    try {
      const detail = await payrollPaymentService.batch(batchId);
      setData(detail || null);
    } catch (error) {
      flash('error', error?.message || 'Unable to load the batch');
    } finally {
      setLoading(false);
    }
  }, [batchId, flash]);

  useEffect(() => {
    load();
  }, [load]);

  const reload = async () => {
    await load();
    setAuditRows(null); // the trail changed — drop the cached read
    await onChanged();
  };

  const openAudit = async () => {
    if (auditRows) return;
    try {
      const rows = await payrollPaymentService.batchAudit(batchId);
      setAuditRows(rows || []);
    } catch (error) {
      flash('error', error?.message || 'Unable to load the audit trail');
      setAuditRows([]);
    }
  };

  const run = async (action, message) => {
    try {
      await action();
      flash('success', message);
      await reload();
    } catch (error) {
      flash('error', error?.message || 'Unable to complete the action');
      await reload();
    }
  };

  const checkValidation = async () => {
    try {
      const report = await payrollPaymentService.validate(batchId);
      setValidation(report || null);
      setTab('excluded');
    } catch (error) {
      flash('error', error?.message || 'Unable to run the validation');
    }
  };

  const batch = data?.batch;
  const payments = data?.payments || [];
  const failed = payments.filter((row) => row.status === 'FAILED');
  const status = batch?.status || '';
  const closed = ['PAID', 'CANCELLED'].includes(status);

  // §18 — "everything should be searchable": one box filters whichever table
  // is open, matching the fields a person would actually type.
  const needle = search.trim().toLowerCase();
  const matches = (...fields) =>
    !needle || fields.some((field) => String(field || '').toLowerCase().includes(needle));

  const visiblePayments = payments.filter((row) =>
    matches(row.employeeName, row.employeeCode, row.paymentReference, row.bank?.bankName, row.bank?.ifsc),
  );
  const visibleFailed = failed.filter((row) =>
    matches(row.employeeName, row.employeeCode, row.paymentReference, row.failureReason, row.remarks),
  );
  const visibleFiles = (data.files || []).filter((file) =>
    matches(file.format, file.generatedByName, file.status),
  );
  const visibleExcluded = (data.excluded || []).filter((row) =>
    matches(row.employeeName, row.employeeCode, (row.messages || []).join(' ')),
  );

  // §20 — a queued file is still being built in the background; keep an eye
  // on it so the row turns READY without a manual refresh.
  const pendingFile = (data.files || []).some((file) => ['QUEUED', 'PROCESSING'].includes(file.status));

  useEffect(() => {
    if (!pendingFile) return undefined;
    const timer = setTimeout(load, 4000);
    return () => clearTimeout(timer);
  }, [pendingFile, data, load]);

  const handleGenerate = () =>
    run(async () => {
      const response = await payrollPaymentService.generateFile(batchId, format);
      const queued = response?.meta?.queued;
      if (queued) flash('success', 'Bank file queued — it will be ready shortly');
      else if (response?.data) await onDownload(String(response.data._id));
    }, 'Bank file generated');

  return (
    <Modal
      title={`Payment batch · ${batch?.batchNumber || '…'} · ${formatMonth(batch?.month || '')}`}
      onClose={onClose}
      wide
    >
      {loading ? (
        <div className="py-10 text-center text-crewly-dim">
          <Loader2 className="mx-auto animate-spin" size={18} /> Loading batch…
        </div>
      ) : !data ? (
        <p className="text-sm text-crewly-dim">Batch not found.</p>
      ) : (
        <div className="space-y-4">
          {/* §18 — batch summary */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg bg-white/5 p-3">
              <p className="text-[11px] uppercase text-crewly-dim">Employees</p>
              <p className="text-sm font-semibold">{formatNumber(batch.summary?.totalEmployees)}</p>
            </div>
            <div className="rounded-lg bg-white/5 p-3">
              <p className="text-[11px] uppercase text-crewly-dim">Total net salary</p>
              <p className="text-sm font-semibold">{formatMoney(batch.summary?.totalNetSalary)}</p>
            </div>
            <div className="rounded-lg bg-white/5 p-3">
              <p className="text-[11px] uppercase text-crewly-dim">Paid</p>
              <p className="text-sm font-semibold text-emerald-300">
                {formatNumber(batch.summary?.successfulTransactions)} ·{' '}
                {formatMoney(batch.summary?.totalPaid)}
              </p>
            </div>
            <div className="rounded-lg bg-white/5 p-3">
              <p className="text-[11px] uppercase text-crewly-dim">Failed / pending</p>
              <p className="text-sm font-semibold">
                <span className={batch.summary?.failedTransactions ? 'text-red-300' : ''}>
                  {formatNumber(batch.summary?.failedTransactions)}
                </span>
                {' / '}
                {formatNumber(batch.summary?.pendingTransactions)}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {statusBadge(status)}
            {batch.attempt > 1 ? (
              <span className="text-xs text-crewly-dim">
                retry of a previous batch · attempt {formatNumber(batch.attempt)}
              </span>
            ) : null}
            <span className="text-xs text-crewly-dim">
              · payment date {batch.paymentDate ? formatStamp(batch.paymentDate).split(',')[0] : '—'}
            </span>
          </div>

          {/* actions */}
          <div className="flex flex-wrap items-center gap-2 border-y border-white/5 py-3">
            <select
              className="input max-w-[130px]"
              value={format}
              onChange={(event) => setFormat(event.target.value)}
              disabled={busy || !canGenerate}
            >
              <option value="CSV">CSV</option>
              <option value="XLSX">XLSX</option>
            </select>
            <button
              className="btn-primary"
              disabled={busy || !canGenerate || closed}
              onClick={handleGenerate}
            >
              <FileSpreadsheet size={15} /> Generate bank file
            </button>
            <button
              className="btn-secondary"
              disabled={busy || !canGenerate}
              onClick={checkValidation}
            >
              <ShieldCheck size={15} /> Validate bank details
            </button>
            <button
              className="btn-secondary"
              disabled={busy || !canConfirm || closed || ['DRAFT', 'READY'].includes(status)}
              onClick={() =>
                run(
                  () => payrollPaymentService.markAllPaid(batchId),
                  'Payments confirmed — employees marked paid',
                )
              }
            >
              <CheckCircle2 size={15} /> Mark all paid
            </button>
            <button
              className="btn-secondary"
              disabled={busy || !canGenerate || Number(batch.summary?.failedTransactions || 0) === 0}
              onClick={() => run(() => payrollPaymentService.retry(batchId), 'Retry batch created')}
            >
              <RotateCcw size={15} /> Retry failed
            </button>
            {status === 'FAILED' ? (
              <button
                className="btn-secondary"
                disabled={busy || !canConfirm}
                onClick={() => run(() => payrollPaymentService.reopen(batchId), 'Batch reopened')}
              >
                <RefreshCcw size={15} /> Reopen
              </button>
            ) : null}
            {!closed ? (
              <button
                className="btn-secondary"
                disabled={busy || !canGenerate}
                onClick={() => setCancelReason(' ')}
              >
                <Ban size={15} /> Cancel batch
              </button>
            ) : null}
          </div>

          {['DRAFT', 'READY'].includes(status) ? (
            <p className="text-xs text-crewly-dim">
              Generate the bank file before confirming payment — Crewly records a payment only when
              there is a file to have been uploaded (§26).
            </p>
          ) : null}

          {/* tabs */}
          <div className="flex flex-wrap gap-1 border-b border-white/10">
            {TABS.map((entry) => (
              <button
                key={entry.key}
                className={`border-b-2 px-3 py-2 text-sm transition-colors ${
                  tab === entry.key
                    ? 'border-indigo-500 text-crewly-text'
                    : 'border-transparent text-crewly-dim hover:text-crewly-text'
                }`}
                onClick={() => {
                  setTab(entry.key);
                  if (entry.key === 'audit') openAudit();
                }}
              >
                {entry.label}
                {entry.key === 'failed' && failed.length ? (
                  <span className="ml-1 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-300">
                    {formatNumber(failed.length)}
                  </span>
                ) : null}
                {entry.key === 'excluded' && (data.excluded || []).length ? (
                  <span className="ml-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                    {formatNumber((data.excluded || []).length)}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          {/* §18 — one search box for whichever table is open */}
          <div className="flex items-center gap-2">
            <Search size={15} className="text-crewly-dim" />
            <input
              className="input max-w-xs"
              placeholder={
                tab === 'downloads'
                  ? 'Search format, generated by, status…'
                  : tab === 'audit'
                    ? 'Search action, actor, status…'
                    : 'Search employee, code, reference, bank…'
              }
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {needle ? (
              <span className="text-xs text-crewly-dim">
                {tab === 'employees'
                  ? `${visiblePayments.length}/${payments.length}`
                  : tab === 'failed'
                    ? `${visibleFailed.length}/${failed.length}`
                    : tab === 'downloads'
                      ? `${visibleFiles.length}/${(data.files || []).length}`
                      : ''}
              </span>
            ) : null}
          </div>

          {/* §9 — employee payment table */}
          {tab === 'employees' ? (
            <div className="max-h-[26rem] overflow-y-auto rounded-lg border border-white/5">
              <table className="w-full text-left text-sm">
                <thead className="bg-white/5 text-xs uppercase tracking-wide text-crewly-dim">
                  <tr>
                    <th className="px-3 py-2">Employee</th>
                    <th className="px-3 py-2">Bank</th>
                    <th className="px-3 py-2">Account</th>
                    <th className="px-3 py-2">IFSC</th>
                    <th className="px-3 py-2">Net salary</th>
                    <th className="px-3 py-2">Reference</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-crewly-dim">
                        No payments in this batch.
                      </td>
                    </tr>
                  ) : (
                    visiblePayments.map((row) => (
                      <tr key={row._id} className="border-t border-white/5">
                        <td className="px-3 py-2">
                          <p className="font-medium">{row.employeeName}</p>
                          <p className="text-xs text-crewly-dim">
                            {row.employeeCode}
                            {row.departmentName ? ` · ${row.departmentName}` : ''}
                          </p>
                        </td>
                        <td className="px-3 py-2 text-xs">{row.bank?.bankName || '—'}</td>
                        {/* §9 / §23 — masked, always. */}
                        <td className="px-3 py-2 font-mono text-xs">
                          {row.bank?.accountNumberMasked || '—'}
                        </td>
                        <td className="px-3 py-2 text-xs">{row.bank?.ifsc || '—'}</td>
                        <td className="px-3 py-2 font-semibold">{formatMoney(row.netSalary)}</td>
                        <td className="px-3 py-2 text-xs text-crewly-dim">{row.paymentReference}</td>
                        <td className="px-3 py-2">
                          {paymentBadge(row.status)}
                          {row.failureReason ? (
                            <p className="mt-1 text-[10px] uppercase text-red-300">
                              {FAILURE_REASONS.find((item) => item.key === row.failureReason)?.label ||
                                row.failureReason}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {canMark && !closed ? (
                            <div className="flex justify-end gap-2">
                              {row.status !== 'PAID' ? (
                                <button
                                  className="text-xs text-emerald-300 hover:underline"
                                  disabled={busy}
                                  onClick={() =>
                                    run(
                                      () =>
                                        payrollPaymentService.markEmployee(batchId, row.employeeId, {
                                          status: 'PAID',
                                        }),
                                      `${row.employeeName} marked paid`,
                                    )
                                  }
                                >
                                  Mark paid
                                </button>
                              ) : null}
                              {row.status !== 'FAILED' ? (
                                <button
                                  className="text-xs text-red-300 hover:underline"
                                  disabled={busy}
                                  onClick={() => {
                                    setFailurePrompt(row);
                                    setFailureReason('INVALID_ACCOUNT');
                                    setFailureRemarks('');
                                  }}
                                >
                                  Mark failed
                                </button>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-xs text-crewly-dim">
                              {row.remarks || '—'}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : null}

          {/* §14 — failed transactions */}
          {tab === 'failed' ? (
            failed.length === 0 ? (
              <p className="text-sm text-crewly-dim">No failed payments in this batch.</p>
            ) : (
              <div className="space-y-2">
                {visibleFailed.map((row) => (
                  <div
                    key={row._id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border-l-4 border-red-500 bg-red-500/5 p-3 text-sm"
                  >
                    <div>
                      <p className="font-medium">
                        {row.employeeName}{' '}
                        <span className="text-xs text-crewly-dim">({row.employeeCode})</span>
                      </p>
                      <p className="text-xs text-red-300">
                        {FAILURE_REASONS.find((item) => item.key === row.failureReason)?.label ||
                          row.failureReason}{' '}
                        · {formatMoney(row.netSalary)} · {row.paymentReference}
                      </p>
                      {row.remarks ? (
                        <p className="text-xs text-crewly-dim">{row.remarks}</p>
                      ) : null}
                    </div>
                    {canMark && !closed ? (
                      <button
                        className="btn-secondary"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () =>
                              payrollPaymentService.markEmployee(batchId, row.employeeId, {
                                status: 'PAID',
                              }),
                            `${row.employeeName} marked paid`,
                          )
                        }
                      >
                        <CheckCircle2 size={15} /> Mark paid
                      </button>
                    ) : null}
                  </div>
                ))}
                {canGenerate && Number(batch.summary?.failedTransactions || 0) > 0 ? (
                  <p className="text-xs text-crewly-dim">
                    Create a retry batch to pay only these employees — anyone already paid is never
                    sent twice (§15 / §16).
                  </p>
                ) : null}
              </div>
            )
          ) : null}

          {/* §7 — validation report */}
          {tab === 'excluded' ? (
            <div className="space-y-3">
              {validation ? (
                <p
                  className={`rounded-lg p-2 text-sm ${
                    validation.valid
                      ? 'bg-emerald-500/10 text-emerald-200'
                      : 'bg-amber-500/10 text-amber-200'
                  }`}
                >
                  {validation.valid
                    ? `All ${formatNumber(validation.checked)} payment(s) passed bank validation.`
                    : `${formatNumber(validation.errorRows.length)} of ${formatNumber(
                        validation.checked,
                      )} payment(s) failed validation. The file cannot be generated until they are fixed.`}
                </p>
              ) : (
                <p className="text-xs text-crewly-dim">
                  Run “Validate bank details” to re-check every employee in this batch.
                </p>
              )}

              {validation && !validation.valid ? (
                <div className="rounded-lg border border-white/5">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-white/5 text-xs uppercase tracking-wide text-crewly-dim">
                      <tr>
                        <th className="px-3 py-2">Employee</th>
                        <th className="px-3 py-2">Problem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validation.errorRows.map((row) => (
                        <tr key={String(row.employeeId)} className="border-t border-white/5">
                          <td className="px-3 py-2">
                            {row.employeeName || row.employeeCode || row.employeeId}
                          </td>
                          <td className="px-3 py-2 text-xs">{(row.messages || []).join(' · ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {(data.excluded || []).length ? (
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">
                    Excluded when the batch was created
                  </h3>
                  {visibleExcluded.map((row) => (
                    <div
                      key={String(row.employeeId)}
                      className="rounded-lg bg-white/5 p-3 text-sm"
                    >
                      <p className="font-medium">
                        {row.employeeName || row.employeeCode}{' '}
                        <span className="text-xs text-crewly-dim">({row.employeeCode})</span>
                      </p>
                      <p className="text-xs text-amber-300">{(row.messages || []).join(' · ')}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* §12 — download history */}
          {tab === 'downloads' ? (
            <div className="rounded-lg border border-white/5">
              <table className="w-full text-left text-sm">
                <thead className="bg-white/5 text-xs uppercase tracking-wide text-crewly-dim">
                  <tr>
                    <th className="px-3 py-2">Generated</th>
                    <th className="px-3 py-2">Format</th>
                    <th className="px-3 py-2">Rows</th>
                    <th className="px-3 py-2">By</th>
                    <th className="px-3 py-2">Downloads</th>
                    <th className="px-3 py-2 text-right">File</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.files || []).length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-3 py-8 text-center text-crewly-dim">
                        No file generated yet.
                      </td>
                    </tr>
                  ) : (
                    visibleFiles.map((file) => (
                      <tr key={file._id} className="border-t border-white/5">
                        <td className="px-3 py-2 text-xs">{formatStamp(file.generatedAt)}</td>
                        <td className="px-3 py-2">{file.format}</td>
                        <td className="px-3 py-2">{formatNumber(file.rowCount)}</td>
                        <td className="px-3 py-2 text-xs">{file.generatedByName || '—'}</td>
                        <td className="px-3 py-2">
                          {formatNumber(file.downloadCount)}
                          {file.lastDownloadedAt ? (
                            <span className="ml-1 text-xs text-crewly-dim">
                              · {formatStamp(file.lastDownloadedAt)}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {file.status === 'READY' ? (
                            <button
                              className="text-sm text-indigo-300 hover:underline"
                              disabled={busy}
                              onClick={() => onDownload(String(file._id))}
                            >
                              <Download size={14} className="inline" /> Download
                            </button>
                          ) : (
                            <span className="text-xs text-crewly-dim">
                              {file.status === 'FAILED' ? 'generation failed' : 'generating…'}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              <p className="p-3 text-xs text-crewly-dim">
                Files are never overwritten: every generation adds a new row, so the audit trail can
                show which file finance actually uploaded (§12).
              </p>
            </div>
          ) : null}

          {/* §18 / §22 — every recorded action on this batch */}
          {tab === 'audit' ? (
            <div className="rounded-lg border border-white/5">
              <table className="w-full text-left text-sm">
                <thead className="bg-white/5 text-xs uppercase tracking-wide text-crewly-dim">
                  <tr>
                    <th className="px-3 py-2">When</th>
                    <th className="px-3 py-2">Action</th>
                    <th className="px-3 py-2">By</th>
                    <th className="px-3 py-2">Status change</th>
                    <th className="px-3 py-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {auditRows === null ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-crewly-dim">
                        <Loader2 className="mx-auto animate-spin" size={18} /> Loading history…
                      </td>
                    </tr>
                  ) : (auditRows || []).filter((row) =>
                      matches(row.action, row.actorName, row.actorRole, row.from, row.to, row.reason),
                    ).length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-crewly-dim">
                        Nothing recorded for this batch yet.
                      </td>
                    </tr>
                  ) : (
                    (auditRows || [])
                      .filter((row) =>
                        matches(row.action, row.actorName, row.actorRole, row.from, row.to, row.reason),
                      )
                      .map((row, index) => (
                        <tr key={`${row.action}-${row.at}-${index}`} className="border-t border-white/5">
                          <td className="px-3 py-2 text-xs">{formatStamp(row.at)}</td>
                          <td className="px-3 py-2">
                            <span className="font-medium">{row.action}</span>
                            {row.resource ? (
                              <p className="text-[10px] uppercase text-crewly-dim">{row.resource}</p>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {row.actorName || '—'}
                            {row.actorRole ? (
                              <p className="text-[10px] uppercase text-crewly-dim">{row.actorRole}</p>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {row.from || row.to ? (
                              <>
                                {statusBadge(row.from)}
                                <span className="mx-1 text-crewly-dim">→</span>
                                {statusBadge(row.to)}
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs">{row.reason || '—'}</td>
                        </tr>
                      ))
                  )}
                </tbody>
              </table>
              <p className="p-3 text-xs text-crewly-dim">
                Written by the platform audit service on every action (§22) — company, actor,
                previous status and new status, with the batch, its payment rows and its files.
              </p>
            </div>
          ) : null}
        </div>
      )}

      {/* §14 — mark an employee failed, with a reason */}
      {failurePrompt ? (
        <Modal
          title={`Mark ${failurePrompt.employeeName} as failed?`}
          onClose={() => setFailurePrompt(null)}
        >
          <div className="space-y-3 text-sm">
            <p className="text-crewly-dim">
              {formatMoney(failurePrompt.netSalary)} was not credited. This employee stays unpaid and
              can be retried later without affecting the successful payments.
            </p>
            <select
              className="input w-full"
              value={failureReason}
              onChange={(event) => setFailureReason(event.target.value)}
            >
              {FAILURE_REASONS.map((reason) => (
                <option key={reason.key} value={reason.key}>
                  {reason.label}
                </option>
              ))}
            </select>
            <textarea
              className="input min-h-[70px] w-full"
              placeholder="Remarks (optional)"
              value={failureRemarks}
              onChange={(event) => setFailureRemarks(event.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setFailurePrompt(null)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={busy}
                onClick={async () => {
                  const row = failurePrompt;
                  setFailurePrompt(null);
                  await run(
                    () =>
                      payrollPaymentService.markEmployee(batchId, row.employeeId, {
                        status: 'FAILED',
                        failureReason,
                        remarks: failureRemarks,
                      }),
                    `${row.employeeName} marked failed`,
                  );
                }}
              >
                <XCircle size={15} /> Mark failed
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* §8 — cancel with a reason */}
      {cancelReason !== '' && cancelReason !== null ? null : null}
      {cancelReason ? (
        <Modal title={`Cancel batch ${batch?.batchNumber || ''}?`} onClose={() => setCancelReason('')}>
          <div className="space-y-3 text-sm">
            <p className="text-crewly-dim">
              Cancelling stops this batch. No file can be generated from it afterwards, and the
              payments stay unpaid.
            </p>
            <textarea
              className="input min-h-[70px] w-full"
              placeholder="Reason (optional)"
              value={cancelReason === ' ' ? '' : cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button className="btn-secondary" onClick={() => setCancelReason('')}>
                Keep batch
              </button>
              <button
                className="btn-primary"
                disabled={busy}
                onClick={async () => {
                  const reason = cancelReason === ' ' ? '' : cancelReason;
                  setCancelReason('');
                  await run(
                    () => payrollPaymentService.cancel(batchId, reason),
                    'Payment batch cancelled',
                  );
                }}
              >
                <Ban size={15} /> Cancel batch
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </Modal>
  );
};

export default SalaryPaymentPage;
