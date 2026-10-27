// Phase 31.15 — Attendance Reports & Analytics. READ-ONLY reporting
// surface over the resolved-daily layer (§31.10) and finalized
// snapshots (§31.11). Five tabs: Overview KPIs, monthly Trends,
// the Employee breakdown table, My summary (self-service) and the
// read-only Payroll reconciliation. Every number carries its
// provenance — FINALIZED snapshot version or LIVE/PROVISIONAL
// open-month facts — and the page never mutates attendance,
// leave, OT or payroll. No rankings, no scores, no predictions:
// the employee table default-orders by name and every column
// sort is an explicit, unranked sort.
//
// Redesign (2026-10): the overview reads as a ledger front page —
// four headline rates, the day-outcome breakdown as a distribution
// rather than a list, then the three evidence cards (capture
// sources, overtime chain, corrections) that explain where those
// numbers came from. Nothing new is computed here; the same payload
// is simply ordered by what a reader asks first.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  FileSpreadsheet,
  FileText,
  Filter,
  Gauge,
  MapPin,
  RefreshCw,
  ScanFace,
  ShieldCheck,
  Sparkles,
  Timer,
  TriangleAlert,
  User,
  Users,
  X,
} from 'lucide-react';
import attendanceService from '../../services/attendanceService.js';
import attendanceLocationService from '../../services/attendanceLocationService.js';
import departmentService from '../../services/departmentService.js';
import scheduleService from '../../services/scheduleService.js';
import usePermission from '../../hooks/usePermission.js';

const TABS = [
  ['overview', 'Overview', BarChart3],
  ['trends', 'Trends', CalendarDays],
  ['employees', 'Employees', Users],
  ['mine', 'My summary', User],
  ['reconciliation', 'Payroll reconciliation', FileText],
];

const PAGE_SIZE = 25;

const SORT_COLUMNS = [
  ['name', 'Employee'],
  ['employeeCode', 'Code'],
  ['workedUnits', 'Worked'],
  ['absentUnits', 'Absent'],
  ['attendanceRate', 'Attendance %'],
  ['workedMinutes', 'Worked min'],
  ['lateOccurrences', 'Late'],
];

const RECON_STYLES = {
  MATCH: 'bg-st-secondary-container text-st-on-secondary-container',
  MISMATCH: 'bg-st-error-container text-st-on-error-container',
  NOT_SYNCED: 'bg-st-primary-fixed text-st-on-primary-fixed-variant',
  NOT_FINALIZED: 'bg-st-high text-st-on-variant',
};

const MODE_LABEL = {
  OFFICE: 'Office',
  WFH: 'Work from home',
  FIELD: 'Field operations',
  CLIENT_SITE: 'Client site',
  BUSINESS_TRAVEL: 'Business travel',
};

const MODE_DOT = {
  OFFICE: 'bg-st-secondary',
  WFH: 'bg-st-primary-container',
  FIELD: 'bg-st-tertiary',
  CLIENT_SITE: 'bg-st-outline',
  BUSINESS_TRAVEL: 'bg-st-primary-fixed-dim',
};

const DAY_TILES = [
  ['present', 'Present', 'Timetabled and clocked', 'bg-st-secondary', 'text-st-on'],
  ['weeklyOff', 'Weekly off', 'Roster rest day', 'bg-st-outline', 'text-st-on'],
  ['absent', 'Absent', 'No punch, no leave', 'bg-st-error', 'text-st-error'],
  ['leave', 'Approved leave', 'Paid or unpaid, approved', 'bg-st-tertiary', 'text-st-on'],
  ['halfDay', 'Half day', '0.5 ratio applied', 'bg-st-primary-container', 'text-st-on'],
  ['holiday', 'Holiday', 'Calendar gazetted', 'bg-st-primary-fixed-dim', 'text-st-on'],
  ['unresolved', 'Unresolved punches', 'Needs a correction', 'bg-st-error', 'text-st-primary'],
];

const currentMonth = () => new Date().toISOString().slice(0, 7);

const fmtPct = (rate) => {
  if (!rate || rate.pct === null || rate.pct === undefined) return '—';
  return `${rate.pct}%`;
};

