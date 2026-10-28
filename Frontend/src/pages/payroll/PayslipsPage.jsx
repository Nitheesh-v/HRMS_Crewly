/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Building2,
  Download,
  FileText,
  Loader2,
  Mail,
  RefreshCcw,
  ScrollText,
  Search,
  Send,
  Wallet,
  XCircle,
} from 'lucide-react';

import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import PayslipDocument, { downloadPayslipFile } from './PayslipDocument.jsx';
import payslipService, { saveBlob } from '../../services/payslipService.js';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';
import {
  Avatar,
  Panel,
  Pill,
  StageBand,
  StageButton,
  StatCard,
} from '../../components/payroll/PayrollCockpit.jsx';

// ───────────────────────────────────────────────────────────────────────────
// Phase 29.9 — Payroll → Payslips (§27)
//
//   1. Payslip dashboard      — counters for the month
//   2. Generate payslips      — from the PAID payment batch (§17)
//   3. Payslip list           — filterable by month / year / FY / search (§15)
//   4. Employee payslip preview (§16) + download + print
//   5. Bulk download          — department ZIP or company ZIP (§18)
//
// A payslip is generated only after the salary is PAID (§1) and is cut from
// the frozen payroll snapshot — nothing here recalculates salary (§5).
// ───────────────────────────────────────────────────────────────────────────

const currentMonth = () => new Date().toISOString().slice(0, 7);

const formatMoney = (value) => `Rs ${Number(value || 0).toLocaleString('en-IN')}`;
const formatNumber = (value) => Number(value || 0).toLocaleString('en-IN');

