import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarRange,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  CornerDownRight,
  Layers,
  Mail,
  Search,
  ShieldCheck,
  Timer,
  X,
} from 'lucide-react';
import leaveService from '../../services/leaveService.js';
import Modal from '../../components/Modal.jsx';
import { roleLabel } from '../../utils/roles.js';
import { notify } from '../../utils/notify.js';
import EmptyState, { TableEmpty } from '../../components/common/EmptyState.jsx';

const STATUS_STYLE = {
  PENDING: 'bg-crewly-orange/15 text-crewly-orange',
  APPROVED: 'bg-crewly-green/15 text-crewly-green',
  REJECTED: 'bg-crewly-red/15 text-crewly-red',
  CANCELLED: 'bg-crewly-inset-strong text-crewly-dim',
};

/* One colour role per leave type — the same type reads the same everywhere. */
const TYPE = {
  CASUAL: { label: 'Casual leave', chip: 'bg-crewly-orange/15 text-crewly-orange', dot: 'bg-crewly-orange' },
  SICK: { label: 'Sick leave', chip: 'bg-crewly-red/15 text-crewly-red', dot: 'bg-crewly-red' },
  EARNED: { label: 'Earned leave', chip: 'bg-crewly-green/15 text-crewly-green', dot: 'bg-crewly-green' },
  COMP_OFF: { label: 'Comp-off', chip: 'bg-crewly-selected/60 text-crewly-text', dot: 'bg-crewly-accent' },
};
const typeOf = (t) =>
  TYPE[t] || { label: t, chip: 'bg-crewly-inset-strong text-crewly-dim', dot: 'bg-crewly-dim' };

/* Mirrors Backend/src/utils/constants.js — the register's yearly allocation. */
const POLICY = [
  { type: 'CASUAL', yearly: 12, note: 'Planned personal time. Applied against the calendar year.' },
  { type: 'SICK', yearly: 6, note: 'Short illness. No document is attached to the record today.' },
  { type: 'EARNED', yearly: 12, note: 'Accrued time off. Booked ahead of the absence.' },
  { type: 'COMP_OFF', yearly: 0, note: 'Credited per extra day worked — never a standing quota.' },
];

const DAY_MS = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const dayName = (date) =>
  new Date(`${date}T00:00:00`).toLocaleDateString([], { weekday: 'short' });
const shortDate = (date) =>
  new Date(`${date}T00:00:00`).toLocaleDateString([], { day: '2-digit', month: 'short' });
const fmtDate = (value) => {
  if (!value) return '—';
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
};

const ago = (value, now) => {
  if (!value) return 'date not recorded';
  const ms = now - new Date(value).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
};

const initials = (name = '') =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';

const rangeLabel = (start, end) => {
  const s = fmtDate(start);
  const e = fmtDate(end);
  return s === e ? s : `${s} → ${e}`;
};

const LEAVE_STATUSES = ['ALL', 'APPROVED', 'REJECTED', 'CANCELLED'];

