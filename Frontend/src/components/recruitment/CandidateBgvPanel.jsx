import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Loader2, ShieldCheck } from 'lucide-react';
import usePermission from '../../hooks/usePermission.js';
import bgvService from '../../services/bgvService.js';
import CandidateBgvDecisionSection from './CandidateBgvDecisionSection.jsx';

const CandidateBgvPanel = ({ candidate }) => {
  const { candidateRef } = useParams();
  const { hasPermission } = usePermission();
  const canRead = hasPermission('BACKGROUND_VERIFICATION_READ');
  const canStart = hasPermission('BACKGROUND_VERIFICATION_CREATE');
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const ref =
    candidateRef ||
    candidate?.overview?.candidateCode ||
    candidate?.candidateCode ||
    candidate?.overview?.id ||
    candidate?.id;

  useEffect(() => {
    if (!canRead || !ref) return undefined;
    let active = true;
    bgvService
      .summary(ref)
      .then((data) => {
        if (active) setSummary(data);
      })
      .catch(() => {
        if (active) setSummary({ hasCase: false });
      });
    return () => {
      active = false;
    };
  }, [canRead, ref]);

  if (!canRead && !canStart) return null;

  const start = async () => {
    if (!canStart || !ref) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await bgvService.start(ref);
      setMessage(result.idempotent ? 'BGV case already exists' : 'Background verification started');
      setSummary({
        hasCase: true,
        case: {
          id: result.id,
          caseCode: result.caseCode,
          status: result.status,
          requiredCheckCount: result.requiredCheckCount,
          verifiedRequiredCount: result.verifiedRequiredCount,
          discrepancyCount: result.discrepancyCount,
          overallOutcome: result.overallOutcome,
        },
      });
    } catch (requestError) {
      setError(requestError.message || 'BGV could not be started');
    } finally {
      setBusy(false);
    }
  };

  const caseData = summary?.case;

  return (
    <div className="flex flex-col gap-4">
      {/* Phase 30.1 — optional BGV decision (persisted, refresh-safe). */}
      <CandidateBgvDecisionSection
        candidateRef={ref}
        summary={summary}
        onDecided={(decision) => setSummary((current) => ({ ...(current || {}), decision }))}
        onSync={(fresh) => setSummary(fresh)}
      />
    <section className="rounded-2xl border border-violet-500/20 bg-violet-500/5 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-violet-500/10 p-2 text-violet-300">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div>
            <h2 className="font-semibold text-slate-100">Background verification</h2>
            <p className="mt-1 text-sm text-slate-400">
              {caseData
                ? `${caseData.caseCode} · ${String(caseData.status || '').replaceAll('_', ' ')} · ${caseData.verifiedRequiredCount || 0}/${caseData.requiredCheckCount || 0} required verified`
                : 'No BGV case yet. Start a human-controlled verification workflow when policy requires it.'}
            </p>
            {caseData?.discrepancyCount ? (
              <p className="mt-1 text-xs text-amber-300">
                {caseData.discrepancyCount} discrepancy recorded — candidate is not auto-rejected.
              </p>
            ) : null}
            {error ? <p className="mt-2 text-sm text-rose-300">{error}</p> : null}
            {message ? <p className="mt-2 text-sm text-emerald-300">{message}</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {caseData?.id ? (
            <Link
              to={`/app/recruitment/background-verification/${caseData.id}`}
              className="btn-ghost"
            >
              Open case
            </Link>
          ) : null}
          {/* Phase 30.1 guard: a recorded waiver means no BGV work — hide the
              legacy internal start so the two tracks cannot contradict. */}
          {canStart && !caseData && summary?.decision?.status !== 'PROCEEDED_WITHOUT_BGV' ? (
            <button type="button" className="btn-primary gap-2" disabled={busy} onClick={start}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Start BGV
            </button>
          ) : null}
        </div>
      </div>
    </section>
    </div>
  );
};

export default CandidateBgvPanel;
