import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Gift,
  HeartPulse,
  Info,
  MoreVertical,
  ShieldCheck,
  Sun,
  Umbrella,
  X,
  Zap,
} from 'lucide-react';
import leaveService from '../../services/leaveService.js';
import scheduleService from '../../services/scheduleService.js';
import { TableEmpty, default as EmptyState } from '../../components/common/EmptyState.jsx';
import { notify } from '../../utils/notify.js';

/* One colour role per bucket, so a type reads the same in the card, the pace
   legend and the trail row. */
const TYPE = {
  CASUAL: {
    label: 'Casual Leave',
    tag: 'GENERAL',
    blurb: 'Unplanned & single-day personal time',
    Icon: Sun,
    tile: 'bg-st-secondary-container text-st-secondary',
    tagChip: 'bg-st-secondary-container/70 text-st-on-secondary-container',
    dot: 'bg-st-secondary',
    bar: 'bg-st-secondary',
  },
  SICK: {
    label: 'Sick Leave',
    tag: 'HEALTH',
    blurb: 'Medical recovery and appointments',
    Icon: HeartPulse,
    tile: 'bg-st-primary-fixed text-st-primary',
    tagChip: 'bg-st-primary-fixed/60 text-st-on-primary-fixed-variant',
    dot: 'bg-st-primary',
    bar: 'bg-st-primary-container',
  },
  EARNED: {
    label: 'Earned / Privilege',
    tag: 'ANNUAL',
    blurb: 'Accrued statutory annual vacation',
    Icon: Umbrella,
    tile: 'bg-st-tertiary-fixed/70 text-st-tertiary',
    tagChip: 'bg-st-tertiary-fixed/70 text-st-on-tertiary-fixed',
    dot: 'bg-st-tertiary',
    bar: 'bg-st-tertiary-container',
  },
  COMP_OFF: {
    label: 'Comp-Off Balance',
    tag: 'FLOATING',
    blurb: 'Earned during weekend releases',
    Icon: Gift,
    tile: 'bg-st-high text-st-secondary',
    tagChip: 'bg-st-high text-st-on',
    dot: 'bg-st-outline',
    bar: 'bg-st-secondary-fixed-dim',
  },
};
const metaOf = (type) =>
  TYPE[type] || {
    label: type,
    tag: type,
    blurb: 'Balance for this bucket',
    Icon: CalendarDays,
    tile: 'bg-st-high text-st-on',
    tagChip: 'bg-st-high text-st-on',
    dot: 'bg-st-outline',
    bar: 'bg-st-outline',
  };

const STATUS = {
  PENDING: { label: 'Pending', chip: 'bg-st-primary-fixed text-st-on-primary-fixed-variant' },
  APPROVED: { label: 'Approved', chip: 'bg-st-secondary-container text-st-on-secondary-container' },
  REJECTED: { label: 'Declined', chip: 'bg-st-error-container text-st-on-error-container' },
  CANCELLED: { label: 'Cancelled', chip: 'bg-st-high text-st-on-variant' },
};
const statusOf = (s) => STATUS[s] || { label: s, chip: 'bg-st-high text-st-on-variant' };

const DAY_MS = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const fmt = (value) => {
  if (!value) return '—';
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? String(value)
    : d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
};
const weekday = (value) =>
  new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString([], { weekday: 'long' });
const dayNo = (value) => String(value).slice(8, 10);
const initials = (name = '') =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';

const PAGE_SIZE = 5;

/* Working days between two ISO dates, weekends off — the same rule the API
   applies before it accepts a request. */
const workingDays = (start, end) => {
  if (!start || !end) return 0;
  let count = 0;
  for (
    let t = new Date(`${start}T00:00:00Z`).getTime();
    t <= new Date(`${end}T00:00:00Z`).getTime();
    t += DAY_MS
  ) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
};

const emptyForm = { type: 'CASUAL', startDate: '', endDate: '', reason: '' };