const LeaveApprovalsPage = () => {
  const [tab, setTab] = useState('pending');
  const [pending, setPending] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [deciding, setDeciding] = useState(null); // { leaves: [], action }
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [showZeroState, setShowZeroState] = useState(false);
  /* one clock reading per mount — dates and ages stay stable while the page is open */
  const [nowMs] = useState(() => Date.now());

  const loadPending = () =>
    leaveService
      .pending()
      .then((d) => setPending(Array.isArray(d) ? d : d.leaves || []))
      .catch(() => {});
  const loadHistory = () =>
    leaveService
      .requests('ALL')
      .then((d) => setHistory(Array.isArray(d) ? d : d.leaves || []))
      .catch(() => {});

  useEffect(() => {
    let alive = true;
    Promise.resolve().then(async () => {
      if (!alive) return;
      await Promise.all([loadPending(), loadHistory()]);
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const refresh = () => {
    loadPending();
    loadHistory();
  };

  const submitDecision = async () => {
    if (!deciding) return;
    setSaving(true);
    try {
      /* the only decision path is per-leave, so a bulk action walks the queue */
      for (const leave of deciding.leaves) {
        await leaveService.decide(leave._id, deciding.action, note);
      }
      notify.success(
        deciding.leaves.length === 1
          ? `Leave ${deciding.action === 'APPROVE' ? 'approved' : 'declined'}.`
          : `${deciding.leaves.length} requests ${deciding.action === 'APPROVE' ? 'approved' : 'declined'}.`,
      );
      setDeciding(null);
      setNote('');
      refresh();
    } catch (err) {
      notify.error(err);
    } finally {
      setSaving(false);
    }
  };

  const urgent = useMemo(
    () =>
      [...pending].sort(
        (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime(),
      ),
    [pending],
  );

  const visiblePending = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return urgent.filter((l) => {
      if (typeFilter && l.type !== typeFilter) return false;
      if (!needle) return true;
      return `${l.user?.name || ''} ${l.user?.department?.name || ''} ${l.reason || ''}`
        .toLowerCase()
        .includes(needle);
    });
  }, [urgent, query, typeFilter]);

  const visibleHistory = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...history]
      .filter((l) => (typeFilter ? l.type === typeFilter : true))
      .filter((l) => (statusFilter === 'ALL' ? true : l.status === statusFilter))
      .filter((l) => (needle ? `${l.user?.name || ''} ${l.reason || ''}`.toLowerCase().includes(needle) : true))
      .sort((a, b) => String(b.decidedAt || b.createdAt || '').localeCompare(String(a.decidedAt || a.createdAt || '')));
  }, [history, query, typeFilter, statusFilter]);

  const oldest = urgent[0];
  const decided = history.filter((l) => l.status === 'APPROVED' || l.status === 'REJECTED');
  const approved = decided.filter((l) => l.status === 'APPROVED').length;
  const rejected = decided.filter((l) => l.status === 'REJECTED').length;
  const approvalRate = decided.length ? Math.round((approved / decided.length) * 100) : 0;
  const daysInQueue = pending.reduce((acc, l) => acc + (l.days || 0), 0);

  /* Which of the next seven days already have someone out on a request that is
     still waiting — read straight off the pending queue. */
  const outlook = useMemo(() => {
    const days = [];
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(nowMs + i * DAY_MS);
      const key = iso(d);
      const away = pending.filter(
        (l) => String(l.startDate).slice(0, 10) <= key && String(l.endDate).slice(0, 10) >= key,
      );
      days.push({ key, away });
    }
    return days;
  }, [pending, nowMs]);

  const overlapsFor = (leave) =>
    pending.filter(
      (other) =>
        other._id !== leave._id &&
        String(other.startDate).slice(0, 10) <= String(leave.endDate).slice(0, 10) &&
        String(other.endDate).slice(0, 10) >= String(leave.startDate).slice(0, 10),
    );

  const [quarter] = useState(() => Math.floor(new Date().getMonth() / 3) + 1);
  const tabs = [
    { key: 'pending', label: 'Pending review', count: pending.length },
    { key: 'history', label: 'History & decisions', count: history.length },
    { key: 'policies', label: 'Leave policies', count: null },
  ];

  return (
    <div className="space-y-5">
      {/* ── title ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-crewly-dim">
            Management console
            <span className="mx-2 text-crewly-border">•</span>
            Cycle {new Date().getFullYear()}-Q{quarter}
          </p>
          <h1 className="mt-1 text-2xl font-bold sm:text-[28px]">Leave approvals &amp; management</h1>
          <p className="mt-1 max-w-2xl text-sm text-crewly-dim">
            Every request waiting on a decision, oldest first — with the reason stated, the days it
            costs, and who else is already out on those dates.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:max-w-md sm:grid-cols-2">
          <div className="rounded-xl border border-crewly-border bg-crewly-card px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
              Pending queue
            </p>
            <p className="mt-0.5 flex items-baseline gap-1.5">
              <span className="text-xl font-bold">{pending.length}</span>
              <span className="text-[10px] text-crewly-dim">{daysInQueue} working days</span>
            </p>
          </div>
          <div className="rounded-xl border border-crewly-border bg-crewly-card px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
              Longest waiting
            </p>
            <p className="mt-0.5 truncate text-sm font-bold">{oldest ? ago(oldest.createdAt, nowMs) : 'Nothing queued'}</p>
          </div>
        </div>
      </div>

      {/* ── tabs ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-crewly-border pb-0">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-bold transition ${
              tab === t.key
                ? 'border-crewly-accent text-crewly-text'
                : 'border-transparent text-crewly-dim hover:text-crewly-text'
            }`}
          >
            {t.label}
            {t.count !== null ? (
              <span className="rounded-full bg-crewly-inset-strong px-1.5 text-[10px]">{t.count}</span>
            ) : null}
          </button>
        ))}
      </div>

      {/* ── decision mix + queue tools ────────────────────────────────── */}
      {tab !== 'policies' ? (
        <div className="card space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-[220px] flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
                  Decision mix
                </p>
                <p className="text-[11px] font-bold">{approvalRate}% approved</p>
              </div>
              <div className="mt-1 flex h-2 overflow-hidden rounded-full bg-crewly-inset-strong">
                <span className="bg-crewly-green" style={{ width: `${decided.length ? (approved / decided.length) * 100 : 0}%` }} />
                <span className="bg-crewly-red" style={{ width: `${decided.length ? (rejected / decided.length) * 100 : 0}%` }} />
              </div>
              <p className="mt-1 text-[11px] text-crewly-dim">
                {decided.length
                  ? `${approved} approved · ${rejected} declined · ${history.length} on record`
                  : 'No decisions recorded yet.'}
              </p>
            </div>

            <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
              <label className="relative block min-w-[160px] flex-1 sm:max-w-[220px]">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crewly-dim"
                  aria-hidden="true"
                />
                <input
                  className="input w-full py-1.5 pl-7 text-xs"
                  placeholder="Search name or reason"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search requests"
                />
              </label>
              <select
                className="input py-1.5 text-xs"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                aria-label="Filter by leave type"
              >
                <option value="">All types</option>
                {Object.entries(TYPE).map(([key, meta]) => (
                  <option key={key} value={key}>
                    {meta.label}
                  </option>
                ))}
              </select>
              {tab === 'history' ? (
                <select
                  className="input py-1.5 text-xs"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  aria-label="Filter by decision"
                >
                  {LEAVE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s === 'ALL' ? 'Every decision' : s.charAt(0) + s.slice(1).toLowerCase()}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          </div>

          {tab === 'pending' ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-crewly-border pt-2.5">
              <p className="text-[11px] text-crewly-dim">
                Bulk actions walk the queue one request at a time — the register has no all-at-once
                endpoint, so each decision is recorded on its own.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!visiblePending.length}
                  onClick={() => {
                    if (!visiblePending.length) return;
                    if (window.confirm(`Decline all ${visiblePending.length} visible requests?`)) {
                      setNote('');
                      setDeciding({ leaves: visiblePending, action: 'REJECT' });
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-crewly-red/40 px-2.5 py-1.5 text-[11px] font-bold text-crewly-red transition hover:bg-crewly-red/10 disabled:opacity-40"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" /> Bulk decline
                </button>
                <button
                  type="button"
                  disabled={!visiblePending.length}
                  onClick={() => {
                    if (!visiblePending.length) return;
                    if (window.confirm(`Approve all ${visiblePending.length} visible requests?`)) {
                      setNote('');
                      setDeciding({ leaves: visiblePending, action: 'APPROVE' });
                    }
                  }}
                  className="btn-primary inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-bold disabled:opacity-40"
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" /> Bulk approve
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── pending review ────────────────────────────────────────────── */}
      {tab === 'pending' ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
              Pending decisions ({visiblePending.length})
              <span className="ml-2 normal-case tracking-normal text-crewly-dim/80">
                sorted by urgency — the longest wait first
              </span>
            </p>
            <button
              type="button"
              onClick={() => setShowZeroState((v) => !v)}
              className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-crewly-dim hover:text-crewly-text"
            >
              <ChevronDown
                className={`h-3.5 w-3.5 transition ${showZeroState ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
              Preview zero-pending state
            </button>
          </div>

          {showZeroState ? (
            <div className="card border-dashed">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-crewly-dim">
                Preview only — this is how the queue reads when nothing is waiting
              </p>
              <EmptyState
                illustration="calendar"
                title="Queue clear"
                description="Every request has a decision. New requests from your team land here oldest-first, with the reason and the days it costs."
                size="sm"
              />
            </div>
          ) : null}

          <div className="space-y-3">
            {visiblePending.map((l) => {
              const meta = typeOf(l.type);
              const overlaps = overlapsFor(l);
              return (
                <article key={l._id} className="card p-0">
                  <div className="flex flex-col gap-3 p-4 lg:flex-row">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start gap-3">
                        <span className="relative shrink-0">
                          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-crewly-inset-strong text-xs font-bold">
                            {initials(l.user?.name)}
                          </span>
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-crewly-card ${meta.dot}`}
                            aria-hidden="true"
                          />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <p className="text-sm font-bold">{l.user?.name || 'Team member'}</p>
                            <span className="rounded bg-crewly-inset-strong px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-crewly-dim">
                              {l.user?.department?.name || roleLabel(l.user?.role)}
                            </span>
                          </div>
                          <p className="text-[11px] text-crewly-dim">
                            {roleLabel(l.user?.role)} · requested {ago(l.createdAt, nowMs)}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${meta.chip}`}>
                            {meta.label}
                          </span>
                          <span className="rounded-full bg-crewly-inset-strong px-2 py-0.5 text-[10px] font-bold">
                            {l.days} {l.days === 1 ? 'day' : 'days'}
                          </span>
                        </div>
                      </div>

                      <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
                        <CalendarRange className="h-3.5 w-3.5 text-crewly-dim" aria-hidden="true" />
                        {rangeLabel(l.startDate, l.endDate)}
                        <span className="text-crewly-dim">
                          ({dayName(String(l.startDate).slice(0, 10))}
                          {String(l.startDate).slice(0, 10) !== String(l.endDate).slice(0, 10)
                            ? ` – ${dayName(String(l.endDate).slice(0, 10))}`
                            : ''}
                          )
                        </span>
                      </p>

                      <blockquote className="mt-2 min-w-0 break-words border-l-2 border-crewly-accent/60 bg-crewly-inset/50 px-2.5 py-1.5 text-[11px] italic leading-relaxed text-crewly-text/90">
                        “{l.reason}”
                      </blockquote>

                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <div className="rounded-lg bg-crewly-inset/50 px-2.5 py-1.5">
                          <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-crewly-dim">
                            What it costs
                          </p>
                          <p className="mt-0.5 text-[11px]">
                            <span className="font-bold">{l.days}</span> working{' '}
                            {l.days === 1 ? 'day' : 'days'} · weekends excluded from the count
                          </p>
                        </div>
                        <div className="rounded-lg bg-crewly-inset/50 px-2.5 py-1.5">
                          <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-crewly-dim">
                            Overlaps
                          </p>
                          <p className={`mt-0.5 flex items-center gap-1 text-[11px] ${overlaps.length ? 'text-crewly-orange' : 'text-crewly-green'}`}>
                            {overlaps.length ? (
                              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                            ) : (
                              <Check className="h-3 w-3" aria-hidden="true" />
                            )}
                            {overlaps.length
                              ? `${overlaps.length} other request${overlaps.length === 1 ? '' : 's'} on these dates`
                              : 'No other request covers these dates'}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col gap-1.5 border-t border-crewly-border pt-3 lg:w-44 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
                      <button
                        type="button"
                        onClick={() => {
                          setNote('');
                          setDeciding({ leaves: [l], action: 'APPROVE' });
                        }}
                        className="btn-primary inline-flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-bold"
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden="true" /> Approve leave
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setNote('');
                          setDeciding({ leaves: [l], action: 'REJECT' });
                        }}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-crewly-red/40 px-3 py-2 text-[11px] font-bold text-crewly-red transition hover:bg-crewly-red/10"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" /> Decline with note
                      </button>
                      {l.user?.email ? (
                        <a
                          href={`mailto:${l.user.email}?subject=${encodeURIComponent('Your leave request')}`}
                          className="btn-ghost inline-flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-bold"
                        >
                          <Mail className="h-3.5 w-3.5" aria-hidden="true" /> Message
                        </a>
                      ) : (
                        <span className="px-3 py-2 text-center text-[11px] text-crewly-dim">
                          No email on file
                        </span>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}

            {!visiblePending.length && !loading ? (
              <div className="card">
                <EmptyState
                  illustration="calendar"
                  title={pending.length ? 'Nothing matches this filter' : 'Queue clear'}
                  description={
                    pending.length
                      ? 'Clear the search or the type filter to see the rest of the queue.'
                      : 'Every leave request has a decision. New ones land here oldest-first.'
                  }
                  size="sm"
                />
              </div>
            ) : null}
          </div>

          {/* ── next seven days ─────────────────────────────────────── */}
          <section className="card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
                  Availability outlook
                </p>
                <h2 className="card-title text-base font-bold">Next seven days</h2>
              </div>
              <p className="text-[11px] text-crewly-dim">
                Requests still awaiting a decision that cover each day
              </p>
            </div>
            <div className="mt-2.5 grid grid-cols-4 gap-1.5 sm:grid-cols-7">
              {outlook.map((d, i) => {
                const weekend = [0, 6].includes(new Date(`${d.key}T00:00:00`).getDay());
                return (
                  <div
                    key={d.key}
                    className={`rounded-lg border px-1 py-1.5 text-center ${
                      weekend ? 'border-transparent bg-crewly-inset/40' : 'border-crewly-border'
                    }`}
                  >
                    <p className="text-[9px] font-bold uppercase text-crewly-dim">
                      {i === 0 ? 'Today' : dayName(d.key)}
                    </p>
                    <p className="text-sm font-bold leading-tight">{shortDate(d.key).split(' ')[0]}</p>
                    <p className={`mt-0.5 text-[9px] font-semibold ${d.away.length ? 'text-crewly-orange' : 'text-crewly-dim'}`}>
                      {d.away.length ? `${d.away.length} out` : weekend ? 'Weekend' : 'Clear'}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      ) : null}

      {/* ── history ───────────────────────────────────────────────────── */}
      {tab === 'history' ? (
        <section className="card overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-crewly-border text-[10px] uppercase tracking-[0.1em] text-crewly-dim">
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">Person</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Type</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Window</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Days</th>
                  <th className="px-3 py-2.5 font-semibold">Reason</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Decision</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-semibold">Decided by</th>
                </tr>
              </thead>
              <tbody>
                {visibleHistory.map((l) => {
                  const meta = typeOf(l.type);
                  return (
                    <tr key={l._id} className="border-b border-crewly-border/50 last:border-0">
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <span className="flex items-center gap-2">
                          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-crewly-inset-strong text-[9px] font-bold">
                            {initials(l.user?.name)}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-xs font-semibold">{l.user?.name || '—'}</span>
                            <span className="block text-[10px] text-crewly-dim">
                              {l.user?.department?.name || roleLabel(l.user?.role)}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <span className={`badge ${meta.chip}`}>{meta.label}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-[11px]">{rangeLabel(l.startDate, l.endDate)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 font-bold">{l.days}</td>
                      <td className="max-w-[240px] px-3 py-2.5">
                        <p className="truncate text-[12px]" title={l.reason}>
                          {l.reason}
                        </p>
                        {l.approverNote ? (
                          <p className="mt-0.5 flex items-start gap-1 text-[10px] text-crewly-dim">
                            <CornerDownRight className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="line-clamp-1">{l.approverNote}</span>
                          </p>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <span className={`badge ${STATUS_STYLE[l.status] || ''}`}>{l.status}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-[11px]">
                        <span className="block">{l.approver?.name || '—'}</span>
                        <span className="block text-[10px] text-crewly-dim">{fmtDate(l.decidedAt)}</span>
                      </td>
                    </tr>
                  );
                })}
                {!visibleHistory.length ? (
                  <TableEmpty
                    colSpan={7}
                    illustration="calendar"
                    title="No decisions here"
                    description="Once a request is approved or declined it is kept here with the note attached."
                  />
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-crewly-border bg-crewly-inset/40 px-4 py-2.5 text-[11px] text-crewly-dim">
            <span>
              Showing {visibleHistory.length} of {history.length} recorded
              {history.length === 1 ? ' request' : ' requests'}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock3 className="h-3 w-3" aria-hidden="true" /> Newest decision first
            </span>
          </div>
        </section>
      ) : null}

      {/* ── policies ──────────────────────────────────────────────────── */}
      {tab === 'policies' ? (
        <div className="grid items-start gap-4 xl:grid-cols-3">
          <section className="card xl:col-span-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">
                  Register policy
                </p>
                <h2 className="card-title text-base font-bold">Yearly allocation per type</h2>
              </div>
              <ShieldCheck className="h-4 w-4 shrink-0 text-crewly-dim" aria-hidden="true" />
            </div>
            <p className="mt-1 text-[11px] text-crewly-dim">
              These are the caps the leave engine applies when it builds every balance. A request is
              measured against the requester&apos;s own remaining days, not this table.
            </p>
            <div className="mt-3 divide-y divide-crewly-border/60">
              {POLICY.map((p) => {
                const meta = typeOf(p.type);
                return (
                  <div key={p.type} className="flex flex-wrap items-center gap-2 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${meta.chip}`}>
                      {meta.label}
                    </span>
                    <p className="min-w-[160px] flex-1 text-[11px] text-crewly-dim">{p.note}</p>
                    <span className="rounded-lg bg-crewly-inset-strong px-2 py-0.5 text-[11px] font-bold">
                      {p.yearly ? `${p.yearly} days / year` : 'As earned'}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card">
            <h2 className="card-title flex items-center gap-2 text-base font-bold">
              <Layers className="h-4 w-4 text-crewly-dim" aria-hidden="true" />
              How a decision is recorded
            </h2>
            <ul className="mt-2 space-y-2 text-[11px] leading-relaxed">
              {[
                ['One decision per request', 'Approving or declining writes the decision, the note and the date to that request.'],
                ['Days are working days', 'Saturday and Sunday are excluded when the register counts duration.'],
                ['Cancelling is the requester’s move', 'A pending request can be withdrawn before a decision lands.'],
                ['Nothing is deleted', 'A declined request stays on record with the reason attached.'],
              ].map(([title, body]) => (
                <li key={title} className="rounded-lg bg-crewly-inset/50 px-2.5 py-2">
                  <p className="font-bold text-crewly-text">{title}</p>
                  <p className="text-crewly-dim">{body}</p>
                </li>
              ))}
            </ul>
            <a
              href="/app/leaves"
              className="btn-ghost mt-3 inline-flex w-full items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-bold"
            >
              Open my own balances <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </section>
        </div>
      ) : null}

      {/* ── decision dialog ───────────────────────────────────────────── */}
      {deciding ? (
        <Modal
          title={
            deciding.leaves.length === 1
              ? deciding.action === 'APPROVE'
                ? `Approve ${deciding.leaves[0].user?.name || 'this request'}`
                : `Decline ${deciding.leaves[0].user?.name || 'this request'}`
              : `${deciding.action === 'APPROVE' ? 'Approve' : 'Decline'} ${deciding.leaves.length} requests`
          }
          onClose={() => setDeciding(null)}
        >
          <div className="space-y-3">
            {deciding.leaves.length === 1 ? (
              <div className="rounded-xl bg-crewly-inset/60 p-3 text-[11px]">
                <p className="flex items-center gap-1.5 font-semibold">
                  <Timer className="h-3.5 w-3.5 text-crewly-dim" aria-hidden="true" />
                  {rangeLabel(deciding.leaves[0].startDate, deciding.leaves[0].endDate)} ·{' '}
                  {deciding.leaves[0].days} {deciding.leaves[0].days === 1 ? 'day' : 'days'}
                </p>
                <p className="mt-1 italic text-crewly-dim">“{deciding.leaves[0].reason}”</p>
              </div>
            ) : (
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-xl bg-crewly-inset/60 p-2 text-[11px]">
                {deciding.leaves.map((l) => (
                  <li key={l._id} className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold">{l.user?.name || l._id}</span>
                    <span className="shrink-0 text-crewly-dim">{l.days}d</span>
                  </li>
                ))}
              </ul>
            )}

            <div>
              <label className="label">
                {deciding.action === 'REJECT' ? 'Note to the requester' : 'Note (optional)'}
              </label>
              <textarea
                className="input"
                rows={3}
                maxLength={300}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  deciding.action === 'REJECT'
                    ? 'What should they know before re-applying?'
                    : 'Anything worth recording alongside the approval?'
                }
              />
              <p className="mt-1 text-[10px] text-crewly-dim">
                {deciding.action === 'REJECT' && !note.trim()
                  ? 'A note is shown on their trail — it is worth writing one.'
                  : 'The note is saved with the decision and shown on their trail.'}
              </p>
            </div>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" className="btn-ghost px-4 py-2 text-xs font-bold" onClick={() => setDeciding(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-xs font-bold disabled:opacity-50 ${
                  deciding.action === 'APPROVE'
                    ? 'btn-primary'
                    : 'border border-crewly-red/40 text-crewly-red hover:bg-crewly-red/10'
                }`}
                disabled={saving}
                onClick={submitDecision}
              >
                {deciding.action === 'APPROVE' ? (
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <X className="h-4 w-4" aria-hidden="true" />
                )}
                {saving
                  ? 'Recording…'
                  : deciding.action === 'APPROVE'
                    ? 'Record approval'
                    : 'Record decline'}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
};

export default LeaveApprovalsPage;
