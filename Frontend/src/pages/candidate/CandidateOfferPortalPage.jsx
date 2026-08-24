import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, FileCheck2, ShieldCheck, XCircle } from 'lucide-react';
import { useParams } from 'react-router-dom';
import OfferStatusBadge from '../../components/recruitment/OfferStatusBadge.jsx';
import offerService from '../../services/offerService.js';

const money = (value, currency) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 2 }).format(Number(value) || 0);
const dateLabel = (value) => value ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(value)) : 'Not set';
const enumLabel = (value) => String(value || '').toLowerCase().split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');

const CandidateOfferPortalPage = () => {
  const { secureToken } = useParams();
  const viewPosted = useRef(false);
  const [offer, setOffer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [decision, setDecision] = useState('');
  const [category, setCategory] = useState('NO_REASON');
  const [comment, setComment] = useState('');

  useEffect(() => {
    let active = true;
    document.title = 'Secure employment offer — Crewly';
    offerService.publicRead(secureToken)
      .then(async (result) => {
        if (!active) return;
        setOffer(result);
        setLoading(false);
        if (!viewPosted.current && ['SENT', 'VIEWED'].includes(result.status)) {
          viewPosted.current = true;
          try {
            const viewed = await offerService.publicView(secureToken);
            if (active) setOffer(viewed);
          } catch {
            // The offer remains readable even if non-final view telemetry fails.
          }
        }
      })
      .catch((requestError) => {
        if (!active) return;
        setError(requestError.message || 'Offer is unavailable');
        setLoading(false);
      });
    return () => { active = false; };
  }, [secureToken]);

  const download = async () => {
    setBusy('DOCUMENT');
    setError('');
    try {
      const blob = await offerService.publicDocument(secureToken);
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

  const confirmDecision = async (event) => {
    event.preventDefault();
    setBusy(decision);
    setError('');
    try {
      const updated = decision === 'ACCEPT'
        ? await offerService.publicAccept(secureToken)
        : await offerService.publicReject(secureToken, { category, comment });
      setOffer(updated);
      setDecision('');
    } catch (requestError) {
      setError(requestError.message || 'Your decision could not be recorded');
    } finally {
      setBusy('');
    }
  };

  if (loading) return <div className="mx-auto max-w-5xl px-5 py-10"><div className="h-[65vh] animate-pulse rounded-2xl bg-slate-900" /></div>;
  if (!offer) return <div className="mx-auto flex max-w-xl items-center justify-center px-5 py-24"><section className="w-full rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center"><XCircle className="mx-auto h-10 w-10 text-slate-600" /><h1 className="mt-4 text-xl font-semibold">Offer unavailable</h1><p className="mt-2 text-sm text-slate-400">{error || 'This link is invalid, expired, or no longer available.'}</p></section></div>;

  const final = ['ACCEPTED', 'REJECTED'].includes(offer.status);
  const compensation = offer.compensation;
  return <div className="mx-auto max-w-5xl space-y-5 px-5 py-8 sm:py-10"><header className="rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:p-8"><div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between"><div><div className="flex flex-wrap items-center gap-3"><p className="font-mono text-xs font-semibold text-indigo-300">{offer.offerCode}</p><OfferStatusBadge status={offer.status} /></div><h1 className="mt-4 text-2xl font-bold text-slate-100 sm:text-3xl">Employment offer for {offer.candidate.name}</h1><p className="mt-2 text-sm text-slate-400">{offer.terms.designation} · {offer.company.name}</p></div><button type="button" className="btn-ghost gap-2" onClick={download} disabled={busy === 'DOCUMENT'}><Download className="h-4 w-4" />Download approved PDF</button></div></header>{error ? <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null}{final ? <section className={`rounded-2xl border p-6 ${offer.status === 'ACCEPTED' ? 'border-emerald-500/25 bg-emerald-500/10' : 'border-rose-500/25 bg-rose-500/10'}`}><div className="flex items-start gap-3">{offer.status === 'ACCEPTED' ? <CheckCircle2 className="h-6 w-6 text-emerald-300" /> : <XCircle className="h-6 w-6 text-rose-300" />}<div><h2 className="font-semibold text-slate-100">Your decision has been recorded</h2><p className="mt-1 text-sm text-slate-300">This offer was {offer.status.toLowerCase()}. Repeated submissions will not create duplicate decisions.</p></div></div></section> : null}<div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]"><div className="space-y-5"><section className="rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:p-8"><div className="flex items-center gap-2"><FileCheck2 className="h-4 w-4 text-indigo-300" /><h2 className="font-semibold">Offer terms</h2></div><pre className="mt-5 whitespace-pre-wrap break-words font-sans text-sm leading-7 text-slate-300">{offer.renderedContent}</pre></section><section className="rounded-2xl border border-slate-800 bg-slate-900 p-6"><h2 className="font-semibold">Compensation snapshot</h2><div className="mt-4 grid gap-3 sm:grid-cols-2"><div className="rounded-xl bg-slate-950/60 p-4 sm:col-span-2"><p className="text-xs text-slate-500">Annual CTC</p><p className="mt-1 text-xl font-bold text-emerald-300">{money(compensation.annualCTC, compensation.currency)}</p></div>{[['Monthly basic', compensation.monthly?.basic], ['Monthly HRA', compensation.monthly?.hra], ['Monthly allowances', compensation.monthly?.allowances], ['Variable pay', compensation.variablePay], ['Offer bonus', compensation.bonus]].map(([label, value]) => <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/40 p-4"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-sm font-medium text-slate-200">{money(value, compensation.currency)}</p></div>)}</div></section></div><aside className="space-y-5 xl:sticky xl:top-6"><section className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><h2 className="font-semibold">Position facts</h2><dl className="mt-4 space-y-4">{[['Designation', offer.terms.designation], ['Department', offer.terms.departmentName || 'Not set'], ['Work mode', enumLabel(offer.terms.workMode)], ['Location', offer.terms.location], ['Joining date', dateLabel(offer.terms.joiningDate)], ['Offer valid until', dateLabel(offer.terms.expiryDate)], ['Reporting manager', offer.terms.reportingManagerName || 'To be assigned']].map(([label, value]) => <div key={label}><dt className="text-[10px] uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-1 text-sm text-slate-200">{value}</dd></div>)}</dl></section><section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5"><div className="flex items-center gap-2 text-emerald-200"><ShieldCheck className="h-4 w-4" /><h2 className="font-semibold">Secure document</h2></div><p className="mt-2 text-xs leading-5 text-slate-400">This portal displays the fixed snapshot approved by the hiring team. Final decisions are accepted only through explicit confirmation.</p></section>{!final ? <div className="grid gap-2"><button type="button" className="btn-primary w-full justify-center gap-2" onClick={() => setDecision('ACCEPT')}><CheckCircle2 className="h-4 w-4" />Accept offer</button><button type="button" className="btn-ghost w-full justify-center gap-2 text-rose-300" onClick={() => setDecision('REJECT')}><XCircle className="h-4 w-4" />Reject offer</button></div> : null}</aside></div>{decision ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4" role="dialog" aria-modal="true"><form onSubmit={confirmDecision} className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6"><h2 className="text-lg font-semibold">Confirm offer {decision === 'ACCEPT' ? 'acceptance' : 'rejection'}</h2><p className="mt-2 text-sm leading-6 text-slate-400">This records a final candidate decision for {offer.offerCode}. Review the approved PDF and terms before confirming.</p>{decision === 'REJECT' ? <div className="mt-4 space-y-4"><label className="block"><span className="label">Reason category (optional)</span><select className="input" value={category} onChange={(event) => setCategory(event.target.value)}>{['NO_REASON', 'COMPENSATION', 'JOINING_DATE', 'ACCEPTED_ANOTHER_OFFER', 'PERSONAL', 'OTHER'].map((value) => <option key={value} value={value}>{enumLabel(value)}</option>)}</select></label><label className="block"><span className="label">Comment (optional)</span><textarea className="input min-h-24" maxLength="1000" value={comment} onChange={(event) => setComment(event.target.value)} /></label></div> : null}<div className="mt-6 flex justify-end gap-3"><button type="button" className="btn-ghost" onClick={() => setDecision('')}>Cancel</button><button type="submit" className="btn-primary" disabled={Boolean(busy)}>Confirm {decision === 'ACCEPT' ? 'acceptance' : 'rejection'}</button></div></form></div> : null}</div>;
};

export default CandidateOfferPortalPage;
