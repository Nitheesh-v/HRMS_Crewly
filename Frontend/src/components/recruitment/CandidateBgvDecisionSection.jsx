import { useState } from 'react';
import { ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import Modal from '../Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import bgvService from '../../services/bgvService.js';

// Phase 30.1 — OPTIONAL BGV DECISION.
// Rendered on the candidate detail page. Shows either the persisted decision
// (survives refresh — MongoDB is the source of truth) or the two explicit HR
// choices, available only after the human final selection and only for users
// holding BACKGROUND_VERIFICATION_MANAGE.
const CandidateBgvDecisionSection = ({ candidateRef, summary, onDecided, onSync }) => {
  const { hasPermission } = usePermission();
  const canManage = hasPermission('BACKGROUND_VERIFICATION_MANAGE');
  const [waiverOpen, setWaiverOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  if (!summary || !canManage) return null;

  const decisionStatus = summary.decision?.status || 'NONE';
  const eligibility = summary.eligibility || {};
  const canWaive = eligibility.proceedWithoutBgv?.allowed === true;
  const canInitiate = eligibility.initiateBgv?.allowed === true;

  // MongoDB is the source of truth: after any submit attempt (success or a
  // 409 conflict from a stale page/tab), re-fetch the authoritative summary
  // so the persisted badge always wins over in-memory state.
  const syncFromServer = async () => {
    try {
      const fresh = await bgvService.summary(candidateRef);
      if (fresh) {
        onSync?.(fresh);
        onDecided?.(fresh.decision);
      }
    } catch {
      // keep the current view; the error text already explains the failure
    }
  };

  const submit = async (decision) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await bgvService.decide(candidateRef, {
        decision,
        reason: decision === 'PROCEED_WITHOUT_BGV' ? reason : undefined,
      });
      setMessage(
        result.idempotent ? 'BGV decision already recorded' : 'BGV decision recorded'
      );
      setWaiverOpen(false);
      setReason('');
      await syncFromServer();
    } catch (requestError) {
      // A 409 means the server holds a different decision than this page's
      // stale snapshot — refresh so the persisted state is shown.
      if (requestError?.status === 409) await syncFromServer();
      setError(requestError?.message || 'BGV decision could not be recorded');
    } finally {
      setBusy(false);
    }
  };

  // Persisted waiver: explicit "not cleared" semantics, never a clearance.
  if (decisionStatus === 'PROCEEDED_WITHOUT_BGV') {
    return (
      <section className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-5">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-amber-500/10 p-2 text-amber-300">
            <ShieldOff className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-semibold text-slate-100">BGV Not Requested</h2>
            <p className="mt-1 text-sm text-slate-400">
              HR chose to proceed without Crewly BGV. The candidate has NOT been
              BGV cleared.
            </p>
            {summary.decision?.reason ? (
              <p className="mt-1 text-xs text-slate-500">Reason: {summary.decision.reason}</p>
            ) : null}
            {summary.decision?.decidedAt ? (
              <p className="mt-1 text-xs text-slate-500">
                Recorded {new Date(summary.decision.decidedAt).toLocaleString()}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  // Persisted intention: handoff message for the later purchase steps.
  if (decisionStatus === 'BGV_INITIATED') {
    return (
      <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-emerald-500/10 p-2 text-emerald-300">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-semibold text-slate-100">BGV Requested</h2>
            <p className="mt-1 text-sm text-slate-400">
              HR initiated Crewly BGV. Check selection and purchase follow in the
              next product step.
            </p>
            {summary.decision?.decidedAt ? (
              <p className="mt-1 text-xs text-slate-500">
                Recorded {new Date(summary.decision.decidedAt).toLocaleString()}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  // No decision yet: show the choices only when the pipeline allows them.
  if (!canWaive && !canInitiate) {
    return (
      <section className="rounded-2xl border border-slate-700/40 bg-slate-800/20 p-5">
        <p className="text-sm text-slate-500">
          Optional BGV decision becomes available after the human final selection
          (Selected or later).
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-slate-700/40 bg-slate-800/20 p-5">
      <div className="flex items-start gap-3">
        <span className="rounded-xl bg-slate-700/30 p-2 text-slate-300">
          <ShieldAlert className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="flex-1">
          <h2 className="font-semibold text-slate-100">Optional BGV decision</h2>
          <p className="mt-1 text-sm text-slate-400">
            BGV is optional. Choose how this organisation proceeds after the human
            final selection.
          </p>
          {error ? <p className="mt-2 text-sm text-rose-300">{error}</p> : null}
          {message ? <p className="mt-2 text-sm text-emerald-300">{message}</p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            {canWaive ? (
              <button
                type="button"
                className="btn-ghost"
                disabled={busy}
                onClick={() => {
                  setError('');
                  setMessage('');
                  setWaiverOpen(true);
                }}
              >
                Proceed Without BGV
              </button>
            ) : null}
            {canInitiate ? (
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => submit('INITIATE_BGV')}
              >
                Initiate BGV
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {waiverOpen ? (
        <Modal title="Proceed Without BGV" onClose={() => !busy && setWaiverOpen(false)}>
          <div className="flex flex-col gap-4">
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
              <li>
                The organisation is choosing to continue recruitment without Crewly
                BGV.
              </li>
              <li>No BGV verification will be performed for this candidate.</li>
              <li>The candidate will NOT be treated or displayed as BGV cleared.</li>
              <li>This is an HR acknowledgement, not candidate consent.</li>
            </ul>
            <label className="flex flex-col gap-1 text-sm text-slate-400">
              Reason (optional)
              <textarea
                className="min-h-[72px] rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-sm text-slate-200"
                maxLength={300}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. BGV not required for this role"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => setWaiverOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
                disabled={busy}
                onClick={() => submit('PROCEED_WITHOUT_BGV')}
              >
                {busy ? 'Recording…' : 'Confirm Proceed Without BGV'}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </section>
  );
};

export default CandidateBgvDecisionSection;
