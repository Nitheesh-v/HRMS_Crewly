import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Briefcase,
  Building2,
  CalendarOff,
  CheckCircle2,
  ChevronDown,
  Clock,
  Coffee,
  MapPin,
  Moon,
  Plane,
  RefreshCw,
  Search,
  Timer,
  UserCheck,
  UserX,
  Users,
} from 'lucide-react';
import usePermission from '../../hooks/usePermission.js';
import attendanceService from '../../services/attendanceService.js';
import departmentService from '../../services/departmentService.js';

// Phase 31.9 — Who's Working: the live team attendance board.
// ATTENDANCE PRESENCE ONLY: every state here comes from punch
// facts, schedules, leave and holidays — never from computer
// activity, and the board shows no coordinates, no reasons and
// no payroll figures. Refresh is bounded polling (45s, visible
// tab only) plus manual refresh; durations tick client-side from
// authoritative server timestamps.

const REFRESH_MS = 45000;
const TICK_MS = 15000;

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

const PRESENCE_STYLE = {
  WORKING: 'bg-crewly-green/15 text-crewly-green',
  ON_BREAK: 'bg-crewly-orange/15 text-crewly-orange',
  COMPLETED: 'bg-blue-400/15 text-blue-300',
  NOT_IN: 'bg-white/10 text-crewly-dim',
  LATE_NOT_IN: 'bg-crewly-red/15 text-crewly-red',
  ON_LEAVE: 'bg-blue-400/15 text-blue-300',
  HOLIDAY: 'bg-crewly-orange/15 text-crewly-orange',
  WEEKLY_OFF: 'bg-white/10 text-crewly-dim',
  UNRESOLVED: 'bg-white/10 text-crewly-dim',
};

const MODE_LABEL = {
  OFFICE: 'Office',
  WFH: 'WFH',
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
  if (!value) return '';
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
};

const fmtSpan = (totalMinutes) => {
  const minutes = Math.max(0, Math.floor(Number(totalMinutes) || 0));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) return `${rest}m`;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
};

