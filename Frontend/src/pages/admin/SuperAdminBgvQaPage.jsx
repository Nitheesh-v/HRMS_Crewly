import { useCallback, useEffect, useState } from 'react';
import {
  BadgeCheck,
  Download,
  FileText,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Undo2,
} from 'lucide-react';
import superAdminService from '../../services/superAdminService.js';

// Phase 30.10 — internal BGV QA review + final report release.
// QA approves or returns verifier findings; it NEVER hires/rejects — those
// remain tenant HR decisions after release. Report generation/release are
// explicit, backend-gated actions (generated ≠ released).

const QA_BADGE = {
  PENDING: 'bg-sky-500/10 text-sky-300',
  APPROVED: 'bg-crewly-green/10 text-crewly-green',
  RETURNED: 'bg-amber-500/10 text-amber-300',
};

const SuperAdminBgvQaPage = () => {
  const [rows, setRows] = useState(null);
  const [filters, setFilters] = useState({ status: 'awaiting', checkType: '', orderCode: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [report, setReport] = useState(null);
  const [returnReason, setReturnReason] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await superAdminService.bgvQaQueue(filters);
      setRows(result.rows || []);
    } catch (requestError) {
      setError(requestError?.message || 'Could not load the QA queue');
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = async (row) => {
    setSelected(row);
    setReturnReason('');
    try {
      const [detailResult, reportResult] = await Promise.all([
        superAdminService.bgvQaDetail(row.orderId, row.checkType),
        superAdminService.bgvQaReportStatus(row.orderId),
      ]);
      setDetail(detailResult);
      setReport(reportResult);
    } catch (requestError) {
      setError(requestError?.message || 'Could not load QA detail');
    }
  };

  const act = async (key, action, message) => {
    setBusy(key);
    setError('');
    try {
      await action();
      setNotice(message);
      await load();
      if (selected) await openDetail(selected);
    } catch (requestError) {
      setError(requestError?.message || 'Action failed');
    } finally {
      setBusy('');
    }
  };

  const downloadBlob = async (promise, fallbackName) => {
    const blob = await promise;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fallbackName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-crewly-text">BGV QA Review</h1>
          <p className="text-xs text-crewly-dim">
            Internal quality control: review submitted verifier findings, approve or return them, and release the final report once every
            purchased check is QA-approved. QA never hires or rejects — tenant HR decides.
          </p>
        </div>
        <button type="button" onClick={load} className="btn-ghost gap-2 !px-3 !py-1.5 text-xs">
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {error ? <div className="rounded-lg border border-crewly-red/30 bg-crewly-red/10 p-3 text-xs text-crewly-red">{error}</div> : null}
      {notice ? <div className="rounded-lg border border-crewly-green/30 bg-crewly-green/10 p-3 text-xs text-crewly-green">{notice}</div> : null}

      <div className="card">
        <div className="mb-3 flex flex-wrap gap-2">
          <select className="input !w-44" value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
            <option value="awaiting">Awaiting QA</option>
            <option value="returned">Returned</option>
            <option value="approved">Approved</option>
            <option value="">All submitted</option>
          </select>
          <select className="input !w-40" value={filters.checkType} onChange={(event) => setFilters((current) => ({ ...current, checkType: event.target.value }))}>
            <option value="">All check types</option>
            {['IDENTITY', 'ADDRESS', 'EDUCATION', 'EMPLOYMENT', 'REFERENCE'].map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          <input
            className="input !w-48"
            placeholder="Order code…"
            value={filters.orderCode}
            onChange={(event) => setFilters((current) => ({ ...current, orderCode: event.target.value }))}
          />
        </div>

        {rows === null ? (
          <p className="text-xs text-crewly-dim">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-crewly-dim">No verifier-submitted work matches these filters.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-crewly-border text-crewly-dim">
                <th className="py-2 pr-3">ORDER</th>
                <th className="py-2 pr-3">TENANT</th>
                <th className="py-2 pr-3">CANDIDATE</th>
                <th className="py-2 pr-3">CHECK</th>
                <th className="py-2 pr-3">CONCLUSION</th>
                <th className="py-2 pr-3">QA</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.orderId}-${row.checkType}`} className="border-b border-crewly-border/50">
                  <td className="py-2 pr-3 font-mono text-crewly-text">{row.orderCode}</td>
                  <td className="py-2 pr-3">{row.tenantName}</td>
                  <td className="py-2 pr-3">{row.candidateName}</td>
                  <td className="py-2 pr-3">{row.checkType}</td>
                  <td className="py-2 pr-3">{(row.conclusion || '—').replaceAll('_', ' ')}</td>
                  <td className="py-2 pr-3">
                    <span className={`badge ${QA_BADGE[row.qaStatus] || 'bg-slate-500/10 text-slate-400'}`}>{row.qaStatus}</span>
                  </td>
                  <td className="py-2 text-right">
                    <button type="button" onClick={() => openDetail(row)} className="btn-ghost !px-3 !py-1 text-xs">Review</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && detail ? (
        <div className="card space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-crewly-text">
              {detail.order.orderCode} · {detail.check.checkType} · {detail.candidateName}
            </h2>
            <span className={`badge ${QA_BADGE[detail.check.qaStatus] || 'bg-slate-500/10 text-slate-400'}`}>{detail.check.qaStatus} · rev {detail.check.revision}</span>
          </div>
          <p className="text-[11px] text-crewly-dim">
            Tenant: {detail.tenantName} · Purchased: {(detail.purchasedChecks || []).join(', ')} · Identity:{' '}
            {(detail.identity || []).map((entry) => `${entry.documentType} ${entry.identifierMasked}`).join(', ') || '—'}
          </p>

          <div>
            <h3 className="label">Verification activities</h3>
            <ul className="space-y-1 text-xs text-crewly-text">
              {(detail.check.activities || []).map((activity) => (
                <li key={activity.seq} className="flex items-center gap-2">
                  <span className="font-mono text-crewly-dim">#{activity.seq}</span> {activity.method.replaceAll('_', ' ')} → {activity.outcome.replaceAll('_', ' ')}
                  {activity.hasEvidence ? <FileText className="h-3.5 w-3.5 text-sky-300" /> : null}
                </li>
              ))}
            </ul>
          </div>

          {(detail.evidence || []).length ? (
            <div>
              <h3 className="label">Supporting evidence (private)</h3>
              <div className="flex flex-wrap gap-2">
                {detail.evidence.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    disabled={busy === file.id}
                    onClick={() => act(file.id, () => downloadBlob(superAdminService.bgvQaEvidence(selected.orderId, selected.checkType, file.id), file.fileName), 'Evidence downloaded')}
                    className="btn-ghost gap-2 !px-3 !py-1.5 text-xs"
                  >
                    {busy === file.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    {file.fileName}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {(detail.check.discrepancies || []).length ? (
            <div>
              <h3 className="label">Discrepancies</h3>
              <ul className="space-y-1 text-xs">
                {detail.check.discrepancies.map((entry, index) => (
                  <li key={index} className="text-amber-300">
                    [{entry.severity}] {entry.field}: {entry.explanation}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <h3 className="label">Finding revisions (immutable history)</h3>
            <ul className="space-y-1 text-xs text-crewly-text">
              {(detail.check.submissions || []).map((submission) => (
                <li key={submission.revision} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">v{submission.revision}</span> {String(submission.conclusion || '').replaceAll('_', ' ')} —{' '}
                  <span className={`badge ${QA_BADGE[submission.qaStatus] || 'bg-slate-500/10 text-slate-400'}`}>{submission.qaStatus}</span>
                  {submission.qaReturnReason ? <span className="text-amber-300">“{submission.qaReturnReason}”</span> : null}
                </li>
              ))}
            </ul>
          </div>

          {(detail.infoRequests || []).length ? (
            <div>
              <h3 className="label">Additional-information history (30.9)</h3>
              <ul className="space-y-1 text-xs text-crewly-dim">
                {detail.infoRequests.map((request) => (
                  <li key={request.id}>{request.category} — {request.status}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {detail.check.qaStatus === 'PENDING' ? (
            <div className="flex flex-wrap items-end gap-3">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => act('approve', () => superAdminService.bgvQaApprove(selected.orderId, selected.checkType), 'Check approved')}
                className="btn-primary gap-2 !px-4 !py-2 text-sm"
              >
                {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />} Approve
              </button>
              <div className="min-w-56 flex-1 space-y-1">
                <input
                  className="input"
                  placeholder="Return reason (min 10 chars)…"
                  value={returnReason}
                  onChange={(event) => setReturnReason(event.target.value)}
                />
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => act('return', () => superAdminService.bgvQaReturn(selected.orderId, selected.checkType, { reason: returnReason }), 'Returned for correction')}
                  className="btn-ghost gap-2 !px-4 !py-2 text-sm text-amber-300"
                >
                  {busy === 'return' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Return for correction
                </button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-crewly-dim">
              {detail.check.qaStatus === 'RETURNED'
                ? `Returned to the current verifier: ${detail.check.qaReturnReason}`
                : 'Approved — this check now counts toward report readiness.'}
            </p>
          )}

          {report ? (
            <div className="rounded-lg border border-crewly-border bg-crewly-bg/60 p-3">
              <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold text-crewly-text">
                <ShieldCheck className="h-4 w-4 text-crewly-green" /> Final report
              </h3>
              {report.readiness?.ready ? (
                <p className="text-xs text-crewly-green">All purchased checks QA-approved — report eligible.</p>
              ) : (
                <ul className="text-xs text-crewly-dim">
                  {(report.readiness?.missing || []).map((entry) => (
                    <li key={entry}>• {entry}</li>
                  ))}
                </ul>
              )}
              {report.report ? (
                <p className="mt-1 text-xs text-crewly-text">
                  {report.report.reportNumber} v{report.report.version} — {report.report.status} · PDF {report.report.pdfStatus}
                  {report.report.overallOutcome ? ` · ${report.report.overallOutcome.replaceAll('_', ' ')}` : ''}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {!report.report ? (
                  <button
                    type="button"
                    disabled={!report.readiness?.ready || Boolean(busy)}
                    onClick={() => act('generate', () => superAdminService.bgvQaGenerateReport(selected.orderId), 'Report generated')}
                    className="btn-primary gap-2 !px-3 !py-1.5 text-xs"
                  >
                    {busy === 'generate' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Generate report
                  </button>
                ) : (
                  <>
                    {report.report.pdfStatus === 'FAILED' ? (
                      <button type="button" disabled={Boolean(busy)} onClick={() => act('retry', () => superAdminService.bgvQaRetryPdf(selected.orderId), 'PDF retried')} className="btn-ghost gap-2 !px-3 !py-1.5 text-xs">
                        {busy === 'retry' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Retry PDF
                      </button>
                    ) : null}
                    {report.report.status !== 'RELEASED' ? (
                      <button
                        type="button"
                        disabled={report.report.pdfStatus !== 'GENERATED' || Boolean(busy)}
                        onClick={() => act('release', () => superAdminService.bgvQaReleaseReport(selected.orderId), 'Report released to tenant HR')}
                        className="btn-primary gap-2 !px-3 !py-1.5 text-xs"
                      >
                        {busy === 'release' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Release to tenant
                      </button>
                    ) : (
                      <span className="badge bg-crewly-green/10 text-crewly-green">Released {report.report.releasedAt ? new Date(report.report.releasedAt).toLocaleString() : ''}</span>
                    )}
                    <button
                      type="button"
                      disabled={report.report.pdfStatus !== 'GENERATED' || Boolean(busy)}
                      onClick={() => act('download', () => downloadBlob(superAdminService.bgvQaDownloadReport(selected.orderId), `${report.report.reportNumber}.pdf`), 'Report downloaded')}
                      className="btn-ghost gap-2 !px-3 !py-1.5 text-xs"
                    >
                      <Download className="h-4 w-4" /> Download PDF
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export default SuperAdminBgvQaPage;
