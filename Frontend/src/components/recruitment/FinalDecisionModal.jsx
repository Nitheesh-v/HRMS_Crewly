import { AlertTriangle, CheckCircle2, PauseCircle, UserRoundX, X } from 'lucide-react';
import { useState } from 'react';

const DECISION_CONFIG = {
  SELECTED: {
    title: 'Select candidate',
    description: 'Record an explicit human selection. This does not create an offer.',
    icon: CheckCircle2,
    tone: 'text-emerald-300',
    reasons: [
      ['BEST_FIT', 'Best fit'],
      ['ROLE_ALIGNMENT', 'Role alignment'],
      ['INTERVIEW_EVIDENCE', 'Interview evidence'],
      ['OTHER', 'Other documented reason'],
    ],
  },
  REJECTED: {
    title: 'Reject candidate',
    description: 'Record a role-related rejection using a safe reason category.',
    icon: UserRoundX,
    tone: 'text-rose-300',
    reasons: [
      ['SKILLS_MISMATCH', 'Skills mismatch'],
      ['INTERVIEW_PERFORMANCE', 'Interview performance'],
      ['ROLE_EXPECTATIONS', 'Role expectations'],
      ['POSITION_CLOSED', 'Position closed'],
      ['COMPENSATION_EXPECTATIONS', 'Compensation expectations'],
      ['OTHER', 'Other role-related reason'],
    ],
  },
  HOLD: {
    title: 'Place candidate on hold',
    description: 'Pause the candidate without treating Hold as a rejection.',
    icon: PauseCircle,
    tone: 'text-amber-300',
    reasons: [
      ['POSITION_PAUSED', 'Position paused'],
      ['AWAITING_APPROVAL', 'Awaiting approval'],
      ['CANDIDATE_AVAILABILITY', 'Candidate availability'],
      ['ADDITIONAL_REVIEW', 'Additional review needed'],
      ['OTHER', 'Other documented reason'],
    ],
  },
};

const FinalDecisionModal = ({ decision, candidateName, busy, error, onClose, onSubmit }) => {
  const config = DECISION_CONFIG[decision];
  const [reasonCategory, setReasonCategory] = useState('');
  const [comment, setComment] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const Icon = config.icon;
  const commentRequired = ['REJECTED', 'HOLD'].includes(decision);

  const submit = (event) => {
    event.preventDefault();
    if (!confirmed || !reasonCategory || (commentRequired && comment.trim().length < 5)) return;
    onSubmit({ decision, reasonCategory, comment: comment.trim() });
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-sm" onMouseDown={() => !busy && onClose()}>
      <section className="w-full max-w-xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex items-start justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <p className={`flex items-center gap-2 text-sm font-semibold ${config.tone}`}><Icon className="h-4 w-4" /> {config.title}</p>
            <h2 className="mt-1 text-lg font-semibold text-slate-100">{candidateName}</h2>
          </div>
          <button type="button" className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Close" disabled={busy} onClick={onClose}><X className="h-4 w-4" /></button>
        </header>
        <form className="space-y-4 p-5" onSubmit={submit}>
          <div className="flex gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5 text-amber-100/80">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <p>{config.description} Scores and recommendations remain evidence only; you are making this decision as the authenticated actor.</p>
          </div>
          <label className="block text-sm text-slate-300">
            Reason category <span className="text-rose-300">*</span>
            <select className="input mt-1.5" value={reasonCategory} onChange={(event) => setReasonCategory(event.target.value)} required>
              <option value="">Choose a safe, role-related category</option>
              {config.reasons.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="block text-sm text-slate-300">
            Decision comment {commentRequired ? <span className="text-rose-300">*</span> : <span className="text-slate-600">(optional)</span>}
            <textarea
              className="input mt-1.5 min-h-28"
              maxLength={2000}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              required={commentRequired}
              placeholder="Document role-related evidence and decision context. Do not include protected-class information."
            />
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-xs leading-5 text-slate-300">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-indigo-500" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            I confirm this is a human decision based on the complete recruitment evidence, not an automatic outcome from ATS or interview scores.
          </label>
          {error ? <p role="alert" className="rounded-lg border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy || !confirmed || !reasonCategory || (commentRequired && comment.trim().length < 5)}>
              {busy ? 'Recording…' : `Confirm ${config.title.toLowerCase()}`}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
};

export default FinalDecisionModal;
