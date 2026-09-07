import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  Loader2,
  Lock,
  Paperclip,
  PhoneCall,
  Plus,
  Send,
} from 'lucide-react';
import bgvVerifierAuthService from '../../../services/bgvVerifierAuthService.js';
import { CONCLUSION_COPY, METHOD_FIELDS, METHOD_LABELS, OUTCOME_LABELS, severityLabel } from './fieldDefinitions.js';

// Phase 30.8 — verifier workbench panels. Structured per-method forms
// (never one giant free-text box); the activity timeline is append-only;
// after final submission everything renders read-only (locked). Notes and
// external-response text render as escaped React text — no HTML is ever
// interpreted. No conclusion control offers CANCELLED (platform-only).

const inputClass = 'input';

const ObservationField = ({ field, value, onChange }) => {
  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-xs text-crewly-dim">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(field.key, event.target.checked)}
          className="h-4 w-4 rounded border-crewly-border"
        />
        {field.label}
      </label>
    );
  }
  if (field.type === 'enum') {
    return (
      <div>
        <label className="label" htmlFor={`obs-${field.key}`}>{field.label}</label>
        <select id={`obs-${field.key}`} className={inputClass} value={value ?? ''} onChange={(event) => onChange(field.key, event.target.value)}>
          <option value="">Select…</option>
          {field.options.map((option) => (
            <option key={option} value={option}>{option.replaceAll('_', ' ')}</option>
          ))}
        </select>
      </div>
    );
  }
  if (field.type === 'date') {
    return (
      <div>
        <label className="label" htmlFor={`obs-${field.key}`}>{field.label}</label>
        <input id={`obs-${field.key}`} type="date" className={inputClass} value={value ?? ''} onChange={(event) => onChange(field.key, event.target.value)} />
      </div>
    );
  }
  if (field.type === 'number') {
    return (
      <div>
        <label className="label" htmlFor={`obs-${field.key}`}>{field.label}</label>
        <input id={`obs-${field.key}`} type="number" min={1} className={inputClass} value={value ?? ''} onChange={(event) => onChange(field.key, event.target.value)} />
      </div>
    );
  }
  return (
    <div>
      <label className="label" htmlFor={`obs-${field.key}`}>{field.label}</label>
      <input
        id={`obs-${field.key}`}
        className={inputClass}
        maxLength={field.max || 500}
        placeholder={field.placeholder || ''}
        value={value ?? ''}
        onChange={(event) => onChange(field.key, event.target.value)}
      />
    </div>
  );
};

