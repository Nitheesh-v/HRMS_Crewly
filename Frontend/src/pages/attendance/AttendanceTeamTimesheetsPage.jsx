import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarCheck2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Gauge,
  Lock,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Users,
} from 'lucide-react';
import attendanceService from '../../services/attendanceService.js';
import departmentService from '../../services/departmentService.js';
import TimesheetMonthView from '../../components/attendance/TimesheetMonthView.jsx';
import AttendanceFinalizationPanel from '../../components/attendance/AttendanceFinalizationPanel.jsx';
import usePermission from '../../hooks/usePermission.js';
import { TableEmpty } from '../../components/common/EmptyState.jsx';

// Phase 31.10 — Team Timesheets: the scoped monthly summary matrix
// for managers, team leads and HR, with per-employee drill-down and
// the scoped CSV export. READ-ONLY: org scope derives backend-side;
// rows show counts and time facts only — no reasons, no money.
//
// Redesign (2026-10): the matrix is styled as the audit table it is
// — sticky header, tabular numerals, per-row exception chip — and
// the four footer figures are computed from the rows actually on
// screen. When the page is one slice of a larger scope the footer
// says so instead of pretending to speak for the whole company.

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const PAGE_SIZES = [10, 25, 50];

const currentMonth = () => new Date().toISOString().slice(0, 7);

const shiftMonth = (month, delta) => {
  const [year, mon] = month.split('-').map(Number);
  const next = new Date(Date.UTC(year, mon - 1 + delta, 1));
  return next.toISOString().slice(0, 7);
};

const monthLabel = (month) => {
  const [year, mon] = (month || '').split('-').map(Number);
  if (!year || !mon) return month;
  return `${MONTH_NAMES[mon - 1]} ${year}`;
};

const fmtSpan = (totalMinutes) => {
  const minutes = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) return `${rest}m`;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
};

const initialsOf = (name = '') => name
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0]?.toUpperCase() || '')
  .join('') || '—';

const STATUS_STYLE = {
  OPEN: 'bg-st-high text-st-on-variant',
  FINALIZING: 'bg-st-primary-fixed text-st-on-primary-fixed-variant',
  FINALIZED: 'bg-st-secondary-container text-st-on-secondary-container',
  SENT_TO_PAYROLL: 'bg-st-tertiary-fixed text-st-on-tertiary-fixed',
  REOPENED: 'bg-st-error-container text-st-on-error-container',
};

const STATUS_LABEL = {
  OPEN: 'Period open',
  FINALIZING: 'Finalizing',
  FINALIZED: 'Finalized',
  SENT_TO_PAYROLL: 'Sent to payroll',
  REOPENED: 'Reopened',
};

const StatTile = ({ icon: Icon, label, value, unit, hint, bar }) => (
  <div className="rounded-xl bg-st-lowest p-4 shadow-sm">
    <div className="flex items-start justify-between gap-2">
      <span className="text-[10px] font-bold uppercase tracking-wider text-st-on-variant">{label}</span>
      <span className="rounded-lg bg-st-low p-1">
        <Icon className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" />
      </span>
    </div>
    <div className="mt-1 flex items-baseline gap-1">
      <span className="text-2xl font-bold text-st-on">{value}</span>
      {unit ? <span className="text-[11px] font-semibold text-st-on-variant">{unit}</span> : null}
    </div>
    <p className="mt-1 text-[10px] leading-snug text-st-on-variant">{hint}</p>
    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-st-high">
      <div className={`h-full rounded-full ${bar}`} style={{ width: '68%' }} />
    </div>
  </div>
);

