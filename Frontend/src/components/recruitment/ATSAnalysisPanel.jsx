import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  GraduationCap,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TimerReset,
  Wrench,
  XCircle,
} from 'lucide-react';

const categoryTone = {
  STRONG: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  GOOD: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
  MODERATE: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  WEAK: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
};

const pendingCopy = {
  NO_RESUME: {
    title: 'Resume required',
    detail: 'ATS matching starts only after a secure resume is available and parsed.',
    icon: AlertTriangle,
  },
  PARSING_PENDING: {
    title: 'Waiting for resume parsing',
    detail: 'The ATS engine will run automatically after secure parsing completes.',
    icon: Clock3,
  },
  PARSING_FAILED: {
    title: 'Resume parsing did not complete',
    detail: 'Reprocess the resume before requesting ATS matching. Candidate-entered information remains preserved.',
    icon: AlertTriangle,
  },
  PARSING_UNSUPPORTED: {
    title: 'Resume format is unsupported',
    detail: 'ATS matching is unavailable because no safe structured resume data could be produced.',
    icon: AlertTriangle,
  },
  PARSING_REVIEW_REQUIRED: {
    title: 'Resume requires manual review',
    detail: 'The document did not contain enough machine-readable text for reliable ATS matching.',
    icon: AlertTriangle,
  },
  MATCHING_PENDING: {
    title: 'ATS matching is queued',
    detail: 'The parsed resume and job requirements are being evaluated in the background.',
    icon: CircleDashed,
  },
};

const numberLabel = (value) =>
  Number.isInteger(Number(value))
    ? String(Number(value))
    : Number(value || 0).toFixed(1);

const categoryLabel = (value = '') =>
  `${value.charAt(0)}${value.slice(1).toLowerCase()} match`;

const dateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : 'Not evaluated';