const liveSpan = (fromIso, tick) => {
  void tick;
  if (!fromIso) return null;
  const ms = Date.now() - new Date(fromIso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  return fmtSpan(ms / 60000);
};

const initialsOf = (name = '') =>
  String(name)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || '?';

const agoText = (when) => {
  if (!when) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - when.getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
};

const KpiCard = ({ icon: Icon, label, value, tone }) => (
  <div className="card flex items-center gap-3 px-4 py-3">
    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone}`}>
      <Icon aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
    </span>
    <span className="min-w-0">
      <span className="block text-xl font-bold leading-tight">{value}</span>
      <span className="block truncate text-xs text-crewly-dim">{label}</span>
    </span>
  </div>
);

const PersonCard = ({ row, expanded, onToggle, tick }) => {
  const presenceLabel = PRESENCE_LABEL[row.presence] || row.presence;
  const ModeIcon = MODE_ICON[row.workMode] || null;
  const workingFor = row.presence === 'WORKING' ? liveSpan(row.clockInAt, tick) : null;
  const breakFor = row.presence === 'ON_BREAK' ? liveSpan(row.breakStartedAt, tick) : null;
  const doneFor = row.presence === 'COMPLETED' ? fmtSpan(row.workedMinutes) : null;

  return (
    <article className="card space-y-2.5 p-4" aria-label={`${row.user.name} — ${presenceLabel}`}>
      <div className="flex items-start gap-3">
        {row.user.avatarUrl ? (
          <img
            src={row.user.avatarUrl}
            alt=""
            className="h-10 w-10 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-crewly-green/15 text-sm font-bold text-crewly-green"
          >
            {initialsOf(row.user.name)}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{row.user.name}</div>
          <div className="truncate text-xs text-crewly-dim">
            {[row.user.designation, row.user.department?.name].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
        <span className={`badge shrink-0 ${PRESENCE_STYLE[row.presence] || ''}`}>
          {row.presence === 'WORKING' && (
            <span aria-hidden="true" className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
          )}
          {presenceLabel}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-crewly-dim">
        {row.workMode && ModeIcon && (
          <span className="inline-flex items-center gap-1">
            <ModeIcon aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2} />
            {MODE_LABEL[row.workMode] || row.workMode}
          </span>
        )}
        {row.schedule && !row.scheduleUnresolved && (
          <span className="inline-flex items-center gap-1">
            <Clock aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2} />
            {row.schedule.startTime}–{row.schedule.endTime}
          </span>
        )}
        {row.scheduleUnresolved && row.presence !== 'ON_LEAVE' && (
          <span className="inline-flex items-center gap-1">
            <Moon aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2} />
            No schedule on file
          </span>
        )}
        {row.locationName && (
          <span className="inline-flex items-center gap-1">
            <Building2 aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2} />
            {row.locationName}
          </span>
        )}
      </div>

      <div className="text-xs text-crewly-dim">
        {row.presence === 'WORKING' && (
          <span>In {fmtClock(row.clockInAt)}{workingFor ? ` · working ${workingFor}` : ''}</span>
        )}
        {row.presence === 'ON_BREAK' && (
          <span>On break{breakFor ? ` · ${breakFor}` : ''} · in {fmtClock(row.clockInAt)}</span>
        )}
        {row.presence === 'COMPLETED' && (
          <span>{fmtClock(row.clockInAt)} – {fmtClock(row.clockOutAt)}{doneFor ? ` · worked ${doneFor}` : ''}</span>
        )}
        {(row.presence === 'NOT_IN' || row.presence === 'LATE_NOT_IN') && row.schedule?.scheduledStartAt && (
          <span>Shift starts {fmtClock(row.schedule.scheduledStartAt)}</span>
        )}
        {row.presence === 'ON_LEAVE' && (
          <span>{row.calendar?.leaveLabel || 'On leave'}</span>
        )}
        {row.presence === 'HOLIDAY' && (
          <span>{row.calendar?.holidayName || 'Holiday'}</span>
        )}
        {row.presence === 'WEEKLY_OFF' && <span>Weekly off</span>}
        {row.presence === 'UNRESOLVED' && <span>Shift not assigned yet</span>}
        {row.late?.isLate && (
          <span className="text-crewly-red"> · {row.late.lateMinutes}m past start</span>
        )}
      </div>

      {(row.presence === 'WORKING' || row.presence === 'ON_BREAK' || row.presence === 'COMPLETED') &&
        row.calendar?.primary === 'HOLIDAY' && (
          <div>
            <span className="badge bg-crewly-orange/15 text-crewly-orange">
              Working on holiday{row.calendar.holidayName ? ` · ${row.calendar.holidayName}` : ''}
            </span>
          </div>
        )}
      {(row.presence === 'WORKING' || row.presence === 'ON_BREAK' || row.presence === 'COMPLETED') &&
        row.calendar?.primary === 'WEEKLY_OFF' && (
          <div>
            <span className="badge bg-crewly-orange/15 text-crewly-orange">Working on weekly off</span>
          </div>
        )}

      {(row.exceptions?.length > 0 || row.ot?.pending || row.ot?.approved || row.ot?.compOffApproved) && (
        <div className="flex flex-wrap gap-1.5">
          {(row.exceptions || []).map((code) => (
            <span key={code} className="badge bg-crewly-red/15 text-crewly-red" title={code}>
              <AlertTriangle aria-hidden="true" className="mr-1 inline h-3 w-3" strokeWidth={2} />
              {EXCEPTION_LABEL[code] || code}
            </span>
          ))}
          {row.ot?.pending && (
            <span className="badge bg-blue-400/15 text-blue-300">
              <Timer aria-hidden="true" className="mr-1 inline h-3 w-3" strokeWidth={2} />
              OT pending
            </span>
          )}
          {row.ot?.approved && (
            <span className="badge bg-crewly-green/15 text-crewly-green">OT approved</span>
          )}
          {row.ot?.compOffApproved && (
            <span className="badge bg-crewly-green/15 text-crewly-green">Comp-off earned</span>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1 text-xs text-crewly-dim transition hover:text-crewly-text"
      >
        {expanded ? 'Hide details' : 'Day details'}
        <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 transition ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-crewly-border/60 pt-2.5 text-xs">
          <div>
            <dt className="text-crewly-dim">Shift</dt>
            <dd>
              {row.schedule
                ? `${row.schedule.shiftName || row.schedule.scheduleName || 'Scheduled'} · ${row.schedule.startTime}–${row.schedule.endTime}${row.schedule.crossesMidnight ? ' (+1 day)' : ''}`
                : 'Not resolved'}
            </dd>
          </div>
          <div>
            <dt className="text-crewly-dim">Clock in / out</dt>
            <dd>{fmtClock(row.clockInAt)} / {fmtClock(row.clockOutAt)}</dd>
          </div>
          <div>
            <dt className="text-crewly-dim">Worked / break</dt>
            <dd>{fmtSpan(row.workedMinutes)} / {fmtSpan(row.breakMinutes)}</dd>
          </div>
          <div>
            <dt className="text-crewly-dim">Day context</dt>
            <dd>
              {[
                row.calendar?.primary === 'HOLIDAY'
                  ? `Holiday${row.calendar.holidayName ? ` (${row.calendar.holidayName})` : ''}`
                  : null,
                row.calendar?.primary === 'WEEKLY_OFF' ? 'Weekly off' : null,
                row.calendar?.leaveLabel ? `Leave (${row.calendar.leaveLabel})` : null,
                row.calendar?.primary === 'WORK_DAY' && !row.calendar?.leaveLabel ? 'Work day' : null,
              ]
                .filter(Boolean)
                .join(' · ') || '—'}
            </dd>
          </div>
          <div>
            <dt className="text-crewly-dim">Flags</dt>
            <dd>
              {[row.regularized ? 'Corrected day' : null, row.needsReview ? 'Needs review' : null]
                .filter(Boolean)
                .join(' · ') || '—'}
            </dd>
          </div>
          <div>
            <dt className="text-crewly-dim">Business date</dt>
            <dd>{row.businessDate}</dd>
          </div>
        </dl>
      )}
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
  const [tick, setTick] = useState(0);
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

  // Debounced search (400ms) so every keystroke is not a request.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (!canView) {
      setLoading(false);
      return;
    }
    load();
  }, [canView, load]);

  // Bounded live refresh: every 45s while the tab is visible, on
  // refocus, and on manual request. Hidden tabs never poll.
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

  // Client-side duration ticker (display only — the server owns time).
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const resetPage = (setter) => (value) => {
    setter(value);
    setPage(1);
  };

  const toggleExpanded = (id) =>
    setExpanded((current) => ({ ...current, [id]: !current[id] }));

  if (permissionsLoading) {
    return <div className="p-6 text-crewly-dim">Loading…</div>;
  }

  if (!canView) {
    return (
      <div className="card space-y-2 p-6">
        <h1 className="text-xl font-bold">Who&apos;s Working</h1>
        <p className="text-sm text-crewly-dim">
          Team presence is visible to managers, team leads and HR. Your own live
          attendance stays on the Attendance page.
        </p>
      </div>
    );
  }

  const counts = board?.counts || {};
  const modes = counts.modes || {};

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Users aria-hidden="true" className="h-6 w-6 text-crewly-green" strokeWidth={2} />
            Who&apos;s Working
          </h1>
          <p className="mt-1 text-sm text-crewly-dim">
            {board?.date ? fmtDay(board.date) : 'Today'} · {board?.scope?.type === 'COMPANY' ? 'whole company' : 'your team'}
            {' '}· attendance presence only, never activity tracking
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-crewly-dim">
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 rounded-full ${refreshing ? 'bg-crewly-orange' : 'bg-crewly-green animate-pulse'}`}
          />
          <span>Updated {agoText(lastRefreshed)}</span>
          <button
            type="button"
            className="btn-ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
            onClick={() => load({ silent: true })}
            disabled={loading || refreshing}
          >
            <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
          {error}
          <button type="button" className="btn-ghost ml-3 px-3 py-1 text-xs" onClick={() => load()}>
            Retry
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        <KpiCard icon={UserCheck} label="Working now" value={counts.working || 0} tone="bg-crewly-green/10 text-crewly-green" />
        <KpiCard icon={Coffee} label="On break" value={counts.onBreak || 0} tone="bg-crewly-orange/10 text-crewly-orange" />
        <KpiCard icon={CheckCircle2} label="Completed" value={counts.completed || 0} tone="bg-blue-400/10 text-blue-300" />
        <KpiCard icon={Clock} label="Not yet in" value={counts.notIn || 0} tone="bg-white/10 text-crewly-dim" />
        <KpiCard icon={Timer} label="Late — not in" value={counts.lateNotIn || 0} tone="bg-crewly-red/10 text-crewly-red" />
        <KpiCard icon={CalendarOff} label="On leave" value={counts.onLeave || 0} tone="bg-blue-400/10 text-blue-300" />
        <KpiCard icon={AlertTriangle} label="Need attention" value={counts.exceptions || 0} tone="bg-crewly-red/10 text-crewly-red" />
      </div>

      {(modes.OFFICE > 0 || modes.WFH > 0 || modes.FIELD > 0 || modes.CLIENT_SITE > 0 || modes.BUSINESS_TRAVEL > 0) && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-crewly-dim">
          <span>Working from:</span>
          {modes.OFFICE > 0 && <span className="badge bg-white/10 text-crewly-dim">Office · {modes.OFFICE}</span>}
          {modes.WFH > 0 && <span className="badge bg-white/10 text-crewly-dim">WFH · {modes.WFH}</span>}
          {modes.FIELD > 0 && <span className="badge bg-white/10 text-crewly-dim">Field · {modes.FIELD}</span>}
          {modes.CLIENT_SITE > 0 && <span className="badge bg-white/10 text-crewly-dim">Client site · {modes.CLIENT_SITE}</span>}
          {modes.BUSINESS_TRAVEL > 0 && <span className="badge bg-white/10 text-crewly-dim">Travel · {modes.BUSINESS_TRAVEL}</span>}
        </div>
      )}

      <div className="card flex flex-wrap items-end gap-3">
        <div className="min-w-52 flex-1">
          <label className="label" htmlFor="team-search">Search</label>
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crewly-dim" />
            <input
              id="team-search"
              className="input pl-9"
              placeholder="Name, code or designation"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              maxLength={60}
            />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="team-dept">Department</label>
          <select id="team-dept" className="input" value={departmentId} onChange={(e) => resetPage(setDepartmentId)(e.target.value)}>
            <option value="">All departments</option>
            {(departments || []).map((dept) => (
              <option key={dept._id} value={dept._id}>{dept.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="team-presence">Status</label>
          <select id="team-presence" className="input" value={presence} onChange={(e) => resetPage(setPresence)(e.target.value)}>
            <option value="">All statuses</option>
            {Object.entries(PRESENCE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="team-mode">Work mode</label>
          <select id="team-mode" className="input" value={workMode} onChange={(e) => resetPage(setWorkMode)(e.target.value)}>
            <option value="">All modes</option>
            {Object.entries(MODE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
            <option value="NONE">No mode yet</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="team-size">Per page</label>
          <select id="team-size" className="input" value={pageSize} onChange={(e) => resetPage(setPageSize)(Number(e.target.value))}>
            {[10, 25, 50, 100].map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </div>
      </div>

      {loading && !board && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((key) => (
            <div key={key} className="card animate-pulse p-4">
              <div className="h-4 w-2/3 rounded bg-white/10" />
              <div className="mt-2 h-3 w-1/3 rounded bg-white/10" />
            </div>
          ))}
        </div>
      )}

      {board && board.rows.length === 0 && !loading && (
        <div className="card flex flex-col items-center gap-2 p-10 text-center">
          <UserX aria-hidden="true" className="h-8 w-8 text-crewly-dim" strokeWidth={1.6} />
          <p className="font-medium">Nobody matches this view</p>
          <p className="text-sm text-crewly-dim">Try clearing the search or filters.</p>
        </div>
      )}

      {board && board.rows.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {board.rows.map((row) => (
            <PersonCard
              key={row.user.id}
              row={row}
              tick={tick}
              expanded={!!expanded[row.user.id]}
              onToggle={() => toggleExpanded(row.user.id)}
            />
          ))}
        </div>
      )}

      {board && board.totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-crewly-dim">
            Page {board.page} of {board.totalPages} · {board.total} people
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-ghost px-3 py-1.5 text-xs"
              disabled={board.page <= 1 || loading}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn-ghost px-3 py-1.5 text-xs"
              disabled={board.page >= board.totalPages || loading}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-crewly-dim">
        Crewly shows attendance presence — clock-ins, breaks, leave and holidays.
        It never infers productivity or computer activity from this board.
      </p>
    </div>
  );
};

export default AttendanceTeamPage;
