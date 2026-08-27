const STYLES = {
  NOT_STARTED: 'border-slate-600 bg-slate-500/10 text-slate-300',
  IN_PROGRESS: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  ACTION_REQUIRED: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  UNDER_REVIEW: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300',
  COMPLETED: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  READY_TO_JOIN: 'border-emerald-400/40 bg-emerald-400/15 text-emerald-200',
  WITHDRAWN: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  PENDING: 'border-slate-600 bg-slate-500/10 text-slate-300',
  UPLOADED: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  VERIFIED: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  REJECTED: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  RESUBMISSION_REQUIRED: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
};

const labelOf = (status) =>
  String(status || 'UNKNOWN')
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const PreOnboardingStatusBadge = ({ status }) => (
  <span
    className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold tracking-wide ${
      STYLES[status] || STYLES.NOT_STARTED
    }`}
  >
    {labelOf(status)}
  </span>
);

export default PreOnboardingStatusBadge;
