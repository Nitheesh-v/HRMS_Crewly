// ============================================================
//  PHASE 30.1.1 — BGV Ops Check Detail (Crewly verifier workspace)
//
//  Ported from the retired 30.1 tenant page — the panels are the
//  same (entries, evidence, follow-up, the human-only status
//  machine), the OPERATOR is not: every action runs on the
//  platform API, the verifier picker lists Crewly users only, and
//  a tenant-context strip names which customer's data is open.
//  No tenant HR decision panel here (that is 30.7, tenant-side).
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Building2,
  CalendarClock,
  Camera,
  Download,
  FileText,
  Link2,
  MessageSquare,
  PhoneCall,
  Pin,
  RotateCcw,
  Send,
  UserPlus2,
  Video,
} from 'lucide-react';
import useAuth from '../../hooks/useAuth.jsx';
import superAdminBgvService from '../../services/superAdminBgvService.js';
import {
  CHECK_TYPE_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
} from './SuperAdminBgvWorkbenchPage.jsx';
import Modal from '../../components/Modal.jsx';

const KIND_META = {
  NOTE: { icon: MessageSquare, label: 'Note' },
  CALL_LOG: { icon: PhoneCall, label: 'Call log' },
  SCREENSHOT: { icon: Camera, label: 'Screenshot' },
  DOCUMENT: { icon: FileText, label: 'Document' },
  LINK: { icon: Link2, label: 'Link' },
  VIDEO_KYC_NOTE: { icon: Video, label: 'Video KYC note' },
  FIELD_VISIT: { icon: Pin, label: 'Field visit' },
};

const FIELD_KINDS = ['SCREENSHOT', 'DOCUMENT'];

const formatDate = (value) =>
  value ? new Date(value).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

const Chip = ({ status }) => (
  <span className={`rounded-full border px-2.5 py-0.5 text-xs ${STATUS_TONES[status] || ''}`}>
    {STATUS_LABELS[status] || status}
  </span>
);

const Field = ({ label, children }) => (
  <label className="block text-sm">
    <span className="mb-1.5 block text-crewly-dim">{label}</span>
    {children}
  </label>
);

const inputClass =
  'w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 py-2 text-sm outline-none transition focus:border-crewly-green';

