import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  XCircle,
} from 'lucide-react';
import { useParams } from 'react-router-dom';
import bgvConsentService from '../../services/bgvConsentService.js';

// Phase 30.4 — public candidate BGV consent portal.
// GET is decision-free; consent/decline are explicit POSTs only. No document
// upload, no verifier, no pipeline action — consent only (30.5 comes later).
const CandidateBgvConsentPortalPage = () => {
  const { secureToken } = useParams();
  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState('');
  const [confirmDecline, setConfirmDecline] = useState(false);

  useEffect(() => {
    let active = true;
    document.title = 'Background verification consent — Crewly';
    bgvConsentService
      .read(secureToken)
      .then((result) => {
        if (active) setView(result);
      })
      .catch((requestError) => {
        if (!active) return;
        setExpired(/expired/i.test(requestError.message || ''));
        setError(requestError.message || 'BGV consent link is unavailable');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [secureToken]);

  const decide = async (action) => {
    setBusy(action);
    setError('');
    try {
      const result =
        action === 'CONSENT'
          ? await bgvConsentService.consent(secureToken)
          : await bgvConsentService.decline(secureToken);
      setView((current) => ({
        ...(current || {}),
        state: result.state === 'DECLINED' ? 'DECLINED' : 'CONSENTED',
      }));
      setConfirmDecline(false);
    } catch (requestError) {
      setError(requestError.message || 'Your decision could not be recorded');
      // Re-read the authoritative state (Mongo is the truth).
      try {
        const fresh = await bgvConsentService.read(secureToken);
        setView(fresh);
      } catch {
        // keep the error message visible
      }
    } finally {
      setBusy('');
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-10">
        <div className="h-[55vh] animate-pulse rounded-2xl bg-slate-900" />
      </div>
    );
  }

  if (!view) {
    return (
      <div className="mx-auto flex max-w-xl items-center justify-center px-5 py-24">
        <section className="w-full rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
          {expired ? (
            <Clock3 className="mx-auto h-10 w-10 text-slate-600" />
          ) : (
            <XCircle className="mx-auto h-10 w-10 text-slate-600" />
          )}
          <h1 className="mt-4 text-xl font-semibold">
            {expired ? 'This link has expired' : 'Link unavailable'}
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            {expired
              ? 'For your security the invitation link is time-limited. Please ask the hiring team to send a new one.'
              : 'This link is invalid, expired, or no longer available. Please contact the hiring team if you expected a background verification request.'}
          </p>
        </section>
      </div>
    );
  }

  const decided = view.state === 'CONSENTED' || view.state === 'DECLINED';

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-5 py-8 sm:py-10">
      <header className="rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:p-8">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-teal-500/10 p-2 text-teal-300">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-bold text-slate-100 sm:text-2xl">
              Background verification request
            </h1>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              Hello {view.candidateName}. <span className="text-slate-200">{view.companyName}</span>{' '}
              has requested a background verification for your candidature, coordinated through
              Crewly. Opening this page did not record any decision — your choice happens only
              when you press a button below.
            </p>
          </div>
        </div>
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <h2 className="font-semibold">Verification checks included</h2>
        <ul className="mt-4 space-y-2">
          {(view.checks || []).map((check) => (
            <li
              key={check.type}
              className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-sm text-slate-200"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0 text-teal-300" /> {check.name}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs leading-5 text-slate-500">
          These checks were selected and authorized by the requesting organisation. Verification
          activities begin only after you consent, and information you provide later is used only
          for verification, retained only as long as required, under Crewly privacy and
          data-protection practices.
        </p>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <h2 className="font-semibold">Your consent</h2>
        <p className="mt-3 whitespace-pre-line text-sm leading-6 text-slate-300">
          {view.statement}
        </p>
        <p className="mt-3 text-xs text-slate-500">Consent wording version {view.consentVersion}</p>
      </section>

      {error ? (
        <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </p>
      ) : null}

      {decided ? (
        <section
          className={`rounded-2xl border p-6 ${
            view.state === 'CONSENTED'
              ? 'border-emerald-500/25 bg-emerald-500/10'
              : 'border-rose-500/25 bg-rose-500/10'
          }`}
        >
          <div className="flex items-start gap-3">
            {view.state === 'CONSENTED' ? (
              <CheckCircle2 className="h-6 w-6 text-emerald-300" />
            ) : (
              <XCircle className="h-6 w-6 text-rose-300" />
            )}
            <div>
              <h2 className="font-semibold text-slate-100">
                {view.state === 'CONSENTED' ? 'Consent recorded' : 'Decline recorded'}
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-300">
                {view.state === 'CONSENTED'
                  ? 'Consent recorded. Crewly will guide you through the required information in the next step.'
                  : 'Your decline has been recorded. The organisation will see your consent decision and make its own recruitment decision — a decline is not a verification failure.'}
              </p>
            </div>
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          {confirmDecline ? (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-4">
              <p className="text-sm font-medium text-amber-200">Decline this verification?</p>
              <p className="mt-1 text-xs leading-5 text-amber-100/70">
                Crewly will record your decline and the verification cannot proceed through this
                request. This is a consent decision, not a verification failure, and the
                organisation makes any recruitment decision separately.
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" className="btn-ghost" disabled={Boolean(busy)} onClick={() => setConfirmDecline(false)}>
                  Back
                </button>
                <button type="button" className="btn-primary gap-2" disabled={Boolean(busy)} onClick={() => decide('DECLINE')}>
                  {busy === 'DECLINE' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsDown className="h-4 w-4" />}
                  Confirm decline
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <button type="button" className="btn-primary flex-1 justify-center gap-2" disabled={Boolean(busy)} onClick={() => decide('CONSENT')}>
                {busy === 'CONSENT' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsUp className="h-4 w-4" />}
                I consent to background verification
              </button>
              <button type="button" className="btn-ghost flex-1 justify-center gap-2 text-rose-300" disabled={Boolean(busy)} onClick={() => setConfirmDecline(true)}>
                <ThumbsDown className="h-4 w-4" /> Decline
              </button>
            </div>
          )}
          <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-slate-500">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            Refreshing or reopening this page never records a decision. Only the buttons above do.
          </p>
        </section>
      )}
    </div>
  );
};

export default CandidateBgvConsentPortalPage;
