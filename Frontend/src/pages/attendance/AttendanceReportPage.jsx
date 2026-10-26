import { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  CheckCircle2,
  Clock,
  Coffee,
  Download,
  Info,
  Search,
  TrendingUp,
  Users,
  UserX,
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

/* A counted number with its caption — the same tile the rest of the app's
   censuses use, so a ribbon of five reads as one block. */
const Tile = ({ icon: Icon, label, value, sub, tone = 'dim', className = '' }) => {
  const tones = {
    green: 'bg-crewly-green/12 text-crewly-green',
    orange: 'bg-crewly-orange/12 text-crewly-orange',
    red: 'bg-crewly-red/12 text-crewly-red',
    dim: 'bg-crewly-inset text-crewly-dim',
  };
  return (
    <div className={`flex items-center gap-3 bg-crewly-card p-4 ${className}`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tones[tone] || tones.dim}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">{label}</p>
        <p className="mt-0.5 text-xl font-bold leading-tight">{value}</p>
        {sub ? <p className="mt-0.5 text-[11px] leading-snug text-crewly-dim">{sub}</p> : null}
      </div>
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
  const [todayData, setTodayData] = useState(null);
  const [report, setReport] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);

  useEffect(() => {
    departmentService.getAll().then(setDepartments).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab !== 'today') return;
    attendanceService
      .company(date)
      .then((data) => {
        setTodayData(data);
        setLoadedAt(new Date());
      })
      .catch((e) => notify.error(e));
  }, [tab, date]);

  useEffect(() => {
    if (tab !== 'monthly') return;
    attendanceService
      .report(month, department)
      .then((data) => {
        setReport(data);
        setLoadedAt(new Date());
      })
      .catch((e) => notify.error(e));
  }, [tab, month, department]);

  /* Filters narrow what the server already returned — nothing is refetched, so
     the counts below and the table can never disagree. */
  const departmentName = useMemo(
    () => departments.find((d) => String(d._id) === String(department))?.name || '',
    [departments, department],
  );

  const todayRows = useMemo(() => {
    const rows = todayData?.rows || [];
    const needle = query.trim().toLowerCase();
    return rows.filter(({ user }) => {
      if (departmentName && user.department?.name !== departmentName) return false;
      if (!needle) return true;
      const haystack = `${user.name} ${user.department?.name || ''} ${user.email || ''}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [todayData, query, departmentName]);

  const monthlyRows = useMemo(() => {
    const rows = report?.rows || [];
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => {
      const haystack = `${r.user.name} ${r.user.department?.name || ''} ${r.user.email || ''}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [report, query]);

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
      /* hours per present-day, not per head — the only reading the totals support */
      avgPerPresentDay: present ? (minutes / 60 / present).toFixed(1) : null,
      avgPct: rows.length
        ? Math.round(rows.reduce((acc, r) => acc + (Number(r.attendancePct) || 0), 0) / rows.length)
        : null,
      fullScore: rows.filter((r) => Number(r.attendancePct) >= 100).length,
      belowThreshold: rows.filter((r) => Number(r.attendancePct) < 75).length,
    };
  }, [monthlyRows]);

  const c = todayData?.counts;

  const missingToday = useMemo(
    () =>
      todayRows.filter(
        ({ record, reconciliation }) =>
          !record &&
          !(reconciliation?.leave?.portion && reconciliation.leave.portion !== 'NONE') &&
          !(reconciliation?.calendar?.primary === 'HOLIDAY' || reconciliation?.calendar?.primary === 'WEEKLY_OFF'),
      ),
    [todayRows],
  );

  const awayToday = useMemo(
    () =>
      todayRows.filter(
        ({ record, reconciliation }) =>
          !record && reconciliation?.leave?.portion && reconciliation.leave.portion !== 'NONE',
      ),
    [todayRows],
  );

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
      header = 'Name,Role,Department,Punch in,Punch out,Hours,Status';
      lines = todayRows.map(({ user, record }) =>
        [
          user.name,
          roleLabel(user.role),
          user.department?.name || '',
          record ? fmtTime(record.regularization?.correctedIn || record.punchIn) : '',
          record ? fmtTime(record.regularization?.correctedOut || record.punchOut) : '',
          record?.workMinutes ? (record.workMinutes / 60).toFixed(1) : '',
          record?.status || (record?.punchOut ? 'DONE' : record ? 'ON_DUTY' : 'NOT_PUNCHED'),
        ].map(cell).join(','),
      );
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

  const shown = tab === 'today' ? todayRows.length : monthlyRows.length;
  const total = tab === 'today' ? todayData?.rows.length || 0 : report?.rows.length || 0;
  const canExport = (tab === 'today' ? todayRows : monthlyRows).length > 0;

  const tiles =
    tab === 'today'
      ? [
          { icon: CheckCircle2, label: 'On duty', value: c ? c.punchedIn : '—', sub: c ? 'Clocked in, no punch out yet' : 'Loading…', tone: 'green' },
          { icon: Clock, label: 'Done shifts', value: c ? c.punchedOut : '—', sub: 'Punched in and out', tone: 'dim' },
          { icon: Coffee, label: 'Late in', value: c ? c.late : '—', sub: 'After the shift start', tone: 'orange' },
          { icon: UserX, label: 'Absent', value: c ? c.absent : '—', sub: 'Working day, no punch', tone: 'red' },
          { icon: Users, label: 'Headcount', value: c ? c.total : '—', sub: 'On this day’s roster', tone: 'dim' },
        ]
      : [
          { icon: CheckCircle2, label: 'Present days', value: report ? totals.present : '—', sub: report ? `Across ${totals.people} people` : 'Loading…', tone: 'green' },
          { icon: Clock, label: 'Late days', value: report ? totals.late : '—', sub: 'Shift start missed', tone: 'orange' },
          { icon: Coffee, label: 'Half days', value: report ? totals.halfDay : '—', sub: 'Short or split days', tone: 'dim' },
          { icon: UserX, label: 'Absent days', value: report ? totals.absent : '—', sub: report ? `${report.workingDays} working days` : 'Loading…', tone: 'red' },
          { icon: TrendingUp, label: 'Avg score', value: report ? `${totals.avgPct ?? 0}%` : '—', sub: report ? 'Mean attendance, this filter' : 'Loading…', tone: 'dim' },
        ];

  return (
    <div className="space-y-5">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-crewly-border bg-crewly-inset/50 p-4 sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-crewly-inset text-crewly-green">
            <TrendingUp className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold sm:text-2xl">Attendance report</h1>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-crewly-green/12 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-crewly-green">
                <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                {loadedAt
                  ? `Snapshot ${loadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                  : 'Loading'}
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-crewly-dim">
              {tab === 'today'
                ? `Who is on duty on ${longDate(date)}, straight from the punch record.`
                : `${monthLabel(month)} across ${department ? 'the selected department' : 'every department'}.`}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-crewly-border bg-crewly-card p-0.5" role="tablist" aria-label="Report period">
            {[
              ['today', 'Today'],
              ['monthly', 'Monthly'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  tab === key ? 'bg-crewly-green/15 text-crewly-green' : 'text-crewly-dim hover:text-crewly-text'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={exportCSV}
            disabled={!canExport}
            className="btn-ghost inline-flex items-center gap-2 whitespace-nowrap px-3 py-2 text-sm disabled:opacity-50"
            title={tab === 'today' ? `Download ${date} as CSV` : `Download ${monthLabel(month)} as CSV`}
          >
            <Download className="h-4 w-4" aria-hidden="true" /> Export CSV
          </button>
        </div>
      </div>

      {/* ── KPI ribbon ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-px overflow-hidden rounded-xl border border-crewly-border bg-crewly-border sm:grid-cols-3 xl:grid-cols-5">
        {tiles.map((tile, index) => (
          <Tile
            key={tile.label}
            {...tile}
            className={
              index === tiles.length - 1 && tiles.length % 2 === 1
                ? 'col-span-2 sm:col-span-1'
                : ''
            }
          />
        ))}
      </div>

      {/* ── filters ────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="block text-xs sm:w-52">
              <span className="mb-1 block font-semibold text-crewly-dim">Search</span>
              <span className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crewly-dim" aria-hidden="true" />
                <input
                  className="input w-full pl-8 pr-8"
                  placeholder="Name or department"
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
              </span>
            </label>

            {tab === 'today' ? (
              <label className="block text-xs sm:w-44">
                <span className="mb-1 block font-semibold text-crewly-dim">Date</span>
                <input
                  type="date"
                  className="input w-full"
                  value={date}
                  max={todayStr()}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
            ) : (
              <label className="block text-xs sm:w-40">
                <span className="mb-1 block font-semibold text-crewly-dim">Month</span>
                <input type="month" className="input w-full" value={month} onChange={(e) => setMonth(e.target.value)} />
              </label>
            )}

            <label className="block text-xs sm:w-52">
              <span className="mb-1 flex items-center justify-between gap-2 font-semibold text-crewly-dim">
                <span>Department</span>
                {departments.length ? (
                  <span className="rounded-full bg-crewly-inset px-1.5 text-[10px] font-bold text-crewly-dim">
                    {departments.length}
                  </span>
                ) : null}
              </span>
              <select className="input w-full" value={department} onChange={(e) => setDepartment(e.target.value)}>
                <option value="">All departments</option>
                {departments.map((d) => (
                  <option key={d._id} value={d._id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-crewly-dim">
            <span>
              Showing <span className="font-semibold text-crewly-text">{shown}</span> of {total}
            </span>
            {tab === 'monthly' && report ? (
              <span>· {report.workingDays} working days</span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="h-3 w-3" aria-hidden="true" />
                {date === todayStr() ? 'Today' : longDate(date)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── roster ─────────────────────────────────────────────────────── */}
      <section className="card overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-crewly-border bg-crewly-inset/40 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-crewly-accent/15 text-crewly-orange">
              <Users className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <h2 className="card-title text-sm font-bold">
                {tab === 'today' ? 'Roster status' : 'Month matrix'}
              </h2>
              <p className="text-[11px] text-crewly-dim">
                {tab === 'today'
                  ? 'The punch and the verdict for every person on the roster.'
                  : 'Days counted from each person’s own record.'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] uppercase tracking-wide text-crewly-dim">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-crewly-green" aria-hidden="true" />Present
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-crewly-orange" aria-hidden="true" />Late
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-crewly-red" aria-hidden="true" />Absent
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-crewly-dim" aria-hidden="true" />Away
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-crewly-border text-[10px] uppercase tracking-[0.1em] text-crewly-dim">
                <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Employee</th>
                <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Department</th>
                {tab === 'today' ? (
                  <>
                    <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Punch in</th>
                    <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Punch out</th>
                    <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Hours</th>
                    <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Status</th>
                  </>
                ) : (
                  <>
                    <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">Present</th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">Late</th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">Half</th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">Absent</th>
                    <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">Hours</th>
                    <th className="w-52 px-3 py-2.5 font-semibold">Month score</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {tab === 'today' &&
                todayRows.map(({ user, record, reconciliation }) => (
                  <tr key={user._id} className="border-b border-crewly-border/50 last:border-0">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-crewly-inset text-[11px] font-bold text-crewly-dim">
                          {initialsOf(user.name)}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{user.name}</p>
                          <p className="text-[11px] text-crewly-dim">{roleLabel(user.role)}</p>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-crewly-dim">{user.department?.name || '—'}</td>
                    {/* effective times win for display; the recorded punch stays one hover away */}
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {fmtTime(record?.regularization?.correctedIn || record?.punchIn)}
                      {record?.regularization?.correctedIn && (
                        <span className="ml-1 text-crewly-green" title={`Recorded: ${fmtTime(record?.punchIn)}`}>*</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {fmtTime(record?.regularization?.correctedOut || record?.punchOut)}
                      {record?.regularization?.correctedOut && (
                        <span className="ml-1 text-crewly-green" title={`Recorded: ${fmtTime(record?.punchOut)}`}>*</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {record?.workMinutes ? `${(record.workMinutes / 60).toFixed(1)}h` : '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {!record && reconciliation?.leave?.portion && reconciliation.leave.portion !== 'NONE' && (
                          <span className="badge bg-crewly-inset-strong text-crewly-dim" title={reconciliation.leave.label || ''}>
                            On leave
                          </span>
                        )}
                        {!record && (!reconciliation?.leave?.portion || reconciliation.leave.portion === 'NONE') && reconciliation?.calendar?.primary === 'HOLIDAY' && (
                          <span className="badge bg-crewly-orange/15 text-crewly-orange" title={reconciliation.calendar.holiday?.name || ''}>
                            Holiday
                          </span>
                        )}
                        {!record && (!reconciliation?.leave?.portion || reconciliation.leave.portion === 'NONE') && reconciliation?.calendar?.primary === 'WEEKLY_OFF' && (
                          <span className="badge bg-crewly-inset-strong text-crewly-dim">Weekly off</span>
                        )}
                        {!record && (!reconciliation || (reconciliation.leave?.portion === 'NONE' && reconciliation.calendar?.primary === 'WORK_DAY')) && (
                          <span className="badge bg-crewly-red/15 text-crewly-red">Not punched</span>
                        )}
                        {record && !record.punchOut && <span className="badge bg-crewly-green/15 text-crewly-green">On duty</span>}
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
                  </tr>
                ))}

              {tab === 'monthly' &&
                monthlyRows.map((r) => (
                  <tr key={r.user._id} className="border-b border-crewly-border/50 last:border-0">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-crewly-inset text-[11px] font-bold text-crewly-dim">
                          {initialsOf(r.user.name)}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{r.user.name}</p>
                          <p className="text-[11px] text-crewly-dim">{roleLabel(r.user.role)}</p>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-crewly-dim">{r.user.department?.name || '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right text-crewly-green">{r.present}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right text-crewly-orange">{r.late}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">{r.halfDay}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right text-crewly-red">{r.absent}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">{r.totalMinutes ? `${(r.totalMinutes / 60).toFixed(1)}h` : '—'}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="block h-1.5 w-full overflow-hidden rounded-full bg-crewly-inset-strong">
                          <span
                            className={`block h-full rounded-full ${
                              r.attendancePct >= 80 ? 'bg-crewly-green' : r.attendancePct >= 60 ? 'bg-crewly-orange' : 'bg-crewly-red'
                            }`}
                            style={{ width: `${Math.max(0, Math.min(100, Number(r.attendancePct) || 0))}%` }}
                          />
                        </span>
                        <span className="w-9 shrink-0 text-right text-[11px] font-semibold tabular-nums">{r.attendancePct}%</span>
                      </div>
                      <p className="mt-0.5 text-[10px] text-crewly-dim">
                        {r.present} of {r.workingDays} days present
                      </p>
                    </td>
                  </tr>
                ))}

              {tab === 'today' && todayRows.length === 0 && (
                <TableEmpty
                  colSpan={6}
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
              {tab === 'monthly' && monthlyRows.length === 0 && (
                <TableEmpty
                  colSpan={8}
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

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-crewly-border px-3 py-2.5 text-[11px] text-crewly-dim">
          <span>
            Showing {shown} of {total} {total === 1 ? 'person' : 'people'}
          </span>
          <span>{tab === 'today' ? longDate(date) : monthLabel(month)}</span>
        </div>
      </section>

      {/* ── secondary reading ──────────────────────────────────────────── */}
      <div className="grid items-start gap-4 lg:grid-cols-12">
        {tab === 'today' ? (
          <>
            <section className="card lg:col-span-7">
              <h2 className="card-title flex items-center gap-2 text-sm font-bold">
                <UserX className="h-4 w-4 text-crewly-dim" aria-hidden="true" />
                Who is not on the clock
              </h2>
              <p className="mt-0.5 text-[11px] text-crewly-dim">
                Working days with no punch. Approved leave is counted separately, so nobody is
                called absent while they are away.
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-crewly-red">
                    Not punched · {missingToday.length}
                  </p>
                  {missingToday.length ? (
                    <ul className="mt-1.5 space-y-1 text-xs">
                      {missingToday.slice(0, 8).map(({ user }) => (
                        <li key={user._id} className="flex items-center gap-2">
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-crewly-red/12 text-[9px] font-bold text-crewly-red">
                            {initialsOf(user.name)}
                          </span>
                          <span className="truncate">{user.name}</span>
                        </li>
                      ))}
                      {missingToday.length > 8 ? (
                        <li className="text-[11px] text-crewly-dim">and {missingToday.length - 8} more</li>
                      ) : null}
                    </ul>
                  ) : (
                    <p className="mt-1.5 text-xs text-crewly-dim">
                      {todayData?.rows.length
                        ? 'Everyone on a working day has punched.'
                        : 'No one is on this date’s roster.'}
                    </p>
                  )}
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-crewly-dim">
                    On leave · {awayToday.length}
                  </p>
                  {awayToday.length ? (
                    <ul className="mt-1.5 space-y-1 text-xs">
                      {awayToday.slice(0, 8).map(({ user, reconciliation }) => (
                        <li key={user._id} className="flex items-center gap-2">
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-crewly-inset-strong text-[9px] font-bold text-crewly-dim">
                            {initialsOf(user.name)}
                          </span>
                          <span className="truncate">{user.name}</span>
                          <span className="ml-auto shrink-0 text-[10px] text-crewly-dim">
                            {reconciliation.leave.portion === 'FULL_DAY' ? 'Full day' : 'Half day'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1.5 text-xs text-crewly-dim">No approved leave on this date.</p>
                  )}
                </div>
              </div>
            </section>

            <section className="card lg:col-span-5">
              <h2 className="card-title flex items-center gap-2 text-sm font-bold">
                <Info className="h-4 w-4 text-crewly-dim" aria-hidden="true" />
                How a status is decided
              </h2>
              <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-crewly-dim">
                <li>· On duty means a punch in with no punch out yet on this date.</li>
                <li>· Done means the session was closed; hours are the minutes in the record.</li>
                <li>· Late and half day compare the punch against the shift in force that day.</li>
                <li>· Not punched is a working day with no punch and no approved leave.</li>
              </ul>
            </section>
          </>
        ) : (
          <>
            <section className="card lg:col-span-7">
              <h2 className="card-title flex items-center gap-2 text-sm font-bold">
                <TrendingUp className="h-4 w-4 text-crewly-dim" aria-hidden="true" />
                What the month adds up to
              </h2>
              <div className="mt-3 grid gap-px overflow-hidden rounded-xl border border-crewly-border bg-crewly-border sm:grid-cols-3">
                <div className="bg-crewly-card p-3.5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">Avg day length</p>
                  <p className="mt-1 text-xl font-bold">{totals.avgPerPresentDay ? `${totals.avgPerPresentDay}h` : '—'}</p>
                  <p className="mt-0.5 text-[11px] text-crewly-dim">{totals.hours}h across present days</p>
                </div>
                <div className="bg-crewly-card p-3.5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">Full attendance</p>
                  <p className="mt-1 text-xl font-bold text-crewly-green">{totals.fullScore}</p>
                  <p className="mt-0.5 text-[11px] text-crewly-dim">People at 100% for {monthLabel(month)}</p>
                </div>
                <div className="bg-crewly-card p-3.5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">Below 75%</p>
                  <p className="mt-1 text-xl font-bold text-crewly-orange">{totals.belowThreshold}</p>
                  <p className="mt-0.5 text-[11px] text-crewly-dim">People to look at this month</p>
                </div>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-crewly-dim">
                Averages cover only the people in this filter. Days are counted from each person’s
                own record, so a joiner mid-month is scored on the days they were on the roster.
              </p>
            </section>

            <section className="card lg:col-span-5">
              <h2 className="card-title flex items-center gap-2 text-sm font-bold">
                <Info className="h-4 w-4 text-crewly-dim" aria-hidden="true" />
                Where these numbers come from
              </h2>
              <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-crewly-dim">
                <li>· Present, late, half day and absent are the verdict the record itself carries.</li>
                <li>· Hours are the worked minutes in those records, not the rostered shift.</li>
                <li>· The month score is a person’s present days over their own working days.</li>
                <li>· Approved corrections replace the punch; the original stays on the record.</li>
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
};

export default AttendanceReportPage;