const AttendanceTeamTimesheetsPage = () => {
  const [month, setMonth] = useState(currentMonth());
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [hasExceptions, setHasExceptions] = useState(false);
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [table, setTable] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [tab, setTab] = useState('timesheets');
  const [period, setPeriod] = useState(null);
  const [periodError, setPeriodError] = useState('');
  const { hasPermission } = usePermission();
  const canSeeFinalization = hasPermission('ATTENDANCE_FINALIZATION_READ');

  const load = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const [nextTable, nextPeriod] = await Promise.all([
        attendanceService.teamTimesheets({
          month,
          search: search.trim(),
          departmentId,
          hasExceptions,
          page,
          pageSize,
        }),
        // Period status drives the "can this month be locked" strip below.
        // Read-only here; the mutations stay behind their own permissions on
        // the finalization tab.
        canSeeFinalization
          ? attendanceService.finalizationStatus(month).catch((err) => {
            setPeriodError(err?.response?.data?.message || err?.message || 'Period status unavailable');
            return null;
          })
          : Promise.resolve(null),
      ]);
      setTable(nextTable);
      if (canSeeFinalization) {
        setPeriod(nextPeriod);
        if (nextPeriod) setPeriodError('');
      }
    } catch (err) {
      if (!silent) setTable(null);
      setError(err?.response?.data?.message || err.message || 'Failed to load team timesheets');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [month, search, departmentId, hasExceptions, page, pageSize, canSeeFinalization]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    departmentService.getAll().then(setDepartments).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
    }, 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
    setSelectedId(null);
    setDetail(null);
  }, [month, search, departmentId, hasExceptions, pageSize]);

  const openDetail = async (userId) => {
    if (selectedId === userId && detail) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
    setSelectedId(userId);
    setDetail(null);
    setDetailLoading(true);
    setDetailError('');
    try {
      setDetail(await attendanceService.employeeTimesheet(userId, month));
    } catch (err) {
      setDetailError(err?.response?.data?.message || err.message || 'Failed to load employee month');
    } finally {
      setDetailLoading(false);
    }
  };

  const runExport = async () => {
    setExporting(true);
    try {
      await attendanceService.downloadTeamTimesheets({
        month,
        search: search.trim(),
        departmentId,
        hasExceptions,
      });
    } catch (err) {
      setError(err?.response?.data?.message || err.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const rows = useMemo(() => table?.rows || [], [table]);
  const total = table?.total || 0;
  const wholeScope = Boolean(table) && rows.length === total;

  const totals = useMemo(() => {
    const sum = rows.reduce((acc, row) => {
      const s = row.summary || {};
      acc.scheduled += s.scheduledWorkingDays || 0;
      acc.present += s.present || 0;
      acc.halfDay += s.halfDay || 0;
      acc.leave += s.leave || 0;
      acc.absent += s.absent || 0;
      acc.late += s.lateDays || 0;
      acc.workedMinutes += s.workedMinutes || 0;
      acc.otMinutes += s.approvedOtMinutes || 0;
      acc.exceptionDays += s.exceptionDays || 0;
      acc.unresolvedDays += s.unresolvedDays || 0;
      if ((s.exceptionDays || 0) > 0) acc.flaggedPeople += 1;
      return acc;
    }, {
      scheduled: 0, present: 0, halfDay: 0, leave: 0, absent: 0, late: 0,
      workedMinutes: 0, otMinutes: 0, exceptionDays: 0, unresolvedDays: 0, flaggedPeople: 0,
    });
    const presence = sum.scheduled > 0
      ? Math.round(((sum.present + sum.halfDay * 0.5) / sum.scheduled) * 1000) / 10
      : null;
    const avgDaily = sum.scheduled > 0 ? sum.workedMinutes / sum.scheduled : null;
    return { ...sum, presence, avgDaily };
  }, [rows]);

  const periodStatus = period?.status || null;
  const versions = period?.versions || [];
  const lastFinalized = versions.length ? versions[versions.length - 1] : null;

  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-5">
        {/* ── hero ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
                Time &amp; Leave · Team Timesheets
              </span>
              <span className="rounded-full bg-st-secondary-container px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-st-on-secondary-container">
                Audit cycle · {monthLabel(month)}
              </span>
              {periodStatus ? (
                <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${STATUS_STYLE[periodStatus] || STATUS_STYLE.OPEN}`}>
                  {STATUS_LABEL[periodStatus] || periodStatus}
                </span>
              ) : null}
            </div>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-st-on lg:text-[2rem]">Team Timesheets</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-st-on-variant">
              Monthly attendance summaries for {table?.scope === 'COMPANY' ? 'the whole company' : 'your reporting line'}.
              Inspect individual anomalies, audit quota compliance and lock a finalized period — all read-only
              until HR finalizes.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg bg-st-lowest p-1 shadow-sm">
              <button
                type="button"
                onClick={() => setMonth((value) => shiftMonth(value, -1))}
                className="rounded p-1.5 text-st-on-variant transition hover:bg-st-low hover:text-st-on"
                aria-label="Previous month"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-[8.5rem] text-center text-xs font-bold text-st-on">{monthLabel(month)}</span>
              <button
                type="button"
                onClick={() => setMonth((value) => shiftMonth(value, 1))}
                className="rounded p-1.5 text-st-on-variant transition hover:bg-st-low hover:text-st-on"
                aria-label="Next month"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={runExport}
              disabled={exporting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-st-lowest px-3 py-2 text-[11px] font-bold text-st-on shadow-sm transition hover:bg-st-low disabled:opacity-50"
              title="Download the filtered scope as CSV"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" /> {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
            {canSeeFinalization ? (
              <button
                type="button"
                onClick={() => setTab('finalization')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary shadow-sm transition hover:opacity-95"
              >
                <Lock className="h-3.5 w-3.5" aria-hidden="true" /> Lock &amp; finalize period
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => load({ silent: true })}
              disabled={refreshing}
              className="rounded-lg bg-st-lowest p-2 text-st-on-variant shadow-sm transition hover:text-st-on disabled:opacity-50"
              aria-label="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </section>

        {error ? (
          <div className="flex items-center gap-3 rounded-lg bg-st-error-container px-4 py-2.5 text-xs font-medium text-st-on-error-container">
            {error}
            <button type="button" onClick={() => load()} className="rounded bg-st-lowest px-2 py-1 text-[11px] font-bold text-st-on">
              Retry
            </button>
          </div>
        ) : null}

        {/* ── tabs + attention guard ───────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg bg-st-low p-1">
              {[
                ['timesheets', 'Monthly timesheet matrix', FileSpreadsheet],
                ...(canSeeFinalization ? [['finalization', 'Month finalization & payroll lock', Lock]] : []),
              ].map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTab(value)}
                  aria-pressed={tab === value}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-bold transition ${
                    tab === value
                      ? 'bg-st-primary-container text-st-on-primary-container shadow-sm'
                      : 'text-st-on-variant hover:text-st-on'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {label}
                </button>
              ))}
            </div>
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-st-on-variant">
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              {table ? `${rows.length} of ${total} employee${total === 1 ? '' : 's'} in this view` : 'Loading scope…'}
            </span>
          </div>

          <section className={`rounded-xl p-4 shadow-sm ${totals.flaggedPeople ? 'bg-st-primary-fixed/50' : 'bg-st-lowest'}`}>
            <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
              <ShieldCheck className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" />
              Attention guard
              <span className={`ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                totals.flaggedPeople ? 'bg-st-error-container text-st-on-error-container' : 'bg-st-secondary-container text-st-on-secondary-container'
              }`}>
                {totals.flaggedPeople ? 'Active' : 'Clear'}
              </span>
            </h2>
            <p className="mt-1 text-lg font-bold text-st-on">
              {totals.flaggedPeople
                ? `${totals.flaggedPeople} exception item${totals.flaggedPeople === 1 ? '' : 's'} flagged`
                : 'No exceptions on this page'}
            </p>
            <ul className="mt-1 space-y-0.5 text-[10px] leading-relaxed text-st-on-variant">
              <li>{totals.exceptionDays} exception day{totals.exceptionDays === 1 ? '' : 's'} across the rows shown</li>
              <li>{totals.unresolvedDays} unresolved day{totals.unresolvedDays === 1 ? '' : 's'} · {totals.late} late day{totals.late === 1 ? '' : 's'}</li>
              <li>Corrections are requested on the Regularizations page, not edited here.</li>
            </ul>
            <button
              type="button"
              onClick={() => setHasExceptions((value) => !value)}
              aria-pressed={hasExceptions}
              className={`mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10px] font-bold transition ${
                hasExceptions ? 'bg-st-primary text-st-on-primary' : 'bg-st-lowest text-st-on hover:bg-st-low'
              }`}
            >
              <TriangleAlert className="h-3 w-3" aria-hidden="true" />
              {hasExceptions ? 'Show everyone again' : 'Isolate rows needing attention'}
            </button>
          </section>
        </div>

        {tab === 'finalization' && canSeeFinalization ? (
          <AttendanceFinalizationPanel month={month} />
        ) : (
          <>
            {/* ── filters ──────────────────────────────────────────────── */}
            <section className="rounded-xl bg-st-lowest p-3 shadow-sm">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                <label className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-st-outline" aria-hidden="true" />
                  <input
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    maxLength={60}
                    placeholder="Search employee name, code or role…"
                    className="w-full rounded-lg bg-st-low py-2 pl-9 pr-3 text-xs text-st-on placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                    aria-label="Search employees"
                  />
                </label>
                <select
                  value={departmentId}
                  onChange={(event) => setDepartmentId(event.target.value)}
                  className="rounded-lg bg-st-low px-3 py-2 text-xs font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  aria-label="Department"
                >
                  <option value="">All departments ({departments.length})</option>
                  {(departments || []).map((dept) => (
                    <option key={dept._id || dept.id} value={dept._id || dept.id}>{dept.name}</option>
                  ))}
                </select>
                <select
                  value={pageSize}
                  onChange={(event) => setPageSize(Number(event.target.value))}
                  className="rounded-lg bg-st-low px-3 py-2 text-xs font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  aria-label="Rows per page"
                >
                  {PAGE_SIZES.map((size) => <option key={size} value={size}>{size} per page</option>)}
                </select>
                {(search || departmentId || hasExceptions) ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchInput('');
                      setSearch('');
                      setDepartmentId('');
                      setHasExceptions(false);
                    }}
                    className="rounded-lg bg-st-low px-3 py-2 text-[11px] font-bold text-st-on-variant transition hover:text-st-on"
                  >
                    Clear filters
                  </button>
                ) : null}
              </div>
            </section>

            {/* ── the matrix ───────────────────────────────────────────── */}
            <section className="overflow-hidden rounded-xl bg-st-lowest shadow-sm">
              <div className="flex flex-wrap items-center gap-2 border-b border-st-high/60 px-4 py-2.5">
                <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
                  <CalendarCheck2 className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" />
                  {monthLabel(month)} monthly matrix
                </h2>
                <span className="text-[10px] font-semibold text-st-on-variant">
                  {table ? `${rows.length} of ${total} employees` : ''}
                  {loading ? ' · loading…' : ''}
                </span>
                <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-semibold text-st-on-variant">
                  <Gauge className="h-3 w-3" aria-hidden="true" />
                  {totals.presence === null ? 'No scheduled days' : `${totals.presence}% presence across these rows`}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[62rem] text-left">
                  <thead>
                    <tr className="bg-st-container text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                      <th className="py-2 pl-4 pr-3 font-bold">Employee &amp; role</th>
                      <th className="px-2 py-2 text-right font-bold">Scheduled</th>
                      <th className="px-2 py-2 text-right font-bold">Present</th>
                      <th className="px-2 py-2 text-right font-bold">Half day</th>
                      <th className="px-2 py-2 text-right font-bold">Leave</th>
                      <th className="px-2 py-2 text-right font-bold">Absent</th>
                      <th className="px-2 py-2 text-right font-bold">Late</th>
                      <th className="px-2 py-2 text-right font-bold">Worked</th>
                      <th className="px-2 py-2 text-right font-bold">Approved OT</th>
                      <th className="px-2 py-2 pr-4 font-bold">Attention</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const summary = row.summary || {};
                      const flagged = (summary.exceptionDays || 0) > 0;
                      return (
                        <tr
                          key={row.user.id}
                          onClick={() => openDetail(row.user.id)}
                          className={`cursor-pointer border-b border-st-high/50 transition hover:bg-st-low ${
                            selectedId === row.user.id ? 'bg-st-container' : ''
                          }`}
                        >
                          <td className="py-2.5 pl-4 pr-3">
                            <div className="flex items-center gap-2">
                              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-st-secondary-container text-[9px] font-bold text-st-on-secondary-container">
                                {initialsOf(row.user.name)}
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate text-xs font-bold text-st-on">{row.user.name}</span>
                                <span className="block truncate text-[10px] text-st-on-variant">
                                  {[row.user.employeeCode, row.user.designation, row.user.department?.name].filter(Boolean).join(' · ')}
                                </span>
                              </span>
                            </div>
                          </td>
                          <td className="px-2 py-2.5 text-right text-[11px] text-st-on-variant tabular-nums">{summary.scheduledWorkingDays ?? 0}</td>
                          <td className="px-2 py-2.5 text-right text-[11px] tabular-nums">
                            <span className="rounded bg-st-secondary-container px-1.5 py-0.5 font-bold text-st-on-secondary-container">{summary.present ?? 0}</span>
                          </td>
                          <td className="px-2 py-2.5 text-right text-[11px] tabular-nums">
                            {summary.halfDay ? (
                              <span className="rounded bg-st-primary-fixed px-1.5 py-0.5 font-bold text-st-on-primary-fixed-variant">{summary.halfDay}</span>
                            ) : <span className="text-st-on-variant">0</span>}
                          </td>
                          <td className="px-2 py-2.5 text-right text-[11px] tabular-nums">
                            {summary.leave ? (
                              <span className="rounded bg-st-tertiary-fixed px-1.5 py-0.5 font-bold text-st-on-tertiary-fixed">{summary.leave}</span>
                            ) : <span className="text-st-on-variant">0</span>}
                          </td>
                          <td className="px-2 py-2.5 text-right text-[11px] tabular-nums">
                            {summary.absent ? (
                              <span className="rounded bg-st-error-container px-1.5 py-0.5 font-bold text-st-on-error-container">{summary.absent}</span>
                            ) : <span className="text-st-on-variant">0</span>}
                          </td>
                          <td className="px-2 py-2.5 text-right text-[11px] tabular-nums">
                            {summary.lateDays ? (
                              <span className="rounded bg-st-primary-fixed-dim/50 px-1.5 py-0.5 font-bold text-st-on-primary-fixed-variant">{summary.lateDays}</span>
                            ) : <span className="text-st-on-variant">0</span>}
                          </td>
                          <td className="px-2 py-2.5 text-right text-[11px] font-semibold text-st-on tabular-nums">{fmtSpan(summary.workedMinutes)}</td>
                          <td className="px-2 py-2.5 text-right text-[11px] tabular-nums">
                            {summary.approvedOtMinutes ? (
                              <span className="font-bold text-st-primary">+{fmtSpan(summary.approvedOtMinutes)}</span>
                            ) : <span className="text-st-on-variant">0h 00m</span>}
                          </td>
                          <td className="py-2.5 pr-4">
                            {flagged ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-st-error-container px-2 py-0.5 text-[9px] font-bold text-st-on-error-container">
                                <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
                                {summary.exceptionDays} day{summary.exceptionDays === 1 ? '' : 's'}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-st-secondary-container px-2 py-0.5 text-[9px] font-bold text-st-on-secondary-container">
                                <CheckCircle2 className="h-2.5 w-2.5" aria-hidden="true" /> Clean
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {!loading && rows.length === 0 ? (
                      <TableEmpty
                        colSpan={10}
                        illustration="calendar"
                        title="Nobody in scope matches these filters"
                        description="Widen the month or clear the department filter — timesheets appear once people have logged work in the period."
                      />
                    ) : null}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-st-high/60 px-4 py-2.5 text-[10px] text-st-on-variant">
                <span>
                  Page <strong className="font-bold text-st-on">{table?.page ?? 1}</strong> of {table?.totalPages ?? 1}
                  {' · '}showing {rows.length} of {total} in scope
                </span>
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    className="rounded bg-st-low p-1.5 text-st-on-variant transition hover:text-st-on disabled:opacity-40"
                    disabled={!table || table.page <= 1}
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="rounded bg-st-low p-1.5 text-st-on-variant transition hover:text-st-on disabled:opacity-40"
                    disabled={!table || table.page >= table.totalPages}
                    onClick={() => setPage((value) => value + 1)}
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
            </section>

            {/* ── footer figures ───────────────────────────────────────── */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile
                icon={CalendarCheck2}
                label="Scheduled man-days"
                value={totals.scheduled.toLocaleString('en-IN')}
                unit="days"
                hint={`${rows.length} employee${rows.length === 1 ? '' : 's'} in this page`}
                bar="bg-st-secondary"
              />
              <StatTile
                icon={Users}
                label="Cumulative hours"
                value={(Math.round((totals.workedMinutes / 60) * 10) / 10).toLocaleString('en-IN')}
                unit="h"
                hint={totals.otMinutes ? `+${fmtSpan(totals.otMinutes)} approved overtime` : 'no approved overtime in these rows'}
                bar="bg-st-primary-container"
              />
              <StatTile
                icon={Gauge}
                label="Avg daily presence"
                value={totals.avgDaily === null ? '—' : `${(Math.round((totals.avgDaily / 60) * 10) / 10).toFixed(1)}h`}
                hint="Worked minutes ÷ scheduled days, these rows only"
                bar="bg-st-tertiary-container"
              />
              <StatTile
                icon={ShieldCheck}
                label="Presence rating"
                value={totals.presence === null ? '—' : `${totals.presence}%`}
                hint={totals.presence === null ? 'no scheduled days to divide by' : `${totals.present} present · ${totals.halfDay} half · ${totals.absent} absent`}
                bar="bg-st-secondary-fixed-dim"
              />
            </div>
            <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-st-on-variant">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              {wholeScope
                ? 'These four figures cover the full filtered scope — every employee the API returned.'
                : `These four figures cover the ${rows.length} rows on this page, not all ${total} in scope. Export the CSV for the full month.`}
            </p>

            {/* ── period strip ─────────────────────────────────────────── */}
            <section className="flex flex-col gap-3 rounded-xl bg-st-low px-4 py-3 shadow-sm lg:flex-row lg:items-center">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-st-primary-container text-st-on-primary-container">
                <Lock className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-st-on">
                  {periodStatus
                    ? `${monthLabel(month)} is ${(STATUS_LABEL[periodStatus] || periodStatus).toLowerCase()}${lastFinalized ? ` · snapshot v${lastFinalized.version}` : ''}`
                    : periodError
                      ? 'Period status unavailable for your role'
                      : 'Reading the period status…'}
                </p>
                <p className="text-[10px] leading-snug text-st-on-variant">
                  {lastFinalized?.finalizedAt
                    ? `Last finalized ${new Date(lastFinalized.finalizedAt).toLocaleString('en-IN')}${lastFinalized.summary?.employees ? ` for ${lastFinalized.summary.employees} employees` : ''}. `
                    : ''}
                  Finalizing freezes the month's derived facts; reopenings keep their reason on the audit trail.
                  {periodError ? ` ${periodError}` : ''}
                </p>
              </div>
              {canSeeFinalization ? (
                <button
                  type="button"
                  onClick={() => setTab('finalization')}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary transition hover:opacity-95"
                >
                  Open finalization <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : (
                <span className="shrink-0 rounded-full bg-st-high px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                  HR-only action
                </span>
              )}
            </section>
          </>
        )}

        {selectedId ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-st-on">
                {detail?.employee?.name || rows.find((row) => row.user.id === selectedId)?.user?.name || 'Employee month'}
              </h2>
              <button
                type="button"
                onClick={() => { setSelectedId(null); setDetail(null); }}
                className="rounded-lg bg-st-low px-3 py-1.5 text-[11px] font-bold text-st-on-variant transition hover:text-st-on"
              >
                Close month
              </button>
            </div>
            {detailLoading ? <div className="rounded-xl bg-st-lowest p-4 text-xs text-st-on-variant shadow-sm">Loading month…</div> : null}
            {detailError ? <div className="rounded-xl bg-st-error-container p-4 text-xs text-st-on-error-container">{detailError}</div> : null}
            {!detailLoading && !detailError && detail ? (
              <TimesheetMonthView sheet={detail} employeeName={detail?.employee?.name || ''} />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default AttendanceTeamTimesheetsPage;
