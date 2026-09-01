/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Building2,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Mail,
  RefreshCcw,
  Search,
  Send,
  Wallet,
  XCircle,
} from 'lucide-react';

import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import PayslipDocument, { downloadPayslipFile } from './PayslipDocument.jsx';
import payslipService, { saveBlob } from '../../services/payslipService.js';

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

const STATUS_STYLES = {
  PENDING: 'bg-slate-500/15 text-slate-300',
  GENERATED: 'bg-emerald-500/15 text-emerald-300',
  EMAILED: 'bg-sky-500/15 text-sky-300',
  DOWNLOADED: 'bg-violet-500/15 text-violet-300',
  FAILED: 'bg-red-500/15 text-red-300',
};

const statusBadge = (status) => (
  <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${STATUS_STYLES[status] || STATUS_STYLES.PENDING}`}>
    {String(status || 'PENDING').toLowerCase()}
  </span>
);

const KpiCard = ({ icon: Icon, label, value, tone = 'default' }) => {
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
    </div>
  );
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
  const [banner, setBanner] = useState(null);
  const [accessDenied, setAccessDenied] = useState(false);

  const [viewing, setViewing] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [zipScope, setZipScope] = useState('COMPANY');

  const flash = useCallback((type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 7000);
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

  if ((!permsLoading && !canRead) || accessDenied) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Payslips</h1>
        <div className="card space-y-2">
          <h2 className="text-lg font-semibold">Payslip access required</h2>
          <p className="text-sm text-crewly-dim">
            You don&apos;t have permission to view payslips. Contact your Company Admin or Payroll
            Admin.
          </p>
        </div>
      </div>
    );
  }

  const rows = dashboard.payslips || [];
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

  const pendingArchive = bulkFiles.some((file) => ['QUEUED', 'PROCESSING'].includes(file.status));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Payslips</h1>
          <p className="mt-1 text-sm text-crewly-dim">
            Official salary documents, cut from the frozen payroll snapshot once the salary has been
            paid. Nothing here recalculates salary (§5).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input type="month" className="input" value={month} onChange={(event) => setMonth(event.target.value)} />
          <button
            className="btn-primary"
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
            <FileText size={15} /> Generate payslips
          </button>
          <button className="btn-secondary" disabled={busy || !canRelease} onClick={handleEmailMonth}>
            <Mail size={15} /> Email month
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

      {pendingArchive ? (
        <div className="card flex items-center gap-2 text-sm text-crewly-dim">
          <Loader2 className="animate-spin" size={15} /> An archive is being prepared — this page
          refreshes itself.
        </div>
      ) : null}

      {/* §27.1 — dashboard counters */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard icon={FileText} label="Payslips" value={formatNumber(summary.totalPayslips)} />
        <KpiCard icon={CheckCircle2} label="Generated" value={formatNumber(summary.generated)} tone="good" />
        <KpiCard icon={Mail} label="Emailed" value={formatNumber(summary.emailed)} />
        <KpiCard icon={Download} label="Downloaded" value={formatNumber(summary.downloaded)} />
        <KpiCard
          icon={XCircle}
          label="Failed"
          value={formatNumber(summary.failed)}
          tone={summary.failed ? 'bad' : 'default'}
        />
        <KpiCard icon={Wallet} label="Total net salary" value={formatMoney(summary.totalNetSalary)} />
      </div>

      {/* §18 — bulk download */}
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">Bulk download</h2>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="text-xs uppercase tracking-wide text-crewly-dim">Scope</label>
            <select className="input mt-1" value={zipScope} onChange={(event) => setZipScope(event.target.value)}>
              <option value="COMPANY">Entire company</option>
              <option value="DEPARTMENT">Department</option>
            </select>
          </div>
          <button className="btn-secondary" disabled={busy || !canRead} onClick={handleBulkDownload}>
            <Archive size={15} /> Build ZIP
          </button>
        </div>

        {bulkFiles.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-white/5 text-xs uppercase tracking-wide text-crewly-dim">
                <tr>
                  <th className="px-3 py-2">Requested</th>
                  <th className="px-3 py-2">Scope</th>
                  <th className="px-3 py-2">Files</th>
                  <th className="px-3 py-2">Progress</th>
                  <th className="px-3 py-2">By</th>
                  <th className="px-3 py-2 text-right">Archive</th>
                </tr>
              </thead>
              <tbody>
                {bulkFiles.map((file) => (
                  <tr key={file._id} className="border-t border-white/5">
                    <td className="px-3 py-2 text-xs">{formatStamp(file.createdAt)}</td>
                    <td className="px-3 py-2 text-xs">
                      {file.scope === 'DEPARTMENT' ? `Department · ${file.departmentName || '—'}` : 'Company'}
                    </td>
                    <td className="px-3 py-2">{formatNumber(file.total)}</td>
                    <td className="px-3 py-2">
                      {file.status === 'READY' ? (
                        <span className="text-xs text-emerald-300">ready</span>
                      ) : file.status === 'FAILED' ? (
                        <span className="text-xs text-red-300">{file.error || 'failed'}</span>
                      ) : (
                        <span className="text-xs text-crewly-dim">
                          {file.progress || 0}% · {formatNumber(file.processed)}/{formatNumber(file.total)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{file.requestedByName || '—'}</td>
                    <td className="px-3 py-2 text-right">
                      {file.status === 'READY' ? (
                        <button
                          className="text-sm text-indigo-300 hover:underline"
                          disabled={busy}
                          onClick={() => downloadZip(file)}
                        >
                          <Download size={14} className="inline" /> Download
                        </button>
                      ) : (
                        <span className="text-xs text-crewly-dim">
                          {file.status === 'FAILED' ? '—' : 'preparing…'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-crewly-dim">
            No archive yet. Large companies build the ZIP in the background, so the download appears
            here when it is ready (§18).
          </p>
        )}
      </div>

      {/* §27.3 — the list */}
      <div className="card overflow-x-auto p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-crewly-dim">
            Payslips · {formatMonthInput(month)}
          </h2>
          <span className="text-xs text-crewly-dim">
            {visible.length} of {rows.length}
          </span>
        </div>

        {/* §15 — filters */}
        <div className="flex flex-wrap items-end gap-3 border-b border-white/5 p-3">
          <div className="min-w-[200px] flex-1">
            <div className="flex items-center gap-2">
              <Search size={15} className="text-crewly-dim" />
              <input
                className="input w-full"
                placeholder="Search employee, code, payslip number…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wide text-crewly-dim">Financial year</label>
            <select
              className="input mt-1"
              value={financialYear}
              onChange={(event) => setFinancialYear(event.target.value)}
            >
              <option value="">All</option>
              {financialYears.map((fy) => (
                <option key={fy} value={fy}>
                  FY {fy}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wide text-crewly-dim">Year</label>
            <select className="input mt-1" value={year} onChange={(event) => setYear(event.target.value)}>
              <option value="">All</option>
              {years.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
        </div>

        <table className="w-full text-left text-sm">
          <thead className="bg-white/5 text-xs uppercase tracking-wide text-crewly-dim">
            <tr>
              <th className="px-3 py-2">Employee</th>
              <th className="px-3 py-2">Payslip number</th>
              <th className="px-3 py-2">Gross</th>
              <th className="px-3 py-2">Net</th>
              <th className="px-3 py-2">Payment date</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-crewly-dim">
                  <Loader2 className="mx-auto animate-spin" size={18} /> Loading payslips…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-crewly-dim">
                  {rows.length === 0
                    ? `No payslips for ${formatMonthInput(month)} yet. Generate them once the salary has been paid.`
                    : 'No payslip matches these filters.'}
                </td>
              </tr>
            ) : (
              visible.map((row) => (
                <tr key={row._id} className="border-t border-white/5 hover:bg-white/5">
                  <td className="px-3 py-2">
                    <button
                      className="font-medium text-indigo-300 hover:underline"
                      onClick={() => openPayslip(row)}
                    >
                      {row.employeeName || row.employeeCode}
                    </button>
                    <p className="text-[10px] text-crewly-dim">
                      {row.employeeCode}
                      {row.departmentName ? ` · ${row.departmentName}` : ''}
                    </p>
                  </td>
                  <td className="px-3 py-2 text-xs">{row.payslipNumber}</td>
                  <td className="px-3 py-2">{formatMoney(row.grossSalary)}</td>
                  <td className="px-3 py-2 font-semibold text-emerald-300">{formatMoney(row.netSalary)}</td>
                  <td className="px-3 py-2 text-xs">{formatStamp(row.paymentDate).split(',')[0]}</td>
                  <td className="px-3 py-2">
                    {statusBadge(row.status)}
                    {row.emailedAt ? <p className="mt-1 text-[10px] text-crewly-dim">emailed</p> : null}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        className="text-xs text-indigo-300 hover:underline disabled:opacity-50"
                        disabled={downloadingId === row._id || busy}
                        onClick={() => downloadOne(row)}
                      >
                        <Download size={13} className="inline" /> PDF
                      </button>
                      {canRelease ? (
                        <button
                          className="text-xs text-sky-300 hover:underline disabled:opacity-50"
                          disabled={busy}
                          onClick={() =>
                            run(
                              () => payslipService.emailOne(row._id),
                              (result) => (result?.delivered ? 'Payslip emailed' : `Email failed: ${result?.error || 'unknown error'}`),
                            )
                          }
                        >
                          <Send size={13} className="inline" /> Email
                        </button>
                      ) : null}
                      {canRegenerate ? (
                        <button
                          className="text-xs text-amber-300 hover:underline disabled:opacity-50"
                          disabled={busy}
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
                          <RefreshCcw size={13} className="inline" /> Regenerate
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

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
