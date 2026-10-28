/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Ban,
  Banknote,
  CheckCircle2,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Loader2,
  RefreshCcw,
  RotateCcw,
  Search,
  ShieldCheck,
  Wallet,
  XCircle,
} from 'lucide-react';

import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import payrollPaymentService from '../../services/payrollPaymentService.js';
import { notify } from '../../utils/notify.js';
import { TableEmpty } from '../../components/common/EmptyState.jsx';
import {
  Avatar,
  CheckRow,
  Panel,
  Pipeline,
  Pill,
  Rail,
  StageBand,
  StageButton,
  StatCard,
  Td,
  Th,
} from '../../components/payroll/PayrollCockpit.jsx';

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

const statusTone = (status) => {
  const map = {
    PAID: 'text-st-secondary',
    PARTIALLY_PAID: 'text-st-primary',
    FAILED: 'text-st-error',
    CANCELLED: 'text-st-on-variant/70',
    PROCESSING: 'text-st-primary',
  };
  return `text-[10px] font-bold uppercase tracking-wide ${map[status] || 'text-st-on-variant'}`;
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
  const [accessDenied, setAccessDenied] = useState(false);

  const [kpis, setKpis] = useState({});
  const [batches, setBatches] = useState([]);
  const [detailId, setDetailId] = useState(null);
  const [prompt, setPrompt] = useState(null);
  // The newest batch's detail powers the roster and the file list. It is a
  // read of the same endpoint the batch drawer uses — no extra data source.
  const [newest, setNewest] = useState(null);

  /*
   * 35.1 — feedback is a toast now. The signature is unchanged so every call
   * site keeps working; only the destination moved (out of the page flow and
   * into the app-wide stack).
   */
  /*
   * 35.1 — feedback is a toast now. The signature is unchanged so every call
   * site keeps working; only the destination moved (out of the page flow and
   * into the app-wide stack).
   */
  const flash = useCallback((type, text) => {
    const body = typeof text === 'string' && text ? text : '';

    if (!body) return;

    const kind = String(type).toLowerCase();

    if (kind === 'error' || kind === 'danger' || kind === 'failed') notify.error(body);
    else if (kind === 'warning' || kind === 'warn') notify.warning(body);
    else if (kind === 'info') notify.info(body);
    else notify.success(body);
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

  useEffect(() => {
    const id = batches[0]?._id;
    if (!id) {
      setNewest(null);
      return;
    }
    let active = true;
    payrollPaymentService
      .batch(id)
      .then((response) => {
        if (active) setNewest(response?.data ?? response ?? null);
      })
      .catch(() => {
        if (active) setNewest(null);
      });
    return () => {
      active = false;
    };
  }, [batches]);

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
      <div className="st-surface min-h-screen space-y-4">
        <StageBand eyebrow="Cycle step 4 of 4" title="Direct salary disbursement" />
        <Panel title="Payment access required">
          <div className="p-4 text-sm text-st-on-variant">
            You don&apos;t have permission to view salary payments. Contact your Company Admin or
            Finance Manager.
          </div>
        </Panel>
      </div>
    );
  }

  const monthBatches = batches;
  const latestBatch = monthBatches[0] || null;
  const latestFile = newest?.files?.[0] || null;

  return (
    <div className="space-y-3">
      <StageBand
        eyebrow="Cycle step 4 of 4 · Monthly payroll pipeline"
        title="Direct salary disbursement"
        description="Prepare the bank transfer file for an approved payroll. Crewly builds and validates the batch — your finance team uploads the file to the company bank, and the bank pays. No money moves from this screen."
        pills={[
          latestBatch
            ? {
                label: String(latestBatch.status || 'DRAFT').replace(/_/g, ' ').toLowerCase(),
                tone:
                  latestBatch.status === 'PAID'
                    ? 'good'
                    : latestBatch.status === 'FAILED'
                      ? 'bad'
                      : 'accent',
                title: 'Status of the newest batch for this month',
              }
            : { label: 'no batch yet', tone: 'default' },
          { label: formatMonth(month), tone: 'default' },
          ...(latestBatch?.paymentDate
            ? [{ label: `dated ${formatStamp(latestBatch.paymentDate).split(',')[0]}`, tone: 'warn' }]
            : []),
        ]}
        aside={
          <div className="min-w-[11rem] rounded-xl border border-st-high bg-st-low/60 px-3 py-2">
            <p className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
              Latest disbursement batch
            </p>
            <p className="mt-0.5 font-mono text-[12px] font-bold text-st-on">
              {latestBatch?.batchNumber || '—'}
            </p>
            <p className="text-[10px] text-st-on-variant">
              {latestBatch ? `Cycle: ${formatMonth(latestBatch.month)}` : `Cycle: ${formatMonth(month)}`}
            </p>
            <label className="mt-1.5 flex items-center gap-1 text-[10px] font-semibold text-st-on-variant">
              month
              <input
                type="month"
                value={month}
                onChange={(event) => setMonth(event.target.value)}
                className="w-full rounded-md border border-st-outline-variant/70 bg-st-lowest px-1.5 py-1 text-[10px] font-semibold text-st-on"
              />
            </label>
          </div>
        }
        actions={
          <>
            <StageButton
              variant="primary"
              icon={Banknote}
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
              Create payment batch
            </StageButton>
            <StageButton
              icon={Download}
              disabled={busy || !latestFile}
              title={
                latestFile
                  ? `Download ${latestFile.format} · ${formatNumber(latestFile.rowCount)} row(s)`
                  : 'Generate the bank file inside the batch first'
              }
              onClick={() => latestFile && handleDownload(latestFile._id)}
            >
              Download bank file{latestFile ? ` (${latestFile.format})` : ''}
            </StageButton>
            <StageButton
              icon={ShieldCheck}
              disabled={!latestBatch}
              onClick={() => latestBatch && setDetailId(latestBatch._id)}
            >
              Batch audit &amp; roster
            </StageButton>
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-st-outline-variant px-2 py-1.5 text-[10px] font-semibold text-st-on-variant">
              <Wallet aria-hidden="true" size={12} /> File handoff — no bank gateway connected
            </span>
          </>
        }
      />

      <Pipeline
        steps={[
          { key: 'inputs', index: '01', label: 'Monthly inputs', hint: 'Reimbursements, incentives & LOP', state: 'done' },
          { key: 'run', index: '02', label: 'Run payroll', hint: 'Tax, PF, ESI & gross', state: 'done' },
          { key: 'review', index: '03', label: 'Review & approval', hint: 'Sign-off by finance', state: latestBatch ? 'done' : 'active' },
          { key: 'payment', index: '04', label: 'Salary payment', hint: 'Bank file & release', state: latestBatch ? 'active' : 'locked' },
        ]}
        footnote="Stage 04 is reachable only once a batch exists for the month — the export's step 4 is what this page performs."
      />

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          icon={Wallet}
          label="Total disbursable"
          value={formatMoney(kpis.totalPayroll)}
          hint={`${formatMonth(month)} across ${formatNumber(kpis.batches)} batch(es)`}
        />
        <StatCard
          icon={CheckCircle2}
          label="Paid & transferred"
          value={formatMoney(kpis.totalAmountPaid)}
          tone="good"
          hint={`${formatNumber(kpis.paidEmployees)} confirmed transaction(s)`}
        />
        <StatCard
          icon={Wallet}
          label="Pending bank exec"
          value={formatNumber(kpis.pendingPayments)}
          tone={kpis.pendingPayments > 0 ? 'warn' : 'default'}
          hint="Waiting for finance to confirm"
        />
        <StatCard
          icon={XCircle}
          label="Bounced transfers"
          value={formatNumber(kpis.failedPayments)}
          tone={kpis.failedPayments > 0 ? 'bad' : 'good'}
          hint="Rejected or returned by the bank"
        />
        <StatCard
          icon={RefreshCcw}
          label="Retry required"
          value={`${formatNumber(kpis.retryRequired)} batch(es)`}
          tone={kpis.retryRequired > 0 ? 'warn' : 'default'}
          hint="Batches still holding a failure"
        />
        <StatCard
          icon={FileSpreadsheet}
          label="Bank files generated"
          value={formatNumber(newest?.files?.length || 0)}
          hint={latestFile ? `${latestFile.format} · ${formatNumber(latestFile.rowCount)} rows` : 'none for this batch'}
        />
      </div>

      <div className="flex flex-col gap-3 xl:flex-row">
        <div className="min-w-0 flex-1 space-y-3">
          <Panel
            title="Payment batches & transfer schedules"
            subtitle="Staged batch files and past disbursement reconciliation"
            right={
              <span className="text-[10px] text-st-on-variant">
                {monthBatches.length} batch(es) · {formatMonth(month)}
              </span>
            }
          >
            <div className="overflow-x-auto border-t border-st-high">
              <table className="w-full text-left">
                <thead className="bg-st-low/70">
                  <tr>
                    <Th>Batch ID &amp; month</Th>
                    <Th>Scope</Th>
                    <Th>Net disbursable</Th>
                    <Th>Mode</Th>
                    <Th>Disbursement status</Th>
                    <Th>Scheduled date</Th>
                    <Th className="text-right">Action</Th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-10 text-center text-st-on-variant">
                        <Loader2 className="mx-auto animate-spin" size={16} />
                      </td>
                    </tr>
                  ) : monthBatches.length === 0 ? (
                    <TableEmpty
                      colSpan={7}
                      illustration="wallet"
                      title={`No payment batch for ${formatMonth(month)} yet`}
                      description="Approve the month in Review & approval first, then create a batch here. Each batch keeps its own bank-file status and totals."
                      action={
                        <Link className="btn-ghost px-4 py-2 text-sm" to="/app/payroll/review">
                          Go to Review &amp; approval
                        </Link>
                      }
                    />
                  ) : (
                    monthBatches.map((batch) => (
                      <tr key={batch._id} className="border-t border-st-high/70 hover:bg-st-low/50">
                        <Td>
                          <p className="font-mono text-[11px] font-bold text-st-on">{batch.batchNumber}</p>
                          <p className="text-[10px] text-st-on-variant">
                            {formatMonth(batch.month)}
                            {batch.attempt > 1 ? ` · retry #${batch.attempt}` : ''}
                          </p>
                        </Td>
                        <Td>
                          <span className="font-semibold tabular-nums">
                            {formatNumber(batch.summary?.totalEmployees)}
                          </span>
                          <span className="block text-[10px] text-st-on-variant">
                            {formatNumber(batch.summary?.totalTransactions)} transaction(s)
                          </span>
                        </Td>
                        <Td className="font-semibold tabular-nums">
                          {formatMoney(batch.summary?.totalNetSalary)}
                        </Td>
                        <Td>
                          <span className="inline-flex items-center gap-1 rounded-md bg-st-low px-1.5 py-0.5 text-[10px] font-semibold uppercase text-st-on-variant">
                            <FileSpreadsheet aria-hidden="true" size={10} /> bank file
                          </span>
                        </Td>
                        <Td>
                          <span className={statusTone(batch.status)}>
                            {String(batch.status || 'DRAFT').replace(/_/g, ' ').toLowerCase()}
                          </span>
                          <span className="block text-[10px] text-st-on-variant">
                            {formatNumber(batch.summary?.successfulTransactions)} paid ·{' '}
                            {formatNumber(batch.summary?.failedTransactions)} failed
                          </span>
                        </Td>
                        <Td className="tabular-nums text-[11px] text-st-on-variant">
                          {batch.paymentDate ? formatStamp(batch.paymentDate).split(',')[0] : '—'}
                        </Td>
                        <Td className="text-right">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-semibold text-st-primary hover:bg-st-low"
                            onClick={() => setDetailId(batch._id)}
                          >
                            Open batch
                            <ChevronRight aria-hidden="true" size={11} />
                          </button>
                        </Td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel
            title="Disbursement recipient roster"
            subtitle={
              newest?.batch
                ? `Batch ${newest.batch.batchNumber} · masked account bindings`
                : 'Recipients appear once a batch exists'
            }
            right={
              newest?.payments?.length ? (
                <span className="text-[10px] text-st-on-variant">
                  showing {Math.min(4, newest.payments.length)} of {formatNumber(newest.payments.length)}
                </span>
              ) : null
            }
          >
            <div className="grid gap-2 border-t border-st-high px-3 py-2.5 sm:grid-cols-2">
              {newest?.payments?.length ? (
                newest.payments.slice(0, 4).map((payment) => (
                  <div
                    key={payment._id}
                    className="flex items-start gap-2 rounded-xl border border-st-high bg-st-low/40 px-2.5 py-2"
                  >
                    <Avatar name={payment.employeeName} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-semibold text-st-on">
                        {payment.employeeName}
                      </p>
                      <p className="truncate text-[9px] text-st-on-variant">
                        {payment.bank?.bankName || 'bank not recorded'}
                        {payment.bank?.accountNumberLast4
                          ? ` ••••${payment.bank.accountNumberLast4}`
                          : payment.bank?.accountNumberMasked
                            ? ` ${payment.bank.accountNumberMasked}`
                            : ''}
                        {payment.bank?.ifsc ? ` (IFSC: ${payment.bank.ifsc})` : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[11px] font-bold tabular-nums text-st-on">
                        {formatMoney(payment.amount)}
                      </p>
                      <p className="text-[9px] font-semibold text-st-secondary">
                        {String(payment.status || '').replace(/_/g, ' ').toLowerCase()}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-[10px] leading-snug text-st-on-variant sm:col-span-2">
                  No recipient list yet. A batch snapshots the approved payroll — every employee
                  whose bank details validated appears here, with the account masked.
                </p>
              )}
            </div>
          </Panel>
        </div>

        <Rail>
          <Panel
            title="Bank connectivity"
            subtitle="How the file reaches the bank"
            right={<Pill tone="warn">file handoff</Pill>}
          >
            <div className="space-y-1 px-4 pb-3">
              <CheckRow ok={false} label="Host-to-host gateway" value="not connected" />
              <CheckRow ok={false} label="API push / 2-FA authorisation" value="not available" />
              <CheckRow ok={Boolean(latestFile)} label="Bank file generated" value={latestFile ? latestFile.format : '—'} />
              <CheckRow
                ok={Boolean(latestFile?.downloadCount)}
                label="Downloaded for upload"
                value={latestFile ? `${formatNumber(latestFile.downloadCount)} time(s)` : '—'}
              />
              <p className="pt-1 text-[9px] leading-snug text-st-on-variant">
                Crewly does not hold bank credentials and does not transmit payments. Your finance
                team downloads the batch file and uploads it to the corporate banking portal — that
                is the only step this product cannot see.
              </p>
            </div>
          </Panel>

          <Panel title="What is recorded" subtitle="Every step of a batch, not just the total">
            <div className="space-y-1 px-4 pb-3">
              <CheckRow
                ok={Boolean(newest?.files?.length)}
                label="File generations are in the batch's audit trail"
                value={formatNumber(newest?.files?.length || 0)}
              />
              <CheckRow
                ok
                label="Account numbers masked outside the file"
                value="last 4 only"
              />
              <CheckRow
                ok={Number(kpis.failedPayments) === 0}
                label="Rejected transactions recorded per employee"
                value={formatNumber(kpis.failedPayments)}
              />
              <p className="pt-1 text-[9px] leading-snug text-st-on-variant">
                The export claims envelope encryption, a dual-admin quorum and NPCI certification.
                None of those are configured here, so none of them are printed as badges. What is
                real: the audit trail, the per-employee outcomes, and the masked roster above.
              </p>
            </div>
          </Panel>

          <Panel title="Alternate export" subtitle="Hand the file over the way your bank accepts">
            <div className="space-y-1.5 px-4 pb-3">
              {newest?.files?.length ? (
                newest.files.slice(0, 3).map((file) => (
                  <button
                    key={file._id}
                    type="button"
                    disabled={busy}
                    onClick={() => handleDownload(file._id)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-st-outline-variant/60 px-2.5 py-1.5 text-[10px] font-semibold text-st-on hover:bg-st-low disabled:opacity-50"
                  >
                    <span className="inline-flex items-center gap-1">
                      <Download aria-hidden="true" size={11} /> {file.format} ·{' '}
                      {formatNumber(file.rowCount)} row(s)
                    </span>
                    <span className="text-st-on-variant">{formatStamp(file.generatedAt).split(',')[0]}</span>
                  </button>
                ))
              ) : (
                <p className="text-[10px] leading-snug text-st-on-variant">
                  No file yet. Generate one inside the batch — Crewly writes CSV or XLSX, the two
                  formats corporate portals accept.
                </p>
              )}
              <p className="pt-1 text-[9px] leading-snug text-st-on-variant">
                Bank-specific templates (HDFC CMS, ICICI bulk) are not shipped as separate exports;
                the generated file carries the columns both portals read.
              </p>
            </div>
          </Panel>
        </Rail>
      </div>

      <p className="px-1 text-[10px] text-st-on-variant">
        Every generation, download, confirmation and failure is written to the audit log. Account
        numbers are masked everywhere except inside the generated file.
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
            <div className="rounded-lg bg-crewly-inset p-3">
              <p className="text-[11px] uppercase text-crewly-dim">Employees</p>
              <p className="text-sm font-semibold">{formatNumber(batch.summary?.totalEmployees)}</p>
            </div>
            <div className="rounded-lg bg-crewly-inset p-3">
              <p className="text-[11px] uppercase text-crewly-dim">Total net salary</p>
              <p className="text-sm font-semibold">{formatMoney(batch.summary?.totalNetSalary)}</p>
            </div>
            <div className="rounded-lg bg-crewly-inset p-3">
              <p className="text-[11px] uppercase text-crewly-dim">Paid</p>
              <p className="text-sm font-semibold text-emerald-300">
                {formatNumber(batch.summary?.successfulTransactions)} ·{' '}
                {formatMoney(batch.summary?.totalPaid)}
              </p>
            </div>
            <div className="rounded-lg bg-crewly-inset p-3">
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
          <div className="flex flex-wrap items-center gap-2 border-y border-crewly-hairline py-3">
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
          <div className="flex flex-wrap gap-1 border-b border-crewly-hairline-strong">
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
            <div className="max-h-[26rem] overflow-y-auto rounded-lg border border-crewly-hairline">
              <table className="w-full text-left text-sm">
                <thead className="bg-crewly-inset text-xs uppercase tracking-wide text-crewly-dim">
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
                    <TableEmpty
                      colSpan={8}
                      illustration="wallet"
                      title="No payments in this batch"
                      description="Add employees to this batch and their net pay, bank details and transfer status are listed here before you generate the file."
                    />
                  ) : (
                    visiblePayments.map((row) => (
                      <tr key={row._id} className="border-t border-crewly-hairline">
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
                <div className="rounded-lg border border-crewly-hairline">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-crewly-inset text-xs uppercase tracking-wide text-crewly-dim">
                      <tr>
                        <th className="px-3 py-2">Employee</th>
                        <th className="px-3 py-2">Problem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validation.errorRows.map((row) => (
                        <tr key={String(row.employeeId)} className="border-t border-crewly-hairline">
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
                      className="rounded-lg bg-crewly-inset p-3 text-sm"
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
            <div className="rounded-lg border border-crewly-hairline">
              <table className="w-full text-left text-sm">
                <thead className="bg-crewly-inset text-xs uppercase tracking-wide text-crewly-dim">
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
                    <TableEmpty
                      colSpan={6}
                      illustration="documents"
                      title="No file generated yet"
                      description="Build the bank or payment file for this batch and it appears here with its format, who generated it and a download link."
                    />
                  ) : (
                    visibleFiles.map((file) => (
                      <tr key={file._id} className="border-t border-crewly-hairline">
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
            <div className="rounded-lg border border-crewly-hairline">
              <table className="w-full text-left text-sm">
                <thead className="bg-crewly-inset text-xs uppercase tracking-wide text-crewly-dim">
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
                    <TableEmpty
                      colSpan={5}
                      illustration="tasks"
                      title="Nothing recorded for this batch yet"
                      description="Approvals, file generation and status changes append here with their actor, time and reason."
                    />
                  ) : (
                    (auditRows || [])
                      .filter((row) =>
                        matches(row.action, row.actorName, row.actorRole, row.from, row.to, row.reason),
                      )
                      .map((row, index) => (
                        <tr key={`${row.action}-${row.at}-${index}`} className="border-t border-crewly-hairline">
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
