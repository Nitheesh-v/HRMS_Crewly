/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  Building2,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  Download,
  FileSpreadsheet,
  FileText,
  Landmark,
  Loader2,
  RefreshCcw,
  ScrollText,
  ShieldCheck,
  Wallet,
} from 'lucide-react';

import usePermission from '../../hooks/usePermission.js';
import statutoryService, { saveBlob } from '../../services/statutoryService.js';

// ───────────────────────────────────────────────────────────────────────────
// Phase 29.10 — Payroll → Statutory Compliance (§5 / §25)
//
//   Overview  the consolidated compliance summary + the compliance register
//   PF ESI PT TDS LWF Gratuity   one report each, with its filing lifecycle
//   Annual    financial-year reports
//   Calendar  filing deadlines and who has ticked what off
//
// Two things this page never does:
//   · it never recalculates a statutory figure — every number arrives from
//     the immutable payroll snapshot (§2 / §6)
//   · it never claims a return was filed — that is a human attestation made
//     on the government portal and recorded here afterwards (§26)
// ───────────────────────────────────────────────────────────────────────────

const currentMonth = () => new Date().toISOString().slice(0, 7);

const money = (value) => `Rs ${Number(value || 0).toLocaleString('en-IN')}`;
const count = (value) => Number(value || 0).toLocaleString('en-IN');

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const monthLabel = (month) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return month || '—';
  const [year, part] = String(month).split('-');
  return `${MONTHS_LONG[Number(part) - 1]} ${year}`;
};

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const financialYearOf = (month, fyStartMonth = 4) => {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return '';
  const [year, part] = String(month).split('-').map(Number);
  const start = part >= fyStartMonth ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

const currentFinancialYear = () => {
  const now = new Date();
  const year = now.getFullYear();
  const start = now.getMonth() + 1 >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

// §14 — filing status colours.
const FILING_STYLES = {
  DRAFT: 'bg-slate-500/15 text-slate-300',
  REVIEWED: 'bg-sky-500/15 text-sky-300',
  READY: 'bg-amber-500/15 text-amber-300',
  FILED: 'bg-emerald-500/15 text-emerald-300',
  REOPENED: 'bg-orange-500/15 text-orange-300',
  NOT_GENERATED: 'bg-slate-500/10 text-crewly-dim',
};

const FILING_LABELS = {
  DRAFT: 'Draft',
  REVIEWED: 'Reviewed',
  READY: 'Ready',
  FILED: 'Filed',
  REOPENED: 'Reopened',
  NOT_GENERATED: 'Not generated',
};

const filingBadge = (status) => (
  <span
    className={`rounded-full px-2.5 py-0.5 text-[11px] ${
      FILING_STYLES[status] || FILING_STYLES.NOT_GENERATED
    }`}
  >
    {FILING_LABELS[status] || status || 'Not generated'}
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

// The report tabs. Gratuity and the compliance summary are reports, not
// returns, so only the first five carry a filing lifecycle (§14).
const REPORT_TABS = [
  { key: 'OVERVIEW', label: 'Overview', icon: ShieldCheck },
  { key: 'PF', label: 'PF', icon: Landmark },
  { key: 'ESI', label: 'ESI', icon: ShieldCheck },
  { key: 'PT', label: 'PT', icon: FileText },
  { key: 'TDS', label: 'TDS', icon: Wallet },
  { key: 'LWF', label: 'LWF', icon: Building2 },
  { key: 'GRATUITY', label: 'Gratuity', icon: Wallet },
  { key: 'ANNUAL', label: 'Annual', icon: FileSpreadsheet },
  { key: 'CALENDAR', label: 'Calendar', icon: CalendarClock },
];

const StatutoryCompliancePage = () => {
  const { loading: permsLoading, hasAnyPermission } = usePermission();

  // §4 — permissions, never role names.
  const canRead = hasAnyPermission([
    'PAYROLL_STATUTORY_READ',
    'PAYROLL_STATUTORY_GENERATE',
    'PAYROLL_STATUTORY_MANAGE',
    'PAYROLL_STATUTORY_FILING',
  ]);
  const canGenerate = hasAnyPermission(['PAYROLL_STATUTORY_GENERATE', 'PAYROLL_STATUTORY_MANAGE']);
  const canFile = hasAnyPermission(['PAYROLL_STATUTORY_FILING', 'PAYROLL_STATUTORY_MANAGE']);

  const [month, setMonth] = useState(currentMonth());
  const [tab, setTab] = useState('OVERVIEW');

  const [dashboard, setDashboard] = useState(null);
  const [report, setReport] = useState(null);
  const [history, setHistory] = useState({ rows: [] });
  const [annual, setAnnual] = useState(null);
  const [calendar, setCalendar] = useState({ rows: [] });
  const [exports, setExports] = useState([]);

  const [loading, setLoading] = useState(true);
  const [tabLoading, setTabLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);
  const [accessDenied, setAccessDenied] = useState(false);

  const [financialYear, setFinancialYear] = useState(currentFinancialYear());
  const [filingDraft, setFilingDraft] = useState({ status: 'FILED', reference: '', remarks: '' });
  const [exporting, setExporting] = useState(null);

  const flash = useCallback((type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 7000);
  }, []);

  // ── loads ────────────────────────────────────────────────────────────────

  const loadDashboard = useCallback(async () => {
    try {
      const data = await statutoryService.dashboard(month);
      setDashboard(data || null);
      setAccessDenied(false);
    } catch (error) {
      if (error?.status === 403) setAccessDenied(true);
      else flash('error', error?.message || 'Unable to load the compliance dashboard');
    } finally {
      setLoading(false);
    }
  }, [month, flash]);

  useEffect(() => {
    if (!permsLoading && canRead) loadDashboard();
    if (!permsLoading && !canRead) setLoading(false);
  }, [permsLoading, canRead, loadDashboard]);

  const loadTab = useCallback(async () => {
    if (tab === 'OVERVIEW') return;
    setTabLoading(true);
    try {
      if (tab === 'ANNUAL') {
        const data = await statutoryService.annual(financialYear);
        setAnnual(data || null);
        setExports(await statutoryService.exports({ financialYear }).catch(() => []));
      } else if (tab === 'CALENDAR') {
        setCalendar(await statutoryService.calendar(recentMonths(month, 3)));
      } else {
        setReport(await statutoryService.report({ type: tab, month }));
      }
    } catch (error) {
      flash('error', error?.message || 'Unable to load this report');
    } finally {
      setTabLoading(false);
    }
  }, [tab, month, financialYear, flash]);

  useEffect(() => {
    if (!permsLoading && canRead) loadTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, month, financialYear, permsLoading, canRead]);

  useEffect(() => {
    if (tab !== 'OVERVIEW') return;
    statutoryService
      .history(financialYearOf(month))
      .then((data) => setHistory(data || { rows: [] }))
      .catch(() => setHistory({ rows: [] }));
  }, [tab, month, dashboard]);

  // ── actions ──────────────────────────────────────────────────────────────

  const run = async (action, message) => {
    setBusy(true);
    try {
      const result = await action();
      flash('success', typeof message === 'function' ? message(result) : message);
      await loadDashboard();
      await loadTab();
      return result;
    } catch (error) {
      flash('error', error?.message || 'Unable to complete the action');
      await loadDashboard();
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleGenerate = () =>
    run(
      () => statutoryService.generate(month),
      (result) =>
        result?.queued
          ? 'Statutory reports queued — they will appear shortly'
          : `Statutory reports generated: ${count(result?.generated)} report(s) for ${monthLabel(month)}`,
    );

  const handleFiling = () =>
    run(
      () =>
        statutoryService.updateFiling({
          type: tab,
          month,
          status: filingDraft.status,
          filingReference: filingDraft.reference,
          filingRemarks: filingDraft.remarks,
        }),
      (result) => `Marked as ${FILING_LABELS[result?.status] || result?.status}`,
    );

  const downloadReport = async (reportKey, format, period = {}) => {
    setExporting(`${reportKey}-${format}`);
    try {
      const blob = await statutoryService.exportReport({ reportKey, format, ...period });
      const suffix = format.toLowerCase();
      const name = period.month || period.financialYear || month;
      saveBlob(blob, `statutory-${String(reportKey).toLowerCase()}-${name}.${suffix}`);
    } catch (error) {
      flash('error', error?.message || 'Unable to build this export');
    } finally {
      setExporting(null);
    }
  };

  const downloadRegister = async () => {
    setBusy(true);
    try {
      const blob = await statutoryService.register(financialYearOf(month));
      saveBlob(blob, `compliance-register-${financialYearOf(month)}.csv`);
    } catch (error) {
      flash('error', error?.message || 'Unable to build the compliance register');
    } finally {
      setBusy(false);
    }
  };

  const requestAnnual = (reportKey) =>
    run(
      () => statutoryService.requestAnnualExport({ financialYear, reportKey, format: 'XLSX' }),
      (result) => (result?.queued ? 'Annual report queued — it will appear below' : 'Annual report ready'),
    );

  const downloadExportRow = async (row) => {
    setBusy(true);
    try {
      const blob = await statutoryService.downloadExport(row._id);
      saveBlob(blob, row.filename || 'statutory-report.xlsx');
      await loadTab();
    } catch (error) {
      flash('error', error?.message || 'Unable to download this report');
    } finally {
      setBusy(false);
    }
  };

  const toggleTask = (row) =>
    run(
      () => statutoryService.updateCalendarTask({ month: row.month, type: row.type, done: !row.taskDone }),
      () => (row.taskDone ? 'Calendar task reopened' : 'Calendar task completed'),
    );

  const handleReminders = () =>
    run(
      () => statutoryService.sendReminders(month),
      (result) =>
        result?.queued
          ? 'Filing reminders queued'
          : `${count(result?.sent)} filing reminder(s) sent`,
    );

  // ── guards ───────────────────────────────────────────────────────────────

  if ((!permsLoading && !canRead) || accessDenied) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Statutory Compliance</h1>
        <div className="card space-y-2">
          <h2 className="text-lg font-semibold">Statutory access required</h2>
          <p className="text-sm text-crewly-dim">
            You don&apos;t have permission to view statutory reports. Contact your Company Admin or
            Payroll Admin.
          </p>
        </div>
      </div>
    );
  }

  const kpis = dashboard?.kpis || {};
  const summary = dashboard?.summary || {};
  const statuses = dashboard?.statuses || [];
  const statusOf = (type) => statuses.find((row) => row.type === type)?.status || 'NOT_GENERATED';
  const applicability = dashboard?.applicability || {};

  return (
    <div className="space-y-5">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Statutory Compliance</h1>
          <p className="text-sm text-crewly-dim">
            {monthLabel(month)} · {dashboard?.financialYearLabel || financialYearOf(month)} ·{' '}
            {count(dashboard?.paidCount)} paid employee(s)
            {dashboard?.cycle ? ` · ${String(dashboard.cycle).toLowerCase()} cycle` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            className="input-field w-auto"
            aria-label="Payroll month"
          />
          {canGenerate && (
            <button
              type="button"
              className="btn-primary flex items-center gap-2"
              onClick={handleGenerate}
              disabled={busy}
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCcw size={15} />}
              Generate reports
            </button>
          )}
          <button
            type="button"
            className="btn-secondary flex items-center gap-2"
            onClick={downloadRegister}
            disabled={busy}
          >
            <ScrollText size={15} /> Register
          </button>
          {canGenerate && (
            <button
              type="button"
              className="btn-secondary flex items-center gap-2"
              onClick={handleReminders}
              disabled={busy}
            >
              <BellRing size={15} /> Remind
            </button>
          )}
        </div>
      </div>

      {banner && (
        <div
          className={`card border-l-4 text-sm ${
            banner.type === 'error'
              ? 'border-red-500 text-red-300'
              : 'border-emerald-500 text-emerald-300'
          }`}
        >
          {banner.text}
        </div>
      )}

      {/* ── §5 KPI cards ───────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <KpiCard icon={Landmark} label="PF Payable" value={money(kpis.pfPayable)} />
        <KpiCard icon={ShieldCheck} label="ESI Payable" value={money(kpis.esiPayable)} />
        <KpiCard icon={FileText} label="PT Payable" value={money(kpis.ptPayable)} />
        <KpiCard icon={Wallet} label="TDS Payable" value={money(kpis.tdsPayable)} />
        <KpiCard icon={Building2} label="LWF Payable" value={money(kpis.lwfPayable)} />
        <KpiCard
          icon={CircleDashed}
          label="Filing Pending"
          value={count(kpis.filingPending)}
          tone={Number(kpis.filingPending) > 0 ? 'warn' : 'default'}
        />
        <KpiCard
          icon={CheckCircle2}
          label="Filing Completed"
          value={count(kpis.filingCompleted)}
          tone="good"
        />
      </div>

      {/* ── tabs ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-1 border-b border-white/10 pb-2">
        {REPORT_TABS.map(({ key, label, icon: Icon }) => {
          const hidden =
            (key === 'LWF' && !applicability.lwf) || (key === 'GRATUITY' && !applicability.gratuity);
          if (hidden) return null;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`flex items-center gap-1.5 rounded-t-md px-3 py-2 text-sm transition ${
                tab === key
                  ? 'border-b-2 border-crewly-accent text-crewly-text'
                  : 'text-crewly-dim hover:text-crewly-text'
              }`}
            >
              <Icon size={14} />
              {label}
              {key !== 'OVERVIEW' && key !== 'ANNUAL' && key !== 'CALENDAR' && (
                <span className="ml-1">{filingBadge(statusOf(key))}</span>
              )}
            </button>
          );
        })}
      </div>

      {tabLoading && (
        <div className="card flex items-center gap-2 text-sm text-crewly-dim">
          <Loader2 size={15} className="animate-spin" /> Loading…
        </div>
      )}

      {/* ── Overview ───────────────────────────────────────────────────── */}
      {tab === 'OVERVIEW' && !tabLoading && (
        <div className="space-y-5">
          <section className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">Compliance summary</h2>
                <p className="text-xs text-crewly-dim">
                  Every statutory liability for {monthLabel(month)}, in one view (§16).
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {['CSV', 'XLSX', 'PDF'].map((format) => (
                  <button
                    key={format}
                    type="button"
                    className="btn-secondary flex items-center gap-1.5"
                    onClick={() => downloadReport('COMPLIANCE_SUMMARY', format, { month })}
                    disabled={Boolean(exporting)}
                  >
                    {exporting === `COMPLIANCE_SUMMARY-${format}` ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Download size={14} />
                    )}
                    {format}
                  </button>
                ))}
              </div>
            </div>
            <SummaryTable summary={summary} applicability={applicability} />
          </section>

          <section className="card space-y-3">
            <h2 className="text-lg font-semibold">Compliance register</h2>
            <p className="text-xs text-crewly-dim">
              The filing history for {history.financialYearLabel || financialYearOf(month)} (§13).
            </p>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-crewly-dim">
                    <th className="py-2 pr-4">Month</th>
                    <th className="py-2 pr-4 text-right">Employees</th>
                    <th className="py-2 pr-4 text-right">Gross</th>
                    <th className="py-2 pr-4 text-right">PF</th>
                    <th className="py-2 pr-4 text-right">ESI</th>
                    <th className="py-2 pr-4 text-right">PT</th>
                    <th className="py-2 pr-4 text-right">TDS</th>
                    <th className="py-2 pr-4 text-right">LWF</th>
                    <th className="py-2 pr-4">PF status</th>
                    <th className="py-2 pr-4">TDS status</th>
                  </tr>
                </thead>
                <tbody>
                  {(history.rows || []).length === 0 && (
                    <tr>
                      <td colSpan={10} className="py-6 text-center text-sm text-crewly-dim">
                        No payroll months recorded for this financial year yet.
                      </td>
                    </tr>
                  )}
                  {(history.rows || []).map((row) => (
                    <tr key={row.month} className="border-t border-white/5">
                      <td className="py-2 pr-4">{row.monthLabel}</td>
                      <td className="py-2 pr-4 text-right">{count(row.employees)}</td>
                      <td className="py-2 pr-4 text-right">{money(row.gross)}</td>
                      <td className="py-2 pr-4 text-right">{money(row.pf)}</td>
                      <td className="py-2 pr-4 text-right">{money(row.esi)}</td>
                      <td className="py-2 pr-4 text-right">{money(row.pt)}</td>
                      <td className="py-2 pr-4 text-right">{money(row.tds)}</td>
                      <td className="py-2 pr-4 text-right">{money(row.lwf)}</td>
                      <td className="py-2 pr-4">{filingBadge(statusOfRow(row, 'PF'))}</td>
                      <td className="py-2 pr-4">{filingBadge(statusOfRow(row, 'TDS'))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* ── one statutory report ───────────────────────────────────────── */}
      {!['OVERVIEW', 'ANNUAL', 'CALENDAR'].includes(tab) && report && !tabLoading && (
        <ReportTab
          report={report}
          canFile={canFile}
          busy={busy}
          exporting={exporting}
          filingDraft={filingDraft}
          setFilingDraft={setFilingDraft}
          onFile={handleFiling}
          onExport={(format) => downloadReport(tab, format, { month })}
        />
      )}

      {/* ── §18 annual ─────────────────────────────────────────────────── */}
      {tab === 'ANNUAL' && annual && !tabLoading && (
        <AnnualTab
          annual={annual}
          financialYear={financialYear}
          setFinancialYear={setFinancialYear}
          canGenerate={canGenerate}
          busy={busy}
          exports={exports}
          onRequest={requestAnnual}
          onDownload={downloadExportRow}
        />
      )}

      {/* ── §19 calendar ───────────────────────────────────────────────── */}
      {tab === 'CALENDAR' && !tabLoading && (
        <CalendarTab calendar={calendar} busy={busy} onToggle={toggleTask} />
      )}
    </div>
  );
};

// ── the consolidated summary (§16) ─────────────────────────────────────────

const SummaryTable = ({ summary = {}, applicability = {} }) => {
  const sections = [
    ['Payroll Summary', [
      ['Gross payroll', summary.grossPayroll],
      ['Net payroll', summary.netPayroll],
    ]],
    ['PF', [
      ['Employee PF', summary.pf?.employee],
      ['Employer PF', summary.pf?.employer],
      ['Total PF payable', summary.pf?.total],
    ]],
    ['ESI', [
      ['Employee ESI', summary.esi?.employee],
      ['Employer ESI', summary.esi?.employer],
      ['Total ESI payable', summary.esi?.total],
    ]],
    ['PT', [['Professional tax collected', summary.pt?.total]]],
    ['TDS', [['TDS deducted', summary.tds?.total]]],
    ['LWF', [
      ['Employee LWF', summary.lwf?.employee],
      ['Employer LWF', summary.lwf?.employer],
      ['Total LWF payable', summary.lwf?.total],
    ]],
    ['Gratuity', [
      ['Monthly provision', summary.gratuity?.monthly],
      ['Annualised liability', summary.gratuity?.annualised],
    ]],
  ].filter(([section]) => section !== 'LWF' || applicability.lwf)
   .filter(([section]) => section !== 'Gratuity' || applicability.gratuity);

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {sections.map(([section, rows]) => (
        <div key={section} className="rounded-lg border border-white/5 p-3">
          <p className="text-xs uppercase tracking-wide text-crewly-dim">{section}</p>
          <dl className="mt-2 space-y-1.5">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-2 text-sm">
                <dt className="text-crewly-dim">{label}</dt>
                <dd className="font-medium">{money(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
};

// ── one report tab (§7–§14) ────────────────────────────────────────────────

const ReportTab = ({
  report,
  canFile,
  busy,
  exporting,
  filingDraft,
  setFilingDraft,
  onFile,
  onExport,
}) => {
  const table = report.table || { headers: [], rows: [] };
  const extras = report.extras || {};

  return (
    <div className="space-y-5">
      <section className="card space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{report.typeLabel}</h2>
              {filingBadge(report.status)}
            </div>
            <p className="text-xs text-crewly-dim">
              {report.monthLabel}
              {report.dueDate ? ` · due ${formatDate(report.dueDate)}` : ''}
              {` · ${count(report.employeeCount)} employee(s) in the snapshot`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {['CSV', 'XLSX', 'PDF'].map((format) => (
              <button
                key={format}
                type="button"
                className="btn-secondary flex items-center gap-1.5"
                onClick={() => onExport(format)}
                disabled={Boolean(exporting)}
              >
                {exporting === `${report.type}-${format}` ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Download size={14} />
                )}
                {format}
              </button>
            ))}
          </div>
        </div>

        {!report.applicable && (
          <p className="rounded-md bg-slate-500/10 px-3 py-2 text-sm text-crewly-dim">
            This company does not have {report.typeLabel} switched on in Payroll Setup, so there is
            nothing to report.
          </p>
        )}

        {/* §14 — the filing panel. Reports that are not returns have none. */}
        {report.filable && (
          <div className="rounded-lg border border-white/5 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-crewly-dim">
                Status
                <select
                  className="input-field mt-1 w-auto"
                  value={filingDraft.status}
                  onChange={(event) =>
                    setFilingDraft({ ...filingDraft, status: event.target.value })
                  }
                >
                  <option value="REVIEWED">Reviewed</option>
                  <option value="READY">Ready</option>
                  <option value="FILED">Filed</option>
                  <option value="REOPENED">Reopened</option>
                </select>
              </label>
              <label className="text-xs text-crewly-dim">
                Portal reference
                <input
                  className="input-field mt-1"
                  placeholder="e.g. ECR-2026-08-000412"
                  value={filingDraft.reference}
                  onChange={(event) =>
                    setFilingDraft({ ...filingDraft, reference: event.target.value })
                  }
                />
              </label>
              <label className="text-xs text-crewly-dim">
                Remarks
                <input
                  className="input-field mt-1"
                  placeholder="Optional"
                  value={filingDraft.remarks}
                  onChange={(event) =>
                    setFilingDraft({ ...filingDraft, remarks: event.target.value })
                  }
                />
              </label>
              {canFile ? (
                <button
                  type="button"
                  className="btn-primary flex items-center gap-1.5"
                  onClick={onFile}
                  disabled={busy}
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  Update status
                </button>
              ) : (
                <span className="text-xs text-crewly-dim">
                  Filing status is updated by Finance.
                </span>
              )}
            </div>
            {report.filing && (
              <p className="mt-2 text-xs text-crewly-dim">
                {report.filing.generatedByName
                  ? `Generated by ${report.filing.generatedByName}${report.filing.generatedAt ? ` on ${formatDate(report.filing.generatedAt)}` : ''}. `
                  : ''}
                {report.filing.filedByName
                  ? `Filed by ${report.filing.filedByName}${report.filing.filedAt ? ` on ${formatDate(report.filing.filedAt)}` : ''}`
                  : 'Not filed yet.'}
                {report.filing.filingReference ? ` · Ref ${report.filing.filingReference}` : ''}
              </p>
            )}
            <p className="mt-2 text-[11px] text-crewly-dim">
              Crewly prepares this return; it does not submit it. Recording a status here is an
              attestation that the filing was completed on the government portal.
            </p>
          </div>
        )}
      </section>

      {/* §9 — PT is state-wise. */}
      {extras.byState?.length > 0 && (
        <section className="card space-y-2">
          <h3 className="text-sm font-semibold">State-wise collection</h3>
          <DataTable
            headers={['State', 'Employees', 'PT collected']}
            rows={extras.byState.map((row) => [row.state, count(row.employees), money(row.amount)])}
          />
          <p className="text-[11px] text-crewly-dim">
            Slabs come from the payroll engine and the state recorded in Payroll Setup — they are
            never hardcoded here.
          </p>
        </section>
      )}

      {/* §10 — TDS carries a department summary. */}
      {extras.byDepartment?.length > 0 && (
        <section className="card space-y-2">
          <h3 className="text-sm font-semibold">Department summary</h3>
          <DataTable
            headers={['Department', 'Employees', 'Taxable income (annualised)', 'TDS']}
            rows={extras.byDepartment.map((row) => [
              row.department,
              count(row.employees),
              money(row.taxableIncome),
              money(row.tds),
            ])}
          />
        </section>
      )}

      <section className="card space-y-2">
        <h3 className="text-sm font-semibold">{report.typeLabel} register</h3>
        <DataTable headers={table.headers} rows={table.rows} />
      </section>
    </div>
  );
};

// ── §18 annual ─────────────────────────────────────────────────────────────

const ANNUAL_REPORTS = [
  { key: 'ANNUAL_PF', label: 'Annual PF Summary' },
  { key: 'ANNUAL_TDS', label: 'Annual TDS Summary' },
  { key: 'ANNUAL_PAYROLL_REGISTER', label: 'Annual Payroll Register' },
  { key: 'ANNUAL_EMPLOYER_CONTRIBUTION', label: 'Annual Employer Contribution' },
  { key: 'ANNUAL_DEPARTMENT', label: 'Department-wise Payroll' },
];

const AnnualTab = ({
  annual,
  financialYear,
  setFinancialYear,
  canGenerate,
  busy,
  exports,
  onRequest,
  onDownload,
}) => (
  <div className="space-y-5">
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Annual reports</h2>
          <p className="text-xs text-crewly-dim">
            Built from every monthly snapshot in {annual.financialYearLabel} (§18).
          </p>
        </div>
        <input
          className="input-field w-auto"
          value={financialYear}
          onChange={(event) => setFinancialYear(event.target.value)}
          placeholder="2026-27"
          aria-label="Financial year"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard icon={Landmark} label="PF (employee + employer)" value={money(annual.summary?.pf?.total)} />
        <KpiCard icon={ShieldCheck} label="ESI total" value={money(annual.summary?.esi?.total)} />
        <KpiCard icon={FileText} label="Professional tax" value={money(annual.summary?.pt?.total)} />
        <KpiCard icon={Wallet} label="TDS deducted" value={money(annual.summary?.tds?.total)} />
        <KpiCard icon={Building2} label="Gross payroll" value={money(annual.summary?.grossPayroll)} />
      </div>

      {canGenerate && (
        <div className="flex flex-wrap gap-2">
          {ANNUAL_REPORTS.map((item) => (
            <button
              key={item.key}
              type="button"
              className="btn-secondary flex items-center gap-1.5"
              onClick={() => onRequest(item.key)}
              disabled={busy}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </section>

    <section className="card space-y-2">
      <h3 className="text-sm font-semibold">Month-by-month register</h3>
      <DataTable
        headers={['Month', 'Employees', 'Gross', 'Net', 'PF', 'ESI', 'PT', 'TDS', 'LWF']}
        rows={(annual.registers || []).map((row) => [
          row.monthLabel,
          count(row.employees),
          money(row.grossPayroll),
          money(row.netPayroll),
          money(row.pfTotal),
          money(row.esiTotal),
          money(row.pt),
          money(row.tds),
          money(row.lwfTotal),
        ])}
      />
    </section>

    <section className="card space-y-2">
      <h3 className="text-sm font-semibold">Department-wise payroll</h3>
      <DataTable
        headers={['Department', 'Employees', 'Gross', 'Net', 'PF', 'ESI', 'TDS', 'Employer contributions']}
        rows={(annual.departments || []).map((row) => [
          row.department,
          count(row.employees),
          money(row.grossPayroll),
          money(row.netPayroll),
          money(row.pfTotal),
          money(row.esiTotal),
          money(row.tds),
          money(row.employerContributions),
        ])}
      />
    </section>

    <section className="card space-y-2">
      <h3 className="text-sm font-semibold">Per-employee annual totals</h3>
      <DataTable
        headers={['Code', 'Employee', 'PAN', 'UAN', 'Months', 'Gross', 'Employee PF', 'Employer PF', 'TDS']}
        rows={(annual.employees || []).map((row) => [
          row.employeeCode,
          row.employeeName,
          row.pan || '—',
          row.uan || '—',
          count(row.months),
          money(row.gross),
          money(row.employeePF),
          money(row.employerPF),
          money(row.tds),
        ])}
      />
    </section>

    {(exports || []).length > 0 && (
      <section className="card space-y-2">
        <h3 className="text-sm font-semibold">Generated files</h3>
        <DataTable
          headers={['Report', 'Format', 'Status', 'Rows', 'Requested by', '', ]}
          rows={(exports || []).map((row) => [
            row.reportLabel,
            row.format,
            row.status,
            count(row.rowCount),
            row.requestedByName || '—',
            row.status === 'READY' ? (
              <button
                type="button"
                className="btn-secondary flex items-center gap-1"
                onClick={() => onDownload(row)}
                disabled={busy}
              >
                <Download size={13} /> Download
              </button>
            ) : (
              <span className="text-xs text-crewly-dim">{row.progress || 0}%</span>
            ),
          ])}
        />
      </section>
    )}
  </div>
);

// ── §19 calendar ───────────────────────────────────────────────────────────

const CalendarTab = ({ calendar, busy, onToggle }) => {
  const rows = calendar.rows || [];
  return (
    <div className="space-y-5">
      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Compliance calendar</h2>
            <p className="text-xs text-crewly-dim">
              Statutory filing deadlines and what is still open (§19). Crewly tracks these; it does
              not file them.
            </p>
          </div>
          <div className="flex gap-3 text-xs text-crewly-dim">
            <span>{count(calendar.pending)} open</span>
            <span className={Number(calendar.overdue) > 0 ? 'text-red-300' : ''}>
              {count(calendar.overdue)} overdue
            </span>
          </div>
        </div>

        <DataTable
          headers={['Month', 'Return', 'Due date', 'Report status', 'Task', '']}
          rows={rows.map((row) => [
            row.monthLabel,
            <>
              {row.typeLabel}
              {row.overdue && (
                <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-red-300">
                  <AlertTriangle size={11} /> overdue
                </span>
              )}
            </>,
            formatDate(row.dueDate),
            filingBadge(row.status),
            row.taskDone ? (
              <span className="text-emerald-300">Completed</span>
            ) : (
              <span className="text-crewly-dim">Pending</span>
            ),
            <button
              type="button"
              className="btn-secondary flex items-center gap-1"
              onClick={() => onToggle(row)}
              disabled={busy}
            >
              {row.taskDone ? 'Reopen' : 'Mark complete'}
            </button>,
          ])}
        />

        {rows.length === 0 && (
          <p className="py-4 text-center text-sm text-crewly-dim">
            No compliance deadlines to show. Generate the month&apos;s reports first.
          </p>
        )}
      </section>
    </div>
  );
};

// ── a small shared table ───────────────────────────────────────────────────

const DataTable = ({ headers = [], rows = [] }) => (
  <div className="overflow-x-auto">
    <table className="min-w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-crewly-dim">
          {(headers || []).map((header, index) => (
            <th key={`${header}-${index}`} className="whitespace-nowrap py-2 pr-4">
              {header || ''}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(rows || []).length === 0 && (
          <tr>
            <td colSpan={headers.length} className="py-6 text-center text-sm text-crewly-dim">
              Nothing to show for this period.
            </td>
          </tr>
        )}
        {(rows || []).map((row, rowIndex) => (
          <tr key={rowIndex} className="border-t border-white/5">
            {(row || []).map((cell, cellIndex) => (
              <td key={cellIndex} className="whitespace-nowrap py-2 pr-4">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

// ── helpers ────────────────────────────────────────────────────────────────

const statusOfRow = (row, type) =>
  (row.statuses || []).find((entry) => entry.type === type)?.status || 'NOT_GENERATED';

const recentMonths = (month, howMany) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) return [];
  const [year, part] = String(month).split('-').map(Number);
  const months = [];
  for (let offset = howMany - 1; offset >= 0; offset -= 1) {
    const index = part - 1 - offset;
    const y = year + Math.floor(index / 12);
    const m = ((index % 12) + 12) % 12;
    months.push(`${y}-${String(m + 1).padStart(2, '0')}`);
  }
  return months;
};

export default StatutoryCompliancePage;
