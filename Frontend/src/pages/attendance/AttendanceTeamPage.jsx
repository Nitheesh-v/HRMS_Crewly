import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Briefcase,
  Building2,
  CalendarOff,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Coffee,
  Download,
  Filter,
  MapPin,
  Plane,
  RefreshCw,
  Search,
  ShieldCheck,
  Timer,
  UserCheck,
  Users,
  Wifi,
} from 'lucide-react';
import usePermission from '../../hooks/usePermission.js';
import attendanceService from '../../services/attendanceService.js';
import departmentService from '../../services/departmentService.js';
import EmptyState from '../../components/common/EmptyState.jsx';

// Phase 31.9 — Who's Working: the live team attendance board, re-cut to the
// Operations mock.
//
// ATTENDANCE PRESENCE ONLY. Every state below comes from punch facts, the
// resolved roster, leave and holidays — never from computer activity. The board
// shows no coordinates, no reasons and no payroll figures. Refresh is bounded
// polling (45s, visible tab only) plus a manual refresh, and durations tick
// client-side from authoritative server timestamps.

const REFRESH_MS = 45000;

const PRESENCE_LABEL = {
  WORKING: 'Working',
  ON_BREAK: 'On break',
  COMPLETED: 'Completed',
  NOT_IN: 'Not yet in',
  LATE_NOT_IN: 'Late — not in',
  ON_LEAVE: 'On leave',
  HOLIDAY: 'Holiday',
  WEEKLY_OFF: 'Weekly off',
  UNRESOLVED: 'No schedule',
};

/* One colour role per state, carried by the chip and by the card's left edge. */
const PRESENCE_TONE = {
  WORKING: { chip: 'bg-st-secondary-container text-st-on-secondary-container', bar: 'bg-st-secondary' },
  ON_BREAK: { chip: 'bg-st-primary-fixed text-st-on-primary-fixed-variant', bar: 'bg-st-primary-container' },
  COMPLETED: { chip: 'bg-st-tertiary-fixed text-st-on-tertiary-fixed', bar: 'bg-st-tertiary-container' },
  NOT_IN: { chip: 'bg-st-high text-st-on-variant', bar: 'bg-st-outline' },
  LATE_NOT_IN: { chip: 'bg-st-error-container text-st-on-error-container', bar: 'bg-st-error' },
  ON_LEAVE: { chip: 'bg-st-container text-st-on-variant', bar: 'bg-st-outline' },
  HOLIDAY: { chip: 'bg-st-tertiary-fixed/70 text-st-on-tertiary-fixed', bar: 'bg-st-tertiary-container' },
  WEEKLY_OFF: { chip: 'bg-st-high text-st-on-variant', bar: 'bg-st-outline' },
  UNRESOLVED: { chip: 'bg-st-high text-st-on-variant', bar: 'bg-st-outline' },
};
const toneOf = (p) => PRESENCE_TONE[p] || PRESENCE_TONE.NOT_IN;

const MODE_LABEL = {
  OFFICE: 'In office',
  WFH: 'Remote / WFH',
  FIELD: 'Field',
  CLIENT_SITE: 'Client site',
  BUSINESS_TRAVEL: 'Travel',
};
const MODE_ICON = {
  OFFICE: Building2,
  WFH: Briefcase,
  FIELD: MapPin,
  CLIENT_SITE: Users,
  BUSINESS_TRAVEL: Plane,
};

const EXCEPTION_LABEL = {
  LATE_ARRIVAL: 'Late arrival',
  EARLY_EXIT: 'Early exit',
  MISSING_PUNCH: 'Missing punch',
  REGULARIZATION_PENDING: 'Correction pending',
  ATTENDANCE_ON_LEAVE: 'Worked on leave',
  STALE_OPEN_SESSION: 'Open session needs closing',
};

const fmtClock = (value) => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const fmtDay = (value) => {
  if (!value) return 'Today';
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
};

const fmtSpan = (totalMinutes) => {
  const minutes = Math.max(0, Math.floor(Number(totalMinutes) || 0));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) return `${rest}m`;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
};

