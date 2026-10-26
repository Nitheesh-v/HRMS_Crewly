import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarCheck,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  Gift,
  HeartPulse,
  Info,
  Palmtree,
  Sparkles,
  Sun,
  Umbrella,
  X,
} from 'lucide-react';
import leaveService from '../../services/leaveService.js';
import scheduleService from '../../services/scheduleService.js';
import Modal from '../../components/Modal.jsx';
import { notify } from '../../utils/notify.js';
import { TableEmpty } from '../../components/common/EmptyState.jsx';

const STATUS_STYLE = {
  PENDING: 'bg-crewly-orange/15 text-crewly-orange',
  APPROVED: 'bg-crewly-green/15 text-crewly-green',
  REJECTED: 'bg-crewly-red/15 text-crewly-red',
  CANCELLED: 'bg-crewly-inset-strong text-crewly-dim',
};

/* One colour role per leave type, so the same type reads the same everywhere. */
const TYPE = {
  CASUAL: { label: 'Casual', chip: 'bg-crewly-orange/15 text-crewly-orange', bar: 'bg-crewly-orange', Icon: Sun },
  SICK: { label: 'Sick', chip: 'bg-crewly-red/15 text-crewly-red', bar: 'bg-crewly-red', Icon: HeartPulse },
  EARNED: { label: 'Earned', chip: 'bg-crewly-green/15 text-crewly-green', bar: 'bg-crewly-green', Icon: Umbrella },
  COMP_OFF: { label: 'Comp-off', chip: 'bg-crewly-selected/60 text-crewly-text', bar: 'bg-crewly-accent', Icon: Gift },
};

const TYPE_OF = (t) => TYPE[t] || { label: t, chip: 'bg-crewly-inset-strong text-crewly-dim', bar: 'bg-crewly-dim', Icon: CalendarDays };

const DAY_MS = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const fmt = (value) => {
  if (!value) return '—';
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? String(value)
    : d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
};
const chip = (value) => {
  if (!value) return '—';
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? String(value)
    : d.toLocaleDateString([], { day: '2-digit', month: 'short' });
};

const PAGE_SIZE = 5;

