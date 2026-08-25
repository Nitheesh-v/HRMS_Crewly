import { useState } from 'react';
import { ClipboardList, Loader2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import usePermission from '../../hooks/usePermission.js';
import preOnboardingService from '../../services/preOnboardingService.js';
import PreOnboardingStatusBadge from './PreOnboardingStatusBadge.jsx';

const CandidatePreOnboardingPanel = ({ candidate, onStarted }) => {
  const navigate = useNavigate();
  const { hasPermission } = usePermission();
  const canStart = hasPermission('PRE_ONBOARDING_CREATE');
  const canRead = hasPermission('PRE_ONBOARDING_READ');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const stage =
    candidate?.overview?.currentStage || candidate?.overview?.stage || '';
  const candidateId = candidate?.overview?.id || candidate?.overview?._id;

  if (!canRead && !canStart) return null;
  if (!['OFFER_ACCEPTED', 'PRE_ONBOARDING'].includes(stage)) return null;

  const start = async () => {
    if (!canStart || !candidateId) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await preOnboardingService.start(candidateId);
      setMessage(
        result.idempotent
          ? 'Pre-onboarding case already exists'
          : 'Pre-onboarding started and invite sent'
      );
      if (onStarted) onStarted(result);
      if (result?.id) {
        navigate(`/app/recruitment/pre-onboarding/${result.id}`);
      }
    } catch (requestError) {
      setError(requestError.message || 'Pre-onboarding could not be started');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-indigo-500/20 bg-indigo-500/5 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-indigo-500/10 p-2 text-indigo-300">
            <ClipboardList className="h-5 w-5" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold text-slate-100">Pre-onboarding</h2>
              {stage === 'PRE_ONBOARDING' ? (
                <PreOnboardingStatusBadge status="IN_PROGRESS" />
              ) : (
                <PreOnboardingStatusBadge status="NOT_STARTED" />
              )}
            </div>
            <p className="mt-1 text-sm text-slate-400">
              {stage === 'OFFER_ACCEPTED'
                ? 'Offer is accepted. Start pre-onboarding to collect joining documents through a secure candidate portal.'
                : 'This candidate is in pre-onboarding. Open the case to review documents and readiness.'}
            </p>
            {error ? (
              <p className="mt-2 text-sm text-rose-300">{error}</p>
            ) : null}
            {message ? (
              <p className="mt-2 text-sm text-emerald-300">{message}</p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canRead ? (
            <Link to="/app/recruitment/pre-onboarding" className="btn-ghost">
              Open board
            </Link>
          ) : null}
          {canStart && stage === 'OFFER_ACCEPTED' ? (
            <button
              type="button"
              className="btn-primary gap-2"
              disabled={busy}
              onClick={start}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Start pre-onboarding
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
};

export default CandidatePreOnboardingPanel;