const ChipList = ({ title, items, matched = false }) => {
  if (!items?.length) return null;
  const Icon = matched ? CheckCircle2 : XCircle;

  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {items.map((item, index) => (
          <span
            key={`${title}-${item}-${index}`}
            className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${
              matched
                ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                : 'border-rose-500/25 bg-rose-500/10 text-rose-200'
            }`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="break-words">{item}</span>
          </span>
        ))}
      </div>
    </div>
  );
};

const BreakdownCard = ({ icon: Icon, title, match, children }) => (
  <article className="rounded-2xl border border-slate-800 bg-slate-950/45 p-4 sm:p-5">
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-indigo-300" />
        <h3 className="font-semibold text-slate-200">{title}</h3>
      </div>
      <span className="shrink-0 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2.5 py-1 text-xs font-semibold text-indigo-200">
        {numberLabel(match?.score)} / {numberLabel(match?.maxScore)}
      </span>
    </div>
    <p className="mt-3 text-sm leading-6 text-slate-400">{match?.explanation}</p>
    {children ? <div className="mt-4 space-y-4">{children}</div> : null}
  </article>
);

const ScoreGauge = ({ score }) => {
  const safeScore = Math.max(0, Math.min(100, Number(score) || 0));

  return (
    <div
      className="relative grid h-40 w-40 shrink-0 place-items-center rounded-full p-3"
      style={{
        background: `conic-gradient(rgb(129 140 248) ${safeScore * 3.6}deg, rgb(30 41 59) 0deg)`,
      }}
      aria-label={`ATS score ${numberLabel(safeScore)} out of 100`}
    >
      <div className="grid h-full w-full place-items-center rounded-full border border-slate-800 bg-slate-950 text-center shadow-inner">
        <div>
          <p className="text-4xl font-bold text-slate-100">{numberLabel(safeScore)}</p>
          <p className="mt-1 text-xs uppercase tracking-[0.2em] text-slate-500">out of 100</p>
        </div>
      </div>
    </div>
  );
};

const ATSAnalysisPanel = ({
  ats,
  loading,
  error,
  canReprocess,
  reprocessBusy,
  onReprocess,
}) => {
  if (loading) {
    return <div className="h-80 animate-pulse rounded-2xl border border-slate-800 bg-slate-900" />;
  }

  if (error) {
    return (
      <section className="rounded-2xl border border-rose-500/25 bg-slate-900 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" />
          <div>
            <h2 className="font-semibold text-slate-100">Crewly ATS Analysis unavailable</h2>
            <p role="alert" className="mt-1 text-sm text-rose-200">{error}</p>
          </div>
        </div>
      </section>
    );
  }

  if (ats?.status !== 'COMPLETED' || !ats?.result) {
    const copy = pendingCopy[ats?.status] || pendingCopy.MATCHING_PENDING;
    const StateIcon = copy.icon;

    return (
      <section className="rounded-2xl border border-indigo-500/20 bg-slate-900 p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-2.5">
              <StateIcon className={`h-5 w-5 text-indigo-300 ${ats?.status === 'MATCHING_PENDING' ? 'animate-pulse' : ''}`} />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">Crewly ATS Analysis</p>
              <h2 className="mt-1 text-lg font-semibold text-slate-100">{copy.title}</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">{ats?.message || copy.detail}</p>
            </div>
          </div>
          {canReprocess && reprocessBusy ? (
            <button type="button" className="btn-primary shrink-0 gap-2" disabled>
              <RefreshCw className="h-4 w-4 animate-spin" /> Recalculating…
            </button>
          ) : null}
        </div>
        <div className="mt-5 flex items-start gap-2 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <p className="text-xs leading-5 text-slate-500">
            ATS matching is assistive only. It never shortlists, rejects, hides, or makes a hiring decision about a candidate.
          </p>
        </div>
      </section>
    );
  }

  const result = ats.result;
  const breakdown = result.breakdown || {};
  const locationNotice = breakdown.locationAndNotice || {};

  return (
    <section className="overflow-hidden rounded-2xl border border-indigo-500/25 bg-slate-900">
      <div className="border-b border-slate-800 bg-gradient-to-br from-indigo-500/10 via-slate-900 to-slate-900 p-5 sm:p-7">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
            <ScoreGauge score={result.overallScore} />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">Crewly ATS Analysis</p>
                <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${categoryTone[result.matchCategory] || categoryTone.MODERATE}`}>
                  {categoryLabel(result.matchCategory)}
                </span>
              </div>
              <h2 className="mt-2 text-2xl font-bold text-slate-100">Explainable job match</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-slate-400">
                This score compares available resume and application evidence with the current job requirements. Review every category before taking any human decision.
              </p>
              <p className="mt-2 text-xs text-slate-500">
                Engine {result.engineVersion} · Evaluated {dateLabel(result.evaluatedAt)}
              </p>
            </div>
          </div>
          {canReprocess ? (
            <button
              type="button"
              className="btn-primary shrink-0 gap-2 self-start lg:self-center"
              onClick={onReprocess}
              disabled={reprocessBusy}
            >
              <RefreshCw className={`h-4 w-4 ${reprocessBusy ? 'animate-spin' : ''}`} />
              {reprocessBusy ? 'Recalculating…' : 'Recalculate ATS'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 p-5 sm:p-6 lg:grid-cols-2">
        <BreakdownCard icon={Wrench} title="Required skills" match={breakdown.requiredSkills}>
          <ChipList title="Matched required skills" items={breakdown.requiredSkills?.matched} matched />
          <ChipList title="Missing required skills" items={breakdown.requiredSkills?.missing} />
        </BreakdownCard>

        <BreakdownCard icon={TimerReset} title="Experience" match={breakdown.experience}>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
              <p className="text-slate-500">Candidate evidence</p>
              <p className="mt-1 font-semibold text-slate-200">{numberLabel((breakdown.experience?.candidateMonths || 0) / 12)} years</p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
              <p className="text-slate-500">Required minimum</p>
              <p className="mt-1 font-semibold text-slate-200">{numberLabel((breakdown.experience?.requiredMinMonths || 0) / 12)} years</p>
            </div>
          </div>
          <p className="text-xs text-slate-500">Source: {breakdown.experience?.source === 'PARSED_RESUME' ? 'Parsed resume duration' : 'Candidate declaration fallback'}</p>
        </BreakdownCard>

        <BreakdownCard icon={Sparkles} title="Preferred skills" match={breakdown.preferredSkills}>
          <ChipList title="Matched preferred skills" items={breakdown.preferredSkills?.matched} matched />
          <ChipList title="Missing preferred skills" items={breakdown.preferredSkills?.missing} />
        </BreakdownCard>

        <BreakdownCard icon={GraduationCap} title="Education" match={breakdown.education}>
          <ChipList title="Matched requirements" items={breakdown.education?.matched} matched />
          <ChipList title="Missing requirements" items={breakdown.education?.missing} />
          {breakdown.education?.candidateQualifications?.length ? (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Candidate qualifications considered</p>
              <p className="mt-2 text-xs leading-5 text-slate-300">{breakdown.education.candidateQualifications.join(' · ')}</p>
            </div>
          ) : null}
        </BreakdownCard>

        <BreakdownCard icon={MapPin} title="Location and notice period" match={locationNotice}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-slate-300">Location</p>
                <span className="text-xs text-indigo-200">{numberLabel(locationNotice.location?.score)} / {numberLabel(locationNotice.location?.maxScore)}</span>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500">{locationNotice.location?.explanation}</p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-slate-300">Notice period</p>
                <span className="text-xs text-indigo-200">{numberLabel(locationNotice.notice?.score)} / {numberLabel(locationNotice.notice?.maxScore)}</span>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500">{locationNotice.notice?.explanation}</p>
            </div>
          </div>
        </BreakdownCard>
      </div>

      <div className="border-t border-slate-800 bg-slate-950/40 p-5 sm:px-6">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-indigo-300" />
          <p className="text-xs leading-5 text-slate-500">
            Assistive analysis only. The score does not automatically shortlist, reject, rank away, or make a hiring decision. HR remains responsible for fair, contextual review.
          </p>
        </div>
      </div>
    </section>
  );
};

export default ATSAnalysisPanel;
