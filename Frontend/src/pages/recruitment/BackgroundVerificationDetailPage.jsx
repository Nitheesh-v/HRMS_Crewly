/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import usePermission from '../../hooks/usePermission.js';
import bgvService from '../../services/bgvService.js';

const BackgroundVerificationDetailPage = () => {
  const { caseId } = useParams();
  const { hasPermission } = usePermission();
  const canVerify = hasPermission('BACKGROUND_VERIFICATION_VERIFY');
  const canManage = hasPermission('BACKGROUND_VERIFICATION_MANAGE');

  const [bundle, setBundle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState('CLEAR');
  const [reviewComment, setReviewComment] = useState('');
  const [activeCheck, setActiveCheck] = useState(null);
  const [checkForm, setCheckForm] = useState({
    verifiedInformation: '',
    discrepancy: '',
    resultSummary: '',
    hrComment: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await bgvService.detail(caseId);
      setBundle(data);
      if (data?.case?.overallOutcome) setOutcome(data.case.overallOutcome);
      if (data?.case?.reviewComment) setReviewComment(data.case.reviewComment);
    } catch (requestError) {
      setError(requestError.message || 'BGV case could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (key, action) => {
    setBusy(key);
    setError('');
    try {
      await action();
      await load();
      setActiveCheck(null);
    } catch (requestError) {
      setError(requestError.message || 'Action failed');
    } finally {
      setBusy('');
    }
  };

  if (loading) return <div className="h-64 animate-pulse rounded-2xl bg-slate-900" />;
  if (!bundle?.case) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-300">
        {error || 'BGV case not found'}
      </div>
    );
  }

  const caseData = bundle.case;
  const checks = caseData.checks || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <Link
            to="/app/recruitment/background-verification"
            className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-100"
          >
            <ArrowLeft className="h-4 w-4" />
            Background verification
          </Link>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-100">{caseData.caseCode}</h1>
            <span className="rounded-full border border-slate-700 bg-slate-800 px-2.5 py-0.5 text-[11px] font-semibold text-slate-300">
              {String(caseData.status || '').replaceAll('_', ' ')}
            </span>
            {caseData.overallOutcome ? (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-200">
                {caseData.overallOutcome.replaceAll('_', ' ')}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-slate-400">
            {caseData.candidate?.name} · {caseData.job?.title || 'Open role'} · trigger{' '}
            {caseData.triggerStage}
          </p>
        </div>
        <button type="button" className="btn-ghost gap-2" onClick={load}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </p>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 lg:col-span-2">
          <h2 className="font-semibold">Verification checks</h2>
          <p className="mt-1 text-sm text-slate-400">
            {caseData.verifiedRequiredCount || 0}/{caseData.requiredCheckCount || 0} required
            verified · {caseData.discrepancyCount || 0} discrepancies
          </p>
          <div className="mt-5 space-y-3">
            {checks.map((check) => (
              <div
                key={check.id}
                className="rounded-xl border border-slate-800 bg-slate-950/50 p-4"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-slate-100">{check.name}</p>
                      <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] uppercase text-slate-400">
                        {check.status.replaceAll('_', ' ')}
                      </span>
                      <span className="text-[11px] uppercase text-slate-500">
                        {check.required ? 'Required' : 'Optional'}
                      </span>
                    </div>
                    {check.claimedInformation ? (
                      <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-900 p-3 font-sans text-xs text-slate-400">
                        Claimed{'\n'}
                        {check.claimedInformation}
                      </pre>
                    ) : null}
                    {check.verifiedInformation ? (
                      <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-900 p-3 font-sans text-xs text-slate-300">
                        Verified{'\n'}
                        {check.verifiedInformation}
                      </pre>
                    ) : null}
                    {check.discrepancy ? (
                      <p className="mt-2 text-sm text-amber-200">{check.discrepancy}</p>
                    ) : null}
                    {check.resultSummary ? (
                      <p className="mt-2 text-xs text-slate-500">{check.resultSummary}</p>
                    ) : null}
                  </div>
                  {canVerify && !['COMPLETED', 'CANCELLED'].includes(caseData.status) ? (
                    <div className="flex flex-wrap gap-2">
                      {check.status === 'NOT_STARTED' ? (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={busy === `START-${check.id}`}
                          onClick={() =>
                            run(`START-${check.id}`, () =>
                              bgvService.updateCheck(caseData.id, check.id, {
                                action: 'START',
                              })
                            )
                          }
                        >
                          Start
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn-primary gap-2"
                        onClick={() => {
                          setActiveCheck(check);
                          setCheckForm({
                            verifiedInformation: check.verifiedInformation || check.claimedInformation || '',
                            discrepancy: '',
                            resultSummary: '',
                            hrComment: '',
                          });
                        }}
                      >
                        <ShieldCheck className="h-4 w-4" />
                        Record result
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="font-semibold">Consent</h2>
            <p className="mt-2 text-sm text-slate-300">
              {caseData.consent?.required ? caseData.consent?.status : 'Not required'}
            </p>
          </section>

          {canManage && caseData.status === 'REVIEW_REQUIRED' ? (
            <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5">
              <h2 className="font-semibold">Complete human review</h2>
              <p className="mt-1 text-xs text-slate-400">
                Never auto-rejects the candidate. Choose an overall outcome.
              </p>
              <label className="mt-4 block">
                <span className="label">Overall outcome</span>
                <select
                  className="input"
                  value={outcome}
                  onChange={(event) => setOutcome(event.target.value)}
                >
                  <option value="CLEAR">CLEAR</option>
                  <option value="CLEAR_WITH_DISCREPANCIES">CLEAR_WITH_DISCREPANCIES</option>
                  <option value="HOLD">HOLD</option>
                </select>
              </label>
              <label className="mt-3 block">
                <span className="label">Review comment</span>
                <textarea
                  className="input min-h-24"
                  value={reviewComment}
                  onChange={(event) => setReviewComment(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn-primary mt-4 w-full gap-2"
                disabled={busy === 'COMPLETE'}
                onClick={() =>
                  run('COMPLETE', () =>
                    bgvService.complete(caseData.id, {
                      overallOutcome: outcome,
                      reviewComment,
                    })
                  )
                }
              >
                <CheckCircle2 className="h-4 w-4" />
                Complete BGV review
              </button>
            </section>
          ) : null}

          {canManage && !['COMPLETED', 'CANCELLED'].includes(caseData.status) ? (
            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="font-semibold">Cancel case</h2>
              <button
                type="button"
                className="btn-ghost mt-3 w-full gap-2 text-rose-300"
                disabled={busy === 'CANCEL'}
                onClick={() => {
                  const reason = window.prompt('Cancellation reason');
                  if (!reason) return;
                  run('CANCEL', () => bgvService.cancel(caseData.id, reason));
                }}
              >
                <XCircle className="h-4 w-4" />
                Cancel BGV
              </button>
            </section>
          ) : null}

          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="font-semibold">History</h2>
            <div className="mt-3 max-h-80 space-y-2 overflow-y-auto">
              {(bundle.history || []).map((item) => (
                <div key={item.id} className="rounded-lg bg-slate-950/50 p-3 text-xs text-slate-400">
                  <p className="font-medium text-slate-200">
                    {String(item.action || '').replaceAll('_', ' ')}
                  </p>
                  <p className="mt-1">
                    {item.previousStatus || '—'} → {item.newStatus || '—'}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>

      {activeCheck ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4">
          <form
            className="w-full max-w-lg space-y-4 rounded-2xl border border-slate-700 bg-slate-900 p-6"
            onSubmit={(event) => {
              event.preventDefault();
              const action = event.nativeEvent.submitter?.value;
              run(`CHECK-${activeCheck.id}`, () =>
                bgvService.updateCheck(caseData.id, activeCheck.id, {
                  action,
                  ...checkForm,
                })
              );
            }}
          >
            <div className="flex items-start gap-3">
              <ShieldAlert className="h-5 w-5 text-amber-300" />
              <div>
                <h2 className="text-lg font-semibold">{activeCheck.name}</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Record a human verification result. Discrepancies do not reject the candidate.
                </p>
              </div>
            </div>
            <label className="block">
              <span className="label">Verified information</span>
              <textarea
                className="input min-h-24"
                value={checkForm.verifiedInformation}
                onChange={(event) =>
                  setCheckForm((current) => ({
                    ...current,
                    verifiedInformation: event.target.value,
                  }))
                }
              />
            </label>
            <label className="block">
              <span className="label">Discrepancy (required for discrepancy action)</span>
              <textarea
                className="input min-h-20"
                value={checkForm.discrepancy}
                onChange={(event) =>
                  setCheckForm((current) => ({
                    ...current,
                    discrepancy: event.target.value,
                  }))
                }
              />
            </label>
            <label className="block">
              <span className="label">Result summary</span>
              <input
                className="input"
                value={checkForm.resultSummary}
                onChange={(event) =>
                  setCheckForm((current) => ({
                    ...current,
                    resultSummary: event.target.value,
                  }))
                }
              />
            </label>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setActiveCheck(null)}>
                Cancel
              </button>
              <button type="submit" name="action" value="REQUEST_INFORMATION" className="btn-ghost">
                Request info
              </button>
              <button type="submit" name="action" value="UNABLE_TO_VERIFY" className="btn-ghost">
                Unable to verify
              </button>
              <button type="submit" name="action" value="RECORD_DISCREPANCY" className="btn-ghost text-amber-300">
                Discrepancy
              </button>
              <button type="submit" name="action" value="MARK_VERIFIED" className="btn-primary">
                Mark verified
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
};

export default BackgroundVerificationDetailPage;