export const ActivityForm = ({ orderId, checkType, workbench, onRecorded, onError }) => {
  const [method, setMethod] = useState('');
  const [outcome, setOutcome] = useState('');
  const [observations, setObservations] = useState({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const fields = METHOD_FIELDS[`${checkType}:${method}`] || [];
  const outcomes = workbench.methodOutcomes?.[method] || [];

  const submit = async () => {
    setBusy(true);
    try {
      await bgvVerifierAuthService.recordActivity(orderId, checkType, {
        method,
        outcome,
        observations,
        notes,
      });
      setMethod('');
      setOutcome('');
      setObservations({});
      setNotes('');
      await onRecorded();
    } catch (requestError) {
      onError(requestError?.message || 'Could not record activity');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2 className="mb-3 text-sm font-semibold text-crewly-text">Record verification activity</h2>
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="wb-method">Method (controlled registry)</label>
          <select
            id="wb-method"
            className={inputClass}
            value={method}
            onChange={(event) => {
              setMethod(event.target.value);
              setOutcome('');
              setObservations({});
            }}
          >
            <option value="">Select method…</option>
            {workbench.allowedMethods.map((entry) => (
              <option key={entry} value={entry}>{METHOD_LABELS[entry] || entry}</option>
            ))}
          </select>
        </div>
        {method ? (
          <>
            <div>
              <label className="label" htmlFor="wb-outcome">Attempt outcome</label>
              <select id="wb-outcome" className={inputClass} value={outcome} onChange={(event) => setOutcome(event.target.value)}>
                <option value="">Select outcome…</option>
                {outcomes.map((entry) => (
                  <option key={entry} value={entry}>{OUTCOME_LABELS[entry] || entry}</option>
                ))}
              </select>
            </div>
            {method.includes('DIGILOCKER') ? (
              <p className="rounded-lg border border-crewly-border bg-crewly-bg/60 px-3 py-2 text-[11px] text-crewly-dim">
                Manual / issuer-assisted only. Crewly has NO DigiLocker API integration — never enter DigiLocker passwords or OTPs; this form
                records what YOU established through an available official/public mechanism.
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              {fields.map((field) => (
                <ObservationField
                  key={field.key}
                  field={field}
                  value={observations[field.key]}
                  onChange={(key, value) => setObservations((current) => ({ ...current, [key]: value }))}
                />
              ))}
            </div>
            <div>
              <label className="label" htmlFor="wb-notes">Verifier notes (supplement — max 2000 characters)</label>
              <textarea
                id="wb-notes"
                className={`${inputClass} min-h-20`}
                maxLength={2000}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
            <button type="button" onClick={submit} disabled={busy || !method || !outcome} className="btn-primary gap-2 !px-4 !py-2 text-sm">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Record activity
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
};

export const ActivityTimeline = ({ workbench, onDownloadEvidence, downloading }) => (
  <section className="card">
    <h2 className="mb-3 text-sm font-semibold text-crewly-text">Verification activity timeline</h2>
    {workbench.activities.length === 0 ? (
      <p className="text-xs text-crewly-dim">No activities recorded yet. Attempts append — history is never overwritten.</p>
    ) : (
      <ol className="space-y-3">
        {workbench.activities.map((activity) => (
          <li key={activity.seq} className="rounded-lg border border-crewly-border bg-crewly-bg/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-crewly-text">
                Attempt {activity.seq} · {METHOD_LABELS[activity.method] || activity.method}
              </p>
              <span className="badge bg-crewly-green/10 text-crewly-green">
                {OUTCOME_LABELS[activity.outcome] || activity.outcome}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-crewly-dim">
              {new Date(activity.at).toLocaleString()} · verifier {activity.verifierId.slice(-6)}
            </p>
            {Object.keys(activity.observations || {}).length > 0 ? (
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                {Object.entries(activity.observations).map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-crewly-dim">{key}</dt>
                    {/* Rendered as escaped text — untrusted input never becomes HTML. */}
                    <dd className="text-crewly-text">{value instanceof Object ? JSON.stringify(value) : String(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {activity.notes ? <p className="mt-2 whitespace-pre-wrap text-xs text-crewly-text">{activity.notes}</p> : null}
            {activity.evidenceFileId ? (
              <button
                type="button"
                onClick={() => onDownloadEvidence(activity.evidenceFileId)}
                disabled={downloading === activity.evidenceFileId}
                className="btn-ghost mt-2 gap-2 !px-3 !py-1.5 text-xs"
              >
                {downloading === activity.evidenceFileId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Download attached evidence
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    )}
  </section>
);

export const EvidenceUploadPanel = ({ orderId, checkType, workbench, onUploaded, onError }) => {
  const [activitySeq, setActivitySeq] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  const upload = async () => {
    setBusy(true);
    try {
      const formData = new FormData();
      formData.append('activitySeq', String(activitySeq));
      formData.append('file', file);
      await bgvVerifierAuthService.uploadActivityEvidence(orderId, checkType, formData);
      setFile(null);
      setActivitySeq('');
      await onUploaded();
    } catch (requestError) {
      onError(requestError?.message || 'Could not upload evidence');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2 className="mb-1 text-sm font-semibold text-crewly-text">Attach verifier evidence</h2>
      <p className="mb-3 text-[11px] text-crewly-dim">
        Official responses, issuer-verification screenshots, field photos. Private storage — never a public URL. PDF/JPG/PNG/WEBP only.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="ev-seq">Activity</label>
          <select id="ev-seq" className={`${inputClass} !w-auto`} value={activitySeq} onChange={(event) => setActivitySeq(event.target.value)}>
            <option value="">Select activity…</option>
            {workbench.activities.map((activity) => (
              <option key={activity.seq} value={activity.seq}>
                Attempt {activity.seq} · {METHOD_LABELS[activity.method] || activity.method}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="ev-file">File</label>
          <input id="ev-file" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={(event) => setFile(event.target.files?.[0] || null)} />
        </div>
        <button type="button" onClick={upload} disabled={busy || !activitySeq || !file} className="btn-primary gap-2 !px-4 !py-2 text-sm">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />} Attach
        </button>
      </div>
    </section>
  );
};

export const DiscrepancyPanel = ({ orderId, checkType, workbench, onRecorded, onError }) => {
  const [form, setForm] = useState({ field: '', candidateClaimed: '', sourceConfirmed: '', severity: 'INFO', explanation: '' });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await bgvVerifierAuthService.recordDiscrepancy(orderId, checkType, form);
      setForm({ field: '', candidateClaimed: '', sourceConfirmed: '', severity: 'INFO', explanation: '' });
      await onRecorded();
    } catch (requestError) {
      onError(requestError?.message || 'Could not record discrepancy');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2 className="mb-1 text-sm font-semibold text-crewly-text">Discrepancies</h2>
      <p className="mb-3 text-[11px] text-crewly-dim">
        Structured findings for human HR/QA review — never a hiring decision; severity never rejects a candidate.
      </p>
      {workbench.discrepancies.length > 0 ? (
        <ul className="mb-4 space-y-2">
          {workbench.discrepancies.map((entry, index) => (
            <li key={index} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
              <p className="flex items-center gap-2 font-semibold text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" /> {entry.field} · {severityLabel(entry.severity)}
              </p>
              <p className="mt-1 text-crewly-dim">Candidate claimed: <span className="text-crewly-text">{entry.candidateClaimed}</span></p>
              <p className="text-crewly-dim">Source confirmed: <span className="text-crewly-text">{entry.sourceConfirmed}</span></p>
              <p className="mt-1 text-crewly-text">{entry.explanation}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-xs text-crewly-dim">No discrepancies recorded.</p>
      )}
      {!workbench.locked ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="dp-field">Field</label>
            <input id="dp-field" className={inputClass} maxLength={80} value={form.field} onChange={(event) => setForm((c) => ({ ...c, field: event.target.value }))} placeholder="e.g. EMPLOYMENT_END_DATE" />
          </div>
          <div>
            <label className="label" htmlFor="dp-sev">Severity</label>
            <select id="dp-sev" className={inputClass} value={form.severity} onChange={(event) => setForm((c) => ({ ...c, severity: event.target.value }))}>
              <option value="INFO">Info</option>
              <option value="MINOR">Minor</option>
              <option value="MAJOR">Major</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="dp-claimed">Candidate claimed</label>
            <input id="dp-claimed" className={inputClass} maxLength={300} value={form.candidateClaimed} onChange={(event) => setForm((c) => ({ ...c, candidateClaimed: event.target.value }))} />
          </div>
          <div>
            <label className="label" htmlFor="dp-source">Source confirmed</label>
            <input id="dp-source" className={inputClass} maxLength={300} value={form.sourceConfirmed} onChange={(event) => setForm((c) => ({ ...c, sourceConfirmed: event.target.value }))} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="dp-exp">Explanation</label>
            <input id="dp-exp" className={inputClass} maxLength={1000} value={form.explanation} onChange={(event) => setForm((c) => ({ ...c, explanation: event.target.value }))} />
          </div>
          <div className="sm:col-span-2">
            <button type="button" onClick={submit} disabled={busy || !form.field || !form.candidateClaimed || !form.sourceConfirmed || !form.explanation} className="btn-primary gap-2 !px-4 !py-2 text-sm">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />} Record discrepancy
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
};

export const ConclusionPanel = ({ orderId, checkType, workbench, onSubmitted, onError }) => {
  const [conclusion, setConclusion] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await bgvVerifierAuthService.submitConclusion(orderId, checkType, { conclusion, reason });
      setConfirming(false);
      await onSubmitted();
    } catch (requestError) {
      onError(requestError?.message || 'Submission blocked by validation');
    } finally {
      setBusy(false);
    }
  };

  if (workbench.conclusion) {
    return (
      <section className="card border-crewly-green/40">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-crewly-text">
          <Lock className="h-4 w-4 text-crewly-green" /> Final conclusion — submitted &amp; locked
        </h2>
        <p className="mt-2 text-sm font-semibold text-crewly-green">{workbench.conclusion.value.replaceAll('_', ' ')}</p>
        {workbench.conclusion.reason ? <p className="mt-1 text-xs text-crewly-dim">{workbench.conclusion.reason}</p> : null}
        <p className="mt-2 text-[11px] text-crewly-dim">
          Submitted {new Date(workbench.conclusion.submittedAt).toLocaleString()} · {workbench.conclusion.activityCountAtSubmission} activities on
          record. Editing is locked; QA review arrives in a later phase.
        </p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2 className="mb-1 text-sm font-semibold text-crewly-text">Final conclusion</h2>
      <p className="mb-3 text-[11px] text-crewly-dim">
        A conclusion is a BGV finding for human review — it never rejects, selects, or hires a candidate, and it never clears the whole BGV.
      </p>
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="wb-conclusion">Conclusion</label>
          <select id="wb-conclusion" className={inputClass} value={conclusion} onChange={(event) => setConclusion(event.target.value)}>
            <option value="">Select conclusion…</option>
            {workbench.verifierConclusions.map((entry) => (
              <option key={entry} value={entry}>{CONCLUSION_COPY[entry]?.label || entry}</option>
            ))}
          </select>
        </div>
        {conclusion ? <p className="text-[11px] text-crewly-dim">{CONCLUSION_COPY[conclusion]?.hint}</p> : null}
        {['UNABLE_TO_VERIFY', 'INCONCLUSIVE'].includes(conclusion) ? (
          <div>
            <label className="label" htmlFor="wb-reason">Reason / explanation (min 10 characters)</label>
            <textarea id="wb-reason" className={`${inputClass} min-h-20`} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
        ) : null}
        {!confirming ? (
          <button type="button" onClick={() => setConfirming(true)} disabled={!conclusion} className="btn-primary gap-2 !px-4 !py-2 text-sm">
            <Send className="h-4 w-4" /> Submit conclusion
          </button>
        ) : (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="text-xs text-amber-300">
              Submitting <strong>{conclusion.replaceAll('_', ' ')}</strong> locks this check. History and findings cannot be edited afterwards.
            </p>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={submit} disabled={busy} className="btn-primary gap-2 !px-4 !py-2 text-sm">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Confirm submission
              </button>
              <button type="button" onClick={() => setConfirming(false)} className="btn-ghost gap-2 !px-4 !py-2 text-sm">Cancel</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

export const StateBadgeRow = ({ orderId, checkType, workbench, onChanged, onError }) => {
  const [busy, setBusy] = useState(false);
  const toggle = async (next) => {
    setBusy(true);
    try {
      await bgvVerifierAuthService.setWorkbenchState(orderId, checkType, next);
      await onChanged();
    } catch (requestError) {
      onError(requestError?.message || 'Could not update state');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="badge bg-crewly-green/10 text-crewly-green">
        {workbench.state === 'AWAITING_THIRD_PARTY' ? (
          <Clock3 className="mr-1 inline h-3.5 w-3.5" />
        ) : (
          <PhoneCall className="mr-1 inline h-3.5 w-3.5" />
        )}
        {workbench.state.replaceAll('_', ' ')}
      </span>
      {!workbench.locked ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => toggle(workbench.state === 'AWAITING_THIRD_PARTY' ? 'IN_PROGRESS' : 'AWAITING_THIRD_PARTY')}
          className="btn-ghost gap-2 !px-3 !py-1.5 text-xs"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock3 className="h-4 w-4" />}
          {workbench.state === 'AWAITING_THIRD_PARTY' ? 'Resume work' : 'Mark awaiting third party'}
        </button>
      ) : null}
    </div>
  );
};
