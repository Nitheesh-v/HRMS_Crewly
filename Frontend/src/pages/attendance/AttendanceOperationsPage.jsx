import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CalendarClock,
  CalendarOff,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  Gauge,
  MapPin,
  RefreshCw,
  ScanFace,
  Search,
  ShieldCheck,
  Timer,
  UserX,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import attendanceService from '../../services/attendanceService.js';
import departmentService from '../../services/departmentService.js';
import usePermission from '../../hooks/usePermission.js';
import Modal from '../../components/Modal.jsx';
import TimesheetMonthView from '../../components/attendance/TimesheetMonthView.jsx';
import { TableEmpty } from '../../components/common/EmptyState.jsx';

// Phase 31.12 — HR attendance operations command centre. READ-ONLY
// aggregation over the presence board: expected vs actual, the
// department / shift / campus matrix, the severity-ranked exception
// queue and the pending regularization + overtime workload. Every
// issue links to its owner workflow — nothing here mutates
// attendance, leave, OT or payroll. Time facts only: no reasons, no
// money, no scores.
//
// Redesign (2026-10): the queue is a triage rail of exception cards
// rather than a wide table, because HR reads one person at a time
// and needs the clock facts next to the verdict; the matrix keeps
// the tabular view because a manager scans a whole department at
// once. Both are fed by the same filtered response, so the numbers
// can never disagree.

const REFRESH_MS = 45000;

const WORKFLOWS = {
  attendance: { to: '/app/attendance/team', label: "Who's working" },
  regularizations: { to: '/app/attendance/regularizations', label: 'Review & fix' },
  leaves: { to: '/app/leaves', label: 'Open leaves' },
  overtime: { to: '/app/attendance/overtime', label: 'Open overtime' },
  schedules: { to: '/app/schedules', label: 'Open schedules' },
};

const CATEGORIES = [
  ['LATE_NOT_IN', 'Late — not in'],
  ['LATE_ARRIVAL', 'Late arrival'],
  ['MISSING_PUNCH', 'Missing punch'],
  ['UNRESOLVED_SESSION', 'Unresolved session'],
  ['INCOMPLETE_BREAK', 'Break left open'],
  ['EARLY_EXIT', 'Early exit'],
  ['SHORT_HOURS', 'Short hours'],
  ['RECON_CONFLICT', 'Attendance/leave conflict'],
  ['REG_PENDING', 'Regularization pending'],
  ['OT_PENDING', 'OT review pending'],
  ['WORKED_DAY_OFF', 'Worked day off'],
];

const SEVERITY = {
  BLOCKER: {
    chip: 'bg-st-error-container text-st-on-error-container',
    edge: 'bg-st-error',
    label: 'Blocker',
  },
  WARNING: {
    chip: 'bg-st-primary-fixed text-st-on-primary-fixed-variant',
    edge: 'bg-st-primary-container',
    label: 'Warning',
  },
  INFO: {
    chip: 'bg-st-high text-st-on-variant',
    edge: 'bg-st-outline',
    label: 'Notice',
  },
};

const PRESENCE = {
  WORKING: { label: 'Working', chip: 'bg-st-secondary-container text-st-on-secondary-container' },
  ON_BREAK: { label: 'On break', chip: 'bg-st-primary-fixed text-st-on-primary-fixed-variant' },
  COMPLETED: { label: 'Completed', chip: 'bg-st-tertiary-fixed text-st-on-tertiary-fixed' },
  NOT_IN: { label: 'Not in', chip: 'bg-st-high text-st-on-variant' },
  LATE_NOT_IN: { label: 'Late · not in', chip: 'bg-st-error-container text-st-on-error-container' },
  ON_LEAVE: { label: 'On leave', chip: 'bg-st-tertiary-fixed text-st-on-tertiary-fixed' },
  HOLIDAY: { label: 'Holiday', chip: 'bg-st-primary-fixed-dim/40 text-st-on-primary-fixed-variant' },
  WEEKLY_OFF: { label: 'Weekly off', chip: 'bg-st-high text-st-on-variant' },
  UNRESOLVED: { label: 'Unresolved', chip: 'bg-st-error-container text-st-on-error-container' },
};

const MODE_LABEL = {
  OFFICE: 'Office',
  WFH: 'WFH',
  FIELD: 'Field',
  CLIENT_SITE: 'Client site',
  BUSINESS_TRAVEL: 'Travel',
  NONE: 'No mode',
};

