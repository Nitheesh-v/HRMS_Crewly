import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Download, FileText, Loader2, Play } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import bgvVerifierAuthService from '../../services/bgvVerifierAuthService.js';
import {
  ActivityForm,
  ActivityTimeline,
  ConclusionPanel,
  DiscrepancyPanel,
  EvidenceUploadPanel,
  StateBadgeRow,
} from './workbench/WorkbenchPanels.jsx';

// Phase 30.7 — minimum-data detail for ONE assigned check. The backend
// projects only what this check type needs (no giant candidate object, no
// other checks, no payment data). Evidence downloads stream through the
// authenticated session; there are no public file URLs. No conclusion
// controls exist here — PASS/FAIL/VERIFIED belong to Phase 30.8.
const BgvVerifierCheckDetailPage = () => {
  const { orderId, checkType } = useParams();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await bgvVerifierAuthService.workDetail(orderId, checkType);
      setDetail(result);
    } catch (requestError) {
      if (requestError?.status === 401 || requestError?.status === 403) {
        bgvVerifierAuthService.clearToken();
        window.location.assign('/bgv-verifier/login');
        return;
      }
      setError(requestError?.message || 'Could not load check details');
    }
  }, [orderId, checkType]);

  useEffect(() => {
    document.title = `${String(checkType || '').toUpperCase()} verification — Crewly BGV Operations`;
    load();
  }, [load, checkType]);

  const start = async () => {
    setBusy('start');
    setError('');
    try {
      await bgvVerifierAuthService.startWork(orderId, checkType);
      await load();
    } catch (requestError) {
      setError(requestError?.message || 'Could not start verification');
    } finally {
      setBusy('');
    }
  };

  const download = async (file) => {
    setBusy(file.id);
    setError('');
    try {
      const blob = await bgvVerifierAuthService.downloadEvidence(file.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (requestError) {
      setError(requestError?.message || 'Could not download evidence');
    } finally {
      setBusy('');
    }
  };

  const downloadVerifierFile = async (fileId) => {
    setBusy(fileId);
    setError('');
    try {
      const blob = await bgvVerifierAuthService.downloadVerifierEvidence(fileId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `verifier-evidence-${fileId}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (requestError) {
      setError(requestError?.message || 'Could not download verifier evidence');
    } finally {
      setBusy('');
    }
  };

  const renderAddress = (address) => (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      {Object.entries(address || {})
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-xs text-crewly-dim">{key}</dt>
            <dd className="text-crewly-text">{String(value)}</dd>
          </div>
        ))}
    </dl>
  );

  return (
    <div className="min-h-screen bg-crewly-bg">
      <header className="border-b border-crewly-border bg-crewly-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
          <div>
            <p className="text-sm font-black text-crewly-text">
              {String(checkType || '').toUpperCase()}{' '}
              <span className="text-crewly-green">Verification</span>
            </p>
            <p className="text-[11px] text-crewly-dim">
              {detail ? `${detail.candidateName || detail.identity?.legalName || ''} · ${detail.companyName} · ${detail.orderCode}` : 'Loading…'}
            </p>
          </div>
          <Link to="/bgv-verifier/work" className="btn-ghost gap-2 !px-4 !py-2 text-sm">
            <ArrowLeft className="h-4 w-4" /> My work
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-4 px-4 py-8">
        {error ? <div className="card border-rose-500/40 text-sm text-rose-300">{error}</div> : null}

        {detail === null && !error ? (
          <div className="card flex items-center gap-2 text-sm text-crewly-dim">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading check details…
          </div>
        ) : null}

        {detail ? (
          <>
            <div className="card flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs text-crewly-dim">Operational state</p>
                <span
                  className={`badge mt-1 inline-block ${detail.status === 'IN_PROGRESS' ? 'bg-amber-500/10 text-amber-300' : 'bg-crewly-green/10 text-crewly-green'}`}
                >
                  {detail.status.replaceAll('_', ' ')}
                </span>
              </div>
              {detail.workbench ? (
                <StateBadgeRow orderId={orderId} checkType={checkType} workbench={detail.workbench} onChanged={load} onError={setError} />
              ) : null}
              {detail.status === 'ASSIGNED' ? (
                <button type="button" onClick={start} disabled={busy === 'start'} className="btn-primary gap-2 !px-4 !py-2 text-sm">
                  {busy === 'start' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  Start verification
                </button>
              ) : null}
            </div>

            {detail.identity ? (
              <section className="card">
                <h2 className="mb-3 text-sm font-semibold text-crewly-text">Identity context</h2>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-xs text-crewly-dim">Legal name</dt>
                  <dd className="text-crewly-text">{detail.identity.legalName}</dd>
                  <dt className="text-xs text-crewly-dim">Date of birth</dt>
                  <dd className="text-crewly-text">
                    {detail.identity.dateOfBirth ? new Date(detail.identity.dateOfBirth).toLocaleDateString() : '—'}
                  </dd>
                  <dt className="text-xs text-crewly-dim">Document type</dt>
                  <dd className="text-crewly-text">{detail.identity.documentType || '—'}</dd>
                  <dt className="text-xs text-crewly-dim">Identifier</dt>
                  <dd className="font-mono text-crewly-text">{detail.identity.identifierMasked || '—'}</dd>
                </dl>
                <p className="mt-3 text-[11px] text-crewly-dim">
                  Provenance: {detail.identity.provenance}. Uploaded copies are candidate-provided evidence — not e-KYC or DigiLocker verified.
                </p>
              </section>
            ) : null}

            {detail.address ? (
              <section className="card">
                <h2 className="mb-3 text-sm font-semibold text-crewly-text">Address submitted</h2>
                {renderAddress(detail.address)}
              </section>
            ) : null}

            {detail.educations ? (
              <section className="card space-y-3">
                <h2 className="text-sm font-semibold text-crewly-text">Education records</h2>
                {detail.educations.length === 0 ? <p className="text-xs text-crewly-dim">No education records submitted.</p> : null}
                {detail.educations.map((record) => (
                  <div key={record.id} className="rounded-lg border border-crewly-border bg-crewly-bg/60 p-3 text-sm">
                    <p className="font-semibold text-crewly-text">{record.institution}</p>
                    <p className="text-xs text-crewly-dim">
                      {[record.qualification, record.specialization, record.universityBoard].filter(Boolean).join(' · ')}
                    </p>
                    <p className="mt-1 text-xs text-crewly-dim">
                      {record.startYear || '?'} – {record.endYear || '?'}
                      {record.location ? ` · ${record.location}` : ''}
                    </p>
                  </div>
                ))}
              </section>
            ) : null}

            {detail.employments ? (
              <section className="card space-y-3">
                <h2 className="text-sm font-semibold text-crewly-text">Employment records</h2>
                {detail.employments.length === 0 ? <p className="text-xs text-crewly-dim">No employment records submitted.</p> : null}
                {detail.employments.map((record) => (
                  <div key={record.id} className="rounded-lg border border-crewly-border bg-crewly-bg/60 p-3 text-sm">
                    <p className="font-semibold text-crewly-text">{record.employer}</p>
                    <p className="text-xs text-crewly-dim">
                      {record.designation}
                      {record.employeeId ? ` · Emp ID ${record.employeeId}` : ''} · {record.employmentType}
                    </p>
                    <p className="mt-1 text-xs text-crewly-dim">
                      {new Date(record.startDate).toLocaleDateString()} – {record.endDate ? new Date(record.endDate).toLocaleDateString() : 'present'}
                    </p>
                    {record.hrContactName || record.hrContactEmail ? (
                      <p className="mt-1 text-xs text-crewly-dim">
                        HR contact: {[record.hrContactName, record.hrContactEmail].filter(Boolean).join(' · ')}
                      </p>
                    ) : null}
                  </div>
                ))}
              </section>
            ) : null}

            {detail.references ? (
              <section className="card space-y-3">
                <h2 className="text-sm font-semibold text-crewly-text">References submitted</h2>
                {detail.references.length === 0 ? <p className="text-xs text-crewly-dim">No references submitted.</p> : null}
                {detail.references.map((record) => (
                  <div key={record.id} className="rounded-lg border border-crewly-border bg-crewly-bg/60 p-3 text-sm">
                    <p className="font-semibold text-crewly-text">{record.name}</p>
                    <p className="text-xs text-crewly-dim">
                      {[record.designation, record.organization, record.relationship].filter(Boolean).join(' · ')}
                    </p>
                    {record.email || record.phone ? (
                      <p className="mt-1 text-xs text-crewly-dim">{[record.email, record.phone].filter(Boolean).join(' · ')}</p>
                    ) : null}
                  </div>
                ))}
              </section>
            ) : null}

            <section className="card">
              <h2 className="mb-3 text-sm font-semibold text-crewly-text">Evidence files</h2>
              {(detail.files || []).length === 0 ? (
                <p className="text-xs text-crewly-dim">No evidence files for this check.</p>
              ) : (
                <ul className="space-y-2">
                  {detail.files.map((file) => (
                    <li key={file.id} className="flex items-center justify-between rounded-lg border border-crewly-border bg-crewly-bg/60 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-crewly-green" />
                        <div>
                          <p className="text-sm text-crewly-text">{file.fileName}</p>
                          <p className="text-[11px] text-crewly-dim">
                            {file.category.replaceAll('_', ' ')} · v{file.version} · {(file.fileSize / 1024).toFixed(0)} KB
                          </p>
                        </div>
                      </div>
                      <button type="button" onClick={() => download(file)} disabled={busy === file.id} className="btn-ghost gap-2 !px-3 !py-1.5 text-xs">
                        {busy === file.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Phase 30.8 — verification workbench (this check only). */}
            {detail.workbench ? (
              <>
                <ActivityForm orderId={orderId} checkType={detail.checkType} workbench={detail.workbench} onRecorded={load} onError={setError} />
                <ActivityTimeline workbench={detail.workbench} onDownloadEvidence={downloadVerifierFile} downloading={busy} />
                {detail.workbench.locked ? null : (
                  <EvidenceUploadPanel orderId={orderId} checkType={detail.checkType} workbench={detail.workbench} onUploaded={load} onError={setError} />
                )}
                <DiscrepancyPanel orderId={orderId} checkType={detail.checkType} workbench={detail.workbench} onRecorded={load} onError={setError} />
                <ConclusionPanel orderId={orderId} checkType={detail.checkType} workbench={detail.workbench} onSubmitted={load} onError={setError} />
              </>
            ) : null}

            <p className="text-[11px] text-crewly-dim">
              Conclusions are BGV findings for human HR/QA review — they never reject, select, or hire a candidate, and they never clear the
              whole BGV. Access is limited to this assigned check only.
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
};

export default BgvVerifierCheckDetailPage;