const fmtHours = (minutes) => {
  if (minutes === null || minutes === undefined) return '—';
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const fmtUnits = (value) => {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString('en-IN', { maximumFractionDigits: 1 });
};

const sourceLabel = (code) => String(code || '')
  .toLowerCase()
  .split('_')
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ');

const KpiCard = ({ label, value, unit, hint, detail, icon: Icon, tone, accent, meter = null }) => (
  <div className="rounded-xl bg-st-lowest p-4 shadow-sm">
    <div className="flex items-start justify-between gap-2">
      <span className="text-[10px] font-bold uppercase tracking-wider text-st-on-variant">{label}</span>
      <span className={`rounded-lg p-1 ${tone}`}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </div>
    <div className="mt-1 flex items-baseline gap-1">
      <span className="text-2xl font-bold text-st-on tabular-nums">{value}</span>
      {unit ? <span className="text-[10px] font-semibold text-st-on-variant">{unit}</span> : null}
    </div>
    <p className="mt-0.5 text-[10px] font-semibold text-st-on-variant">{hint}</p>
    {meter === null ? null : (
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-st-high">
        <div className={`h-full rounded-full ${accent}`} style={{ width: `${Math.max(0, Math.min(100, meter))}%` }} />
      </div>
    )}
    {detail ? <p className="mt-1.5 text-[10px] leading-snug text-st-on-variant">{detail}</p> : null}
  </div>
);

const Section = ({ title, icon: Icon, badge = null, note = null, children, className = '' }) => (
  <section className={`rounded-xl bg-st-lowest p-4 shadow-sm ${className}`}>
    <div className="flex items-start gap-2">
      <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
        {Icon ? <Icon className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" /> : null}
        {title}
      </h2>
      {badge ? <span className="ml-auto shrink-0 rounded-full bg-st-high px-2 py-0.5 text-[8px] font-bold uppercase tracking-wider text-st-on-variant">{badge}</span> : null}
    </div>
    {note ? <p className="mt-1 text-[10px] leading-relaxed text-st-on-variant">{note}</p> : null}
    <div className="mt-3">{children}</div>
  </section>
);

// Provenance: every covered month names its source — the FINALIZED
// snapshot version (payroll-grade truth) or the LIVE open-month
// projection. Shown above every tab's numbers.
const SourceBanner = ({ provenance, range }) => {
  if (!provenance || !provenance.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
        <FileText className="h-3 w-3" aria-hidden="true" /> Source
      </span>
      {provenance.map((row) => (
        <span
          key={row.month}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
            row.finalized
              ? 'bg-st-secondary-container text-st-on-secondary-container'
              : 'bg-st-primary-fixed text-st-on-primary-fixed-variant'
          }`}
          title={row.finalized ? `Finalized snapshot v${row.version}` : 'Live open-month projection'}
        >
          {row.finalized ? <CheckCircle2 className="h-2.5 w-2.5" aria-hidden="true" /> : <TriangleAlert className="h-2.5 w-2.5" aria-hidden="true" />}
          {row.month} · {row.finalized ? `v${row.version}` : 'live'}
        </span>
      ))}
      {range?.from ? (
        <span className="ml-auto text-[10px] text-st-on-variant">
          {range.from} → {range.to}
        </span>
      ) : null}
    </div>
  );
};

const SourceChip = ({ provenance }) => {
  const live = (provenance || []).some((row) => !row.finalized);
  const finalized = (provenance || []).filter((row) => row.finalized).length;
  if (!provenance?.length) return null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
      live ? 'bg-st-primary-fixed text-st-on-primary-fixed-variant' : 'bg-st-secondary-container text-st-on-secondary-container'
    }`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {live ? 'Live projection' : `${finalized} finalized`}
    </span>
  );
};

const AttendanceAnalyticsPage = () => {
  const { hasPermission, loading: permissionsLoading } = usePermission();
  const canAnalyze = hasPermission('ATTENDANCE_ANALYTICS_READ');
  const canSelf = hasPermission('ATTENDANCE_READ_SELF');

  const [tab, setTab] = useState('overview');
  const [month, setMonth] = useState(currentMonth());
  const [preset, setPreset] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [shiftId, setShiftId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [workMode, setWorkMode] = useState('');

  const [departments, setDepartments] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [locations, setLocations] = useState([]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState('');
  const [refreshedAt, setRefreshedAt] = useState(null);

  const [sort, setSort] = useState('name');
  const [page, setPage] = useState(1);

  const filters = useMemo(
    () => ({
      ...(preset ? { preset, month } : { month }),
      ...(departmentId ? { departmentId } : {}),
      ...(shiftId ? { shiftId } : {}),
      ...(locationId ? { locationId } : {}),
      ...(workMode ? { workMode } : {}),
    }),
    [preset, month, departmentId, shiftId, locationId, workMode]
  );

  const load = useCallback(async ({ silent = false } = {}) => {
    if (tab !== 'mine' && !canAnalyze) return;
    if (tab === 'mine' && !canAnalyze && !canSelf) return;
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      let result = null;
      if (tab === 'overview') result = await attendanceService.analyticsOverview(filters);
      else if (tab === 'trends') result = await attendanceService.analyticsTrends(filters);
      else if (tab === 'employees') {
        result = await attendanceService.analyticsEmployees({ ...filters, sort, page, pageSize: PAGE_SIZE });
      } else if (tab === 'mine') {
        result = await attendanceService.analyticsMine(preset ? { preset, month } : { month });
      } else if (tab === 'reconciliation') {
        result = await attendanceService.analyticsReconciliation(month);
      }
      setData(result?.data ?? result ?? null);
      setRefreshedAt(new Date());
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Failed to load analytics');
      if (!silent) setData(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [tab, filters, sort, page, month, preset, canAnalyze, canSelf]);

  useEffect(() => {
    departmentService.getAll().then(setDepartments).catch(() => {});
    // 31.16 D-07 — both services resolve envelopes, not bare arrays;
    // setting the envelope object crashed .map and blanked the page.
    scheduleService.listShifts().then((res) => setShifts(res?.shifts || res?.data?.shifts || res?.data || [])).catch(() => setShifts([]));
    attendanceLocationService.list().then((res) => setLocations(res?.data?.locations || res?.data || [])).catch(() => setLocations([]));
  }, []);

  useEffect(() => {
    setPage(1);
  }, [tab, month, preset, departmentId, shiftId, locationId, workMode, sort]);

  useEffect(() => {
    if (!permissionsLoading) load();
  }, [load, permissionsLoading]);

  // Self-service audience (no analytics permission) lands on — and
  // only ever sees — the My summary tab.
  useEffect(() => {
    if (!permissionsLoading && !canAnalyze && canSelf) setTab('mine');
  }, [permissionsLoading, canAnalyze, canSelf]);

  const toggleSort = (field) => {
    setSort((prev) => {
      if (prev === field) return `-${field}`;
      if (prev === `-${field}`) return 'name';
      return field;
    });
  };

  const sortIcon = (field) => {
    if (sort === field) return <ArrowUp size={11} className="inline" />;
    if (sort === `-${field}`) return <ArrowDown size={11} className="inline" />;
    return <ArrowUpDown size={11} className="inline opacity-40" />;
  };

  const runExport = async (reportType, format) => {
    const key = `${reportType}:${format}`;
    setExporting(key);
    setError('');
    try {
      await attendanceService.downloadAnalytics({ reportType, format, ...filters });
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Export failed');
    } finally {
      setExporting('');
    }
  };

  const clearFilters = () => {
    setPreset('');
    setDepartmentId('');
    setShiftId('');
    setLocationId('');
    setWorkMode('');
  };

  const hasFilters = preset || departmentId || shiftId || locationId || workMode;
  const totals = data?.totals || null;
  const visibleTabs = TABS.filter(([key]) => {
    if (key === 'mine') return canAnalyze || canSelf;
    return canAnalyze;
  });

  if (permissionsLoading) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 text-sm text-st-on-variant shadow-sm">Loading attendance analytics…</div>
      </div>
    );
  }

  if (!canAnalyze && !canSelf) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 shadow-sm">
          <h1 className="text-xl font-bold text-st-on">Attendance Analytics</h1>
          <p className="mt-2 text-sm text-st-on-variant">
            Your role doesn&apos;t include attendance analytics. Ask an administrator for access if you need it.
          </p>
        </div>
      </div>
    );
  }

  const renderFilterBar = (showRange = true) => (
    <section className="rounded-xl bg-st-lowest p-3 shadow-sm">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {showRange ? (
          <>
            <label className="flex flex-col gap-0.5">
              <span className="pl-1 text-[8px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Date scope</span>
              <input
                type="month"
                value={month}
                max={currentMonth()}
                onChange={(event) => setMonth(event.target.value || currentMonth())}
                className="rounded-lg bg-st-low px-2.5 py-1.5 text-[11px] font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                aria-label="Month"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="pl-1 text-[8px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Granularity</span>
              <select
                value={preset}
                onChange={(event) => setPreset(event.target.value)}
                className="rounded-lg bg-st-low px-2.5 py-1.5 text-[11px] font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                aria-label="Range preset"
              >
                <option value="">Single month</option>
                <option value="quarter">Quarter (anchored)</option>
                <option value="fy">Financial year (anchored)</option>
              </select>
            </label>
          </>
        ) : null}
        {tab !== 'mine' && tab !== 'reconciliation' ? (
          <>
            <label className="flex flex-col gap-0.5">
              <span className="pl-1 text-[8px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Department</span>
              <select
                value={departmentId}
                onChange={(event) => setDepartmentId(event.target.value)}
                className="rounded-lg bg-st-low px-2.5 py-1.5 text-[11px] font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                aria-label="Department"
              >
                <option value="">All departments</option>
                {departments.map((dept) => (
                  <option key={dept._id || dept.id} value={dept._id || dept.id}>{dept.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="pl-1 text-[8px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Shift plan</span>
              <select
                value={shiftId}
                onChange={(event) => setShiftId(event.target.value)}
                className="rounded-lg bg-st-low px-2.5 py-1.5 text-[11px] font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                aria-label="Shift"
              >
                <option value="">All shifts</option>
                {(shifts || []).map((shift) => (
                  <option key={shift._id || shift.id} value={shift._id || shift.id}>{shift.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="pl-1 text-[8px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Location pod</span>
              <select
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
                className="rounded-lg bg-st-low px-2.5 py-1.5 text-[11px] font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                aria-label="Location"
              >
                <option value="">All locations</option>
                {(locations || []).map((loc) => (
                  <option key={loc._id || loc.id} value={loc._id || loc.id}>{loc.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="pl-1 text-[8px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Modality</span>
              <select
                value={workMode}
                onChange={(event) => setWorkMode(event.target.value)}
                className="rounded-lg bg-st-low px-2.5 py-1.5 text-[11px] font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                aria-label="Work mode"
              >
                <option value="">All modes</option>
                <option value="OFFICE">Office</option>
                <option value="WFH">WFH</option>
                <option value="FIELD">Field</option>
                <option value="CLIENT_SITE">Client site</option>
                <option value="BUSINESS_TRAVEL">Travel</option>
              </select>
            </label>
          </>
        ) : null}
      </div>
      {hasFilters ? (
        <button
          type="button"
          onClick={clearFilters}
          className="mt-2 inline-flex items-center gap-1 rounded-lg bg-st-low px-2 py-1 text-[10px] font-bold text-st-on-variant transition hover:text-st-on"
        >
          <X className="h-3 w-3" aria-hidden="true" /> Clear filters
        </button>
      ) : null}
    </section>
  );

  const renderTotalsKpis = () => {
    if (!totals) return null;
    const day = totals.dayCounts || {};
    const daySum = ['present', 'halfDay', 'absent', 'leave', 'holiday', 'weeklyOff', 'unresolved']
      .reduce((sum, key) => sum + (Number(day[key]) || 0), 0);
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Attendance rate"
          value={fmtPct(totals.attendanceRate)}
          icon={Gauge}
          tone="bg-st-secondary-container text-st-on-secondary-container"
          hint={`${fmtUnits(totals.workedUnits)} of ${fmtUnits(totals.scheduledUnits)} scheduled units`}
          accent="bg-st-secondary"
          meter={totals.attendanceRate?.pct ?? 0}
          detail={daySum ? `${day.present ?? 0} present days carry the rate` : 'No scheduled units in range'}
        />
        <KpiCard
          label="Absence & leave rate"
          value={fmtPct(totals.absenceRate)}
          icon={CalendarDays}
          tone="bg-st-primary-fixed text-st-on-primary-fixed-variant"
          hint={`${fmtUnits(totals.absentUnits)} absent units`}
          accent="bg-st-primary-container"
          meter={totals.absenceRate?.pct ?? 0}
          detail={`${day.leave ?? 0} leave day${(day.leave ?? 0) === 1 ? '' : 's'} · ${day.absent ?? 0} absent day${(day.absent ?? 0) === 1 ? '' : 's'}`}
        />
        <KpiCard
          label="Effective worked"
          value={fmtHours(totals.workedMinutes)}
          icon={Clock}
          tone="bg-st-secondary-fixed text-st-on-secondary-fixed"
          hint={totals.sessionDays ? `${totals.sessionDays} session days` : 'no session days'}
          accent="bg-st-secondary"
          meter={totals.sessionDays ? 100 : 0}
          detail={totals.averageWorkedMinutes ? `average ${fmtHours(totals.averageWorkedMinutes)} per session day` : 'average unavailable'}
        />
        <KpiCard
          label="Punctuality & lateness"
          value={totals.lateOccurrences ?? 0}
          unit="late arrivals"
          icon={Timer}
          tone="bg-st-primary-fixed text-st-on-primary-fixed-variant"
          hint={`${totals.lateMinutes || 0} minutes past start`}
          accent="bg-st-primary-container"
          meter={totals.lateOccurrences ? Math.min(100, totals.lateOccurrences * 5) : 0}
          detail={`${totals.earlyOccurrences || 0} early exit${(totals.earlyOccurrences || 0) === 1 ? '' : 's'} · ${totals.missingPunchDays || 0} missing punch day${(totals.missingPunchDays || 0) === 1 ? '' : 's'}`}
        />
      </div>
    );
  };

  const renderOverview = () => {
    if (!data) return null;
    const dayCounts = totals?.dayCounts || {};
    const modes = totals?.modes || {};
    const sources = data.sources || { counts: {}, total: 0, pcts: {} };
    const ot = data.overtime || {};
    const regs = data.regularizations || {};
    const sourceEntries = Object.entries(sources.counts || {});
    const daySum = DAY_TILES.reduce((sum, [key]) => sum + (Number(dayCounts[key]) || 0), 0);
    const modeTotal = Object.values(modes).reduce((sum, value) => sum + (Number(value) || 0), 0);
    const locationRows = data.locations?.locations || [];

    return (
      <div className="flex flex-col gap-4">
        <SourceBanner provenance={data.provenance} range={data.range} />
        {renderTotalsKpis()}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <Section
            title="Day outcomes breakdown"
            icon={CalendarDays}
            badge={`${daySum} day${daySum === 1 ? '' : 's'}`}
            note="Consolidated operational ledger units for the selected interval. Every tile is a bucket the backend resolved — nothing here is projected."
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {DAY_TILES.map(([key, label, hint, dot, tone]) => (
                <div key={key} className="rounded-lg bg-st-low px-2.5 py-2">
                  <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                    <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                    {label}
                  </span>
                  <p className={`mt-0.5 text-lg font-bold tabular-nums ${tone}`}>{dayCounts[key] ?? 0}</p>
                  <p className="text-[9px] leading-tight text-st-on-variant">{hint}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-st-high">
              {DAY_TILES.map(([key, , , dot]) => {
                const value = Number(dayCounts[key]) || 0;
                if (!value || !daySum) return null;
                return (
                  <span
                    key={key}
                    className={dot}
                    style={{ width: `${(value / daySum) * 100}%` }}
                    title={`${key}: ${value}`}
                  />
                );
              })}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-st-on-variant">
              <span>{totals?.missingPunchDays ?? 0} missing-punch day{(totals?.missingPunchDays ?? 0) === 1 ? '' : 's'}</span>
              <span>· {totals?.sessionDays ?? 0} session days</span>
              <Link to="/app/attendance/regularizations" className="ml-auto inline-flex items-center gap-1 font-bold text-st-primary hover:underline">
                Resolve unresolved punches <ChevronRight className="h-2.5 w-2.5" aria-hidden="true" />
              </Link>
            </div>
          </Section>

          <Section
            title="Work modes & modality"
            icon={Building2}
            badge={modeTotal ? `${modeTotal} sessions` : 'no sessions'}
            note="Aggregated presence across workplace policies for the same interval."
          >
            <ul className="space-y-2.5">
              {Object.keys(MODE_LABEL).map((mode) => {
                const value = Number(modes[mode]) || 0;
                const share = modeTotal ? Math.round((value / modeTotal) * 100) : 0;
                return (
                  <li key={mode}>
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="inline-flex items-center gap-1.5 font-semibold text-st-on">
                        <span aria-hidden="true" className={`h-2 w-2 rounded-full ${MODE_DOT[mode]}`} />
                        {MODE_LABEL[mode]}
                      </span>
                      <span className="text-st-on-variant">
                        <strong className="font-bold text-st-on">{share}%</strong> ({value} session{value === 1 ? '' : 's'})
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-st-high">
                      <div className={`h-full rounded-full ${MODE_DOT[mode]}`} style={{ width: `${share}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
            {modeTotal === 0 ? (
              <p className="mt-2 text-[10px] text-st-on-variant">No session day in range had a recorded work mode.</p>
            ) : null}
            <div className="mt-3 rounded-lg bg-st-low px-3 py-2">
              <p className="flex items-center gap-1 text-[10px] font-bold text-st-on">
                <ShieldCheck className="h-3 w-3 text-st-outline" aria-hidden="true" /> Hybrid compliance
                <span className="ml-auto rounded-full bg-st-high px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-st-on-variant">
                  Not configured
                </span>
              </p>
              <p className="mt-0.5 text-[9px] leading-relaxed text-st-on-variant">
                No mandated office-day minimum is stored, so no compliance percentage is printed. Set one on
                the attendance policy if you need it measured.
              </p>
              <Link to="/app/attendance/policy" className="mt-1 inline-flex items-center gap-1 text-[9px] font-bold text-st-primary hover:underline">
                Open attendance policy <ChevronRight className="h-2.5 w-2.5" aria-hidden="true" />
              </Link>
            </div>
          </Section>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Section title="Capture telemetry" icon={ScanFace} badge={`${sources.total ?? 0} punches`} note="Where the punches came from — the device story behind the numbers.">
            {sourceEntries.length ? (
              <ul className="space-y-2">
                {sourceEntries.map(([source, count]) => {
                  const pct = sources.pcts?.[source] ?? (sources.total ? Math.round((count / sources.total) * 100) : 0);
                  return (
                    <li key={source}>
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="font-semibold text-st-on">{sourceLabel(source)}</span>
                        <span className="text-st-on-variant"><strong className="font-bold text-st-on">{pct}%</strong> · {count}</span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-st-high">
                        <div className="h-full rounded-full bg-st-secondary" style={{ width: `${pct}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[10px] text-st-on-variant">No punches in range, so there is no capture mix to show.</p>
            )}
            <p className="mt-2 text-[9px] leading-relaxed text-st-on-variant">
              Gateway heartbeats and terminal uptime are not published — this card counts evidence, it does
              not claim a device is online.
            </p>
          </Section>

          <Section title="Overtime ledger" icon={Timer} badge="time bank" note="Permanent time facts only.">
            <div className="rounded-lg bg-st-low px-3 py-2">
              <p className="text-[8px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Approved overtime hours</p>
              <p className="text-xl font-bold text-st-on tabular-nums">{fmtHours(ot.approvedMinutes)}</p>
              <p className="text-[10px] text-st-on-variant">
                across {ot.approved ?? 0} approved request{(ot.approved ?? 0) === 1 ? '' : 's'}
                {(ot.pending ?? 0) > 0 ? ` · ${ot.pending} pending` : ''}
              </p>
            </div>
            <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-st-primary-fixed/50 px-2.5 py-2">
              <Gauge className="mt-0.5 h-3 w-3 shrink-0 text-st-on-primary-fixed-variant" aria-hidden="true" />
              <p className="text-[9px] leading-relaxed text-st-on-primary-fixed-variant">
                <strong className="font-bold">Statutory note.</strong> Money never appears here. This ledger
                tracks time and comp-off eligibility; payout belongs to payroll.
              </p>
            </div>
            <Link to="/app/attendance/overtime" className="mt-2 inline-flex items-center gap-1 text-[10px] font-bold text-st-primary hover:underline">
              Audit overtime &amp; comp-off <ChevronRight className="h-2.5 w-2.5" aria-hidden="true" />
            </Link>
          </Section>

          <Section title="Regularizations & exceptions" icon={TriangleAlert} badge={`${regs.pending ?? 0} pending`} note="The correction queue behind every unresolved day.">
            <div className="grid grid-cols-3 gap-1.5">
              {[
                ['Submitted', regs.submitted ?? 0, 'text-st-on'],
                ['Approved', regs.approved ?? 0, 'text-st-secondary'],
                ['Pending', regs.pending ?? 0, 'text-st-primary'],
              ].map(([label, value, tone]) => (
                <div key={label} className="rounded-lg bg-st-low px-2 py-1.5 text-center">
                  <p className={`text-base font-bold tabular-nums ${tone}`}>{value}</p>
                  <p className="text-[8px] font-bold uppercase tracking-wider text-st-on-variant">{label}</p>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[9px] text-st-on-variant">
              {regs.rejected ?? 0} request{(regs.rejected ?? 0) === 1 ? '' : 's'} declined in this range.
            </p>

            <h3 className="mt-3 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
              <MapPin className="h-3 w-3" aria-hidden="true" /> Punch locations
            </h3>
            <ul className="mt-1 space-y-1">
              {locationRows.slice(0, 3).map((row) => {
                const share = data.locations?.totalEvents ? Math.round((row.events / data.locations.totalEvents) * 100) : 0;
                return (
                  <li key={row.locationId || row.locationName} className="text-[10px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-semibold text-st-on">{row.locationName || 'Unassigned'}</span>
                      <span className="shrink-0 text-st-on-variant">{share}% ({row.events})</span>
                    </div>
                    <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-st-high">
                      <div className="h-full rounded-full bg-st-outline" style={{ width: `${share}%` }} />
                    </div>
                  </li>
                );
              })}
              {!locationRows.length ? <li className="text-[10px] text-st-on-variant">No located punches in range.</li> : null}
            </ul>
            <p className="mt-1 text-[9px] text-st-on-variant">
              {data.locations?.totalEvents ?? 0} located punch events · no coordinates are shown or stored on screen.
            </p>
            <Link to="/app/attendance/regularizations" className="mt-2 inline-flex items-center gap-1 text-[10px] font-bold text-st-primary hover:underline">
              Open the exception centre <ChevronRight className="h-2.5 w-2.5" aria-hidden="true" />
            </Link>
          </Section>
        </div>

        <div className="flex flex-col gap-3 rounded-xl bg-st-low px-4 py-3 shadow-sm lg:flex-row lg:items-center">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-st-primary-container text-st-on-primary-container">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-st-on">
              {data.provenance?.some((row) => row.finalized)
                ? 'Snapshot-backed figures'
                : 'Live projection for an open month'}
            </p>
            <p className="text-[10px] leading-snug text-st-on-variant">
              {data.provenance?.some((row) => row.finalized)
                ? 'A finalized month is a frozen snapshot of resolved daily facts — payroll-grade truth. Live months keep moving until HR finalizes them.'
                : 'This month is not finalized, so these numbers are a live projection over current punch, leave and roster facts. Finalize the month to freeze them.'}{' '}
              Read-only: nothing on this page writes attendance, leave, overtime or payroll.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={!!exporting}
              onClick={() => runExport('employees', 'csv')}
              className="inline-flex items-center gap-1 rounded-lg bg-st-lowest px-2.5 py-1.5 text-[10px] font-bold text-st-on shadow-sm transition hover:bg-st-container disabled:opacity-50"
            >
              <FileText className="h-3 w-3" aria-hidden="true" /> {exporting === 'employees:csv' ? 'Exporting…' : 'Employees CSV'}
            </button>
            <button
              type="button"
              disabled={!!exporting}
              onClick={() => runExport('employees', 'xlsx')}
              className="inline-flex items-center gap-1 rounded-lg bg-st-lowest px-2.5 py-1.5 text-[10px] font-bold text-st-on shadow-sm transition hover:bg-st-container disabled:opacity-50"
            >
              <FileSpreadsheet className="h-3 w-3" aria-hidden="true" /> {exporting === 'employees:xlsx' ? 'Exporting…' : 'Employees XLSX'}
            </button>
            <button
              type="button"
              disabled={!!exporting}
              onClick={() => runExport('reconciliation', 'csv')}
              className="inline-flex items-center gap-1 rounded-lg bg-st-lowest px-2.5 py-1.5 text-[10px] font-bold text-st-on shadow-sm transition hover:bg-st-container disabled:opacity-50"
            >
              <FileText className="h-3 w-3" aria-hidden="true" /> {exporting === 'reconciliation:csv' ? 'Exporting…' : 'Reconciliation CSV'}
            </button>
            <button
              type="button"
              disabled
              title="No PDF ledger report is published; the CSVs are the signed extract."
              className="inline-flex items-center gap-1 rounded-lg bg-st-primary px-2.5 py-1.5 text-[10px] font-bold text-st-on-primary opacity-60"
            >
              <Download className="h-3 w-3" aria-hidden="true" /> PDF audit
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderTrends = () => {
    if (!data) return null;
    const months = data.months || [];
    const maxPct = Math.max(100, ...months.map((row) => row.totals?.attendanceRate?.pct || 0));
    return (
      <div className="flex flex-col gap-4">
        <SourceBanner provenance={data.provenance} range={data.range} />
        <Section
          title="Monthly attendance rate"
          icon={BarChart3}
          note="Up to 12 months back. Each bar names its source — a finalized bar is snapshot truth, a live bar moves until finalization."
        >
          {months.length ? (
            <svg viewBox={`0 0 ${months.length * 64 + 16} 190`} className="w-full" role="img" aria-label="Monthly attendance rate chart">
              <line x1="8" y1="150" x2={months.length * 64 + 8} y2="150" stroke="currentColor" strokeOpacity="0.2" />
              {[25, 50, 75, 100].map((tick) => (
                <g key={tick}>
                  <line x1="8" y1={150 - (tick / maxPct) * 130} x2={months.length * 64 + 8} y2={150 - (tick / maxPct) * 130} stroke="currentColor" strokeOpacity="0.08" />
                  <text x="4" y={153 - (tick / maxPct) * 130} fontSize="8" fill="currentColor" opacity="0.5" textAnchor="start">{tick}</text>
                </g>
              ))}
              {months.map((row, index) => {
                const pct = row.totals?.attendanceRate?.pct ?? null;
                const height = pct === null ? 2 : Math.max(2, (pct / maxPct) * 130);
                const x = 16 + index * 64;
                return (
                  <g key={row.month}>
                    <rect
                      x={x}
                      y={150 - height}
                      width="40"
                      height={height}
                      rx="3"
                      className={row.finalized ? 'fill-st-secondary/80' : 'fill-st-primary-container/80'}
                    >
                      <title>{`${row.month}: ${pct === null ? 'no scheduled days' : `${pct}%`} (${row.finalized ? 'finalized' : 'live'})`}</title>
                    </rect>
                    <text x={x + 20} y={146 - height} fontSize="9" fill="currentColor" textAnchor="middle">
                      {pct === null ? '—' : `${pct}%`}
                    </text>
                    <text x={x + 20} y="163" fontSize="8" fill="currentColor" opacity="0.7" textAnchor="middle">
                      {row.month.slice(2)}
                    </text>
                    <text x={x + 20} y="174" fontSize="7" fill="currentColor" opacity="0.5" textAnchor="middle">
                      {row.finalized ? 'FINAL' : 'LIVE'}
                    </text>
                  </g>
                );
              })}
            </svg>
          ) : (
            <p className="text-[11px] text-st-on-variant">No months in this range.</p>
          )}
        </Section>

        <section className="overflow-hidden rounded-xl bg-st-lowest shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-left">
              <thead>
                <tr className="bg-st-container text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                  <th className="py-2 pl-4 pr-2 font-bold">Month</th>
                  <th className="px-2 py-2 font-bold">Source</th>
                  <th className="px-2 py-2 text-right font-bold">Attendance %</th>
                  <th className="px-2 py-2 text-right font-bold">Absence %</th>
                  <th className="px-2 py-2 text-right font-bold">Worked units</th>
                  <th className="px-2 py-2 text-right font-bold">Scheduled units</th>
                  <th className="py-2 pl-2 pr-4 text-right font-bold">Effective worked</th>
                </tr>
              </thead>
              <tbody>
                {months.map((row) => (
                  <tr key={row.month} className="border-b border-st-high/50 hover:bg-st-low">
                    <td className="py-2 pl-4 pr-2 text-xs font-bold text-st-on">{row.month}</td>
                    <td className="px-2 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                        row.finalized ? 'bg-st-secondary-container text-st-on-secondary-container' : 'bg-st-primary-fixed text-st-on-primary-fixed-variant'
                      }`}>
                        {row.finalized ? 'Finalized' : 'Live'}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right text-[11px] tabular-nums">{fmtPct(row.totals?.attendanceRate)}</td>
                    <td className="px-2 py-2 text-right text-[11px] tabular-nums">{fmtPct(row.totals?.absenceRate)}</td>
                    <td className="px-2 py-2 text-right text-[11px] tabular-nums">{fmtUnits(row.totals?.workedUnits)}</td>
                    <td className="px-2 py-2 text-right text-[11px] tabular-nums">{fmtUnits(row.totals?.scheduledUnits)}</td>
                    <td className="py-2 pl-2 pr-4 text-right text-[11px] tabular-nums">{fmtHours(row.totals?.workedMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    );
  };

  const renderEmployees = () => {
    if (!data) return null;
    const rows = data.rows || [];
    return (
      <div className="flex flex-col gap-4">
        <SourceBanner provenance={data.provenance} range={data.range} />
        <section className="overflow-hidden rounded-xl bg-st-lowest shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[60rem] text-left">
              <thead>
                <tr className="bg-st-container text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                  {SORT_COLUMNS.map(([field, label]) => (
                    <th key={field} className={`py-2 ${field === 'name' ? 'pl-4 pr-2' : 'px-2'} ${field === 'name' ? '' : 'text-right'} font-bold`}>
                      <button type="button" className="inline-flex items-center gap-1 hover:text-st-on" onClick={() => toggleSort(field)}>
                        {label} {sortIcon(field)}
                      </button>
                    </th>
                  ))}
                  <th className="px-2 py-2 text-right font-bold">Avg / day</th>
                  <th className="px-2 py-2 text-right font-bold">Late min</th>
                  <th className="px-2 py-2 text-right font-bold">Missing</th>
                  <th className="py-2 pl-2 pr-4 text-right font-bold">OT min</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.employeeId} className="border-b border-st-high/50 hover:bg-st-low">
                    <td className="py-2 pl-4 pr-2">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-st-secondary-container text-[9px] font-bold text-st-on-secondary-container">
                          {(row.name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('')}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-bold text-st-on">{row.name}</span>
                          <span className="block truncate text-[10px] text-st-on-variant">{row.department?.name || row.designation || '—'}</span>
                        </span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right text-[10px] text-st-on-variant">{row.employeeCode || '—'}</td>
                    <td className="px-2 py-2 text-right text-[11px] tabular-nums">{fmtUnits(row.workedUnits)}</td>
                    <td className="px-2 py-2 text-right text-[11px] tabular-nums">{fmtUnits(row.absentUnits)}</td>
                    <td className="px-2 py-2 text-right text-[11px] font-bold tabular-nums">{fmtPct(row.attendanceRate)}</td>
                    <td className="px-2 py-2 text-right text-[11px] tabular-nums">{fmtHours(row.workedMinutes)}</td>
                    <td className="px-2 py-2 text-right text-[11px] tabular-nums">{fmtHours(row.averageWorkedMinutes)}</td>
                    <td className="px-2 py-2 text-right text-[11px] tabular-nums">{row.lateMinutes ?? 0}</td>
                    <td className="px-2 py-2 text-right text-[11px] tabular-nums">{row.missingPunchDays ?? 0}</td>
                    <td className="py-2 pl-2 pr-4 text-right text-[11px] tabular-nums">{row.approvedOtMinutes ?? 0}</td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr>
                    <td colSpan={11} className="px-4 py-6 text-center text-[11px] text-st-on-variant">
                      No employees in scope for this range.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-st-high/60 px-4 py-2 text-[10px] text-st-on-variant">
            <span>Page {data.page || 1} of {data.totalPages || 1} · {data.total || 0} employees</span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                className="rounded bg-st-low p-1.5 transition hover:text-st-on disabled:opacity-40"
                disabled={(data.page || 1) <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="Previous page"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="rounded bg-st-low p-1.5 transition hover:text-st-on disabled:opacity-40"
                disabled={(data.page || 1) >= (data.totalPages || 1)}
                onClick={() => setPage((p) => p + 1)}
                aria-label="Next page"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
        </section>
        <p className="text-[10px] text-st-on-variant">
          Default order is by name. Every other order is an explicit sort of a ledger, never a ranking or a score.
        </p>
      </div>
    );
  };

  const renderMine = () => {
    if (!data) return null;
    return (
      <div className="flex flex-col gap-4">
        <SourceBanner provenance={data.provenance} range={data.range} />
        {renderTotalsKpis()}
        <Section title="My day outcomes" icon={CalendarDays} note="The same ledger the company report reads, narrowed to your own record.">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['Present', totals?.dayCounts?.present],
              ['Half day', totals?.dayCounts?.halfDay],
              ['Absent', totals?.dayCounts?.absent],
              ['Leave', totals?.dayCounts?.leave],
              ['Holiday', totals?.dayCounts?.holiday],
              ['Weekly off', totals?.dayCounts?.weeklyOff],
              ['Unresolved', totals?.dayCounts?.unresolved],
              ['Missing punch days', totals?.missingPunchDays],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-st-low px-2.5 py-2">
                <p className="text-lg font-bold text-st-on tabular-nums">{value ?? 0}</p>
                <p className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">{label}</p>
              </div>
            ))}
          </div>
          <Link to="/app/attendance/timesheet" className="mt-2 inline-flex items-center gap-1 text-[10px] font-bold text-st-primary hover:underline">
            Day-by-day detail lives on My Timesheet <ChevronRight className="h-2.5 w-2.5" aria-hidden="true" />
          </Link>
        </Section>
      </div>
    );
  };

  const renderReconciliation = () => {
    if (!data) return null;
    const summary = data.summary || {};
    const rows = data.rows || [];
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
            <Building2 className="h-3 w-3" aria-hidden="true" /> {data.month} · period {data.periodStatus}
          </span>
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
            data.finalized ? 'bg-st-secondary-container text-st-on-secondary-container' : 'bg-st-primary-fixed text-st-on-primary-fixed-variant'
          }`}>
            {data.finalized ? `Finalized v${data.currentVersion}` : 'Not finalized'}
          </span>
          {Object.entries(summary).map(([status, count]) => (
            <span key={status} className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${RECON_STYLES[status] || 'bg-st-high text-st-on-variant'}`}>
              {status}: {count}
            </span>
          ))}
          <span className="ml-auto text-[10px] text-st-on-variant">Read-only — HR-owned payroll entries are never compared.</span>
        </div>
        <section className="overflow-hidden rounded-xl bg-st-lowest shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-left">
              <thead>
                <tr className="bg-st-container text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                  <th className="py-2 pl-4 pr-2 font-bold">Employee</th>
                  <th className="px-2 py-2 font-bold">Status</th>
                  <th className="px-2 py-2 text-right font-bold">Snapshot v</th>
                  <th className="px-2 py-2 text-right font-bold">Current v</th>
                  <th className="px-2 py-2 font-bold">Synced at</th>
                  <th className="py-2 pl-2 pr-4 font-bold">Differences</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.employeeId} className="border-b border-st-high/50 hover:bg-st-low">
                    <td className="py-2 pl-4 pr-2">
                      <span className="block text-xs font-bold text-st-on">{row.name}</span>
                      <span className="block text-[10px] text-st-on-variant">{row.department?.name || row.employeeCode || ''}</span>
                    </td>
                    <td className="px-2 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${RECON_STYLES[row.status] || 'bg-st-high text-st-on-variant'}`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right text-[11px] tabular-nums">{row.snapshotVersion ?? '—'}</td>
                    <td className="px-2 py-2 text-right text-[11px] tabular-nums">{row.currentVersion ?? '—'}</td>
                    <td className="px-2 py-2 text-[10px] text-st-on-variant">{row.syncedAt ? new Date(row.syncedAt).toLocaleString('en-IN') : '—'}</td>
                    <td className="py-2 pl-2 pr-4 text-[10px]">
                      {(row.diffs || []).length === 0 ? (
                        <span className="text-st-on-variant">—</span>
                      ) : (
                        <ul className="list-disc space-y-0.5 pl-4">
                          {row.diffs.map((diff, index) => (
                            <li key={`${diff.field || index}`}>
                              {diff.field}: expected {String(diff.expected ?? '—')} · actual {String(diff.actual ?? '—')}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-[11px] text-st-on-variant">No employees in scope for this month.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    );
  };

  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-5">
        {/* ── hero ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
                Time &amp; Leave · Attendance Analytics
              </span>
              <SourceChip provenance={data?.provenance} />
              {refreshedAt ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-st-on-variant">
                  <Sparkles className="h-3 w-3" aria-hidden="true" /> read {refreshedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              ) : null}
            </div>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-st-on lg:text-[2rem]">Attendance Analytics</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-st-on-variant">
              Read-only reports over {tab === 'mine' ? 'your own' : 'scoped'} attendance facts — finalized
              snapshots where they exist, live workforce projections otherwise. No rankings, no scores, no
              money.
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-stretch gap-2">
            <div className="flex items-center justify-between gap-2 rounded-lg bg-st-lowest px-3 py-2 shadow-sm">
              <span className="min-w-0">
                <span className="block text-[8px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Audit snapshot</span>
                <span className="block truncate text-[11px] font-bold text-st-on">
                  {refreshedAt ? refreshedAt.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Reading…'}
                </span>
              </span>
              <button
                type="button"
                onClick={() => load({ silent: true })}
                disabled={refreshing}
                className="rounded p-1 text-st-on-variant transition hover:text-st-on disabled:opacity-50"
                aria-label="Refresh now"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <Link
              to="/app/attendance/policy"
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary shadow-sm transition hover:opacity-95"
            >
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Ledger rules
            </Link>
          </div>
        </section>

        {/* ── tabs ─────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap gap-1.5">
          {visibleTabs.map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold transition ${
                tab === key
                  ? 'bg-st-primary-container text-st-on-primary-container shadow-sm'
                  : 'bg-st-lowest text-st-on-variant shadow-sm hover:text-st-on'
              }`}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {label}
            </button>
          ))}
        </div>

        {tab === 'reconciliation' ? (
          <section className="rounded-xl bg-st-lowest p-3 shadow-sm">
            <label className="flex max-w-[14rem] flex-col gap-0.5">
              <span className="pl-1 text-[8px] font-bold uppercase tracking-[0.12em] text-st-on-variant">Month</span>
              <input
                type="month"
                value={month}
                max={currentMonth()}
                onChange={(event) => setMonth(event.target.value || currentMonth())}
                className="rounded-lg bg-st-low px-2.5 py-1.5 text-[11px] font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                aria-label="Month"
              />
            </label>
          </section>
        ) : renderFilterBar(tab !== 'mine')}

        {error ? (
          <div className="flex items-center gap-3 rounded-lg bg-st-error-container px-4 py-2.5 text-xs font-medium text-st-on-error-container">
            {error}
            <button type="button" onClick={() => load()} className="rounded bg-st-lowest px-2 py-1 text-[11px] font-bold text-st-on">
              Retry
            </button>
          </div>
        ) : null}

        {loading && !data ? (
          <div className="rounded-xl bg-st-lowest p-6 text-sm text-st-on-variant shadow-sm">Loading analytics…</div>
        ) : null}

        {!error && data ? (
          <>
            {tab === 'overview' && renderOverview()}
            {tab === 'trends' && renderTrends()}
            {tab === 'employees' && renderEmployees()}
            {tab === 'mine' && renderMine()}
            {tab === 'reconciliation' && renderReconciliation()}
          </>
        ) : null}

        <p className="flex items-start gap-2 rounded-xl bg-st-low px-4 py-3 text-[10px] leading-relaxed text-st-on-variant">
          <Filter className="mt-0.5 h-3.5 w-3.5 shrink-0 text-st-outline" aria-hidden="true" />
          <span>
            Filters narrow every number on the tab identically. Blocks this workspace cannot back — hybrid
            office-day compliance, device uptime, a PDF audit file — say so in place instead of printing a
            plausible figure.
          </span>
        </p>
      </div>
    </div>
  );
};

export default AttendanceAnalyticsPage;
