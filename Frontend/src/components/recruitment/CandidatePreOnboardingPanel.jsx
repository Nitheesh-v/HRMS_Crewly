import { useState } from 'react';
import { ClipboardList, Loader2 } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import usePermission from '../../hooks/usePermission.js';
import preOnboardingService from '../../services/preOnboardingService.js';
import PreOnboardingStatusBadge from './PreOnboardingStatusBadge.jsx';

const CandidatePreOnboardingPanel = ({ candidate, onStarted }) => {
  const navigate = useNavigate();
  const { candidateRef } = useParams();
  const { hasPermission, permissions, loaded } = usePermission();
  const canStart = hasPermission('PRE_ONBOARDING_CREATE');
  const canRead = hasPermission('PRE_ONBOARDING_READ');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const stage =
    candidate?.overview?.currentStage || candidate?.overview?.stage || '';

  // Prefer Mongo id; fall back to candidate code / route ref for start API.
  const candidateId =
    candidate?.overview?.id ||
    candidate?.overview?._id ||
    candidate?.id ||
    candidate?._id ||
    candidate?.candidateCode ||
    candidate?.overview?.candidateCode ||
    candidateRef ||
    '';

  // Show panel once permissions are known and stage is eligible.
  // If permissions failed to load new PRE_ONBOARDING_* keys, still show a clear message.
  const stageEligible = ['OFFER_ACCEPTED', 'PRE_ONBOARDING'].includes(stage);
  if (!stageEligible) return null;

  const missingNewPermissions =
    loaded &&
    !canRead &&
    !canStart &&
    !permissions.some((name) => String(name).startsWith('PRE_ONBOARDING_'));

  const start = async () => {
    if (!candidateId) {
      setError('Candidate id is missing. Refresh the page and try again.');
      return;
    }
    if (!canStart) {
      setError(
        'Your role is missing PRE_ONBOARDING_CREATE. Log out and log back in after backend permission migration, or ask a Company Admin to refresh roles.'
      );
      return;
    }

    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await preOnboardingService.start(candidateId);
      setMessage(
        result?.idempotent
          ? 'Pre-onboarding case already exists'
          : 'Pre-onboarding started and invite sent'
      );
      if (onStarted) onStarted(result);
      const caseId = result?.id || result?._id || result?.case?.id;
      if (caseId) {
        navigate(`/app/recruitment/pre-onboarding/${caseId}`);
      } else {
        navigate('/app/recruitment/pre-onboarding');
      }
    } catch (requestError) {
      const status = requestError?.status || requestError?.payload?.statusCode;
      if (status === 403) {
        setError(
          requestError.message ||
            'Permission denied. Log out/in so PRE_ONBOARDING_* permissions migrate onto your HR role.'
        );
      } else if (status === 404) {
        setError(
          requestError.message ||
            'Start API not found. Confirm frontend VITE_API_URL points at your local Backend running Phase 27.12 (not only production Render).'
        );
      } else {
        setError(requestError.message || 'Pre-onboarding could not be started');
      }
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
            {missingNewPermissions ? (
              <p className="mt-2 text-sm text-amber-200">
                Your session does not include Phase 27.12 pre-onboarding permissions yet.
                Restart the local backend on branch arena/01a0398f-hrms-crewly, confirm
                VITE_API_URL points to that backend, then log out and log back in.
              </p>
            ) : null}
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
          ) : (
            <Link to="/app/recruitment/pre-onboarding" className="btn-ghost">
              Open board
            </Link>
          )}
          {stage === 'OFFER_ACCEPTED' ? (
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