const liveMinutes = (fromIso) => {
  if (!fromIso) return 0;
  const ms = Date.now() - new Date(fromIso).getTime();
  if (Number.isNaN(ms) || ms < 0) return 0;
  return Math.floor(ms / 60000);
};

const initialsOf = (name = '') =>
  String(name)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || '?';

const windowMinutes = (schedule) => {
  if (!schedule?.startTime || !schedule?.endTime) return null;
  const toMin = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const span = (toMin(schedule.endTime) - toMin(schedule.startTime) + 1440) % 1440;
  return span || 1440;
};

const agoText = (when) => {
  if (!when) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - when.getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
};

const KpiTile = ({ icon: Icon, label, value, hint, tone, bar }) => (
  <div className="rounded-xl bg-st-lowest p-4 shadow-sm">
    <div className="flex items-start justify-between">
      <span className="text-[10px] font-bold uppercase tracking-wider text-st-on-variant">{label}</span>
      <Icon className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" />
    </div>
    <div className="mt-1.5 flex items-baseline gap-1.5">
      <span className="text-2xl font-bold text-st-on">{value}</span>
      <span className="text-[10px] font-semibold text-st-on-variant">{hint}</span>
    </div>
    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-st-high">
      <div className={`h-full rounded-full ${bar}`} style={{ width: `${tone}%` }} />
    </div>
  </div>
);

