/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  Mail,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import PreOnboardingStatusBadge from '../../components/recruitment/PreOnboardingStatusBadge.jsx';
import usePermission from '../../hooks/usePermission.js';
import preOnboardingService from '../../services/preOnboardingService.js';

const dateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }).format(new Date(value))
    : 'Not set';

const PreOnboardingDetailPage = () => {
  const { preOnboardingId } = useParams();
  const { hasPermission } = usePermission();
  const canVerify = hasPermission('PRE_ONBOARDING_DOCUMENT_VERIFY');
  const canReady = hasPermission('PRE_ONBOARDING_READY');
  const canSend = hasPermission('PRE_ONBOARDING_SEND');
  const canReadDocs = hasPermission('PRE_ONBOARDING_DOCUMENT_READ');

  const [bundle, setBundle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [rejectTarget, setRejectTarget] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await preOnboardingService.detail(preOnboardingId);
      setBundle(result);
    } catch (requestError) {
      setError(requestError.message || 'Pre-onboarding case could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [preOnboardingId]);

  useEffect(() => {
    load();
  }, [load]);

  const caseData = bundle?.case;
  const documents = bundle?.documents || [];
  const history = bundle?.history || [];

  const documentByRequirement = Object.fromEntries(
    documents.map((document) => [document.requirementCode, document])
  );

  const runAction = async (key, action) => {
    setBusy(key);
    setError('');
    try {
      await action();
      await load();
    } catch (requestError) {
      setError(requestError.message || 'Action failed');
    } finally {
      setBusy('');
    }
  };

  if (loading) {
    return <div className="h-[60vh] animate-pulse rounded-2xl bg-slate-900" />;
  }

  if (!caseData) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center">
        <p className="text-slate-300">{error || 'Pre-onboarding case not found'}</p>
        <Link to="/app/recruitment/pre-onboarding" className="btn-ghost mt-4 inline-flex">
          Back to list
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <Link
            to="/app/recruitment/pre-onboarding"
            className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200"
          >
            <ArrowLeft className="h-4 w-4" />
            Pre-onboarding
          </Link>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-100">
              {caseData.candidate?.name}
            </h1>
            <PreOnboardingStatusBadge status={caseData.status} />
          </div>
          <p className="mt-1 text-sm text-slate-400">
            {caseData.job?.title} · {caseData.preOnboardingCode} · Joining{' '}
            {dateLabel(caseData.offer?.joiningDate)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost gap-2" onClick={load}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
          {canSend && caseData.status !== 'READY_TO_JOIN' ? (
            <button
              type="button"
              className="btn-ghost gap-2"
              disabled={busy === 'INVITE'}
              onClick={() =>
                runAction('INVITE', () =>
                  preOnboardingService.resendInvite(caseData.id)
                )
              }
            >
              <Mail className="h-4 w-4" />
              Resend invite
            </button>
          ) : null}
          {canReady && caseData.status !== 'READY_TO_JOIN' ? (
            <button
              type="button"
              className="btn-primary gap-2"
              disabled={!caseData.canMarkReady || busy === 'READY'}
              onClick={() =>
                runAction('READY', () => preOnboardingService.markReady(caseData.id))
              }
            >
              <ShieldCheck className="h-4 w-4" />
              Mark ready to join
            </button>
          ) : null}
          {caseData.status === 'READY_TO_JOIN' ? (
            <Link
              to={`/app/recruitment/candidates/${caseData.candidate?.candidateCode || caseData.candidate?.id}/convert`}
              className="btn-primary gap-2"
            >
              Convert to employee
            </Link>
          ) : null}
        </div>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </p>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 lg:col-span-2">
          <h2 className="font-semibold text-slate-100">Document checklist</h2>
          <p className="mt-1 text-sm text-slate-400">
            {caseData.verifiedRequiredDocumentCount || 0} /{' '}
            {caseData.requiredDocumentCount || 0} mandatory documents verified
          </p>
          <div className="mt-5 space-y-3">
            {(caseData.requirements || []).map((requirement) => {
              const document = documentByRequirement[requirement.code];
              return (
                <div
                  key={requirement.id || requirement.code}
                  className="rounded-xl border border-slate-800 bg-slate-950/50 p-4"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-slate-100">{requirement.name}</p>
                        <PreOnboardingStatusBadge status={requirement.status} />
                        <span className="text-[11px] uppercase tracking-wide text-slate-500">
                          {requirement.required ? 'Required' : 'Optional'}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {requirement.category} · {requirement.code}
                      </p>
                      {requirement.rejectionReason ? (
                        <p className="mt-2 text-sm text-amber-200">
                          {requirement.rejectionReason}
                        </p>
                      ) : null}
                      {document?.activeVersion ? (
                        <p className="mt-2 text-xs text-slate-400">
                          v{document.activeVersion.version} ·{' '}
                          {document.activeVersion.originalFileName} · scan{' '}
                          {document.activeVersion.scanStatus}
                        </p>
                      ) : (
                        <p className="mt-2 text-xs text-slate-500">No file uploaded yet</p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {canReadDocs && document ? (
                        <button
                          type="button"
                          className="btn-ghost gap-2"
                          disabled={busy === `FILE-${document.id}`}
                          onClick={() =>
                            runAction(`FILE-${document.id}`, () =>
                              preOnboardingService.downloadDocument(
                                caseData.id,
                                document.id,
                                document.activeVersion?.originalFileName ||
                                  `${document.documentCode}.bin`
                              )
                            )
                          }
                        >
                          <Download className="h-4 w-4" />
                          Secure view
                        </button>
                      ) : null}
                      {canVerify && document && requirement.status !== 'VERIFIED' ? (
                        <button
                          type="button"
                          className="btn-primary gap-2"
                          disabled={busy === `VERIFY-${document.id}`}
                          onClick={() =>
                            runAction(`VERIFY-${document.id}`, () =>
                              preOnboardingService.verifyDocument(
                                caseData.id,
                                document.id
                              )
                            )
                          }
                        >
                          <CheckCircle2 className="h-4 w-4" />
                          Verify
                        </button>
                      ) : null}
                      {canVerify && document && requirement.status !== 'RESUBMISSION_REQUIRED' ? (
                        <button
                          type="button"
                          className="btn-ghost gap-2 text-rose-300"
                          onClick={() => {
                            setRejectTarget(document);
                            setRejectReason('');
                          }}
                        >
                          <XCircle className="h-4 w-4" />
                          Reject
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-4">
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="font-semibold">Readiness</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Mandatory verified</dt>
                <dd className="text-slate-200">
                  {caseData.readiness?.verifiedRequired || 0}/
                  {caseData.readiness?.totalRequired || 0}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Under review</dt>
                <dd className="text-slate-200">
                  {caseData.readiness?.underReviewRequired || 0}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Resubmission</dt>
                <dd className="text-slate-200">
                  {caseData.readiness?.resubmissionRequired || 0}
                </dd>
              </div>
            </dl>
            {(caseData.readiness?.blockingReasons || []).length ? (
              <ul className="mt-4 space-y-2 text-xs text-amber-200">
                {caseData.readiness.blockingReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-emerald-300">
                All mandatory documents are verified. HR can mark ready to join.
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="font-semibold">Case facts</h2>
            <dl className="mt-4 space-y-3 text-sm">
              {[
                ['Offer', caseData.offer?.offerCode],
                ['Designation', caseData.offer?.designation],
                ['Department', caseData.offer?.departmentName || 'Not set'],
                ['Location', caseData.offer?.location || 'Not set'],
                ['Started', dateLabel(caseData.startedAt)],
                ['Ready at', dateLabel(caseData.readyToJoinAt)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[10px] uppercase tracking-wide text-slate-500">
                    {label}
                  </dt>
                  <dd className="mt-1 text-slate-200">{value || 'Not set'}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="font-semibold">History</h2>
            <div className="mt-4 max-h-80 space-y-3 overflow-y-auto">
              {history.length ? (
                history.map((item) => (
                  <div key={item.id} className="rounded-lg bg-slate-950/50 p-3">
                    <p className="text-sm text-slate-200">
                      {String(item.action || '')
                        .toLowerCase()
                        .split('_')
                        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                        .join(' ')}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {dateLabel(item.createdAt)}
                      {item.reason ? ` · ${item.reason}` : ''}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-500">No history yet.</p>
              )}
            </div>
          </section>
        </div>
      </section>

      {rejectTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4">
          <form
            className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6"
            onSubmit={(event) => {
              event.preventDefault();
              runAction(`REJECT-${rejectTarget.id}`, async () => {
                await preOnboardingService.rejectDocument(
                  caseData.id,
                  rejectTarget.id,
                  rejectReason
                );
                setRejectTarget(null);
                setRejectReason('');
              });
            }}
          >
            <h2 className="text-lg font-semibold">Request resubmission</h2>
            <p className="mt-2 text-sm text-slate-400">
              The candidate will see this reason in the secure portal.
            </p>
            <label className="mt-4 block">
              <span className="label">Reason</span>
              <textarea
                className="input min-h-28"
                maxLength={1000}
                required
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
              />
            </label>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setRejectTarget(null)}
              >
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={Boolean(busy)}>
                Confirm rejection
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
};

export default PreOnboardingDetailPage;