const SuperAdminBgvCheckDetailPage = () => {
  const { checkId } = useParams();
  const { user } = useAuth();
  const canAssign = ['SUPER_ADMIN', 'PLATFORM_ADMIN'].includes(user?.role);
  const [check, setCheck] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState(null); // 'assign' | 'status' | 'evidence' | 'sla' | 'reopen'
  const [dialogTarget, setDialogTarget] = useState({ entryKey: null });
  const [form, setForm] = useState({});
  const [verifiers, setVerifiers] = useState([]);

  const load = useCallback(() => {
    setLoading(true);
    superAdminBgvService
      .detail(checkId)
      .then((data) => setCheck(data))
      .catch((err) => setError(err?.message || 'Could not load this check'))
      .finally(() => setLoading(false));
  }, [checkId]);

  useEffect(() => { load(); }, [load]);

  const openDialog = async (name, entryKey = null) => {
    setError('');
    setDialogTarget({ entryKey });
    setForm(name === 'status' ? { toStatus: 'IN_PROGRESS', resultSummary: '', discrepancyNote: '', closedReason: '', reason: '' } : {});
    setDialog(name);
    if (name === 'assign') {
      try {
        setVerifiers(await superAdminBgvService.verifiers());
      } catch {
        setVerifiers([]);
      }
    }
  };

  const isTerminal = useMemo(() => ['VERIFIED', 'UTV', 'SKIPPED'].includes(check?.status), [check]);

  const statusTargets = useMemo(() => {
    if (!check) return [];
    if (isTerminal) return [];
    const options = ['IN_PROGRESS', 'VERIFIED', 'DISCREPANCY', 'UTV', 'INSUFFICIENT_DATA'];
    if (!check.isRequired) options.push('SKIPPED');
    return options;
  }, [check, isTerminal]);

  const submit = async (action) => {
    setError('');
    setNotice('');
    try {
      if (action === 'assign') {
        await superAdminBgvService.assign(check.id, form.verifierId);
        setNotice('Verifier assigned.');
      } else if (action === 'status') {
        await superAdminBgvService.updateStatus(check.id, {
          entryKey: dialogTarget.entryKey || undefined,
          toStatus: form.toStatus,
          resultSummary: form.resultSummary || undefined,
          discrepancyNote: form.discrepancyNote || undefined,
          reason: form.reason || undefined,
          followUp: form.closedReason ? { closedReason: form.closedReason } : undefined,
        });
        setNotice('Status updated. Every change is recorded in the audit trail as a platform action.');
      } else if (action === 'sla') {
        await superAdminBgvService.extendSla(check.id, { days: Number(form.days), reason: form.reason });
        setNotice('SLA extended once for this check.');
      } else if (action === 'reopen') {
        await superAdminBgvService.reopen(check.id, form.reason);
        setNotice('Check reopened for verification.');
      } else if (action === 'evidence') {
        const payload = new FormData();
        if (dialogTarget.entryKey) payload.append('entryKey', dialogTarget.entryKey);
        payload.append('kind', form.kind || 'NOTE');
        if (form.note) payload.append('note', form.note);
        const meta = {};
        if (form.kind === 'CALL_LOG') Object.assign(meta, { phone: form.phone, durationSec: Number(form.durationSec || 0), outcome: form.outcome });
        if (form.kind === 'LINK') Object.assign(meta, { url: form.url });
        if (form.kind === 'FIELD_VISIT') Object.assign(meta, { geoLat: form.geoLat, geoLng: form.geoLng, geoAccuracyM: form.geoAccuracy });
        payload.append('meta', JSON.stringify(meta));
        if (form.file) payload.append('file', form.file);
        await superAdminBgvService.addEvidence(check.id, payload);
        setNotice('Evidence added.');
      }
      setDialog(null);
      load();
    } catch (err) {
      setError(err?.message || 'This action could not be completed');
    }
  };

  const submitEvidence = (event) => {
    event.preventDefault();
    submit('evidence');
  };

  const download = async (evidence) => {
    setError('');
    try {
      await superAdminBgvService.downloadEvidence(check.id, evidence.id, evidence.filename || 'evidence');
    } catch (err) {
      setError(err?.message || 'Evidence could not be downloaded');
    }
  };

  if (loading) return <p className="text-sm text-crewly-dim">Loading check…</p>;
  if (!check) {
    return (
      <div className="space-y-4">
        <Link to="/super-admin/bgv" className="flex items-center gap-1.5 text-sm text-crewly-dim hover:text-crewly-text">
          <ArrowLeft size={14} /> Verification queue
        </Link>
        <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
          {error || 'Check not found'}
        </div>
      </div>
    );
  }

  const singleEntry = check.entries?.length === 1;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/super-admin/bgv" className="flex items-center gap-1.5 text-sm text-crewly-dim transition hover:text-crewly-text">
          <ArrowLeft size={14} /> Verification queue
        </Link>
        <span className="text-xs text-crewly-dim">BGV case {check.caseId}</span>
      </div>

      {/* Tenant-context strip — whose data is on screen. */}
      <div className="card flex flex-wrap items-center gap-3 !p-3 text-sm">
        <Building2 size={15} className="text-crewly-dim" />
        <span className="text-crewly-dim">Verifying for</span>
        <Link to={`/super-admin/companies/${check.companyId}`} className="font-medium text-crewly-green transition hover:underline">
          {check.company?.name || 'Tenant'}
        </Link>
        <span className="ml-auto text-xs text-crewly-dim">
          All actions on this page are audited as Crewly platform activity.
        </span>
      </div>

      {error && <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">{error}</div>}
      {notice && <div className="rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-4 py-3 text-sm text-crewly-green">{notice}</div>}

      <div className="card space-y-3 !p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">
              {CHECK_TYPE_LABELS[check.checkType] || check.checkType} check · {check.caseInfo?.candidateName || 'Candidate'}
            </h1>
            <p className="text-sm text-crewly-dim">
              {check.caseInfo?.candidateCode}
              {check.caseInfo?.jobTitle ? ` · applying for ${check.caseInfo.jobTitle}` : ''}
              {check.assignedVerifierName ? ` · assigned to ${check.assignedVerifierName}` : ' · unassigned'}
            </p>
          </div>
          <Chip status={check.status} />
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs text-crewly-dim">
          {['PENDING', 'IN_PROGRESS'].map((step) => (
            <span key={step} className={`rounded-full border px-2.5 py-0.5 ${check.status === step ? STATUS_TONES[step] : 'border-crewly-border'}`}>
              {STATUS_LABELS[step]}
            </span>
          ))}
          <span className={`rounded-full border px-2.5 py-0.5 ${isTerminal ? STATUS_TONES[check.status] : 'border-crewly-border'}`}>
            {isTerminal ? STATUS_LABELS[check.status] : 'Awaiting outcome'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-4 border-t border-crewly-border/60 pt-3 text-sm">
          <span className="flex items-center gap-1.5 text-crewly-dim">
            <CalendarClock size={14} /> Due {formatDate(check.sla?.dueAt)}
            {check.sla?.extendedOnce ? ` (extended ${check.sla.extensionDays}d once)` : ''}
          </span>
          <span className="text-crewly-dim">Initiated {formatDate(check.sla?.initiatedAt)}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {canAssign && (
            <button type="button" onClick={() => openDialog('assign')} className="flex items-center gap-1.5 rounded-lg border border-crewly-border px-3 py-1.5 text-sm transition hover:border-crewly-green/50">
              <UserPlus2 size={14} /> {check.assignedVerifierId ? 'Reassign' : 'Assign verifier'}
            </button>
          )}
          {!isTerminal && (
            <>
              <button type="button" onClick={() => openDialog('status')} className="rounded-lg border border-crewly-border px-3 py-1.5 text-sm transition hover:border-crewly-green/50">
                Change status
              </button>
              {!check.sla?.extendedOnce && (
                <button type="button" onClick={() => openDialog('sla')} className="rounded-lg border border-crewly-border px-3 py-1.5 text-sm transition hover:border-amber-500/50">
                  Extend SLA (once)
                </button>
              )}
            </>
          )}
          {isTerminal && canAssign && (
            <button type="button" onClick={() => openDialog('reopen')} className="flex items-center gap-1.5 rounded-lg border border-crewly-red/40 px-3 py-1.5 text-sm text-crewly-red transition hover:bg-crewly-red/10">
              <RotateCcw size={14} /> Reopen check
            </button>
          )}
        </div>
      </div>

      {check.resultSummary && (
        <div className="card !p-4 text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-crewly-dim">Outcome summary</span>
          {check.resultSummary}
          {check.discrepancyNote && <p className="mt-2 text-crewly-red">{check.discrepancyNote}</p>}
        </div>
      )}

      <div className="space-y-4">
        {(check.entries || []).map((entry, index) => (
          <div key={entry.entryKey} className="card space-y-3 !p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">
                {(check.entries?.length || 0) > 1 ? `Entry ${index + 1}: ` : ''}
                {entry.label || 'Verification entry'}
              </h2>
              <div className="flex items-center gap-2">
                <Chip status={entry.status} />
                {!isTerminal && (
                  <button type="button" onClick={() => openDialog('status', entry.entryKey)} className="text-xs text-crewly-dim underline-offset-2 hover:text-crewly-text hover:underline">
                    Update
                  </button>
                )}
              </div>
            </div>

            {entry.claim && Object.keys(entry.claim).length > 0 && (
              <div className="grid gap-2 rounded-lg border border-crewly-border/60 bg-crewly-bg/50 p-3 text-xs sm:grid-cols-2">
                {Object.entries(entry.claim)
                  .filter(([, value]) => value !== null && value !== undefined && value !== '' && !Array.isArray(value))
                  .map(([key, value]) => (
                    <span key={key}>
                      <span className="text-crewly-dim">{key}: </span>
                      {String(value)}
                    </span>
                  ))}
              </div>
            )}

            {entry.resultSummary && <p className="text-sm text-crewly-green">{entry.resultSummary}</p>}
            {entry.discrepancyNote && <p className="text-sm text-crewly-red">{entry.discrepancyNote}</p>}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wide text-crewly-dim">Evidence ({entry.evidence?.length || 0})</span>
                {!isTerminal && (
                  <button type="button" onClick={() => openDialog('evidence', singleEntry ? null : entry.entryKey)} className="text-xs text-crewly-green underline-offset-2 hover:underline">
                    + Add evidence
                  </button>
                )}
              </div>
              {!entry.evidence?.length ? (
                <p className="text-sm text-crewly-dim">Nothing recorded yet — log call results and upload screenshots or documents as verification proceeds.</p>
              ) : (
                entry.evidence.map((evidence) => {
                  const kind = KIND_META[evidence.kind] || { icon: MessageSquare, label: evidence.kind };
                  const Icon = kind.icon;
                  return (
                    <div key={evidence.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-crewly-border/60 px-3 py-2 text-sm">
                      <Icon size={14} className="shrink-0 text-crewly-dim" />
                      <span className="min-w-28 font-medium">{kind.label}</span>
                      {evidence.note && <span className="text-crewly-dim">{evidence.note}</span>}
                      {evidence.kind === 'CALL_LOG' && (
                        <span className="text-xs text-crewly-dim">
                          {evidence.meta?.phone ? `ph ${evidence.meta.phone}` : ''}
                          {evidence.meta?.durationSec ? ` · ${evidence.meta.durationSec}s` : ''}
                          {evidence.meta?.outcome ? ` · ${evidence.meta.outcome}` : ''}
                        </span>
                      )}
                      {evidence.kind === 'LINK' && evidence.meta?.url && (
                        <span className="truncate text-xs text-crewly-dim">{evidence.meta.url}</span>
                      )}
                      <span className="ml-auto flex items-center gap-2 text-xs text-crewly-dim">{formatDate(evidence.addedAt)}</span>
                      {evidence.hasFile && (
                        <button type="button" onClick={() => download(evidence)} className="flex items-center gap-1 text-xs text-crewly-dim transition hover:text-crewly-text">
                          <Download size={12} /> {evidence.filename || 'file'}
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="card !p-4 text-sm">
        <span className="mb-2 block text-xs uppercase tracking-wide text-crewly-dim">Follow-up (read-only until the request engine, Phase 30.3)</span>
        <div className="flex flex-wrap gap-4 text-crewly-dim">
          <span>Email attempts: {check.followUp?.emailAttempts ?? 0}</span>
          <span>Calls: {check.followUp?.callAttempts ?? 0}</span>
          <span>Last follow-up: {formatDate(check.followUp?.lastFollowUpAt)}</span>
          <span>Next due: {formatDate(check.followUp?.nextFollowUpAt)}</span>
          {check.followUp?.closedReason && <span>Closed: {check.followUp.closedReason}</span>}
        </div>
      </div>

      {dialog === 'assign' && (
        <Modal title="Assign a Crewly verifier" onClose={() => setDialog(null)}>
          <div className="space-y-3">
            <input
              className={inputClass}
              placeholder="Search the Crewly team"
              onChange={(event) => {
                const q = event.target.value.toLowerCase();
                setForm((f) => ({ ...f, query: event.target.value }));
                setVerifiers(verifiers.filter((u) => !q || String(u.name || '').toLowerCase().includes(q)));
              }}
            />
            <p className="text-xs text-crewly-dim">Only Crewly platform staff appear here — tenant accounts cannot verify (Phase 30.1.1).</p>
            <div className="max-h-64 space-y-1.5 overflow-y-auto">
              {verifiers.map((verifier) => (
                <button
                  key={verifier.id}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, verifierId: verifier.id, verifierName: verifier.name }))}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm transition ${
                    form.verifierId === verifier.id ? 'border-crewly-green/60 bg-crewly-green/10' : 'border-crewly-border hover:border-crewly-green/40'
                  }`}
                >
                  <span>{verifier.name}</span>
                  <span className="text-xs text-crewly-dim">{verifier.role}</span>
                </button>
              ))}
              {!verifiers.length && <p className="text-sm text-crewly-dim">No Crewly verifiers found.</p>}
            </div>
            <button
              type="button"
              disabled={!form.verifierId}
              onClick={() => submit('assign')}
              className="w-full rounded-lg bg-crewly-green px-4 py-2 text-sm font-medium text-crewly-bg transition disabled:opacity-40"
            >
              Assign {form.verifierName ? `to ${form.verifierName}` : 'verifier'}
            </button>
          </div>
        </Modal>
      )}

      {dialog === 'status' && (
        <Modal title={dialogTarget.entryKey ? 'Update entry status' : 'Change check status'} onClose={() => setDialog(null)}>
          <div className="space-y-3">
            <Field label="Target status">
              <select className={inputClass} value={form.toStatus} onChange={(e) => setForm((f) => ({ ...f, toStatus: e.target.value }))}>
                {statusTargets.map((value) => (
                  <option key={value} value={value}>{STATUS_LABELS[value]}</option>
                ))}
              </select>
            </Field>
            {form.toStatus === 'VERIFIED' && (
              <Field label="Result summary (required)">
                <textarea className={inputClass} rows={3} value={form.resultSummary || ''} onChange={(e) => setForm((f) => ({ ...f, resultSummary: e.target.value }))} placeholder="What was confirmed, with whom, when. Mask any document numbers (e.g. XXXX XXXX 9012)." />
              </Field>
            )}
            {form.toStatus === 'DISCREPANCY' && (
              <Field label="Discrepancy note (required)">
                <textarea className={inputClass} rows={3} value={form.discrepancyNote || ''} onChange={(e) => setForm((f) => ({ ...f, discrepancyNote: e.target.value }))} placeholder="What does not match, and what is being asked of whom." />
              </Field>
            )}
            {form.toStatus === 'UTV' && (
              <Field label="Closure reason (required)">
                <input className={inputClass} value={form.closedReason || ''} onChange={(e) => setForm((f) => ({ ...f, closedReason: e.target.value }))} placeholder="e.g. NO_RESPONSE_AFTER_TIMELINE" />
              </Field>
            )}
            {dialogTarget.entryKey && <p className="text-xs text-crewly-dim">The check-level status rolls up from all entries automatically — a discrepancy here flags the check for review; it never rejects the candidate.</p>}
            <button
              type="button"
              onClick={() => submit('status')}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-crewly-green px-4 py-2 text-sm font-medium text-crewly-bg transition hover:opacity-90"
            >
              <Send size={14} /> Apply status
            </button>
          </div>
        </Modal>
      )}

      {dialog === 'evidence' && (
        <Modal title="Add evidence" onClose={() => setDialog(null)}>
          <form onSubmit={submitEvidence} className="space-y-3">
            <Field label="Kind">
              <select className={inputClass} value={form.kind || 'NOTE'} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
                {Object.keys(KIND_META).map((kind) => (
                  <option key={kind} value={kind}>{KIND_META[kind].label}</option>
                ))}
              </select>
            </Field>
            {FIELD_KINDS.includes(form.kind) && (
              <Field label="File (PNG, JPEG, WEBP or PDF — stored privately)">
                <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className={inputClass} onChange={(e) => setForm((f) => ({ ...f, file: e.target.files?.[0] || null }))} />
              </Field>
            )}
            {form.kind === 'CALL_LOG' && (
              <div className="grid grid-cols-3 gap-2">
                <Field label="Phone"><input className={inputClass} value={form.phone || ''} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} /></Field>
                <Field label="Duration (s)"><input type="number" min="0" className={inputClass} value={form.durationSec || ''} onChange={(e) => setForm((f) => ({ ...f, durationSec: e.target.value }))} /></Field>
                <Field label="Outcome"><input className={inputClass} value={form.outcome || ''} onChange={(e) => setForm((f) => ({ ...f, outcome: e.target.value }))} /></Field>
              </div>
            )}
            {form.kind === 'LINK' && (
              <Field label="URL (reference only)"><input className={inputClass} value={form.url || ''} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} /></Field>
            )}
            {form.kind === 'FIELD_VISIT' && (
              <div className="grid grid-cols-3 gap-2">
                <Field label="Latitude"><input className={inputClass} value={form.geoLat || ''} onChange={(e) => setForm((f) => ({ ...f, geoLat: e.target.value }))} /></Field>
                <Field label="Longitude"><input className={inputClass} value={form.geoLng || ''} onChange={(e) => setForm((f) => ({ ...f, geoLng: e.target.value }))} /></Field>
                <Field label="Accuracy (m)"><input className={inputClass} value={form.geoAccuracy || ''} onChange={(e) => setForm((f) => ({ ...f, geoAccuracy: e.target.value }))} /></Field>
              </div>
            )}
            <Field label="Note">
              <textarea className={inputClass} rows={3} value={form.note || ''} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="Observations. Do not paste Aadhaar/PAN/passport numbers — mask them." />
            </Field>
            <button type="submit" className="w-full rounded-lg bg-crewly-green px-4 py-2 text-sm font-medium text-crewly-bg transition hover:opacity-90">
              Save evidence
            </button>
          </form>
        </Modal>
      )}

      {dialog === 'sla' && (
        <Modal title="Extend SLA (once per check)" onClose={() => setDialog(null)}>
          <div className="space-y-3">
            <Field label="Extra days (1–30)">
              <input type="number" min="1" max="30" className={inputClass} value={form.days || ''} onChange={(e) => setForm((f) => ({ ...f, days: e.target.value }))} />
            </Field>
            <Field label="Reason (required, audited)">
              <textarea className={inputClass} rows={2} value={form.reason || ''} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
            </Field>
            <button type="button" disabled={!form.days || !form.reason} onClick={() => submit('sla')} className="w-full rounded-lg bg-crewly-green px-4 py-2 text-sm font-medium text-crewly-bg disabled:opacity-40">
              Extend
            </button>
          </div>
        </Modal>
      )}

      {dialog === 'reopen' && (
        <Modal title="Reopen this check" onClose={() => setDialog(null)}>
          <div className="space-y-3">
            <p className="text-sm text-crewly-dim">
              Reopening moves the check back to In progress. The terminal outcome and its history stay in the audit trail.
              Requires the bgv:assign platform permission.
            </p>
            <Field label="Written reason (required)">
              <textarea className={inputClass} rows={2} value={form.reason || ''} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
            </Field>
            <button type="button" disabled={!form.reason} onClick={() => submit('reopen')} className="w-full rounded-lg border border-crewly-red/50 bg-crewly-red/10 px-4 py-2 text-sm text-crewly-red transition hover:bg-crewly-red/20 disabled:opacity-40">
              Reopen with reason
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default SuperAdminBgvCheckDetailPage;
