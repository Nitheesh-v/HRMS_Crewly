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
// ============================================================
import { useCallback, useEffect, useState } from 'react';
import { Check, ClipboardCheck, Loader2, RefreshCw, X } from 'lucide-react';
import profileService from '../../services/profileService';
import Modal from '../../components/Modal.jsx';
import { notify } from '../../utils/notify.js';

const STATUS_STYLE = {
  pending: 'bg-amber-400/15 text-amber-200',
  approved: 'bg-crewly-green/15 text-crewly-green',
  rejected: 'bg-crewly-red/15 text-crewly-red',
  cancelled: 'bg-white/10 text-crewly-dim',
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

const ProfileChangeRequestsPage = () => {
  const [tab, setTab] = useState('pending');
  const [pending, setPending] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
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

  const renderPerson = (row) => (
    <div className="min-w-0">
      <p className="truncate font-medium">{row.employeeName || 'Employee'}</p>
      <p className="text-xs text-crewly-dim">{row.employeeCode || '—'}</p>
    </div>
  );

  const renderChanges = (row) => (
    <dl className="space-y-1 text-sm">
      {row.changes.map((change) => (
        <div key={change.field} className="flex flex-wrap items-center gap-1.5">
          <dt className="text-crewly-dim">{change.label}:</dt>
          <dd className="line-through opacity-70">{change.from || '—'}</dd>
          <dd aria-hidden="true">→</dd>
          <dd className="font-medium">{change.to || '—'}</dd>
        </div>
      ))}
    </dl>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ClipboardCheck className="h-6 w-6 text-crewly-green" />Profile Change Requests
        </h1>
        <button
          type="button"
          onClick={reload}
          disabled={loading}
          className="btn-ghost inline-flex items-center gap-2 px-3 py-2 text-sm"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh
        </button>
      </div>

      <p className="text-sm text-crewly-dim">
        Employees propose changes to fields they cannot edit directly. Approving applies the value to
        the employee record; rejecting leaves it untouched and tells the employee why.
      </p>

      <div className="flex gap-2">
        {[['pending', `Pending (${pending.length})`], ['history', 'Decided']].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-lg px-4 py-2 text-sm transition ${
              tab === key
                ? 'bg-crewly-green/15 text-crewly-green'
                : 'border border-crewly-border text-crewly-dim hover:text-crewly-text'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'pending' && (
        <div className="space-y-3">
          {pending.map((row) => (
            <div key={row.id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                {renderPerson(row)}
                <span className="text-[11px] text-crewly-dim">Requested {pretty(row.requestedAt)}</span>
              </div>

              <div className="mt-3">{renderChanges(row)}</div>

              {row.reason && <p className="mt-2 text-xs text-crewly-dim">Employee note: {row.reason}</p>}

              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => { setDeciding({ request: row, action: 'approve' }); setNote(''); }}
                  className="inline-flex items-center gap-1 rounded-lg bg-crewly-green/15 px-4 py-2 text-sm text-crewly-green transition hover:bg-crewly-green/25"
                >
                  <Check className="h-4 w-4" />Approve
                </button>
                <button
                  type="button"
                  onClick={() => { setDeciding({ request: row, action: 'reject' }); setNote(''); }}
                  className="inline-flex items-center gap-1 rounded-lg border border-crewly-red/40 px-4 py-2 text-sm text-crewly-red transition hover:bg-crewly-red/10"
                >
                  <X className="h-4 w-4" />Reject
                </button>
              </div>
            </div>
          ))}
          {pending.length === 0 && !loading && (
            <div className="card py-10 text-center text-crewly-dim">
              No pending requests — the queue is clear.
            </div>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="space-y-3">
          {history.map((row) => (
            <div key={row.id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                {renderPerson(row)}
                <span className={`badge ${STATUS_STYLE[row.status] || STATUS_STYLE.cancelled}`}>{row.status}</span>
              </div>
              <div className="mt-3">{renderChanges(row)}</div>
              <p className="mt-2 text-xs text-crewly-dim">
                Decided {pretty(row.reviewedAt)}
                {row.appliedAt ? ` · applied ${pretty(row.appliedAt)}` : ''}
              </p>
              {row.decisionNote && <p className="mt-1 text-xs text-crewly-dim">Note: {row.decisionNote}</p>}
            </div>
          ))}
          {history.length === 0 && !loading && (
            <div className="card py-10 text-center text-crewly-dim">Nothing decided yet.</div>
          )}
        </div>
      )}

      {deciding && (
        <Modal
          title={`${deciding.action === 'approve' ? 'Approve' : 'Reject'} — ${deciding.request.employeeName || 'Employee'}`}
          onClose={() => setDeciding(null)}
        >
          <div className="space-y-3">
            {renderChanges(deciding.request)}
            <p className="text-xs text-crewly-dim">
              {deciding.action === 'approve'
                ? 'The new values are written to the employee record and an audit row is created.'
                : 'The profile is not touched. The employee sees your note.'}
            </p>
            <div>
              <label className="label">
                {deciding.action === 'approve' ? 'Note (optional)' : 'Reason (required)'}
              </label>
              <textarea
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
                : 'inline-flex items-center justify-center rounded-lg bg-crewly-red px-5 py-2.5 font-semibold text-white hover:opacity-90 disabled:opacity-50'}`}
            >
              {saving ? 'Saving…' : `Confirm ${deciding.action === 'approve' ? 'Approval' : 'Rejection'}`}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default ProfileChangeRequestsPage;
