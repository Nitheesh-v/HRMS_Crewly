/* eslint-disable react-hooks/set-state-in-effect */
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  LockKeyhole,
  Save,
  Send,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import recruitmentEvaluationService from '../../services/recruitmentEvaluationService.js';

const RECOMMENDATIONS = [
  ['STRONG_HIRE', 'Strong hire'],
  ['HIRE', 'Hire'],
  ['NEXT_ROUND', 'Proceed to next round'],
  ['HOLD', 'Hold'],
  ['NO_HIRE', 'No hire'],
];

const emptyNarrative = {
  strengths: '',
  concerns: '',
  privateNotes: '',
  recommendation: '',
};

const dateLabel = (value) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : '';

const InterviewFeedbackModal = ({ interviewId, onClose, onSaved }) => {
  const [context, setContext] = useState(null);
  const [template, setTemplate] = useState(null);
  const [ratings, setRatings] = useState({});
  const [narrative, setNarrative] = useState(emptyNarrative);
  const [feedback, setFeedback] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const readOnly = ['SUBMITTED', 'LOCKED'].includes(feedback?.status);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [ownResult, scorecardResult] = await Promise.all([
        recruitmentEvaluationService.myFeedback(interviewId),
        recruitmentEvaluationService.scorecard(interviewId),
      ]);
      const nextTemplate = ownResult.template || scorecardResult.template;
      const existing = ownResult.feedback;
      setContext(scorecardResult.interview || null);
      setTemplate(nextTemplate);
      setFeedback(existing);
      setRatings(
        Object.fromEntries(
          (existing?.ratings || []).map((item) => [
            item.criterionKey,
            { score: item.score, comment: item.comment || '' },
          ])
        )
      );
      setNarrative({
        strengths: existing?.strengths || '',
        concerns: existing?.concerns || '',
        privateNotes: existing?.privateNotes || '',
        recommendation: existing?.recommendation || '',
      });
    } catch (requestError) {
      setError(requestError?.message || 'The interview scorecard could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [interviewId]);

  useEffect(() => {
    load();
  }, [load]);

  const payload = useMemo(
    () => ({
      ratings: (template?.criteria || [])
        .filter((criterion) => ratings[criterion.key]?.score !== '' && ratings[criterion.key]?.score !== undefined)
        .map((criterion) => ({
          criterionKey: criterion.key,
          score: Number(ratings[criterion.key].score),
          comment: ratings[criterion.key].comment || '',
        })),
      ...narrative,
    }),
    [narrative, ratings, template]
  );

  const updateRating = (criterionKey, field, value) => {
    setRatings((current) => ({
      ...current,
      [criterionKey]: {
        score: current[criterionKey]?.score ?? '',
        comment: current[criterionKey]?.comment || '',
        [field]: value,
      },
    }));
  };

  const save = async (action) => {
    if (busy || readOnly) return;
    setBusy(true);
    setError('');
    try {
      const result = await recruitmentEvaluationService.saveMyFeedback(interviewId, {
        ...payload,
        action,
      });
      setFeedback(result);
      setConfirmSubmit(false);
      await onSaved?.(result);
    } catch (requestError) {
      setError(requestError?.message || 'Interview feedback could not be saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-sm" onMouseDown={() => !busy && onClose()}>
      <section className="max-h-[95vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <header className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-800 bg-slate-900/95 px-5 py-4 backdrop-blur">
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-indigo-300">
              <ClipboardCheck className="h-4 w-4" /> Interview scorecard
            </p>
            <h2 className="mt-1 text-lg font-semibold text-slate-100">
              {context?.candidate?.name || 'Assigned candidate'}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {context?.interviewCode} · {context?.round?.name} · {template?.name}
            </p>
          </div>
          <button type="button" className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Close scorecard" disabled={busy} onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>

        {loading ? (
          <div className="m-6 h-80 animate-pulse rounded-2xl bg-slate-950/40" />
        ) : error && !template ? (
          <div className="p-6">
            <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</p>
            <button type="button" className="btn-ghost mt-4" onClick={load}>Try again</button>
          </div>
        ) : (
          <div className="space-y-5 p-5 sm:p-6">
            <div className={`flex items-start gap-3 rounded-xl border p-4 ${readOnly ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-indigo-500/20 bg-indigo-500/5'}`}>
              {readOnly ? <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-indigo-300" />}
              <div>
                <p className="text-sm font-medium text-slate-200">
                  {readOnly ? 'Submitted and locked' : feedback?.status === 'DRAFT' ? 'Draft in progress' : 'Independent interviewer assessment'}
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  {readOnly
                    ? `Submitted ${dateLabel(feedback.submittedAt)}. Submitted feedback is read-only.`
                    : 'Only you can access this working scorecard. Save a draft and return later, or submit once complete.'}
                </p>
              </div>
            </div>

            <section>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">Rating criteria</h3>
                  <p className="mt-1 text-xs text-slate-500">Backend-defined maximums and weights are validated again on submission.</p>
                </div>
                {feedback?.overallScore !== null && feedback?.overallScore !== undefined ? (
                  <p className="rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-200">
                    Server-calculated score <span className="font-mono font-semibold">{Number(feedback.overallScore).toFixed(2)} / {feedback.maxOverallScore || 10}</span>
                  </p>
                ) : null}
              </div>
              <div className="mt-3 space-y-3">
                {(template?.criteria || []).map((criterion) => {
                  const value = ratings[criterion.key] || { score: '', comment: '' };
                  const needsComment =
                    criterion.commentRequiredBelowScore !== null &&
                    Number(value.score) > 0 &&
                    Number(value.score) < criterion.commentRequiredBelowScore;
                  return (
                    <fieldset key={criterion.key} className="rounded-xl border border-slate-800 bg-slate-950/35 p-4" disabled={readOnly || busy}>
                      <div className="grid gap-4 md:grid-cols-[1fr_130px]">
                        <div>
                          <legend className="text-sm font-medium text-slate-200">
                            {criterion.label} {criterion.required ? <span className="text-rose-300">*</span> : null}
                          </legend>
                          <p className="mt-1 text-xs leading-5 text-slate-500">{criterion.description}</p>
                        </div>
                        <label className="text-xs text-slate-400">
                          Score, 1–{criterion.maxScore}
                          <input
                            type="number"
                            className="input mt-1 text-center font-mono"
                            min="1"
                            max={criterion.maxScore}
                            step="1"
                            value={value.score}
                            onChange={(event) => updateRating(criterion.key, 'score', event.target.value)}
                            required={criterion.required}
                            aria-label={`${criterion.label} score out of ${criterion.maxScore}`}
                          />
                        </label>
                      </div>
                      <label className="mt-3 block text-xs text-slate-400">
                        Evidence comment {needsComment ? <span className="text-amber-300">(required for this score)</span> : <span className="text-slate-600">(optional)</span>}
                        <textarea
                          className="input mt-1 min-h-20"
                          maxLength={1500}
                          value={value.comment}
                          onChange={(event) => updateRating(criterion.key, 'comment', event.target.value)}
                          required={needsComment}
                          placeholder="Record role-related evidence for this rating."
                        />
                      </label>
                    </fieldset>
                  );
                })}
              </div>
            </section>

            <section className="grid gap-4 md:grid-cols-2">
              <label className="text-sm text-slate-300">
                Strengths
                <textarea className="input mt-1.5 min-h-28" maxLength={4000} disabled={readOnly || busy} value={narrative.strengths} onChange={(event) => setNarrative((current) => ({ ...current, strengths: event.target.value }))} placeholder="Role-related strengths supported by interview evidence." />
              </label>
              <label className="text-sm text-slate-300">
                Concerns
                <textarea className="input mt-1.5 min-h-28" maxLength={4000} disabled={readOnly || busy} value={narrative.concerns} onChange={(event) => setNarrative((current) => ({ ...current, concerns: event.target.value }))} placeholder="Role-related concerns or evidence gaps." />
              </label>
              <label className="text-sm text-slate-300 md:col-span-2">
                Private notes
                <textarea className="input mt-1.5 min-h-24" maxLength={5000} disabled={readOnly || busy} value={narrative.privateNotes} onChange={(event) => setNarrative((current) => ({ ...current, privateNotes: event.target.value }))} placeholder="Internal recruitment notes. Never visible to the candidate or peer interviewers." />
              </label>
              <label className="text-sm text-slate-300 md:col-span-2">
                Recommendation <span className="text-rose-300">*</span>
                <select className="input mt-1.5" disabled={readOnly || busy} value={narrative.recommendation} onChange={(event) => setNarrative((current) => ({ ...current, recommendation: event.target.value }))}>
                  <option value="">Choose a recommendation</option>
                  {RECOMMENDATIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            </section>

            {error ? <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null}

            {!readOnly ? (
              <div className="sticky bottom-0 -mx-5 -mb-5 border-t border-slate-800 bg-slate-900/95 px-5 py-4 backdrop-blur sm:-mx-6 sm:-mb-6 sm:px-6">
                {confirmSubmit ? (
                  <div className="mb-3 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3">
                    <p className="text-sm font-medium text-amber-200">Submit and lock this scorecard?</p>
                    <p className="mt-1 text-xs leading-5 text-amber-100/70">Your ratings and recommendation become visible to authorized HR users. They cannot be edited after submission.</p>
                    <div className="mt-3 flex justify-end gap-2">
                      <button type="button" className="btn-ghost" disabled={busy} onClick={() => setConfirmSubmit(false)}>Back</button>
                      <button type="button" className="btn-primary gap-2" disabled={busy} onClick={() => save('SUBMIT')}><CheckCircle2 className="h-4 w-4" /> {busy ? 'Submitting…' : 'Confirm submission'}</button>
                    </div>
                  </div>
                ) : null}
                <div className="flex flex-wrap justify-end gap-2">
                  <button type="button" className="btn-ghost gap-2" disabled={busy || confirmSubmit} onClick={() => save('SAVE_DRAFT')}><Save className="h-4 w-4" /> {busy ? 'Saving…' : 'Save draft'}</button>
                  <button type="button" className="btn-primary gap-2" disabled={busy || confirmSubmit} onClick={() => setConfirmSubmit(true)}><Send className="h-4 w-4" /> Review and submit</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm text-emerald-200"><CheckCircle2 className="h-4 w-4" /> Your independent feedback is complete.</div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};

export default InterviewFeedbackModal;
