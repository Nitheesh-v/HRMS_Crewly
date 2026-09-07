import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Download, Loader2, MailQuestion, Send, XCircle } from 'lucide-react';
import bgvVerifierAuthService from '../../../services/bgvVerifierAuthService.js';

// Phase 30.9 — additional information requests (verifier side).
// Categories mirror the backend allowlist; the backend re-validates.
// Crewly sends the candidate notification — no manual email copying, no
// raw tokens anywhere in this UI. Requests never conclude or reject.

const CATEGORIES = {
  IDENTITY: [
    ['CLEARER_DOCUMENT', 'Clearer identity document'],
    ['ALTERNATE_ID_DOCUMENT', 'Alternate approved ID document'],
    ['SELFIE_REUPLOAD', 'New selfie / current photograph'],
    ['NAME_CLARIFICATION', 'Name clarification'],
    ['DOB_CLARIFICATION', 'Date of birth clarification'],
    ['OTHER_IDENTITY_CLARIFICATION', 'Other identity clarification'],
  ],
  ADDRESS: [
    ['CLEARER_ADDRESS_PROOF', 'Clearer address proof'],
    ['RECENT_ADDRESS_PROOF', 'More recent address proof'],
    ['ADDRESS_CLARIFICATION', 'Address clarification'],
    ['CONTACT_CLARIFICATION', 'Contact clarification'],
  ],
  EDUCATION: [
    ['CLEARER_CERTIFICATE', 'Clearer certificate'],
    ['MARKSHEET', 'Marksheet'],
    ['ENROLLMENT_NUMBER', 'Enrollment number'],
    ['INSTITUTION_DETAILS', 'Institution details'],
    ['PASSING_YEAR_CLARIFICATION', 'Passing year clarification'],
    ['OTHER_EDUCATION_EVIDENCE', 'Other education evidence'],
  ],
  EMPLOYMENT: [
    ['CLEARER_EMPLOYMENT_DOCUMENT', 'Clearer employment document'],
    ['EXPERIENCE_LETTER', 'Experience letter'],
    ['RELIEVING_LETTER', 'Relieving letter'],
    ['EMPLOYEE_ID', 'Employee ID'],
    ['EMPLOYMENT_DATES', 'Corrected employment dates'],
    ['HR_CONTACT', 'Verifiable HR contact'],
    ['OTHER_EMPLOYMENT_EVIDENCE', 'Other employment evidence'],
  ],
  REFERENCE: [
    ['REFERENCE_CONTACT_CORRECTION', 'Corrected reference contact'],
    ['ALTERNATE_REFERENCE', 'Alternate professional reference'],
    ['RELATIONSHIP_CLARIFICATION', 'Relationship clarification'],
    ['REFERENCE_DETAILS', 'Reference details'],
  ],
};

const STATUS_BADGE = {
  OPEN: 'bg-sky-500/10 text-sky-300',
  CANDIDATE_RESPONDED: 'bg-emerald-500/10 text-emerald-300',
  RESOLVED: 'bg-crewly-green/10 text-crewly-green',
  CANCELLED: 'bg-slate-500/10 text-slate-400',
};

const STATUS_LABEL = {
  OPEN: 'Waiting for candidate',
  CANDIDATE_RESPONDED: 'Candidate responded',
  RESOLVED: 'Resolved',
  CANCELLED: 'Cancelled',
};

