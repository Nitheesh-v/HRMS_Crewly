/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BadgeCheck,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  Check,
  CircleDollarSign,
  ClipboardCheck,
  Clock3,
  Eye,
  History,
  MapPin,
  MessageSquareText,
  RefreshCw,
  RotateCcw,
  Search,
  SendToBack,
  ShieldCheck,
  UserRound,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import usePermission from '../../hooks/usePermission.js';
import requisitionService from '../../services/requisitionService.js';

const DECISIONS = {
  APPROVED: {
    title: 'Approve requisition',
    confirmLabel: 'Approve requisition',
    prompt: 'Approval confirms that HR accepts this hiring requirement. It does not create a job posting.',
    fieldLabel: 'Approval note (optional)',
    placeholder: 'Add context for the requester or recruitment team',
    required: false,
    icon: Check,
    buttonClass: 'bg-emerald-500 text-slate-950 hover:bg-emerald-400',
  },
  REJECTED: {
    title: 'Reject requisition',
    confirmLabel: 'Reject requisition',
    prompt: 'A clear rejection reason is required and will be sent to the requester.',
    fieldLabel: 'Rejection reason *',
    placeholder: 'Explain why this hiring request cannot proceed',
    required: true,
    icon: XCircle,
    buttonClass: 'bg-rose-500 text-white hover:bg-rose-400',
  },
  SENT_BACK: {
    title: 'Request changes',
    confirmLabel: 'Send back for changes',
    prompt: 'The requester can edit and resubmit this requisition after addressing your comment.',
    fieldLabel: 'Changes required *',
    placeholder: 'List the information or corrections the requester must provide',
    required: true,
    icon: SendToBack,
    buttonClass: 'bg-sky-500 text-slate-950 hover:bg-sky-400',
  },
};

const PRIORITY_STYLE = {
  LOW: 'border-slate-500/40 bg-slate-500/10 text-slate-300',
  MEDIUM: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  HIGH: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  CRITICAL: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
};

const enumLabel = (value = '') =>
  String(value)
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const dateLabel = (value, includeTime = false) => {
  if (!value) return 'Not set';

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(includeTime
      ? {
          hour: '2-digit',
          minute: '2-digit',
        }
      : {}),
  }).format(new Date(value));
};

const moneyLabel = (value) =>
  value === null || value === undefined || value === ''
    ? 'Not set'
    : new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0,
      }).format(value);

const errorText = (error) => error?.message || 'Something went wrong';