const formatMonthInput = (month) => {
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

const financialYearOf = (month, fyStartMonth = 4) => {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return '';
  const [year, part] = String(month).split('-').map(Number);
  const start = part >= fyStartMonth ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

const PayslipsPage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();

  // §4 — permissions, never role names.
  const canRead = hasAnyPermission(['PAYSLIP_READ', 'PAYSLIP_GENERATE', 'PAYSLIP_RELEASE', 'PAYSLIP_RERELEASE']);
  const canGenerate = hasAnyPermission(['PAYSLIP_GENERATE']);
  const canRelease = hasAnyPermission(['PAYSLIP_RELEASE']);
  const canRegenerate = hasAnyPermission(['PAYSLIP_RERELEASE']);

  const [month, setMonth] = useState(currentMonth());
  const [search, setSearch] = useState('');
  const [financialYear, setFinancialYear] = useState('');
  const [year, setYear] = useState('');

  const [dashboard, setDashboard] = useState({ summary: {}, payslips: [] });
  const [bulkFiles, setBulkFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

  const [viewing, setViewing] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [zipScope, setZipScope] = useState('COMPANY');

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
      const [data, files] = await Promise.all([
        payslipService.dashboard(month),
        payslipService.bulkDownloads(month),
      ]);
      setDashboard(data || { summary: {}, payslips: [] });
      setBulkFiles(files || []);
      setAccessDenied(false);
    } catch (error) {
      if (error?.status === 403) setAccessDenied(true);
      else flash('error', error?.message || 'Unable to load payslips');
    } finally {
      setLoading(false);
    }
  }, [month, flash]);

  useEffect(() => {
    if (!permsLoading && canRead) load();
    if (!permsLoading && !canRead) setLoading(false);
  }, [permsLoading, canRead, load]);

  const run = async (action, message) => {
    setBusy(true);
    try {
      const result = await action();
      flash('success', typeof message === 'function' ? message(result) : message);
      await load();
      return result;
    } catch (error) {
      flash('error', error?.message || 'Unable to complete the action');
      await load();
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleGenerate = () =>
    run(
      () => payslipService.generate(month),
      (result) =>
        result?.queued
          ? 'Payslip generation queued — progress will appear below'
          : `Payslips generated: ${formatNumber(result?.created)} created, ${formatNumber(result?.updated)} refreshed${
              result?.failed ? `, ${formatNumber(result.failed)} failed` : ''
            }`,
    );

  const handleEmailMonth = () =>
    run(
      () => payslipService.emailMonth(month),
      (result) =>
        result?.queued
          ? 'Payslip emails queued'
          : `Payslip emails: ${formatNumber(result?.sent)} sent${
              result?.failed ? `, ${formatNumber(result.failed)} failed` : ''
            }`,
    );

  const handleBulkDownload = () =>
    run(
      () => payslipService.requestBulkDownload({ month, scope: zipScope }),
      (result) => (result?.queued ? 'Archive queued — it will be ready shortly' : 'Archive ready'),
    );

  const downloadZip = async (file) => {
    setBusy(true);
    try {
      const blob = await payslipService.downloadBulk(file._id);
      saveBlob(blob, file.filename || `payslips-${month}.zip`);
      await load();
    } catch (error) {
      flash('error', error?.message || 'Unable to download the archive');
    } finally {
      setBusy(false);
    }
  };

  const openPayslip = async (row) => {
    try {
      const detail = await payslipService.detail(row._id);
      setViewing(detail);
    } catch (error) {
      flash('error', error?.message || 'Unable to open this payslip');
    }
  };

  const downloadOne = async (row) => {
    setDownloadingId(row._id);
    try {
      await downloadPayslipFile({
        service: payslipService,
        payslipId: row._id,
        filename: `payslip-${row.month}-${row.employeeCode || row._id}.pdf`,
      });
      await load();
    } catch (error) {
      flash('error', error?.message || 'Unable to download this payslip');
    } finally {
      setDownloadingId(null);
    }
  };

  // Memoised so the three filters below do not re-run on every render.
  const rows = useMemo(() => dashboard.payslips || [], [dashboard]);
  const summary = dashboard.summary || {};

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (financialYear && financialYearOf(row.month) !== financialYear) return false;
      if (year && String(row.month || '').slice(0, 4) !== year) return false;
      if (!needle) return true;
      return [row.employeeName, row.employeeCode, row.payslipNumber, row.departmentName, row.monthLabel]
        .map((value) => String(value || '').toLowerCase())
        .join(' ')
        .includes(needle);
    });
  }, [rows, search, financialYear, year]);

  const financialYears = useMemo(
    () => [...new Set(rows.map((row) => financialYearOf(row.month)).filter(Boolean))].sort().reverse(),
    [rows],
  );
  const years = useMemo(
    () => [...new Set(rows.map((row) => String(row.month || '').slice(0, 4)).filter(Boolean))].sort().reverse(),
    [rows],
  );

  if ((!permsLoading && !canRead) || accessDenied) {
    return (
      <div className="space-y-3">
        <StageBand
          eyebrow="Payroll · Payslips"
          title="Payslips"
          description="Official salary documents for the payroll month."
        />
        <Panel title="Payslip access required">
          <p className="px-4 pb-4 text-[11px] leading-relaxed text-st-on-variant">
            This page is limited to the payslip permissions. Ask your Company Admin or Payroll Admin
            for access.
          </p>
        </Panel>
      </div>
    );
  }

  const pendingArchive = bulkFiles.find((file) => ['QUEUED', 'PROCESSING'].includes(file.status));
  const readyArchives = bulkFiles.filter((file) => file.status === 'READY');
  const newestArchive = readyArchives[0] || null;
  const generated = Number(summary.generated || 0);
  const total = Number(summary.totalPayslips || 0);

  const toneFor = (status) =>
    status === 'GENERATED'
      ? 'good'
      : status === 'EMAILED'
        ? 'accent'
        : status === 'FAILED'
          ? 'bad'
          : status === 'DOWNLOADED'
            ? 'default'
            : 'warn';

  return (
    <div className="space-y-3">
      <StageBand
        eyebrow="Payroll · Payslips"
        title="Payslips"
        description={
          rows.length
            ? `${formatMonthInput(month)} · ${generated} of ${total} payslip(s) generated from the frozen payroll snapshot. A payslip exists only once the salary is paid, and nothing here recalculates it.`
            : `${formatMonthInput(month)} · a payslip is cut from the frozen payroll snapshot once the salary is paid.`
        }
        pills={[
          { label: formatMonthInput(month), tone: 'default' },
          ...(total ? [{ label: `${formatNumber(generated)}/${formatNumber(total)} generated`, tone: generated === total ? 'good' : 'warn' }] : []),
          ...(Number(summary.failed) ? [{ label: `${formatNumber(summary.failed)} failed`, tone: 'bad' }] : []),
        ]}
        aside={
          <div className="text-right">
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
              Net on these payslips
            </p>
            <p className="text-lg font-bold leading-tight tabular-nums text-st-on">
              {formatMoney(summary.totalNetSalary)}
            </p>
            <p className="text-[10px] text-st-on-variant">{formatNumber(total)} document(s)</p>
          </div>
        }
        actions={
          <>
            <input
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              className="rounded-lg border border-st-outline-variant/70 bg-st-lowest px-2 py-1.5 text-[11px] font-semibold text-st-on"
              aria-label="Payroll month"
            />
            <StageButton
              variant="primary"
              icon={FileText}
              disabled={busy || !canGenerate}
              onClick={() =>
                setPrompt({
                  title: `Generate payslips for ${formatMonthInput(month)}?`,
                  body:
                    'Crewly takes every employee whose salary was confirmed PAID in the payment batch, freezes their payroll snapshot, renders the PDF and notifies them. Employees whose payment failed are skipped until they are paid.',
                  actionLabel: 'Generate payslips',
                  onConfirm: handleGenerate,
                })
              }
            >
              Generate payslips
            </StageButton>
            <StageButton icon={Mail} disabled={busy || !canRelease} onClick={handleEmailMonth}>
              Email month
            </StageButton>
            <StageButton
              icon={Archive}
              disabled={busy || !canRead}
              onClick={handleBulkDownload}
              title="Build a ZIP of this month's payslips for the scope chosen below"
            >
              Build ZIP
            </StageButton>
            <StageButton
              icon={ScrollText}
              disabled={busy || rows.length === 0}
              onClick={async () => {
                setBusy(true);
                try {
                  const blob = await payslipService.register(month);
                  saveBlob(blob, `payroll-register-${month}.csv`);
                } catch (error) {
                  flash('error', error?.message || 'Unable to download the register');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Register
            </StageButton>
          </>
        }
      />

      {pendingArchive ? (
        <p className="flex items-center gap-2 rounded-xl bg-st-lowest px-3 py-2 text-[11px] text-st-on-variant shadow-sm">
          <Loader2 aria-hidden="true" className="animate-spin" size={13} /> An archive is being
          prepared — this page refreshes itself.
        </p>
      ) : null}

      {/* ── the five counters ─────────────────────────────────────────── */}
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          icon={FileText}
          label="Payslips"
          value={formatNumber(total)}
          hint={`${formatNumber(summary.generated || 0)} generated`}
        />
        <StatCard
          icon={Mail}
          label="Emailed"
          value={formatNumber(summary.emailed)}
          hint={summary.emailed ? 'sent from the payslip inbox' : 'nobody emailed yet'}
        />
        <StatCard
          icon={Download}
          label="Downloaded by staff"
          value={formatNumber(summary.downloaded)}
          hint="counted when the PDF is fetched"
        />
        <StatCard
          icon={XCircle}
          label="Delivery failures"
          value={formatNumber(summary.failed)}
          hint={summary.failed ? 'retry from the row below' : 'none recorded'}
          tone={Number(summary.failed) ? 'bad' : 'default'}
        />
        <StatCard
          icon={Wallet}
          label="Net on payslips"
          value={formatMoney(summary.totalNetSalary)}
          hint="sum of the frozen snapshots"
        />
      </div>

      {/* ── one list, one archive strip ───────────────────────────────── */}
      <Panel
        title={`Payslips · ${formatMonthInput(month)}`}
        subtitle={`${formatNumber(visible.length)} of ${formatNumber(rows.length)} shown. Click a name to open the payslip.`}
        right={
          <div className="flex flex-wrap items-center gap-1.5">
            {financialYears.length > 1 ? (
              <select
                className="rounded-lg border border-st-outline-variant/70 bg-st-lowest px-2 py-1 text-[10px] font-semibold text-st-on"
                value={financialYear}
                onChange={(event) => setFinancialYear(event.target.value)}
                aria-label="Financial year"
              >
                <option value="">All FY</option>
                {financialYears.map((fy) => (
                  <option key={fy} value={fy}>
                    FY {fy}
                  </option>
                ))}
              </select>
            ) : null}
            {years.length > 1 ? (
              <select
                className="rounded-lg border border-st-outline-variant/70 bg-st-lowest px-2 py-1 text-[10px] font-semibold text-st-on"
                value={year}
                onChange={(event) => setYear(event.target.value)}
                aria-label="Year"
              >
                <option value="">All years</option>
                {years.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        }
        bodyClassName="border-t border-st-high"
      >
        <div className="flex items-center gap-2 border-b border-st-high px-3 py-2">
          <Search aria-hidden="true" size={13} className="text-st-on-variant" />
          <input
            className="w-full bg-transparent text-[11px] text-st-on outline-none placeholder:text-st-on-variant/70"
            placeholder="Search an employee, code or payslip number…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        {loading ? (
          <p className="flex items-center gap-2 px-4 py-8 text-[11px] text-st-on-variant">
            <Loader2 aria-hidden="true" className="animate-spin" size={14} /> Reading payslips…
          </p>
        ) : visible.length === 0 ? (
          <div className="px-4 py-6">
            <EmptyState
              illustration={rows.length === 0 ? 'payslip' : 'search'}
              title={
                rows.length === 0
                  ? `No payslips for ${formatMonthInput(month)} yet`
                  : 'No payslip matches these filters'
              }
              description={
                rows.length === 0
                  ? 'Payslips are generated once the salary for the month has been paid. Pay the month, then generate them here.'
                  : 'Nothing matches this search. Clear it to see the whole month.'
              }
              size="sm"
            />
          </div>
        ) : (
          <ul className="divide-y divide-st-high">
            {visible.map((row) => (
              <li
                key={row._id}
                className="flex flex-wrap items-center gap-2 px-3 py-2 hover:bg-st-selected/20"
              >
                <Avatar name={row.employeeName || row.employeeCode} />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => openPayslip(row)}
                >
                  <span className="block text-[12px] font-semibold text-st-on">
                    {row.employeeName || row.employeeCode}
                  </span>
                  <span className="block text-[10px] text-st-on-variant">
                    {row.employeeCode}
                    {row.departmentName ? ` · ${row.departmentName}` : ''} ·{' '}
                    {row.payslipNumber || 'no number'}
                  </span>
                </button>
                <div className="text-right">
                  <p className="text-[12px] font-semibold tabular-nums text-st-on">
                    {formatMoney(row.netSalary)}
                  </p>
                  <p className="text-[10px] text-st-on-variant">
                    gross {formatMoney(row.grossSalary)} · paid{' '}
                    {formatStamp(row.paymentDate).split(',')[0]}
                  </p>
                </div>
                <Pill tone={toneFor(row.status)}>{String(row.status || 'PENDING').toLowerCase()}</Pill>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="rounded-lg border border-st-outline-variant/60 px-2 py-1 text-[10px] font-semibold text-st-on hover:bg-st-low disabled:opacity-50"
                    disabled={downloadingId === row._id || busy}
                    onClick={() => downloadOne(row)}
                    title="Download this payslip as a PDF"
                  >
                    <Download aria-hidden="true" size={11} className="inline" /> PDF
                  </button>
                  {canRelease ? (
                    <button
                      type="button"
                      className="rounded-lg px-1.5 py-1 text-[10px] font-semibold text-st-on-variant hover:bg-st-low disabled:opacity-50"
                      disabled={busy}
                      title="Email this payslip to the employee"
                      onClick={() =>
                        run(
                          () => payslipService.emailOne(row._id),
                          (result) =>
                            result?.delivered
                              ? 'Payslip emailed'
                              : `Email failed: ${result?.error || 'unknown error'}`,
                        )
                      }
                    >
                      <Send aria-hidden="true" size={11} />
                    </button>
                  ) : null}
                  {canRegenerate ? (
                    <button
                      type="button"
                      className="rounded-lg px-1.5 py-1 text-[10px] font-semibold text-st-on-variant hover:bg-st-low disabled:opacity-50"
                      disabled={busy}
                      title="Re-render the PDF from the same snapshot"
                      onClick={() =>
                        run(
                          () => payslipService.regenerate(row._id),
                          (result) =>
                            result?.valuesUnchanged
                              ? 'PDF regenerated — salary values unchanged'
                              : 'PDF regenerated (values changed — please review)',
                        )
                      }
                    >
                      <RefreshCcw aria-hidden="true" size={11} />
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Bulk archive"
        subtitle="A ZIP of the month's payslips, built in the background for large companies."
        right={
          <div className="flex items-center gap-1.5">
            <select
              className="rounded-lg border border-st-outline-variant/70 bg-st-lowest px-2 py-1 text-[10px] font-semibold text-st-on"
              value={zipScope}
              onChange={(event) => setZipScope(event.target.value)}
              aria-label="Archive scope"
            >
              <option value="COMPANY">Entire company</option>
              <option value="DEPARTMENT">Department</option>
            </select>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg border border-st-outline-variant/60 px-2 py-1 text-[10px] font-semibold text-st-on hover:bg-st-low disabled:opacity-50"
              disabled={busy || !canRead}
              onClick={handleBulkDownload}
            >
              <Archive aria-hidden="true" size={10} /> Build ZIP
            </button>
          </div>
        }
      >
        <div className="border-t border-st-high px-3 py-2">
          {pendingArchive ? (
            <p className="text-[11px] text-st-on-variant">
              Preparing now — {formatNumber(pendingArchive.processed)}/{formatNumber(pendingArchive.total)}{' '}
              payslips ({pendingArchive.progress || 0}%).
            </p>
          ) : newestArchive ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-st-on">
                <span className="font-semibold">{newestArchive.filename || 'Payslip archive'}</span>
                <span className="ml-1.5 text-[10px] text-st-on-variant">
                  {formatNumber(newestArchive.total)} payslip(s) ·{' '}
                  {newestArchive.scope === 'DEPARTMENT'
                    ? newestArchive.departmentName || 'department'
                    : 'company'}
                  {newestArchive.sizeBytes
                    ? ` · ${formatNumber(Math.max(1, Math.round(newestArchive.sizeBytes / 1024)))} KB`
                    : ''}{' '}
                  · {formatStamp(newestArchive.createdAt)}
                </span>
              </p>
              {Number(newestArchive.total) > 0 ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-lg border border-st-outline-variant/60 px-2 py-1 text-[10px] font-semibold text-st-on hover:bg-st-low disabled:opacity-50"
                  disabled={busy}
                  onClick={() => downloadZip(newestArchive)}
                >
                  <Download aria-hidden="true" size={10} /> Download ZIP
                </button>
              ) : (
                <span className="text-[10px] text-st-on-variant">
                  Empty archive — build it again once payslips exist for the month.
                </span>
              )}
            </div>
          ) : (
            <p className="text-[11px] leading-relaxed text-st-on-variant">
              No archive built yet. One ZIP of this month&apos;s payslips is created on request and
              appears here when it is ready.
            </p>
          )}
          {readyArchives.length > 1 ? (
            <p className="mt-1 text-[10px] text-st-on-variant">
              {formatNumber(readyArchives.length - 1)} older archive(s) are listed on the exports page.
            </p>
          ) : null}
        </div>
      </Panel>

      {/* §16 — preview */}
      {viewing ? (
        <Modal
          title={`Payslip — ${viewing.monthLabel || viewing.month} · ${
            viewing.snapshot?.employee?.name || ''
          }`}
          onClose={() => setViewing(null)}
          wide
        >
          {viewing.snapshot ? (
            <PayslipDocument
              snapshot={viewing.snapshot}
              downloading={downloadingId === viewing._id}
              onDownload={async () => {
                await downloadOne(viewing);
                setViewing(null);
              }}
            />
          ) : (
            <p className="text-sm text-crewly-dim">This payslip has no snapshot yet.</p>
          )}
        </Modal>
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
                  await prompt.onConfirm();
                }}
              >
                {busy ? <Loader2 className="animate-spin" size={15} /> : <Building2 size={15} />}
                {prompt.actionLabel}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
};

export default PayslipsPage;
