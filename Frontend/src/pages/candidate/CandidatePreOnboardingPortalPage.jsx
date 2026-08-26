import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ClipboardList,
  Upload,
  XCircle,
} from 'lucide-react';
import { useParams } from 'react-router-dom';
import PreOnboardingStatusBadge from '../../components/recruitment/PreOnboardingStatusBadge.jsx';
import preOnboardingService from '../../services/preOnboardingService.js';

const dateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }).format(new Date(value))
    : 'Not set';

const CandidatePreOnboardingPortalPage = () => {
  const { secureToken } = useParams();
  const viewPosted = useRef(false);
  const [caseData, setCaseData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyCode, setBusyCode] = useState('');
  const [numbers, setNumbers] = useState({});
  const [expiries, setExpiries] = useState({});
  const [files, setFiles] = useState({});

  useEffect(() => {
    let active = true;
    document.title = 'Secure pre-onboarding — Crewly';
    preOnboardingService
      .publicRead(secureToken)
      .then(async (result) => {
        if (!active) return;
        setCaseData(result);
        setLoading(false);
        if (!viewPosted.current) {
          viewPosted.current = true;
          try {
            const viewed = await preOnboardingService.publicView(secureToken);
            if (active) setCaseData(viewed);
          } catch {
            // Non-final view telemetry may fail without blocking the portal.
          }
        }
      })
      .catch((requestError) => {
        if (!active) return;
        setError(requestError.message || 'Pre-onboarding is unavailable');
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [secureToken]);

  const upload = async (requirement) => {
    const file = files[requirement.code];
    if (!file) {
      setError('Choose a file before uploading');
      return;
    }

    if (
      requirement.fileRules?.requiresDocumentNumber &&
      !String(numbers[requirement.code] || '').trim()
    ) {
      setError(`Document number is required for ${requirement.name}`);
      return;
    }

    if (
      requirement.fileRules?.requiresExpiryDate &&
      !String(expiries[requirement.code] || '').trim()
    ) {
      setError(`Expiry date is required for ${requirement.name}`);
      return;
    }

    setBusyCode(requirement.code);
    setError('');
    try {
      const formData = new FormData();
      formData.append('document', file);
      if (numbers[requirement.code]) {
        formData.append('documentNumber', numbers[requirement.code]);
      }
      if (expiries[requirement.code]) {
        // Send as ISO date so backend ISO8601 validation accepts it.
        const expiryValue = String(expiries[requirement.code]);
        const isoExpiry = expiryValue.includes('T')
          ? expiryValue
          : `${expiryValue}T00:00:00.000Z`;
        formData.append('expiryDate', isoExpiry);
      }
      const result = await preOnboardingService.publicUpload(
        secureToken,
        requirement.code,
        formData
      );
      const nextCase = result?.case || result;
      setCaseData(nextCase);
      setFiles((current) => ({ ...current, [requirement.code]: null }));
    } catch (requestError) {
      setError(requestError.message || 'Document could not be uploaded');
    } finally {
      setBusyCode('');
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-5 py-10">
        <div className="h-[65vh] animate-pulse rounded-2xl bg-slate-900" />
      </div>
    );
  }

  if (!caseData) {
    return (
      <div className="mx-auto flex max-w-xl items-center justify-center px-5 py-24">
        <section className="w-full rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
          <XCircle className="mx-auto h-10 w-10 text-slate-600" />
          <h1 className="mt-4 text-xl font-semibold">Pre-onboarding unavailable</h1>
          <p className="mt-2 text-sm text-slate-400">
            {error || 'This link is invalid, expired, or no longer available.'}
          </p>
        </section>
      </div>
    );
  }

  const complete = caseData.status === 'READY_TO_JOIN';

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-5 py-8 sm:py-10">
      <header className="rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <ClipboardList className="h-5 w-5 text-indigo-300" />
          <p className="font-mono text-xs font-semibold text-indigo-300">
            {caseData.preOnboardingCode}
          </p>
          <PreOnboardingStatusBadge status={caseData.status} />
        </div>
        <h1 className="mt-4 text-2xl font-bold text-slate-100 sm:text-3xl">
          Hello {caseData.candidate?.name}
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          {caseData.company?.name} · {caseData.job?.title} · Joining{' '}
          {dateLabel(caseData.offer?.joiningDate)}
        </p>
        <p className="mt-4 text-sm text-slate-300">
          Progress: {caseData.verifiedRequiredDocumentCount || 0} /{' '}
          {caseData.requiredDocumentCount || 0} mandatory documents verified
        </p>
      </header>

      {error ? (
        <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </p>
      ) : null}

      {complete ? (
        <section className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-6">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-6 w-6 text-emerald-300" />
            <div>
              <h2 className="font-semibold text-slate-100">You are ready to join</h2>
              <p className="mt-1 text-sm text-slate-300">
                Your mandatory documents are complete. The hiring team will continue with
                employee setup in the next step. No further uploads are required here.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <section className="space-y-4">
        {(caseData.requirements || []).map((requirement) => {
          const locked = requirement.status === 'VERIFIED' || complete;
          const needsUpload = [
            'PENDING',
            'REJECTED',
            'RESUBMISSION_REQUIRED',
          ].includes(requirement.status);

          return (
            <article
              key={requirement.code}
              className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold text-slate-100">{requirement.name}</h2>
                    <PreOnboardingStatusBadge status={requirement.status} />
                    <span className="text-[11px] uppercase tracking-wide text-slate-500">
                      {requirement.required ? 'Required' : 'Optional'}
                    </span>
                  </div>
                  {requirement.instructions ? (
                    <p className="mt-2 text-sm text-slate-400">{requirement.instructions}</p>
                  ) : null}
                  {requirement.rejectionReason ? (
                    <p className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-100">
                      {requirement.rejectionReason}
                    </p>
                  ) : null}
                </div>
              </div>

              {locked ? (
                <p className="mt-4 text-sm text-emerald-300">
                  {requirement.status === 'VERIFIED'
                    ? 'This document has been verified.'
                    : 'This case is complete.'}
                </p>
              ) : (
                <div className="mt-4 space-y-3">
                  {requirement.fileRules?.requiresDocumentNumber ? (
                    <label className="block">
                      <span className="label">Document number</span>
                      <input
                        className="input"
                        value={numbers[requirement.code] || ''}
                        onChange={(event) =>
                          setNumbers((current) => ({
                            ...current,
                            [requirement.code]: event.target.value,
                          }))
                        }
                      />
                    </label>
                  ) : null}
                  {requirement.fileRules?.requiresExpiryDate ? (
                    <label className="block">
                      <span className="label">Expiry date</span>
                      <input
                        className="input"
                        type="date"
                        value={expiries[requirement.code] || ''}
                        onChange={(event) =>
                          setExpiries((current) => ({
                            ...current,
                            [requirement.code]: event.target.value,
                          }))
                        }
                      />
                    </label>
                  ) : null}
                  <label className="block">
                    <span className="label">
                      {needsUpload ? 'Upload file' : 'Replace file'}
                    </span>
                    <input
                      className="input"
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
                      onChange={(event) =>
                        setFiles((current) => ({
                          ...current,
                          [requirement.code]: event.target.files?.[0] || null,
                        }))
                      }
                    />
                  </label>
                  {files[requirement.code] ? (
                    <p className="text-xs text-slate-400">
                      Selected: {files[requirement.code].name}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="btn-primary gap-2"
                    disabled={busyCode === requirement.code}
                    onClick={() => upload(requirement)}
                  >
                    <Upload className="h-4 w-4" />
                    {busyCode === requirement.code ? 'Uploading...' : 'Upload document'}
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
};

export default CandidatePreOnboardingPortalPage;
