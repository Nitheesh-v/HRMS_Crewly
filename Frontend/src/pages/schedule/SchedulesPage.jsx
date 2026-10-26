import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  Clock,
  Coffee,
  Copy,
  HelpCircle,
  Info,
  Lock,
  Moon,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Timer,
  TimerReset,
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

const spanMinutes = (s) =>
  (toMinutes(s.endTime) - toMinutes(s.startTime) + 1440) % 1440 || 1440;

/* Net hours the pattern asks for: the window minus the unpaid break. */
const netMinutes = (s) => Math.max(0, spanMinutes(s) - (Number(s.breakMinutes) || 0));

const crossesMidnight = (s) => toMinutes(s.endTime) <= toMinutes(s.startTime);

const categoryOf = (s) => {
  if (crossesMidnight(s)) return 'ROTATIONAL';
  if ((s.workingDays || []).length < 5) return 'FLEXIBLE';
  return 'CORE';
};

const CATEGORY = {
  CORE: { label: 'Core daytime', tone: 'bg-st-primary-fixed text-st-on-primary-fixed' },
  ROTATIONAL: { label: 'Rotational', tone: 'bg-st-tertiary-fixed text-st-on-tertiary-fixed' },
  FLEXIBLE: { label: 'Flexible & remote', tone: 'bg-st-container text-st-on-variant' },
};

