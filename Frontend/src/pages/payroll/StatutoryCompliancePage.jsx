/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  Building2,
  CalendarClock,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileText,
  ArrowRight,
  Landmark,
  Loader2,
  RefreshCcw,
  ScrollText,
  ShieldCheck,
  Wallet,
} from 'lucide-react';

import usePermission from '../../hooks/usePermission.js';
import statutoryService, { saveBlob } from '../../services/statutoryService.js';
import { notify } from '../../utils/notify.js';
import { TableEmpty } from '../../components/common/EmptyState.jsx';
import EmptyState from '../../components/common/EmptyState.jsx';
import {
  CheckRow,
  Panel,
  Pill,
  Rail,
  StageBand,
  StageButton,
  StatCard,
  Td,
  Th,
} from '../../components/payroll/PayrollCockpit.jsx';

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
  const [monthCalendar, setMonthCalendar] = useState({ rows: [] });
  const [exports, setExports] = useState([]);

  const [loading, setLoading] = useState(true);
  const [tabLoading, setTabLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

  const [financialYear, setFinancialYear] = useState(currentFinancialYear());
  const [filingDraft, setFilingDraft] = useState({ status: 'FILED', reference: '', remarks: '' });
  const [exporting, setExporting] = useState(null);

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

  /*
   * The overview needs two more reads beside the dashboard: the year's
   * register (the ledger) and this month's filing window (the due-date rail).
   * Both are the same endpoints the Register and Calendar tabs use, so the
   * numbers cannot drift between them.
   */
  useEffect(() => {
    if (tab !== 'OVERVIEW') return undefined;
    let active = true;
    statutoryService
      .history(financialYearOf(month))
      .then((data) => {
        if (active) setHistory(data || { rows: [] });
      })
      .catch(() => {
        if (active) setHistory({ rows: [] });
      });
    statutoryService
      .calendar([month])
      .then((data) => {
        if (active) setMonthCalendar(data || { rows: [] });
      })
      .catch(() => {
        if (active) setMonthCalendar({ rows: [] });
      });
    return () => {
      active = false;
    };
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
      <div className="space-y-4">
        <StageBand
          eyebrow="Payroll · Statutory"
          title="Statutory Compliance"
          description="Employer and employee statutory liabilities for the payroll month."
        />
        <Panel title="Statutory access required">
          <p className="px-4 pb-4 text-[11px] leading-relaxed text-st-on-variant">
            This page is limited to PAYROLL_STATUTORY_READ. Ask your Company Admin or Payroll Admin
            for access.
          </p>
        </Panel>
      </div>
    );
  }

  const kpis = dashboard?.kpis || {};
  const summary = dashboard?.summary || {};
  const statuses = dashboard?.statuses || [];
  const applicability = dashboard?.applicability || {};
  const statusOf = (type) => statuses.find((row) => row.type === type)?.status || 'NOT_GENERATED';

  /*
   * The six blocks the summary carries. `applicable` is the company's own
   * 29.1 switch — a block that is off is not shown at all rather than shown as
   * a zero, the same rule the report tabs follow.
   */
  const blocks = [
    {
      type: 'PF',
      label: 'Provident Fund (PF)',
      icon: Landmark,
      applicable: applicability.pf,
      employee: summary.pf?.employee,
      employer: summary.pf?.employer,
      total: summary.pf?.total,
      members: summary.pf?.employees,
      memberWord: 'member(s) with PF',
    },
    {
      type: 'ESI',
      label: 'Employees’ State Insurance (ESI)',
      icon: ShieldCheck,
      applicable: applicability.esi,
      employee: summary.esi?.employee,
      employer: summary.esi?.employer,
      total: summary.esi?.total,
      members: summary.esi?.employees,
      memberWord: 'employee(s) under ESI',
    },
    {
      type: 'PT',
      label: `Professional Tax (PT)${applicability.ptState ? ` · ${applicability.ptState}` : ''}`,
      icon: FileText,
      applicable: applicability.pt,
      employee: summary.pt?.total,
      employer: null,
      total: summary.pt?.total,
      members: summary.pt?.employees,
      memberWord: 'employee(s) in a PT slab',
    },
    {
      type: 'TDS',
      label: 'Income Tax (TDS)',
      icon: Wallet,
      applicable: applicability.tds,
      employee: summary.tds?.total,
      employer: null,
      total: summary.tds?.total,
      members: summary.tds?.employees,
      memberWord: 'employee(s) under TDS',
    },
    {
      type: 'LWF',
      label: 'Labour Welfare Fund (LWF)',
      icon: Building2,
      applicable: applicability.lwf,
      employee: summary.lwf?.employee,
      employer: summary.lwf?.employer,
      total: summary.lwf?.total,
      members: summary.lwf?.employees,
      memberWord: 'employee(s) covered',
    },
    {
      type: 'GRATUITY',
      label: 'Gratuity provision',
      icon: ScrollText,
      applicable: applicability.gratuity,
      employee: null,
      employer: summary.gratuity?.monthly,
      total: summary.gratuity?.monthly,
      members: summary.gratuity?.employees,
      memberWord: 'employee(s) accruing gratuity',
      provision: true,
    },
  ].filter((block) => block.applicable);

  // One due date per applicable type, straight from the compliance calendar.
  const calendarRows = (monthCalendar?.rows || []).filter((row) => row.month === month);
  const dueFor = (type) => calendarRows.find((row) => row.type === type) || null;
  const dueSorted = [...calendarRows].sort((a, b) =>
    String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')),
  );
  const overdueCount = calendarRows.filter((row) => row.overdue).length;
  const generatedCount = calendarRows.filter((row) => row.status !== 'NOT_GENERATED').length;

  /*
   * A monthly obligation is money that actually leaves the company this month.
   * Gratuity is a provision, not a remittance, so it is named separately
   * rather than folded into the total.
   */
  const sumTotal = (keys) => keys.reduce((total, key) => total + Number(summary?.[key]?.total || 0), 0);
  const obligationTotal = sumTotal(['pf', 'esi', 'pt', 'tds', 'lwf']);
  const employeeShare = ['pf', 'esi', 'lwf'].reduce(
    (total, key) => total + Number(summary?.[key]?.employee || 0),
    0,
  ) + Number(summary?.pt?.total || 0) + Number(summary?.tds?.total || 0);
  const employerShare = ['pf', 'esi', 'lwf'].reduce(
    (total, key) => total + Number(summary?.[key]?.employer || 0),
    0,
  );

  const filable = blocks.filter((block) => !block.provision);
  const filedCount = filable.filter((block) => statusOf(block.type) === 'FILED').length;

  const filingTone = (status) =>
    status === 'FILED'
      ? 'good'
      : status === 'READY' || status === 'REVIEWED'
        ? 'warn'
        : status === 'DRAFT'
          ? 'accent'
          : 'default';

  const historyRows = [...(history.rows || [])]
    .sort((a, b) => String(b.month).localeCompare(String(a.month)))
    .slice(0, 6);

  const dueLabel = (row) => {
    if (!row) return '—';
    if (row.daysRemaining === null || row.daysRemaining === undefined) return formatDate(row.dueDate);
    if (row.overdue) return `${Math.abs(row.daysRemaining)} day(s) overdue`;
    if (row.daysRemaining === 0) return 'due today';
    return `in ${row.daysRemaining} day(s)`;
  };

  return (
    <div className="space-y-3">
      <StageBand
        eyebrow="Payroll · Statutory"
        title="Statutory Compliance"
        description={
          dashboard
            ? `${monthLabel(dashboard.month || month)} · FY ${dashboard.financialYearLabel || financialYearOf(month)} · ${count(dashboard.paidCount)} employee(s) paid${dashboard.cycle ? ` · ${String(dashboard.cycle).toLowerCase()} cycle` : ''}. Every figure below is read from that month's locked payroll snapshot.`
            : 'Employer and employee statutory liabilities for the payroll month.'
        }
        pills={[
          { label: `${count(filedCount)} of ${count(filable.length)} filed`, tone: filedCount === filable.length ? 'good' : 'warn' },
          ...(overdueCount ? [{ label: `${count(overdueCount)} overdue`, tone: 'bad' }] : []),
          ...(dashboard?.cycle ? [{ label: String(dashboard.cycle).toLowerCase(), tone: 'default' }] : []),
        ]}
        aside={
          <div className="text-right">
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
              Monthly obligations
            </p>
            <p className="text-lg font-bold leading-tight tabular-nums text-st-on">
              {money(obligationTotal)}
            </p>
            <p className="text-[10px] text-st-on-variant">
              PF + ESI + PT + TDS + LWF
            </p>
          </div>
        }
        actions={
          <>
            <label className="flex items-center gap-2 text-[11px] font-semibold text-st-on-variant">
              <span className="uppercase tracking-wide">Month</span>
              <input
                type="month"
                value={month}
                onChange={(event) => setMonth(event.target.value)}
                className="rounded-lg border border-st-outline-variant/70 bg-st-lowest px-2 py-1.5 text-[11px] font-semibold text-st-on"
                aria-label="Payroll month"
              />
            </label>
            {canGenerate ? (
              <StageButton variant="primary" icon={RefreshCcw} onClick={handleGenerate} disabled={busy}>
                {busy ? 'Generating…' : 'Generate reports'}
              </StageButton>
            ) : null}
            <StageButton icon={ScrollText} onClick={downloadRegister} disabled={busy}>
              Register
            </StageButton>
            {canGenerate ? (
              <StageButton icon={BellRing} onClick={handleReminders} disabled={busy}>
                Remind
              </StageButton>
            ) : null}
          </>
        }
      />

      {loading ? (
        <Panel>
          <p className="flex items-center gap-2 px-4 py-8 text-[11px] text-st-on-variant">
            <Loader2 aria-hidden="true" className="animate-spin" size={14} /> Loading the compliance
            dashboard…
          </p>
        </Panel>
      ) : !dashboard ? (
        <Panel>
          <p className="px-4 py-6 text-[11px] leading-relaxed text-st-on-variant">
            No compliance dashboard came back for {monthLabel(month)}. Statutory reports are prepared
            only for a month whose payroll has been paid — pay the run, then generate the reports.
          </p>
        </Panel>
      ) : (
        <>
          {/* The report tabs stay one strip: the summary is the first tab, the
              individual returns are the rest. */}
          <div className="flex flex-wrap items-center gap-1 rounded-xl bg-st-lowest p-1.5 shadow-sm">
            {REPORT_TABS.map(({ key, label, icon: Icon }) => {
              const hidden =
                (key === 'LWF' && !applicability.lwf) ||
                (key === 'GRATUITY' && !applicability.gratuity);
              if (hidden) return null;
              const active = tab === key;
              const showStatus = !['OVERVIEW', 'ANNUAL', 'CALENDAR'].includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setTab(key)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition ${
                    active
                      ? 'bg-st-primary-container text-st-on-primary-container shadow-sm'
                      : 'text-st-on-variant hover:bg-st-low'
                  }`}
                >
                  <Icon aria-hidden="true" size={12} />
                  {label}
                  {showStatus ? (
                    <span className="text-[9px] uppercase tracking-wide opacity-80">
                      {FILING_LABELS[statusOf(key)] || statusOf(key)}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {tabLoading ? (
            <Panel>
              <p className="flex items-center gap-2 px-4 py-6 text-[11px] text-st-on-variant">
                <Loader2 aria-hidden="true" className="animate-spin" size={14} /> Loading this report…
              </p>
            </Panel>
          ) : null}

          {tab === 'OVERVIEW' ? (
            <>
          {blocks.length === 0 ? (
            <Panel title="No statutory scheme is switched on">
              <p className="px-4 pb-4 text-[11px] leading-relaxed text-st-on-variant">
                PF, ESI, PT, TDS, LWF and gratuity are all off in this company&apos;s setup, so there is
                nothing to remit. Turn a scheme on under Payroll setup to see its liability here.
              </p>
            </Panel>
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
              {blocks.map((block) => (
                <StatCard
                  key={block.type}
                  icon={block.icon}
                  label={block.label}
                  value={money(block.total)}
                  badge={{
                    label: FILING_LABELS[statusOf(block.type)] || statusOf(block.type),
                    tone: filingTone(statusOf(block.type)),
                  }}
                  hint={`${count(block.members)} ${block.memberWord}${
                    block.provision ? ' · provision, not remitted' : ''
                  }`}
                  tone={statusOf(block.type) === 'FILED' ? 'good' : 'default'}
                />
              ))}
            </div>
          )}

          <div className="flex flex-col gap-3 xl:flex-row">
            <div className="min-w-0 flex-1 space-y-3">
              {/* ── the filing summary ─────────────────────────────────── */}
              <Panel
                title="Compliance filing summary"
                subtitle={`Computed from the locked payroll run for ${monthLabel(dashboard.month || month)}. Employee share is withheld from salary; employer share is the company's own contribution.`}
                right={
                  <div className="flex items-center gap-1.5">
                    {['CSV', 'XLSX', 'PDF'].map((format) => (
                      <button
                        key={format}
                        type="button"
                        className="inline-flex items-center gap-1 rounded-lg border border-st-outline-variant/60 px-2 py-1 text-[10px] font-semibold text-st-on hover:bg-st-low disabled:opacity-50"
                        onClick={() => downloadReport('COMPLIANCE_SUMMARY', format, { month })}
                        disabled={Boolean(exporting)}
                      >
                        {exporting === `COMPLIANCE_SUMMARY-${format}` ? (
                          <Loader2 aria-hidden="true" size={10} className="animate-spin" />
                        ) : (
                          <Download aria-hidden="true" size={10} />
                        )}
                        {format}
                      </button>
                    ))}
                  </div>
                }
              >
                <div className="overflow-x-auto border-t border-st-high">
                  <table className="min-w-full">
                    <thead>
                      <tr className="bg-st-low/60">
                        <Th>Component</Th>
                        <Th className="text-right">Employee share</Th>
                        <Th className="text-right">Employer share</Th>
                        <Th className="text-right">Total payable</Th>
                        <Th>Due</Th>
                        <Th>Filing</Th>
                        <Th className="text-right">Action</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {blocks.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-3 py-6 text-[11px] text-st-on-variant">
                            No statutory scheme is switched on for this company.
                          </td>
                        </tr>
                      ) : (
                        blocks.map((block) => {
                          const due = dueFor(block.type);
                          return (
                            <tr key={block.type} className="border-t border-st-high hover:bg-st-selected/25">
                              <Td>
                                <span className="font-semibold">{block.label}</span>
                                <span className="ml-1.5 text-[10px] text-st-on-variant">
                                  {count(block.members)} employee(s)
                                </span>
                              </Td>
                              <Td className="text-right tabular-nums">
                                {block.employee === null ? '—' : money(block.employee)}
                              </Td>
                              <Td className="text-right tabular-nums">
                                {block.employer === null ? '—' : money(block.employer)}
                              </Td>
                              <Td className="text-right font-semibold tabular-nums">
                                {money(block.total)}
                              </Td>
                              <Td>
                                {statusOf(block.type) === 'FILED' && due?.filedAt ? (
                                  <span>filed {formatDate(due.filedAt)}</span>
                                ) : (
                                  <>
                                    <span className="tabular-nums">{formatDate(due?.dueDate)}</span>
                                    <span className="ml-1 text-[10px] text-st-on-variant">
                                      {dueLabel(due)}
                                    </span>
                                  </>
                                )}
                              </Td>
                              <Td>
                                <Pill tone={filingTone(statusOf(block.type))}>
                                  {FILING_LABELS[statusOf(block.type)] || statusOf(block.type)}
                                </Pill>
                                {due?.overdue ? (
                                  <span className="ml-1 text-[10px] font-semibold text-st-error">
                                    overdue
                                  </span>
                                ) : null}
                              </Td>
                              <Td className="text-right">
                                <button
                                  type="button"
                                  className="inline-flex items-center gap-1 rounded-lg border border-st-outline-variant/60 px-2 py-1 text-[10px] font-semibold text-st-on hover:bg-st-low"
                                  onClick={() => setTab(block.type)}
                                  title={`Open the ${block.type} working`}
                                >
                                  Open <ArrowRight aria-hidden="true" size={10} />
                                </button>
                              </Td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                    {blocks.length ? (
                      <tfoot>
                        <tr className="border-t-2 border-st-outline-variant/50 bg-st-low/40">
                          <Td className="font-bold">Monthly obligations</Td>
                          <Td className="text-right font-bold tabular-nums">{money(employeeShare)}</Td>
                          <Td className="text-right font-bold tabular-nums">{money(employerShare)}</Td>
                          <Td className="text-right font-bold tabular-nums">{money(obligationTotal)}</Td>
                          <Td colSpan={3} className="text-[10px] text-st-on-variant">
                            Gratuity {money(summary.gratuity?.monthly)} is provisioned, not remitted
                            monthly.
                          </Td>
                        </tr>
                      </tfoot>
                    ) : null}
                  </table>
                </div>
              </Panel>

              {/* ── recent filings ledger ──────────────────────────────── */}
              <Panel
                title="Recent filings ledger"
                subtitle={`Every month with a statutory summary in FY ${history.financialYearLabel || financialYearOf(month)}, newest first.`}
                right={
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-lg border border-st-outline-variant/60 px-2 py-1 text-[10px] font-semibold text-st-on hover:bg-st-low"
                    onClick={() => downloadReport('COMPLIANCE_SUMMARY', 'CSV', { financialYear: financialYearOf(month) })}
                    disabled={Boolean(exporting)}
                  >
                    <Download aria-hidden="true" size={10} /> Full register
                  </button>
                }
              >
                {historyRows.length === 0 ? (
                  <p className="border-t border-st-high px-4 py-6 text-[11px] leading-relaxed text-st-on-variant">
                    No completed payroll month is recorded for this financial year yet. Once a month is
                    paid, its PF, ESI, PT and TDS totals land here.
                  </p>
                ) : (
                  <ul className="divide-y divide-st-high border-t border-st-high">
                    {historyRows.map((row) => {
                      const monthTotal =
                        Number(row.pf || 0) +
                        Number(row.esi || 0) +
                        Number(row.pt || 0) +
                        Number(row.tds || 0) +
                        Number(row.lwf || 0);
                      return (
                        <li
                          key={row.month}
                          className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 hover:bg-st-selected/20"
                        >
                          <div className="min-w-0">
                            <p className="text-[12px] font-bold text-st-on">{row.monthLabel}</p>
                            <p className="text-[10px] text-st-on-variant">
                              {money(monthTotal)} total · {count(row.employees)} employee(s) ·
                              gratuity {money(row.gratuity)}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-1">
                            {['PF', 'ESI', 'PT', 'TDS', 'LWF'].map((type) => {
                              const status = (row.statuses || []).find((entry) => entry.type === type)?.status;
                              if (!status || !applicability[type.toLowerCase()]) return null;
                              return (
                                <Pill key={type} tone={filingTone(status)} title={`${type}: ${FILING_LABELS[status] || status}`}>
                                  {type} {FILING_LABELS[status] || status}
                                </Pill>
                              );
                            })}
                            <button
                              type="button"
                              className="ml-1 rounded-md p-1 text-st-on-variant hover:bg-st-low"
                              title={`Download the ${row.monthLabel} compliance summary`}
                              onClick={() => downloadReport('COMPLIANCE_SUMMARY', 'CSV', { month: row.month })}
                              disabled={Boolean(exporting)}
                            >
                              <Download aria-hidden="true" size={12} />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Panel>
            </div>

            {/* ── right rail ───────────────────────────────────────────── */}
            <Rail>
              <Panel
                title="Filing status & due dates"
                subtitle={`Statutory due dates for ${monthLabel(month)}.`}
                bodyClassName="px-4 pb-4"
              >
                {dueSorted.length === 0 ? (
                  <p className="text-[11px] leading-relaxed text-st-on-variant">
                    No filing window is loaded for this month yet.
                  </p>
                ) : (
                  <ol className="space-y-2">
                    {dueSorted.map((row) => (
                      <li key={`${row.month}-${row.type}`} className="flex gap-2">
                        <span
                          className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[11px] font-bold tabular-nums ${
                            row.status === 'FILED'
                              ? 'bg-st-secondary-container text-st-on-secondary-container'
                              : row.overdue
                                ? 'bg-st-error-container text-st-on-error-container'
                                : 'bg-st-low text-st-on-variant'
                          }`}
                        >
                          {row.dueDate ? String(row.dueDate).slice(8, 10) : '—'}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] font-semibold leading-tight text-st-on">
                            {row.typeLabel}
                          </p>
                          <p className="text-[10px] leading-snug text-st-on-variant">
                            {row.status === 'FILED'
                              ? `filed ${formatDate(row.filedAt)}`
                              : `${dueLabel(row)}${row.dueDate ? ` · ${formatDate(row.dueDate)}` : ''}`}
                          </p>
                          {row.note ? (
                            <p className="text-[9px] leading-snug text-st-on-variant/80">{row.note}</p>
                          ) : null}
                        </div>
                        <Pill
                          tone={row.status === 'FILED' ? 'good' : row.overdue ? 'bad' : row.dueSoon ? 'warn' : 'default'}
                        >
                          {row.status === 'FILED' ? 'filed' : row.overdue ? 'overdue' : row.dueSoon ? 'due soon' : 'open'}
                        </Pill>
                      </li>
                    ))}
                  </ol>
                )}
              </Panel>

              <Panel title="Filing readiness" bodyClassName="px-4 pb-4">
                <CheckRow
                  ok={generatedCount === calendarRows.length && calendarRows.length > 0}
                  label="Reports generated"
                  value={`${count(generatedCount)}/${count(calendarRows.length)}`}
                />
                <CheckRow
                  ok={filable.length > 0 && filedCount === filable.length}
                  label="Returns filed"
                  value={`${count(filedCount)}/${count(filable.length)}`}
                />
                <CheckRow
                  ok={overdueCount === 0}
                  label="Overdue returns"
                  value={count(overdueCount)}
                />
                <CheckRow
                  ok={(dashboard.paidCount || 0) > 0}
                  label="Employees paid in the month"
                  value={count(dashboard.paidCount)}
                />
                <CheckRow
                  ok={Boolean(summary.grossPayroll)}
                  label="Gross payroll in the snapshot"
                  value={money(summary.grossPayroll)}
                />
                <p className="pt-2 text-[10px] leading-snug text-st-on-variant">
                  Crewly records a filing after it happens on the government portal. Nothing here is
                  auto-filed, and a tick only means the attestation has been entered.
                </p>
              </Panel>

              <Panel title="Open a working" bodyClassName="px-4 pb-4">
                <p className="pb-2 text-[10px] leading-snug text-st-on-variant">
                  Each tab carries the employee-wise lines the return needs, plus export.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {REPORT_TABS.filter(
                    ({ key }) =>
                      !['OVERVIEW', 'ANNUAL', 'CALENDAR'].includes(key) &&
                      !(key === 'LWF' && !applicability.lwf) &&
                      !(key === 'GRATUITY' && !applicability.gratuity),
                  ).map(({ key, label }) => (
                    <StageButton key={key} variant="quiet" onClick={() => setTab(key)}>
                      {label}
                    </StageButton>
                  ))}
                </div>
              </Panel>
            </Rail>
          </div>

          <p className="rounded-xl bg-st-low/50 px-3 py-2 text-[10px] leading-snug text-st-on-variant">
            Liabilities are frozen when the payroll is paid. Filing status is a human record of what was
            submitted on EPFO / ESIC / the state PT portal / TRACES — no return is claimed as filed by
            Crewly itself.
          </p>
            </>
          ) : null}

          {!['OVERVIEW', 'ANNUAL', 'CALENDAR'].includes(tab) && report && !tabLoading ? (
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
          ) : null}

          {tab === 'ANNUAL' && annual && !tabLoading ? (
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
          ) : null}

          {tab === 'CALENDAR' && !tabLoading ? (
            <CalendarTab calendar={calendar} busy={busy} onToggle={toggleTask} />
          ) : null}
        </>
      )}
    </div>
  );
};

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
          <div className="rounded-lg border border-crewly-hairline p-3">
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
          <EmptyState
            illustration="calendar"
            title="No compliance deadlines to show"
            description="Deadlines appear once the month's PF, ESI and TDS reports are generated. Generate them above and the filing calendar fills in."
            size="sm"
          />
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
          <TableEmpty
            colSpan={headers.length}
            illustration="documents"
            title="Nothing to show for this period"
            description="No challan or filing data exists for this month and section. Pick another period above."
          />
        )}
        {(rows || []).map((row, rowIndex) => (
          <tr key={rowIndex} className="border-t border-crewly-hairline">
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