const MODE_CHIPS = [
  ['OFFICE', 'Office'],
  ['WFH', 'WFH'],
  ['FIELD', 'Field'],
  ['CLIENT_SITE', 'Client site'],
];

const fmtTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
};

const fmtDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-IN');
};

const fmtDay = (date) => {
  if (!date) return '';
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
};

const agoText = (from) => {
  if (!from) return 'not synced yet';
  const minutes = Math.max(0, Math.round((Date.now() - from.getTime()) / 60000));
  if (minutes < 1) return 'just now';
  return `${minutes}m ago`;
};

const initialsOf = (name = '') => name
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0]?.toUpperCase() || '')
  .join('') || '—';

const prevDay = (day) => {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
};

const AttentionCard = ({ item, active, onOpen }) => {
  const tone = SEVERITY[item.severity] || SEVERITY.INFO;
  const presence = PRESENCE[item.presence] || { label: item.presence || '—', chip: 'bg-st-high text-st-on-variant' };
  const workflow = WORKFLOWS[item.workflow];
  return (
    <li className={`relative overflow-hidden rounded-xl border p-3 transition ${active ? 'border-st-secondary bg-st-container' : 'border-st-high/70 bg-st-lowest hover:border-st-secondary/50 hover:bg-st-low'}`}>
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-0.5 ${tone.edge}`} />
      <div className="flex items-start gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-st-secondary-container text-[10px] font-bold text-st-on-secondary-container">
          {initialsOf(item.employee.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            <span className="truncate text-xs font-bold text-st-on">{item.employee.name}</span>
            {item.employee.employeeCode ? (
              <span className="rounded bg-st-low px-1 py-0.5 font-mono text-[9px] font-semibold text-st-on-variant">
                {item.employee.employeeCode}
              </span>
            ) : null}
            <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider ${tone.chip}`}>
              {tone.label}
            </span>
          </div>
          <p className="truncate text-[10px] text-st-on-variant">
            {[item.employee.designation, item.employee.department?.name, item.shiftName].filter(Boolean).join(' · ') || '—'}
          </p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${presence.chip}`}>{presence.label}</span>
        {item.workMode ? (
          <span className="rounded-full bg-st-low px-1.5 py-0.5 text-[9px] font-semibold text-st-on-variant">
            {MODE_LABEL[item.workMode] || item.workMode}
          </span>
        ) : null}
        {item.locationName ? (
          <span className="inline-flex items-center gap-0.5 rounded-full bg-st-low px-1.5 py-0.5 text-[9px] font-semibold text-st-on-variant">
            <MapPin className="h-2.5 w-2.5" aria-hidden="true" /> {item.locationName}
          </span>
        ) : null}
      </div>

      <div className="mt-2 rounded-lg bg-st-low px-2.5 py-1.5">
        <p className="text-[10px] font-bold text-st-on">{item.label}</p>
        <p className="text-[9px] leading-snug text-st-on-variant">
          {item.since ? `Since ${fmtTime(item.since)}` : 'Since —'}
          {Number.isFinite(item.minutes) && item.minutes > 0 ? ` · ${item.minutes} minutes` : ''}
          {item.clockInAt ? ` · in ${fmtTime(item.clockInAt)}` : ''}
          {item.clockOutAt ? ` · out ${fmtTime(item.clockOutAt)}` : ''}
        </p>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onOpen(item)}
          className="inline-flex items-center gap-1 rounded-lg bg-st-primary px-2 py-1 text-[9px] font-bold text-st-on-primary transition hover:opacity-95"
        >
          Open month <ArrowRight className="h-2.5 w-2.5" aria-hidden="true" />
        </button>
        {workflow ? (
          <Link
            to={workflow.to}
            className="inline-flex items-center gap-1 rounded-lg bg-st-low px-2 py-1 text-[9px] font-bold text-st-on transition hover:bg-st-container"
          >
            {workflow.label}
          </Link>
        ) : null}
      </div>
    </li>
  );
};

const AttentionDot = ({ tone }) => (
  <span aria-hidden="true" className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />
);

const KpiTile = ({ icon: Icon, label, value, unit, hint, tone, bar, share }) => (
  <div className="rounded-xl bg-st-lowest p-4 shadow-sm">
    <div className="flex items-start justify-between gap-2">
      <span className="text-[10px] font-bold uppercase tracking-wider text-st-on-variant">{label}</span>
      <span className={`rounded-lg p-1 ${tone}`}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </div>
    <div className="mt-1 flex items-baseline gap-1">
      <span className="text-2xl font-bold text-st-on tabular-nums">{value}</span>
      {unit ? <span className="text-[10px] font-bold uppercase tracking-wider text-st-on-variant">{unit}</span> : null}
    </div>
    <p className="mt-0.5 truncate text-[10px] leading-snug text-st-on-variant" title={hint}>{hint}</p>
    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-st-high">
      <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.max(0, Math.min(100, share || 0))}%` }} />
    </div>
  </div>
);

