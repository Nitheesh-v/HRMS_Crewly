const tones = {
  DRAFT: 'border-slate-600 bg-slate-800 text-slate-200',
  PENDING_APPROVAL: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  APPROVED: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-200',
  SENT: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
  VIEWED: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200',
  ACCEPTED: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  REJECTED: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
  EXPIRED: 'border-orange-500/30 bg-orange-500/10 text-orange-200',
  WITHDRAWN: 'border-slate-700 bg-slate-900 text-slate-400',
};

const offerStatusLabel = (status = '') =>
  String(status)
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const OfferStatusBadge = ({ status }) => (
  <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${tones[status] || tones.DRAFT}`}>
    {offerStatusLabel(status)}
  </span>
);

export default OfferStatusBadge;
