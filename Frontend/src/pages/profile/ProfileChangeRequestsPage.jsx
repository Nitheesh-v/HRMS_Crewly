// ============================================================
// PROFILE CHANGE REQUESTS — the reviewer queue (Phase 38)
//
// Who sees this page: HR Manager and Company Admin (the
// PROFILE_CHANGE_REVIEW permission). The page is a thin shell —
// the SERVER decides what a reviewer may see (org scope) and what a
// decision does. A MANAGER whose subtree is empty simply gets an empty
// queue; there is nothing to hide in the UI.
//
// Approving here is the ONLY way a name / designation / employee code /
// date of joining / bank value proposed by an employee becomes real.
//
// The layout puts the old and the new value side by side, because that is
// the only comparison a reviewer actually makes. The counts above the queue
// are derived from the rows the API returned — no target, no promise about
// how fast a review should happen, and no "this month" figure when there is
// nothing to average.
// ============================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Check, ClipboardCheck, Clock, Loader2, RefreshCw, Search, ShieldAlert, X,
} from 'lucide-react';
import profileService from '../../services/profileService';
import Modal from '../../components/Modal.jsx';
import { notify } from '../../utils/notify.js';
import EmptyState from '../../components/common/EmptyState.jsx';

const STATUS_STYLE = {
  pending: 'bg-amber-400/15 text-amber-300',
  approved: 'bg-crewly-green/15 text-crewly-green',
  rejected: 'bg-crewly-red/15 text-crewly-red',
  cancelled: 'bg-crewly-inset-strong text-crewly-dim',
};

const STATUS_WORD = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Withdrawn',
};

const pretty = (value) => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/* "2 hours ago" for the queue, because a reviewer triages by staleness. Falls
   back to the absolute date once a request is older than a fortnight — past
   that point "37 days ago" is harder to place than the date itself. */
const ago = (value) => {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days <= 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  return pretty(value);
};

const initials = (name = '') =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '?';

const Tile = ({ icon: Icon, label, value, sub }) => (
  <div className="flex items-start gap-3 bg-crewly-card p-4 sm:p-5">
    <div className="min-w-0 flex-1">
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">{label}</p>
      <p className="mt-1.5 text-xl font-bold leading-tight sm:text-2xl">{value}</p>
      {sub ? <p className="mt-1 text-xs leading-snug text-crewly-dim">{sub}</p> : null}
    </div>
    <Icon className="mt-0.5 h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />
  </div>
);

