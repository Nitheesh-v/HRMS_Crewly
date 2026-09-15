import { useCallback, useEffect, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  ClipboardList,
  Home,
  Inbox,
  MapPin,
  Plane,
  Plus,
  XCircle,
} from 'lucide-react';
import usePermission from '../../hooks/usePermission.js';
import attendanceWorkModeService from '../../services/attendanceWorkModeService.js';

// Phase 31.4 — Work Mode Requests (one surface, two permission-gated
// tabs). Requests authorize a later CLOCK_IN under a non-office mode;
// they never create attendance or mark anyone Present.

const MODE_META = {
  WFH: { label: 'Work From Home', icon: Home, placeHint: 'Optional note (no home address)' },
  FIELD: { label: 'Field Work', icon: MapPin, placeHint: 'Site / purpose (optional)' },
  CLIENT_SITE: { label: 'Client Site', icon: Building2, placeHint: 'Client / site name (optional)' },
  BUSINESS_TRAVEL: { label: 'Business Travel', icon: Plane, placeHint: 'Destination (optional)' },
};

const PORTION_LABEL = {
  FULL_DAY: 'Full day',
  FIRST_HALF: 'First half',
  SECOND_HALF: 'Second half',
};

const STATUS_STYLE = {
  PENDING: 'bg-crewly-orange/15 text-crewly-orange',
  APPROVED: 'bg-crewly-green/15 text-crewly-green',
  REJECTED: 'bg-crewly-red/15 text-crewly-red',
  CANCELLED: 'bg-crewly-dim/15 text-crewly-dim',
};

const todayStr = () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

const rangeLabel = (row) =>
  row.startDate === row.endDate ? row.startDate : `${row.startDate} → ${row.endDate}`;

const ModeIcon = ({ mode, className = 'h-4 w-4' }) => {
  const Icon = MODE_META[mode]?.icon || ClipboardList;
  return <Icon className={className} />;
};

