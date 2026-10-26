import { useEffect, useMemo, useState } from 'react';
import {
  Banknote,
  Building2,
  Check,
  Circle,
  Coffee,
  Gauge,
  History,
  Moon,
  Pencil,
  Plus,
  ScrollText,
  Search,
  ShieldCheck,
  Sunrise,
  Sunset,
  Timer,
  Trash2,
  UserPlus,
  Users,
  Wrench,
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
  MORNING: { label: 'Morning', Icon: Sunrise, chip: 'bg-crewly-orange/15 text-crewly-orange' },
  GENERAL: { label: 'General', Icon: Building2, chip: 'bg-crewly-green/15 text-crewly-green' },
  EVENING: { label: 'Evening', Icon: Sunset, chip: 'bg-crewly-accent/15 text-crewly-orange' },
  NIGHT: { label: 'Night', Icon: Moon, chip: 'bg-crewly-selected/60 text-crewly-text' },
  FLEXIBLE: { label: 'Flexible', Icon: Timer, chip: 'bg-crewly-inset-strong text-crewly-dim' },
  CUSTOM: { label: 'Custom', Icon: Wrench, chip: 'bg-crewly-inset-strong text-crewly-dim' },
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

/* The window the shift actually covers, wrapped across midnight when it must. */
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

  const visibleTypes = useMemo(() => {
    if (typeTab === 'ALL') return active;
    return active.filter((s) => s.type === typeTab);
  }, [active, typeTab]);

  const specRows = useMemo(() => {
    const needle = specQuery.trim().toLowerCase();
    return shifts.filter((s) => {
      if (!needle) return true;
      return `${s.name} ${s.type} ${(s.departments || []).map((d) => d.name).join(' ')}`.toLowerCase().includes(needle);
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

  const rosterCrew = rosterFor ? (shifts.find((s) => s.id === rosterFor)?.employees || []) : [];

  const pickerMatches = useMemo(() => {
    const needle = historyQuery.trim().toLowerCase();
    return empList
      .filter((u) => (needle ? `${u.name} ${u.email || ''}`.toLowerCase().includes(needle) : true))
      .slice(0, 30);
  }, [empList, historyQuery]);

  /* Timeline for my own window: check-in, meal break, shift end. Straight
     arithmetic on the assigned shift — no live punch is read here. */
  const timeline = useMemo(() => {
    if (!myShift) return null;
    const breakStart = addMinutes(myShift.startTime, Math.round(spanMinutes(myShift) / 2) - 30);
    const breakEnd = addMinutes(breakStart, Number(myShift.breakMinutes) || 0);
    return {
      checkIn: myShift.startTime,
      breakStart,
      breakEnd,
      end: myShift.endTime,
      breakRatio: Math.round(spanMinutes(myShift) / 2),
    };
  }, [myShift]);

  return (
    <div className="space-y-5">
      {/* ── hero ──────────────────────────────────────────────────────── */}
      <section className="card relative overflow-hidden">
        <span
          className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-crewly-green/10 blur-2xl"
          aria-hidden="true"
        />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-crewly-dim">
              <span className="rounded-full bg-crewly-green/12 px-2 py-0.5 normal-case tracking-normal text-crewly-green">
                Roster engine
              </span>
              {active.length} {active.length === 1 ? 'shift' : 'shifts'} configured
              <span className="text-crewly-border">•</span>
              {crewTotal} {crewTotal === 1 ? 'person' : 'people'} assigned
            </p>
            <h1 className="mt-1 text-[26px] font-bold leading-tight sm:text-[34px]">Shifts &amp; rosters</h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-crewly-dim">
              {active.length
                ? active.map((s) => metaOf(s.type).label).filter((v, i, a) => a.indexOf(v) === i).join(' · ')
                : 'Morning · General · Evening · Night (cross-midnight safe) · Flexible'}
              . One window per group, with its own break, grace and allowances.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <a
              href="#assignment-history"
              className="btn-ghost inline-flex items-center gap-2 whitespace-nowrap px-3 py-2 text-xs font-bold"
            >
              <History className="h-4 w-4" aria-hidden="true" /> Assignment history
            </a>
            {isHR ? (
              <button
                type="button"
                onClick={openCreate}
                className="btn-primary inline-flex items-center gap-2 whitespace-nowrap px-4 py-2 text-xs font-bold"
              >
                <Plus className="h-4 w-4" aria-hidden="true" /> New shift
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {/* ── my shift + the engine ─────────────────────────────────────── */}
      <div className="grid items-stretch gap-4 xl:grid-cols-3">
        <section className="card xl:col-span-2">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-crewly-dim">
              My assigned shift
            </p>
            <span className="text-[10px] text-crewly-dim">
              {current?.source === 'EMPLOYEE_OVERRIDE'
                ? 'Personal override'
                : current?.source === 'DEPARTMENT_DEFAULT'
                  ? 'Department default'
                  : myShift
                    ? 'Resolved for today'
                    : 'Nothing assigned'}
            </span>
          </div>

          {myShift ? (
            <>
              <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-crewly-green/12 px-2 py-0.5 text-[10px] font-bold text-crewly-green">
                      <span className="h-1.5 w-1.5 rounded-full bg-crewly-green" aria-hidden="true" />
                      Active today
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${metaOf(myShift.type).chip}`}>
                      {metaOf(myShift.type).label}
                    </span>
                    {crosses(myShift) ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-crewly-selected/60 px-2 py-0.5 text-[10px] font-bold">
                        <Moon className="h-3 w-3" aria-hidden="true" /> Cross-midnight
                      </span>
                    ) : null}
                  </div>
                  <h2 className="mt-1.5 text-2xl font-bold leading-tight">{myShift.name}</h2>
                  <p className="mt-0.5 text-[11px] text-crewly-dim">
                    {(myShift.departments || []).map((d) => d.name).join(' · ') ||
                      'Assigned directly to you'}
                    {myShift.branch ? ` · ${myShift.branch}` : ''}
                  </p>
                </div>

                <div className="flex shrink-0 gap-2">
                  <div className="rounded-xl bg-crewly-inset/70 px-3 py-2">
                    <p className="text-[9px] font-bold uppercase tracking-wide text-crewly-dim">
                      Scheduled slot
                    </p>
                    <p className="mt-0.5 whitespace-nowrap text-[13px] font-bold tabular-nums">
                      {clock12(myShift.startTime)} <span className="text-crewly-dim">→</span>{' '}
                      {clock12(myShift.endTime)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-crewly-inset/70 px-3 py-2 text-center">
                    <p className="text-[9px] font-bold uppercase tracking-wide text-crewly-dim">Duration</p>
                    <p className="mt-0.5 text-[13px] font-bold">{netHours(myShift).toFixed(1)} hrs</p>
                  </div>
                </div>
              </div>

              <div className="mt-4 rounded-xl bg-crewly-inset/50 p-3">
                <div className="flex items-center justify-between text-[10px] font-bold text-crewly-dim">
                  <span className="inline-flex items-center gap-1 text-crewly-text">
                    <span className="h-1.5 w-1.5 rounded-full bg-crewly-green" aria-hidden="true" />
                    {clock12(timeline.checkIn)} Check-in
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Coffee className="h-3 w-3" aria-hidden="true" />
                    {clock12(timeline.breakStart)} Meal break ({myShift.breakMinutes}m)
                  </span>
                  <span className="inline-flex items-center gap-1 text-crewly-orange">
                    {clock12(timeline.end)} Shift end
                    <span className="h-1.5 w-1.5 rounded-full bg-crewly-orange" aria-hidden="true" />
                  </span>
                </div>
                <span className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-crewly-inset-strong">
                  <span className="bg-crewly-green/70" style={{ width: `${(timeline.breakRatio / spanMinutes(myShift)) * 100}%` }} />
                  <span className="bg-crewly-dim/40" style={{ width: `${((Number(myShift.breakMinutes) || 0) / spanMinutes(myShift)) * 100}%` }} />
                  <span className="bg-crewly-accent/60" style={{ flex: 1 }} />
                </span>
                <div className="mt-1 flex justify-between text-[9px] text-crewly-dim">
                  <span>Grace {graceOf(myShift)} min · until {clock12(addMinutes(myShift.startTime, graceOf(myShift)))}</span>
                  <span>Break allowance {myShift.breakMinutes} min</span>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ['Grace window', `${graceOf(myShift)} min`, 'from the scheduled start'],
                  ['Early clock-out', `${earlyOf(myShift)} min`, 'before the end time'],
                  [
                    'Allowance',
                    myShift.nightAllowance > 0
                      ? `${money(myShift.nightAllowance)}/day`
                      : myShift.shiftAllowance > 0
                        ? `${money(myShift.shiftAllowance)}/day`
                        : 'None',
                    myShift.nightAllowance > 0 ? 'night differential' : 'shift differential',
                  ],
                  [
                    'Overtime',
                    myShift.overtimeEligible ? `${money(myShift.overtimeRatePerHour)}/hr` : 'Not eligible',
                    myShift.overtimeEligible ? 'paid past the end time' : 'recorded, not paid',
                  ],
                ].map(([label, value, note]) => (
                  <div key={label}>
                    <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-crewly-dim">{label}</p>
                    <p className="mt-0.5 text-[12px] font-bold">{value}</p>
                    <p className="text-[9px] leading-tight text-crewly-dim">{note}</p>
                  </div>
                ))}
              </div>

              {(mine?.history || []).length ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-crewly-border pt-2.5 text-[10px] text-crewly-dim">
                  <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
                  Last change:{' '}
                  <span className="font-semibold text-crewly-text">{mine.history[0].shift}</span>
                  from {mine.history[0].effectiveFrom}
                  {mine.history[0].changedBy ? ` · by ${mine.history[0].changedBy}` : ''}
                </div>
              ) : null}
            </>
          ) : (
            <div className="mt-2">
              <EmptyState
                illustration="calendar"
                title="No shift assigned yet"
                description="You are on the default work hours. Once a shift is assigned to you or your department, its timings and allowances show up here."
                size="sm"
              />
            </div>
          )}
        </section>

        {/* the dark engine card from the mock */}
        <section className="flex flex-col rounded-xl bg-crewly-inset-strong p-4">
          <div className="flex items-start justify-between">
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-crewly-dim">
              Compliance metric
            </p>
            <Gauge className="h-4 w-4 text-crewly-dim" aria-hidden="true" />
          </div>
          <h2 className="mt-1.5 text-lg font-bold leading-tight">Roster assignment engine</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-crewly-dim">
            A person&apos;s window is resolved once per day: a personal assignment first, then the
            department default, then the schedule in force. Cross-midnight shifts end on the next
            calendar day and are never split across two records.
          </p>

          <div className="mt-3 space-y-1.5">
            {[
              [
                Moon,
                'Night differential',
                nightAllowance ? `${money(nightAllowance)} / day` : 'Not configured',
              ],
              [
                Banknote,
                'Overtime rate',
                otRates.length ? `up to ${money(Math.max(...otRates))} / hr` : 'Not configured',
              ],
              [
                ShieldCheck,
                'Cross-midnight safe',
                nightShifts.length ? `${nightShifts.length} shift${nightShifts.length === 1 ? '' : 's'}` : 'Not needed',
              ],
              [Users, 'Assigned crew', `${crewTotal} across ${active.length} shifts`],
            ].map(([Icon, label, value]) => (
              <div key={label} className="flex items-center gap-2 rounded-lg bg-crewly-card/60 px-2.5 py-1.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-crewly-inset text-crewly-dim">
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1 text-[11px] text-crewly-dim">{label}</span>
                <span className="shrink-0 text-[11px] font-bold">{value}</span>
              </div>
            ))}
          </div>

          <p className="mt-auto pt-3 text-[10px] leading-relaxed text-crewly-dim">
            Company timezone Asia/Kolkata · the window in force today is read from the shift
            assigned to you, not from the catalog.
          </p>
        </section>
      </div>

      {/* ── catalog ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="card-title text-lg font-bold">Company shift catalog</h2>
          <p className="text-[11px] text-crewly-dim">
            Every window the company works, with its break, grace and differential.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setTypeTab('ALL')}
            className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition ${
              typeTab === 'ALL' ? 'bg-crewly-inset-strong text-crewly-text' : 'text-crewly-dim hover:text-crewly-text'
            }`}
          >
            All <span className="opacity-70">({active.length})</span>
          </button>
          {SHIFT_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTypeTab(t)}
              className={`rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition ${
                typeTab === t ? 'bg-crewly-inset-strong text-crewly-text' : 'text-crewly-dim hover:text-crewly-text'
              }`}
            >
              {metaOf(t).label} <span className="opacity-70">({typeCounts[t]})</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {visibleTypes.map((s) => {
          const crew = s.employees || [];
          const isDefault = defaultShift?.id === s.id;
          return (
            <section
              key={s.id}
              className={`card flex flex-col p-0 ${isDefault ? 'border-t-2 border-t-crewly-accent' : ''}`}
            >
              <div className="flex items-start justify-between gap-2 px-3 pt-3">
                <div className="flex flex-wrap gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-crewly-inset px-1.5 py-0.5 text-[9px] font-bold uppercase">
                    <span className="h-1.5 w-1.5 rounded-full bg-crewly-green" aria-hidden="true" /> Active
                  </span>
                  {isDefault ? (
                    <span className="rounded-full bg-crewly-accent/15 px-1.5 py-0.5 text-[9px] font-bold text-crewly-orange">
                      Default company shift
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-0.5">
                  <button
                    type="button"
                    onClick={() => setRosterFor(s.id)}
                    className="rounded-md p-1 text-crewly-dim hover:bg-crewly-inset hover:text-crewly-text"
                    aria-label={`Roster for ${s.name}`}
                  >
                    <Users className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(s)}
                    className="rounded-md p-1 text-crewly-dim hover:bg-crewly-inset hover:text-crewly-text"
                    aria-label={`Edit ${s.name}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div className="flex flex-1 flex-col px-3 pt-1.5">
                <h3 className="text-[15px] font-bold leading-tight">{s.name}</h3>
                <p className="mt-0.5 text-[10px] leading-snug text-crewly-dim">
                  {(s.departments || []).map((d) => d.name).join(', ') || metaOf(s.type).label + ' shift'}
                </p>

                <div className="mt-2 rounded-lg bg-crewly-inset/70 p-2.5">
                  <p className="whitespace-nowrap text-[12px] font-bold tabular-nums">
                    {clock12(s.startTime)} <span className="text-crewly-dim">→</span> {clock12(s.endTime)}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-crewly-dim">
                    {netHours(s).toFixed(1)}h · {s.breakMinutes}m break
                    {crosses(s) ? (
                      <span className="inline-flex items-center gap-0.5 font-semibold text-crewly-orange">
                        <Moon className="h-3 w-3" aria-hidden="true" />+1d
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-[10px] text-crewly-dim">
                    Grace <span className="font-bold text-crewly-text">{graceOf(s)} min</span>
                  </p>
                </div>

                <div className="mt-2 space-y-0.5">
                  <p className="text-[9px] font-bold uppercase tracking-[0.08em] text-crewly-dim">
                    Differential pay
                  </p>
                  <p className="text-[10px]">
                    {s.nightAllowance > 0
                      ? `Night ${money(s.nightAllowance)}/day`
                      : s.shiftAllowance > 0
                        ? `Shift ${money(s.shiftAllowance)}/day`
                        : 'Standard base'}
                    {s.overtimeEligible ? ` · OT ${money(s.overtimeRatePerHour)}/hr` : ''}
                  </p>
                </div>

                <div className="mt-2 flex items-center gap-1.5">
                  <span className="flex -space-x-1.5">
                    {crew.slice(0, 3).map((p) => (
                      <span
                        key={p.id || p.name}
                        className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-crewly-card bg-crewly-inset-strong text-[8px] font-bold"
                        title={p.name}
                      >
                        {initials(p.name)}
                      </span>
                    ))}
                    {crew.length > 3 ? (
                      <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-crewly-card bg-crewly-inset text-[8px] font-bold text-crewly-dim">
                        +{crew.length - 3}
                      </span>
                    ) : null}
                  </span>
                  <p className="text-[10px] text-crewly-dim">
                    <span className="font-bold text-crewly-text">{crew.length}</span> assigned
                  </p>
                </div>
              </div>

              <div className="mt-2 flex items-center gap-1.5 border-t border-crewly-border px-2.5 py-2">
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
                  className="btn-ghost inline-flex flex-1 items-center justify-center gap-1 px-2 py-1 text-[10px] font-bold"
                >
                  <UserPlus className="h-3 w-3" aria-hidden="true" /> Assign
                </button>
                <button
                  type="button"
                  onClick={() => openEdit(s)}
                  className="btn-ghost inline-flex items-center justify-center px-2 py-1 text-[10px] font-bold"
                  aria-label={`Configure ${s.name}`}
                >
                  <Pencil className="h-3 w-3" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => deactivate(s)}
                  className="btn-ghost inline-flex items-center justify-center px-2 py-1 text-[10px] font-bold text-crewly-red"
                  aria-label={`Deactivate ${s.name}`}
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            </section>
          );
        })}

        {!loading && !visibleTypes.length ? (
          <div className="sm:col-span-2 xl:col-span-4">
            <div className="card">
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
          </div>
        ) : null}
      </div>

      {/* ── specifications ────────────────────────────────────────────── */}
      {isHR ? (
        <section className="card overflow-hidden p-0">
          <div className="flex flex-wrap items-start justify-between gap-2 border-b border-crewly-border px-4 py-3">
            <div>
              <h2 className="card-title text-base font-bold">Shift specifications &amp; attendance rules</h2>
              <p className="text-[11px] text-crewly-dim">
                The grace, break deduction and differential each shift is measured against.
              </p>
            </div>
            <label className="relative block w-[220px]">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crewly-dim"
                aria-hidden="true"
              />
              <input
                className="input w-full py-1.5 pl-7 text-xs"
                placeholder="Filter by policy…"
                value={specQuery}
                onChange={(e) => setSpecQuery(e.target.value)}
                aria-label="Filter specifications"
              />
            </label>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-crewly-border bg-crewly-inset/40 text-[10px] uppercase tracking-[0.1em] text-crewly-dim">
                  <th className="px-4 py-2.5 font-semibold">Shift name</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Timing window</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Grace in / out</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Break deduction</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Allowance / diff.</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Staff count</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {specRows.map((s) => (
                  <tr key={s.id} className="border-b border-crewly-border/50 last:border-0">
                    <td className="px-4 py-2.5">
                      <p className="font-semibold">{s.name}</p>
                      <p className="text-[10px] text-crewly-dim">
                        {(s.departments || []).map((d) => d.name).join(', ') || `${metaOf(s.type).label} shift`}
                        {s.isActive ? '' : ' · inactive'}
                      </p>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[11px]">
                      {clock12(s.startTime)} – {clock12(s.endTime)}
                      <span className="block text-crewly-dim">{netHours(s).toFixed(1)}h incl. {s.breakMinutes}m</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[11px]">
                      {graceOf(s)} min / {earlyOf(s)} min
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[11px]">
                      {s.breakMinutes} min
                      <span className="block text-crewly-dim">auto-deducted</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      {s.nightAllowance > 0 ? (
                        <span className="badge bg-crewly-selected/60 text-crewly-text">
                          {money(s.nightAllowance)} night
                        </span>
                      ) : s.shiftAllowance > 0 ? (
                        <span className="badge bg-crewly-accent/15 text-crewly-orange">
                          {money(s.shiftAllowance)} shift
                        </span>
                      ) : (
                        <span className="badge bg-crewly-inset-strong text-crewly-dim">Regular</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[11px]">
                      <span className="font-bold">{(s.employees || []).length}</span>{' '}
                      <span className="text-crewly-dim">
                        {(s.employees || []).length === 1 ? 'employee' : 'employees'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => openEdit(s)}
                        className="text-[11px] font-bold text-crewly-green hover:underline"
                      >
                        Configure
                      </button>
                    </td>
                  </tr>
                ))}
                {!specRows.length ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-center text-[11px] text-crewly-dim">
                      No shift matches that filter.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-crewly-border bg-crewly-inset/40 px-4 py-2.5 text-[10px] text-crewly-dim">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-crewly-green" aria-hidden="true" />
              Showing {specRows.length} of {shifts.length} configured shifts
            </span>
            <span>Cross-midnight cutoff 00:00 auto-rollover · Timezone Asia/Kolkata</span>
          </div>
        </section>
      ) : null}

      {/* ── assignment history ────────────────────────────────────────── */}
      {isHR ? (
        <section id="assignment-history" className="card">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="card-title flex items-center gap-2 text-base font-bold">
                <ScrollText className="h-4 w-4 text-crewly-dim" aria-hidden="true" />
                Assignment history
              </h2>
              <p className="text-[11px] text-crewly-dim">
                Every window a person has been on, newest first. The previous assignment closes the
                day before the next one starts.
              </p>
            </div>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <label className="relative block min-w-[220px] flex-1 sm:max-w-sm">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crewly-dim"
                aria-hidden="true"
              />
              <input
                className="input w-full py-1.5 pl-7 text-xs"
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
                className="btn-ghost inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-bold"
              >
                <X className="h-3 w-3" aria-hidden="true" /> Clear
              </button>
            ) : null}
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {pickerMatches.map((u) => {
              const id = String(u._id || u.id);
              const on = historyFor === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => loadHistory(id)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
                    on
                      ? 'border-crewly-accent bg-crewly-selected/60 text-crewly-text'
                      : 'border-crewly-border text-crewly-dim hover:bg-crewly-inset hover:text-crewly-text'
                  }`}
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-crewly-inset-strong text-[8px] font-bold">
                    {initials(u.name)}
                  </span>
                  {u.name}
                </button>
              );
            })}
            {!pickerMatches.length ? (
              <p className="text-[11px] text-crewly-dim">
                {empList.length ? 'No person matches that search.' : 'No people could be read for this company.'}
              </p>
            ) : null}
          </div>

          <div className="mt-3 border-t border-crewly-border pt-2.5">
            {!historyFor ? (
              <p className="text-[11px] text-crewly-dim">Pick a person above to read their trail.</p>
            ) : !history.length ? (
              <p className="text-[11px] text-crewly-dim">No assignment history for this person yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-crewly-inset/50 px-2.5 py-1.5 text-[11px]">
                    {h.current ? (
                      <span className="inline-flex items-center gap-1 font-bold text-crewly-green">
                        <span className="h-1.5 w-1.5 rounded-full bg-crewly-green" aria-hidden="true" />
                        {h.shift?.name || '—'}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 font-semibold">
                        <Circle className="h-1.5 w-1.5" aria-hidden="true" />
                        {h.shift?.name || '—'}
                      </span>
                    )}
                    <span className="text-crewly-dim">
                      {h.effectiveFrom} → {h.effectiveTo || 'present'}
                    </span>
                    {h.prevShift ? <span className="text-crewly-dim">(was {h.prevShift})</span> : null}
                    {h.reason ? <span className="text-crewly-dim">· {h.reason}</span> : null}
                    {h.changedBy ? <span className="ml-auto text-crewly-dim">by {h.changedBy}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : null}

      {/* ── roster drawer ─────────────────────────────────────────────── */}
      {rosterFor ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onClick={() => setRosterFor(null)}>
          <div
            className="max-h-[88vh] w-full max-w-md overflow-hidden rounded-t-2xl border border-crewly-border bg-crewly-card sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2 border-b border-crewly-border px-4 py-3">
              <div>
                <h3 className="card-title text-base font-bold">
                  {shifts.find((s) => s.id === rosterFor)?.name} roster
                </h3>
                <p className="text-[11px] text-crewly-dim">{rosterCrew.length} assigned to this window.</p>
              </div>
              <button type="button" onClick={() => setRosterFor(null)} className="rounded-lg p-1 text-crewly-dim" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
            <ul className="max-h-[60vh] overflow-y-auto px-3 py-2">
              {rosterCrew.map((p) => (
                <li key={p.id || p.name} className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-xs hover:bg-crewly-inset/60">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-crewly-inset-strong text-[9px] font-bold">
                    {initials(p.name)}
                  </span>
                  <span className="min-w-0 truncate font-semibold">{p.name}</span>
                </li>
              ))}
              {!rosterCrew.length ? (
                <li className="px-2 py-4 text-center text-[11px] text-crewly-dim">
                  Nobody is assigned to this shift yet.
                </li>
              ) : null}
            </ul>
            <div className="border-t border-crewly-border px-4 py-2.5">
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
                className="btn-primary inline-flex w-full items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold"
              >
                <UserPlus className="h-4 w-4" aria-hidden="true" /> Assign people
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── create / edit ─────────────────────────────────────────────── */}
      {modal ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => setModal(null)}>
          <div
            className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-crewly-border bg-crewly-card sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-2 border-b border-crewly-border px-5 py-3.5">
              <div>
                <h3 className="card-title text-base font-bold">
                  {modal.mode === 'create' ? 'New shift' : `Edit ${modal.form.name}`}
                </h3>
                <p className="text-[11px] text-crewly-dim">
                  An end time earlier than the start means the shift crosses midnight.
                </p>
              </div>
              <button type="button" onClick={() => setModal(null)} className="rounded-lg p-1 text-crewly-dim" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs">
                  <span className="mb-1 block font-semibold text-crewly-dim">Name</span>
                  <input
                    className="input w-full"
                    value={modal.form.name}
                    onChange={(e) => setModal({ ...modal, form: { ...modal.form, name: e.target.value } })}
                    placeholder="Night shift"
                  />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block font-semibold text-crewly-dim">Type</span>
                  <select
                    className="input w-full"
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
                  ['lateGrace', 'Late grace (min)'],
                  ['earlyGrace', 'Early-out grace (min)'],
                  ['maxLatePerMonth', 'Max lates / month'],
                  ['overtimeRatePerHour', 'OT ₹ / hr'],
                  ['shiftAllowance', 'Shift allowance ₹ / day'],
                  ['nightAllowance', 'Night allowance ₹ / day'],
                ].map(([k, label]) => (
                  <label key={k} className="block text-xs">
                    <span className="mb-1 block font-semibold text-crewly-dim">{label}</span>
                    <input
                      type="number"
                      min="0"
                      className="input w-full"
                      value={modal.form[k]}
                      onChange={(e) => setModal({ ...modal, form: { ...modal.form, [k]: e.target.value } })}
                    />
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={modal.form.overtimeEligible}
                  onChange={(e) => setModal({ ...modal, form: { ...modal.form, overtimeEligible: e.target.checked } })}
                />
                Overtime eligible
              </label>
              <p className="rounded-lg bg-crewly-inset/60 px-2.5 py-2 text-[10px] leading-relaxed text-crewly-dim">
                This window covers {netHours(modal.form).toFixed(1)} hours after a{' '}
                {modal.form.breakMinutes || 0} minute break
                {crosses(modal.form) ? ', ending on the next calendar day' : ''}.
              </p>
            </div>

            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-crewly-border px-5 py-3 sm:flex-row sm:justify-end">
              <button type="button" className="btn-ghost px-4 py-2 text-xs font-bold" onClick={() => setModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary px-4 py-2 text-xs font-bold disabled:opacity-50"
                disabled={saving || !modal.form.name}
                onClick={save}
              >
                {saving ? 'Saving…' : 'Save shift'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── assign ────────────────────────────────────────────────────── */}
      {assignFor ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => setAssignFor(null)}>
          <div
            className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-crewly-border bg-crewly-card sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-2 border-b border-crewly-border px-5 py-3.5">
              <div>
                <h3 className="card-title text-base font-bold">Assign “{assignFor.name}”</h3>
                <p className="text-[11px] text-crewly-dim">
                  An employee assignment overrides the department default for that person.
                </p>
              </div>
              <button type="button" onClick={() => setAssignFor(null)} className="rounded-lg p-1 text-crewly-dim" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
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
                        ? 'bg-crewly-inset-strong text-crewly-text'
                        : 'border border-crewly-border text-crewly-dim'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {assignFor.mode === 'EMPLOYEE' ? (
                <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-crewly-border p-1.5">
                  {empList.map((u) => {
                    const id = String(u._id || u.id);
                    const on = assignFor.userIds.includes(id);
                    return (
                      <label
                        key={id}
                        className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${
                          on ? 'bg-crewly-selected/60 font-semibold text-crewly-text' : 'text-crewly-dim hover:bg-crewly-inset'
                        }`}
                      >
                        <input
                          type="checkbox"
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
                        <span className="shrink-0 text-[10px] text-crewly-dim">{u.email}</span>
                      </label>
                    );
                  })}
                  {!empList.length ? (
                    <p className="px-2 py-3 text-[11px] text-crewly-dim">No people could be read.</p>
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
                          on ? 'bg-crewly-accent/15 text-crewly-orange' : 'border border-crewly-border text-crewly-dim'
                        }`}
                      >
                        {d.name}
                      </button>
                    );
                  })}
                  {!departments.length ? (
                    <p className="text-[11px] text-crewly-dim">No departments found.</p>
                  ) : null}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs">
                  <span className="mb-1 block font-semibold text-crewly-dim">Effective from</span>
                  <input
                    type="date"
                    className="input w-full"
                    value={assignFor.effectiveFrom}
                    onChange={(e) => setAssignFor({ ...assignFor, effectiveFrom: e.target.value })}
                  />
                </label>
                <label className="block text-xs">
                  <span className="mb-1 block font-semibold text-crewly-dim">Reason</span>
                  <input
                    className="input w-full"
                    value={assignFor.reason}
                    onChange={(e) => setAssignFor({ ...assignFor, reason: e.target.value })}
                    placeholder="Project requirement"
                  />
                </label>
              </div>
              <p className="text-[10px] leading-relaxed text-crewly-dim">
                History is preserved — the previous assignment closes the day before this one
                starts.
              </p>
            </div>

            <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-crewly-border px-5 py-3 sm:flex-row sm:justify-end">
              <button type="button" className="btn-ghost px-4 py-2 text-xs font-bold" onClick={() => setAssignFor(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold disabled:opacity-50"
                disabled={
                  saving ||
                  (assignFor.mode === 'EMPLOYEE' ? !assignFor.userIds.length : !assignFor.departmentId)
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
                {saving ? 'Assigning…' : (
                  <>
                    <Check className="h-3.5 w-3.5" aria-hidden="true" /> Assign
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
