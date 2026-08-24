import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ClipboardList,
  FileText,
  PauseCircle,
  ShieldCheck,
  UserRoundCheck,
  UserRoundX,
} from 'lucide-react';
import { useState } from 'react';
import usePermission from '../../hooks/usePermission.js';
import recruitmentEvaluationService from '../../services/recruitmentEvaluationService.js';
import InterviewFeedbackSummary from './InterviewFeedbackSummary.jsx';
import FinalDecisionModal from './FinalDecisionModal.jsx';

const enumLabel = (value = '') =>
  String(value)
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const CandidateFinalReview = ({ candidate, ats, interviews = [], onChanged }) => {
  const { hasPermission } = usePermission();
  const canDecide = hasPermission('CANDIDATE_FINAL_DECISION');
  const [reviewComment, setReviewComment] = useState('');
  const [confirmReview, setConfirmReview] = useState(false);
  const [decision, setDecision] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const stage = candidate?.overview?.currentStage || candidate?.overview?.stage || '';
  const completedInterviews = interviews.filter((item) => item.status === 'COMPLETED');
  const activeInterviews = interviews.filter((item) => ['SCHEDULED', 'RESCHEDULED', 'IN_PROGRESS'].includes(item.status));
  const totalPendingFeedback = completedInterviews.reduce(
    (sum, item) => sum + Number(item.feedback?.pendingCount || 0),
    0
  );
  const readyForReview = completedInterviews.length > 0 && activeInterviews.length === 0 && totalPendingFeedback === 0;
  const decisionComplete = ['SELECTED', 'REJECTED', 'HOLD'].includes(stage);

  const startReview = async () => {
    if (busy || !readyForReview) return;
    setBusy(true);
    setError('');
    try {
      await recruitmentEvaluationService.startFinalReview(candidate.id, reviewComment.trim());
      setConfirmReview(false);
      setReviewComment('');
      await onChanged?.();
    } catch (requestError) {
      setError(requestError?.message || 'Final Review could not be started');
    } finally {
      setBusy(false);
    }
  };

  const submitDecision = async (payload) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await recruitmentEvaluationService.recordFinalDecision(candidate.id, payload);
      setDecision('');
      await onChanged?.();
    } catch (requestError) {
      setError(requestError?.message || 'The human decision could not be recorded');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-indigo-500/25 bg-slate-900">
      <header className="border-b border-slate-800 bg-gradient-to-br from-indigo-500/10 via-slate-900 to-slate-900 p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">
              <ClipboardList className="h-4 w-4" /> Final Review
            </p>
            <h2 className="mt-1 text-xl font-bold text-slate-100">Human decision workspace</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
              Review ATS evidence, the retained resume, every interview round, independent feedback, strengths, concerns, and timeline before recording a human outcome.
            </p>
          </div>
          <span className="w-fit rounded-full border border-slate-700 bg-slate-950/50 px-3 py-1.5 text-xs font-semibold text-slate-300">
            Pipeline: {enumLabel(stage)}
          </span>
        </div>
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <p className="text-xs leading-5 text-slate-500">
            No composite hiring score is produced. ATS scores, round averages, and recommendations never move the candidate or choose an outcome automatically.
          </p>
        </div>
      </header>

      <div className="space-y-5 p-5 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4">
            <p className="flex items-center gap-2 text-xs font-medium text-slate-400"><Bot className="h-4 w-4" /> ATS evidence</p>
            <p className="mt-2 text-lg font-semibold text-slate-100">
              {ats?.status === 'COMPLETED' ? `${ats.result?.overallScore ?? 0} / 100` : enumLabel(ats?.status || 'Unavailable')}
            </p>
            <p className="mt-1 text-xs text-slate-600">Assistive match only</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4">
            <p className="flex items-center gap-2 text-xs font-medium text-slate-400"><FileText className="h-4 w-4" /> Resume evidence</p>
            <p className="mt-2 text-lg font-semibold text-slate-100">{candidate?.resume?.available ? 'Available' : 'Unavailable'}</p>
            <p className="mt-1 text-xs text-slate-600">Retained source document</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4">
            <p className="flex items-center gap-2 text-xs font-medium text-slate-400"><UserRoundCheck className="h-4 w-4" /> Completed rounds</p>
            <p className="mt-2 text-lg font-semibold text-slate-100">{completedInterviews.length}</p>
            <p className="mt-1 text-xs text-slate-600">{activeInterviews.length} still active</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/35 p-4">
            <p className="flex items-center gap-2 text-xs font-medium text-slate-400"><CheckCircle2 className="h-4 w-4" /> Feedback readiness</p>
            <p className="mt-2 text-lg font-semibold text-slate-100">{totalPendingFeedback ? `${totalPendingFeedback} pending` : 'Complete'}</p>
            <p className="mt-1 text-xs text-slate-600">Independent records retained</p>
          </div>
        </div>

        {completedInterviews.length ? (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-100">Round-by-round evidence</h3>
            {completedInterviews.map((interview) => (
              <div key={interview.id}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
                  <p className="text-sm font-medium text-slate-200">{interview.round?.name}</p>
                  <p className="font-mono text-xs text-slate-500">{interview.interviewCode}</p>
                </div>
                <InterviewFeedbackSummary feedback={interview.feedback} />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-100/80">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /> Complete at least one interview before Final Review.
          </div>
        )}

        {error ? <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null}

        {canDecide && stage === 'HR_FINAL' ? (
          <section className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4">
            <h3 className="text-sm font-semibold text-indigo-100">Move to Final Review</h3>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              Final Review is available only after active interviews are closed and every assigned scorecard for completed rounds is submitted.
            </p>
            {!readyForReview ? (
              <p className="mt-3 text-xs text-amber-200">
                Resolve {activeInterviews.length} active interview{activeInterviews.length === 1 ? '' : 's'} and {totalPendingFeedback} pending scorecard{totalPendingFeedback === 1 ? '' : 's'} first.
              </p>
            ) : null}
            {confirmReview ? (
              <div className="mt-4 space-y-3 rounded-xl border border-slate-700 bg-slate-950/50 p-4">
                <label className="block text-xs text-slate-400">
                  Review note (optional)
                  <textarea className="input mt-1.5 min-h-20" maxLength={1000} value={reviewComment} onChange={(event) => setReviewComment(event.target.value)} placeholder="Document why the evidence is ready for final human review." />
                </label>
                <div className="flex justify-end gap-2">
                  <button type="button" className="btn-ghost" disabled={busy} onClick={() => setConfirmReview(false)}>Back</button>
                  <button type="button" className="btn-primary" disabled={busy} onClick={startReview}>{busy ? 'Starting…' : 'Confirm Final Review'}</button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn-primary mt-4" disabled={!readyForReview || busy} onClick={() => setConfirmReview(true)}>Begin Final Review</button>
            )}
          </section>
        ) : null}

        {canDecide && stage === 'FINAL_REVIEW' ? (
          <section className="rounded-xl border border-slate-700 bg-slate-950/45 p-4">
            <h3 className="text-sm font-semibold text-slate-100">Record final human decision</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">The authenticated decision actor, timestamp, safe reason, pipeline history, candidate timeline, and audit entry will be retained.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-500/15" onClick={() => setDecision('SELECTED')}><CheckCircle2 className="h-4 w-4" /> Select</button>
              <button type="button" className="inline-flex items-center gap-2 rounded-lg border border-rose-500/25 bg-rose-500/10 px-4 py-2 text-sm font-medium text-rose-200 hover:bg-rose-500/15" onClick={() => setDecision('REJECTED')}><UserRoundX className="h-4 w-4" /> Reject</button>
              <button type="button" className="inline-flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-200 hover:bg-amber-500/15" onClick={() => setDecision('HOLD')}><PauseCircle className="h-4 w-4" /> Hold</button>
            </div>
          </section>
        ) : null}

        {decisionComplete ? (
          <div className="flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
            <div>
              <p className="text-sm font-semibold text-emerald-200">Human decision recorded: {enumLabel(stage)}</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                The candidate remains in this pipeline stage. {stage === 'SELECTED' ? 'No offer was created by this action.' : 'No candidate-facing evaluation content was exposed.'}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {decision ? (
        <FinalDecisionModal
          decision={decision}
          candidateName={candidate?.overview?.name || 'Candidate'}
          busy={busy}
          error={error}
          onClose={() => !busy && setDecision('')}
          onSubmit={submitDecision}
        />
      ) : null}
    </section>
  );
};

export default CandidateFinalReview;