const graceOf = (s) => Number(s.lateRule?.graceMinutes ?? s.graceMinutes ?? 0);
const earlyOf = (s) => Number(s.earlyCheckoutRule?.graceMinutes ?? s.graceMinutes ?? 0);
const staffOf = (s) => (s.employees || []).length;

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

  const load = async () => {
    try {
      const d = await scheduleService.listSchedules();
      setSchedules(d.schedules || []);
    } catch {
      /* api.js reports every failed request */
    }
  };

  const editFormOf = (s) => ({
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
  });

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

  const deactivate = async (s) => {
    if (!window.confirm(`Deactivate “${s.name}”?`)) return;
    try {
      const r = await scheduleService.deleteSchedule(s.id);
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

  const active = schedules.filter((s) => s.isActive);
  const staffTotal = schedules.reduce((acc, s) => acc + staffOf(s), 0);

  const buckets = useMemo(() => {
    const count = (key) => schedules.filter((s) => categoryOf(s) === key).length;
    return [
      { key: 'ALL', label: 'All schedules', count: schedules.length },
      { key: 'CORE', label: 'Core daytime', count: count('CORE') },
      { key: 'ROTATIONAL', label: 'Rotational / 24-7', count: count('ROTATIONAL') },
      { key: 'FLEXIBLE', label: 'Flexible & remote', count: count('FLEXIBLE') },
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

  const defaultSchedule = useMemo(
    () => [...active].sort((a, b) => staffOf(b) - staffOf(a))[0] || null,
    [active],
  );

  const graceValues = active.map(graceOf);
  const graceRange = graceValues.length
    ? Math.min(...graceValues) === Math.max(...graceValues)
      ? `${graceValues[0]}`
      : `${Math.min(...graceValues)} – ${Math.max(...graceValues)}`
    : '—';
  const earlyValues = active.map(earlyOf);
  const earlyRange = earlyValues.length
    ? Math.min(...earlyValues) === Math.max(...earlyValues)
      ? `${earlyValues[0]} min`
      : `${Math.min(...earlyValues)}–${Math.max(...earlyValues)} min`
    : '—';

  const activeShare = staffTotal && defaultSchedule ? Math.round((staffOf(defaultSchedule) / staffTotal) * 100) : 0;
  const compliance = schedules.length ? Math.round((active.length / schedules.length) * 100) : 0;
  const inactive = schedules.length - active.length;

  /* Floor coverage: the people each active pattern puts on the floor in an
     hour. Straight arithmetic over the schedules that exist — no roster feed. */
  const coverage = useMemo(() => {
    const hours = Array.from({ length: 17 }, (_, i) => i + 6);
    return hours.map((hour) => ({
      hour,
      staff: active.reduce((acc, s) => {
        const start = toMinutes(s.startTime) / 60;
        const end = toMinutes(s.endTime) / 60;
        const wraps = end <= start;
        const inside = wraps ? hour >= start || hour < end : hour >= start && hour < end;
        return acc + (inside ? staffOf(s) : 0);
      }, 0),
    }));
  }, [active]);

  const peak = coverage.reduce((best, p) => (p.staff > best.staff ? p : best), { hour: 0, staff: 0 });
  const peakHours = coverage.filter((p) => p.staff === peak.staff && peak.staff > 0);
  const fmtHour = (h) => `${String(h).padStart(2, '0')}:00`;

  const coveragePath = (close) => {
    const max = Math.max(1, ...coverage.map((c) => c.staff));
    const pts = coverage.map((p, i) => ({
      x: (i / (coverage.length - 1)) * 700,
      y: 100 - (p.staff / max) * 75,
    }));
    if (!pts.length) return '';
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length; i += 1) {
      const prev = pts[i - 1];
      const cur = pts[i];
      const cx = (prev.x + cur.x) / 2;
      d += ` C${cx},${prev.y} ${cx},${cur.y} ${cur.x},${cur.y}`;
    }
    return close ? `${d} L700,100 L0,100 Z` : d;
  };

  if (!isHR) {
    return (
      <div className="st-surface min-h-screen p-6">
        <div className="rounded-xl border border-st-high bg-st-lowest p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-st-on-variant" aria-hidden="true" />
            <p className="text-sm text-st-on-variant">
              Only an admin or HR manager manages work schedules. Your own pattern is on{' '}
              <a className="font-semibold text-st-primary underline" href="/app/shifts">
                Shifts
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-6">
        {/* ── context bar ───────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4 pb-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-widest text-st-secondary">
                Operational cadence
              </span>
              <span className="inline-block h-1 w-1 rounded-full bg-st-outline" />
              <span className="text-xs font-medium text-st-on-variant">
                {active.length} {active.length === 1 ? 'pattern' : 'patterns'} in force
              </span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-st-on lg:text-4xl">Work schedules</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-st-on-variant lg:text-base">
              Reusable working-day patterns — flexible shift models, grace periods, and custom
              operational cycles configured for autonomous enterprise governance.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label className="relative hidden sm:block">
              <Search
                className="pointer-events-none absolute left-3 top-2.5 h-[18px] w-[18px] text-st-outline"
                aria-hidden="true"
              />
              <input
                className="w-52 rounded-lg bg-st-lowest py-2 pl-9 pr-4 text-xs text-st-on shadow-sm placeholder:text-st-outline focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                placeholder="Filter schedules…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Filter schedules"
              />
            </label>
            <button
              type="button"
              onClick={() => document.getElementById('schedule-list')?.scrollIntoView({ behavior: 'smooth' })}
              className="flex items-center gap-2 rounded-lg bg-st-highest/60 px-4 py-2 text-xs font-semibold text-st-on shadow-sm transition-all hover:bg-st-highest"
            >
              <TimerReset className="h-[18px] w-[18px]" aria-hidden="true" />
              Filter ({visible.length})
            </button>
            <button
              type="button"
              onClick={() => setModal({ mode: 'create', form: { ...emptyForm, departments: [] } })}
              className="flex items-center gap-2 rounded-lg bg-st-primary-container px-5 py-2 text-xs font-semibold text-st-on-primary-container shadow-md transition-all hover:bg-st-primary-fixed-dim active:scale-[0.98]"
            >
              <Plus className="h-[18px] w-[18px]" aria-hidden="true" />
              + New schedule
            </button>
          </div>
        </div>

        {/* ── four readings ─────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col justify-between rounded-xl bg-st-lowest p-5 shadow-sm">
            <div className="flex items-start justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-st-secondary-container text-st-on-secondary-container">
                <CalendarDays className="h-5 w-5" aria-hidden="true" />
              </div>
              <span className="rounded-full bg-st-container px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
                Live config
              </span>
            </div>
            <div className="mt-4">
              <div className="text-xs font-medium text-st-on-variant">Active patterns</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-st-on">{active.length}</span>
                <span className="text-xs font-semibold text-st-secondary">Established</span>
              </div>
              <div className="mt-1 truncate text-[11px] text-st-on-variant/80">
                {active.map((s) => s.name).join(', ') || 'None configured yet'}
              </div>
            </div>
            <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-st-high">
              <div
                className="h-full rounded-full bg-st-secondary"
                style={{ width: `${schedules.length ? (active.length / schedules.length) * 100 : 0}%` }}
              />
            </div>
          </div>

          <div className="flex flex-col justify-between rounded-xl bg-st-lowest p-5 shadow-sm">
            <div className="flex items-start justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-st-primary-fixed text-st-primary">
                <Users className="h-5 w-5" aria-hidden="true" />
              </div>
              <span className="rounded-full bg-st-tertiary-fixed px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-st-on-tertiary-fixed">
                {staffTotal ? `${activeShare}% staff` : 'No staff'}
              </span>
            </div>
            <div className="mt-4">
              <div className="text-xs font-medium text-st-on-variant">Default assignment</div>
              <div className="mt-1 truncate text-lg font-bold text-st-on">
                {defaultSchedule?.name || '—'}
              </div>
              <div className="mt-1 truncate text-[11px] text-st-on-variant/80">
                {defaultSchedule
                  ? `${staffOf(defaultSchedule)} people · ${(defaultSchedule.departments || [])
                      .map((d) => d.name)
                      .join(', ') || 'no department attached'}`
                  : 'Nothing assigned yet'}
              </div>
            </div>
            <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-st-high">
              <div className="h-full rounded-full bg-st-primary-container" style={{ width: `${activeShare}%` }} />
            </div>
          </div>

          <div className="flex flex-col justify-between rounded-xl bg-st-lowest p-5 shadow-sm">
            <div className="flex items-start justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-st-high text-st-tertiary">
                <Timer className="h-5 w-5" aria-hidden="true" />
              </div>
              <span className="rounded-full bg-st-secondary-container/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-st-on-secondary-container">
                {graceValues.length && new Set(graceValues).size === 1 ? 'Standardized' : 'Per pattern'}
              </span>
            </div>
            <div className="mt-4">
              <div className="text-xs font-medium text-st-on-variant">Avg grace allowance</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-st-on">{graceRange}</span>
                <span className="text-xs font-semibold text-st-outline">minutes</span>
              </div>
              <div className="mt-1 text-[11px] text-st-on-variant/80">
                {earlyRange} tolerance on early clock-out
              </div>
            </div>
            <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-st-high">
              <div
                className="h-full rounded-full bg-st-tertiary-container"
                style={{ width: `${Math.min(100, ((Math.max(0, ...graceValues) || 0) / 30) * 100)}%` }}
              />
            </div>
          </div>

          <div className="flex flex-col justify-between rounded-xl bg-st-lowest p-5 shadow-sm">
            <div className="flex items-start justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-st-secondary-container text-st-secondary">
                <ShieldCheck className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="flex items-center gap-1 text-[11px] font-bold text-st-secondary">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${inactive ? 'bg-st-primary-container' : 'bg-st-secondary'}`}
                />
                {inactive ? 'Review' : 'Nominal'}
              </div>
            </div>
            <div className="mt-4">
              <div className="text-xs font-medium text-st-on-variant">Compliance status</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-st-on">{compliance}%</span>
                <span className="text-xs font-semibold text-st-secondary">Active</span>
              </div>
              <div className="mt-1 text-[11px] text-st-on-variant/80">
                {inactive
                  ? `${inactive} inactive ${inactive === 1 ? 'pattern' : 'patterns'} still on the register`
                  : 'Every pattern on the register is active'}
              </div>
            </div>
            <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-st-high">
              <div className="h-full rounded-full bg-st-secondary" style={{ width: `${compliance}%` }} />
            </div>
          </div>
        </div>

        {/* ── buckets ───────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3 pb-1 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-1 rounded-xl bg-st-container p-1">
            {buckets.map((b) => (
              <button
                key={b.key}
                type="button"
                onClick={() => setBucket(b.key)}
                className={`rounded-lg px-4 py-1.5 text-xs transition-all ${
                  bucket === b.key
                    ? 'bg-st-lowest font-semibold text-st-on shadow-sm'
                    : 'font-medium text-st-on-variant hover:text-st-on'
                }`}
              >
                {b.label} ({b.count})
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs text-st-on-variant">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-st-outline">
              Default tier:
            </span>
            <span className="rounded-full bg-st-secondary-container px-2 py-0.5 text-[11px] font-semibold text-st-on-secondary-container">
              {defaultSchedule ? `Automatic enrolment · ${defaultSchedule.name}` : 'Automatic enrolment enabled'}
            </span>
          </div>
        </div>

        {/* ── patterns ──────────────────────────────────────────────────── */}
        <div id="schedule-list" className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {visible.map((s) => {
            const net = netMinutes(s);
            const days = s.workingDays || [];
            const staff = s.employees || [];
            const isDefault = defaultSchedule?.id === s.id;
            const overnight = crossesMidnight(s);
            return (
              <div
                key={s.id}
                className={`relative flex flex-col justify-between overflow-hidden rounded-xl bg-st-lowest p-6 shadow-sm transition-all hover:shadow-lg ${
                  s.isActive ? '' : 'opacity-70'
                }`}
              >
                {isDefault ? <div className="absolute inset-x-0 top-0 h-1.5 bg-st-primary-container" /> : null}

                <div>
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`h-2.5 w-2.5 rounded-full ${
                            s.isActive ? 'bg-st-secondary' : 'bg-st-outline'
                          }`}
                        />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-st-secondary">
                          {s.isActive ? 'Active' : 'Inactive'}
                        </span>
                        {isDefault ? (
                          <span className="rounded-full bg-st-tertiary-fixed px-2 py-0.5 text-[10px] font-bold text-st-on-tertiary-fixed">
                            Primary
                          </span>
                        ) : null}
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${CATEGORY[categoryOf(s)].tone}`}
                        >
                          {CATEGORY[categoryOf(s)].label}
                        </span>
                      </div>
                      <h3 className="pt-1 text-xl font-bold text-st-on">{s.name}</h3>
                      <p className="text-xs text-st-on-variant">
                        {(s.departments || []).map((d) => d.name).join(' · ') ||
                          'Not attached to a department yet'}
                        {s.branch ? ` · ${s.branch}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => setModal(editFormOf(s))}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-st-on-variant transition-colors hover:bg-st-container hover:text-st-on"
                        aria-label={`Edit ${s.name}`}
                      >
                        <Pencil className="h-[18px] w-[18px]" />
                      </button>
                      {s.isActive ? (
                        <button
                          type="button"
                          onClick={() => deactivate(s)}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-st-on-variant transition-colors hover:bg-st-error-container hover:text-st-error"
                          aria-label={`Deactivate ${s.name}`}
                        >
                          <Trash2 className="h-[18px] w-[18px]" />
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {/* work window */}
                  <div className="mt-6 flex flex-col gap-3 rounded-xl bg-st-low p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-st-highest text-st-primary">
                          {overnight ? <Moon className="h-[18px] w-[18px]" /> : <Clock className="h-[18px] w-[18px]" />}
                        </div>
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wider text-st-outline">
                            Work window
                          </div>
                          <div className="text-base font-bold text-st-on">
                            {s.startTime}{' '}
                            <span className="text-xs font-normal text-st-on-variant">→</span> {s.endTime}
                            {overnight ? (
                              <span className="ml-1.5 rounded bg-st-primary-fixed/50 px-1 text-[10px] font-semibold text-st-primary">
                                +1D
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <span className="whitespace-nowrap rounded-full bg-st-highest px-2.5 py-1 text-xs font-bold text-st-on">
                        {(net / 60).toFixed(1)}h Net / Day
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px] text-st-on-variant">
                      <div className="flex items-center gap-1.5">
                        <Coffee className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" />
                        <span>
                          Meal break: <strong className="text-st-on">{s.breakMinutes || 0} min</strong>
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Timer className="h-3.5 w-3.5 text-st-secondary" aria-hidden="true" />
                        <span>
                          Grace window:{' '}
                          <strong className="font-bold text-st-secondary">{graceOf(s)} min</strong>
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* weekday strip */}
                  <div className="mt-5 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-st-outline">
                        Active working days
                      </span>
                      <span className="text-[11px] font-semibold text-st-secondary">
                        {days.length} days / {((net * days.length) / 60).toFixed(1)}h wk
                      </span>
                    </div>
                    <div className="grid grid-cols-7 gap-1.5 text-center">
                      {DAYS.map((day) => {
                        const on = days.includes(day);
                        return (
                          <div
                            key={day}
                            className={`rounded-lg py-2 text-[11px] font-bold ${
                              on
                                ? 'bg-st-secondary-container text-st-on-secondary-container shadow-sm'
                                : 'bg-st-high/60 text-st-outline-variant'
                            }`}
                          >
                            <span className="block text-[9px] uppercase tracking-tighter">{day.slice(0, 3)}</span>
                            {on ? (
                              <Check className="mx-auto mt-0.5 h-3 w-3" aria-label="working" />
                            ) : (
                              <span>Off</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* assignment */}
                  <button
                    type="button"
                    onClick={() => openAssign(s)}
                    className="mt-5 flex w-full items-center justify-between rounded-lg bg-st-lowest p-3 text-left transition-colors hover:bg-st-low"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex -space-x-2">
                        {staff.slice(0, 3).map((p) => (
                          <span
                            key={p.id || p._id || p.name}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-st-secondary-fixed text-[10px] font-bold text-st-on-secondary-fixed ring-2 ring-st-lowest"
                            title={p.name}
                          >
                            {initials(p.name)}
                          </span>
                        ))}
                        {staff.length > 3 ? (
                          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-st-highest text-[10px] font-bold text-st-on ring-2 ring-st-lowest">
                            +{staff.length - 3}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs">
                        <div className="font-bold text-st-on">
                          {staff.length} Direct {staff.length === 1 ? 'person' : 'Staff'}
                        </div>
                        <div className="text-[11px] text-st-on-variant">
                          {(s.departments || []).map((d) => d.name).join(' & ') || 'No department attached'}
                        </div>
                      </div>
                    </div>
                    <ArrowRight className="h-[18px] w-[18px] text-st-secondary" aria-hidden="true" />
                  </button>
                </div>

                <div className="mt-6 flex items-center justify-between gap-2 pt-4">
                  <button
                    type="button"
                    onClick={() => setModal(editFormOf(s))}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-st-high px-3 py-2 text-xs font-semibold text-st-on transition-colors hover:bg-st-highest"
                  >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                    Edit policy
                  </button>
                  <button
                    type="button"
                    onClick={() => openAssign(s)}
                    className="flex items-center justify-center gap-1.5 rounded-lg bg-st-primary-fixed/40 px-3 py-2 text-xs font-semibold text-st-on-primary-fixed-variant transition-colors hover:bg-st-primary-fixed"
                    title="Assign staff"
                  >
                    <UserPlus className="h-4 w-4" aria-hidden="true" />
                    Assign
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
                    className="rounded-lg bg-st-high p-2 text-st-on-variant transition-colors hover:bg-st-highest"
                    title="Copy this pattern"
                    aria-label={`Copy ${s.name}`}
                  >
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}

          {!loading && !visible.length ? (
            <div className="rounded-xl bg-st-lowest p-6 shadow-sm lg:col-span-3">
              <EmptyState
                illustration="calendar"
                title={schedules.length ? 'No pattern in this view' : 'No schedules yet'}
                description={
                  schedules.length
                    ? 'Clear the search or pick another bucket to see the rest of the register.'
                    : 'A schedule sets the working days, hours and grace one group follows — a general 09:30–18:30 office, or a six-day support rota.'
                }
                size="sm"
              />
            </div>
          ) : null}
        </div>

        {/* ── coverage + policy ─────────────────────────────────────────── */}
        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="flex flex-col justify-between rounded-xl bg-st-lowest p-6 shadow-sm lg:col-span-8">
            <div>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-st-secondary">
                    Operational overlap
                  </span>
                  <h3 className="text-lg font-bold text-st-on">Daily capacity &amp; floor coverage profile</h3>
                  <p className="text-xs text-st-on-variant">
                    People the active patterns put on the floor in each hour, 06:00–22:00.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {active.slice(0, 3).map((s) => (
                    <span key={s.id} className="flex items-center gap-1 text-[11px] text-st-on-variant">
                      <span
                        className={`h-2.5 w-2.5 rounded-sm ${
                          categoryOf(s) === 'CORE'
                            ? 'bg-st-primary-container'
                            : categoryOf(s) === 'ROTATIONAL'
                              ? 'bg-st-secondary'
                              : 'bg-st-tertiary-container'
                        }`}
                      />
                      {s.name}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-6 w-full overflow-x-auto pb-2">
                <div className="relative min-w-[500px]">
                  <svg
                    viewBox="0 0 700 120"
                    className="h-32 w-full"
                    fill="none"
                    role="img"
                    aria-label="People on the floor by hour"
                  >
                    <line x1="0" x2="700" y1="100" y2="100" className="stroke-st-high" strokeWidth="1" />
                    <line
                      x1="0"
                      x2="700"
                      y1="65"
                      y2="65"
                      className="stroke-st-high"
                      strokeWidth="1"
                      strokeDasharray="3 3"
                    />
                    <line
                      x1="0"
                      x2="700"
                      y1="30"
                      y2="30"
                      className="stroke-st-high"
                      strokeWidth="1"
                      strokeDasharray="3 3"
                    />
                    <path d={coveragePath(true)} className="fill-st-secondary-container" opacity="0.45" />
                    <path
                      d={coveragePath(false)}
                      className="stroke-st-secondary"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                    {peak.staff ? (
                      <circle
                        cx={(coverage.findIndex((c) => c.hour === peakHours[0].hour) / (coverage.length - 1)) * 700}
                        cy={100 - (peak.staff / Math.max(1, peak.staff)) * 75}
                        r="4"
                        className="fill-st-primary-container"
                      />
                    ) : null}
                  </svg>
                  {peak.staff ? (
                    <span
                      className="pointer-events-none absolute top-1 whitespace-nowrap text-[11px] font-bold text-st-primary"
                      style={{
                        left: `calc(${
                          (coverage.findIndex((c) => c.hour === peakHours[0].hour) / (coverage.length - 1)) * 100
                        }% - 70px)`,
                      }}
                    >
                      Peak overlap: {peak.staff} on duty
                    </span>
                  ) : null}
                  <div className="mt-1 flex justify-between text-[10px] text-st-outline">
                    {coverage
                      .filter((_, i) => i % 3 === 0)
                      .map((p) => (
                        <span key={p.hour}>{fmtHour(p.hour)}</span>
                      ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 pt-4 text-xs">
              <div className="flex items-center gap-2 text-st-on">
                <Info className="h-[18px] w-[18px] text-st-secondary" aria-hidden="true" />
                <span>
                  {peak.staff ? (
                    <>
                      Highest simultaneous occupancy spans{' '}
                      <strong>
                        {fmtHour(peakHours[0].hour)} → {fmtHour(peakHours[peakHours.length - 1].hour + 1)}
                      </strong>{' '}
                      daily.
                    </>
                  ) : (
                    'Nobody is assigned to an active pattern yet, so there is no coverage to plot.'
                  )}
                </span>
              </div>
              <a
                className="inline-flex items-center gap-1 font-bold text-st-primary transition-colors hover:text-st-on-primary-container"
                href="/app/attendance/report"
              >
                Detailed roster matrix <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </div>
          </div>

          <div className="flex flex-col justify-between rounded-xl bg-st-low p-6 shadow-sm lg:col-span-4">
            <div>
              <div className="mb-3 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-st-secondary">
                  Policy guidelines
                </span>
                <HelpCircle className="h-5 w-5 text-st-outline" aria-hidden="true" />
              </div>
              <h4 className="mb-2 text-base font-bold text-st-on">Automated grace logic</h4>
              <p className="mb-4 text-xs leading-relaxed text-st-on-variant">
                Grace tolerance is calculated against the punch itself. A check-in inside the
                allowance is recorded as <em>on time (grace)</em>; past it the minutes stay on the
                record and the day is marked late.
              </p>
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-lg bg-st-lowest p-3 text-xs">
                  <span className="font-medium text-st-on">Late check-in grace limit</span>
                  <span className="rounded bg-st-container px-2 py-0.5 font-bold text-st-on">
                    {graceRange === '—' ? '—' : `${graceRange} mins`}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-st-lowest p-3 text-xs">
                  <span className="font-medium text-st-on">Early clock-out grace</span>
                  <span className="rounded bg-st-container px-2 py-0.5 font-bold text-st-on">{earlyRange}</span>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-st-lowest p-3 text-xs">
                  <span className="font-medium text-st-on">Break deducted from net hours</span>
                  <span className="flex items-center gap-1 font-bold text-st-secondary">
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    {active.length
                      ? `${Math.min(...active.map((s) => Number(s.breakMinutes) || 0))}–${Math.max(
                          ...active.map((s) => Number(s.breakMinutes) || 0),
                        )} min`
                      : '—'}
                  </span>
                </div>
              </div>
            </div>
            <div className="mt-6 pt-3">
              <button
                type="button"
                onClick={() => {
                  if (defaultSchedule) setModal(editFormOf(defaultSchedule));
                  else setModal({ mode: 'create', form: { ...emptyForm, departments: [] } });
                }}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-st-secondary px-4 py-2.5 text-xs font-semibold text-st-on-secondary shadow-sm transition-all hover:bg-st-secondary/90"
              >
                <TimerReset className="h-4 w-4" aria-hidden="true" />
                Configure enterprise limits
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── editor ──────────────────────────────────────────────────────── */}
      {modal && (modal.mode === 'create' || modal.mode === 'edit') ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-st-inverse/50 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setModal(null)}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-st-lowest shadow-2xl sm:rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-st-high bg-st-low px-6 py-4">
              <div>
                <h3 className="text-base font-bold text-st-on">
                  {modal.mode === 'create' ? 'New schedule' : `Edit ${modal.form.name}`}
                </h3>
                <p className="text-xs text-st-on-variant">The pattern applies from the next working day.</p>
              </div>
              <button
                type="button"
                onClick={() => setModal(null)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-st-outline hover:bg-st-container hover:text-st-on"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5 text-xs">
              <label className="block">
                <span className="mb-1.5 block font-semibold text-st-on">Name</span>
                <input
                  className="w-full rounded-lg bg-st-container px-3 py-2.5 text-st-on placeholder:text-st-on-variant/50 focus:outline-none focus:ring-2 focus:ring-st-primary-container"
                  value={modal.form.name}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, name: e.target.value } })}
                  placeholder="General office schedule"
                />
              </label>

              <div>
                <span className="mb-1.5 block font-semibold text-st-on">Working days</span>
                <div className="flex flex-wrap gap-1.5">
                  {DAYS.map((day) => {
                    const on = modal.form.workingDays.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleDay(day)}
                        className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition ${
                          on
                            ? 'bg-st-secondary-container text-st-on-secondary-container'
                            : 'bg-st-container text-st-on-variant'
                        }`}
                      >
                        {day.slice(0, 3)}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1.5 block font-semibold text-st-on">Start</span>
                  <input
                    type="time"
                    className="w-full rounded-lg bg-st-container px-3 py-2.5 text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container"
                    value={modal.form.startTime}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, startTime: e.target.value } })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block font-semibold text-st-on">End</span>
                  <input
                    type="time"
                    className="w-full rounded-lg bg-st-container px-3 py-2.5 text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container"
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
                  <label key={key} className="block">
                    <span className="mb-1.5 block font-semibold text-st-on">{label}</span>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      className="w-full rounded-lg bg-st-container px-3 py-2.5 text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container"
                      value={modal.form[key]}
                      onChange={(e) => setModal({ ...modal, form: { ...modal.form, [key]: e.target.value } })}
                    />
                  </label>
                ))}
                <label className="block">
                  <span className="mb-1.5 block font-semibold text-st-on">Branch</span>
                  <input
                    className="w-full rounded-lg bg-st-container px-3 py-2.5 text-st-on placeholder:text-st-on-variant/50 focus:outline-none focus:ring-2 focus:ring-st-primary-container"
                    value={modal.form.branch}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, branch: e.target.value } })}
                    placeholder="Optional"
                  />
                </label>
              </div>

              <div>
                <span className="mb-1.5 block font-semibold text-st-on">Departments on this schedule</span>
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
                        className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition ${
                          on
                            ? 'bg-st-primary-fixed text-st-on-primary-fixed-variant'
                            : 'bg-st-container text-st-on-variant'
                        }`}
                      >
                        {d.name}
                      </button>
                    );
                  })}
                  {!departments.length ? (
                    <span className="text-[11px] text-st-on-variant">No departments found.</span>
                  ) : null}
                </div>
              </div>

              <label className="flex items-center gap-2 font-medium text-st-on">
                <input
                  type="checkbox"
                  className="accent-st-primary"
                  checked={modal.form.overtimeEligible}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, overtimeEligible: e.target.checked } })}
                />
                Overtime eligible
              </label>
            </div>

            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-st-high bg-st-low px-6 py-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="rounded-lg bg-st-container px-4 py-2 text-xs font-semibold text-st-on transition hover:bg-st-high"
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-st-primary-container px-5 py-2 text-xs font-semibold text-st-on-primary-container shadow-sm transition hover:bg-st-primary-fixed-dim disabled:opacity-50"
                disabled={saving || !modal.form.name || !modal.form.workingDays.length}
                onClick={save}
              >
                {saving ? 'Saving…' : 'Save schedule'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── assign ──────────────────────────────────────────────────────── */}
      {modal?.mode === 'assign' ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-st-inverse/50 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setModal(null)}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl bg-st-lowest shadow-2xl sm:rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-st-high bg-st-low px-6 py-4">
              <div>
                <h3 className="text-base font-bold text-st-on">Assign to {modal.schedule?.name}</h3>
                <p className="text-xs text-st-on-variant">
                  {staffOf(modal.schedule || {})} already on this pattern.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModal(null)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-st-outline hover:bg-st-container hover:text-st-on"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <p className="mb-2 text-xs font-semibold text-st-on-variant">Departments</p>
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
                      className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition ${
                        on
                          ? 'bg-st-secondary-container text-st-on-secondary-container'
                          : 'bg-st-container text-st-on-variant'
                      }`}
                    >
                      {d.name}
                    </button>
                  );
                })}
              </div>

              <p className="mb-2 mt-5 text-xs font-semibold text-st-on-variant">People</p>
              <ul className="space-y-1">
                {people.slice(0, 30).map((p) => {
                  const id = String(p._id || p.id);
                  const on = (modal.schedule?.employees || []).some((e) => String(e.id || e._id) === id);
                  return (
                    <li key={id} className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1.5 hover:bg-st-low">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-st-secondary-fixed text-[10px] font-bold text-st-on-secondary-fixed">
                          {initials(p.name)}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-semibold text-st-on">{p.name}</span>
                          <span className="block truncate text-[10px] text-st-on-variant">
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
                        className={`shrink-0 rounded-lg px-2 py-1 text-[11px] font-bold ${
                          on
                            ? 'bg-st-secondary-container text-st-on-secondary-container'
                            : 'bg-st-container text-st-on-variant'
                        }`}
                      >
                        {on ? 'On it' : 'Add'}
                      </button>
                    </li>
                  );
                })}
                {!people.length ? (
                  <li className="text-[11px] text-st-on-variant">No people could be read for this company.</li>
                ) : null}
              </ul>
            </div>
            <div className="shrink-0 border-t border-st-high bg-st-low px-6 py-3">
              <button
                type="button"
                className="w-full rounded-lg bg-st-container px-4 py-2 text-xs font-semibold text-st-on transition hover:bg-st-high"
                onClick={() => setModal(null)}
              >
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