const AttendanceWorkModePage = () => {
  const { hasPermission, loading: permissionsLoading } = usePermission();
  const canRequest = hasPermission('ATTENDANCE_WORK_MODE_REQUEST');
  const canReview = hasPermission('ATTENDANCE_WORK_MODE_REVIEW');

  const [tab, setTab] = useState('mine');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [requests, setRequests] = useState([]);
  const [requestableModes, setRequestableModes] = useState([]);
  const [pending, setPending] = useState([]);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({
    mode: '',
    startDate: todayStr(),
    endDate: '',
    dayPortion: 'FULL_DAY',
    reason: '',
    placeLabel: '',
  });
  const [rejectFor, setRejectFor] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  const loadMine = useCallback(async () => {
    if (!canRequest) return;
    const result = await attendanceWorkModeService.mine();
    const data = result?.data || {};
    setRequests(Array.isArray(data.requests) ? data.requests : []);
    setRequestableModes(Array.isArray(data.requestableModes) ? data.requestableModes : []);
  }, [canRequest]);

  const loadPending = useCallback(async () => {
    if (!canReview) return;
    const result = await attendanceWorkModeService.pending();
    const rows = result?.data;
    setPending(Array.isArray(rows) ? rows : []);
  }, [canReview]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await Promise.all([loadMine(), loadPending()]);
    } catch (loadError) {
      setError(loadError?.message || 'Could not load work-mode requests');
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

  useEffect(() => {
    if (!form.mode && requestableModes.length > 0) {
      setForm((previous) => ({ ...previous, mode: requestableModes[0] }));
    }
  }, [form.mode, requestableModes]);

  const isRanged = form.endDate && form.endDate !== form.startDate;

  const submit = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await attendanceWorkModeService.submit({
        mode: form.mode,
        startDate: form.startDate,
        ...(form.endDate ? { endDate: form.endDate } : {}),
        dayPortion: isRanged ? 'FULL_DAY' : form.dayPortion,
        reason: form.reason.trim(),
        ...(form.placeLabel.trim() ? { placeLabel: form.placeLabel.trim() } : {}),
      });
      setMessage('Request submitted for review');
      setForm({ mode: requestableModes[0] || '', startDate: todayStr(), endDate: '', dayPortion: 'FULL_DAY', reason: '', placeLabel: '' });
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
      await attendanceWorkModeService.cancel(id);
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
      await attendanceWorkModeService.approve(id);
      setMessage('Request approved');
      await loadPending();
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
      await attendanceWorkModeService.reject(id, rejectReason.trim());
      setMessage('Request rejected');
      setRejectFor(null);
      setRejectReason('');
      await loadPending();
    } catch (rejectError) {
      setError(rejectError?.message || 'Could not reject the request');
    } finally {
      setBusy(false);
    }
  };

  if (permissionsLoading || loading) {
    return <p className="text-crewly-dim">Loading work-mode requests…</p>;
  }

  if (!canRequest && !canReview) {
    return (
      <div className="card p-6">
        <h1 className="text-xl font-bold">Work Mode Requests</h1>
        <p className="mt-2 text-crewly-dim">
          You do not have permission to request or review non-office work.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-crewly-dim">Time &amp; Leave</p>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ClipboardList className="h-6 w-6 text-crewly-green" /> Work Mode Requests
        </h1>
        <p className="mt-1 text-sm text-crewly-dim">
          Authorizations for WFH, field, client-site and travel days. An approval
          permits a later Clock In — it never marks attendance by itself.
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
            My requests
          </button>
        )}
        {canReview && (
          <button
            type="button"
            className={tab === 'pending' ? 'btn-primary px-4 py-2' : 'btn-ghost px-4 py-2'}
            onClick={() => setTab('pending')}
          >
            <span className="inline-flex items-center gap-2">
              <Inbox className="h-4 w-4" /> Pending approvals
              {pending.length > 0 && <span className="badge">{pending.length}</span>}
            </span>
          </button>
        )}
      </div>

      {tab === 'mine' && canRequest && (
        <section className="card space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold uppercase tracking-wide text-crewly-dim">
              Current &amp; upcoming requests
            </h2>
            <button
              type="button"
              className="btn-primary inline-flex items-center gap-2 px-4 py-2"
              disabled={busy || requestableModes.length === 0}
              onClick={() => setFormOpen((open) => !open)}
            >
              <Plus className="h-4 w-4" /> New request
            </button>
          </div>

          {requestableModes.length === 0 && (
            <p className="text-sm text-crewly-orange">
              No non-office modes are enabled by your company policy — contact your administrator.
            </p>
          )}

          {formOpen && requestableModes.length > 0 && (
            <div className="grid max-w-2xl grid-cols-1 gap-3 rounded-lg border border-crewly-border p-4 sm:grid-cols-2">
              <div>
                <label className="label">Work mode</label>
                <select
                  className="input w-full"
                  value={form.mode}
                  disabled={busy}
                  onChange={(event) => setForm((previous) => ({ ...previous, mode: event.target.value }))}
                >
                  {requestableModes.map((mode) => (
                    <option key={mode} value={mode}>{MODE_META[mode]?.label || mode}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Day portion</label>
                <select
                  className="input w-full"
                  value={isRanged ? 'FULL_DAY' : form.dayPortion}
                  disabled={busy || Boolean(isRanged)}
                  onChange={(event) => setForm((previous) => ({ ...previous, dayPortion: event.target.value }))}
                >
                  <option value="FULL_DAY">Full day</option>
                  <option value="FIRST_HALF">First half</option>
                  <option value="SECOND_HALF">Second half</option>
                </select>
                {isRanged && <p className="mt-1 text-xs text-crewly-dim">Ranges always cover full days.</p>}
              </div>
              <div>
                <label className="label">Start date</label>
                <input
                  className="input w-full"
                  type="date"
                  min={todayStr()}
                  value={form.startDate}
                  disabled={busy}
                  onChange={(event) => setForm((previous) => ({ ...previous, startDate: event.target.value }))}
                />
              </div>
              <div>
                <label className="label">End date (optional)</label>
                <input
                  className="input w-full"
                  type="date"
                  min={form.startDate}
                  value={form.endDate}
                  disabled={busy}
                  onChange={(event) => setForm((previous) => ({ ...previous, endDate: event.target.value }))}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="label">Reason</label>
                <textarea
                  className="input w-full"
                  rows={2}
                  maxLength={300}
                  value={form.reason}
                  disabled={busy}
                  onChange={(event) => setForm((previous) => ({ ...previous, reason: event.target.value }))}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="label">{MODE_META[form.mode]?.placeHint || 'Note (optional)'}</label>
                <input
                  className="input w-full"
                  maxLength={120}
                  value={form.placeLabel}
                  disabled={busy}
                  onChange={(event) => setForm((previous) => ({ ...previous, placeLabel: event.target.value }))}
                />
              </div>
              <div>
                <button type="button" className="btn-primary px-4 py-2" disabled={busy} onClick={submit}>
                  {busy ? 'Submitting…' : 'Submit request'}
                </button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            {requests.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-crewly-border px-3 py-2 text-sm"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <ModeIcon mode={row.mode} />
                  <strong>{row.modeLabel || row.mode}</strong>
                  <span className="text-crewly-dim">{rangeLabel(row)} · {PORTION_LABEL[row.dayPortion] || row.dayPortion}</span>
                  <span className={`badge ${STATUS_STYLE[row.status] || ''}`}>{row.status}</span>
                </span>
                {row.canCancel && (
                  <button type="button" className="btn-ghost px-3 py-1 text-sm" disabled={busy} onClick={() => cancel(row.id)}>
                    Cancel
                  </button>
                )}
              </div>
            ))}
            {requests.length === 0 && <p className="text-sm text-crewly-dim">No requests yet.</p>}
          </div>

          {requests.some((row) => row.status === 'REJECTED' && row.reviewReason) && (
            <div className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wide text-crewly-dim">Latest rejections</h3>
              {requests
                .filter((row) => row.status === 'REJECTED' && row.reviewReason)
                .slice(0, 3)
                .map((row) => (
                  <p key={row.id} className="text-sm text-crewly-dim">
                    {row.modeLabel || row.mode} · {rangeLabel(row)} — “{row.reviewReason}”
                  </p>
                ))}
            </div>
          )}
        </section>
      )}

      {tab === 'pending' && canReview && (
        <section className="card space-y-3 p-5">
          <h2 className="text-sm font-bold uppercase tracking-wide text-crewly-dim">
            Pending approvals — your team only
          </h2>
          {pending.map((row) => (
            <div key={row.id} className="space-y-2 rounded-lg border border-crewly-border px-3 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <ModeIcon mode={row.mode} />
                <strong>{row.employee?.name || 'Employee'}</strong>
                {row.employee?.designation && <span className="text-crewly-dim">· {row.employee.designation}</span>}
                <span className="text-crewly-dim">· {row.modeLabel || row.mode}</span>
                <span className="text-crewly-dim">· {rangeLabel(row)} · {PORTION_LABEL[row.dayPortion] || row.dayPortion}</span>
              </div>
              <p className="text-crewly-dim">“{row.reason}”{row.placeLabel ? ` · ${row.placeLabel}` : ''}</p>
              {rejectFor === row.id ? (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className="input min-w-0 flex-1"
                    placeholder="Rejection reason (required)"
                    maxLength={300}
                    value={rejectReason}
                    disabled={busy}
                    onChange={(event) => setRejectReason(event.target.value)}
                  />
                  <button type="button" className="btn-primary px-3 py-1 text-sm" disabled={busy} onClick={() => reject(row.id)}>
                    Confirm reject
                  </button>
                  <button type="button" className="btn-ghost px-3 py-1 text-sm" disabled={busy} onClick={() => { setRejectFor(null); setRejectReason(''); }}>
                    Back
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-primary inline-flex items-center gap-1 px-3 py-1 text-sm" disabled={busy} onClick={() => approve(row.id)}>
                    <CheckCircle2 className="h-4 w-4" /> Approve
                  </button>
                  <button type="button" className="btn-ghost inline-flex items-center gap-1 px-3 py-1 text-sm" disabled={busy} onClick={() => { setRejectFor(row.id); setRejectReason(''); }}>
                    <XCircle className="h-4 w-4" /> Reject
                  </button>
                </div>
              )}
            </div>
          ))}
          {pending.length === 0 && <p className="text-sm text-crewly-dim">Nothing waiting for review.</p>}
        </section>
      )}
    </div>
  );
};

export default AttendanceWorkModePage;