const InfoRequestPanel = ({ orderId, checkType, workbench, onChanged, onError }) => {
  const [requests, setRequests] = useState(null);
  const [category, setCategory] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [confirming, setConfirming] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await bgvVerifierAuthService.infoRequests(orderId, checkType);
      setRequests(result.requests || []);
    } catch (requestError) {
      onError(requestError?.message || 'Could not load information requests');
    }
  }, [orderId, checkType, onError]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    setBusy('create');
    try {
      await bgvVerifierAuthService.createInfoRequest(orderId, checkType, { category, message });
      setCategory('');
      setMessage('');
      await Promise.all([load(), onChanged()]);
    } catch (requestError) {
      onError(requestError?.message || 'Could not create the request');
    } finally {
      setBusy('');
    }
  };

  const resolve = async (requestId) => {
    setBusy(requestId);
    try {
      await bgvVerifierAuthService.resolveInfoRequest(requestId, { orderId, checkType });
      await Promise.all([load(), onChanged()]);
    } catch (requestError) {
      onError(requestError?.message || 'Could not resolve the request');
    } finally {
      setBusy('');
    }
  };

  const cancel = async (requestId) => {
    setBusy(requestId);
    try {
      await bgvVerifierAuthService.cancelInfoRequest(requestId, { orderId, checkType });
      await Promise.all([load(), onChanged()]);
    } catch (requestError) {
      onError(requestError?.message || 'Could not cancel the request');
    } finally {
      setBusy('');
    }
  };

  const download = async (file) => {
    setBusy(file.id);
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
      onError(requestError?.message || 'Could not download the response file');
    } finally {
      setBusy('');
    }
  };

  const options = CATEGORIES[checkType] || [];

  return (
    <section className="card">
      <h2 className="mb-1 text-sm font-semibold text-crewly-text">Additional information requests</h2>
      <p className="mb-3 text-[11px] text-crewly-dim">
        Ask the candidate for a correction or clearer document through Crewly. The candidate responds in the secure portal; nothing here
        concludes, rejects, or charges anything.
      </p>

      {(requests || []).length > 0 ? (
        <ul className="mb-4 space-y-2">
          {requests.map((request) => (
            <li key={request.id} className="rounded-lg border border-crewly-border bg-crewly-bg/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-crewly-text">{request.categoryLabel}</p>
                <span className={`badge ${STATUS_BADGE[request.status] || 'bg-slate-500/10 text-slate-400'}`}>
                  {STATUS_LABEL[request.status] || request.status}
                </span>
              </div>
              {request.message ? <p className="mt-1 text-xs text-crewly-dim">{request.message}</p> : null}
              <p className="mt-1 text-[11px] text-crewly-dim">Requested {new Date(request.requestedAt).toLocaleString()}</p>

              {request.status === 'CANDIDATE_RESPONDED' ? (
                <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2">
                  <p className="text-xs font-semibold text-emerald-300">Candidate responded</p>
                  {request.response?.text ? <p className="mt-1 whitespace-pre-wrap text-xs text-crewly-text">{request.response.text}</p> : null}
                  {(request.responseFiles || []).map((file) => (
                    <button key={file.id} type="button" onClick={() => download(file)} disabled={busy === file.id} className="btn-ghost mt-2 gap-2 !px-3 !py-1.5 text-xs">
                      {busy === file.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      {file.fileName} (v{file.version})
                    </button>
                  ))}
                  <p className="mt-1 text-[11px] text-crewly-dim">Response is evidence/input — review it; it is not automatically verified.</p>
                </div>
              ) : null}

              <div className="mt-2 flex gap-2">
                {request.status === 'CANDIDATE_RESPONDED' ? (
                  <button type="button" onClick={() => resolve(request.id)} disabled={Boolean(busy)} className="btn-primary gap-2 !px-3 !py-1.5 text-xs">
                    {busy === request.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Resolve
                  </button>
                ) : null}
                {request.status === 'OPEN' ? (
                  <button type="button" onClick={() => cancel(request.id)} disabled={Boolean(busy)} className="btn-ghost gap-2 !px-3 !py-1.5 text-xs text-rose-300">
                    {busy === request.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />} Cancel request
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-xs text-crewly-dim">No information requests for this check yet.</p>
      )}

      {!workbench?.locked ? (
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="ir-category">Request category ({checkType} only)</label>
            <select id="ir-category" className="input" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">Select category…</option>
              {options.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ir-message">Safe instructions for the candidate (optional, max 500)</label>
            <textarea id="ir-message" className="input min-h-16" maxLength={500} value={message} onChange={(event) => setMessage(event.target.value)} />
          </div>
          {confirming ? (
            <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
              <p className="text-xs text-sky-300">
                Crewly will email the candidate a secure portal link and this check will wait for the candidate. Duplicate open requests are
                returned idempotently — no spam.
              </p>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => { setConfirming(false); create(); }} disabled={busy === 'create'} className="btn-primary gap-2 !px-4 !py-2 text-sm">
                  {busy === 'create' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Confirm request
                </button>
                <button type="button" onClick={() => setConfirming(false)} className="btn-ghost gap-2 !px-4 !py-2 text-sm">Back</button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} disabled={!category} className="btn-primary gap-2 !px-4 !py-2 text-sm">
              <MailQuestion className="h-4 w-4" /> Request additional information
            </button>
          )}
        </div>
      ) : (
        <p className="text-xs text-crewly-dim">Findings are submitted — additional information now requires the QA workflow.</p>
      )}
    </section>
  );
};

export default InfoRequestPanel;
