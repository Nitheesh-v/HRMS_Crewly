import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  BedDouble,
  CalendarRange,
  Check,
  Circle,
  Coffee,
  Gauge,
  History,
  Moon,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Timer,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useSelector } from 'react-redux';
import scheduleService from '../../services/scheduleService';
import { getEmployees } from '../../services/docsService';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';

const HR = ['COMPANY_ADMIN', 'HR_MANAGER'];
const SHIFT_TYPES = ['MORNING', 'GENERAL', 'EVENING', 'NIGHT', 'FLEXIBLE', 'CUSTOM'];

const TYPE_META = {
  MORNING: { label: 'Morning', chip: 'bg-st-secondary-container text-st-on-secondary-container' },
  GENERAL: { label: 'General', chip: 'bg-st-primary-fixed text-st-on-primary-fixed' },
  EVENING: { label: 'Evening', chip: 'bg-st-tertiary-fixed/70 text-st-on-tertiary-fixed' },
  NIGHT: { label: 'Night', chip: 'bg-st-tertiary-fixed text-st-on-tertiary-fixed' },
  FLEXIBLE: { label: 'Flexible', chip: 'bg-st-container text-st-on-variant' },
  CUSTOM: { label: 'Custom', chip: 'bg-st-container text-st-on-variant' },
};
const metaOf = (type) => TYPE_META[type] || TYPE_META.CUSTOM;

const emptyForm = {
  name: '',
  type: 'GENERAL',
  startTime: '09:00',
  endTime: '18:00',
  breakMinutes: 60,
  graceMinutes: 10,
  overtimeEligible: false,
  overtimeRatePerHour: 0,
  shiftAllowance: 0,
  nightAllowance: 0,
  lateGrace: 10,
  maxLatePerMonth: 3,
  earlyGrace: 10,
};

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : 0;
};
const spanMinutes = (s) => (toMinutes(s.endTime) - toMinutes(s.startTime) + 1440) % 1440 || 1440;
const netHours = (s) => Math.max(0, (spanMinutes(s) - (Number(s.breakMinutes) || 0)) / 60);
const crosses = (s) => toMinutes(s.endTime) <= toMinutes(s.startTime);

