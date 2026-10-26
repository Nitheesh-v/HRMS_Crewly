import { useEffect, useMemo, useState } from 'react';
import {
  AlarmClock,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  Clock,
  Coffee,
  Copy,
  Lock,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useSelector } from 'react-redux';
import scheduleService from '../../services/scheduleService';
import userService from '../../services/userService';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const emptyForm = {
  name: '',
  workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
  startTime: '09:00',
  endTime: '18:00',
  breakMinutes: 60,
  graceMinutes: 10,
  minWorkingHours: 8,
  halfDayHours: 4,
  overtimeEligible: false,
  lateGrace: 10,
  maxLatePerMonth: 3,
  earlyGrace: 10,
  branch: '',
};

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : 0;
};

/* Net hours the pattern asks for: the window minus the unpaid break, wrapped
   across midnight when the shift does. */
const netMinutes = (schedule) => {
  const span = (toMinutes(schedule.endTime) - toMinutes(schedule.startTime) + 1440) % 1440;
  if (!span) return 0;
  return Math.max(0, span - (Number(schedule.breakMinutes) || 0));
};

const categoryOf = (schedule) => {
  if ((toMinutes(schedule.endTime) - toMinutes(schedule.startTime) + 1440) % 1440 === 0) return 'OVERNIGHT';
  if (toMinutes(schedule.endTime) <= toMinutes(schedule.startTime)) return 'OVERNIGHT';
  if ((schedule.workingDays || []).length < 5) return 'PART_WEEK';
  return 'DAY';
};

const CATEGORY = {
  DAY: { label: 'Daytime', tone: 'bg-crewly-green/15 text-crewly-green' },
  OVERNIGHT: { label: 'Crosses midnight', tone: 'bg-crewly-accent/15 text-crewly-orange' },
  PART_WEEK: { label: 'Part week', tone: 'bg-crewly-inset-strong text-crewly-dim' },
};

const graceOf = (schedule) => Number(schedule.lateRule?.graceMinutes ?? schedule.graceMinutes ?? 0);
const earlyOf = (schedule) => Number(schedule.earlyCheckoutRule?.graceMinutes ?? schedule.graceMinutes ?? 0);
const staffOf = (schedule) => (schedule.employees || []).length;

const initials = (name = '') =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';

