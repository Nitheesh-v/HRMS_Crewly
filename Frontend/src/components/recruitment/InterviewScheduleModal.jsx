/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  Check,
  Search,
  Users,
  X,
} from 'lucide-react';
import interviewService from '../../services/interviewService.js';

const baseForm = {
  roundKey: 'TECHNICAL_1',
  date: '',
  time: '10:00',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
  durationMinutes: 60,
  interviewType: 'ONLINE',
  meetingLink: '',
  location: '',
  candidateInstructions: '',
  internalNotes: '',
  interviewerIds: [],
  updateCandidateStage: true,
  reason: '',
};

const localScheduleParts = (value, timezone) => {
  if (!value) return { date: '', time: '10:00' };
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${byType.year}-${byType.month}-${byType.day}`,
    time: `${byType.hour}:${byType.minute}`,
  };
};

const timezoneOptions = () => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Asia/Kolkata', 'UTC', 'Europe/London', 'America/New_York'];
  }
};

const Field = ({ label, hint = '', children, className = '' }) => (
  <label className={`block ${className}`}>
    <span className="mb-1.5 block text-xs font-medium text-slate-300">{label}</span>
    {children}
    {hint ? <span className="mt-1 block text-[11px] text-slate-500">{hint}</span> : null}
  </label>
);

const InterviewScheduleModal = ({
  candidate = null,
  interview = null,
  initialRoundKey = 'TECHNICAL_1',
  onClose,
  onSaved,
}) => {
  const rescheduling = Boolean(interview?.id);
  const [options, setOptions] = useState({
    companyTimezone: baseForm.timezone,
    rounds: [],
    interviewTypes: ['ONLINE', 'ONSITE', 'PHONE'],
    interviewers: [],
  });
  const [form, setForm] = useState(baseForm);
  const [interviewerSearch, setInterviewerSearch] = useState('');
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoadingOptions(true);
    interviewService
      .options()
      .then((result) => {
        if (!active) return;
        setOptions({
          companyTimezone: result.companyTimezone || baseForm.timezone,
          rounds: Array.isArray(result.rounds) ? result.rounds : [],
          interviewTypes: Array.isArray(result.interviewTypes)
            ? result.interviewTypes
            : ['ONLINE', 'ONSITE', 'PHONE'],
          interviewers: Array.isArray(result.interviewers)
            ? result.interviewers
            : [],
        });

        if (rescheduling) {
          const timezone = interview.timezone || result.companyTimezone || baseForm.timezone;
          const local = localScheduleParts(interview.scheduledStartAt, timezone);
          setForm({
            ...baseForm,
            roundKey: interview.round?.key || initialRoundKey,
            date: local.date,
            time: local.time,
            timezone,
            durationMinutes: interview.durationMinutes || 60,
            interviewType: interview.interviewType || 'ONLINE',
            meetingLink: interview.meetingLink || '',
            location: interview.location || '',
            candidateInstructions: interview.candidateInstructions || '',
            internalNotes: interview.internalNotes || '',
            interviewerIds: (interview.interviewers || []).map((person) => String(person.id)),
            updateCandidateStage: false,
            reason: '',
          });
        } else {
          const hiringManagerId = candidate?.assignments?.hiringManager?.id;
          setForm({
            ...baseForm,
            roundKey: initialRoundKey,
            timezone: result.companyTimezone || baseForm.timezone,
            interviewerIds: hiringManagerId ? [String(hiringManagerId)] : [],
          });
        }
      })
      .catch((requestError) => {
        if (active) {
          setError(requestError?.message || 'Interview options could not be loaded');
        }
      })
      .finally(() => {
        if (active) setLoadingOptions(false);
      });

    return () => {
      active = false;
    };
  }, [candidate, initialRoundKey, interview, rescheduling]);

  const filteredInterviewers = useMemo(() => {
    const search = interviewerSearch.trim().toLowerCase();
    if (!search) return options.interviewers;
    return options.interviewers.filter((person) =>
      [person.name, person.email, person.role]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search))
    );
  }, [interviewerSearch, options.interviewers]);

  const update = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
    setError('');
  };

  const toggleInterviewer = (interviewerId) => {
    setForm((current) => ({
      ...current,
      interviewerIds: current.interviewerIds.includes(interviewerId)
        ? current.interviewerIds.filter((id) => id !== interviewerId)
        : [...current.interviewerIds, interviewerId],
    }));
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');

    try {
      const common = {
        date: form.date,
        time: form.time,
        timezone: form.timezone,
        durationMinutes: Number(form.durationMinutes),
        interviewerIds: form.interviewerIds,
        meetingLink: form.meetingLink.trim(),
        location: form.location.trim(),
      };
      const result = rescheduling
        ? await interviewService.reschedule(interview.id, {
            ...common,
            reason: form.reason.trim(),
          })
        : await interviewService.schedule({
            ...common,
            candidateId: candidate.id,
            roundKey: form.roundKey,
            interviewType: form.interviewType,
            candidateInstructions: form.candidateInstructions.trim(),
            internalNotes: form.internalNotes.trim(),
            updateCandidateStage: form.updateCandidateStage,
          });
      await onSaved?.(result, result?.stageTransition?.warning || '');
    } catch (requestError) {
      setError(requestError?.message || 'Interview could not be saved');
    } finally {
      setBusy(false);
    }
  };

  const requiredChannelMissing =
    (form.interviewType === 'ONLINE' && !form.meetingLink.trim()) ||
    (form.interviewType === 'ONSITE' && !form.location.trim());
  const disabled =
    busy ||
    loadingOptions ||
    !form.date ||
    !form.time ||
    !form.timezone ||
    !form.interviewerIds.length ||
    requiredChannelMissing ||
    (rescheduling && !form.reason.trim());

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm"
      onMouseDown={() => !busy && onClose()}
    >
      <section
        className="max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sticky top-0 z-10 flex items-start justify-between border-b border-slate-800 bg-slate-900/95 px-6 py-4 backdrop-blur">
          <div>
            <div className="flex items-center gap-2 text-indigo-300">
              <CalendarClock className="h-4 w-4" />
              <p className="text-xs font-semibold uppercase tracking-wide">
                Interview management
              </p>
            </div>
            <h2 className="mt-1 text-lg font-semibold text-slate-100">
              {rescheduling ? `Reschedule ${interview.interviewCode}` : `Schedule interview · ${candidate?.overview?.name || candidate?.name}`}
            </h2>
            {rescheduling ? (
              <p className="mt-1 text-xs text-slate-400">
                {interview.round?.name} · {interview.candidate?.name}
              </p>
            ) : null}
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

        <form className="space-y-6 p-6" onSubmit={submit}>
          {!rescheduling ? (
            <section>
              <h3 className="text-sm font-semibold text-slate-200">Round</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {options.rounds.map((round) => (
                  <button
                    key={round.key}
                    type="button"
                    onClick={() => update('roundKey', round.key)}
                    className={`rounded-xl border p-3 text-left transition ${
                      form.roundKey === round.key
                        ? 'border-indigo-400 bg-indigo-500/10 text-indigo-200'
                        : 'border-slate-800 bg-slate-950/30 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <span className="block text-[10px] uppercase tracking-wide opacity-70">
                      Round {round.sequence}
                    </span>
                    <span className="mt-1 block text-sm font-medium">{round.name}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <section>
            <h3 className="text-sm font-semibold text-slate-200">Schedule</h3>
            <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Date">
                <input
                  type="date"
                  className="input"
                  min={new Date().toISOString().slice(0, 10)}
                  value={form.date}
                  onChange={(event) => update('date', event.target.value)}
                  required
                />
              </Field>
              <Field label="Start time">
                <input
                  type="time"
                  className="input"
                  value={form.time}
                  onChange={(event) => update('time', event.target.value)}
                  required
                />
              </Field>
              <Field label="Duration">
                <select
                  className="input"
                  value={form.durationMinutes}
                  onChange={(event) => update('durationMinutes', event.target.value)}
                >
                  {[30, 45, 60, 90, 120].map((minutes) => (
                    <option key={minutes} value={minutes}>{minutes} minutes</option>
                  ))}
                </select>
              </Field>
              <Field label="Timezone">
                <select
                  className="input"
                  value={form.timezone}
                  onChange={(event) => update('timezone', event.target.value)}
                  required
                >
                  {timezoneOptions().map((timezone) => (
                    <option key={timezone} value={timezone}>{timezone}</option>
                  ))}
                </select>
              </Field>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-slate-200">Interview channel</h3>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label="Type">
                <select
                  className="input"
                  value={form.interviewType}
                  onChange={(event) => update('interviewType', event.target.value)}
                  disabled={rescheduling}
                >
                  {options.interviewTypes.map((type) => (
                    <option key={type} value={type}>
                      {type.charAt(0) + type.slice(1).toLowerCase()}
                    </option>
                  ))}
                </select>
              </Field>
              {form.interviewType === 'ONLINE' ? (
                <Field label="HTTPS meeting link">
                  <input
                    type="url"
                    className="input"
                    maxLength={1000}
                    value={form.meetingLink}
                    onChange={(event) => update('meetingLink', event.target.value)}
                    placeholder="https://meet.example.com/..."
                    required
                  />
                </Field>
              ) : form.interviewType === 'ONSITE' ? (
                <Field label="Location">
                  <input
                    className="input"
                    maxLength={500}
                    value={form.location}
                    onChange={(event) => update('location', event.target.value)}
                    placeholder="Office and room"
                    required
                  />
                </Field>
              ) : (
                <Field label="Phone interview note" hint="Candidate contact details stay on the secured interview record.">
                  <input className="input" value="Phone call" disabled />
                </Field>
              )}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
                  <Users className="h-4 w-4 text-indigo-300" /> Interviewers
                </h3>
                <p className="mt-1 text-xs text-slate-500">Select 1–10 active company users.</p>
              </div>
              <div className="relative w-56 max-w-full">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
                <input
                  className="input pl-9"
                  value={interviewerSearch}
                  onChange={(event) => setInterviewerSearch(event.target.value)}
                  placeholder="Find interviewer"
                />
              </div>
            </div>
            <div className="mt-3 grid max-h-52 gap-2 overflow-y-auto sm:grid-cols-2">
              {filteredInterviewers.map((person) => {
                const selected = form.interviewerIds.includes(String(person.id));
                return (
                  <button
                    key={person.id}
                    type="button"
                    onClick={() => toggleInterviewer(String(person.id))}
                    className={`flex items-center gap-3 rounded-xl border p-3 text-left ${
                      selected
                        ? 'border-indigo-400/60 bg-indigo-500/10'
                        : 'border-slate-800 bg-slate-950/30 hover:border-slate-700'
                    }`}
                  >
                    <span className={`flex h-5 w-5 items-center justify-center rounded border ${
                      selected ? 'border-indigo-400 bg-indigo-500 text-white' : 'border-slate-600'
                    }`}>
                      {selected ? <Check className="h-3.5 w-3.5" /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-slate-200">{person.name}</span>
                      <span className="block truncate text-[11px] text-slate-500">
                        {person.role?.replaceAll('_', ' ')} · {person.email}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-slate-500">{form.interviewerIds.length} selected</p>
          </section>

          {rescheduling ? (
            <Field label="Reschedule reason">
              <textarea
                className="input min-h-24"
                maxLength={1000}
                value={form.reason}
                onChange={(event) => update('reason', event.target.value)}
                placeholder="Explain the schedule change"
                required
              />
            </Field>
          ) : (
            <section className="grid gap-4 sm:grid-cols-2">
              <Field label="Candidate instructions" hint="Included in the candidate schedule email.">
                <textarea
                  className="input min-h-28"
                  maxLength={3000}
                  value={form.candidateInstructions}
                  onChange={(event) => update('candidateInstructions', event.target.value)}
                  placeholder="Preparation, joining, or arrival instructions"
                />
              </Field>
              <Field label="Internal interviewer instructions" hint="Never included in candidate email or candidate timeline.">
                <textarea
                  className="input min-h-28"
                  maxLength={5000}
                  value={form.internalNotes}
                  onChange={(event) => update('internalNotes', event.target.value)}
                  placeholder="Internal interview context"
                />
              </Field>
              <label className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/30 p-4 sm:col-span-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={form.updateCandidateStage}
                  onChange={(event) => update('updateCandidateStage', event.target.checked)}
                />
                <span>
                  <span className="block text-sm font-medium text-slate-200">Move candidate to this interview stage</span>
                  <span className="mt-1 block text-xs leading-5 text-slate-500">
                    Uses the audited candidate pipeline service. Scheduling never rejects or selects a candidate.
                  </span>
                </span>
              </label>
            </section>
          )}

          {error ? (
            <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">
              {error}
            </p>
          ) : null}

          <footer className="flex justify-end gap-3 border-t border-slate-800 pt-5">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
              {rescheduling ? 'Keep current schedule' : 'Cancel'}
            </button>
            <button type="submit" className="btn-primary" disabled={disabled}>
              {busy ? 'Saving…' : rescheduling ? 'Confirm reschedule' : 'Schedule interview'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
};

export default InterviewScheduleModal;