const Modal = ({ title, subtitle = '', onClose, wide = false, children }) => (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm"
    onMouseDown={onClose}
  >
    <section
      className={`max-h-[92vh] w-full overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl ${
        wide ? 'max-w-5xl' : 'max-w-xl'
      }`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-700 bg-slate-900/95 px-6 py-4 backdrop-blur">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
          {subtitle && <p className="mt-1 text-xs text-slate-400">{subtitle}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="p-6">{children}</div>
    </section>
  </div>
);

const DetailItem = ({ label, value, icon: Icon }) => (
  <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
    <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-500">
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {label}
    </p>
    <div className="mt-1.5 text-sm text-slate-200">{value || 'Not set'}</div>
  </div>
);

const RequisitionApprovalsPage = () => {
  const {
    loading: permissionsLoading,
    hasPermission,
    hasAnyPermission,
  } = usePermission();

  const canApprove = hasPermission('REQUISITION_APPROVE');
  const canReject = hasPermission('REQUISITION_REJECT');
  const canSendBack = hasPermission('REQUISITION_SEND_BACK');
  const canReadCandidates = hasPermission('CANDIDATE_READ');
  const canDecide = hasAnyPermission([
    'REQUISITION_APPROVE',
    'REQUISITION_REJECT',
    'REQUISITION_SEND_BACK',
  ]);

  const [queue, setQueue] = useState([]);
  const [summary, setSummary] = useState({});
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [priority, setPriority] = useState('');
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [decisionModal, setDecisionModal] = useState(null);
  const [comment, setComment] = useState('');
  const [decisionError, setDecisionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);

  const flash = useCallback((type, message) => {
    setBanner({ type, message });
    window.setTimeout(() => setBanner(null), 5000);
  }, []);

  const loadQueue = useCallback(async () => {
    setLoading(true);

    try {
      const result = await requisitionService.list({
        status: 'PENDING_HR',
        search: appliedSearch || undefined,
        priority: priority || undefined,
        limit: 200,
      });

      setQueue(result.requisitions || []);
      setSummary(result.summary || result.meta?.summary || {});
    } catch (error) {
      flash('error', errorText(error));
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, flash, priority]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const totalOpenings = useMemo(
    () => queue.reduce((total, requisition) => total + (Number(requisition.openings) || 0), 0),
    [queue]
  );

  const openDetail = async (requisition) => {
    setDetail({ ...requisition, loading: true });

    try {
      const result = await requisitionService.getById(requisition._id);

      if (result.status !== 'PENDING_HR') {
        setDetail(null);
        flash('error', 'This requisition has already left the HR approval queue');
        await loadQueue();
        return;
      }

      setDetail(result);
    } catch (error) {
      setDetail(null);
      flash('error', errorText(error));
    }
  };

  const openDecision = (decision) => {
    setComment('');
    setDecisionError('');
    setDecisionModal({ decision, requisition: detail });
  };

  const closeDecision = () => {
    if (busy) return;
    setDecisionModal(null);
    setComment('');
    setDecisionError('');
  };

  const submitDecision = async () => {
    if (!decisionModal) return;

    const config = DECISIONS[decisionModal.decision];
    const normalizedComment = comment.trim();

    if (config.required && !normalizedComment) {
      setDecisionError(`${config.fieldLabel.replace(' *', '')} is required`);
      return;
    }

    setBusy(true);
    setDecisionError('');

    try {
      const serviceMethod = {
        APPROVED: requisitionService.approve,
        REJECTED: requisitionService.reject,
        SENT_BACK: requisitionService.sendBack,
      }[decisionModal.decision];

      const result = await serviceMethod(
        decisionModal.requisition._id,
        normalizedComment
      );

      const successMessage = {
        APPROVED: `${result.requisitionNumber} approved`,
        REJECTED: `${result.requisitionNumber} rejected`,
        SENT_BACK: `${result.requisitionNumber} sent back for changes`,
      }[decisionModal.decision];

      setDecisionModal(null);
      setDetail(null);
      setComment('');
      flash('success', successMessage);
      await loadQueue();
    } catch (error) {
      setDecisionError(errorText(error));
      await loadQueue();
    } finally {
      setBusy(false);
    }
  };

  const stats = [
    {
      label: 'Awaiting review',
      value: summary.PENDING_HR || queue.length,
      icon: Clock3,
      tone: 'text-amber-300',
    },
    {
      label: 'Pending openings',
      value: totalOpenings,
      icon: Users,
      tone: 'text-indigo-300',
    },
    {
      label: 'Approved',
      value: summary.APPROVED || 0,
      icon: BadgeCheck,
      tone: 'text-emerald-300',
    },
    {
      label: 'Returned / rejected',
      value: (summary.SENT_BACK || 0) + (summary.REJECTED || 0),
      icon: RotateCcw,
      tone: 'text-sky-300',
    },
  ];

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-indigo-300">
            <ShieldCheck className="h-4 w-4" /> Recruitment governance
          </div>
          <h1 className="mt-1 text-2xl font-bold text-slate-100">HR approval queue</h1>
          <p className="mt-1 text-sm text-slate-400">
            Review submitted hiring needs before recruitment begins.
          </p>
        </div>
        <button
          type="button"
          className="btn-ghost gap-2"
          onClick={loadQueue}
          disabled={loading}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh queue
        </button>
      </header>

      <nav className="flex gap-6 overflow-x-auto border-b border-slate-800 text-sm">
        <Link
          to="/app/recruitment/requisitions"
          className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
        >
          Requisitions
        </Link>
        <span className="border-b-2 border-indigo-400 px-1 pb-3 font-semibold text-indigo-300">
          HR approvals
        </span>
        {canReadCandidates && (
          <Link
            to="/app/recruitment/candidates"
            className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
          >
            Candidates
          </Link>
        )}
        <Link
          to="/app/recruitment/legacy"
          className="px-1 pb-3 text-slate-400 transition hover:text-slate-200"
        >
          Existing jobs & candidate pipeline
        </Link>
        <span className="cursor-not-allowed px-1 pb-3 text-slate-600" title="Later Phase 27 subphase">
          Analytics
        </span>
      </nav>

      {banner && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            banner.type === 'error'
              ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          {banner.message}
        </div>
      )}

      {!permissionsLoading && !canDecide && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Your role can view this queue but has no requisition decision permissions.
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(({ label, value, icon: Icon, tone }) => (
          <article key={label} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
              <Icon className={`h-4 w-4 ${tone}`} />
            </div>
            <p className="mt-3 text-2xl font-bold text-slate-100">{value}</p>
          </article>
        ))}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <form
            className="relative flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              setAppliedSearch(search.trim());
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
            <input
              className="input !py-2 !pl-9 text-sm"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search JR number, position, team or location"
            />
          </form>
          <select
            className="input w-full !py-2 text-sm md:w-48"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          >
            <option value="">All priorities</option>
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="CRITICAL">Critical</option>
          </select>
        </div>
      </section>

      {loading ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-12 text-center text-sm text-slate-400">
          Loading HR approval queue…
        </div>
      ) : queue.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/60 p-12 text-center">
          <ClipboardCheck className="mx-auto h-10 w-10 text-emerald-400/70" />
          <h2 className="mt-3 font-semibold text-slate-200">Approval queue is clear</h2>
          <p className="mt-1 text-sm text-slate-500">
            No pending requisitions match the current filters.
          </p>
        </div>
      ) : (
        <section className="grid gap-4 xl:grid-cols-2">
          {queue.map((requisition) => (
            <article
              key={requisition._id}
              className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-sm transition hover:border-slate-700"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-indigo-300">
                    {requisition.requisitionNumber}
                  </p>
                  <h2 className="mt-1 truncate text-lg font-semibold text-slate-100">
                    {requisition.position}
                  </h2>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                    <UserRound className="h-3.5 w-3.5" />
                    Requested by {requisition.requester?.name || 'Unknown requester'}
                  </p>
                </div>
                <span
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                    PRIORITY_STYLE[requisition.priority] || PRIORITY_STYLE.MEDIUM
                  }`}
                >
                  {enumLabel(requisition.priority)}
                </span>
              </div>

              <div className="mt-4 grid gap-2 text-xs text-slate-400 sm:grid-cols-2">
                <p className="flex items-center gap-2 rounded-lg bg-slate-950/50 px-3 py-2">
                  <Building2 className="h-3.5 w-3.5 text-slate-500" />
                  {requisition.department?.name || 'Department unavailable'}
                </p>
                <p className="flex items-center gap-2 rounded-lg bg-slate-950/50 px-3 py-2">
                  <Users className="h-3.5 w-3.5 text-slate-500" />
                  {requisition.openings} opening{requisition.openings === 1 ? '' : 's'}
                </p>
                <p className="flex items-center gap-2 rounded-lg bg-slate-950/50 px-3 py-2">
                  <MapPin className="h-3.5 w-3.5 text-slate-500" />
                  {requisition.location || 'Location not set'}
                </p>
                <p className="flex items-center gap-2 rounded-lg bg-slate-950/50 px-3 py-2">
                  <CalendarDays className="h-3.5 w-3.5 text-slate-500" />
                  Needed by {dateLabel(requisition.expectedJoiningDate)}
                </p>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-slate-800 pt-4">
                <p className="text-[11px] text-slate-500">
                  Submitted {dateLabel(requisition.submittedAt, true)}
                </p>
                <button
                  type="button"
                  onClick={() => openDetail(requisition)}
                  className="inline-flex items-center gap-2 rounded-lg bg-indigo-500/15 px-3 py-2 text-xs font-semibold text-indigo-300 transition hover:bg-indigo-500/25"
                >
                  <Eye className="h-3.5 w-3.5" /> Review details
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {detail && (
        <Modal
          wide
          title={detail.requisitionNumber || 'Requisition review'}
          subtitle={detail.position || 'Loading requisition details…'}
          onClose={() => !busy && setDetail(null)}
        >
          {detail.loading ? (
            <p className="py-12 text-center text-sm text-slate-400">Loading complete requisition…</p>
          ) : (
            <div className="space-y-6">
              <div className="flex flex-col gap-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
                    <Clock3 className="h-4 w-4" /> Pending HR decision
                  </p>
                  <p className="mt-1 text-xs text-amber-200/70">
                    Submitted by {detail.requester?.name || 'Unknown'} on {dateLabel(detail.submittedAt, true)}
                  </p>
                </div>
                <span className="text-xs text-amber-200">No job is created by approval</span>
              </div>

              <section>
                <h3 className="mb-3 text-sm font-semibold text-slate-200">Hiring requirement</h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <DetailItem label="Department" value={detail.department?.name} icon={Building2} />
                  <DetailItem label="Team" value={detail.team} icon={Users} />
                  <DetailItem label="Openings" value={String(detail.openings)} icon={Users} />
                  <DetailItem label="Priority" value={enumLabel(detail.priority)} icon={Clock3} />
                  <DetailItem label="Employment" value={enumLabel(detail.employmentType)} icon={BriefcaseBusiness} />
                  <DetailItem
                    label="Experience"
                    value={
                      detail.experienceLevel === 'FRESHER'
                        ? 'Fresher'
                        : `${detail.minExperience}–${detail.maxExperience} years`
                    }
                  />
                  <DetailItem label="Work mode" value={enumLabel(detail.workMode)} icon={MapPin} />
                  <DetailItem label="Joining date" value={dateLabel(detail.expectedJoiningDate)} icon={CalendarDays} />
                </div>
              </section>

              <section className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <h3 className="text-sm font-semibold text-slate-200">Skills</h3>
                  <p className="mt-3 text-xs text-slate-500">Required</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(detail.requiredSkills || []).length > 0 ? (
                      detail.requiredSkills.map((skill) => (
                        <span key={skill} className="rounded-full bg-indigo-500/10 px-2.5 py-1 text-xs text-indigo-300">
                          {skill}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-slate-500">Not set</span>
                    )}
                  </div>
                  <p className="mt-4 text-xs text-slate-500">Preferred</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(detail.preferredSkills || []).length > 0 ? (
                      detail.preferredSkills.map((skill) => (
                        <span key={skill} className="rounded-full bg-sky-500/10 px-2.5 py-1 text-xs text-sky-300">
                          {skill}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-slate-500">Not set</span>
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                    <CircleDollarSign className="h-4 w-4 text-emerald-300" /> Budget and business reason
                  </h3>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <DetailItem label="Salary min" value={moneyLabel(detail.salaryMin)} />
                    <DetailItem label="Salary max" value={moneyLabel(detail.salaryMax)} />
                    <DetailItem label="Hiring budget" value={moneyLabel(detail.hiringBudget)} />
                  </div>
                  <p className="mt-4 text-xs uppercase tracking-wide text-slate-500">Reason</p>
                  <p className="mt-1 text-sm text-slate-300">
                    {enumLabel(detail.hiringReason)}
                    {detail.hiringReasonDetails ? ` — ${detail.hiringReasonDetails}` : ''}
                  </p>
                </div>
              </section>

              <section>
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
                  <History className="h-4 w-4 text-indigo-300" /> Requisition history
                </h3>
                <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
                  {[...(detail.history || [])].reverse().map((entry, index) => (
                    <div
                      key={entry._id || `${entry.action}-${index}`}
                      className="rounded-xl border border-slate-800 bg-slate-950/40 p-4"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-slate-200">{enumLabel(entry.action)}</p>
                        {entry.fromStatus && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                            {enumLabel(entry.fromStatus)}
                            <ArrowRight className="h-3 w-3" />
                            {enumLabel(entry.toStatus)}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {entry.actor?.name || entry.actorName || 'System'} · {dateLabel(entry.at, true)}
                      </p>
                      {entry.comment && <p className="mt-2 text-xs text-slate-300">{entry.comment}</p>}
                    </div>
                  ))}
                </div>
              </section>

              <footer className="flex flex-col gap-3 border-t border-slate-800 pt-5 sm:flex-row sm:items-center">
                <p className="text-xs text-slate-500 sm:mr-auto">
                  Each decision records your identity, timestamp, comment, audit entry, and requester notification.
                </p>
                {canReject && (
                  <button
                    type="button"
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-rose-500/30 px-3 py-2 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/10"
                    onClick={() => openDecision('REJECTED')}
                  >
                    <XCircle className="h-4 w-4" /> Reject
                  </button>
                )}
                {canSendBack && (
                  <button
                    type="button"
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-sky-500/30 px-3 py-2 text-xs font-semibold text-sky-300 transition hover:bg-sky-500/10"
                    onClick={() => openDecision('SENT_BACK')}
                  >
                    <SendToBack className="h-4 w-4" /> Request changes
                  </button>
                )}
                {canApprove && (
                  <button
                    type="button"
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400"
                    onClick={() => openDecision('APPROVED')}
                  >
                    <Check className="h-4 w-4" /> Approve
                  </button>
                )}
              </footer>
            </div>
          )}
        </Modal>
      )}

      {decisionModal && (
        <Modal
          title={DECISIONS[decisionModal.decision].title}
          subtitle={`${decisionModal.requisition.requisitionNumber} · ${decisionModal.requisition.position}`}
          onClose={closeDecision}
        >
          {(() => {
            const config = DECISIONS[decisionModal.decision];
            const Icon = config.icon;

            return (
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-700 bg-slate-950/50 p-4 text-sm text-slate-300">
                  {config.prompt}
                </div>

                <label className="block">
                  <span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-slate-300">
                    <MessageSquareText className="h-3.5 w-3.5" /> {config.fieldLabel}
                  </span>
                  <textarea
                    className="input min-h-28"
                    maxLength={500}
                    value={comment}
                    onChange={(event) => {
                      setComment(event.target.value);
                      setDecisionError('');
                    }}
                    placeholder={config.placeholder}
                    autoFocus
                  />
                  <span className="mt-1 block text-right text-[11px] text-slate-500">
                    {comment.length}/500
                  </span>
                </label>

                {decisionError && (
                  <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                    {decisionError}
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <button type="button" className="btn-ghost" disabled={busy} onClick={closeDecision}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${config.buttonClass}`}
                    disabled={busy || (config.required && !comment.trim())}
                    onClick={submitDecision}
                  >
                    <Icon className="h-4 w-4" />
                    {busy ? 'Recording decision…' : config.confirmLabel}
                  </button>
                </div>
              </div>
            );
          })()}
        </Modal>
      )}
    </div>
  );
};

export default RequisitionApprovalsPage;