const clock12 = (hhmm) => {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${String(hour).padStart(2, '0')}:${String(m || 0).padStart(2, '0')} ${suffix}`;
};
const addMinutes = (hhmm, delta) => {
  const total = (toMinutes(hhmm) + delta + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
const mins12 = (m) => {
  const h = Math.floor(Math.abs(m) / 60);
  const mm = Math.abs(m) % 60;
  return h ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
};

const initials = (name = '') =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';

const graceOf = (s) => Number(s?.lateRule?.graceMinutes ?? s?.graceMinutes ?? 0);
const earlyOf = (s) => Number(s?.earlyCheckoutRule?.graceMinutes ?? s?.graceMinutes ?? 0);

export default function ShiftsPage() {
  const user = useSelector((s) => s.auth.user);
  const isHR = HR.includes(user?.role);
  const [shifts, setShifts] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [mine, setMine] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [assignFor, setAssignFor] = useState(null);
  const [rosterFor, setRosterFor] = useState(null);
  const [historyFor, setHistoryFor] = useState('');
  const [history, setHistory] = useState([]);
  const [historyQuery, setHistoryQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [typeTab, setTypeTab] = useState('ALL');
  const [specQuery, setSpecQuery] = useState('');
  const [nowMin] = useState(() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  });

  const empList = useMemo(
    () => (Array.isArray(employees) ? employees : employees?.employees || []),
    [employees],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const m = await scheduleService.myShift();
        if (alive) setMine(m);
        if (isHR) {
          const d = await scheduleService.listShifts();
          if (alive) setShifts(d.shifts || []);
          const emps = await getEmployees();
          if (alive) setEmployees(emps?.employees || emps || []);
          const deps = await scheduleService.getDepartments();
          if (alive) setDepartments(deps.departments || []);
        }
      } catch {
        /* api.js reports every failed request */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isHR]);

  const load = async () => {
    try {
      if (isHR) {
        const d = await scheduleService.listShifts();
        setShifts(d.shifts || []);
      }
      const m = await scheduleService.myShift();
      setMine(m);
    } catch {
      /* api.js reports every failed request */
    }
  };

  const openCreate = () => setModal({ mode: 'create', form: { ...emptyForm } });
  const openEdit = (s) =>
    setModal({
      mode: 'edit',
      id: s.id,
      form: {
        name: s.name,
        type: s.type,
        startTime: s.startTime,
        endTime: s.endTime,
        breakMinutes: s.breakMinutes,
        graceMinutes: s.graceMinutes,
        overtimeEligible: s.overtimeEligible,
        overtimeRatePerHour: s.overtimeRatePerHour,
        shiftAllowance: s.shiftAllowance,
        nightAllowance: s.nightAllowance,
        lateGrace: s.lateRule?.graceMinutes ?? 10,
        maxLatePerMonth: s.lateRule?.maxLatePerMonth ?? 3,
        earlyGrace: s.earlyCheckoutRule?.graceMinutes ?? 10,
      },
    });

  const save = async () => {
    setSaving(true);
    try {
      const f = modal.form;
      const payload = {
        name: f.name,
        type: f.type,
        startTime: f.startTime,
        endTime: f.endTime,
        breakMinutes: +f.breakMinutes,
        graceMinutes: +f.graceMinutes,
        overtimeEligible: !!f.overtimeEligible,
        overtimeRatePerHour: +f.overtimeRatePerHour,
        shiftAllowance: +f.shiftAllowance,
        nightAllowance: +f.nightAllowance,
        lateRule: { graceMinutes: +f.lateGrace, maxLatePerMonth: +f.maxLatePerMonth },
        earlyCheckoutRule: { graceMinutes: +f.earlyGrace },
      };
      const r =
        modal.mode === 'create'
          ? await scheduleService.createShift(payload)
          : await scheduleService.updateShift(modal.id, payload);
      notify.successFrom(r, 'Shift saved.');
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
      const r = await scheduleService.deleteShift(s.id);
      notify.successFrom(r, 'Shift deactivated.');
      load();
    } catch {
      /* api.js reports every failed request */
    }
  };

  const loadHistory = async (uid) => {
    setHistoryFor(uid);
    if (!uid) {
      setHistory([]);
      return;
    }
    try {
      const d = await scheduleService.shiftHistory(uid);
      setHistory(d.history || []);
    } catch {
      setHistory([]);
    }
  };

  const current = mine?.current;
  const myShift = current?.shift;
  const active = shifts.filter((s) => s.isActive);

  const typeCounts = useMemo(() => {
    const base = Object.fromEntries(SHIFT_TYPES.map((t) => [t, 0]));
    active.forEach((s) => {
      if (base[s.type] !== undefined) base[s.type] += 1;
    });
    return base;
  }, [active]);

  const visibleTypes = useMemo(
    () => (typeTab === 'ALL' ? active : active.filter((s) => s.type === typeTab)),
    [active, typeTab],
  );

  const specRows = useMemo(() => {
    const needle = specQuery.trim().toLowerCase();
    return shifts.filter((s) => {
      if (!needle) return true;
      return `${s.name} ${s.type} ${(s.departments || []).map((d) => d.name).join(' ')}`
        .toLowerCase()
        .includes(needle);
    });
  }, [shifts, specQuery]);

  const crewTotal = active.reduce((acc, s) => acc + (s.employees || []).length, 0);
  const nightShifts = active.filter((s) => s.type === 'NIGHT' || crosses(s));
  const nightAllowance = Math.max(0, ...active.map((s) => Number(s.nightAllowance) || 0));
  const otRates = active.filter((s) => s.overtimeEligible).map((s) => Number(s.overtimeRatePerHour) || 0);
  const defaultShift = useMemo(
    () => [...active].sort((a, b) => (b.employees || []).length - (a.employees || []).length)[0] || null,
    [active],
  );
  const rosterCrew = rosterFor ? shifts.find((s) => s.id === rosterFor)?.employees || [] : [];

  const pickerMatches = useMemo(() => {
    const needle = historyQuery.trim().toLowerCase();
    return empList
      .filter((u) => (needle ? `${u.name} ${u.email || ''}`.toLowerCase().includes(needle) : true))
      .slice(0, 30);
  }, [empList, historyQuery]);

  /* Where the clock sits in my own window — arithmetic on the assigned shift,
     not a punch. Outside the window the bar reports that honestly. */
  const timeline = useMemo(() => {
    if (!myShift) return null;
    const start = toMinutes(myShift.startTime);
    const span = spanMinutes(myShift);
    const elapsed = (nowMin - start + 1440) % 1440;
    const inside = elapsed <= span;
    const breakStart = addMinutes(myShift.startTime, Math.round(span / 2) - 30);
    return {
      span,
      inside,
      elapsed: inside ? elapsed : 0,
      remaining: inside ? span - elapsed : span,
      breakStart,
      breakEnd: addMinutes(breakStart, Number(myShift.breakMinutes) || 0),
      breakAt: Math.round(span / 2) - 30,
    };
  }, [myShift, nowMin]);

  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-8">
        {/* ── hero ─────────────────────────────────────────────────────── */}
        <div className="relative overflow-hidden rounded-xl bg-st-low p-6 shadow-sm md:p-8">
          <div className="pointer-events-none absolute -right-16 -top-16 h-80 w-80 rounded-full bg-st-secondary-fixed/30 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-20 right-48 h-64 w-64 rounded-full bg-st-primary-fixed/40 blur-2xl" />
          <div className="relative z-10 flex flex-col justify-between gap-6 md:flex-row md:items-center">
            <div className="max-w-3xl space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-st-secondary-container px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-st-on-secondary-container">
                  Roster engine
                </span>
                <span className="text-xs font-medium text-st-on-variant">
                  • {active.length} {active.length === 1 ? 'shift' : 'shifts'} · {crewTotal} people assigned
                </span>
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-st-on md:text-4xl">Shifts &amp; rosters</h1>
              <p className="text-sm leading-relaxed text-st-on-variant md:text-base">
                {active.length
                  ? active
                      .map((s) => metaOf(s.type).label)
                      .filter((v, i, a) => a.indexOf(v) === i)
                      .join(' • ')
                  : 'Morning • General • Evening • Night (cross-midnight safe) • Flexible'}
                {' '}— one window per group, with its own break, grace and allowances.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-3">
              <a
                href="#assignment-history"
                className="inline-flex items-center gap-2 rounded-lg bg-st-highest px-4 py-2.5 text-sm font-semibold text-st-on shadow-sm transition hover:bg-st-container"
              >
                <History className="h-[18px] w-[18px]" aria-hidden="true" />
                Timeline &amp; history
              </a>
              {isHR ? (
                <button
                  type="button"
                  onClick={openCreate}
                  className="inline-flex items-center gap-2 rounded-lg bg-st-primary-container px-5 py-2.5 text-sm font-semibold text-st-on-primary-container shadow-md transition hover:opacity-95 active:scale-[0.98]"
                >
                  <Plus className="h-5 w-5" aria-hidden="true" />
                  + New shift
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {/* ── my shift ─────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-st-primary" aria-hidden="true" />
              <h2 className="text-lg font-bold text-st-on">My assigned shift</h2>
            </div>
            <span className="text-xs font-medium text-st-on-variant">
              {current?.source === 'EMPLOYEE_OVERRIDE'
                ? 'Personal assignment overrides the department default'
                : current?.source === 'DEPARTMENT_DEFAULT'
                  ? 'Resolved from your department default'
                  : myShift
                    ? 'Resolved for today'
                    : 'No shift assigned'}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
            <div className="relative flex flex-col justify-between rounded-xl bg-st-lowest p-6 shadow-sm lg:col-span-8 md:p-7">
              {myShift ? (
                <>
                  <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-st-secondary-container px-3 py-1 text-xs font-semibold text-st-on-secondary-container">
                          <span className="h-2 w-2 rounded-full bg-st-secondary" />
                          Active today
                        </span>
                        <span className="rounded-full bg-st-high px-2.5 py-1 text-xs font-medium text-st-on">
                          {metaOf(myShift.type).label} protocol
                        </span>
                        {crosses(myShift) ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-st-tertiary-fixed px-2.5 py-1 text-xs font-semibold text-st-on-tertiary-fixed">
                            <Moon className="h-3.5 w-3.5" aria-hidden="true" /> Cross-midnight
                          </span>
                        ) : null}
                      </div>
                      <h3 className="pt-2 text-2xl font-bold text-st-on">{myShift.name}</h3>
                      <p className="text-xs text-st-on-variant">
                        {(myShift.departments || []).map((d) => d.name).join(' · ') ||
                          'Assigned directly to you'}
                        {myShift.branch ? ` • ${myShift.branch}` : ''}
                      </p>
                    </div>

                    <div className="flex items-center gap-4 self-start rounded-xl bg-st-low px-5 py-3">
                      <div className="text-right">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-st-outline">
                          Scheduled slot
                        </div>
                        <div className="whitespace-nowrap text-base font-bold text-st-on">
                          {clock12(myShift.startTime)} <span className="text-st-outline">→</span>{' '}
                          {clock12(myShift.endTime)}
                        </div>
                      </div>
                      <div className="h-9 w-px bg-st-highest" />
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-st-outline">
                          Duration
                        </div>
                        <div className="text-base font-bold text-st-primary">
                          {netHours(myShift).toFixed(1)} hrs
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="my-6 space-y-2 rounded-xl bg-st-low/70 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-st-on">
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-st-secondary" /> {clock12(myShift.startTime)}{' '}
                        check-in
                      </span>
                      <span className="flex items-center gap-1 text-st-on-variant">
                        <Coffee className="h-3.5 w-3.5" aria-hidden="true" /> {clock12(timeline.breakStart)} (
                        {myShift.breakMinutes}m meal break)
                      </span>
                      <span className="flex items-center gap-1.5">
                        {clock12(myShift.endTime)} shift end
                        <span className="h-2 w-2 rounded-full bg-st-primary-container" />
                      </span>
                    </div>
                    <div className="flex h-3 w-full overflow-hidden rounded-full bg-st-highest">
                      <div
                        className="h-full bg-st-secondary"
                        style={{ width: `${(timeline.elapsed / timeline.span) * 100}%` }}
                        title="Elapsed"
                      />
                      <div
                        className="h-full bg-st-tertiary-fixed-dim/70"
                        style={{ width: `${((Number(myShift.breakMinutes) || 0) / timeline.span) * 100}%` }}
                        title="Break window"
                      />
                      <div className="h-full flex-1 bg-st-high" title="Remaining" />
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-st-on-variant">
                      <span>
                        {timeline.inside ? (
                          <>
                            Elapsed: <strong>{mins12(timeline.elapsed)}</strong>
                          </>
                        ) : (
                          'Outside the window right now'
                        )}
                      </span>
                      <span className="font-semibold text-st-primary">
                        {timeline.inside ? `Remaining: ${mins12(timeline.remaining)}` : `Window: ${mins12(timeline.span)}`}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-col justify-between gap-4 pt-2 md:flex-row md:items-center">
                    <div className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-3">
                      <div>
                        <span className="block text-[11px] font-semibold uppercase text-st-outline">
                          Grace window
                        </span>
                        <span className="font-semibold text-st-on">
                          {graceOf(myShift)} min (until {clock12(addMinutes(myShift.startTime, graceOf(myShift)))})
                        </span>
                      </div>
                      <div>
                        <span className="block text-[11px] font-semibold uppercase text-st-outline">
                          Break allowance
                        </span>
                        <span className="font-semibold text-st-on">{myShift.breakMinutes} min</span>
                      </div>
                      <div>
                        <span className="block text-[11px] font-semibold uppercase text-st-outline">
                          Department
                        </span>
                        <span className="font-semibold text-st-on">
                          {(myShift.departments || []).map((d) => d.name).join(', ') || 'Direct assignment'}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 pt-2 md:pt-0">
                      <a
                        href="/app/leaves"
                        className="flex items-center gap-1.5 rounded-lg bg-st-container px-3.5 py-2 text-xs font-semibold text-st-on transition hover:bg-st-high"
                      >
                        <CalendarRange className="h-4 w-4" aria-hidden="true" />
                        Plan time off
                      </a>
                      <button
                        type="button"
                        disabled
                        title="Shift swaps are arranged with your manager — no self-service endpoint yet."
                        className="flex cursor-not-allowed items-center gap-1.5 rounded-lg bg-st-primary/80 px-3.5 py-2 text-xs font-semibold text-st-on-primary transition"
                      >
                        <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                        Request shift change
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <EmptyState
                  illustration="calendar"
                  title="No shift assigned yet"
                  description="You are on the default work hours. Once a shift is assigned to you or your department, its timings and allowances show up here."
                  size="sm"
                />
              )}
            </div>

            {/* engine card */}
            <div className="flex flex-col justify-between space-y-6 rounded-xl bg-st-inverse p-6 text-st-inverse-on shadow-sm lg:col-span-4">
              <div>
                <div className="flex items-center justify-between pb-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-st-tertiary-fixed-dim">
                    Compliance metric
                  </span>
                  <ShieldCheck className="h-5 w-5 text-st-secondary-fixed" aria-hidden="true" />
                </div>
                <h4 className="text-xl font-bold text-st-inverse-on">Roster assignment engine</h4>
                <p className="mt-1 text-xs leading-relaxed text-st-inverse-on/70">
                  One window per person per day — a personal assignment first, then the department
                  default, then the schedule in force. Cross-midnight shifts end on the next calendar
                  day and are never split across records.
                </p>
                <div className="mt-5 space-y-3">
                  <div className="flex items-center justify-between rounded-lg bg-st-tertiary-fixed/10 p-3">
                    <div className="flex items-center gap-2">
                      <BedDouble className="h-[18px] w-[18px] text-st-tertiary-fixed" aria-hidden="true" />
                      <span className="text-xs font-medium">Night differential</span>
                    </div>
                    <span className="text-xs font-bold text-st-tertiary-fixed">
                      {nightAllowance ? `${money(nightAllowance)} / day` : 'Not configured'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-st-tertiary-fixed/10 p-3">
                    <div className="flex items-center gap-2">
                      <Timer className="h-[18px] w-[18px] text-st-secondary-fixed" aria-hidden="true" />
                      <span className="text-xs font-medium">Overtime rate</span>
                    </div>
                    <span className="text-xs font-bold text-st-secondary-fixed">
                      {otRates.length ? `${money(Math.max(...otRates))} / hr` : 'Not configured'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-st-tertiary-fixed/10 p-3">
                    <div className="flex items-center gap-2">
                      <Gauge className="h-[18px] w-[18px] text-st-primary-fixed" aria-hidden="true" />
                      <span className="text-xs font-medium">Cross-midnight safe</span>
                    </div>
                    <span className="text-xs font-bold text-st-primary-fixed">
                      {nightShifts.length
                        ? `${nightShifts.length} shift${nightShifts.length === 1 ? '' : 's'}`
                        : 'Not needed'}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between text-[11px] text-st-inverse-on/60">
                <span>{crewTotal} people across {active.length} shifts</span>
                <span>Timezone Asia/Kolkata</span>
              </div>
            </div>
          </div>
        </section>

        {/* ── catalog ──────────────────────────────────────────────────── */}
        <section className="space-y-4">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-xl font-bold text-st-on">Company shift catalog &amp; rosters</h2>
              <p className="text-xs text-st-on-variant">
                Every window the company works, with its break, grace and differential.
              </p>
            </div>
            <div className="flex items-center gap-1.5 overflow-x-auto rounded-xl bg-st-high p-1">
              <button
                type="button"
                onClick={() => setTypeTab('ALL')}
                className={`whitespace-nowrap rounded-lg px-3.5 py-1.5 text-xs transition ${
                  typeTab === 'ALL'
                    ? 'bg-st-lowest font-bold text-st-on shadow-sm'
                    : 'font-medium text-st-on-variant hover:text-st-on'
                }`}
              >
                All ({active.length})
              </button>
              {SHIFT_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTypeTab(t)}
                  className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs transition ${
                    typeTab === t
                      ? 'bg-st-lowest font-bold text-st-on shadow-sm'
                      : 'font-medium text-st-on-variant hover:text-st-on'
                  }`}
                >
                  {metaOf(t).label} ({typeCounts[t]})
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {visibleTypes.map((s) => {
              const crew = s.employees || [];
              const isDefault = defaultShift?.id === s.id;
              return (
                <div
                  key={s.id}
                  className="relative flex flex-col justify-between space-y-4 rounded-xl bg-st-lowest p-5 shadow-sm transition hover:shadow-md"
                >
                  {isDefault ? <div className="absolute inset-x-0 top-0 h-1 rounded-t-xl bg-st-primary-container" /> : null}
                  <div>
                    <div className="flex items-center justify-between">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                          isDefault ? 'bg-st-primary-fixed text-st-on-primary-fixed' : TYPE_META.GENERAL.chip
                        }`}
                      >
                        {isDefault ? 'Default company shift' : 'Active'}
                      </span>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-st-outline">
                          {metaOf(s.type).label}
                        </span>
                        <button
                          type="button"
                          onClick={() => openEdit(s)}
                          className="flex h-6 w-6 items-center justify-center rounded text-st-outline hover:text-st-on"
                          aria-label={`Edit ${s.name}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    <h3 className="mt-2.5 text-base font-bold text-st-on">{s.name}</h3>
                    <p className="text-xs text-st-on-variant">
                      {(s.departments || []).map((d) => d.name).join(', ') || `${metaOf(s.type).label} shift`}
                    </p>
                  </div>

                  <div className="space-y-1 rounded-lg bg-st-low p-3">
                    <div className="text-sm font-bold tracking-tight text-st-on">
                      {clock12(s.startTime)} <span className="font-normal text-st-outline">→</span>{' '}
                      {clock12(s.endTime)}
                      {crosses(s) ? (
                        <span className="ml-1 rounded bg-st-primary-fixed/50 px-1 text-[10px] font-semibold text-st-primary">
                          +1D
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center justify-between text-xs text-st-on-variant">
                      <span>
                        {netHours(s).toFixed(1)} hrs (incl. {s.breakMinutes}m break)
                      </span>
                      <span className="font-semibold text-st-secondary">{graceOf(s)}m grace</span>
                    </div>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div className="flex items-center justify-between text-st-on-variant">
                      <span>Differential pay:</span>
                      <span
                        className={`font-semibold ${
                          s.nightAllowance > 0 ? 'text-st-primary' : 'text-st-on'
                        }`}
                      >
                        {s.nightAllowance > 0
                          ? `${money(s.nightAllowance)} night / day`
                          : s.shiftAllowance > 0
                            ? `${money(s.shiftAllowance)} shift / day`
                            : 'Standard base'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-st-on-variant">
                      <span>Assigned crew:</span>
                      <div className="flex items-center gap-1.5">
                        <div className="flex -space-x-1.5">
                          {crew.slice(0, 3).map((p) => (
                            <span
                              key={p.id || p.name}
                              className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-st-secondary text-[9px] font-bold text-st-on-secondary ring-2 ring-st-lowest"
                              title={p.name}
                            >
                              {initials(p.name)}
                            </span>
                          ))}
                          {crew.length > 3 ? (
                            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-st-inverse text-[9px] font-bold text-st-inverse-on ring-2 ring-st-lowest">
                              +{crew.length - 3}
                            </span>
                          ) : null}
                        </div>
                        <span className="font-bold text-st-on">{crew.length} assigned</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setRosterFor(s.id)}
                      className={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition ${
                        isDefault
                          ? 'bg-st-primary-container text-st-on-primary-container hover:opacity-95'
                          : 'bg-st-container text-st-on hover:bg-st-high'
                      }`}
                    >
                      Roster
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setAssignFor({
                          ...s,
                          mode: 'EMPLOYEE',
                          userIds: [],
                          departmentId: '',
                          effectiveFrom: new Date().toISOString().slice(0, 10),
                          reason: '',
                        })
                      }
                      className="rounded-lg bg-st-container px-3 py-1.5 text-xs font-semibold text-st-on transition hover:bg-st-high"
                      aria-label={`Assign people to ${s.name}`}
                    >
                      <UserPlus className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => deactivate(s)}
                      className="rounded-lg bg-st-container px-2 py-1.5 text-st-on-variant transition hover:bg-st-error-container hover:text-st-error"
                      aria-label={`Deactivate ${s.name}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              );
            })}

            {!loading && !visibleTypes.length ? (
              <div className="rounded-xl bg-st-lowest p-5 shadow-sm md:col-span-2 xl:col-span-4">
                <EmptyState
                  illustration="calendar"
                  title={active.length ? 'No shift of this type' : 'No shifts yet'}
                  description={
                    active.length
                      ? 'Pick another type, or create the window this team actually works.'
                      : 'Create the shifts your teams actually work — General, Morning, Night — then assign them to people or departments.'
                  }
                  size="sm"
                />
              </div>
            ) : null}
          </div>
        </section>

        {/* ── specifications ───────────────────────────────────────────── */}
        {isHR ? (
          <section className="space-y-5 rounded-xl bg-st-lowest p-6 shadow-sm">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <h3 className="text-lg font-bold text-st-on">Shift specifications &amp; attendance rules</h3>
                <p className="text-xs text-st-on-variant">
                  The grace, break deduction and differential each shift is measured against.
                </p>
              </div>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-2.5 h-[18px] w-[18px] text-st-outline"
                  aria-hidden="true"
                />
                <input
                  className="rounded-lg bg-st-container py-2 pl-9 pr-4 text-xs font-medium text-st-on placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container"
                  placeholder="Filter by policy…"
                  value={specQuery}
                  onChange={(e) => setSpecQuery(e.target.value)}
                  aria-label="Filter specifications"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="rounded-lg bg-st-low font-label text-[11px] font-bold uppercase tracking-wider text-st-outline">
                    <th className="rounded-l-lg px-4 py-3.5">Shift name</th>
                    <th className="px-4 py-3.5">Timing window</th>
                    <th className="px-4 py-3.5">Grace in / out</th>
                    <th className="px-4 py-3.5">Break deduction</th>
                    <th className="px-4 py-3.5">Allowance / diff.</th>
                    <th className="px-4 py-3.5">Staff count</th>
                    <th className="rounded-r-lg px-4 py-3.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="text-xs">
                  {specRows.map((s) => (
                    <tr key={s.id} className="transition hover:bg-st-low/60">
                      <td className="px-4 py-3.5">
                        <div className="font-bold text-st-on">{s.name}</div>
                        <div className="text-[11px] text-st-on-variant">
                          {(s.departments || []).map((d) => d.name).join(', ') ||
                            `${metaOf(s.type).label} shift`}
                          {s.isActive ? '' : ' · inactive'}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3.5 font-medium text-st-on">
                        {clock12(s.startTime)} – {clock12(s.endTime)}{' '}
                        <span className="text-[11px] text-st-outline">
                          ({netHours(s).toFixed(1)}h)
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3.5 text-st-on-variant">
                        {graceOf(s)} mins / {earlyOf(s)} mins
                      </td>
                      <td className="whitespace-nowrap px-4 py-3.5 text-st-on-variant">
                        {s.breakMinutes} mins (auto-deducted)
                      </td>
                      <td className="whitespace-nowrap px-4 py-3.5">
                        {s.nightAllowance > 0 ? (
                          <span className="rounded bg-st-tertiary-fixed px-2 py-0.5 text-[11px] font-bold text-st-on-tertiary-fixed">
                            {money(s.nightAllowance)} night
                          </span>
                        ) : s.shiftAllowance > 0 ? (
                          <span className="rounded bg-st-secondary-container px-2 py-0.5 text-[11px] font-semibold text-st-on-secondary-container">
                            {money(s.shiftAllowance)} shift
                          </span>
                        ) : (
                          <span className="rounded bg-st-container px-2 py-0.5 text-[11px] font-semibold text-st-on">
                            Regular
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3.5 font-bold text-st-on">
                        {(s.employees || []).length}{' '}
                        <span className="font-normal text-st-on-variant">
                          {(s.employees || []).length === 1 ? 'employee' : 'employees'}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3.5 text-right">
                        <button
                          type="button"
                          onClick={() => openEdit(s)}
                          className="rounded px-2 py-1 text-xs font-semibold text-st-primary hover:underline"
                        >
                          Configure
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!specRows.length ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-[11px] text-st-on-variant">
                        No shift matches that filter.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col items-center justify-between gap-2 pt-3 text-xs text-st-on-variant sm:flex-row">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-st-secondary" />
                <span>
                  Showing {specRows.length} of {shifts.length} configured shifts
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <span>
                  Cross-midnight cutoff: <strong className="text-st-on">00:00 auto-rollover</strong>
                </span>
                <span>
                  Timezone: <strong className="text-st-on">Asia/Kolkata (IST +5:30)</strong>
                </span>
              </div>
            </div>
          </section>
        ) : null}

        {/* ── assignment history ──────────────────────────────────────── */}
        {isHR ? (
          <section id="assignment-history" className="space-y-4 rounded-xl bg-st-lowest p-6 shadow-sm">
            <div>
              <h3 className="flex items-center gap-2 text-base font-bold text-st-on">
                <History className="h-4 w-4 text-st-outline" aria-hidden="true" />
                Assignment history
              </h3>
              <p className="text-xs text-st-on-variant">
                Every window a person has been on, newest first. The previous assignment closes the
                day before the next one starts.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="relative block min-w-[220px] flex-1 sm:max-w-sm">
                <Search
                  className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-st-outline"
                  aria-hidden="true"
                />
                <input
                  className="w-full rounded-lg bg-st-container py-1.5 pl-7 pr-3 text-xs text-st-on placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container"
                  placeholder="Search a person by name or email…"
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                  aria-label="Search people"
                />
              </label>
              {historyFor ? (
                <button
                  type="button"
                  onClick={() => {
                    setHistoryFor('');
                    setHistory([]);
                  }}
                  className="flex items-center gap-1 rounded-lg bg-st-container px-2.5 py-1.5 text-[11px] font-semibold text-st-on-variant hover:bg-st-high"
                >
                  <X className="h-3 w-3" aria-hidden="true" /> Clear
                </button>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-1.5">
              {pickerMatches.map((u) => {
                const id = String(u._id || u.id);
                const on = historyFor === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => loadHistory(id)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                      on
                        ? 'bg-st-secondary-container text-st-on-secondary-container'
                        : 'bg-st-container text-st-on-variant hover:bg-st-high hover:text-st-on'
                    }`}
                  >
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-st-lowest text-[9px] font-bold">
                      {initials(u.name)}
                    </span>
                    {u.name}
                  </button>
                );
              })}
              {!pickerMatches.length ? (
                <p className="text-[11px] text-st-on-variant">
                  {empList.length ? 'No person matches that search.' : 'No people could be read for this company.'}
                </p>
              ) : null}
            </div>

            <div className="border-t border-st-high pt-3">
              {!historyFor ? (
                <p className="text-[11px] text-st-on-variant">Pick a person above to read their trail.</p>
              ) : !history.length ? (
                <p className="text-[11px] text-st-on-variant">No assignment history for this person yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {history.map((h) => (
                    <li
                      key={h.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg bg-st-low px-2.5 py-1.5 text-[11px]"
                    >
                      {h.current ? (
                        <span className="inline-flex items-center gap-1 font-bold text-st-secondary">
                          <span className="h-1.5 w-1.5 rounded-full bg-st-secondary" />
                          {h.shift?.name || '—'}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 font-semibold text-st-on">
                          <Circle className="h-1.5 w-1.5" aria-hidden="true" />
                          {h.shift?.name || '—'}
                        </span>
                      )}
                      <span className="text-st-on-variant">
                        {h.effectiveFrom} → {h.effectiveTo || 'present'}
                      </span>
                      {h.prevShift ? <span className="text-st-on-variant">(was {h.prevShift})</span> : null}
                      {h.reason ? <span className="text-st-on-variant">· {h.reason}</span> : null}
                      {h.changedBy ? <span className="ml-auto text-st-on-variant">by {h.changedBy}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        ) : null}
      </div>

      {/* ── roster drawer ───────────────────────────────────────────────── */}
      {rosterFor ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-st-inverse/50 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setRosterFor(null)}
        >
          <div
            className="max-h-[88vh] w-full max-w-md overflow-hidden rounded-t-2xl bg-st-lowest shadow-2xl sm:rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2 border-b border-st-high bg-st-low px-4 py-3">
              <div>
                <h3 className="text-base font-bold text-st-on">
                  {shifts.find((s) => s.id === rosterFor)?.name} roster
                </h3>
                <p className="text-xs text-st-on-variant">{rosterCrew.length} assigned to this window.</p>
              </div>
              <button
                type="button"
                onClick={() => setRosterFor(null)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-st-outline hover:bg-st-container hover:text-st-on"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <ul className="max-h-[60vh] overflow-y-auto px-3 py-2">
              {rosterCrew.map((p) => (
                <li
                  key={p.id || p.name}
                  className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs hover:bg-st-low"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-st-secondary-fixed text-[10px] font-bold text-st-on-secondary-fixed">
                    {initials(p.name)}
                  </span>
                  <span className="min-w-0 truncate font-semibold text-st-on">{p.name}</span>
                </li>
              ))}
              {!rosterCrew.length ? (
                <li className="px-2 py-4 text-center text-[11px] text-st-on-variant">
                  Nobody is assigned to this shift yet.
                </li>
              ) : null}
            </ul>
            <div className="border-t border-st-high bg-st-low px-4 py-2.5">
              <button
                type="button"
                onClick={() => {
                  const s = shifts.find((x) => x.id === rosterFor);
                  setRosterFor(null);
                  setAssignFor({
                    ...s,
                    mode: 'EMPLOYEE',
                    userIds: [],
                    departmentId: '',
                    effectiveFrom: new Date().toISOString().slice(0, 10),
                    reason: '',
                  });
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-st-primary-container px-3 py-2 text-xs font-semibold text-st-on-primary-container shadow-sm transition hover:opacity-95"
              >
                <UserPlus className="h-4 w-4" aria-hidden="true" /> Assign people
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── create / edit ───────────────────────────────────────────────── */}
      {modal ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-st-inverse/50 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setModal(null)}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-st-lowest shadow-2xl sm:rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-2 border-b border-st-high bg-st-low px-6 py-4">
              <div>
                <h3 className="text-base font-bold text-st-on">
                  {modal.mode === 'create' ? 'Create operational shift' : `Edit ${modal.form.name}`}
                </h3>
                <p className="text-xs text-st-on-variant">
                  An end time earlier than the start means the shift crosses midnight.
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

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1.5 block font-semibold text-st-on">Shift title</span>
                  <input
                    className="w-full rounded-lg bg-st-container px-3.5 py-2.5 text-st-on placeholder:text-st-on-variant/50 focus:outline-none focus:ring-2 focus:ring-st-primary-container"
                    value={modal.form.name}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, name: e.target.value } })}
                    placeholder="Night shift"
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block font-semibold text-st-on">Type</span>
                  <select
                    className="w-full rounded-lg bg-st-container px-3.5 py-2.5 text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container"
                    value={modal.form.type}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, type: e.target.value } })}
                  >
                    {SHIFT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {metaOf(t).label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block font-semibold text-st-on">Start time</span>
                  <input
                    type="time"
                    className="w-full rounded-lg bg-st-container px-3.5 py-2.5 text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container"
                    value={modal.form.startTime}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, startTime: e.target.value } })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block font-semibold text-st-on">End time</span>
                  <input
                    type="time"
                    className="w-full rounded-lg bg-st-container px-3.5 py-2.5 text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container"
                    value={modal.form.endTime}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, endTime: e.target.value } })}
                  />
                </label>
              </div>

              <div className="flex items-start gap-2.5 rounded-lg bg-st-low p-3">
                <Moon className="mt-0.5 h-4 w-4 shrink-0 text-st-primary" aria-hidden="true" />
                <div>
                  <span className="block font-bold text-st-on">
                    {crosses(modal.form) ? 'Cross-midnight safe shift' : 'Same-day shift'}
                  </span>
                  <span className="text-[11px] text-st-on-variant">
                    {crosses(modal.form)
                      ? 'Check-in and check-out span consecutive calendar dates without splitting the attendance record.'
                      : 'Check-in and check-out land on the same calendar date.'}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {[
                  ['breakMinutes', 'Break (min)'],
                  ['lateGrace', 'Late grace (min)'],
                  ['earlyGrace', 'Early-out grace (min)'],
                  ['maxLatePerMonth', 'Max lates / month'],
                  ['overtimeRatePerHour', 'OT ₹ / hr'],
                  ['shiftAllowance', 'Shift allowance ₹ / day'],
                  ['nightAllowance', 'Night allowance ₹ / day'],
                ].map(([k, label]) => (
                  <label key={k} className="block">
                    <span className="mb-1.5 block font-semibold text-st-on">{label}</span>
                    <input
                      type="number"
                      min="0"
                      className="w-full rounded-lg bg-st-container px-3.5 py-2.5 text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container"
                      value={modal.form[k]}
                      onChange={(e) => setModal({ ...modal, form: { ...modal.form, [k]: e.target.value } })}
                    />
                  </label>
                ))}
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

              <p className="rounded-lg bg-st-low px-3 py-2 text-[11px] leading-relaxed text-st-on-variant">
                This window covers {netHours(modal.form).toFixed(1)} hours after a{' '}
                {modal.form.breakMinutes || 0} minute break
                {crosses(modal.form) ? ', ending on the next calendar day' : ''}.
              </p>
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
                className="rounded-lg bg-st-primary-container px-5 py-2 text-xs font-semibold text-st-on-primary-container shadow-sm transition hover:opacity-95 disabled:opacity-50"
                disabled={saving || !modal.form.name}
                onClick={save}
              >
                {saving ? 'Saving…' : 'Save & publish shift'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── assign ──────────────────────────────────────────────────────── */}
      {assignFor ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-st-inverse/50 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setAssignFor(null)}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-st-lowest shadow-2xl sm:rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-2 border-b border-st-high bg-st-low px-6 py-4">
              <div>
                <h3 className="text-base font-bold text-st-on">Assign “{assignFor.name}”</h3>
                <p className="text-xs text-st-on-variant">
                  An employee assignment overrides the department default for that person.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAssignFor(null)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-st-outline hover:bg-st-container hover:text-st-on"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-5">
              <div className="flex gap-1.5">
                {[
                  ['EMPLOYEE', 'People'],
                  ['DEPARTMENT', 'Whole department'],
                ].map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setAssignFor({ ...assignFor, mode: m })}
                    className={`flex-1 rounded-lg px-3 py-1.5 text-[11px] font-bold transition ${
                      assignFor.mode === m
                        ? 'bg-st-secondary-container text-st-on-secondary-container'
                        : 'bg-st-container text-st-on-variant'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {assignFor.mode === 'EMPLOYEE' ? (
                <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-st-high p-1.5">
                  {empList.map((u) => {
                    const id = String(u._id || u.id);
                    const on = assignFor.userIds.includes(id);
                    return (
                      <label
                        key={id}
                        className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${
                          on
                            ? 'bg-st-secondary-container/60 font-semibold text-st-on'
                            : 'text-st-on-variant hover:bg-st-low'
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="accent-st-primary"
                          checked={on}
                          onChange={() =>
                            setAssignFor({
                              ...assignFor,
                              userIds: on
                                ? assignFor.userIds.filter((x) => x !== id)
                                : [...assignFor.userIds, id],
                            })
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">{u.name}</span>
                        <span className="shrink-0 text-[10px] text-st-on-variant">{u.email}</span>
                      </label>
                    );
                  })}
                  {!empList.length ? (
                    <p className="px-2 py-3 text-[11px] text-st-on-variant">No people could be read.</p>
                  ) : null}
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {departments.map((d) => {
                    const id = String(d._id || d.id);
                    const on = assignFor.departmentId === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setAssignFor({ ...assignFor, departmentId: id })}
                        className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${
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
                    <p className="text-[11px] text-st-on-variant">No departments found.</p>
                  ) : null}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 text-xs">
                <label className="block">
                  <span className="mb-1.5 block font-semibold text-st-on">Effective from</span>
                  <input
                    type="date"
                    className="w-full rounded-lg bg-st-container px-3 py-2 text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container"
                    value={assignFor.effectiveFrom}
                    onChange={(e) => setAssignFor({ ...assignFor, effectiveFrom: e.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block font-semibold text-st-on">Reason</span>
                  <input
                    className="w-full rounded-lg bg-st-container px-3 py-2 text-st-on placeholder:text-st-on-variant/50 focus:outline-none focus:ring-2 focus:ring-st-primary-container"
                    value={assignFor.reason}
                    onChange={(e) => setAssignFor({ ...assignFor, reason: e.target.value })}
                    placeholder="Project requirement"
                  />
                </label>
              </div>
              <p className="text-[11px] leading-relaxed text-st-on-variant">
                History is preserved — the previous assignment closes the day before this one starts.
              </p>
            </div>

            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-st-high bg-st-low px-6 py-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="rounded-lg bg-st-container px-4 py-2 text-xs font-semibold text-st-on transition hover:bg-st-high"
                onClick={() => setAssignFor(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-lg bg-st-primary-container px-5 py-2 text-xs font-semibold text-st-on-primary-container shadow-sm transition hover:opacity-95 disabled:opacity-50"
                disabled={
                  saving || (assignFor.mode === 'EMPLOYEE' ? !assignFor.userIds.length : !assignFor.departmentId)
                }
                onClick={async () => {
                  setSaving(true);
                  try {
                    const r = await scheduleService.assignShift(assignFor.id, {
                      userIds: assignFor.mode === 'EMPLOYEE' ? assignFor.userIds : [],
                      departmentId: assignFor.mode === 'DEPARTMENT' ? assignFor.departmentId : null,
                      effectiveFrom: assignFor.effectiveFrom,
                      reason: assignFor.reason,
                    });
                    notify.successFrom(r, 'Shift assigned.');
                    setAssignFor(null);
                    load();
                  } catch {
                    /* api.js reports every failed request */
                  }
                  setSaving(false);
                }}
              >
                {saving ? (
                  'Assigning…'
                ) : (
                  <>
                    <Check className="h-4 w-4" aria-hidden="true" /> Assign
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