const PersonCard = ({ row, expanded, onToggle }) => {
  const presenceLabel = PRESENCE_LABEL[row.presence] || row.presence;
  const tone = toneOf(row.presence);
  const ModeIcon = MODE_ICON[row.workMode] || null;
  const target = windowMinutes(row.schedule);
  const worked =
    row.presence === 'WORKING'
      ? liveMinutes(row.clockInAt)
      : row.presence === 'ON_BREAK'
        ? liveMinutes(row.clockInAt)
        : Number(row.workedMinutes) || 0;
  const progress = target ? Math.min(100, (worked / target) * 100) : 0;
  const isLive = row.presence === 'WORKING' || row.presence === 'ON_BREAK';

  return (
    <article
      className="relative flex flex-col gap-3 overflow-hidden rounded-xl bg-st-lowest p-4 shadow-sm"
      aria-label={`${row.user.name} — ${presenceLabel}`}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${tone.bar}`} aria-hidden="true" />

      <div className="flex items-start gap-2.5">
        {row.user.avatarUrl ? (
          <img src={row.user.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-st-secondary-container text-[11px] font-bold text-st-on-secondary-container"
          >
            {initialsOf(row.user.name)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-bold text-st-on">{row.user.name}</span>
            {row.user.employeeCode ? (
              <span className="shrink-0 rounded bg-st-low px-1 py-0.5 font-mono text-[9px] font-semibold text-st-on-variant">
                {row.user.employeeCode}
              </span>
            ) : null}
          </div>
          <div className="truncate text-[10px] text-st-on-variant">
            {[row.user.designation, row.user.department?.name].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${tone.chip}`}>
          {isLive ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" /> : null}
          {presenceLabel}
        </span>
        {row.workMode && ModeIcon ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-st-low px-2 py-0.5 text-[9px] font-semibold text-st-on-variant">
            <ModeIcon className="h-2.5 w-2.5" aria-hidden="true" />
            {MODE_LABEL[row.workMode] || row.workMode}
          </span>
        ) : null}
        {row.late?.isLate ? (
          <span className="rounded-full bg-st-error-container px-2 py-0.5 text-[9px] font-bold text-st-on-error-container">
            {row.late.lateMinutes}m late
          </span>
        ) : null}
      </div>

      <dl className="space-y-1 text-[11px]">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-st-on-variant">Clock-in</dt>
          <dd className="font-semibold text-st-on">{fmtClock(row.clockInAt)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-st-on-variant">Shift</dt>
          <dd className="font-semibold text-st-on">
            {row.schedule && !row.scheduleUnresolved
              ? `${row.schedule.startTime}–${row.schedule.endTime}`
              : 'No roster'}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-st-on-variant">{row.presence === 'ON_BREAK' ? 'Break' : 'Elapsed'}</dt>
          <dd className="font-semibold text-st-on">
            {row.presence === 'ON_BREAK'
              ? fmtSpan(liveMinutes(row.breakStartedAt))
              : row.presence === 'COMPLETED'
                ? fmtSpan(row.workedMinutes)
                : fmtSpan(worked)}
            {target ? <span className="font-normal text-st-on-variant"> / {fmtSpan(target)}</span> : null}
          </dd>
        </div>
      </dl>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-st-high">
        <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${progress}%` }} />
      </div>

      <div className="flex items-center justify-between gap-2 text-[10px] text-st-on-variant">
        <span className="inline-flex min-w-0 items-center gap-1">
          <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{row.locationName || 'No site recorded'}</span>
        </span>
        {row.presence === 'ON_LEAVE' ? (
          <span className="truncate">{row.calendar?.leaveLabel || 'On leave'}</span>
        ) : (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="inline-flex shrink-0 items-center gap-0.5 font-semibold text-st-secondary hover:underline"
          >
            View log
            <ChevronDown className={`h-3 w-3 transition ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
        )}
      </div>

      {(row.exceptions?.length > 0 || row.ot?.pending) && (
        <div className="flex flex-wrap gap-1">
          {(row.exceptions || []).map((code) => (
            <span key={code} className="inline-flex items-center gap-1 rounded bg-st-error-container/70 px-1.5 py-0.5 text-[9px] font-semibold text-st-on-error-container">
              <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
              {EXCEPTION_LABEL[code] || code}
            </span>
          ))}
          {row.ot?.pending ? (
            <span className="rounded bg-st-primary-fixed px-1.5 py-0.5 text-[9px] font-semibold text-st-on-primary-fixed-variant">
              OT pending
            </span>
          ) : null}
        </div>
      )}

      {expanded ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-st-high pt-2 text-[10px]">
          <div>
            <dt className="text-st-on-variant">Roster</dt>
            <dd className="font-medium text-st-on">
              {row.schedule
                ? `${row.schedule.shiftName || row.schedule.scheduleName || 'Scheduled'}${row.schedule.crossesMidnight ? ' (+1 day)' : ''}`
                : 'Not resolved'}
            </dd>
          </div>
          <div>
            <dt className="text-st-on-variant">In / out</dt>
            <dd className="font-medium text-st-on">
              {fmtClock(row.clockInAt)} / {fmtClock(row.clockOutAt)}
            </dd>
          </div>
          <div>
            <dt className="text-st-on-variant">Worked / break</dt>
            <dd className="font-medium text-st-on">
              {fmtSpan(row.workedMinutes)} / {fmtSpan(row.breakMinutes)}
            </dd>
          </div>
          <div>
            <dt className="text-st-on-variant">Day context</dt>
            <dd className="font-medium text-st-on">
              {[
                row.calendar?.primary === 'HOLIDAY' ? 'Holiday' : null,
                row.calendar?.primary === 'WEEKLY_OFF' ? 'Weekly off' : null,
                row.calendar?.leaveLabel ? 'Leave' : null,
                row.calendar?.primary === 'WORK_DAY' && !row.calendar?.leaveLabel ? 'Work day' : null,
              ]
                .filter(Boolean)
                .join(' · ') || '—'}
            </dd>
          </div>
          <div>
            <dt className="text-st-on-variant">Flags</dt>
            <dd className="font-medium text-st-on">
              {[row.regularized ? 'Corrected day' : null, row.needsReview ? 'Needs review' : null]
                .filter(Boolean)
                .join(' · ') || '—'}
            </dd>
          </div>
          <div>
            <dt className="text-st-on-variant">Business date</dt>
            <dd className="font-medium text-st-on">{row.businessDate}</dd>
          </div>
        </dl>
      ) : null}
    </article>
  );
};