const FieldChip = ({ change }) => (
  <span
    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
      change.sensitive ? 'bg-crewly-red/15 text-crewly-red' : 'bg-crewly-inset text-crewly-dim'
    }`}
  >
    {change.sensitive ? <ShieldAlert className="h-3 w-3" /> : null}
    {change.label}
  </span>
);

/* The comparison. Two panels, same field order on both sides, so the eye can
   run straight across. Values are whatever the API serialized — a sensitive
   field arrives already masked and is never re-rendered from a raw copy. */
const Comparison = ({ row }) => (
  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
    <div className="rounded-xl border border-crewly-border bg-crewly-inset/40 p-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">Current record</p>
      <dl className="space-y-2">
        {row.changes.map((change) => (
          <div key={`from-${change.field}`}>
            <dt className="text-[11px] text-crewly-dim">{change.label}</dt>
            <dd className="text-sm">{change.from || '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
    <div className="rounded-xl border border-crewly-green/30 bg-crewly-green/[0.06] p-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-green">Proposed</p>
      <dl className="space-y-2">
        {row.changes.map((change) => (
          <div key={`to-${change.field}`}>
            <dt className="text-[11px] text-crewly-dim">{change.label}</dt>
            <dd className="text-sm font-semibold">{change.to || '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  </div>
);

const ProfileChangeRequestsPage = () => {
  const [tab, setTab] = useState('pending');
  const [pending, setPending] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [deciding, setDeciding] = useState(null); // { request, action }
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const loadPending = useCallback(async () => {
    try {
      const res = await profileService.pendingChangeRequests();
      setPending(res?.requests || []);
    } catch (err) {
      notify.error(err);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const [approved, rejected] = await Promise.all([
        profileService.changeRequestHistory('approved'),
        profileService.changeRequestHistory('rejected'),
      ]);
      setHistory([...(approved?.requests || []), ...(rejected?.requests || [])]);
    } catch (err) {
      notify.error(err);
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadPending(), loadHistory()]);
    setLoading(false);
  }, [loadPending, loadHistory]);

  useEffect(() => { reload(); }, [reload]);

  const submitDecision = async () => {
    if (!deciding) return;
    setSaving(true);
    /* 35.1 — nothing to report; failures are toasted by api.js */
    try {
      await profileService.decideChangeRequest(deciding.request.id, deciding.action, note);
      notify.success(
        deciding.action === 'approve'
          ? 'Approved — the profile has been updated'
          : 'Rejected — the profile was left unchanged',
      );
      setDeciding(null);
      setNote('');
      reload();
    } catch (err) {
      notify.error(err);
      // A conflict (someone else decided, or the value drifted) means this
      // screen is stale: reload instead of leaving a lie on screen.
      if (err?.status === 409) reload();
    } finally {
      setSaving(false);
    }
  };

  const matches = (row, term) => {
    if (!term) return true;
    const haystack = [
      row.employeeName,
      row.employeeCode,
      row.reason,
      ...(row.changes || []).map((c) => `${c.label} ${c.to}`),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(term);
  };

  const term = query.trim().toLowerCase();
  const visiblePending = useMemo(() => pending.filter((row) => matches(row, term)), [pending, term]);
  const visibleHistory = useMemo(() => history.filter((row) => matches(row, term)), [history, term]);

  /* Counts come from the rows on screen, never from a target. A typical
     decision time is shown only when there are decisions to average. */
  const decided = history.length;
  const approvedCount = history.filter((r) => r.status === 'approved').length;
  const rejectedCount = history.filter((r) => r.status === 'rejected').length;
  const decisionHours = useMemo(() => {
    const spans = history
      .map((row) => {
        const from = new Date(row.requestedAt).getTime();
        const to = new Date(row.reviewedAt).getTime();
        if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
        return (to - from) / 3600000;
      })
      .filter((value) => value !== null);
    if (!spans.length) return null;
    return spans.reduce((sum, value) => sum + value, 0) / spans.length;
  }, [history]);
  const oldestPending = useMemo(() => {
    const times = pending
      .map((row) => new Date(row.requestedAt).getTime())
      .filter((t) => Number.isFinite(t));
    return times.length ? Math.min(...times) : null;
  }, [pending]);
  const fieldsWaiting = useMemo(
    () => new Set(pending.flatMap((row) => (row.changes || []).map((c) => c.field))).size,
    [pending],
  );

  const formatHours = (hours) => {
    if (hours === null) return '—';
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
    if (hours < 48) return `${hours.toFixed(1)} h`;
    return `${Math.round(hours / 24)} days`;
  };

  const person = (row) => (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-crewly-inset text-xs font-bold text-crewly-dim">
        {initials(row.employeeName)}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-bold">{row.employeeName || 'Employee'}</p>
        <p className="truncate text-[11px] text-crewly-dim">
          {row.employeeCode || 'No employee code'}
          {row.requestedAt ? ` · submitted ${ago(row.requestedAt)}` : ''}
        </p>
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-crewly-inset text-crewly-green">
            <ClipboardCheck className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-crewly-dim">People operations · profile</p>
            <h1 className="text-xl font-bold sm:text-2xl">Profile Change Requests</h1>
            <p className="mt-1 max-w-2xl text-sm text-crewly-dim">
              Employees propose changes to the fields they cannot edit themselves. Approving writes the new
              value to the employee record; rejecting leaves it untouched and tells them why.
            </p>
          </div>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <button
            type="button"
            onClick={reload}
            disabled={loading}
            className="btn-ghost inline-flex flex-1 items-center justify-center gap-2 px-3 py-2 text-sm disabled:opacity-60 sm:flex-none"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── counts ─────────────────────────────────────────────────────── */}
      <div className="card grid grid-cols-2 gap-px overflow-hidden border-crewly-border bg-crewly-border p-0 xl:grid-cols-4">
        <Tile
          icon={Clock}
          label="Pending review"
          value={pending.length}
          sub={
            pending.length
              ? oldestPending
                ? `Oldest raised ${ago(oldestPending)}`
                : 'Waiting on a decision'
              : 'Queue clear'
          }
        />
        <Tile icon={Check} label="Decided" value={decided} sub={decided ? `${approvedCount} approved · ${rejectedCount} rejected` : 'Nothing decided yet'} />
        <Tile
          icon={Loader2}
          label="Typical decision"
          value={formatHours(decisionHours)}
          sub={decisionHours === null ? 'Needs one decided request' : `Average of ${decided} decision${decided === 1 ? '' : 's'}`}
        />
        <Tile icon={ShieldAlert} label="Fields waiting" value={fieldsWaiting} sub={fieldsWaiting ? 'Distinct fields in the queue' : 'No field is blocked'} />
      </div>

      {/* ── tabs + filter ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {[
            ['pending', 'Pending', pending.length],
            ['history', 'Decided', decided],
          ].map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className={`rounded-full px-3.5 py-1.5 text-sm font-semibold transition ${
                tab === key
                  ? 'bg-crewly-selected text-crewly-selected-text'
                  : 'border border-crewly-border text-crewly-dim hover:text-crewly-text'
              }`}
            >
              {label} <span className="opacity-70">{count}</span>
            </button>
          ))}
        </div>
        <div className="relative min-w-0 w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crewly-dim" />
          <input
            className="input pl-9"
            placeholder="Filter by name or code"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter requests"
          />
        </div>
      </div>

      {/* ── queue ──────────────────────────────────────────────────────── */}
      {tab === 'pending' ? (
        <div className="space-y-3">
          {visiblePending.map((row) => (
            <article key={row.id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                {person(row)}
                <div className="flex flex-wrap items-center gap-1.5">
                  {row.changes.map((change) => <FieldChip key={change.field} change={change} />)}
                </div>
              </div>

              {row.reason ? (
                <p className="mt-3 rounded-lg bg-crewly-inset/70 px-3 py-2 text-xs leading-relaxed text-crewly-dim">
                  <span className="font-semibold text-crewly-text">Requester note:</span> “{row.reason}”
                </p>
              ) : null}

              <div className="mt-3">
                <Comparison row={row} />
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] text-crewly-dim">
                  {row.changes.some((c) => c.sensitive)
                    ? 'A sensitive field is in this request — check it against the source document before approving.'
                    : 'Approving writes every proposed value to the employee record in one step.'}
                </p>
                <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                  <button
                    type="button"
                    onClick={() => { setDeciding({ request: row, action: 'reject' }); setNote(''); }}
                    className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-crewly-red/40 px-3 py-2 text-sm font-semibold text-crewly-red transition hover:bg-crewly-red/10 sm:flex-none"
                  >
                    <X className="h-4 w-4" />Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => { setDeciding({ request: row, action: 'approve' }); setNote(''); }}
                    className="btn-primary inline-flex flex-1 items-center justify-center gap-1 px-3 py-2 text-sm sm:flex-none"
                  >
                    <Check className="h-4 w-4" />Approve &amp; update
                  </button>
                </div>
              </div>
            </article>
          ))}
          {visiblePending.length === 0 && !loading ? (
            <div className="card">
              <EmptyState
                illustration="shield"
                title={pending.length ? 'No request matches that filter' : 'Queue is clear'}
                description={
                  pending.length
                    ? 'Clear the filter to see the whole queue.'
                    : 'No profile change is waiting on you. Requests from your team land here with the old and new value side by side.'
                }
                size="sm"
              />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          {visibleHistory.map((row) => (
            <article key={row.id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                {person(row)}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[row.status] || STATUS_STYLE.cancelled}`}>
                    {STATUS_WORD[row.status] || row.status}
                  </span>
                  {row.changes.map((change) => <FieldChip key={change.field} change={change} />)}
                </div>
              </div>
              <div className="mt-3">
                <Comparison row={row} />
              </div>
              <p className="mt-3 text-[11px] text-crewly-dim">
                Decided {pretty(row.reviewedAt)}
                {row.appliedAt ? ` · applied ${pretty(row.appliedAt)}` : ''}
              </p>
              {row.decisionNote ? (
                <p className="mt-1 rounded-lg bg-crewly-inset/70 px-3 py-2 text-xs text-crewly-dim">
                  <span className="font-semibold text-crewly-text">Reviewer note:</span> “{row.decisionNote}”
                </p>
              ) : null}
            </article>
          ))}
          {visibleHistory.length === 0 && !loading ? (
            <div className="card">
              <EmptyState
                illustration="documents"
                title={history.length ? 'No decision matches that filter' : 'Nothing decided yet'}
                description={
                  history.length
                    ? 'Clear the filter to see every decision.'
                    : 'Every accepted or rejected profile change lands here with who decided it, when, and the note they left.'
                }
                size="sm"
              />
            </div>
          ) : null}
        </div>
      )}

      {/* Queue status — the mock's footer bar, carrying only what is true:
          how many are left, how old the oldest is, and a way to re-read the
          queue. There is no "simulate empty state" here; the empty state is
          what you get when the list is empty. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-crewly-border bg-crewly-inset/40 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-crewly-card text-crewly-dim">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              {loading
                ? 'Reading the queue…'
                : pending.length
                  ? `Queue status: ${pending.length} pending review${pending.length === 1 ? '' : 's'} remaining`
                  : 'Queue status: all caught up'}
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-crewly-dim">
              {loading
                ? 'Decisions are recorded the moment they are made.'
                : pending.length
                  ? `Oldest raised ${oldestPending ? ago(oldestPending) : '—'}. Approving writes the approved value, rejecting leaves the record untouched.`
                  : 'Nothing is waiting on you. New proposals from your team land here with the old and new value side by side.'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={reload}
          disabled={loading}
          className="btn-ghost inline-flex items-center gap-2 px-3 py-2 text-sm disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh
        </button>
      </div>

      {deciding ? (
        <Modal
          title={`${deciding.action === 'approve' ? 'Approve' : 'Reject'} — ${deciding.request.employeeName || 'Employee'}`}
          onClose={() => setDeciding(null)}
        >
          <div className="space-y-3">
            <div className="space-y-2 text-sm">
              {deciding.request.changes.map((change) => (
                <div key={change.field} className="flex flex-wrap items-center gap-1.5">
                  <span className="text-crewly-dim">{change.label}:</span>
                  <span className="line-through opacity-70">{change.from || '—'}</span>
                  <ArrowRight className="h-3 w-3 text-crewly-dim" aria-hidden="true" />
                  <span className="font-medium">{change.to || '—'}</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-crewly-dim">
              {deciding.action === 'approve'
                ? 'The new values are written to the employee record and an audit row is created.'
                : 'The profile is not touched. The employee sees your note.'}
            </p>
            <div>
              <label className="label" htmlFor="decision-note">
                {deciding.action === 'approve' ? 'Note (optional)' : 'Reason (required)'}
              </label>
              <textarea
                id="decision-note"
                className="input"
                rows={2}
                maxLength={300}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={
                  deciding.action === 'approve'
                    ? 'e.g. Verified against the promotion letter'
                    : 'e.g. Please attach the name-change affidavit'
                }
              />
            </div>
            <button
              type="button"
              onClick={submitDecision}
              disabled={saving || (deciding.action === 'reject' && note.trim().length === 0)}
              className={`w-full ${deciding.action === 'approve'
                ? 'btn-primary'
                : 'inline-flex items-center justify-center rounded-lg bg-crewly-red px-5 py-2.5 font-semibold text-slate-50 hover:opacity-90 disabled:opacity-50'}`}
            >
              {saving ? 'Saving…' : `Confirm ${deciding.action === 'approve' ? 'Approval' : 'Rejection'}`}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
};

export default ProfileChangeRequestsPage;
