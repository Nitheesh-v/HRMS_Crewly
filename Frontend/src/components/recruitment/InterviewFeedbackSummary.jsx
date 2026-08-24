import { AlertTriangle, CheckCircle2, Clock3, LockKeyhole, Users } from 'lucide-react';

const enumLabel = (value = '') =>
  String(value)
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const Score = ({ value, max = 10 }) => (
  <span className="font-mono text-sm font-semibold text-indigo-200">
    {value === null || value === undefined ? '—' : Number(value).toFixed(2)} / {max}
  </span>
);

const InterviewFeedbackSummary = ({ feedback, compact = false }) => {
  if (!feedback?.enabled && !feedback?.submittedCount) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4 text-sm text-slate-500">
        Scorecards become available after operational interview completion.
      </div>
    );
  }

  const individuals = Array.isArray(feedback.individualFeedback)
    ? feedback.individualFeedback
    : [];

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-950/35 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Users className="h-4 w-4 text-indigo-300" /> Structured feedback
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            {feedback.submittedCount || 0} of {feedback.assignedCount || 0} assigned scorecards submitted
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {feedback.pendingCount ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-200">
              <Clock3 className="h-3.5 w-3.5" /> {feedback.pendingCount} pending
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-200">
              <CheckCircle2 className="h-3.5 w-3.5" /> Complete
            </span>
          )}
          {feedback.roundAverage !== null && feedback.roundAverage !== undefined ? (
            <span className="rounded-full border border-indigo-500/25 bg-indigo-500/10 px-2.5 py-1 text-xs text-indigo-200">
              Round average <Score value={feedback.roundAverage} max={feedback.maxOverallScore || 10} />
            </span>
          ) : null}
        </div>
      </div>

      {feedback.pendingInterviewers?.length ? (
        <p className="mt-3 text-xs text-slate-500">
          Pending: {feedback.pendingInterviewers.map((person) => person?.name || 'Assigned interviewer').join(', ')}
        </p>
      ) : null}

      {!compact && individuals.length ? (
        <div className="mt-4 space-y-3">
          {individuals.map((item) => (
            <details key={item.id} className="group rounded-xl border border-slate-800 bg-slate-900/70">
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">{item.interviewer?.name || 'Interviewer'}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{enumLabel(item.recommendation)} · submitted</p>
                </div>
                <Score value={item.overallScore} max={item.maxOverallScore || 10} />
              </summary>
              <div className="space-y-4 border-t border-slate-800 px-4 py-4">
                <div className="grid gap-2 sm:grid-cols-2">
                  {(item.ratings || []).map((rating) => (
                    <div key={rating.criterionKey} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-xs font-medium text-slate-300">{rating.criterionLabel}</p>
                        <span className="font-mono text-xs text-indigo-200">{rating.score} / {rating.maxScore}</span>
                      </div>
                      {rating.comment ? <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-500">{rating.comment}</p> : null}
                    </div>
                  ))}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/5 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300">Strengths</p>
                    <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-300">{item.strengths || 'None recorded.'}</p>
                  </div>
                  <div className="rounded-lg border border-amber-500/15 bg-amber-500/5 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-300">Concerns</p>
                    <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-300">{item.concerns || 'None recorded.'}</p>
                  </div>
                </div>
                {item.privateNotes ? (
                  <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-3">
                    <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      <LockKeyhole className="h-3.5 w-3.5" /> HR-private interview notes
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-300">{item.privateNotes}</p>
                  </div>
                ) : null}
              </div>
            </details>
          ))}
        </div>
      ) : null}

      {!compact && feedback.submittedCount > 0 && !individuals.length ? (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-slate-800 bg-slate-900 p-3 text-xs text-slate-500">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Individual evaluations require HR feedback-read permission.
        </div>
      ) : null}
    </section>
  );
};

export default InterviewFeedbackSummary;
