import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BadgeCheck,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Coffee,
  Download,
  Info,
  RefreshCw,
  Search,
  Timer,
  TrendingUp,
  UserX,
  Users,
  X,
} from 'lucide-react';
import attendanceService from '../../services/attendanceService.js';
import departmentService from '../../services/departmentService.js';
import { roleLabel } from '../../utils/roles.js';
import { notify } from '../../utils/notify.js';
import { TableEmpty } from '../../components/common/EmptyState.jsx';

const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
const todayStr = () => new Date().toLocaleDateString('en-CA');
const currentMonth = () => new Date().toISOString().slice(0, 7);

const longDate = (value) => {
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};

const chipDate = (value) => {
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
};

const monthLabel = (month) => {
  const [year, mon] = String(month || '').split('-').map(Number);
  if (!year || !mon) return 'This month';
  return new Date(Date.UTC(year, mon - 1, 1)).toLocaleDateString([], {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

const initialsOf = (name = '') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '—';

/* One tone per person, chosen from the name so it never shuffles between
   renders or between the two tabs. */
const AVATAR_TONES = [
  'bg-crewly-green/15 text-crewly-green',
  'bg-crewly-accent/20 text-crewly-orange',
  'bg-crewly-inset-strong text-crewly-text',
  'bg-crewly-orange/15 text-crewly-orange',
  'bg-crewly-dim/20 text-crewly-dim',
];
const toneFor = (key = '') => {
  let sum = 0;
  for (let i = 0; i < key.length; i += 1) sum += key.charCodeAt(i);
  return AVATAR_TONES[sum % AVATAR_TONES.length];
};

/* A counted number with its caption — the tile the rest of the app uses. */
const Tile = ({ icon: Icon, label, value, sub, tone = 'dim', valueTone = '', className = '' }) => {
  const tones = {
    green: 'bg-crewly-green/12 text-crewly-green',
    orange: 'bg-crewly-orange/12 text-crewly-orange',
    red: 'bg-crewly-red/12 text-crewly-red',
    dim: 'bg-crewly-inset text-crewly-dim',
  };
  const valueTones = {
    green: 'text-crewly-green',
    orange: 'text-crewly-orange',
    red: 'text-crewly-red',
  };
  return (
    <div className={`flex items-center gap-3 bg-crewly-card p-3.5 ${className}`}>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tones[tone] || tones.dim}`}>
        <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">{label}</p>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <p className={`text-2xl font-bold leading-tight ${valueTones[valueTone] || ''}`}>{value}</p>
          {sub ? (
            <p className={`text-[11px] font-semibold ${valueTones[valueTone] || 'text-crewly-dim'}`}>{sub}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const ScoreBar = ({ pct, days, workingDays }) => {
  const value = Math.max(0, Math.min(100, Number(pct) || 0));
  const bar = value >= 80 ? 'bg-crewly-green' : value >= 60 ? 'bg-crewly-orange' : 'bg-crewly-red';
  const text = value >= 80 ? 'text-crewly-green' : value >= 60 ? 'text-crewly-orange' : 'text-crewly-red';
  return (
    <div className="w-28">
      <div className="flex items-baseline justify-between gap-2 text-[10px] font-bold">
        <span className={text}>{value}%</span>
        <span className="text-crewly-dim">
          {days ?? 0}
          {workingDays ? `/${workingDays}` : ''}d
        </span>
      </div>
      <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-crewly-inset-strong">
        <span className={`block h-full rounded-full ${bar}`} style={{ width: `${value}%` }} />
      </span>
    </div>
  );
};

const AttendanceReportPage = () => {
  const [tab, setTab] = useState('today');
  const [date, setDate] = useState(todayStr());
  const [month, setMonth] = useState(currentMonth());
  const [department, setDepartment] = useState('');
  const [departments, setDepartments] = useState([]);
  const [query, setQuery] = useState('');
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [todayData, setTodayData] = useState(null);
  const [report, setReport] = useState(null);
  const [monthRows, setMonthRows] = useState({ month: null, rows: null });
  const [loadedAt, setLoadedAt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  useEffect(() => {
    departmentService.getAll().then(setDepartments).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab !== 'today') return;
    let alive = true;
    const run = async () => {
      setBusy(true);
      try {
        const data = await attendanceService.company(date);
        if (!alive) return;
        setTodayData(data);
        setLoadedAt(new Date());
      } catch (e) {
        notify.error(e);
      } finally {
        if (alive) setBusy(false);
      }
    };
    run();
    return () => {
      alive = false;
    };
  }, [tab, date, reloadKey]);

  /* The day matrix carries a month score, which only the monthly report knows.
     It is read for the same month as the chosen date and shown only when it
     arrives — never guessed from today's single punch. */
  const dayMonth = date.slice(0, 7);
  useEffect(() => {
    if (tab !== 'today') return;
    let alive = true;
    attendanceService
      .report(dayMonth, '')
      .then((data) => alive && setMonthRows({ month: dayMonth, rows: data?.rows || [] }))
      .catch(() => alive && setMonthRows({ month: dayMonth, rows: [] }));
    return () => {
      alive = false;
    };
  }, [tab, dayMonth, reloadKey]);

  useEffect(() => {
    if (tab !== 'monthly') return;
    let alive = true;
    const run = async () => {
      setBusy(true);
      try {
        const data = await attendanceService.report(month, department);
        if (!alive) return;
        setReport(data);
        setLoadedAt(new Date());
      } catch (e) {
        notify.error(e);
      } finally {
        if (alive) setBusy(false);
      }
    };
    run();
    return () => {
      alive = false;
    };
  }, [tab, month, department, reloadKey]);

  const departmentName = useMemo(
    () => departments.find((d) => String(d._id) === String(department))?.name || '',
    [departments, department],
  );

  const scoreById = useMemo(() => {
    const rows = tab === 'today' && monthRows.month === dayMonth ? monthRows.rows || [] : [];
    return Object.fromEntries(rows.map((r) => [String(r.user?._id), r]));
  }, [monthRows, tab, dayMonth]);

  /* Filters narrow what the server already returned — nothing is refetched, so
     the counts above and the table below can never disagree. */
  const todayRows = useMemo(() => {
    const rows = todayData?.rows || [];
    const needle = query.trim().toLowerCase();
    return rows.filter(({ user }) => {
      if (departmentName && user.department?.name !== departmentName) return false;
      if (!needle) return true;
      const haystack = `${user.name} ${user.department?.name || ''} ${user.email || ''} ${roleLabel(user.role)}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [todayData, query, departmentName]);

  const monthlyRows = useMemo(() => {
    const rows = report?.rows || [];
    const needle = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (!needle) return true;
      const haystack = `${r.user.name} ${r.user.department?.name || ''} ${r.user.email || ''} ${roleLabel(r.user.role)}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [report, query]);

  const rowsOnScreen = tab === 'today' ? todayRows : monthlyRows;
  const totalRows = tab === 'today' ? todayData?.rows.length || 0 : report?.rows.length || 0;
  const pageCount = Math.max(1, Math.ceil(rowsOnScreen.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pagedRows = rowsOnScreen.slice((safePage - 1) * pageSize, safePage * pageSize);
  const firstShown = rowsOnScreen.length ? (safePage - 1) * pageSize + 1 : 0;
  const lastShown = Math.min(safePage * pageSize, rowsOnScreen.length);

  /* a new filter starts a new list, so the page counter cannot outlive it */
  const filterKey = `${tab}|${date}|${month}|${department}|${query}|${pageSize}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

  const totals = useMemo(() => {
    const rows = monthlyRows;
    const sum = (pick) => rows.reduce((acc, row) => acc + (Number(pick(row)) || 0), 0);
    const present = sum((r) => r.present);
    const minutes = sum((r) => r.totalMinutes);
    return {
      present,
      late: sum((r) => r.late),
      halfDay: sum((r) => r.halfDay),
      absent: sum((r) => r.absent),
      people: rows.length,
      hours: minutes ? (minutes / 60).toFixed(1) : '0',
      avgPerPresentDay: present ? (minutes / 60 / present).toFixed(1) : null,
      avgPct: rows.length
        ? Math.round(rows.reduce((acc, r) => acc + (Number(r.attendancePct) || 0), 0) / rows.length)
        : null,
      fullScore: rows.filter((r) => Number(r.attendancePct) >= 100).length,
      belowThreshold: rows.filter((r) => Number(r.attendancePct) < 75).length,
      workingDays: rows.reduce((acc, r) => Math.max(acc, Number(r.workingDays) || 0), 0),
    };
  }, [monthlyRows]);

  const monthSourceRows = useMemo(
    () => (tab === 'today' ? monthRows.rows || [] : monthlyRows),
    [tab, monthRows, monthlyRows],
  );
  const monthSourceLabel = tab === 'today' ? `${monthLabel(dayMonth)} so far` : monthLabel(month);

  const departmentBreakdown = useMemo(() => {
    const groups = new Map();
    monthSourceRows.forEach((row) => {
      const name = row.user?.department?.name || 'No department';
      const acc = groups.get(name) || { name, present: 0, working: 0, people: 0 };
      acc.present += Number(row.present) || 0;
      acc.working += Number(row.workingDays) || 0;
      acc.people += 1;
      groups.set(name, acc);
    });
    return [...groups.values()]
      .map((g) => ({ ...g, pct: g.working ? Math.round((g.present / g.working) * 100) : 0 }))
      .sort((a, b) => b.pct - a.pct);
  }, [monthSourceRows]);

  const monthMetrics = useMemo(() => {
    const rows = monthSourceRows;
    const present = rows.reduce((acc, r) => acc + (Number(r.present) || 0), 0);
    const minutes = rows.reduce((acc, r) => acc + (Number(r.totalMinutes) || 0), 0);
    return {
      avgDay: present ? (minutes / 60 / present).toFixed(1) : null,
      totalHours: minutes ? (minutes / 60).toFixed(1) : '0',
      fullScore: rows.filter((r) => Number(r.attendancePct) >= 100).length,
      below: rows.filter((r) => Number(r.attendancePct) < 75).length,
      people: rows.length,
    };
  }, [monthSourceRows]);

  const c = todayData?.counts;

  const exportCSV = () => {
    const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    let header;
    let lines;
    let name;
    if (tab === 'monthly') {
      if (!monthlyRows.length) return;
      header = 'Name,Role,Department,Present,Late,Half Day,Absent,Hours,Attendance %';
      lines = monthlyRows.map((r) =>
        [
          r.user.name,
          roleLabel(r.user.role),
          r.user.department?.name || '',
          r.present,
          r.late,
          r.halfDay,
          r.absent,
          (r.totalMinutes / 60).toFixed(1),
          r.attendancePct,
        ].map(cell).join(','),
      );
      name = `attendance-${month}`;
    } else {
      if (!todayRows.length) return;
      header = 'Name,Role,Department,Punch in,Punch out,Breaks,Approved OT,Shift,Hours,Status,Month score';
      lines = todayRows.map(({ user, record }) => {
        const score = scoreById[String(user._id)];
        return [
          user.name,
          roleLabel(user.role),
          user.department?.name || '',
          record ? fmtTime(record.regularization?.correctedIn || record.punchIn) : '',
          record ? fmtTime(record.regularization?.correctedOut || record.punchOut) : '',
          record?.breakMinutes ? `${record.breakMinutes}m` : '',
          record?.overtimeMinutes ? `${record.overtimeMinutes}m` : '',
          record?.scheduleSnapshot?.scheduledMinutes ? `${(record.scheduleSnapshot.scheduledMinutes / 60).toFixed(1)}h` : '',
          record?.workMinutes ? (record.workMinutes / 60).toFixed(1) : '',
          record?.status || (record?.punchOut ? 'DONE' : record ? 'ON_DUTY' : 'NOT_PUNCHED'),
          score ? score.attendancePct : '',
        ].map(cell).join(',');
      });
      name = `attendance-${date}`;
    }
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const canExport = rowsOnScreen.length > 0;

  const tiles =
    tab === 'today'
      ? [
          { icon: BadgeCheck, label: 'On duty', value: c ? c.punchedIn : '—', sub: 'Present', tone: 'green', valueTone: 'green' },
          { icon: CheckCircle2, label: 'Done shifts', value: c ? c.punchedOut : '—', sub: 'Shift ended', tone: 'dim' },
          { icon: Clock, label: 'Late in', value: c ? c.late : '—', sub: 'Shift start missed', tone: 'orange', valueTone: 'orange' },
          { icon: UserX, label: 'Absent / unpunched', value: c ? c.absent : '—', sub: 'Action req.', tone: 'red', valueTone: 'red' },
          { icon: Users, label: 'Total headcount', value: c ? c.total : '—', sub: 'On roster', tone: 'dim' },
        ]
      : [
          { icon: CheckCircle2, label: 'Present days', value: report ? totals.present : '—', sub: `${totals.people} people`, tone: 'green', valueTone: 'green' },
          { icon: Clock, label: 'Late days', value: report ? totals.late : '—', sub: 'Shift start missed', tone: 'orange', valueTone: 'orange' },
          { icon: Coffee, label: 'Half days', value: report ? totals.halfDay : '—', sub: 'Short or split', tone: 'dim' },
          { icon: UserX, label: 'Absent days', value: report ? totals.absent : '—', sub: `${totals.workingDays} working days`, tone: 'red', valueTone: 'red' },
          { icon: TrendingUp, label: 'Avg score', value: report ? `${totals.avgPct ?? 0}%` : '—', sub: 'Mean attendance', tone: 'dim' },
        ];

  return (
    <div className="space-y-6">
      {/* ── title block ────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-bold sm:text-3xl">Attendance reports</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-crewly-green/12 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-crewly-green">
              <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
              {loadedAt
                ? `Snapshot ${loadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : 'Loading'}
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-crewly-dim">
            {tab === 'today'
              ? `Every punch on ${longDate(date)}, with the shift each one was judged against.`
              : `${monthLabel(month)} across ${department ? 'the selected department' : 'every department'}.`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex rounded-xl border border-crewly-border bg-crewly-inset p-1" role="tablist" aria-label="Report period">
            {[
              ['today', "Today's status", CalendarDays],
              ['monthly', 'Monthly report', CalendarRange],
            ].map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition ${
                  tab === key
                    ? 'bg-crewly-card text-crewly-text shadow-sm'
                    : 'text-crewly-dim hover:text-crewly-text'
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={exportCSV}
            disabled={!canExport}
            className="btn-ghost inline-flex items-center gap-2 whitespace-nowrap px-3.5 py-2 text-xs font-bold disabled:opacity-50"
            title={tab === 'today' ? `Download ${date} as CSV` : `Download ${monthLabel(month)} as CSV`}
          >
            <Download className="h-4 w-4" aria-hidden="true" /> Export CSV
          </button>
        </div>
      </div>

      {/* ── KPI ribbon ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-3 overflow-hidden rounded-xl sm:grid-cols-3 xl:grid-cols-5">
        {tiles.map((tile, index) => (
          <Tile
            key={tile.label}
            {...tile}
            className={`rounded-xl border border-crewly-border ${
              index === tiles.length - 1 && tiles.length % 2 === 1 ? 'col-span-2 sm:col-span-1' : ''
            }`}
          />
        ))}
      </div>

      {/* ── filter bar ─────────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-1 flex-wrap items-center gap-2.5">
            <label className="relative block min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crewly-dim" aria-hidden="true" />
              <input
                className="input w-full pl-8 pr-8"
                placeholder="Search employee or department"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search people"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-crewly-dim transition hover:text-crewly-text"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </label>

            {tab === 'today' ? (
              <label className="flex items-center gap-2 rounded-lg bg-crewly-inset px-3 py-2 text-xs">
                <CalendarDays className="h-4 w-4 shrink-0 text-crewly-orange" aria-hidden="true" />
                <span className="sr-only">Date</span>
                <input
                  type="date"
                  className="w-[122px] bg-transparent font-semibold outline-none"
                  value={date}
                  max={todayStr()}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
            ) : (
              <label className="flex items-center gap-2 rounded-lg bg-crewly-inset px-3 py-2 text-xs">
                <CalendarRange className="h-4 w-4 shrink-0 text-crewly-orange" aria-hidden="true" />
                <span className="sr-only">Month</span>
                <input
                  type="month"
                  className="w-[118px] bg-transparent font-semibold outline-none"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                />
              </label>
            )}

            <label className="flex items-center gap-2 rounded-lg bg-crewly-inset px-3 py-2 text-xs">
              <Users className="h-4 w-4 shrink-0 text-crewly-green" aria-hidden="true" />
              <span className="sr-only">Department</span>
              <select
                className="max-w-[180px] bg-transparent font-semibold outline-none"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
              >
                <option value="">All departments</option>
                {departments.map((d) => (
                  <option key={d._id} value={d._id}>
                    {d.name}
                  </option>
                ))}
              </select>
              {departments.length ? (
                <span className="rounded-full bg-crewly-green/15 px-1.5 text-[10px] font-bold text-crewly-green">
                  {departments.length}
                </span>
              ) : null}
            </label>
          </div>

          <div className="flex items-center gap-3 text-[11px] text-crewly-dim">
            <span>
              Showing <span className="font-semibold text-crewly-text">{rowsOnScreen.length}</span> of {totalRows}{' '}
              records
            </span>
            <button
              type="button"
              onClick={reload}
              disabled={busy}
              className="inline-flex items-center gap-1 font-semibold text-crewly-green transition hover:opacity-80 disabled:opacity-50"
              title="Read the same day again"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* ── roster matrix ──────────────────────────────────────────────── */}
      <section className="card overflow-hidden p-0">
        <div className="flex flex-col gap-2 border-b border-crewly-border bg-crewly-inset/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-crewly-accent/15 text-crewly-orange">
              <Users className="h-4 w-4" aria-hidden="true" />
            </span>
            <h2 className="card-title text-xs font-bold uppercase tracking-[0.1em]">
              {tab === 'today' ? 'Daily roster audit matrix' : 'Monthly attendance matrix'}
            </h2>
            <span className="rounded-full bg-crewly-inset px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-crewly-dim">
              {tab === 'today' ? chipDate(date) : monthLabel(month)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-crewly-dim">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-crewly-green" aria-hidden="true" />Present
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-crewly-orange" aria-hidden="true" />On leave
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-crewly-red" aria-hidden="true" />Not punched
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-crewly-border bg-crewly-inset/30 text-[10px] uppercase tracking-[0.1em] text-crewly-dim">
                <th className="whitespace-nowrap px-4 py-2.5 font-semibold">Employee</th>
                <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Department</th>
                {tab === 'today' ? (
                  <>
                    <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Punch in</th>
                    <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Punch out</th>
                    <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Breaks / OT</th>
                    <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Work hours</th>
                    <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Live status</th>
                    <th className="min-w-[124px] whitespace-nowrap px-3 py-2.5 font-semibold">Month score</th>
                    <th className="whitespace-nowrap px-4 py-2.5 text-right font-semibold">Action</th>
                  </>
                ) : (
                  <>
                    <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">Present</th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">Late</th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">Half</th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">Absent</th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">Hours</th>
                    <th className="min-w-[124px] whitespace-nowrap px-3 py-2.5 font-semibold">Month score</th>
                    <th className="whitespace-nowrap px-4 py-2.5 text-right font-semibold">Action</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {tab === 'today' &&
                pagedRows.map(({ user, record, reconciliation }) => {
                  const score = scoreById[String(user._id)];
                  const shiftMinutes = Number(record?.scheduleSnapshot?.scheduledMinutes) || null;
                  return (
                    <tr key={user._id} className="border-b border-crewly-border/50 transition hover:bg-crewly-inset/40 last:border-0">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${toneFor(String(user._id || user.name))}`}>
                            {initialsOf(user.name)}
                          </span>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate font-semibold">{user.name}</span>
                              <span className="rounded bg-crewly-inset-strong px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-crewly-dim">
                                {roleLabel(user.role)}
                              </span>
                            </div>
                            <p className="truncate text-[11px] text-crewly-dim">
                              {user.designation || user.department?.name || user.email || '—'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">
                        <span className="rounded-md bg-crewly-inset px-2 py-1 text-[11px]">
                          {user.department?.name || '—'}
                        </span>
                      </td>
                      {/* effective times win for display; the recorded punch stays one hover away */}
                      <td className="whitespace-nowrap px-3 py-3 font-mono text-[12px] font-semibold text-crewly-green">
                        {fmtTime(record?.regularization?.correctedIn || record?.punchIn)}
                        {record?.regularization?.correctedIn && (
                          <span className="ml-1" title={`Recorded: ${fmtTime(record?.punchIn)}`}>*</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 font-mono text-[12px] text-crewly-dim">
                        {fmtTime(record?.regularization?.correctedOut || record?.punchOut)}
                        {record?.regularization?.correctedOut && (
                          <span className="ml-1 text-crewly-green" title={`Recorded: ${fmtTime(record?.punchOut)}`}>*</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-[11px] text-crewly-dim">
                        {record?.breakMinutes || record?.overtimeMinutes ? (
                          <span className="space-x-1.5">
                            {record?.breakMinutes ? <span>{record.breakMinutes}m break</span> : null}
                            {record?.overtimeMinutes ? (
                              <span className="text-crewly-green">{record.overtimeMinutes}m OT</span>
                            ) : null}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">
                        <span className="font-mono font-bold">
                          {record?.workMinutes ? `${(record.workMinutes / 60).toFixed(1)}h` : '0.0h'}
                        </span>
                        <span className="block text-[10px] text-crewly-dim">
                          {shiftMinutes ? `of ${(shiftMinutes / 60).toFixed(1)}h shift` : 'no shift on record'}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1">
                          {!record && reconciliation?.leave?.portion && reconciliation.leave.portion !== 'NONE' && (
                            <span className="badge bg-crewly-orange/15 text-crewly-orange" title={reconciliation.leave.label || ''}>
                              On leave
                            </span>
                          )}
                          {!record && (!reconciliation?.leave?.portion || reconciliation.leave.portion === 'NONE') && reconciliation?.calendar?.primary === 'HOLIDAY' && (
                            <span className="badge bg-crewly-inset-strong text-crewly-dim" title={reconciliation.calendar.holiday?.name || ''}>
                              Holiday
                            </span>
                          )}
                          {!record && (!reconciliation?.leave?.portion || reconciliation.leave.portion === 'NONE') && reconciliation?.calendar?.primary === 'WEEKLY_OFF' && (
                            <span className="badge bg-crewly-inset-strong text-crewly-dim">Weekly off</span>
                          )}
                          {!record && (!reconciliation || (reconciliation.leave?.portion === 'NONE' && reconciliation.calendar?.primary === 'WORK_DAY')) && (
                            <span className="badge bg-crewly-red/15 text-crewly-red">Not punched</span>
                          )}
                          {record && !record.punchOut && <span className="badge bg-crewly-green/15 text-crewly-green">Present</span>}
                          {record?.punchOut && <span className="badge bg-crewly-inset-strong text-crewly-dim">Done</span>}
                          {record?.status === 'LATE' && <span className="badge bg-crewly-orange/15 text-crewly-orange">Late</span>}
                          {record?.status === 'HALF_DAY' && <span className="badge bg-crewly-accent/15 text-crewly-orange">Half day</span>}
                          {record?.regularized && (
                            <span className="badge bg-crewly-green/15 text-crewly-green" title="An approved correction overlays this day">
                              Regularized
                            </span>
                          )}
                          {reconciliation?.conflicts?.length > 0 && (
                            <span className="badge bg-crewly-red/15 text-crewly-red" title={reconciliation.conflicts.join(', ')}>
                              Needs review
                            </span>
                          )}
                          {reconciliation?.nonWorkingDayWorked && reconciliation.calendar?.primary === 'HOLIDAY' && (
                            <span className="badge bg-crewly-orange/15 text-crewly-orange" title={reconciliation.calendar.holiday?.name || ''}>
                              Worked on holiday
                            </span>
                          )}
                          {reconciliation?.nonWorkingDayWorked && reconciliation.calendar?.primary === 'WEEKLY_OFF' && (
                            <span className="badge bg-crewly-orange/15 text-crewly-orange">Worked on weekly off</span>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">
                        {score ? (
                          <div title={`${score.present} of ${score.workingDays} days present in ${monthLabel(dayMonth)}`}>
                            <ScoreBar pct={score.attendancePct} days={score.present} workingDays={score.workingDays} />
                          </div>
                        ) : (
                          <span className="text-[11px] text-crewly-dim">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <a
                          href={`/app/attendance/regularizations?date=${date}`}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-crewly-border px-2 py-1 text-[11px] font-semibold text-crewly-text transition hover:bg-crewly-inset"
                          title={`Request a correction for ${user.name} on ${chipDate(date)}`}
                        >
                          <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                          Correct
                        </a>
                      </td>
                    </tr>
                  );
                })}

              {tab === 'monthly' &&
                pagedRows.map((r) => (
                  <tr key={r.user._id} className="border-b border-crewly-border/50 transition hover:bg-crewly-inset/40 last:border-0">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${toneFor(String(r.user._id || r.user.name))}`}>
                          {initialsOf(r.user.name)}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate font-semibold">{r.user.name}</span>
                            <span className="rounded bg-crewly-inset-strong px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-crewly-dim">
                              {roleLabel(r.user.role)}
                            </span>
                          </div>
                          <p className="truncate text-[11px] text-crewly-dim">{r.user.designation || r.user.email || '—'}</p>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <span className="rounded-md bg-crewly-inset px-2 py-1 text-[11px]">
                        {r.user.department?.name || '—'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-mono font-semibold text-crewly-green">{r.present}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-mono font-semibold text-crewly-orange">{r.late}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-mono">{r.halfDay}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-mono font-semibold text-crewly-red">{r.absent}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-mono">
                      {r.totalMinutes ? `${(r.totalMinutes / 60).toFixed(1)}h` : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <ScoreBar pct={r.attendancePct} days={r.present} workingDays={r.workingDays} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <a
                        href={`/app/attendance/regularizations?date=${month}-01`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-crewly-border px-2 py-1 text-[11px] font-semibold text-crewly-text transition hover:bg-crewly-inset"
                        title={`Request a correction in ${monthLabel(month)}`}
                      >
                        <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                        Correct
                      </a>
                    </td>
                  </tr>
                ))}

              {tab === 'today' && rowsOnScreen.length === 0 && (
                <TableEmpty
                  colSpan={9}
                  illustration={todayData?.rows.length ? 'search' : 'chart'}
                  title={
                    !todayData
                      ? 'Reading the roster'
                      : todayData.rows.length
                        ? 'Nobody matches this view'
                        : 'No roster for this date'
                  }
                  description={
                    !todayData
                      ? 'The day’s punches are on their way.'
                      : todayData.rows.length
                        ? 'Clear the search or department filter to bring the whole roster back.'
                        : 'Crewly has no one on the roster for this date. Pick another day.'
                  }
                />
              )}
              {tab === 'monthly' && rowsOnScreen.length === 0 && (
                <TableEmpty
                  colSpan={9}
                  illustration={report?.rows.length ? 'search' : 'chart'}
                  title={report?.rows.length ? 'No team members found' : 'Nothing recorded this month'}
                  description={
                    report?.rows.length
                      ? "Nothing matches this report's filters. Clear the department or search box to bring people back."
                      : 'No punches have been recorded for this month yet. An earlier month may have them.'
                  }
                />
              )}
            </tbody>
          </table>
        </div>

        {/* pagination footer */}
        <div className="flex flex-col gap-3 border-t border-crewly-border bg-crewly-inset/30 px-4 py-2.5 text-[11px] text-crewly-dim sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              <span>Rows per page</span>
              <select
                className="rounded-md border border-crewly-border bg-crewly-card px-1.5 py-1 text-[11px] font-semibold text-crewly-text outline-none"
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                aria-label="Rows per page"
              >
                {[10, 25, 50].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <span>
              {rowsOnScreen.length ? `${firstShown}–${lastShown}` : '0'} of {rowsOnScreen.length}{' '}
              {rowsOnScreen.length === 1 ? 'employee' : 'employees'}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="flex h-7 w-7 items-center justify-center rounded border border-crewly-border bg-crewly-card transition hover:bg-crewly-inset disabled:opacity-40"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {Array.from({ length: pageCount }, (_, i) => i + 1)
              .filter((n) => pageCount <= 7 || Math.abs(n - safePage) <= 1 || n === 1 || n === pageCount)
              .map((n, index, list) => (
                <span key={n} className="flex items-center gap-1">
                  {index > 0 && n - list[index - 1] > 1 ? <span className="px-0.5">…</span> : null}
                  <button
                    type="button"
                    onClick={() => setPage(n)}
                    aria-current={n === safePage ? 'page' : undefined}
                    className={`h-7 min-w-7 rounded px-1.5 text-[11px] font-semibold transition ${
                      n === safePage
                        ? 'bg-crewly-selected text-crewly-selected-text'
                        : 'border border-crewly-border bg-crewly-card hover:bg-crewly-inset'
                    }`}
                  >
                    {n}
                  </button>
                </span>
              ))}
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={safePage >= pageCount}
              className="flex h-7 w-7 items-center justify-center rounded border border-crewly-border bg-crewly-card transition hover:bg-crewly-inset disabled:opacity-40"
              aria-label="Next page"
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>

      {/* ── reading below the matrix ───────────────────────────────────── */}
      <div className="grid items-start gap-4 lg:grid-cols-3">
        <section className="card lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
                Attendance distribution
              </p>
              <h2 className="card-title text-base font-bold">Presence by department · {monthSourceLabel}</h2>
            </div>
            <span className="rounded-full bg-crewly-inset px-2.5 py-1 text-[11px] font-semibold text-crewly-dim">
              {monthMetrics.people} {monthMetrics.people === 1 ? 'person' : 'people'}
            </span>
          </div>

          {departmentBreakdown.length ? (
            <div className="mt-4 space-y-3">
              {departmentBreakdown.map((group) => (
                <div key={group.name}>
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="font-semibold">{group.name}</span>
                    <span className="text-[11px] text-crewly-dim">
                      {group.present} of {group.working} days ·{' '}
                      <span className="font-bold text-crewly-text">{group.pct}%</span>
                    </span>
                  </div>
                  <span className="mt-1 block h-2 overflow-hidden rounded-full bg-crewly-inset-strong">
                    <span
                      className={`block h-full rounded-full ${
                        group.pct >= 80 ? 'bg-crewly-green' : group.pct >= 60 ? 'bg-crewly-orange' : 'bg-crewly-red'
                      }`}
                      style={{ width: `${group.pct}%` }}
                    />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 rounded-lg border border-dashed border-crewly-border px-3 py-6 text-center text-xs text-crewly-dim">
              No department totals yet — they appear once the month has punches.
            </p>
          )}

          <div className="mt-5 grid gap-px overflow-hidden rounded-xl border border-crewly-border bg-crewly-border sm:grid-cols-3">
            <div className="flex items-center gap-2.5 bg-crewly-card p-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-crewly-green/12 text-crewly-green">
                <Timer className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <p className="text-[10px] text-crewly-dim">Avg daily hours</p>
                <p className="text-sm font-bold">{monthMetrics.avgDay ? `${monthMetrics.avgDay}h` : '—'}</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5 bg-crewly-card p-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-crewly-accent/15 text-crewly-orange">
                <BadgeCheck className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <p className="text-[10px] text-crewly-dim">Full attendance</p>
                <p className="text-sm font-bold">{monthMetrics.fullScore} {monthMetrics.fullScore === 1 ? 'person' : 'people'}</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5 bg-crewly-card p-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-crewly-red/12 text-crewly-red">
                <UserX className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <p className="text-[10px] text-crewly-dim">Below 75%</p>
                <p className="text-sm font-bold">{monthMetrics.below} {monthMetrics.below === 1 ? 'person' : 'people'}</p>
              </div>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-crewly-dim">
            {monthMetrics.totalHours}h recorded in {monthSourceLabel}. Days are counted from each
            person’s own roster, so a mid-month joiner is scored on the days they were expected.
          </p>
        </section>

        <section className="card">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
                Audit documentation
              </p>
              <h2 className="card-title text-base font-bold">How these numbers are built</h2>
            </div>
            <Info className="h-4 w-4 shrink-0 text-crewly-dim" aria-hidden="true" />
          </div>
          <ul className="mt-3 space-y-2 text-[11px] leading-relaxed text-crewly-dim">
            <li>· Every figure is read from the punch record for the chosen day or month.</li>
            <li>· Present, late and half day are the verdict stored on that record, judged against the shift in force.</li>
            <li>· Approved corrections replace the punch; the recorded time stays one hover away.</li>
            <li>· The month score is a person’s present days over their own working days.</li>
            <li>· Absent days are working days with no punch — a holiday or weekly off never counts.</li>
          </ul>
          <a
            href="/app/schedules"
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-crewly-inset px-3 py-2 text-xs font-bold text-crewly-text transition hover:bg-crewly-inset-strong"
          >
            <CalendarRange className="h-4 w-4" aria-hidden="true" />
            Review shifts &amp; schedules
          </a>
        </section>
      </div>
    </div>
  );
};

export default AttendanceReportPage;
