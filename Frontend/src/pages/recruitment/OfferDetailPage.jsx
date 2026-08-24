/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Download, Edit3, FileCheck2, RotateCcw, Send, ShieldCheck, XCircle } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import OfferEditor from '../../components/recruitment/OfferEditor.jsx';
import OfferStatusBadge from '../../components/recruitment/OfferStatusBadge.jsx';
import usePermission from '../../hooks/usePermission.js';
import offerService from '../../services/offerService.js';

const dateTime = (value) => value ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : 'Not recorded';
const dateOnly = (value) => value ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(value)) : 'Not set';
const money = (value, currency) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 2 }).format(Number(value) || 0);
const enumLabel = (value) => String(value || '').toLowerCase().split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
const offerStatusLabel = enumLabel;

const OfferDetailPage = () => {
  const { offerId } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = usePermission();
  const [offer, setOffer] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(false);
  const [revising, setRevising] = useState(false);
  const [reasonAction, setReasonAction] = useState('');
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await offerService.get(offerId);
      setOffer(result.offer);
      setHistory(result.history);
      document.title = `${result.offer.offerCode} — Offer — Crewly HRMS`;
    } catch (requestError) {
      setError(requestError.message || 'Offer could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [offerId]);

  useEffect(() => { load(); }, [load]);

  const run = async (action, operation) => {
    setBusy(action);
    setError('');
    setMessage('');
    try {
      const updated = await operation();
      setOffer(updated);
      setMessage(`Offer ${action.toLowerCase()} completed.`);
      setReasonAction('');
      setReason('');
      await load();
    } catch (requestError) {
      setError(requestError.message || `Offer ${action.toLowerCase()} failed`);
    } finally {
      setBusy('');
    }
  };

  const download = async () => {
    setBusy('DOCUMENT');
    setError('');
    try {
      const blob = await offerService.document(offerId);
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = offer.document.fileName || `${offer.offerCode}.pdf`;
      anchor.click();
      window.URL.revokeObjectURL(url);
    } catch (requestError) {
      setError(requestError.message || 'Offer document could not be downloaded');
    } finally {
      setBusy('');
    }
  };

  if (loading) return <div className="h-[70vh] animate-pulse rounded-2xl bg-slate-900" />;
  if (!offer) return <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 p-7"><h1 className="font-semibold text-rose-100">Offer unavailable</h1><p className="mt-2 text-sm text-rose-200">{error}</p><Link className="btn-ghost mt-5 inline-flex" to="/app/recruitment/offers">Back to offers</Link></div>;

  const compensation = offer.compensationSnapshot;
  const canEdit = ['DRAFT', 'APPROVED'].includes(offer.status) && hasPermission('OFFER_UPDATE');
  const canWithdraw = !['ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'].includes(offer.status) && hasPermission('OFFER_WITHDRAW');

  return (
    <div className="space-y-5">
      <Link to="/app/recruitment/offers" className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-100"><ArrowLeft className="h-4 w-4" />Back to offers</Link>
      <header className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-7">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div><div className="flex flex-wrap items-center gap-3"><p className="font-mono text-sm font-semibold text-indigo-300">{offer.offerCode}</p><OfferStatusBadge status={offer.status} /><span className="text-xs text-slate-500">Revision {offer.revisionNumber}</span></div><h1 className="mt-3 text-2xl font-bold text-slate-100">{offer.candidateSnapshot.name}</h1><p className="mt-1 text-sm text-slate-400">{offer.terms.designation} · {offer.companySnapshot.name}</p></div>
          <div className="flex flex-wrap gap-2">
            {canEdit ? <button type="button" className="btn-ghost gap-2" onClick={() => setEditing(true)}><Edit3 className="h-4 w-4" />Edit terms</button> : null}
            {['REJECTED', 'EXPIRED', 'WITHDRAWN'].includes(offer.status) && hasPermission('OFFER_CREATE') ? <button type="button" className="btn-ghost gap-2" onClick={() => setRevising(true)}><RotateCcw className="h-4 w-4" />Create revision</button> : null}
            {offer.document.available ? <button type="button" className="btn-ghost gap-2" onClick={download} disabled={busy === 'DOCUMENT'}><Download className="h-4 w-4" />PDF</button> : null}
            {offer.status === 'DRAFT' && hasPermission('OFFER_SUBMIT') ? <button type="button" className="btn-primary gap-2" onClick={() => run('SUBMIT', () => offerService.submit(offerId))} disabled={Boolean(busy)}><FileCheck2 className="h-4 w-4" />Submit</button> : null}
            {offer.status === 'PENDING_APPROVAL' && hasPermission('OFFER_APPROVE') ? <button type="button" className="btn-primary gap-2" onClick={() => run('APPROVE', () => offerService.approve(offerId))} disabled={Boolean(busy)}><CheckCircle2 className="h-4 w-4" />Approve</button> : null}
            {offer.status === 'PENDING_APPROVAL' && hasPermission('OFFER_RETURN') ? <button type="button" className="btn-ghost gap-2" onClick={() => setReasonAction('RETURN')}><RotateCcw className="h-4 w-4" />Return</button> : null}
            {offer.status === 'APPROVED' && hasPermission('OFFER_SEND') ? <button type="button" className="btn-primary gap-2" onClick={() => run('SEND', () => offerService.send(offerId))} disabled={Boolean(busy)}><Send className="h-4 w-4" />Send securely</button> : null}
            {canWithdraw ? <button type="button" className="btn-ghost gap-2 text-rose-300" onClick={() => setReasonAction('WITHDRAW')}><XCircle className="h-4 w-4" />Withdraw</button> : null}
          </div>
        </div>
      </header>

      {message ? <p className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3 text-sm text-emerald-200">{message}</p> : null}
      {error ? <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null}
      {offer.unresolvedVariables?.length ? <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-sm text-amber-200">Resolve before submission: {offer.unresolvedVariables.join(', ')}</p> : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-7"><div className="flex items-center gap-2"><FileCheck2 className="h-4 w-4 text-indigo-300" /><h2 className="font-semibold text-slate-100">Approved-term preview</h2></div><pre className="mt-5 whitespace-pre-wrap break-words font-sans text-sm leading-7 text-slate-300">{offer.renderedContent}</pre></section>
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><h2 className="font-semibold text-slate-100">Compensation snapshot</h2><div className="mt-4 grid gap-3 sm:grid-cols-2"><div className="rounded-xl bg-slate-950/50 p-4 sm:col-span-2"><p className="text-xs text-slate-500">Annual CTC</p><p className="mt-1 text-xl font-bold text-emerald-300">{money(compensation.annualCTC, compensation.currency)}</p></div>{[['Monthly basic', compensation.monthly?.basic], ['Monthly HRA', compensation.monthly?.hra], ['Monthly allowances', compensation.monthly?.allowances], ['Variable pay', compensation.variablePay], ['Offer bonus', compensation.bonus]].map(([label, value]) => <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/40 p-4"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 font-medium text-slate-200">{money(value, compensation.currency)}</p></div>)}</div></section>
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><h2 className="font-semibold text-slate-100">Immutable offer history</h2><ol className="relative mt-5 space-y-5 before:absolute before:bottom-2 before:left-[5px] before:top-2 before:w-px before:bg-slate-800">{history.map((event) => <li key={event._id} className="relative flex gap-4"><span className="relative z-10 mt-1.5 h-3 w-3 shrink-0 rounded-full bg-indigo-400 ring-4 ring-slate-900" /><div className="min-w-0 flex-1 rounded-xl border border-slate-800 bg-slate-950/40 p-4"><div className="flex flex-col gap-1 sm:flex-row sm:justify-between"><p className="text-sm font-medium text-slate-200">{enumLabel(event.action)}</p><p className="text-xs text-slate-500">{dateTime(event.eventAt)}</p></div><p className="mt-1 text-xs text-slate-500">{event.actor?.name || event.actorNameSnapshot || enumLabel(event.actorType)}</p>{event.fromStatus || event.toStatus ? <p className="mt-2 text-xs text-indigo-300">{event.fromStatus ? offerStatusLabel(event.fromStatus) : 'Created'} → {offerStatusLabel(event.toStatus)}</p> : null}{event.reason ? <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-300">{event.reason}</p> : null}</div></li>)}</ol></section>
        </div>
        <aside className="space-y-5 xl:sticky xl:top-24"><section className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><h2 className="font-semibold text-slate-100">Offer facts</h2><dl className="mt-4 space-y-4">{[['Candidate', `${offer.candidateSnapshot.candidateCode} · ${offer.candidateSnapshot.email}`], ['Job', `${offer.jobSnapshot.title} · ${offer.jobSnapshot.jobCode || 'No code'}`], ['Department', offer.terms.departmentName || 'Not set'], ['Location', `${offer.terms.location} · ${enumLabel(offer.terms.workMode)}`], ['Joining', dateOnly(offer.terms.joiningDate)], ['Valid until', dateOnly(offer.terms.expiryDate)], ['Reporting manager', offer.terms.reportingManagerName || 'To be assigned'], ['Sent', dateTime(offer.delivery?.sentAt)], ['Viewed', dateTime(offer.viewedAt)], ['Accepted', dateTime(offer.acceptedAt)], ['Rejected', dateTime(offer.rejectedAt)]].map(([label, value]) => <div key={label}><dt className="text-[10px] uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-1 text-sm text-slate-200">{value}</dd></div>)}</dl></section><section className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><h2 className="font-semibold text-slate-100">Approval</h2><dl className="mt-4 space-y-4"><div><dt className="text-[10px] uppercase tracking-wide text-slate-500">Attempt</dt><dd className="mt-1 text-sm text-slate-200">{offer.approval?.attempt || 0}</dd></div><div><dt className="text-[10px] uppercase tracking-wide text-slate-500">Submitted by</dt><dd className="mt-1 text-sm text-slate-200">{offer.approval?.submittedBy?.name || 'Not submitted'} · {dateTime(offer.approval?.submittedAt)}</dd></div><div><dt className="text-[10px] uppercase tracking-wide text-slate-500">Approved by</dt><dd className="mt-1 text-sm text-slate-200">{offer.approval?.approvedBy?.name || 'Not approved'} · {dateTime(offer.approval?.approvedAt)}</dd></div>{offer.approval?.returnReason ? <div><dt className="text-[10px] uppercase tracking-wide text-slate-500">Latest return reason</dt><dd className="mt-1 whitespace-pre-wrap text-sm text-slate-200">{offer.approval.returnReason}</dd></div> : null}</dl></section>{offer.document.available ? <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5"><div className="flex items-center gap-2 text-emerald-200"><ShieldCheck className="h-4 w-4" /><h2 className="font-semibold">Document secured</h2></div><p className="mt-3 break-all font-mono text-[10px] text-slate-500">SHA-256 {offer.document.checksum}</p><p className="mt-2 text-xs text-slate-400">Version {offer.document.version} · {dateTime(offer.document.generatedAt)}</p></section> : null}</aside>
      </div>

      {editing ? <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/85 p-4 backdrop-blur-sm" role="dialog" aria-modal="true"><div className="mx-auto my-6 max-w-5xl rounded-2xl border border-slate-700 bg-slate-900 p-5 sm:p-7"><OfferEditor offer={offer} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} /></div></div> : null}
      {revising ? <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/85 p-4 backdrop-blur-sm" role="dialog" aria-modal="true"><div className="mx-auto my-6 max-w-5xl rounded-2xl border border-slate-700 bg-slate-900 p-5 sm:p-7"><OfferEditor revisionSource={offer} presetCandidateId={offer.candidate} replacesOfferId={offer._id} onCancel={() => setRevising(false)} onSaved={(revision) => { setRevising(false); navigate(`/app/recruitment/offers/${revision._id}`); }} /></div></div> : null}
      {reasonAction ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4" role="dialog" aria-modal="true"><form className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6" onSubmit={(event) => { event.preventDefault(); run(reasonAction, () => reasonAction === 'RETURN' ? offerService.returnForChanges(offerId, reason) : offerService.withdraw(offerId, reason)); }}><h2 className="text-lg font-semibold text-slate-100">{reasonAction === 'RETURN' ? 'Return offer for changes' : 'Withdraw offer'}</h2><p className="mt-1 text-sm text-slate-400">This reason is preserved in the immutable offer history.</p><label className="mt-4 block"><span className="label">Reason</span><textarea className="input min-h-28" required minLength="3" maxLength="1000" value={reason} onChange={(event) => setReason(event.target.value)} /></label><div className="mt-5 flex justify-end gap-3"><button type="button" className="btn-ghost" onClick={() => setReasonAction('')}>Cancel</button><button type="submit" className="btn-primary" disabled={Boolean(busy)}>Confirm {reasonAction === 'RETURN' ? 'return' : 'withdrawal'}</button></div></form></div> : null}
    </div>
  );
};

export default OfferDetailPage;