const SchedulesPage = () => {
  const user = useSelector((s) => s.auth.user);
  const isHR = ['COMPANY_ADMIN', 'HR_MANAGER'].includes(user?.role);
  const [schedules, setSchedules] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState('ALL');
  const [modal, setModal] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const d = await scheduleService.listSchedules();
      setSchedules(d.schedules || []);
      const deps = await scheduleService.getDepartments();
      setDepartments(deps.departments || []);
    } catch {
      /* api.js reports every failed request */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await scheduleService.listSchedules();
        if (!alive) return;
        setSchedules(d.schedules || []);
        const deps = await scheduleService.getDepartments();
        if (alive) setDepartments(deps.departments || []);
      } catch {
        /* api.js reports every failed request */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const openAssign = async (schedule) => {
    setModal({ mode: 'assign', id: schedule.id, schedule, selected: staffOf(schedule) });
    try {
      const res = await userService.getAll({ status: 'ACTIVE', limit: 200 });
      const rows = res?.data?.data || res?.data || [];
      setPeople(Array.isArray(rows) ? rows : rows.items || []);
    } catch {
      setPeople([]);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const f = modal.form;
      const payload = {
        name: f.name,
        workingDays: f.workingDays,
        startTime: f.startTime,
        endTime: f.endTime,
        breakMinutes: +f.breakMinutes,
        graceMinutes: +f.graceMinutes,
        minWorkingHours: +f.minWorkingHours,
        halfDayHours: +f.halfDayHours,
        overtimeEligible: !!f.overtimeEligible,
        branch: f.branch,
        departments: f.departments || [],
        lateRule: { graceMinutes: +f.lateGrace, maxLatePerMonth: +f.maxLatePerMonth },
        earlyCheckoutRule: { graceMinutes: +f.earlyGrace },
      };
      const r =
        modal.mode === 'create'
          ? await scheduleService.createSchedule(payload)
          : await scheduleService.updateSchedule(modal.id, payload);
      notify.successFrom(r, 'Schedule saved.');
      setModal(null);
      load();
    } catch {
      /* api.js reports every failed request */
    }
    setSaving(false);
  };

  const deactivate = async (schedule) => {
    if (!window.confirm(`Deactivate “${schedule.name}”?`)) return;
    try {
      const r = await scheduleService.deleteSchedule(schedule.id);
      notify.successFrom(r, 'Schedule deactivated.');
      load();
    } catch {
      /* api.js reports every failed request */
    }
  };

  const toggleDay = (day) => {
    const on = modal.form.workingDays.includes(day);
    setModal({
      ...modal,
      form: {
        ...modal.form,
        workingDays: on
          ? modal.form.workingDays.filter((d) => d !== day)
          : [...modal.form.workingDays, day],
      },
    });
  };

  const buckets = useMemo(() => {
    const count = (key) => schedules.filter((s) => categoryOf(s) === key).length;
    return [
      { key: 'ALL', label: 'All schedules', count: schedules.length },
      { key: 'DAY', label: 'Core daytime', count: count('DAY') },
      { key: 'OVERNIGHT', label: 'Crosses midnight', count: count('OVERNIGHT') },
      { key: 'PART_WEEK', label: 'Part week', count: count('PART_WEEK') },
    ];
  }, [schedules]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return schedules.filter((s) => {
      if (bucket !== 'ALL' && categoryOf(s) !== bucket) return false;
      if (!needle) return true;
      return `${s.name} ${s.branch || ''} ${(s.departments || []).map((d) => d.name).join(' ')}`
        .toLowerCase()
        .includes(needle);
    });
  }, [schedules, bucket, query]);

  const active = schedules.filter((s) => s.isActive);
  const staffTotal = schedules.reduce((acc, s) => acc + staffOf(s), 0);
  const defaultSchedule = useMemo(
    () => [...active].sort((a, b) => staffOf(b) - staffOf(a))[0] || null,
    [active],
  );

  const graceValues = active.map(graceOf);
  const earlyValues = active.map(earlyOf);
  const graceRange = graceValues.length
    ? Math.min(...graceValues) === Math.max(...graceValues)
      ? `${graceValues[0]} min`
      : `${Math.min(...graceValues)}–${Math.max(...graceValues)} min`
    : '—';
  const earlyRange = earlyValues.length
    ? Math.min(...earlyValues) === Math.max(...earlyValues)
      ? `${earlyValues[0]} min`
      : `${Math.min(...earlyValues)}–${Math.max(...earlyValues)} min`
    : '—';

  /* Floor coverage: sum of the people each active pattern puts on the floor in
     a given hour. Straight arithmetic over the schedules that exist. */
  const coverage = useMemo(() => {
    const hours = Array.from({ length: 17 }, (_, i) => i + 6); /* 06:00 → 22:00 */
    return hours.map((hour) => {
      const staff = active.reduce((acc, s) => {
        const start = toMinutes(s.startTime) / 60;
        const end = toMinutes(s.endTime) / 60;
        const wraps = end <= start;
        const inside = wraps ? hour >= start || hour < end : hour >= start && hour < end;
        return acc + (inside ? staffOf(s) : 0);
      }, 0);
      return { hour, staff };
    });
  }, [active]);
  const peak = coverage.reduce((best, point) => (point.staff > best.staff ? point : best), {
    hour: 0,
    staff: 0,
  });
  const peakHours = coverage.filter((p) => p.staff === peak.staff && peak.staff > 0);

  const fmtHour = (h) => `${String(h).padStart(2, '0')}:00`;

  const coveragePath = (close) => {
    const max = Math.max(1, ...coverage.map((c) => c.staff));
    const points = coverage.map((p, i) => ({
      x: (i / (coverage.length - 1)) * 640,
      y: 130 - (p.staff / max) * 110,
    }));
    if (!points.length) return '';
    let d = `M${points[0].x},${points[0].y}`;
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1];
      const cur = points[i];
      const cx = (prev.x + cur.x) / 2;
      d += ` C${cx},${prev.y} ${cx},${cur.y} ${cur.x},${cur.y}`;
    }
    return close ? `${d} L640,140 L0,140 Z` : d;
  };

  if (!isHR) {
    return (
      <div className="card flex items-start gap-3 p-5">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-crewly-dim" aria-hidden="true" />
        <p className="text-sm text-crewly-dim">
          Only an admin or HR manager manages work schedules. Your own pattern is on{' '}
          <a className="font-semibold text-crewly-green underline" href="/app/shifts">
            Shifts
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── title ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-crewly-dim">
            Operational cadence
            <span className="mx-2 text-crewly-border">•</span>
            {active.length} {active.length === 1 ? 'pattern' : 'patterns'} in force
          </p>
          <h1 className="mt-1 text-2xl font-bold sm:text-[28px]">Work schedules</h1>
          <p className="mt-1 max-w-2xl text-sm text-crewly-dim">
            Reusable working-day patterns — the hours, breaks and grace each group follows, and who
            is on each one.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="relative block min-w-[200px] flex-1 sm:flex-none">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crewly-dim"
              aria-hidden="true"
            />
            <input
              className="input w-full pl-8 sm:w-56"
              placeholder="Filter schedules"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter schedules"
            />
          </label>
          <button
            type="button"
            className="btn-ghost inline-flex items-center gap-2 whitespace-nowrap px-3 py-2 text-xs font-bold"
            onClick={() => document.getElementById('schedule-list')?.scrollIntoView({ behavior: 'smooth' })}
          >
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
            {buckets.filter((b) => b.key === bucket)[0]?.label || 'All'}
            <span className="rounded-full bg-crewly-inset-strong px-1.5 text-[10px]">{visible.length}</span>
          </button>
          <button
            type="button"
            onClick={() => setModal({ mode: 'create', form: { ...emptyForm, departments: [] } })}
            className="btn-primary inline-flex items-center gap-2 whitespace-nowrap px-4 py-2 text-xs font-bold"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> New schedule
          </button>
        </div>
      </div>

      {/* ── four readings of the same register ─────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <div className="card relative p-4">
          <span className="absolute right-3 top-3 rounded-full bg-crewly-green/12 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-crewly-green">
            Live config
          </span>
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-crewly-green/12 text-crewly-green">
            <CalendarDays className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
            Active patterns
          </p>
          <p className="mt-0.5 flex items-baseline gap-2">
            <span className="text-2xl font-bold">{active.length}</span>
            <span className="text-[11px] font-semibold text-crewly-green">Established</span>
          </p>
          <p className="mt-1 truncate text-[11px] text-crewly-dim">
            {active.map((s) => s.name).join(', ') || 'None yet'}
          </p>
        </div>

        <div className="card relative p-4">
          <span className="absolute right-3 top-3 rounded-full bg-crewly-accent/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-crewly-orange">
            {staffTotal ? `${Math.round(((defaultSchedule ? staffOf(defaultSchedule) : 0) / staffTotal) * 100)}% staff` : 'No staff'}
          </span>
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-crewly-accent/15 text-crewly-orange">
            <Users className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
            Largest assignment
          </p>
          <p className="mt-0.5 truncate text-lg font-bold leading-tight">
            {defaultSchedule?.name || '—'}
          </p>
          <p className="mt-1 text-[11px] text-crewly-dim">
            {defaultSchedule ? `${staffOf(defaultSchedule)} people on this pattern` : 'Nothing assigned yet'}
          </p>
        </div>

        <div className="card relative p-4">
          <span className="absolute right-3 top-3 rounded-full bg-crewly-inset-strong px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-crewly-dim">
            {graceValues.length && new Set(graceValues).size === 1 ? 'Standardized' : 'Per pattern'}
          </span>
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-crewly-inset-strong text-crewly-dim">
            <AlarmClock className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
            Late grace allowance
          </p>
          <p className="mt-0.5 text-2xl font-bold">{graceRange}</p>
          <p className="mt-1 text-[11px] text-crewly-dim">Before a punch counts as late</p>
        </div>

        <div className="card relative p-4">
          <span className="absolute right-3 top-3 inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-crewly-dim">
            <span className="h-1.5 w-1.5 rounded-full bg-crewly-green" aria-hidden="true" />
            {active.length === schedules.length ? 'Nominal' : 'Review'}
          </span>
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-crewly-green/12 text-crewly-green">
            <ShieldCheck className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
            Compliance
          </p>
          <p className="mt-0.5 flex items-baseline gap-2">
            <span className="text-2xl font-bold">
              {schedules.length ? Math.round((active.length / schedules.length) * 100) : 0}%
            </span>
            <span className="text-[11px] font-semibold text-crewly-green">Active</span>
          </p>
          <p className="mt-1 text-[11px] text-crewly-dim">
            {active.length} of {schedules.length} patterns carry a roster
          </p>
        </div>
      </div>

      {/* ── buckets ────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2">
          {buckets.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => setBucket(b.key)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                bucket === b.key
                  ? 'bg-crewly-inset-strong text-crewly-text'
                  : 'border border-crewly-border text-crewly-dim hover:text-crewly-text'
              }`}
            >
              {b.label} ({b.count})
            </button>
          ))}
        </div>
        <p className="flex items-center gap-2 text-[11px] text-crewly-dim">
          Default tier:
          <span className="rounded-full bg-crewly-green/12 px-2.5 py-1 font-bold text-crewly-green">
            {defaultSchedule ? defaultSchedule.name : 'None assigned'}
          </span>
        </p>
      </div>

      {/* ── the patterns themselves ────────────────────────────────────── */}
      <div id="schedule-list" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((s) => {
          const net = netMinutes(s);
          const days = s.workingDays || [];
          const staff = s.employees || [];
          const category = CATEGORY[categoryOf(s)];
          return (
            <section key={s.id} className={`card flex flex-col p-0 ${s.isActive ? '' : 'opacity-70'}`}>
              <div className="flex items-start justify-between gap-2 border-b border-crewly-border px-4 pb-3 pt-3.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-crewly-inset px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${s.isActive ? 'bg-crewly-green' : 'bg-crewly-dim'}`}
                        aria-hidden="true"
                      />
                      {s.isActive ? 'Active' : 'Inactive'}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${category.tone}`}>
                      {category.label}
                    </span>
                    {s.overtimeEligible ? (
                      <span className="rounded-full bg-crewly-inset-strong px-2 py-0.5 text-[10px] font-bold text-crewly-dim">
                        OT eligible
                      </span>
                    ) : null}
                  </div>
                  <h2 className="mt-2 line-clamp-2 text-lg font-bold leading-tight">{s.name}</h2>
                  <p className="mt-0.5 text-[11px] text-crewly-dim">
                    {(s.departments || []).map((d) => d.name).join(' · ') || 'No department assigned'}
                    {s.branch ? ` · ${s.branch}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setModal({
                        mode: 'edit',
                        id: s.id,
                        form: {
                          name: s.name,
                          workingDays: s.workingDays || [],
                          startTime: s.startTime,
                          endTime: s.endTime,
                          breakMinutes: s.breakMinutes,
                          graceMinutes: s.graceMinutes,
                          minWorkingHours: s.minWorkingHours,
                          halfDayHours: s.halfDayHours,
                          overtimeEligible: s.overtimeEligible,
                          lateGrace: s.lateRule?.graceMinutes ?? s.graceMinutes ?? 10,
                          maxLatePerMonth: s.lateRule?.maxLatePerMonth ?? 3,
                          earlyGrace: s.earlyCheckoutRule?.graceMinutes ?? 10,
                          branch: s.branch || '',
                          departments: (s.departments || []).map((d) => String(d.id)),
                        },
                      })
                    }
                    className="rounded-lg p-1.5 text-crewly-dim transition hover:bg-crewly-inset hover:text-crewly-text"
                    aria-label={`Edit ${s.name}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  {s.isActive ? (
                    <button
                      type="button"
                      onClick={() => deactivate(s)}
                      className="rounded-lg p-1.5 text-crewly-dim transition hover:bg-crewly-red/12 hover:text-crewly-red"
                      aria-label={`Deactivate ${s.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-1 flex-col px-4 pb-4 pt-3">
                <div className="rounded-xl bg-crewly-inset/60 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-crewly-dim">
                        Work window
                      </p>
                      <div className="mt-1 flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 text-crewly-orange" aria-hidden="true" />
                        <span className="text-sm font-bold tabular-nums">
                          {s.startTime} <span className="text-crewly-dim">→</span> {s.endTime}
                        </span>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-crewly-green">
                        {net ? `${(net / 60).toFixed(1)}h` : '—'}
                      </p>
                      <p className="text-[10px] text-crewly-dim">net / day</p>
                    </div>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-crewly-dim">
                    <span className="inline-flex items-center gap-1">
                      <Coffee className="h-3 w-3" aria-hidden="true" /> Break {s.breakMinutes || 0} min
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <AlarmClock className="h-3 w-3" aria-hidden="true" /> Grace {graceOf(s)} min
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" aria-hidden="true" /> Early-out {earlyOf(s)} min
                    </span>
                  </div>
                </div>

                <div className="mt-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-crewly-dim">
                      Active working days
                    </p>
                    <p className="text-[10px] text-crewly-dim">
                      {days.length} {days.length === 1 ? 'day' : 'days'} /{' '}
                      {((net * days.length) / 60).toFixed(1)}h week
                    </p>
                  </div>
                  <div className="mt-1.5 flex gap-1">
                    {DAYS.map((day) => {
                      const on = days.includes(day);
                      return (
                        <span
                          key={day}
                          className={`flex-1 rounded-md px-0.5 py-1 text-center text-[9px] font-bold uppercase ${
                            on
                              ? 'bg-crewly-green/15 text-crewly-green'
                              : 'bg-crewly-inset-strong text-crewly-dim/60 line-through'
                          }`}
                        >
                          {on ? day.slice(0, 3) : 'Off'}
                        </span>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-2.5">
                  <div className="flex -space-x-2">
                    {staff.slice(0, 3).map((person) => (
                      <span
                        key={person.id || person._id || person.name}
                        className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-crewly-card bg-crewly-inset-strong text-[9px] font-bold text-crewly-text"
                        title={person.name}
                      >
                        {initials(person.name)}
                      </span>
                    ))}
                    {staff.length > 3 ? (
                      <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-crewly-card bg-crewly-inset text-[9px] font-bold text-crewly-dim">
                        +{staff.length - 3}
                      </span>
                    ) : null}
                  </div>
                  <p className="min-w-0 text-[11px] leading-tight">
                    <span className="font-semibold">
                      {staff.length} {staff.length === 1 ? 'person' : 'people'}
                    </span>
                    <span className="block truncate text-crewly-dim">
                      {(s.departments || []).map((d) => d.name).join(', ') || 'Direct assignment'}
                    </span>
                  </p>
                  <button
                    type="button"
                    onClick={() => openAssign(s)}
                    className="ml-auto inline-flex items-center gap-1 rounded-lg border border-crewly-border px-2 py-1 text-[11px] font-semibold transition hover:bg-crewly-inset"
                  >
                    <UserPlus className="h-3.5 w-3.5" aria-hidden="true" /> Assign
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 border-t border-crewly-border bg-crewly-inset/30 px-4 py-2.5">
                <button
                  type="button"
                  onClick={() =>
                    setModal({
                      mode: 'edit',
                      id: s.id,
                      form: {
                        name: s.name,
                        workingDays: s.workingDays || [],
                        startTime: s.startTime,
                        endTime: s.endTime,
                        breakMinutes: s.breakMinutes,
                        graceMinutes: s.graceMinutes,
                        minWorkingHours: s.minWorkingHours,
                        halfDayHours: s.halfDayHours,
                        overtimeEligible: s.overtimeEligible,
                        lateGrace: s.lateRule?.graceMinutes ?? s.graceMinutes ?? 10,
                        maxLatePerMonth: s.lateRule?.maxLatePerMonth ?? 3,
                        earlyGrace: s.earlyCheckoutRule?.graceMinutes ?? 10,
                        branch: s.branch || '',
                        departments: (s.departments || []).map((d) => String(d.id)),
                      },
                    })
                  }
                  className="btn-ghost inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-bold"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Edit policy
                </button>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard
                      ?.writeText(
                        `${s.name}: ${s.startTime}–${s.endTime}, ${(s.workingDays || []).join(', ')}, break ${s.breakMinutes}m, grace ${graceOf(s)}m`,
                      )
                      .then(() => notify.success('Pattern copied to the clipboard.'))
                      .catch(() => notify.error('This browser did not allow the clipboard copy.'));
                  }}
                  className="btn-ghost ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-bold"
                  title="Copy this pattern"
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </section>
          );
        })}

        {!loading && !visible.length ? (
          <div className="md:col-span-2 xl:col-span-3">
            <div className="card">
              <EmptyState
                illustration="calendar"
                title={schedules.length ? 'No pattern matches this view' : 'No schedules yet'}
                description={
                  schedules.length
                    ? 'Clear the search or pick another bucket to see the rest of the register.'
                    : 'A schedule sets the working days, hours and grace one group follows — a general 09:00–18:00 office, or a six-day support rota.'
                }
                size="sm"
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* ── coverage and policy ────────────────────────────────────────── */}
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <section className="card xl:col-span-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
            Operational overlap
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="card-title text-base font-bold">Daily capacity &amp; floor coverage</h2>
            <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold text-crewly-dim">
              {active.map((s) => (
                <span key={s.id} className="inline-flex items-center gap-1.5">
                  <span
                    className={`h-2 w-2 rounded-sm ${
                      categoryOf(s) === 'DAY'
                        ? 'bg-crewly-green'
                        : categoryOf(s) === 'OVERNIGHT'
                          ? 'bg-crewly-orange'
                          : 'bg-crewly-dim'
                    }`}
                    aria-hidden="true"
                  />
                  {s.name}
                </span>
              ))}
            </div>
          </div>
          <p className="mt-0.5 text-[11px] text-crewly-dim">
            People the active patterns put on the floor in each hour, 06:00–22:00.
          </p>

          <div className="mt-3">
            <svg viewBox="0 0 640 150" className="h-40 w-full" role="img" aria-label="Staff on the floor by hour">
              {[0, 1, 2].map((i) => (
                <line
                  key={i}
                  x1="0"
                  x2="640"
                  y1={20 + i * 45}
                  y2={20 + i * 45}
                  className="stroke-crewly-border"
                  strokeWidth="1"
                  strokeDasharray="3 5"
                />
              ))}
              <path
                d={coveragePath(true)}
                className="fill-crewly-green/10"
                stroke="none"
              />
              <path
                d={coveragePath(false)}
                fill="none"
                className="stroke-crewly-green"
                strokeWidth="2.5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {peakHours.map((p) => {
                const index = coverage.findIndex((c) => c.hour === p.hour);
                const max = Math.max(1, ...coverage.map((c) => c.staff));
                return (
                  <circle
                    key={p.hour}
                    cx={(index / (coverage.length - 1)) * 640}
                    cy={130 - (p.staff / max) * 110}
                    r="4"
                    className="fill-crewly-orange"
                  />
                );
              })}
            </svg>
            <div className="flex justify-between text-[9px] font-semibold text-crewly-dim">
              {coverage
                .filter((_, i) => i % 3 === 0)
                .map((p) => (
                  <span key={p.hour}>{fmtHour(p.hour)}</span>
                ))}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-crewly-inset/60 px-3 py-2 text-[11px]">
            <span>
              {peak.staff ? (
                <>
                  Peak overlap{' '}
                  <span className="font-bold text-crewly-text">{peak.staff} people</span> ·{' '}
                  {fmtHour(peakHours[0].hour)}–{fmtHour(peakHours[peakHours.length - 1].hour + 1)}
                </>
              ) : (
                'No one is assigned to an active pattern yet, so there is no coverage to plot.'
              )}
            </span>
            <a className="inline-flex items-center gap-1 font-semibold text-crewly-green" href="/app/attendance/team">
              Detailed roster <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </a>
          </div>
        </section>

        <section className="card">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
                Policy guidelines
              </p>
              <h2 className="card-title text-base font-bold">Grace and break logic</h2>
            </div>
            <Sparkles className="h-4 w-4 shrink-0 text-crewly-dim" aria-hidden="true" />
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-crewly-dim">
            A punch inside the grace window is on time. Past it, the record is marked late and the
            minutes are kept — the schedule in force at that moment decides the window.
          </p>

          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-between gap-2 rounded-lg bg-crewly-inset/60 px-3 py-2">
              <span className="text-[11px] text-crewly-dim">Late check-in grace</span>
              <span className="rounded-md bg-crewly-card px-2 py-0.5 text-[11px] font-bold">{graceRange}</span>
            </div>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-crewly-inset/60 px-3 py-2">
              <span className="text-[11px] text-crewly-dim">Early clock-out grace</span>
              <span className="rounded-md bg-crewly-card px-2 py-0.5 text-[11px] font-bold">{earlyRange}</span>
            </div>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-crewly-inset/60 px-3 py-2">
              <span className="text-[11px] text-crewly-dim">Half-day threshold</span>
              <span className="rounded-md bg-crewly-card px-2 py-0.5 text-[11px] font-bold">
                {active.length
                  ? `${Math.min(...active.map((s) => Number(s.halfDayHours) || 0))}h`
                  : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-crewly-inset/60 px-3 py-2">
              <span className="flex items-center gap-1.5 text-[11px] text-crewly-dim">
                <Check className="h-3 w-3 text-crewly-green" aria-hidden="true" />
                Break deducted from net hours
              </span>
              <span className="rounded-md bg-crewly-card px-2 py-0.5 text-[11px] font-bold">
                {active.length
                  ? `${Math.min(...active.map((s) => Number(s.breakMinutes) || 0))}–${Math.max(
                      ...active.map((s) => Number(s.breakMinutes) || 0),
                    )} min`
                  : '—'}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setModal({ mode: 'create', form: { ...emptyForm, departments: [] } })}
            className="btn-primary mt-4 inline-flex w-full items-center justify-center gap-2 px-3 py-2 text-xs font-bold"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New schedule
          </button>
        </section>
      </div>

      {/* ── dialogs ────────────────────────────────────────────────────── */}
      {modal && (modal.mode === 'create' || modal.mode === 'edit') ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => setModal(null)}>
          <div
            className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-crewly-border bg-crewly-card sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-crewly-border px-5 py-3.5">
              <div>
                <h3 className="card-title text-base font-bold">
                  {modal.mode === 'create' ? 'New schedule' : 'Edit schedule'}
                </h3>
                <p className="text-[11px] text-crewly-dim">
                  The pattern applies from the next working day.
                </p>
              </div>
              <button type="button" onClick={() => setModal(null)} className="rounded-lg p-1 text-crewly-dim hover:text-crewly-text" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-crewly-dim">Name</span>
                <input
                  className="input w-full"
                  value={modal.form.name}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, name: e.target.value } })}
                  placeholder="General office schedule"
                />
              </label>

              <div>
                <span className="mb-1 block text-xs font-semibold text-crewly-dim">Working days</span>
                <div className="flex flex-wrap gap-1.5">
                  {DAYS.map((day) => {
                    const on = modal.form.workingDays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleDay(day)}
                        className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${
                          on
                            ? 'bg-crewly-green/15 text-crewly-green'
                            : 'border border-crewly-border text-crewly-dim'
                        }`}
                      >
                        {day.slice(0, 3)}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs">
                  <span className="mb-1 block font-semibold text-crewly-dim">Start</span>
                  <input
                    type="time"
                    className="input w-full"
                    value={modal.form.startTime}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, startTime: e.target.value } })}
                  />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block font-semibold text-crewly-dim">End</span>
                  <input
                    type="time"
                    className="input w-full"
                    value={modal.form.endTime}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, endTime: e.target.value } })}
                  />
                </label>
                {[
                  ['breakMinutes', 'Break (min)'],
                  ['graceMinutes', 'Grace (min)'],
                  ['lateGrace', 'Late grace (min)'],
                  ['earlyGrace', 'Early-out grace (min)'],
                  ['minWorkingHours', 'Min hours / day'],
                  ['halfDayHours', 'Half-day hours'],
                  ['maxLatePerMonth', 'Max lates / month'],
                ].map(([key, label]) => (
                  <label key={key} className="block text-xs">
                    <span className="mb-1 block font-semibold text-crewly-dim">{label}</span>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      className="input w-full"
                      value={modal.form[key]}
                      onChange={(e) => setModal({ ...modal, form: { ...modal.form, [key]: e.target.value } })}
                    />
                  </label>
                ))}
                <label className="block text-xs">
                  <span className="mb-1 block font-semibold text-crewly-dim">Branch</span>
                  <input
                    className="input w-full"
                    value={modal.form.branch}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, branch: e.target.value } })}
                    placeholder="Optional"
                  />
                </label>
              </div>

              <div>
                <span className="mb-1 block text-xs font-semibold text-crewly-dim">
                  Departments on this schedule
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {departments.map((d) => {
                    const id = String(d._id || d.id);
                    const on = (modal.form.departments || []).includes(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() =>
                          setModal({
                            ...modal,
                            form: {
                              ...modal.form,
                              departments: on
                                ? modal.form.departments.filter((x) => x !== id)
                                : [...(modal.form.departments || []), id],
                            },
                          })
                        }
                        className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${
                          on
                            ? 'bg-crewly-accent/15 text-crewly-orange'
                            : 'border border-crewly-border text-crewly-dim'
                        }`}
                      >
                        {d.name}
                      </button>
                    );
                  })}
                  {!departments.length ? (
                    <span className="text-[11px] text-crewly-dim">No departments found.</span>
                  ) : null}
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={modal.form.overtimeEligible}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, overtimeEligible: e.target.checked } })}
                />
                Overtime eligible
              </label>
            </div>

            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-crewly-border px-5 py-3 sm:flex-row sm:justify-end">
              <button type="button" className="btn-ghost px-4 py-2 text-xs font-bold" onClick={() => setModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary px-4 py-2 text-xs font-bold disabled:opacity-50"
                disabled={saving || !modal.form.name || !modal.form.workingDays.length}
                onClick={save}
              >
                {saving ? 'Saving…' : 'Save schedule'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {modal?.mode === 'assign' ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => setModal(null)}>
          <div
            className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border border-crewly-border bg-crewly-card sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-crewly-border px-5 py-3.5">
              <div>
                <h3 className="card-title text-base font-bold">Assign to {modal.schedule?.name}</h3>
                <p className="text-[11px] text-crewly-dim">
                  {modal.schedule?.employees?.length || 0} already on this pattern.
                </p>
              </div>
              <button type="button" onClick={() => setModal(null)} className="rounded-lg p-1 text-crewly-dim hover:text-crewly-text" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <p className="mb-2 text-[11px] text-crewly-dim">Departments</p>
              <div className="flex flex-wrap gap-1.5">
                {departments.map((d) => {
                  const id = String(d._id || d.id);
                  const on = (modal.schedule?.departments || []).some((x) => String(x.id) === id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={async () => {
                        try {
                          const r = on
                            ? await scheduleService.unassignSchedule(modal.id, { departmentIds: [id] })
                            : await scheduleService.assignSchedule(modal.id, { departmentIds: [id] });
                          notify.successFrom(r, on ? 'Department removed.' : 'Department assigned.');
                          setModal(null);
                          load();
                        } catch {
                          /* api.js reports */
                        }
                      }}
                      className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${
                        on ? 'bg-crewly-green/15 text-crewly-green' : 'border border-crewly-border text-crewly-dim'
                      }`}
                    >
                      {d.name}
                    </button>
                  );
                })}
              </div>

              <p className="mb-2 mt-4 text-[11px] text-crewly-dim">People</p>
              <ul className="space-y-1">
                {people.slice(0, 30).map((p) => {
                  const id = String(p._id || p.id);
                  const on = (modal.schedule?.employees || []).some(
                    (e) => String(e.id || e._id) === id,
                  );
                  return (
                    <li key={id} className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1 hover:bg-crewly-inset/60">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-crewly-inset-strong text-[9px] font-bold">
                          {initials(p.name)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-semibold">{p.name}</span>
                          <span className="block truncate text-[10px] text-crewly-dim">
                            {p.department?.name || p.email}
                          </span>
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const r = on
                              ? await scheduleService.unassignSchedule(modal.id, { userIds: [id] })
                              : await scheduleService.assignSchedule(modal.id, { userIds: [id] });
                            notify.successFrom(r, on ? 'Removed from the pattern.' : 'Added to the pattern.');
                            setModal(null);
                            load();
                          } catch {
                            /* api.js reports */
                          }
                        }}
                        className={`shrink-0 rounded-lg px-2 py-1 text-[11px] font-bold transition ${
                          on ? 'bg-crewly-green/15 text-crewly-green' : 'border border-crewly-border text-crewly-dim'
                        }`}
                      >
                        {on ? 'On it' : 'Add'}
                      </button>
                    </li>
                  );
                })}
                {!people.length ? (
                  <li className="text-[11px] text-crewly-dim">No people could be read for this company.</li>
                ) : null}
              </ul>
            </div>
            <div className="shrink-0 border-t border-crewly-border px-5 py-3">
              <button type="button" className="btn-ghost w-full px-4 py-2 text-xs font-bold" onClick={() => setModal(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default SchedulesPage;
