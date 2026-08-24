/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  Clock3,
  ExternalLink,
  History,
  MapPin,
  Play,
  RotateCw,
  UserRoundX,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import interviewService from '../../services/interviewService.js';
import InterviewScheduleModal from './InterviewScheduleModal.jsx';

const enumLabel = (value = '') =>
  String(value)
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const statusTone = {
  SCHEDULED: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
  RESCHEDULED: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-200',
  IN_PROGRESS: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  COMPLETED: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  CANCELLED: 'border-slate-600 bg-slate-800 text-slate-300',
  NO_SHOW: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
};

const scheduleLabel = (value, timezone) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        timeZone: timezone || undefined,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(value))
    : 'Not scheduled';

const Value = ({ label, children }) => (
  <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
    <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
    <div className="mt-1.5 break-words text-sm text-slate-200">{children || 'Not set'}</div>
  </div>
);

const InterviewDetailModal = ({ interviewId, onClose, onChanged }) => {
  const [interview, setInterview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [action, setAction] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await interviewService.detail(interviewId);
      setInterview(result);
    } catch (requestError) {
      setError(requestError?.message || 'Interview detail could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [interviewId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const runAction = async (event) => {
    event.preventDefault();
    if (busy || !action) return;
    setBusy(true);
    setError('');
    try {
      const updated = action === 'CANCELLED'
        ? await interviewService.cancel(interview.id, reason.trim())
        : await interviewService.updateStatus(interview.id, action, reason.trim());
      setInterview(updated);
      setAction('');
      setReason('');
      await onChanged?.(updated);
    } catch (requestError) {
      setError(requestError?.message || 'Interview action could not be completed');
    } finally {
      setBusy(false);
    }
  };

  const chooseAction = (nextAction) => {
    setAction(nextAction);
    setReason('');
    setError('');
  };

  const statusActions = interview?.status === 'IN_PROGRESS'
    ? ['COMPLETED', 'NO_SHOW']
    : ['SCHEDULED', 'RESCHEDULED'].includes(interview?.status)
      ? ['IN_PROGRESS', 'COMPLETED', 'NO_SHOW']
      : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm"
      onMouseDown={() => !busy && onClose()}
    >
      <section
        className="max-h-[94vh] w-full max-w-5xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-800 bg-slate-900/95 px-6 py-4 backdrop-blur">
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-indigo-300">
              <CalendarClock className="h-4 w-4" /> Interview detail
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-100">
                {interview?.interviewCode || 'Loading interview'}
              </h2>
              {interview?.status ? (
                <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusTone[interview.status]}`}>
                  {enumLabel(interview.status)}
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"
            onClick={onClose}
            disabled={busy}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {loading ? (
          <div className="m-6 h-72 animate-pulse rounded-2xl bg-slate-950/50" />
        ) : error && !interview ? (
          <div className="p-8">
            <p className="text-sm text-rose-200">{error}</p>
            <button type="button" className="btn-ghost mt-4" onClick={loadDetail}>Try again</button>
          </div>
        ) : interview ? (
          <div className="space-y-6 p-6">
            <div className="grid gap-4 lg:grid-cols-3">
              <Value label="Candidate">
                <p className="font-medium">{interview.candidate?.name}</p>
                <p className="mt-1 font-mono text-xs text-indigo-300">{interview.candidate?.candidateCode}</p>
                <p className="mt-1 text-xs text-slate-400">{interview.candidate?.email}</p>
              </Value>
              <Value label="Position">
                <p className="font-medium">{interview.job?.title}</p>
                <p className="mt-1 font-mono text-xs text-slate-400">{interview.job?.jobCode}</p>
              </Value>
              <Value label="Round">
                <p className="font-medium">{interview.round?.name}</p>
                <p className="mt-1 text-xs text-slate-400">
                  Round {interview.round?.sequence} · {enumLabel(interview.round?.category)}
                </p>
              </Value>
            </div>

            <section className="rounded-2xl border border-slate-800 bg-slate-950/30 p-5">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <Clock3 className="h-4 w-4 text-indigo-300" /> Schedule and channel
              </h3>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Value label="Starts">{scheduleLabel(interview.scheduledStartAt, interview.timezone)}</Value>
                <Value label="Ends">{scheduleLabel(interview.scheduledEndAt, interview.timezone)}</Value>
                <Value label="Duration">{interview.durationMinutes} minutes</Value>
                <Value label="Type">{enumLabel(interview.interviewType)}</Value>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {interview.meetingLink ? (
                  <Value label="Meeting link">
                    <a
                      className="inline-flex items-center gap-1.5 text-indigo-300 hover:text-indigo-200"
                      href={interview.meetingLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open secure meeting <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Value>
                ) : null}
                {interview.location ? (
                  <Value label="Location">
                    <span className="inline-flex items-center gap-1.5">
                      <MapPin className="h-3.5 w-3.5 text-slate-500" /> {interview.location}
                    </span>
                  </Value>
                ) : null}
              </div>
            </section>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-2xl border border-slate-800 bg-slate-950/30 p-5">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <Users className="h-4 w-4 text-indigo-300" /> Interviewers
                </h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  {interview.interviewers?.map((person) => (
                    <span key={person.id} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200">
                      {person.name} · {enumLabel(person.role)}
                    </span>
                  ))}
                </div>
              </section>
              <section className="rounded-2xl border border-slate-800 bg-slate-950/30 p-5">
                <h3 className="text-sm font-semibold text-slate-100">Instructions</h3>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-300">
                  {interview.candidateInstructions || 'No candidate instructions.'}
                </p>
                {'internalNotes' in interview ? (
                  <div className="mt-4 border-t border-slate-800 pt-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-300">Internal only</p>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-300">
                      {interview.internalNotes || 'No internal instructions.'}
                    </p>
                  </div>
                ) : null}
              </section>
            </div>

            {interview.status === 'COMPLETED' ? (
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-4">
                <p className="text-sm font-semibold text-amber-200">Feedback pending</p>
                <p className="mt-1 text-xs leading-5 text-amber-100/70">
                  Feedback, scorecards, ratings, and recommendations are not implemented in Phase 27.9. Completion is operational only and does not advance or decide the candidate.
                </p>
              </div>
            ) : null}

            {(interview.capabilities?.canReschedule || interview.capabilities?.canCancel ||
              (interview.capabilities?.canSetStatus && statusActions.length)) ? (
              <section className="rounded-2xl border border-slate-800 bg-slate-950/30 p-5">
                <h3 className="text-sm font-semibold text-slate-100">Operational actions</h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  {interview.capabilities?.canReschedule ? (
                    <button type="button" className="btn-ghost inline-flex items-center gap-2" onClick={() => setRescheduleOpen(true)}>
                      <RotateCw className="h-4 w-4" /> Reschedule
                    </button>
                  ) : null}
                  {interview.capabilities?.canSetStatus && statusActions.includes('IN_PROGRESS') ? (
                    <button type="button" className="btn-ghost inline-flex items-center gap-2" onClick={() => chooseAction('IN_PROGRESS')}>
                      <Play className="h-4 w-4" /> Start interview
                    </button>
                  ) : null}
                  {interview.capabilities?.canSetStatus && statusActions.includes('COMPLETED') ? (
                    <button type="button" className="btn-ghost inline-flex items-center gap-2" onClick={() => chooseAction('COMPLETED')}>
                      <CheckCircle2 className="h-4 w-4" /> Mark complete
                    </button>
                  ) : null}
                  {interview.capabilities?.canSetStatus && statusActions.includes('NO_SHOW') ? (
                    <button type="button" className="btn-ghost inline-flex items-center gap-2" onClick={() => chooseAction('NO_SHOW')}>
                      <UserRoundX className="h-4 w-4" /> Mark no-show
                    </button>
                  ) : null}
                  {interview.capabilities?.canCancel ? (
                    <button type="button" className="btn-ghost inline-flex items-center gap-2 text-rose-300" onClick={() => chooseAction('CANCELLED')}>
                      <XCircle className="h-4 w-4" /> Cancel interview
                    </button>
                  ) : null}
                </div>

                {action ? (
                  <form className="mt-4 rounded-xl border border-slate-700 bg-slate-900 p-4" onSubmit={runAction}>
                    <p className="text-sm font-medium text-slate-200">Confirm: {enumLabel(action)}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      {action === 'COMPLETED'
                        ? 'This records operational completion only. It will not change the candidate pipeline or hiring outcome.'
                        : action === 'CANCELLED'
                          ? 'The interview remains in history and is never physically deleted.'
                          : 'This status change is recorded in the candidate timeline and recruitment audit.'}
                    </p>
                    <textarea
                      className="input mt-3 min-h-20"
                      maxLength={1000}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder={action === 'CANCELLED' || action === 'NO_SHOW' ? 'Reason (required)' : 'Operational note (optional)'}
                      required={action === 'CANCELLED' || action === 'NO_SHOW'}
                    />
                    <div className="mt-3 flex justify-end gap-2">
                      <button type="button" className="btn-ghost" disabled={busy} onClick={() => setAction('')}>Back</button>
                      <button
                        type="submit"
                        className="btn-primary"
                        disabled={busy || ((action === 'CANCELLED' || action === 'NO_SHOW') && !reason.trim())}
                      >
                        {busy ? 'Saving…' : 'Confirm action'}
                      </button>
                    </div>
                  </form>
                ) : null}
              </section>
            ) : null}

            <section className="rounded-2xl border border-slate-800 bg-slate-950/30 p-5">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <History className="h-4 w-4 text-indigo-300" /> Interview history
              </h3>
              <ol className="mt-4 space-y-3">
                {[...(interview.statusHistory || [])].reverse().map((entry) => (
                  <li key={entry.id} className="rounded-xl border border-slate-800 bg-slate-900 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm text-slate-200">
                        {entry.fromStatus ? `${enumLabel(entry.fromStatus)} → ` : ''}{enumLabel(entry.toStatus)}
                      </p>
                      <p className="text-[11px] text-slate-500">{scheduleLabel(entry.changedAt, interview.timezone)}</p>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">{entry.changedBy?.name || 'Tenant user'}</p>
                    {entry.reason ? <p className="mt-2 whitespace-pre-wrap text-xs text-slate-300">{entry.reason}</p> : null}
                  </li>
                ))}
              </ol>
              {interview.rescheduleHistory?.length ? (
                <div className="mt-5 border-t border-slate-800 pt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Immutable reschedule log</p>
                  <div className="mt-3 space-y-2">
                    {[...interview.rescheduleHistory].reverse().map((entry) => (
                      <div key={entry.id} className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-xs text-slate-300">
                        <p>{scheduleLabel(entry.previousStartAt, entry.previousTimezone)} → {scheduleLabel(entry.newStartAt, entry.newTimezone)}</p>
                        <p className="mt-1 text-slate-500">{entry.reason} · {entry.changedBy?.name || 'Tenant user'}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>

            {error ? (
              <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {rescheduleOpen && interview ? (
        <InterviewScheduleModal
          interview={interview}
          onClose={() => setRescheduleOpen(false)}
          onSaved={async (updated) => {
            setInterview(updated);
            setRescheduleOpen(false);
            await onChanged?.(updated);
          }}
        />
      ) : null}
    </div>
  );
};

export default InterviewDetailModal;