export default function LeavesPage() {
  const [data, setData] = useState({ leaves: [], balance: [], year: '' });
  const [holidays, setHolidays] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState('ALL');
  const [menuFor, setMenuFor] = useState('');

  const load = () =>
    leaveService
      .my()
      .then((d) => setData({ leaves: d.leaves || [], balance: d.balance || [], year: d.year || '' }))
      .catch(() => {});

  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => {
      if (alive) load();
    });
    scheduleService
      .upcoming(180)
      .then((d) => {
        if (alive) setHolidays(d.holidays || []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const year = data.year || String(new Date().getFullYear());
  const balance = useMemo(() => data.balance || [], [data.balance]);

  /* Comp-off carries no yearly quota — it only appears once a day has been
     earned or spent, never as a permanent 0/0 card. */
  const cards = useMemo(
    () =>
      balance.filter(
        (b) => b.type !== 'COMP_OFF' || (b.total || 0) > 0 || (b.used || 0) > 0 || (b.pending || 0) > 0,
      ),
    [balance],
  );

  const totals = useMemo(
    () =>
      balance.reduce(
        (acc, b) => ({
          allocated: acc.allocated + (b.total || 0),
          used: acc.used + (b.used || 0),
          pending: acc.pending + (b.pending || 0),
          available: acc.available + (b.available || 0),
        }),
        { allocated: 0, used: 0, pending: 0, available: 0 },
      ),
    [balance],
  );

  const consumedPct = totals.allocated
    ? Math.min(100, Math.round(((totals.used + totals.pending) / totals.allocated) * 100))
    : 0;
  const preservedPct = 100 - consumedPct;

  const nextHoliday = useMemo(() => {
    const today = iso(new Date());
    return (
      [...holidays]
        .filter((h) => String(h.date).slice(0, 10) >= today)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] || null
    );
  }, [holidays]);

  const daysToHoliday = nextHoliday
    ? Math.max(
        0,
        Math.round(
          (new Date(`${String(nextHoliday.date).slice(0, 10)}T00:00:00Z`) -
            new Date(`${iso(new Date())}T00:00:00Z`)) /
            DAY_MS,
        ),
      )
    : null;

  const trail = useMemo(() => {
    const rows = [...(data.leaves || [])].sort((a, b) =>
      String(b.createdAt || b.startDate).localeCompare(String(a.createdAt || a.startDate)),
    );
    return tab === 'PENDING' ? rows.filter((l) => l.status === 'PENDING') : rows;
  }, [data.leaves, tab]);

  const pendingCount = (data.leaves || []).filter((l) => l.status === 'PENDING').length;
  const pages = Math.max(1, Math.ceil(trail.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const rows = trail.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const draftDays = workingDays(form.startDate, form.endDate);
  const draftType = metaOf(form.type);
  const draftAvailable = balance.find((b) => b.type === form.type)?.available ?? 0;

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await leaveService.apply(form);
      notify.successFrom(r, 'Leave request submitted.');
      setForm(emptyForm);
      load();
    } catch (err) {
      notify.error(err);
    } finally {
      setSaving(false);
    }
  };

  const cancel = async (leave) => {
    if (!window.confirm('Cancel this leave request?')) return;
    try {
      await leaveService.cancel(leave._id);
      notify.success('Leave request cancelled.');
      setMenuFor('');
      load();
    } catch (err) {
      notify.error(err);
    }
  };

  /* The footnote each card can actually stand behind. */
  const footnote = (b) => {
    if (b.type === 'COMP_OFF')
      return { text: 'Earned, no yearly quota — days stay until used', Icon: Clock3 };
    if (b.type === 'SICK') return { text: 'Certificate rules are set by HR', Icon: ShieldCheck };
    if (b.type === 'EARNED') return { text: 'Yearly quota — carry-forward not configured', Icon: Info };
    return { text: `Renews 1 Jan ${Number(year) + 1}`, Icon: CalendarDays };
  };

  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-6">
        {/* ── header ────────────────────────────────────────────────────── */}
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
          <div className="space-y-1.5">
            <div className="inline-flex items-center gap-2 rounded-full bg-st-secondary-container/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-st-on-secondary-container">
              <span className="h-1.5 w-1.5 rounded-full bg-st-secondary" />
              Balance year {year}
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-st-on lg:text-4xl">
              My leaves &amp; time off
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-st-on-variant">
              Personal leave balances, the application drawer, upcoming absences and the audit trail
              behind each decision.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <a
              href="/app/holidays"
              className="inline-flex items-center gap-2 rounded-xl bg-st-lowest px-4 py-2.5 text-sm font-semibold text-st-on shadow-sm transition hover:bg-st-low"
            >
              <CalendarDays className="h-[18px] w-[18px] text-st-secondary" aria-hidden="true" />
              Holiday calendar
            </a>
            <a
              href="#quick-apply"
              className="inline-flex items-center gap-2 rounded-xl bg-st-primary-container px-5 py-2.5 text-sm font-bold text-st-on-primary-container shadow-sm transition hover:opacity-95"
            >
              <span className="text-lg leading-none">+</span> Apply leave
            </a>
          </div>
        </div>

        {/* ── balance cards ─────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map((b) => {
            const meta = metaOf(b.type);
            const total = b.total || 0;
            const available = Math.max(0, b.available || 0);
            const share = total ? Math.min(100, (available / total) * 100) : 0;
            const foot = footnote(b);
            return (
              <div
                key={b.type}
                className="relative flex flex-col justify-between overflow-hidden rounded-xl bg-st-lowest p-5 shadow-sm"
              >
                <div
                  className={`pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full opacity-60 ${meta.tile}`}
                />
                <div className="relative">
                  <div className="flex items-start justify-between">
                    <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${meta.tile}`}>
                      <meta.Icon className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${meta.tagChip}`}
                    >
                      {meta.tag}
                    </span>
                  </div>
                  <h2 className="mt-4 text-base font-bold text-st-on">{meta.label}</h2>
                  <p className="text-[11px] leading-snug text-st-on-variant">{meta.blurb}</p>
                  <div className="mt-4 flex items-baseline gap-1.5">
                    <span className="text-3xl font-bold tracking-tight text-st-on">{available}</span>
                    <span className="text-sm font-medium text-st-on-variant">/{total} left</span>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-st-high">
                    <div className={`h-full rounded-full ${meta.bar}`} style={{ width: `${share}%` }} />
                  </div>
                  <p className="mt-2 text-[11px] font-medium text-st-on-variant">
                    Used: <span className="font-bold text-st-on">{b.used || 0}</span> · Pending:{' '}
                    <span className="font-bold text-st-on">{b.pending || 0}</span> · Allocated:{' '}
                    <span className="font-bold text-st-on">{total}</span>
                  </p>
                </div>
                <div className="relative mt-4 flex items-center gap-1.5 border-t border-st-high pt-2.5 text-[10px] text-st-on-variant">
                  <foot.Icon className="h-3 w-3 shrink-0 text-st-outline" aria-hidden="true" />
                  <span className="truncate">{foot.text}</span>
                </div>
              </div>
            );
          })}

          {!cards.length ? (
            <div className="sm:col-span-2 xl:col-span-4">
              <EmptyState
                illustration="calendar"
                title="No balances to show"
                description="Balances appear once the company publishes a leave policy and your account is on it."
                size="sm"
              />
            </div>
          ) : null}
        </div>

        {/* ── pace + quick apply ────────────────────────────────────────── */}
        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-12">
          <div className="flex flex-col justify-between rounded-xl bg-st-low p-6 xl:col-span-5">
            <div>
              <div className="flex items-start justify-between gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-st-on-variant">
                  Leave consumption pace
                </span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                    consumedPct <= 50
                      ? 'bg-st-secondary-container text-st-on-secondary-container'
                      : consumedPct <= 80
                        ? 'bg-st-primary-fixed text-st-on-primary-fixed-variant'
                        : 'bg-st-error-container text-st-on-error-container'
                  }`}
                >
                  {totals.allocated === 0
                    ? 'No quota'
                    : consumedPct <= 50
                      ? 'Healthy'
                      : consumedPct <= 80
                        ? 'Watch'
                        : 'Tight'}
                </span>
              </div>

              <h2 className="mt-2 text-2xl font-bold tracking-tight text-st-on">
                {totals.allocated} Days Total
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-st-on-variant">
                {totals.allocated
                  ? `${preservedPct}% of the year's quota is untouched — ${totals.available} days available across ${cards.length} ${cards.length === 1 ? 'bucket' : 'buckets'}.`
                  : 'No quota is configured for this year yet.'}
              </p>

              <div className="mt-5 flex items-center gap-5">
                <div className="relative h-24 w-24 shrink-0">
                  <svg viewBox="0 0 100 100" className="h-24 w-24 -rotate-90" role="img" aria-label={`${consumedPct}% consumed`}>
                    <circle cx="50" cy="50" r="42" fill="none" strokeWidth="12" className="stroke-st-high" />
                    <circle
                      cx="50"
                      cy="50"
                      r="42"
                      fill="none"
                      strokeWidth="12"
                      strokeLinecap="round"
                      className="stroke-st-secondary"
                      strokeDasharray={`${(consumedPct / 100) * 264} 264`}
                    />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-lg font-bold text-st-on">{consumedPct}%</span>
                    <span className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                      consumed
                    </span>
                  </div>
                </div>
                <ul className="min-w-0 flex-1 space-y-1.5 text-[11px]">
                  <li className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-st-on-variant">
                      <span className="h-2 w-2 rounded-full bg-st-secondary" /> Available
                    </span>
                    <span className="font-bold text-st-on">{totals.available} Days</span>
                  </li>
                  <li className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-st-on-variant">
                      <span className="h-2 w-2 rounded-full bg-st-primary-container" /> Utilised
                    </span>
                    <span className="font-bold text-st-on">{totals.used} Days</span>
                  </li>
                  <li className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-st-on-variant">
                      <span className="h-2 w-2 rounded-full bg-st-tertiary-container" /> Awaiting
                      decision
                    </span>
                    <span className="font-bold text-st-on">{totals.pending} Days</span>
                  </li>
                </ul>
              </div>

              <div className="mt-5 space-y-1.5 rounded-lg bg-st-lowest/70 p-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-st-outline">
                  Where the days went
                </p>
                {cards.map((b) => {
                  const meta = metaOf(b.type);
                  const spent = (b.used || 0) + (b.pending || 0);
                  const share = b.total ? Math.min(100, (spent / b.total) * 100) : 0;
                  return (
                    <div key={b.type} className="flex items-center gap-2 text-[10px]">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
                      <span className="w-16 shrink-0 truncate text-st-on-variant">{meta.tag}</span>
                      <span className="h-1 flex-1 overflow-hidden rounded-full bg-st-high">
                        <span className={`block h-full rounded-full ${meta.bar}`} style={{ width: `${share}%` }} />
                      </span>
                      <span className="w-10 shrink-0 text-right font-bold text-st-on">{spent}d</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between gap-2 border-t border-st-high pt-3">
              <div className="text-[11px]">
                <p className="font-semibold text-st-on">Next public holiday</p>
                <p className="text-st-on-variant">
                  {nextHoliday
                    ? `in ${daysToHoliday} ${daysToHoliday === 1 ? 'day' : 'days'}`
                    : 'Nothing scheduled ahead'}
                </p>
              </div>
              {nextHoliday ? (
                <a
                  href="/app/holidays"
                  className="flex items-center gap-2 rounded-lg bg-st-lowest px-2.5 py-1.5 text-[11px] font-semibold text-st-on shadow-sm transition hover:bg-st-container"
                >
                  <span className="text-right leading-tight">
                    <span className="block text-[9px] uppercase text-st-on-variant">
                      {new Date(`${String(nextHoliday.date).slice(0, 10)}T00:00:00`).toLocaleDateString([], {
                        month: 'short',
                      })}{' '}
                      {dayNo(nextHoliday.date)}
                    </span>
                    <span className="block max-w-[92px] truncate">{nextHoliday.name}</span>
                  </span>
                  <ArrowUpRight className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" />
                </a>
              ) : null}
            </div>
          </div>

          <form
            id="quick-apply"
            onSubmit={submit}
            className="rounded-xl bg-st-lowest p-6 shadow-sm xl:col-span-7"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-st-primary-fixed text-st-primary">
                  <Zap className="h-4 w-4" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="text-base font-bold text-st-on">Start a request</h2>
                  <p className="text-[11px] text-st-on-variant">
                    Routed to your reporting manager — HR if none is set.
                  </p>
                </div>
              </div>
              <span className="rounded-full bg-st-low px-2.5 py-1 text-[10px] font-semibold text-st-on-variant">
                Draft
              </span>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
                  Leave category
                </span>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  className="w-full appearance-none rounded-lg bg-st-low px-3 py-2.5 text-xs font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/50"
                >
                  {cards.map((b) => (
                    <option key={b.type} value={b.type}>
                      {metaOf(b.type).label} ({b.available} left)
                    </option>
                  ))}
                </select>
              </label>

              <div className="block">
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
                  Absence scope
                </span>
                <div className="flex overflow-hidden rounded-lg bg-st-low p-0.5">
                  <span
                    title="A single whole-day request"
                    className="flex-1 rounded-md bg-st-lowest px-1 py-1.5 text-center text-[10px] font-semibold text-st-on shadow-sm"
                  >
                    Full day
                  </span>
                  {/* The register has no half-day column — the chips are drawn
                      (the form asks for them) but cannot be sent anywhere. */}
                  <button
                    type="button"
                    aria-disabled="true"
                    title="The register stores whole days only — half days are not accepted by the API yet."
                    className="flex-1 cursor-not-allowed rounded-md px-1 py-1.5 text-[10px] font-semibold text-st-on-variant/60"
                  >
                    First half
                  </button>
                  <button
                    type="button"
                    aria-disabled="true"
                    title="The register stores whole days only — half days are not accepted by the API yet."
                    className="flex-1 cursor-not-allowed rounded-md px-1 py-1.5 text-[10px] font-semibold text-st-on-variant/60"
                  >
                    Second half
                  </button>
                </div>
              </div>

              <label className="block">
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
                  Target date
                </span>
                <input
                  type="date"
                  required
                  value={form.startDate}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      startDate: e.target.value,
                      endDate: form.endDate && form.endDate >= e.target.value ? form.endDate : e.target.value,
                    })
                  }
                  className="w-full rounded-lg bg-st-low px-3 py-2.5 text-xs font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/50"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
                  Until
                </span>
                <input
                  type="date"
                  required
                  value={form.endDate}
                  min={form.startDate || undefined}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                  className="w-full rounded-lg bg-st-low px-3 py-2.5 text-xs font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/50"
                />
              </label>
            </div>

            <label className="mt-3 block">
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
                Reason note
              </span>
              <input
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="e.g. Doctor appointment, routine home maintenance"
                className="w-full rounded-lg bg-st-low px-3 py-2.5 text-xs text-st-on placeholder:text-st-on-variant/50 focus:outline-none focus:ring-2 focus:ring-st-primary-container/50"
              />
            </label>

            <p className="mt-2 text-[10px] leading-relaxed text-st-on-variant">
              Requests are counted in whole working days (Sat/Sun are off). Half days are shown
              because the drawn form has them, but the register has no half-day field — the chips are
              inert rather than silently rounding your request.
            </p>

            <div className="mt-4 flex flex-col justify-between gap-3 border-t border-st-high pt-3 sm:flex-row sm:items-center">
              <div className="flex items-center gap-1.5 text-[11px] text-st-on-variant">
                <ShieldCheck className="h-3.5 w-3.5 text-st-secondary" aria-hidden="true" />
                Automatic quota deduction upon approval
                {draftDays ? (
                  <span className="ml-1 font-semibold text-st-on">
                    · {draftDays} working {draftDays === 1 ? 'day' : 'days'} from {draftType.label} (
                    {draftAvailable} left)
                  </span>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => setForm(emptyForm)}
                  className="rounded-lg bg-st-low px-4 py-2 text-xs font-semibold text-st-on-variant transition hover:bg-st-container hover:text-st-on"
                >
                  Clear
                </button>
                <button
                  type="submit"
                  disabled={saving || !form.startDate || !form.endDate || !draftDays}
                  className="rounded-lg bg-st-primary-container px-5 py-2 text-xs font-bold text-st-on-primary-container shadow-sm transition hover:opacity-95 disabled:opacity-50"
                >
                  {saving ? 'Submitting…' : 'Submit application'}
                </button>
              </div>
            </div>
          </form>
        </div>

        {/* ── trail ─────────────────────────────────────────────────────── */}
        <section className="rounded-xl bg-st-lowest p-6 shadow-sm">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-st-on">Time off trail</h2>
              <span className="rounded-full bg-st-low px-2 py-0.5 text-[10px] font-bold text-st-on-variant">
                {(data.leaves || []).length} Recorded
              </span>
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-st-low p-1">
              {[
                ['ALL', 'Upcoming & Past Leaves'],
                ['PENDING', `Pending Requests (${pendingCount})`],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setTab(key);
                    setPage(1);
                  }}
                  className={`rounded-md px-3 py-1.5 text-[11px] transition ${
                    tab === key
                      ? 'bg-st-lowest font-bold text-st-on shadow-sm'
                      : 'font-medium text-st-on-variant hover:text-st-on'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse text-left">
              <thead>
                <tr className="bg-st-low text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
                  <th className="rounded-l-lg px-3 py-3">Absence window</th>
                  <th className="px-3 py-3">Leave type</th>
                  <th className="px-3 py-3">Duration</th>
                  <th className="px-3 py-3">Reason / notes</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">Approved by</th>
                  <th className="w-10 rounded-r-lg px-3 py-3" />
                </tr>
              </thead>
              <tbody className="text-xs">
                {rows.map((l) => {
                  const meta = metaOf(l.type);
                  const st = statusOf(l.status);
                  const approver = l.approver?.name || '';
                  const ended = String(l.endDate).slice(0, 10) < iso(new Date());
                  return (
                    <tr
                      key={l._id}
                      className="border-b border-st-high/70 transition last:border-0 hover:bg-st-low/50"
                    >
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-lg bg-st-secondary-container/60 leading-none">
                            <span className="text-[13px] font-bold text-st-on-secondary-container">
                              {dayNo(l.startDate)}
                            </span>
                            <span className="text-[8px] font-bold uppercase text-st-on-secondary-container/80">
                              {new Date(`${String(l.startDate).slice(0, 10)}T00:00:00`).toLocaleDateString([], {
                                month: 'short',
                              })}
                            </span>
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold text-st-on">
                              {String(l.startDate).slice(0, 10) === String(l.endDate).slice(0, 10)
                                ? fmt(l.startDate)
                                : `${fmt(l.startDate)} – ${fmt(l.endDate)}`}
                            </p>
                            <p className="text-[10px] text-st-on-variant">
                              {String(l.startDate).slice(0, 10) === String(l.endDate).slice(0, 10)
                                ? weekday(l.startDate)
                                : `${weekday(l.startDate).slice(0, 3)} – ${weekday(l.endDate).slice(0, 3)}`}
                              {ended ? ' · ended' : ''}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">
                        <span className="flex items-center gap-1.5 font-medium text-st-on">
                          <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                          {meta.label}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-st-on-variant">
                        {Number(l.days || 0).toFixed(1)}{' '}
                        {Number(l.days) === 1 ? 'Day' : 'Days'} (Full)
                      </td>
                      <td className="max-w-[220px] px-3 py-3 text-st-on-variant">
                        <span className="line-clamp-2">{l.reason || '—'}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${st.chip}`}
                        >
                          {l.status === 'APPROVED' ? <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> : null}
                          {st.label}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3">
                        {approver ? (
                          <span className="flex items-center gap-1.5">
                            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-st-secondary text-[9px] font-bold text-st-on-secondary">
                              {initials(approver)}
                            </span>
                            <span className="text-[11px] font-medium text-st-on">{approver}</span>
                          </span>
                        ) : (
                          <span className="text-[11px] text-st-on-variant">
                            {l.status === 'PENDING' ? 'Awaiting decision' : '—'}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {l.status === 'PENDING' ? (
                          <div className="relative">
                            <button
                              type="button"
                              onClick={() => setMenuFor(menuFor === l._id ? '' : l._id)}
                              className="rounded p-1 text-st-on-variant hover:bg-st-container hover:text-st-on"
                              aria-label="Request actions"
                            >
                              <MoreVertical className="h-4 w-4" />
                            </button>
                            {menuFor === l._id ? (
                              <div className="absolute right-0 top-7 z-10 w-40 overflow-hidden rounded-lg border border-st-high bg-st-lowest shadow-lg">
                                <button
                                  type="button"
                                  onClick={() => cancel(l)}
                                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] font-semibold text-st-error hover:bg-st-error-container/60"
                                >
                                  <X className="h-3.5 w-3.5" aria-hidden="true" /> Cancel request
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-[11px] text-st-on-variant/40">⋮</span>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {!rows.length ? (
                  <TableEmpty
                    colSpan={7}
                    illustration="calendar"
                    title={tab === 'PENDING' ? 'Nothing is waiting on an approver' : 'No requests on record yet'}
                    description="Filing one above puts it in this trail with the decision attached."
                  />
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-col items-center justify-between gap-2 border-t border-st-high pt-3 sm:flex-row">
            <p className="text-[11px] text-st-on-variant">
              Showing {rows.length} of {trail.length} records for {year}
              <span className="sr-only">Page {current} of {pages}</span>
            </p>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage(Math.max(1, current - 1))}
                disabled={current <= 1}
                className="flex items-center gap-1 rounded-lg bg-st-low px-2.5 py-1.5 text-[11px] font-semibold text-st-on-variant transition hover:bg-st-container hover:text-st-on disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> Previous
              </button>
              <span className="rounded-md bg-st-lowest px-2 py-1 text-[11px] font-bold text-st-on ring-1 ring-st-high">
                {current}
              </span>
              <button
                type="button"
                onClick={() => setPage(Math.min(pages, current + 1))}
                disabled={current >= pages}
                className="flex items-center gap-1 rounded-lg bg-st-low px-2.5 py-1.5 text-[11px] font-semibold text-st-on-variant transition hover:bg-st-container hover:text-st-on disabled:opacity-40"
              >
                Next <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
