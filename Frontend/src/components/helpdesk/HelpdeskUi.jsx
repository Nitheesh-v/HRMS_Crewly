import { AlertTriangle, CheckCircle2, Clock3, FileText, MessageCircle, XCircle } from 'lucide-react';

const STATUS_LABELS = {
  open: 'Open',
  assigned: 'Assigned',
  in_progress: 'In progress',
  waiting_for_employee: 'Waiting for you',
  waiting_for_department: 'Waiting for department',
  resolved: 'Resolved',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

const STATUS_STYLES = {
  open: 'border-sky-400/20 bg-sky-400/10 text-sky-200',
  assigned: 'border-indigo-400/20 bg-indigo-400/10 text-indigo-200',
  in_progress: 'border-blue-400/20 bg-blue-400/10 text-blue-200',
  waiting_for_employee: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
  waiting_for_department: 'border-orange-400/20 bg-orange-400/10 text-orange-200',
  resolved: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
  closed: 'border-slate-500/20 bg-slate-500/10 text-slate-300',
  cancelled: 'border-rose-400/20 bg-rose-400/10 text-rose-200',
};

const PRIORITY_STYLES = {
  low: 'border-slate-500/20 bg-slate-500/10 text-slate-300',
  normal: 'border-sky-400/20 bg-sky-400/10 text-sky-200',
  high: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
  urgent: 'border-rose-400/25 bg-rose-400/10 text-rose-200',
};

export const dateTimeLabel = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const relativeSize = (value) => {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const StatusPill = ({ status }) => {
  const normalized = String(status || 'open').toLowerCase();
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${STATUS_STYLES[normalized] || STATUS_STYLES.open}`}>
      {STATUS_LABELS[normalized] || normalized.replaceAll('_', ' ')}
    </span>
  );
};

export const PriorityPill = ({ priority }) => {
  const normalized = String(priority || 'normal').toLowerCase();
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold capitalize ${PRIORITY_STYLES[normalized] || PRIORITY_STYLES.normal}`}>
      {normalized}
    </span>
  );
};

export const HelpdeskLoading = ({ label = 'Loading Helpdesk…' }) => (
  <div className="flex min-h-36 items-center justify-center gap-3 text-sm text-crewly-dim" role="status" aria-live="polite">
    <span className="h-4 w-4 animate-spin rounded-full border-2 border-crewly-green/30 border-t-crewly-green" aria-hidden="true" />
    {label}
  </div>
);

export const HelpdeskError = ({ message, onRetry }) => (
  <div className="rounded-xl border border-rose-400/25 bg-rose-400/5 p-4" role="alert">
    <div className="flex items-start gap-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-rose-100">Could not load this Helpdesk view</p>
        <p className="mt-1 break-words text-xs leading-5 text-rose-100/70">{message || 'Try again in a moment.'}</p>
        {onRetry ? <button type="button" className="mt-3 rounded-lg border border-rose-300/20 px-3 py-1.5 text-xs font-semibold text-rose-100 hover:bg-rose-300/10" onClick={onRetry}>Retry</button> : null}
      </div>
    </div>
  </div>
);

export const HelpdeskEmpty = ({ icon: Icon = MessageCircle, title, detail, action = null }) => (
  <div className="rounded-2xl border border-dashed border-crewly-border bg-crewly-card/40 px-5 py-10 text-center">
    <Icon className="mx-auto h-8 w-8 text-crewly-dim/70" aria-hidden="true" />
    <h3 className="mt-3 text-sm font-semibold text-crewly-text">{title}</h3>
    {detail ? <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-crewly-dim">{detail}</p> : null}
    {action ? <div className="mt-4">{action}</div> : null}
  </div>
);

export const HelpdeskSlaSummary = ({ sla }) => {
  if (!sla || sla.configured === false) return null;
  const firstResponse = sla.firstResponse || {};
  const resolution = sla.resolution || {};
  const clocks = [
    ['First response', firstResponse],
    ['Resolution', resolution],
  ].filter(([, clock]) => clock.state || clock.dueAt || clock.breachedAt);
  if (!clocks.length) return null;
  return (
    <section className="rounded-xl border border-crewly-border bg-crewly-bg/60 p-3" aria-label="Service level targets">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-crewly-text">
        <Clock3 className="h-3.5 w-3.5 text-crewly-green" aria-hidden="true" />
        Service targets
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {clocks.map(([label, clock]) => {
          const breached = Boolean(clock.breachedAt) || String(clock.state || '').toUpperCase() === 'BREACHED';
          const completed = Boolean(clock.completedAt) || String(clock.state || '').toUpperCase() === 'COMPLETED';
          const Icon = breached ? XCircle : completed ? CheckCircle2 : Clock3;
          return (
            <div key={label} className="rounded-lg border border-crewly-border/70 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-crewly-dim">{label}</span>
                <Icon className={`h-3.5 w-3.5 ${breached ? 'text-rose-300' : completed ? 'text-emerald-300' : 'text-crewly-green'}`} aria-hidden="true" />
              </div>
              <p className={`mt-1 text-xs font-medium ${breached ? 'text-rose-200' : 'text-crewly-text'}`}>
                {completed ? `Completed ${dateTimeLabel(clock.completedAt)}` : breached ? `Target missed ${dateTimeLabel(clock.breachedAt)}` : `Due ${dateTimeLabel(clock.dueAt)}`}
              </p>
              <p className="mt-0.5 text-[10px] uppercase tracking-wide text-crewly-dim">{String(clock.state || 'not started').replaceAll('_', ' ')}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
};

export const ArticleText = ({ children }) => (
  <div className="whitespace-pre-wrap break-words text-sm leading-7 text-crewly-text">{children || 'No article text is available.'}</div>
);

export const AttachmentButton = ({ attachment, onDownload, busy = false }) => (
  <button
    type="button"
    className="inline-flex max-w-full items-center gap-2 rounded-lg border border-crewly-border bg-crewly-bg/70 px-3 py-2 text-left text-xs text-crewly-text hover:border-crewly-green/50 disabled:opacity-60"
    onClick={() => onDownload?.(attachment)}
    disabled={busy}
  >
    <FileText className="h-4 w-4 shrink-0 text-crewly-green" aria-hidden="true" />
    <span className="min-w-0 flex-1 truncate">{attachment?.fileName || 'Download attachment'}</span>
    <span className="shrink-0 text-crewly-dim">{relativeSize(attachment?.sizeBytes)}</span>
  </button>
);