const LeavesPage = () => {
  const [data, setData] = useState({ leaves: [], balance: [], year: '' });
  const [holidays, setHolidays] = useState([]);
  const [showApply, setShowApply] = useState(false);
  const [form, setForm] = useState({ type: 'CASUAL', startDate: '', endDate: '', reason: '' });
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('ALL');

  const load = () => leaveService.my().then(setData).catch((e) => notify.error(e));

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

  const availableOf = (type) => data.balance.find((b) => b.type === type)?.available ?? 0;

  /* Phase 31.8 — comp-off has no yearly quota: it appears only once earned
     days exist (or are in use), never as a permanent 0/0 card. */
  const visibleBalance = (data.balance || []).filter(
    (b) => b.type !== 'COMP_OFF' || (b.total || 0) > 0 || (b.used || 0) > 0 || (b.pending || 0) > 0,
  );

  const totals = useMemo(
    () =>
      (data.balance || []).reduce(
        (acc, b) => ({
          allocated: acc.allocated + (b.total || 0),
          used: acc.used + (b.used || 0),
          pending: acc.pending + (b.pending || 0),
          available: acc.available + (b.available || 0),
        }),
        { allocated: 0, used: 0, pending: 0, available: 0 },
      ),
    [data.balance],
  );

  const consumedPct = totals.allocated
    ? Math.min(100, Math.round(((totals.used + totals.pending) / totals.allocated) * 100))
    : 0;

  const nextHoliday = useMemo(() => {
    const today = iso(new Date());
    return (
      [...holidays]
        .filter((h) => String(h.date).slice(0, 10) >= today)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] || null
    );
  }, [holidays]);

  const trail = useMemo(() => {
    const rows = [...(data.leaves || [])].sort(
      (a, b) => String(b.createdAt || b.startDate).localeCompare(String(a.createdAt || a.startDate)),
    );
    return filter === 'ALL' ? rows : rows.filter((l) => l.status === filter);
  }, [data.leaves, filter]);

  const pages = Math.max(1, Math.ceil(trail.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const rows = trail.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const workingDays = (start, end) => {
    if (!start || !end) return 0;
    let count = 0;
    for (let t = new Date(`${start}T00:00:00Z`).getTime(); t <= new Date(`${end}T00:00:00Z`).getTime(); t += DAY_MS) {
      const day = new Date(t).getUTCDay();
      if (day !== 0 && day !== 6) count += 1;
    }
    return count;
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await leaveService.apply(form);
      notify.success('Leave request submitted.');
      setShowApply(false);
      setForm({ type: 'CASUAL', startDate: '', endDate: '', reason: '' });
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
      load();
    } catch (err) {
      notify.error(err);
    }
  };

  const draftDays = workingDays(form.startDate, form.endDate);
  const draftBalance = availableOf(form.type);

  return (
    <div className="space-y-5">
      {/* ── title ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-crewly-dim">
            Time off
            <span className="mx-2 text-crewly-border">•</span>
            Balance year {data.year || new Date().getFullYear()}
          </p>
          <h1 className="mt-1 text-2xl font-bold sm:text-[28px]">My leaves &amp; time off</h1>
          <p className="mt-1 max-w-2xl text-sm text-crewly-dim">
            What is left in each bucket, what is waiting on an approver, and every request you have
            filed — with the decision attached.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href="/app/holidays"
            className="btn-ghost inline-flex items-center gap-2 whitespace-nowrap px-3 py-2 text-xs font-bold"
          >
            <CalendarCheck className="h-4 w-4" aria-hidden="true" /> Holiday calendar
          </a>
          <button
            type="button"
            onClick={() => setShowApply(true)}
            className="btn-primary inline-flex items-center gap-2 whitespace-nowrap px-3.5 py-2 text-xs font-bold"
          >
            <Palmtree className="h-4 w-4" aria-hidden="true" /> Apply for leave
          </button>
        </div>
      </div>

      {/* ── the four buckets ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {visibleBalance.map((b) => {
          const meta = TYPE_OF(b.type);
          const total = b.total || 0;
          const used = b.used || 0;
          const pending = b.pending || 0;
          const available = b.available ?? Math.max(0, total - used - pending);
          const pct = total ? Math.min(100, (available / total) * 100) : 0;
          return (
            <section key={b.type} className="card relative overflow-hidden p-4">
              <meta.Icon
                className="pointer-events-none absolute -right-3 -top-2 h-20 w-20 text-crewly-inset-strong/70"
                aria-hidden="true"
              />
              <div className="relative flex items-start justify-between gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${meta.chip}`}>
                  {meta.label}
                </span>
                <CircleDot className="mt-0.5 h-3 w-3 text-crewly-dim" aria-hidden="true" />
              </div>
              <p className="relative mt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-crewly-dim">
                {b.label}
              </p>
              <p className="relative mt-0.5 flex items-baseline gap-1.5">
                <span className="text-[26px] font-bold leading-none">{available}</span>
                <span className="text-sm text-crewly-dim">/ {total} left</span>
              </p>
              <span className="relative mt-2.5 block h-1.5 overflow-hidden rounded-full bg-crewly-inset-strong">
                <span className={`block h-full rounded-full ${meta.bar}`} style={{ width: `${pct}%` }} />
              </span>
              <div className="relative mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-crewly-dim">
                <span>
                  Used <span className="font-bold text-crewly-text">{used}</span>
                </span>
                <span>
                  Pending <span className="font-bold text-crewly-text">{pending}</span>
                </span>
                <span>
                  Allocated <span className="font-bold text-crewly-text">{total}</span>
                </span>
              </div>
              <p className="relative mt-1.5 text-[10px] leading-tight text-crewly-dim">
                {b.type === 'COMP_OFF'
                  ? 'Credited for extra days worked — no yearly quota.'
                  : `Yearly allocation of ${total} ${total === 1 ? 'day' : 'days'}.`}
              </p>
            </section>
          );
        })}
        {!visibleBalance.length ? (
          <div className="card p-4 text-sm text-crewly-dim sm:col-span-2 xl:col-span-4">
            No leave buckets could be read for this year.
          </div>
        ) : null}
      </div>

      {/* ── pace and the draft ────────────────────────────────────────── */}
      <div className="grid items-stretch gap-4 xl:grid-cols-2">
        <section className="card">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
                Annual allowance
              </p>
              <h2 className="card-title text-base font-bold">Leave consumption pace</h2>
            </div>
            <span className="rounded-full bg-crewly-inset-strong px-2 py-0.5 text-[10px] font-bold text-crewly-dim">
              {data.year || new Date().getFullYear()}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4">
            <div className="relative h-[92px] w-[92px] shrink-0">
              <svg viewBox="0 0 40 40" className="h-full w-full -rotate-90">
                <circle cx="20" cy="20" r="16" fill="none" strokeWidth="4" className="stroke-crewly-inset-strong" />
                <circle
                  cx="20"
                  cy="20"
                  r="16"
                  fill="none"
                  strokeWidth="4"
                  strokeLinecap="round"
                  className="stroke-crewly-green"
                  strokeDasharray={`${(consumedPct / 100) * 100.5} 200`}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-lg font-bold leading-none">{consumedPct}%</span>
                <span className="text-[9px] uppercase tracking-wide text-crewly-dim">used</span>
              </div>
            </div>
            <div className="min-w-0">
              <p className="flex items-baseline gap-1.5">
                <span className="text-2xl font-bold">{totals.allocated}</span>
                <span className="text-sm text-crewly-dim">days allocated</span>
              </p>
              <ul className="mt-1.5 space-y-1 text-[11px]">
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-crewly-green" aria-hidden="true" />
                  Available <span className="ml-auto font-bold">{totals.available}</span>
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-crewly-accent" aria-hidden="true" />
                  Utilised <span className="ml-auto font-bold">{totals.used}</span>
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-crewly-orange" aria-hidden="true" />
                  Awaiting decision <span className="ml-auto font-bold">{totals.pending}</span>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-3 flex items-start gap-2.5 rounded-xl bg-crewly-inset/60 p-3">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-crewly-dim" aria-hidden="true" />
            {nextHoliday ? (
              <p className="text-[11px] leading-relaxed">
                Next public holiday:{' '}
                <span className="font-bold text-crewly-text">{nextHoliday.name}</span> on{' '}
                {fmt(nextHoliday.date)}.
                <span className="block text-crewly-dim">
                  It will not be counted against any of these balances.
                </span>
              </p>
            ) : (
              <p className="text-[11px] leading-relaxed text-crewly-dim">
                No upcoming holiday is published for this company yet.
              </p>
            )}
          </div>

          <div className="mt-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
              Where the days went
            </p>
            <ul className="mt-1.5 space-y-1.5">
              {(data.balance || []).map((b) => {
                const meta = TYPE_OF(b.type);
                const total = b.total || 0;
                const spent = (b.used || 0) + (b.pending || 0);
                return (
                  <li key={b.type} className="flex items-center gap-2 text-[11px]">
                    <span className="w-[86px] shrink-0 truncate text-crewly-dim">{meta.label}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-crewly-inset-strong">
                      <span
                        className={`block h-full rounded-full ${meta.bar}`}
                        style={{ width: `${total ? Math.min(100, (spent / total) * 100) : 0}%` }}
                      />
                    </span>
                    <span className="w-[62px] shrink-0 text-right tabular-nums">
                      <span className="font-bold">{spent}</span>
                      <span className="text-crewly-dim"> / {total}</span>
                    </span>
                  </li>
                );
              })}
              {!(data.balance || []).length ? (
                <li className="text-[11px] text-crewly-dim">No buckets to break down yet.</li>
              ) : null}
            </ul>
          </div>
        </section>

        <section className="card">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
                Quick apply
              </p>
              <h2 className="card-title text-base font-bold">Start a request</h2>
            </div>
            <Clock3 className="h-4 w-4 shrink-0 text-crewly-dim" aria-hidden="true" />
          </div>

          <form onSubmit={submit} className="mt-2.5 space-y-2.5">
            <div className="grid gap-2.5 sm:grid-cols-2">
              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-crewly-dim">Category</span>
                <select
                  className="input w-full"
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                >
                  {visibleBalance.map((b) => (
                    <option key={b.type} value={b.type}>
                      {b.label} — {b.available} left
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-crewly-dim">Start date</span>
                <input
                  type="date"
                  className="input w-full"
                  value={form.startDate}
                  min={iso(new Date())}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: form.endDate || e.target.value })}
                  required
                />
              </label>
            </div>

            <div>
              <span className="mb-1 block text-xs font-semibold text-crewly-dim">Scope</span>
              <div className="flex gap-1.5">
                {['Full day', 'First half', 'Second half'].map((scope, i) => (
                  <span
                    key={scope}
                    aria-disabled="true"
                    title={
                      i === 0
                        ? 'Requests cover whole working days.'
                        : 'Half-day leave is not recorded by this leave register yet.'
                    }
                    className={`flex-1 cursor-not-allowed rounded-lg px-2 py-1.5 text-center text-[11px] font-bold ${
                      i === 0
                        ? 'bg-crewly-inset-strong text-crewly-text'
                        : 'border border-dashed border-crewly-border text-crewly-dim/70'
                    }`}
                  >
                    {scope}
                  </span>
                ))}
              </div>
              <p className="mt-1 text-[10px] leading-tight text-crewly-dim">
                Requests are counted in whole working days — Saturday and Sunday are excluded from
                the day count.
              </p>
            </div>

            <label className="block text-xs">
              <span className="mb-1 block font-semibold text-crewly-dim">End date</span>
              <input
                type="date"
                className="input w-full"
                value={form.endDate}
                min={form.startDate || iso(new Date())}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                required
              />
            </label>

            <label className="block text-xs">
              <span className="mb-1 block font-semibold text-crewly-dim">Reason</span>
              <textarea
                className="input w-full"
                rows={2}
                maxLength={300}
                placeholder="Why do you need this leave?"
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                required
              />
            </label>

            <div className="rounded-lg bg-crewly-inset/60 px-2.5 py-2 text-[10px] leading-relaxed text-crewly-dim">
              {draftDays ? (
                <>
                  <span className="font-bold text-crewly-text">
                    {draftDays} working {draftDays === 1 ? 'day' : 'days'}
                  </span>{' '}
                  · leaves {Math.max(0, draftBalance - draftDays)} of {draftBalance} in this bucket ·
                  routed to your reporting manager for a decision.
                </>
              ) : (
                'Pick a start and end date and the day count appears here before you send it.'
              )}
            </div>

            {draftBalance === 0 ? (
              <p className="flex items-center gap-1.5 text-[11px] text-crewly-red">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> No balance left in this
                type
              </p>
            ) : null}

            <div className="flex gap-2">
              <button
                type="button"
                className="btn-ghost px-3 py-2 text-xs font-bold"
                onClick={() => setForm({ type: 'CASUAL', startDate: '', endDate: '', reason: '' })}
              >
                Clear
              </button>
              <button
                type="submit"
                className="btn-primary flex-1 px-3 py-2 text-xs font-bold disabled:opacity-50"
                disabled={saving || draftBalance === 0}
              >
                {saving ? 'Submitting…' : 'Submit request'}
              </button>
            </div>
          </form>
        </section>
      </div>

      {/* ── the trail ─────────────────────────────────────────────────── */}
      <section className="card overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-crewly-border px-4 py-3">
          <div>
            <h2 className="card-title text-base font-bold">Time off trail</h2>
            <p className="text-[11px] text-crewly-dim">
              Every request you have filed, newest first, with the decision and who made it.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {['ALL', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setFilter(s);
                  setPage(1);
                }}
                className={`rounded-full px-2.5 py-1 text-[10px] font-bold transition ${
                  filter === s
                    ? 'bg-crewly-inset-strong text-crewly-text'
                    : 'border border-crewly-border text-crewly-dim hover:text-crewly-text'
                }`}
              >
                {s === 'ALL' ? 'All' : s.charAt(0) + s.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-crewly-border text-[10px] uppercase tracking-[0.1em] text-crewly-dim">
                <th className="whitespace-nowrap px-4 py-2.5 font-semibold">Absence window</th>
                <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Type</th>
                <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Duration</th>
                <th className="px-3 py-2.5 font-semibold">Reason</th>
                <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Status</th>
                <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Approved by</th>
                <th className="px-4 py-2.5 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => {
                const meta = TYPE_OF(l.type);
                return (
                  <tr key={l._id} className="border-b border-crewly-border/50 last:border-0">
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5 rounded-lg bg-crewly-inset px-2 py-1 text-[11px] font-semibold">
                        <span className="text-crewly-dim">{chip(l.startDate)}</span>
                        <ArrowRight className="h-3 w-3 text-crewly-dim" aria-hidden="true" />
                        <span>{chip(l.endDate)}</span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span className={`badge ${meta.chip}`}>{meta.label}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[11px]">
                      <span className="font-bold">{l.days}</span>{' '}
                      <span className="text-crewly-dim">{l.days === 1 ? 'day' : 'days'}</span>
                    </td>
                    <td className="max-w-[240px] px-3 py-2.5">
                      <p className="truncate text-[12px]" title={l.reason}>
                        {l.reason}
                      </p>
                      {l.approverNote ? (
                        <p className="mt-0.5 flex items-start gap-1 text-[10px] text-crewly-dim">
                          <Info className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                          <span className="line-clamp-1">{l.approverNote}</span>
                        </p>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span className={`badge ${STATUS_STYLE[l.status] || ''}`}>{l.status}</span>
                      {l.decidedAt ? (
                        <p className="mt-0.5 text-[10px] text-crewly-dim">{fmt(l.decidedAt)}</p>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[11px]">
                      {l.approver?.name || <span className="text-crewly-dim">Awaiting decision</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      {l.status === 'PENDING' ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-lg border border-crewly-red/40 px-2.5 py-1 text-[11px] font-semibold text-crewly-red hover:bg-crewly-red/10"
                          onClick={() => cancel(l)}
                        >
                          <X className="h-3 w-3" aria-hidden="true" /> Cancel
                        </button>
                      ) : (
                        <span className="text-[11px] text-crewly-dim">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!trail.length ? (
                <TableEmpty
                  colSpan={7}
                  illustration="calendar"
                  title={filter === 'ALL' ? 'No leave requests yet' : `No ${filter.toLowerCase()} requests`}
                  description={
                    filter === 'ALL'
                      ? 'Apply for leave and it appears here with its approval trail — who saw it, and when.'
                      : 'Switch the filter to see the rest of your trail.'
                  }
                />
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-crewly-border bg-crewly-inset/40 px-4 py-2.5">
          <p className="text-[11px] text-crewly-dim">
            Showing {rows.length} of {trail.length} {trail.length === 1 ? 'request' : 'requests'}
          </p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={current === 1}
              className="rounded-lg border border-crewly-border p-1 disabled:opacity-40"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="text-[11px] font-semibold">
              Page {current} of {pages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={current === pages}
              className="rounded-lg border border-crewly-border p-1 disabled:opacity-40"
              aria-label="Next page"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </section>

      {/* ── apply modal (same fields, on demand) ──────────────────────── */}
      {showApply ? (
        <Modal title="Apply for leave" onClose={() => setShowApply(false)}>
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className="label">Leave type</label>
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {visibleBalance.map((b) => (
                  <option key={b.type} value={b.type}>
                    {b.label} — {b.available} left
                  </option>
                ))}
              </select>
              {availableOf(form.type) === 0 ? (
                <p className="mt-1 flex items-center gap-1 text-xs text-crewly-red">
                  <AlertTriangle className="h-3.5 w-3.5" />No balance left in this type
                </p>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Start date</label>
                <input
                  type="date"
                  className="input"
                  value={form.startDate}
                  min={iso(new Date())}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: form.endDate || e.target.value })}
                  required
                />
              </div>
              <div>
                <label className="label">End date</label>
                <input
                  type="date"
                  className="input"
                  value={form.endDate}
                  min={form.startDate || iso(new Date())}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                  required
                />
              </div>
            </div>
            <div>
              <label className="label">Reason</label>
              <textarea
                className="input"
                rows={3}
                maxLength={300}
                placeholder="Why do you need this leave?"
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                required
              />
            </div>
            <p className="text-xs text-crewly-dim">
              {draftDays ? `${draftDays} working ${draftDays === 1 ? 'day' : 'days'} · ` : ''}
              Sat/Sun are auto-excluded from the day count.
            </p>
            <button type="submit" className="btn-primary w-full" disabled={saving || availableOf(form.type) === 0}>
              {saving ? 'Submitting…' : 'Submit request'}
            </button>
          </form>
        </Modal>
      ) : null}
    </div>
  );
};

export default LeavesPage;
