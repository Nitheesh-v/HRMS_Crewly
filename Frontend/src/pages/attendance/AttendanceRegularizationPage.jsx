import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeftRight,
  CheckCircle2,
  ClipboardList,
  FileText,
  History,
  Inbox,
  Plus,
  XCircle,
} from 'lucide-react';
import usePermission from '../../hooks/usePermission.js';
import attendanceRegularizationService from '../../services/attendanceRegularizationService.js';

// Phase 31.5 — Attendance Regularization & Exception Center (one
// surface, two permission-gated tabs). CORRECTION requests fix
// effective facts through an approval overlay; EXPLANATION requests
// resolve exceptions with words. Recorded punches are never edited.

const TYPE_META = {
  MISSED_CLOCK_IN: { label: 'Missed clock-in', kind: 'CORRECTION', needs: 'in' },
  MISSED_CLOCK_OUT: { label: 'Missed clock-out', kind: 'CORRECTION', needs: 'out' },
  CLOCK_IN_TIME_CORRECTION: { label: 'Clock-in time correction', kind: 'CORRECTION', needs: 'in' },
  CLOCK_OUT_TIME_CORRECTION: { label: 'Clock-out time correction', kind: 'CORRECTION', needs: 'out' },
  BREAK_CORRECTION: { label: 'Break correction', kind: 'CORRECTION', needs: 'breaks' },
  WORK_MODE_CORRECTION: { label: 'Work-mode correction', kind: 'CORRECTION', needs: 'mode' },
  LATE_EXPLANATION: { label: 'Late-arrival explanation', kind: 'EXPLANATION', needs: null },
  EARLY_EXIT_EXPLANATION: { label: 'Early-exit explanation', kind: 'EXPLANATION', needs: null },
  SHORT_HOURS_EXPLANATION: { label: 'Short-hours explanation', kind: 'EXPLANATION', needs: null },
  GEOFENCE_EXPLANATION: { label: 'Location explanation', kind: 'EXPLANATION', needs: null },
};

const CORRECTION_TYPES = Object.keys(TYPE_META).filter((type) => TYPE_META[type].kind === 'CORRECTION');
const EXPLANATION_TYPES = Object.keys(TYPE_META).filter((type) => TYPE_META[type].kind === 'EXPLANATION');

const WORK_MODES = ['OFFICE', 'WFH', 'FIELD', 'CLIENT_SITE', 'BUSINESS_TRAVEL'];

const STATUS_STYLE = {
  PENDING: 'bg-crewly-orange/15 text-crewly-orange',
  APPROVED: 'bg-crewly-green/15 text-crewly-green',
  REJECTED: 'bg-crewly-red/15 text-crewly-red',
  CANCELLED: 'bg-crewly-dim/15 text-crewly-dim',
};

const KIND_STYLE = {
  CORRECTION: 'bg-crewly-green/15 text-crewly-green',
  EXPLANATION: 'bg-crewly-orange/15 text-crewly-orange',
};

const todayStr = () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