const AttendanceTeamPage = () => {
  const { hasPermission, loading: permissionsLoading } = usePermission();
  const canView = hasPermission('ATTENDANCE_READ');

  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [departments, setDepartments] = useState([]);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [presence, setPresence] = useState('');
  const [workMode, setWorkMode] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [expanded, setExpanded] = useState({});
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const requestSeq = useRef(0);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!canView) return;
      const seq = requestSeq.current + 1;
      requestSeq.current = seq;
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const result = await attendanceService.presence({
          search,
          departmentId,
          presence,
          workMode,
          page,
          pageSize,
        });
        if (requestSeq.current !== seq) return;
        setBoard(result || null);
        setError('');
        setLastRefreshed(new Date());
      } catch (e) {
        if (requestSeq.current !== seq) return;
        setError(e?.message || 'Could not load team presence');
      } finally {
        if (requestSeq.current === seq) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [canView, search, departmentId, presence, workMode, page, pageSize],
  );

  useEffect(() => {
    departmentService.getAll().then(setDepartments).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  useEffect(() => {
    if (!canView) return undefined;
    const poll = () => {
      if (!document.hidden) load({ silent: true });
    };
    const onVisibility = () => {
      if (!document.hidden) load({ silent: true });
    };
    const timer = setInterval(poll, REFRESH_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, [canView, load]);

  const resetPage = (setter) => (value) => {
    setter(value);
    setPage(1);
  };

  const toggleExpanded = (id) => setExpanded((current) => ({ ...current, [id]: !current[id] }));

  const counts = board?.counts || {};
  const modes = counts.modes || {};
  const rows = useMemo(() => board?.rows || [], [board]);

  /* Modality split over the people actually on the clock — a share of a real
     count, so an empty board reads 0% rather than dividing by zero. */
  const onSite = (modes.OFFICE || 0) + (modes.WFH || 0) + (modes.FIELD || 0) + (modes.CLIENT_SITE || 0) + (modes.BUSINESS_TRAVEL || 0);
  const shareOf = (n) => (onSite ? Math.round(((n || 0) / onSite) * 100) : 0);

  const attention = useMemo(
    () => rows.filter((row) => (row.exceptions?.length || 0) > 0 || row.needsReview),
    [rows],
  );

  if (permissionsLoading) {
    return <div className="st-surface p-6 text-sm text-st-on-variant">Loading…</div>;
  }

  if (!canView) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 shadow-sm">
          <h1 className="text-xl font-bold text-st-on">Who&apos;s working</h1>
          <p className="mt-2 text-sm text-st-on-variant">
            Team presence is visible to managers, team leads and HR. Your own live attendance stays on
            the Attendance page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-6">
        {/* ── hero ─────────────────────────────────────────────────────── */}
        <section className="relative overflow-hidden rounded-xl bg-st-low p-6 shadow-sm md:p-7">
          <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-st-secondary-fixed/40 blur-3xl" />
          <div className="relative flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
            <div className="max-w-2xl space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-st-secondary-container px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-st-on-secondary-container">
                  Real-time presence
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-st-on-variant">
                  <ShieldCheck className="h-3 w-3" aria-hidden="true" /> Consensual &amp; privacy-first
                </span>
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-st-on lg:text-4xl">
                Who&apos;s working {board?.date ? `· ${fmtDay(board.date)}` : 'today'}
              </h1>
              <p className="max-w-xl text-sm leading-relaxed text-st-on-variant">
                Attendance presence across {board?.scope?.type === 'COMPANY' ? 'the whole company' : 'your reporting line'} —
                clock-ins, breaks, leave and holidays. Built from the roster and the punch log, never
                from activity tracking.
              </p>
            </div>

            <div className="flex shrink-0 flex-col items-stretch gap-2">
              <div className="flex items-center justify-between gap-3 rounded-lg bg-st-lowest px-3 py-2 shadow-sm">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-st-on">
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 rounded-full ${refreshing ? 'bg-st-primary-container' : 'animate-pulse bg-st-secondary'}`}
                  />
                  Live sync {agoText(lastRefreshed)}
                </span>
                <button
                  type="button"
                  onClick={() => load({ silent: true })}
                  disabled={loading || refreshing}
                  className="rounded p-1 text-st-on-variant transition hover:text-st-on disabled:opacity-50"
                  aria-label="Refresh presence"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <button
                type="button"
                disabled
                title="No attendance export endpoint is published for this workspace yet."
                className="inline-flex cursor-not-allowed items-center justify-center gap-1.5 rounded-lg bg-st-lowest px-3 py-2 text-[11px] font-semibold text-st-on-variant/70 shadow-sm"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" /> Export presence log
              </button>
              <Link
                to="/app/attendance/report"
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-st-primary-container px-3 py-2 text-[11px] font-bold text-st-on-primary-container shadow-sm transition hover:opacity-95"
              >
                <Users className="h-3.5 w-3.5" aria-hidden="true" /> Open the roster audit
              </Link>
            </div>
          </div>
        </section>

        {error ? (
          <div className="flex items-center gap-3 rounded-lg bg-st-error-container px-4 py-3 text-xs font-medium text-st-on-error-container">
            {error}
            <button
              type="button"
              onClick={() => load()}
              className="rounded bg-st-lowest px-2.5 py-1 text-[11px] font-bold text-st-on"
            >
              Retry
            </button>
          </div>
        ) : null}

        {/* ── the seven counters ───────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <KpiTile
            icon={UserCheck}
            label="Working now"
            value={counts.working || 0}
            hint="active"
            tone={shareOf(counts.working)}
            bar="bg-st-secondary"
          />
          <KpiTile
            icon={Coffee}
            label="On break"
            value={counts.onBreak || 0}
            hint="staff"
            tone={shareOf(counts.onBreak)}
            bar="bg-st-primary-container"
          />
          <KpiTile
            icon={CheckCircle2}
            label="Completed"
            value={counts.completed || 0}
            hint="done"
            tone={board?.total ? ((counts.completed || 0) / board.total) * 100 : 0}
            bar="bg-st-tertiary-container"
          />
          <KpiTile
            icon={Clock}
            label="Not yet in"
            value={counts.notIn || 0}
            hint="expected"
            tone={board?.total ? ((counts.notIn || 0) / board.total) * 100 : 0}
            bar="bg-st-outline"
          />
          <KpiTile
            icon={Timer}
            label="Late arrival"
            value={counts.lateNotIn || 0}
            hint="not in"
            tone={board?.total ? ((counts.lateNotIn || 0) / board.total) * 100 : 0}
            bar="bg-st-primary"
          />
          <KpiTile
            icon={CalendarOff}
            label="On leave"
            value={counts.onLeave || 0}
            hint="approved"
            tone={board?.total ? ((counts.onLeave || 0) / board.total) * 100 : 0}
            bar="bg-st-secondary-fixed-dim"
          />
          <KpiTile
            icon={AlertTriangle}
            label="Action required"
            value={counts.exceptions || 0}
            hint="needs closing"
            tone={board?.total ? ((counts.exceptions || 0) / board.total) * 100 : 0}
            bar="bg-st-error"
          />
        </div>

        {/* ── filters ──────────────────────────────────────────────────── */}
        <section className="rounded-xl bg-st-lowest p-4 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <label className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-st-outline"
                aria-hidden="true"
              />
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                maxLength={60}
                placeholder="Filter by name, employee code or role…"
                className="w-full rounded-lg bg-st-low py-2 pl-9 pr-3 text-xs text-st-on placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                aria-label="Search people"
              />
            </label>

            <select
              value={departmentId}
              onChange={(e) => resetPage(setDepartmentId)(e.target.value)}
              className="rounded-lg bg-st-low px-3 py-2 text-xs font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
              aria-label="Department"
            >
              <option value="">All departments ({departments.length})</option>
              {(departments || []).map((dept) => (
                <option key={dept._id} value={dept._id}>
                  {dept.name}
                </option>
              ))}
            </select>

            <select
              value={presence}
              onChange={(e) => resetPage(setPresence)(e.target.value)}
              className="rounded-lg bg-st-low px-3 py-2 text-xs font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
              aria-label="Status"
            >
              <option value="">All statuses</option>
              {Object.entries(PRESENCE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            <select
              value={pageSize}
              onChange={(e) => resetPage(setPageSize)(Number(e.target.value))}
              className="rounded-lg bg-st-low px-3 py-2 text-xs font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
              aria-label="Per page"
            >
              {[10, 25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size} per page
                </option>
              ))}
            </select>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-st-outline">
              <Filter className="h-3 w-3" aria-hidden="true" /> Work mode
            </span>
            {[
              ['', 'All locations', onSite],
              ['OFFICE', 'In office', modes.OFFICE || 0],
              ['WFH', 'Remote / WFH', modes.WFH || 0],
              ['FIELD', 'Field / client site', (modes.FIELD || 0) + (modes.CLIENT_SITE || 0)],
            ].map(([key, label, n]) => (
              <button
                key={key || 'all'}
                type="button"
                onClick={() => resetPage(setWorkMode)(key)}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                  workMode === key
                    ? 'bg-st-secondary-container text-st-on-secondary-container'
                    : 'bg-st-low text-st-on-variant hover:text-st-on'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${key ? 'bg-st-secondary' : 'bg-st-primary-container'}`} />
                {label} ({n})
              </button>
            ))}
            <span className="ml-auto text-[10px] text-st-on-variant">
              Showing {rows.length} of {board?.total ?? 0} in scope
            </span>
          </div>
        </section>

        {/* ── the board ────────────────────────────────────────────────── */}
        {loading && !board ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((key) => (
              <div key={key} className="animate-pulse rounded-xl bg-st-lowest p-4 shadow-sm">
                <div className="h-4 w-2/3 rounded bg-st-high" />
                <div className="mt-2 h-3 w-1/3 rounded bg-st-high" />
              </div>
            ))}
          </div>
        ) : null}

        {board && !rows.length && !loading ? (
          <div className="rounded-xl bg-st-lowest shadow-sm">
            <EmptyState
              illustration="search"
              title="Nobody matches this view"
              description="No one in your reporting line fits the search and filters you have set. Clear them to see the full team."
            />
          </div>
        ) : null}

        {rows.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {rows.map((row) => (
              <PersonCard
                key={row.user.id}
                row={row}
                expanded={!!expanded[row.user.id]}
                onToggle={() => toggleExpanded(row.user.id)}
              />
            ))}
          </div>
        ) : null}

        {board && board.totalPages > 1 ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11px] text-st-on-variant">
              Page {board.page} of {board.totalPages} · {board.total} people
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-lg bg-st-low px-3 py-1.5 text-[11px] font-semibold text-st-on-variant transition hover:bg-st-container hover:text-st-on disabled:opacity-40"
                disabled={board.page <= 1 || loading}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="rounded-lg bg-st-low px-3 py-1.5 text-[11px] font-semibold text-st-on-variant transition hover:bg-st-container hover:text-st-on disabled:opacity-40"
                disabled={board.page >= board.totalPages || loading}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </button>
            </div>
          </div>
        ) : null}

        {/* ── three closing cards ──────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <div className="rounded-xl bg-st-lowest p-5 shadow-sm">
            <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
              Presence by modality
              <span className="ml-auto text-[10px] font-medium text-st-on-variant">
                {board?.total ?? 0} in scope
              </span>
            </h2>
            <div className="mt-4 flex items-center gap-5">
              <div className="relative h-28 w-28 shrink-0">
                <svg viewBox="0 0 100 100" className="h-28 w-28 -rotate-90" role="img" aria-label="Share on site">
                  <circle cx="50" cy="50" r="40" fill="none" strokeWidth="14" className="stroke-st-high" />
                  {onSite ? (
                    <circle
                      cx="50"
                      cy="50"
                      r="40"
                      fill="none"
                      strokeWidth="14"
                      strokeLinecap="round"
                      className="stroke-st-secondary"
                      strokeDasharray={`${(shareOf(modes.OFFICE) / 100) * 251} 251`}
                    />
                  ) : null}
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-lg font-bold text-st-on">{shareOf(modes.OFFICE)}%</span>
                  <span className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                    in office
                  </span>
                </div>
              </div>
              <ul className="min-w-0 flex-1 space-y-1.5 text-[11px]">
                {[
                  ['Office', modes.OFFICE || 0],
                  ['Remote / WFH', modes.WFH || 0],
                  ['Field', (modes.FIELD || 0) + (modes.CLIENT_SITE || 0)],
                  ['Travel', modes.BUSINESS_TRAVEL || 0],
                ].map(([label, n]) => (
                  <li key={label} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-st-on-variant">
                      <span className="h-2 w-2 rounded-full bg-st-secondary-fixed-dim" />
                      {label}
                    </span>
                    <span className="font-bold text-st-on">{n}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="mt-3 text-[10px] leading-relaxed text-st-on-variant">
              Counts only the people currently on the clock — people on leave or not yet in have no
              modality to report.
            </p>
          </div>

          <div className="rounded-xl bg-st-lowest p-5 shadow-sm">
            <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
              Floor capacity
              <span className="ml-auto rounded-full bg-st-high px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                Not configured
              </span>
            </h2>
            <div className="mt-4 space-y-2">
              {[
                ['Desks per site', 'No inventory is held'],
                ['Air quality / occupancy sensors', 'No integration'],
                ['Badge-swipe occupancy', 'Turnstiles not wired'],
              ].map(([title, note]) => (
                <div key={title} className="rounded-lg bg-st-low px-3 py-2">
                  <p className="text-[11px] font-semibold text-st-on">{title}</p>
                  <p className="text-[10px] text-st-on-variant">{note}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-st-on-variant">
              <Wifi className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              Showing an occupancy figure here would mean inventing a desk register, so the card states
              that it has none.
            </p>
          </div>

          <div className="rounded-xl bg-st-lowest p-5 shadow-sm">
            <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
              Operational attention
              {attention.length ? (
                <span className="ml-auto rounded-full bg-st-error-container px-2 py-0.5 text-[9px] font-bold text-st-on-error-container">
                  {attention.length}
                </span>
              ) : (
                <span className="ml-auto flex items-center gap-1 text-[10px] font-semibold text-st-secondary">
                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Clear
                </span>
              )}
            </h2>
            <ul className="mt-3 space-y-2">
              {attention.slice(0, 3).map((row) => (
                <li key={row.user.id} className="rounded-lg bg-st-error-container/40 px-3 py-2">
                  <p className="text-[11px] font-bold text-st-on">{row.user.name}</p>
                  <p className="text-[10px] text-st-on-variant">
                    {(row.exceptions || []).map((code) => EXCEPTION_LABEL[code] || code).join(' · ') ||
                      'Needs review'}
                  </p>
                  <Link
                    to="/app/attendance/regularizations"
                    className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-bold text-st-primary hover:underline"
                  >
                    Resolve <ChevronRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </li>
              ))}
              {!attention.length ? (
                <li className="rounded-lg border border-dashed border-st-high px-3 py-4 text-center text-[10px] text-st-on-variant">
                  No unresolved sessions or late marks in this view.
                </li>
              ) : null}
            </ul>
            {attention.length > 3 ? (
              <p className="mt-2 text-[10px] text-st-on-variant">
                {attention.length - 3} more in the roster audit.
              </p>
            ) : null}
          </div>
        </div>

        <p className="flex items-start gap-2 rounded-xl bg-st-low px-4 py-3 text-[11px] leading-relaxed text-st-on-variant">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-st-secondary" aria-hidden="true" />
          <span>
            <strong className="font-semibold text-st-on">Presence, not surveillance.</strong> Crewly shows
            attendance presence — clock-ins, breaks, leave and holidays. It never reads keystrokes,
            screenshots, camera feeds or background activity, and it shows no coordinates on this board.
          </span>
        </p>
      </div>
    </div>
  );
};

export default AttendanceTeamPage;
