/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { FilePlus2, FileText, RefreshCw, Search, Settings2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import OfferEditor from '../../components/recruitment/OfferEditor.jsx';
import OfferStatusBadge from '../../components/recruitment/OfferStatusBadge.jsx';
import usePermission from '../../hooks/usePermission.js';
import offerService from '../../services/offerService.js';

const dateLabel = (value) => value ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value)) : 'Not set';
const money = (value, currency) => {
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      maximumFractionDigits: 0,
    }).format(Number(value) || 0);
  } catch {
    return `${currency || ''} ${value || 0}`.trim();
  }
};
const statuses = ['', 'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'VIEWED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'];

const OffersPage = () => {
  const navigate = useNavigate();
  const { hasPermission } = usePermission();
  const [offers, setOffers] = useState([]);
  const [meta, setMeta] = useState({ kpis: {} });
  const [filters, setFilters] = useState({ status: '', search: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await offerService.list({ ...filters, search: filters.search || undefined, status: filters.status || undefined });
      setOffers(result.offers);
      setMeta(result.meta);
    } catch (requestError) {
      setError(requestError.message || 'Offers could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  const kpis = [
    ['Draft', meta.kpis?.DRAFT || 0],
    ['Awaiting approval', meta.kpis?.PENDING_APPROVAL || 0],
    ['Ready to send', meta.kpis?.APPROVED || 0],
    ['Candidate action', (meta.kpis?.SENT || 0) + (meta.kpis?.VIEWED || 0)],
    ['Accepted', meta.kpis?.ACCEPTED || 0],
  ];

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">Recruitment</p>
          <h1 className="mt-1 text-2xl font-bold text-slate-100">Enterprise offers</h1>
          <p className="mt-1 text-sm text-slate-400">Controlled drafting, independent approval, secure delivery, and candidate decisions.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {hasPermission('OFFER_TEMPLATE_READ') ? <Link className="btn-ghost gap-2" to="/app/recruitment/offer-templates"><Settings2 className="h-4 w-4" />Templates</Link> : null}
          {hasPermission('OFFER_CREATE') ? <button type="button" className="btn-primary gap-2" onClick={() => setCreating(true)}><FilePlus2 className="h-4 w-4" />Create offer</button> : null}
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {kpis.map(([label, value]) => <div key={label} className="rounded-2xl border border-slate-800 bg-slate-900 p-4"><p className="text-xs text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold text-slate-100">{value}</p></div>)}
      </div>

      <section className="rounded-2xl border border-slate-800 bg-slate-900">
        <div className="flex flex-col gap-3 border-b border-slate-800 p-4 sm:flex-row">
          <label className="relative flex-1"><span className="sr-only">Search offers</span><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-500" /><input className="input pl-9" placeholder="Search offer, candidate, email, or job" value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} /></label>
          <label><span className="sr-only">Filter by status</span><select className="input min-w-48" value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>{statuses.map((status) => <option key={status || 'ALL'} value={status}>{status ? status.replaceAll('_', ' ') : 'All statuses'}</option>)}</select></label>
          <button type="button" className="btn-ghost gap-2" onClick={load}><RefreshCw className="h-4 w-4" />Refresh</button>
        </div>

        {error ? <p role="alert" className="m-4 rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null}
        {loading ? <div className="m-4 h-64 animate-pulse rounded-xl bg-slate-950/50" /> : offers.length ? (
          <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-sm"><thead className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Offer</th><th className="px-5 py-3">Candidate</th><th className="px-5 py-3">Role</th><th className="px-5 py-3">Compensation</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Created by</th><th className="px-5 py-3">Expires</th><th className="px-5 py-3 text-right">Action</th></tr></thead><tbody className="divide-y divide-slate-800">{offers.map((offer) => <tr key={offer._id} className="hover:bg-slate-950/30"><td className="px-5 py-4"><p className="font-mono font-semibold text-indigo-300">{offer.offerCode}</p><p className="mt-1 text-xs text-slate-500">Revision {offer.revisionNumber}</p></td><td className="px-5 py-4"><p className="font-medium text-slate-200">{offer.candidateSnapshot.name}</p><p className="mt-1 text-xs text-slate-500">{offer.candidateSnapshot.candidateCode}</p></td><td className="px-5 py-4"><p className="text-slate-300">{offer.terms.designation}</p><p className="mt-1 text-xs text-slate-500">{offer.jobSnapshot.departmentName || 'No department'}</p></td><td className="px-5 py-4 font-medium text-slate-300">{money(offer.compensationSnapshot.annualCTC, offer.compensationSnapshot.currency)}</td><td className="px-5 py-4"><OfferStatusBadge status={offer.status} /></td><td className="px-5 py-4 text-slate-400">{offer.createdBy?.name || 'Tenant user'}</td><td className="px-5 py-4 text-slate-400">{dateLabel(offer.terms.expiryDate)}</td><td className="px-5 py-4 text-right"><Link className="text-sm font-medium text-indigo-300 hover:text-indigo-200" to={`/app/recruitment/offers/${offer._id}`}>Open offer</Link></td></tr>)}</tbody></table></div>
        ) : <div className="p-12 text-center"><FileText className="mx-auto h-9 w-9 text-slate-600" /><p className="mt-3 text-sm text-slate-400">No offers match these filters.</p></div>}
      </section>

      {creating ? <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/85 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Create offer"><div className="mx-auto my-6 max-w-5xl rounded-2xl border border-slate-700 bg-slate-900 p-5 sm:p-7"><OfferEditor onCancel={() => setCreating(false)} onSaved={(offer) => { setCreating(false); navigate(`/app/recruitment/offers/${offer._id}`); }} /></div></div> : null}
    </div>
  );
};

export default OffersPage;