const fmtTime = (value) => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const toISO = (local) => {
  if (!local) return null;
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const proposalSummary = (row) => {
  const proposal = row.proposal || {};
  const parts = [];
  if (proposal.correctedIn) parts.push(`In → ${fmtTime(proposal.correctedIn)}`);
  if (proposal.correctedOut) parts.push(`Out → ${fmtTime(proposal.correctedOut)}`);
  if (Array.isArray(proposal.breaks) && proposal.breaks.length > 0) {
    parts.push(`Breaks: ${proposal.breaks.map((entry) => `${fmtTime(entry.start)}–${fmtTime(entry.end)}`).join(', ')}`);
  }
  if (proposal.workMode) parts.push(`Mode → ${proposal.workMode}`);
  return parts.length > 0 ? parts.join(' · ') : 'Words only — no time changes';
};

const recordedSummary = (row) => {
  const snapshot = row.originalSnapshot || {};
  const parts = [];
  parts.push(`In: ${fmtTime(snapshot.firstIn)}`);
  parts.push(`Out: ${fmtTime(snapshot.lastOut)}`);
  if (snapshot.workMode) parts.push(`Mode: ${snapshot.workMode}`);
  if (snapshot.status) parts.push(snapshot.status);
  return parts.join(' · ');
};

const AttendanceRegularizationPage = () => {
  const { hasPermission, loading: permissionsLoading } = usePermission();
  const canRequest = hasPermission('ATTENDANCE_REGULARIZATION_REQUEST');
  const canReview = hasPermission('ATTENDANCE_REGULARIZATION_REVIEW');
  const [searchParams] = useSearchParams();
  const deepDate = searchParams.get('date');

  const [tab, setTab] = useState('mine');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [requests, setRequests] = useState([]);
  const [pending, setPending] = useState([]);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({
    type: 'MISSED_CLOCK_OUT',
    attendanceDate: todayStr(),
    reason: '',
    correctedIn: '',
    correctedOut: '',
    breaks: [{ start: '', end: '' }],
    workMode: 'WFH',
  });
  const [rejectFor, setRejectFor] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  const needs = TYPE_META[form.type]?.needs || null;

  const loadMine = useCallback(async () => {
    if (!canRequest) return;
    const result = await attendanceRegularizationService.mine();
    const rows = result?.data;
    setRequests(Array.isArray(rows) ? rows : []);
  }, [canRequest]);

  const loadPending = useCallback(async () => {
    if (!canReview) return;
    const result = await attendanceRegularizationService.pending();
    const rows = result?.data;
    setPending(Array.isArray(rows) ? rows : []);
  }, [canReview]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await Promise.all([loadMine(), loadPending()]);
    } catch (loadError) {
      setError(loadError?.message || 'Could not load regularization requests');
    } finally {
      setLoading(false);
    }
  }, [loadMine, loadPending]);

  useEffect(() => {
    if (!permissionsLoading) {
      if (!canRequest && canReview) setTab('pending');
      load();
    }
  }, [permissionsLoading, canRequest, canReview, load]);

  // Deep link from the attendance history: preset the day and open
  // the form so the correction starts where the employee saw it.
  useEffect(() => {
    if (deepDate && /^\d{4}-\d{2}-\d{2}$/.test(deepDate)) {
      setForm((previous) => ({ ...previous, attendanceDate: deepDate }));
      setFormOpen(true);
      setTab('mine');
    }
  }, [deepDate]);

  const approvalNote = useMemo(() => {
    if (form.type === 'WORK_MODE_CORRECTION' && form.workMode !== 'OFFICE') {
      return 'Non-office modes need a covering approved work-mode request — otherwise only HR/Admin can approve.';
    }
    if (needs === null) {
      return 'Explanations resolve the exception with words; recorded times stay exactly as punched.';
    }
    return 'Approvals write a correction overlay — recorded punches stay untouched and stay visible.';
  }, [form.type, form.workMode, needs]);

  const submit = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const proposal = {};
      if (needs === 'in') proposal.correctedIn = toISO(form.correctedIn);
      if (needs === 'out') proposal.correctedOut = toISO(form.correctedOut);
      if (needs === 'breaks') {
        proposal.breaks = form.breaks
          .filter((entry) => entry.start && entry.end)
          .map((entry) => ({ start: toISO(entry.start), end: toISO(entry.end) }));
      }
      if (needs === 'mode') proposal.workMode = form.workMode;
      await attendanceRegularizationService.submit({
        type: form.type,
        attendanceDate: form.attendanceDate,
        reason: form.reason.trim(),
        ...(needs ? { proposal } : {}),
      });
      setMessage('Request submitted for review');
      setForm({
        type: 'MISSED_CLOCK_OUT', attendanceDate: todayStr(), reason: '',
        correctedIn: '', correctedOut: '', breaks: [{ start: '', end: '' }], workMode: 'WFH',
      });
      setFormOpen(false);
      await loadMine();
    } catch (submitError) {
      setError(submitError?.message || 'Could not submit the request');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await attendanceRegularizationService.cancel(id);
      setMessage('Request cancelled');
      await Promise.all([loadMine(), loadPending()]);
    } catch (cancelError) {
      setError(cancelError?.message || 'Could not cancel the request');
    } finally {
      setBusy(false);
    }
  };

  const approve = async (id) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await attendanceRegularizationService.approve(id);
      setMessage('Request approved — the day was rebuilt from the correction');
      await Promise.all([loadMine(), loadPending()]);
    } catch (approveError) {
      setError(approveError?.message || 'Could not approve the request');
    } finally {
      setBusy(false);
    }
  };

  const reject = async (id) => {
    if (!rejectReason.trim()) {
      setError('A rejection reason is required');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await attendanceRegularizationService.reject(id, rejectReason.trim());
      setMessage('Request rejected');
      setRejectFor(null);
      setRejectReason('');
      await Promise.all([loadMine(), loadPending()]);
    } catch (rejectError) {
      setError(rejectError?.message || 'Could not reject the request');
    } finally {
      setBusy(false);
    }
  };

  if (permissionsLoading || loading) {
    return <p className="text-crewly-dim">Loading regularization requests…</p>;
  }

  if (!canRequest && !canReview) {
    return (
      <div className="card p-6">
        <h1 className="text-xl font-bold">Attendance Regularization</h1>
        <p className="mt-2 text-crewly-dim">
          You do not have permission to request or review attendance corrections.
        </p>
      </div>
    );
  }

  const renderCard = (row, { reviewer = false } = {}) => (
    <article key={row.id} className="rounded-lg border border-crewly-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${STATUS_STYLE[row.status] || ''}`}>
          {row.status}
        </span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${KIND_STYLE[row.kind] || ''}`}>
          {row.kind}
        </span>
        {row.authorizationOverride && (
          <span className="rounded-full bg-crewly-orange/15 px-2.5 py-0.5 text-xs font-bold text-crewly-orange">
            HR override
          </span>
        )}
        <span className="text-sm font-semibold">{row.typeLabel || row.type}</span>
        <span className="text-sm text-crewly-dim">{row.attendanceDate}</span>
      </div>

      {reviewer && row.employee && (
        <p className="mt-2 text-sm">
          <span className="font-semibold">{row.employee.name}</span>
          {row.employee.designation && <span className="text-crewly-dim"> · {row.employee.designation}</span>}
        </p>
      )}
      <p className="mt-2 text-sm">{row.reason}</p>

      <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
        <p className="rounded bg-crewly-dim/10 px-2 py-1.5">
          <span className="font-bold uppercase tracking-wide text-crewly-dim">Recorded </span>
          {recordedSummary(row)}
        </p>
        <p className="rounded bg-crewly-green/10 px-2 py-1.5">
          <span className="font-bold uppercase tracking-wide text-crewly-dim">Proposed </span>
          {proposalSummary(row)}
        </p>
      </div>

      {row.reviewReason && (
        <p className="mt-2 text-xs text-crewly-dim">
          Review note{row.approver?.name ? ` by ${row.approver.name}` : ''}: {row.reviewReason}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {reviewer && row.status === 'PENDING' && (
          <>
            <button type="button" className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm" disabled={busy} onClick={() => approve(row.id)}>
              <CheckCircle2 className="h-4 w-4" /> Approve
            </button>
            {rejectFor === row.id ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <input
                  className="input w-56"
                  placeholder="Rejection reason (required)"
                  value={rejectReason}
                  disabled={busy}
                  onChange={(event) => setRejectReason(event.target.value)}
                />
                <button type="button" className="btn-ghost px-3 py-1.5 text-sm" disabled={busy} onClick={() => reject(row.id)}>
                  Confirm
                </button>
                <button type="button" className="btn-ghost px-3 py-1.5 text-sm" disabled={busy} onClick={() => { setRejectFor(null); setRejectReason(''); }}>
                  Back
                </button>
              </span>
            ) : (
              <button type="button" className="btn-ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-sm" disabled={busy} onClick={() => setRejectFor(row.id)}>
                <XCircle className="h-4 w-4" /> Reject
              </button>
            )}
          </>
        )}
        {!reviewer && row.canCancel && (
          <button type="button" className="btn-ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-sm" disabled={busy} onClick={() => cancel(row.id)}>
            <XCircle className="h-4 w-4" /> Cancel request
          </button>
        )}
      </div>
    </article>
  );

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-crewly-dim">Time &amp; Leave</p>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ArrowLeftRight className="h-6 w-6 text-crewly-green" /> Attendance Regularization
        </h1>
        <p className="mt-1 text-sm text-crewly-dim">
          Fix missed or wrong punches, or explain exceptions. Recorded punches are never
          edited — approvals overlay the correction beside the original.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-4 py-3 text-sm text-crewly-green">
          {message}
        </div>
      )}

      <div className="flex gap-2">
        {canRequest && (
          <button
            type="button"
            className={tab === 'mine' ? 'btn-primary px-4 py-2' : 'btn-ghost px-4 py-2'}
            onClick={() => setTab('mine')}
          >
            <span className="inline-flex items-center gap-2">
              <FileText className="h-4 w-4" /> My requests
            </span>
          </button>
        )}
        {canReview && (
          <button
            type="button"
            className={tab === 'pending' ? 'btn-primary px-4 py-2' : 'btn-ghost px-4 py-2'}
            onClick={() => setTab('pending')}
          >
            <span className="inline-flex items-center gap-2">
              <Inbox className="h-4 w-4" /> Exception center
              {pending.length > 0 && <span className="badge">{pending.length}</span>}
            </span>
          </button>
        )}
      </div>

      {tab === 'mine' && canRequest && (
        <section className="card space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-crewly-dim">
              <History className="h-4 w-4" /> My correction &amp; explanation requests
            </h2>
            <button
              type="button"
              className="btn-primary inline-flex items-center gap-2 px-4 py-2"
              disabled={busy}
              onClick={() => setFormOpen((open) => !open)}
            >
              <Plus className="h-4 w-4" /> New request
            </button>
          </div>

          {formOpen && (
            <div className="grid max-w-2xl grid-cols-1 gap-3 rounded-lg border border-crewly-border p-4 sm:grid-cols-2">
              <div>
                <label className="label">Request type</label>
                <select
                  className="input w-full"
                  value={form.type}
                  disabled={busy}
                  onChange={(event) => setForm((previous) => ({ ...previous, type: event.target.value }))}
                >
                  <optgroup label="Corrections">
                    {CORRECTION_TYPES.map((type) => (
                      <option key={type} value={type}>{TYPE_META[type].label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Explanations">
                    {EXPLANATION_TYPES.map((type) => (
                      <option key={type} value={type}>{TYPE_META[type].label}</option>
                    ))}
                  </optgroup>
                </select>
              </div>
              <div>
                <label className="label">Attendance day</label>
                <input
                  className="input w-full"
                  type="date"
                  max={todayStr()}
                  value={form.attendanceDate}
                  disabled={busy}
                  onChange={(event) => setForm((previous) => ({ ...previous, attendanceDate: event.target.value }))}
                />
              </div>

              {needs === 'in' && (
                <div className="sm:col-span-2">
                  <label className="label">Corrected clock-in</label>
                  <input
                    className="input w-full"
                    type="datetime-local"
                    disabled={busy}
                    value={form.correctedIn}
                    onChange={(event) => setForm((previous) => ({ ...previous, correctedIn: event.target.value }))}
                  />
                </div>
              )}
              {needs === 'out' && (
                <div className="sm:col-span-2">
                  <label className="label">Corrected clock-out</label>
                  <input
                    className="input w-full"
                    type="datetime-local"
                    disabled={busy}
                    value={form.correctedOut}
                    onChange={(event) => setForm((previous) => ({ ...previous, correctedOut: event.target.value }))}
                  />
                </div>
              )}
              {needs === 'breaks' && (
                <div className="sm:col-span-2 space-y-2">
                  <label className="label">Effective breaks (the full list, not just the fix)</label>
                  {form.breaks.map((entry, index) => (
                    <div key={index} className="flex flex-wrap items-center gap-2">
                      <input
                        className="input flex-1"
                        type="datetime-local"
                        aria-label={`Break ${index + 1} start`}
                        disabled={busy}
                        value={entry.start}
                        onChange={(event) => setForm((previous) => {
                          const breaks = previous.breaks.map((item, position) => (position === index ? { ...item, start: event.target.value } : item));
                          return { ...previous, breaks };
                        })}
                      />
                      <span className="text-crewly-dim">→</span>
                      <input
                        className="input flex-1"
                        type="datetime-local"
                        aria-label={`Break ${index + 1} end`}
                        disabled={busy}
                        value={entry.end}
                        onChange={(event) => setForm((previous) => {
                          const breaks = previous.breaks.map((item, position) => (position === index ? { ...item, end: event.target.value } : item));
                          return { ...previous, breaks };
                        })}
                      />
                      {form.breaks.length > 1 && (
                        <button
                          type="button"
                          className="btn-ghost px-2 py-1 text-sm"
                          disabled={busy}
                          onClick={() => setForm((previous) => ({ ...previous, breaks: previous.breaks.filter((_, position) => position !== index) }))}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn-ghost px-3 py-1.5 text-sm"
                    disabled={busy}
                    onClick={() => setForm((previous) => ({ ...previous, breaks: [...previous.breaks, { start: '', end: '' }] }))}
                  >
                    + Add break
                  </button>
                </div>
              )}
              {needs === 'mode' && (
                <div className="sm:col-span-2">
                  <label className="label">Effective work mode</label>
                  <select
                    className="input w-full"
                    value={form.workMode}
                    disabled={busy}
                    onChange={(event) => setForm((previous) => ({ ...previous, workMode: event.target.value }))}
                  >
                    {WORK_MODES.map((mode) => (
                      <option key={mode} value={mode}>{mode}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="sm:col-span-2">
                <label className="label">Reason</label>
                <textarea
                  className="input w-full"
                  rows={3}
                  maxLength={300}
                  placeholder="What happened? (required)"
                  disabled={busy}
                  value={form.reason}
                  onChange={(event) => setForm((previous) => ({ ...previous, reason: event.target.value }))}
                />
              </div>

              <p className="text-xs text-crewly-dim sm:col-span-2">{approvalNote}</p>

              <div className="sm:col-span-2">
                <button type="button" className="btn-primary px-4 py-2" disabled={busy || !form.reason.trim()} onClick={submit}>
                  Submit request
                </button>
              </div>
            </div>
          )}

          {requests.length === 0 ? (
            <p className="text-sm text-crewly-dim">
              No requests yet. Wrong punch yesterday? File a correction before the policy window closes.
            </p>
          ) : (
            <div className="space-y-3">{requests.map((row) => renderCard(row))}</div>
          )}
        </section>
      )}

      {tab === 'pending' && canReview && (
        <section className="card space-y-4 p-5">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-crewly-dim">
            <ClipboardList className="h-4 w-4" /> Team exceptions awaiting review
          </h2>
          {pending.length === 0 ? (
            <p className="text-sm text-crewly-dim">The queue is clear — nothing waiting on your team.</p>
          ) : (
            <div className="space-y-3">{pending.map((row) => renderCard(row, { reviewer: true }))}</div>
          )}
        </section>
      )}

      <p className="text-xs text-crewly-dim">
        See also: <Link className="underline" to="/app/attendance">Today &amp; history</Link>
        {' · '}
        <Link className="underline" to="/app/attendance/report">Attendance report</Link>
      </p>
    </div>
  );
};

export default AttendanceRegularizationPage;
