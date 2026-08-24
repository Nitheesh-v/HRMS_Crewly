/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { FilePlus2, FileText } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import usePermission from '../../hooks/usePermission.js';
import offerService from '../../services/offerService.js';
import OfferEditor from './OfferEditor.jsx';
import OfferStatusBadge from './OfferStatusBadge.jsx';

const CandidateOfferPanel = ({ candidate }) => {
  const navigate = useNavigate();
  const { hasPermission } = usePermission();
  const [offers, setOffers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const canRead = hasPermission('OFFER_READ');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await offerService.list({ candidateId: candidate.id, limit: 10 });
      setOffers(result.offers);
    } catch (requestError) {
      setError(requestError.message || 'Candidate offers could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [candidate.id]);
  useEffect(() => {
    if (canRead) load();
    else setLoading(false);
  }, [canRead, load]);

  if (!canRead) return null;

  const stage = candidate.overview.currentStage || candidate.overview.stage;
  const hasActive = offers.some((offer) => ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'VIEWED'].includes(offer.status));
  const canCreate = hasPermission('OFFER_CREATE') && ['SELECTED', 'OFFER'].includes(stage) && !hasActive;

  return <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5 sm:p-6"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="flex items-start gap-3"><span className="rounded-xl bg-emerald-500/10 p-2 text-emerald-300"><FileText className="h-5 w-5" /></span><div><h2 className="font-semibold text-slate-100">Enterprise offer</h2><p className="mt-1 text-sm text-slate-400">Offer terms and candidate decisions are controlled outside generic pipeline updates.</p></div></div>{canCreate ? <button type="button" className="btn-primary gap-2" onClick={() => setCreating(true)}><FilePlus2 className="h-4 w-4" />Create offer</button> : null}</div>{error ? <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p> : null}{loading ? <div className="mt-4 h-20 animate-pulse rounded-xl bg-slate-900/70" /> : offers.length ? <div className="mt-4 space-y-2">{offers.map((offer) => <Link key={offer._id} to={`/app/recruitment/offers/${offer._id}`} className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4 transition hover:border-indigo-500/30 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-mono text-xs font-semibold text-indigo-300">{offer.offerCode}</p><p className="mt-1 text-sm text-slate-300">{offer.terms.designation} · Revision {offer.revisionNumber}</p></div><OfferStatusBadge status={offer.status} /></Link>)}</div> : <p className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-500">No enterprise offer has been created for this candidate.</p>}{creating ? <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/85 p-4 backdrop-blur-sm" role="dialog" aria-modal="true"><div className="mx-auto my-6 max-w-5xl rounded-2xl border border-slate-700 bg-slate-900 p-5 sm:p-7"><OfferEditor presetCandidateId={candidate.id} onCancel={() => setCreating(false)} onSaved={(offer) => { setCreating(false); navigate(`/app/recruitment/offers/${offer._id}`); }} /></div></div> : null}</section>;
};

export default CandidateOfferPanel;