const AttendanceOperationsPage = () => {
  const { hasPermission, loading: permissionsLoading } = usePermission();
  const canView = hasPermission('ATTENDANCE_OPERATIONS_READ');

  const [dateOverride, setDateOverride] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [shift, setShift] = useState('');
  const [location, setLocation] = useState('');
  const [presence, setPresence] = useState('');
  const [workMode, setWorkMode] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [groupTab, setGroupTab] = useState('departments');

  const [dash, setDash] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const load = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    else {
      setLoading(true);
      setError('');
    }
    try {
      const next = await attendanceService.operations({
        date: dateOverride,
        search: search.trim(),
        departmentId,
        shift: shift.trim(),
        location,
        presence,
        workMode,
        category,
        page,
        pageSize: 25,
      });
      setDash(next);
      setLastRefreshed(new Date());
    } catch (err) {
      if (!silent) {
        setDash(null);
        setError(err?.response?.data?.message || err.message || 'Failed to load operations');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [dateOverride, search, departmentId, shift, location, presence, workMode, category, page]);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  // Bounded live refresh: 45s while the tab is visible, on refocus and
  // on request. A hidden tab never polls.
  useEffect(() => {
    if (!canView) return undefined;
    const tick = () => {
      if (!document.hidden) load({ silent: true });
    };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, [canView, load]);

  useEffect(() => {
    departmentService.getAll().then(setDepartments).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [dateOverride, search, departmentId, shift, location, presence, workMode, category]);

  const openDetail = async (item) => {
    setSelected(item);
    setDetail(null);
    setDetailLoading(true);
    setDetailError('');
    try {
      setDetail(await attendanceService.employeeTimesheet(item.employee.id, (dash?.date || '').slice(0, 7)));
    } catch (err) {
      setDetailError(err?.response?.data?.message || err.message || 'Failed to load employee month');
    } finally {
      setDetailLoading(false);
    }
  };

  const summary = dash?.summary || {};
  const modes = dash?.modes || {};
  const counts = dash?.attentionCounts || {};
  const attention = dash?.attention || { items: [], page: 1, totalPages: 1, total: 0 };
  const workflows = dash?.workflows || {};
  const expected = summary.expected || 0;
  const notYetIn = (summary.notIn || 0) + (summary.lateNotIn || 0);
  const shareOf = (value) => (expected ? Math.round(((value || 0) / expected) * 100) : 0);
  const viewingYesterday = Boolean(dateOverride);

  const groupRows = useMemo(() => (
    groupTab === 'locations' ? (dash?.locations || []) : (dash?.[groupTab] || [])
  ), [dash, groupTab]);

  const activeFilterCount = [
    searchInput, departmentId, shift, location, presence, workMode, category,
  ].filter(Boolean).length;

  const clearFilters = () => {
    setSearchInput('');
    setSearch('');
    setDepartmentId('');
    setShift('');
    setLocation('');
    setPresence('');
    setWorkMode('');
    setCategory('');
  };

  if (permissionsLoading || (loading && !dash)) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 text-sm text-st-on-variant shadow-sm">Loading the operations centre…</div>
      </div>
    );
  }

  if (!canView) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 shadow-sm">
          <h1 className="text-xl font-bold text-st-on">Attendance Operations</h1>
          <p className="mt-2 text-sm text-st-on-variant">
            This command centre is available to HR administrators only.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-5">
        {/* ── hero ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
              Time &amp; Leave · Attendance Operations
            </span>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-st-on lg:text-[2rem]">
              Attendance operations centre
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-st-on-variant">
              <span className="inline-flex items-center gap-1 rounded-full bg-st-secondary-container px-2 py-0.5 font-bold text-st-on-secondary-container">
                <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${refreshing ? 'bg-st-primary-container' : 'animate-pulse bg-st-on-secondary-container'}`} />
                {dash?.date ? fmtDay(dash.date) : '—'}
              </span>
              <span>{dash?.scope?.type === 'COMPANY' ? 'Whole company' : 'Your reporting line'}</span>
              <span>· {dash?.scope?.total ?? '—'} staff in scope</span>
              <span>·</span>
              <button
                type="button"
                onClick={() => load({ silent: true })}
                className="font-semibold underline-offset-2 hover:underline"
                title={`Last read ${fmtDateTime(lastRefreshed ? lastRefreshed.toISOString() : dash?.refreshedAt)}`}
              >
                live stream synced {agoText(lastRefreshed)}
              </button>
            </div>
          </div>

          <div className="flex flex-col items-stretch gap-2">
            <div className="flex items-center gap-1.5">
              <div className="inline-flex rounded-lg bg-st-low p-1">
                <button
                  type="button"
                  onClick={() => setDateOverride('')}
                  aria-pressed={!viewingYesterday}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition ${
                    !viewingYesterday ? 'bg-st-primary-container text-st-on-primary-container shadow-sm' : 'text-st-on-variant hover:text-st-on'
                  }`}
                >
                  Today
                </button>
                <button
                  type="button"
                  onClick={() => dash?.date && setDateOverride(prevDay(dash.date))}
                  disabled={!dash?.date}
                  aria-pressed={viewingYesterday}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition disabled:opacity-40 ${
                    viewingYesterday ? 'bg-st-primary-container text-st-on-primary-container shadow-sm' : 'text-st-on-variant hover:text-st-on'
                  }`}
                  title="Review the previous business day"
                >
                  Yesterday
                </button>
              </div>
              <button
                type="button"
                onClick={() => load({ silent: true })}
                disabled={refreshing}
                className="rounded-lg bg-st-lowest p-2 text-st-on-variant shadow-sm transition hover:text-st-on disabled:opacity-50"
                aria-label="Refresh now"
              >
                <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Link
                to="/app/attendance/regularizations"
                className="inline-flex items-center gap-1.5 rounded-lg bg-st-lowest px-2.5 py-1.5 text-[10px] font-bold text-st-on shadow-sm transition hover:bg-st-low"
              >
                <CalendarClock className="h-3 w-3 text-st-primary" aria-hidden="true" />
                Regularizations
                <span className="rounded-full bg-st-high px-1.5 py-0.5 text-[9px]">{workflows.regularizations?.total ?? '—'}</span>
              </Link>
              <Link
                to="/app/attendance/overtime"
                className="inline-flex items-center gap-1.5 rounded-lg bg-st-lowest px-2.5 py-1.5 text-[10px] font-bold text-st-on shadow-sm transition hover:bg-st-low"
              >
                <Timer className="h-3 w-3 text-st-primary" aria-hidden="true" />
                OT pending
                <span className="rounded-full bg-st-high px-1.5 py-0.5 text-[9px]">{workflows.overtime?.total ?? '—'}</span>
              </Link>
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-st-lowest px-2.5 py-1.5 text-[10px] font-bold text-st-on shadow-sm">
                <AlertTriangle className="h-3 w-3 text-st-error" aria-hidden="true" />
                Needs attention
                <span className={`rounded-full px-1.5 py-0.5 text-[9px] ${(counts.items || 0) > 0 ? 'bg-st-error-container text-st-on-error-container' : 'bg-st-secondary-container text-st-on-secondary-container'}`}>
                  {counts.items ?? 0}
                </span>
              </span>
            </div>
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

        {dash ? (
          <>
            {/* ── five counters ────────────────────────────────────────── */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <KpiTile
                icon={Users}
                label="Expected today"
                value={summary.expected ?? 0}
                unit="staff"
                hint={`${summary.applicable ?? 0} applicable · ${summary.nonWorking ?? 0} off / leave`}
                tone="bg-st-secondary-container text-st-on-secondary-container"
                bar="bg-st-secondary"
                share={100}
              />
              <KpiTile
                icon={Gauge}
                label="Working now"
                value={summary.working ?? 0}
                unit="in"
                hint={`${summary.onBreak ?? 0} on break · ${summary.completed ?? 0} done for the day`}
                tone="bg-st-secondary-fixed text-st-on-secondary-fixed"
                bar="bg-st-secondary"
                share={shareOf(summary.working)}
              />
              <KpiTile
                icon={CalendarOff}
                label="Approved leave"
                value={summary.onLeave ?? 0}
                unit="staff"
                hint={`${summary.holiday ?? 0} holiday · ${summary.weeklyOff ?? 0} weekly off`}
                tone="bg-st-tertiary-fixed text-st-on-tertiary-fixed"
                bar="bg-st-tertiary"
                share={shareOf(summary.onLeave)}
              />
              <KpiTile
                icon={UserX}
                label="Not in / grace"
                value={notYetIn}
                unit="staff"
                hint={`${summary.lateNotIn ?? 0} past grace · ${summary.unresolved ?? 0} unresolved`}
                tone="bg-st-high text-st-on-variant"
                bar="bg-st-outline"
                share={shareOf(notYetIn)}
              />
              <KpiTile
                icon={AlertTriangle}
                label="Needs attention"
                value={counts.people ?? 0}
                unit="people"
                hint={`${counts.blockers ?? 0} blockers · ${counts.warnings ?? 0} warnings · ${counts.info ?? 0} notices`}
                tone={(counts.people || 0) > 0 ? 'bg-st-error-container text-st-on-error-container' : 'bg-st-secondary-container text-st-on-secondary-container'}
                bar={(counts.people || 0) > 0 ? 'bg-st-error' : 'bg-st-secondary'}
                share={shareOf(counts.people)}
              />
            </div>

            {/* ── filters ──────────────────────────────────────────────── */}
            <section className="rounded-xl bg-st-lowest p-3.5 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <label className="relative min-w-[15rem] flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-st-outline" aria-hidden="true" />
                  <input
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    maxLength={60}
                    placeholder="Search name, employee code, role…"
                    className="w-full rounded-lg bg-st-low py-2 pl-9 pr-3 text-xs text-st-on placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                    aria-label="Search employees"
                  />
                </label>

                <span className="text-[10px] font-bold uppercase tracking-wider text-st-on-variant">Active modes</span>
                {MODE_CHIPS.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setWorkMode((current) => (current === value ? '' : value))}
                    aria-pressed={workMode === value}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold transition ${
                      workMode === value
                        ? 'bg-st-primary-container text-st-on-primary-container'
                        : 'bg-st-low text-st-on-variant hover:bg-st-container'
                    }`}
                  >
                    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                    {label} {modes[value] ?? 0}
                  </button>
                ))}
                {activeFilterCount > 0 ? (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="inline-flex items-center gap-1 rounded-full bg-st-low px-2 py-1 text-[10px] font-bold text-st-on-variant transition hover:text-st-on"
                  >
                    <Filter className="h-3 w-3" aria-hidden="true" /> Clear {activeFilterCount}
                  </button>
                ) : null}
              </div>

              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
                <select
                  value={departmentId}
                  onChange={(event) => setDepartmentId(event.target.value)}
                  className="rounded-lg bg-st-low px-3 py-2 text-[11px] font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  aria-label="Department"
                >
                  <option value="">Department · all ({departments.length})</option>
                  {(departments || []).map((dept) => (
                    <option key={dept._id || dept.id} value={dept._id || dept.id}>{dept.name}</option>
                  ))}
                </select>
                <select
                  value={location}
                  onChange={(event) => setLocation(event.target.value)}
                  className="rounded-lg bg-st-low px-3 py-2 text-[11px] font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  aria-label="Location"
                >
                  <option value="">Location · all</option>
                  {(dash.locations || []).map((loc) => (
                    <option key={loc.name} value={loc.name}>{loc.name}</option>
                  ))}
                </select>
                <select
                  value={presence}
                  onChange={(event) => setPresence(event.target.value)}
                  className="rounded-lg bg-st-low px-3 py-2 text-[11px] font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  aria-label="Presence state"
                >
                  <option value="">Presence · all</option>
                  {Object.entries(PRESENCE).map(([value, meta]) => (
                    <option key={value} value={value}>{meta.label}</option>
                  ))}
                </select>
                <select
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  className="rounded-lg bg-st-low px-3 py-2 text-[11px] font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  aria-label="Issue category"
                >
                  <option value="">Issue · all</option>
                  {CATEGORIES.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <select
                  value={shift}
                  onChange={(event) => setShift(event.target.value)}
                  className="rounded-lg bg-st-low px-3 py-2 text-[11px] font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  aria-label="Shift"
                >
                  <option value="">Shift · all</option>
                  {(dash.shifts || []).map((row) => (
                    <option key={row.name} value={row.name}>{row.name}</option>
                  ))}
                </select>
              </div>
            </section>

            {/* ── matrix + exceptions ─────────────────────────────────── */}
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col gap-3">
                <section className="overflow-hidden rounded-xl bg-st-lowest shadow-sm">
                  <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                    <div className="min-w-0">
                      <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
                        <Building2 className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" />
                        Presence matrix
                      </h2>
                      <p className="text-[10px] text-st-on-variant">
                        Live aggregation for {dash.date} — filters above narrow every column identically.
                      </p>
                    </div>
                    <div className="ml-auto inline-flex rounded-lg bg-st-low p-1">
                      {[
                        ['departments', 'Departments'],
                        ['shifts', 'Shifts'],
                        ['locations', 'Campuses'],
                      ].map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setGroupTab(value)}
                          aria-pressed={groupTab === value}
                          className={`rounded-md px-2.5 py-1 text-[10px] font-bold transition ${
                            groupTab === value ? 'bg-st-primary-container text-st-on-primary-container shadow-sm' : 'text-st-on-variant hover:text-st-on'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="overflow-x-auto border-t border-st-high/60">
                    <table className="w-full min-w-[38rem] text-left">
                      <thead>
                        <tr className="bg-st-container text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                          <th className="py-2 pl-4 pr-2 font-bold">{groupTab === 'shifts' ? 'Shift' : groupTab === 'locations' ? 'Campus' : 'Department unit'}</th>
                          <th className="px-2 py-2 text-right font-bold">{groupTab === 'locations' ? 'Checked in' : 'Expected'}</th>
                          <th className="px-2 py-2 text-right font-bold">{groupTab === 'locations' ? 'Working' : 'Present'}</th>
                          <th className="px-2 py-2 text-right font-bold">{groupTab === 'locations' ? 'Late arrivals' : 'Break'}</th>
                          {groupTab !== 'locations' ? (
                            <>
                              <th className="px-2 py-2 text-right font-bold">Not in</th>
                              <th className="px-2 py-2 text-right font-bold">Late</th>
                              <th className="px-2 py-2 text-right font-bold">Leave</th>
                              <th className="py-2 pr-4 text-right font-bold">Status</th>
                            </>
                          ) : null}
                        </tr>
                      </thead>
                      <tbody>
                        {groupTab === 'locations'
                          ? (dash.locations || []).map((row) => (
                            <tr key={row.name} className="border-b border-st-high/50 hover:bg-st-low">
                              <td className="py-2.5 pl-4 pr-2 text-xs font-bold text-st-on">{row.name}</td>
                              <td className="px-2 py-2.5 text-right text-[11px] tabular-nums">{row.checkedIn}</td>
                              <td className="px-2 py-2.5 text-right text-[11px] font-bold text-st-secondary tabular-nums">{row.working}</td>
                              <td className="px-2 py-2.5 text-right text-[11px] tabular-nums">
                                {row.lateArrivals ? <span className="font-bold text-st-error">{row.lateArrivals}</span> : <span className="text-st-on-variant">0</span>}
                              </td>
                            </tr>
                          ))
                          : groupRows.map((group) => {
                            const share = group.expected > 0 ? Math.round((group.working / group.expected) * 100) : 0;
                            const tone = group.attention > 0
                              ? 'bg-st-error-container text-st-on-error-container'
                              : group.notIn + group.lateNotIn > 0
                                ? 'bg-st-primary-fixed text-st-on-primary-fixed-variant'
                                : 'bg-st-secondary-container text-st-on-secondary-container';
                            return (
                              <tr key={group.id || group.name} className="border-b border-st-high/50 hover:bg-st-low">
                                <td className="py-2.5 pl-4 pr-2">
                                  <div className="flex items-center gap-1.5">
                                    <AttentionDot tone={group.attention > 0 ? 'bg-st-error' : 'bg-st-secondary'} />
                                    <span className="min-w-0">
                                      <span className="block truncate text-xs font-bold text-st-on">{group.name}</span>
                                      <span className="block text-[9px] text-st-on-variant">
                                        {group.working}/{group.expected} on the clock · {share}%
                                      </span>
                                    </span>
                                  </div>
                                </td>
                                <td className="px-2 py-2.5 text-right text-[11px] tabular-nums">{group.expected}</td>
                                <td className="px-2 py-2.5 text-right text-[11px] font-bold text-st-secondary tabular-nums">{group.working}</td>
                                <td className="px-2 py-2.5 text-right text-[11px] tabular-nums">{group.onBreak}</td>
                                <td className="px-2 py-2.5 text-right text-[11px] tabular-nums">{group.notIn + group.lateNotIn}</td>
                                <td className="px-2 py-2.5 text-right text-[11px] tabular-nums">
                                  {group.lateNotIn ? <span className="font-bold text-st-error">{group.lateNotIn}</span> : <span className="text-st-on-variant">0</span>}
                                </td>
                                <td className="px-2 py-2.5 text-right text-[11px] tabular-nums">{group.onLeave}</td>
                                <td className="py-2.5 pr-4 text-right">
                                  <span className={`inline-block rounded-full px-2 py-0.5 text-[9px] font-bold ${tone}`}>
                                    {group.attention > 0 ? `${group.attention} flagged` : group.completed === group.expected && group.expected > 0 ? 'Complete' : 'Nominal'}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        {groupRows.length === 0 ? (
                          <TableEmpty
                            colSpan={groupTab === 'locations' ? 4 : 8}
                            illustration={groupTab === 'locations' ? 'box' : 'team'}
                            title={groupTab === 'locations' ? 'No office check-ins in this view' : 'No groups in this view'}
                            description={groupTab === 'locations'
                              ? 'Nobody has punched in from an office location for this date — kiosk and mobile punches both count.'
                              : 'Departments and shifts come from the roster. Clear a filter or add people to a department and they appear here.'}
                          />
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </section>

                {/* The mock's two hardware strips have no endpoint behind them. */}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <section className="rounded-xl bg-st-lowest p-4 shadow-sm">
                    <h2 className="flex items-center gap-1.5 text-xs font-bold text-st-on">
                      <ScanFace className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" /> Capture telemetry
                      <span className="ml-auto rounded-full bg-st-high px-2 py-0.5 text-[8px] font-bold uppercase tracking-wider text-st-on-variant">
                        Not configured
                      </span>
                    </h2>
                    <p className="mt-1.5 text-[10px] leading-relaxed text-st-on-variant">
                      No gateway heartbeat is published, so this card does not claim a terminal synced
                      &ldquo;18 punches in the last 20 minutes&rdquo;. Punch sources are counted on
                      Attendance Analytics instead.
                    </p>
                    <Link to="/app/attendance/analytics" className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-bold text-st-primary hover:underline">
                      Open analytics <ArrowRight className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  </section>
                  <section className="rounded-xl bg-st-lowest p-4 shadow-sm">
                    <h2 className="flex items-center gap-1.5 text-xs font-bold text-st-on">
                      <Wifi className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" /> Geofence &amp; device network
                      <span className="ml-auto rounded-full bg-st-high px-2 py-0.5 text-[8px] font-bold uppercase tracking-wider text-st-on-variant">
                        Not configured
                      </span>
                    </h2>
                    <p className="mt-1.5 text-[10px] leading-relaxed text-st-on-variant">
                      This board shows presence, never coordinates. Wi-Fi BSSID checks and IoT scanners
                      have no data behind them, so nothing is invented for them here.
                    </p>
                    <Link to="/app/attendance/policy" className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-bold text-st-primary hover:underline">
                      Geofence policy <ArrowRight className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  </section>
                </div>
              </div>

              {/* ── exception rail ─────────────────────────────────────── */}
              <section className="flex min-w-0 flex-col rounded-xl bg-st-low p-3.5 shadow-sm">
                <div className="flex items-start gap-2">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-st-error" aria-hidden="true" />
                  <div className="min-w-0">
                    <h2 className="text-sm font-bold text-st-on">
                      Operational exceptions
                      <span className="ml-1 text-[10px] font-semibold text-st-on-variant">({attention.total})</span>
                    </h2>
                    <p className="text-[10px] leading-snug text-st-on-variant">
                      Live exceptions needing a human decision. Opening a card shows that person&apos;s month;
                      the workflow link hands the decision to its owner page.
                    </p>
                  </div>
                  <Link
                    to="/app/attendance/regularizations"
                    className="ml-auto shrink-0 rounded-lg bg-st-primary px-2 py-1 text-[9px] font-bold text-st-on-primary transition hover:opacity-95"
                  >
                    Resolve all
                  </Link>
                </div>

                <ul className="mt-3 flex-1 space-y-2 overflow-y-auto pr-0.5" style={{ maxHeight: '46rem' }}>
                  {attention.items.map((item, index) => (
                    <AttentionCard
                      key={`${item.category}-${item.employee.id}-${item.since || index}`}
                      item={item}
                      active={selected?.employee?.id === item.employee.id && selected?.category === item.category}
                      onOpen={openDetail}
                    />
                  ))}
                  {attention.items.length === 0 ? (
                    <li className="rounded-xl border border-dashed border-st-high px-3 py-6 text-center">
                      <ShieldCheck className="mx-auto h-5 w-5 text-st-secondary" aria-hidden="true" />
                      <p className="mt-1.5 text-[11px] font-bold text-st-on">Queue clear</p>
                      <p className="text-[10px] text-st-on-variant">
                        No missed punches, late arrivals or unresolved sessions in this view.
                      </p>
                    </li>
                  ) : null}
                </ul>

                <div className="mt-3 flex items-center justify-between border-t border-st-high/60 pt-2 text-[10px] text-st-on-variant">
                  <span>Page {attention.page} of {attention.totalPages} · {attention.total} exception{attention.total === 1 ? '' : 's'}</span>
                  <span className="flex items-center gap-1">
                    <button
                      type="button"
                      className="rounded bg-st-lowest p-1.5 text-st-on-variant transition hover:text-st-on disabled:opacity-40"
                      disabled={attention.page <= 1}
                      onClick={() => setPage((value) => Math.max(1, value - 1))}
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="rounded bg-st-lowest p-1.5 text-st-on-variant transition hover:text-st-on disabled:opacity-40"
                      disabled={attention.page >= attention.totalPages}
                      onClick={() => setPage((value) => value + 1)}
                      aria-label="Next page"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
              </section>
            </div>

            {/* ── workflow strip ───────────────────────────────────────── */}
            <section className="flex flex-col gap-3 rounded-xl bg-st-low px-4 py-3 shadow-sm lg:flex-row lg:items-center">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-st-primary-container text-st-on-primary-container">
                <Clock className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-st-on">Pending workload, linked not copied</p>
                <p className="text-[10px] leading-snug text-st-on-variant">
                  {workflows.regularizations?.total ?? 0} regularization request{(workflows.regularizations?.total ?? 0) === 1 ? '' : 's'} and{' '}
                  {workflows.overtime?.total ?? 0} overtime claim{(workflows.overtime?.total ?? 0) === 1 ? '' : 's'} are waiting on a decision.
                  Escalation rules and grace windows live on the policy page; this board never approves anything.
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-1.5">
                <Link to="/app/attendance/policy" className="rounded-lg bg-st-lowest px-3 py-1.5 text-[10px] font-bold text-st-on shadow-sm transition hover:bg-st-container">
                  View escalation rules
                </Link>
                <Link to="/app/attendance/team" className="inline-flex items-center gap-1 rounded-lg bg-st-primary px-3 py-1.5 text-[10px] font-bold text-st-on-primary transition hover:opacity-95">
                  Open the presence board <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </Link>
              </div>
            </section>

            <p className="flex items-start gap-2 rounded-xl bg-st-lowest px-4 py-3 text-[10px] leading-relaxed text-st-on-variant shadow-sm">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-st-secondary" aria-hidden="true" />
              <span>
                <strong className="font-semibold text-st-on">Time facts only.</strong> No reasons, no
                money, no productivity score, no coordinates. Everything above is recomputed by the
                backend on each read — this page writes nothing.
              </span>
            </p>
          </>
        ) : null}

        {selected ? (
          <Modal
            title={`${selected.employee.name} · ${(dash?.date || '').slice(0, 7)}`}
            onClose={() => { setSelected(null); setDetail(null); }}
            wide
          >
            <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-st-on-variant">
              <span>Issue: <strong className="font-semibold text-st-on">{selected.label}</strong></span>
              <span>Presence: <strong className="font-semibold text-st-on">{(PRESENCE[selected.presence]?.label || selected.presence || '—')}</strong></span>
              <span>In: <strong className="font-semibold text-st-on">{fmtTime(selected.clockInAt)}</strong></span>
              <span>Out: <strong className="font-semibold text-st-on">{fmtTime(selected.clockOutAt)}</strong></span>
              {selected.locationName ? <span>At: <strong className="font-semibold text-st-on">{selected.locationName}</strong></span> : null}
              <button
                type="button"
                onClick={() => { setSelected(null); setDetail(null); }}
                className="ml-auto inline-flex items-center gap-1 rounded bg-st-low px-2 py-1 text-[10px] font-bold text-st-on-variant hover:text-st-on"
              >
                <X className="h-3 w-3" aria-hidden="true" /> Close
              </button>
            </div>
            {detailLoading ? <div className="rounded-xl bg-st-low p-4 text-xs text-st-on-variant">Loading month…</div> : null}
            {detailError ? <div className="rounded-xl bg-st-error-container p-4 text-xs text-st-on-error-container">{detailError}</div> : null}
            {!detailLoading && !detailError && detail ? (
              <TimesheetMonthView sheet={detail} employeeName={detail?.employee?.name || ''} />
            ) : null}
          </Modal>
        ) : null}
      </div>
    </div>
  );
};

export default AttendanceOperationsPage;
