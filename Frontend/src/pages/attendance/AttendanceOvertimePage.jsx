import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CalendarDays,
  CheckCircle2,
  History,
  Inbox,
  Plus,
  Timer,
  XCircle,
} from 'lucide-react';
import usePermission from '../../hooks/usePermission.js';
import attendanceOvertimeService from '../../services/attendanceOvertimeService.js';

// Phase 31.8 — Overtime / Comp-Off (one surface, two
// permission-gated tabs). Recorded extra time becomes eligible
// through the attendance policy gate, then needs a human approval
// before it is payable time (OT) or leave credit (comp-off).
// TIME ONLY — this page never shows a salary amount.

const STATUS_STYLE = {
  PENDING: 'bg-crewly-orange/15 text-crewly-orange',
  APPROVED: 'bg-crewly-green/15 text-crewly-green',
  REJECTED: 'bg-crewly-red/15 text-crewly-red',
  CANCELLED: 'bg-crewly-dim/15 text-crewly-dim',
};

const CALENDAR_STYLE = {
  WORK_DAY: 'bg-crewly-dim/15 text-crewly-dim',
  WEEKLY_OFF: 'bg-crewly-orange/15 text-crewly-orange',
  HOLIDAY: 'bg-crewly-orange/15 text-crewly-orange',
};

const CALENDAR_LABEL = {
  WORK_DAY: 'Work day',
  WEEKLY_OFF: 'Weekly off',
  HOLIDAY: 'Holiday',
};

const currentMonth = () => new Date().toISOString().slice(0, 7);

const monthBounds = (month) => {
  const [year, mon] = String(month || '').split('-').map(Number);
  if (!year || !mon) return null;
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return {
    from: `${month}-01`,
    to: `${month}-${String(last).padStart(2, '0')}`,
  };
};

const fmtDate = (value) =>
  new Date(`${value}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', weekday: 'short' });

const fmtClock = (value) => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const AttendanceOvertimePage = () => {
  const { hasPermission, loading: permissionsLoading } = usePermission();
  const canRequest = hasPermission('ATTENDANCE_OVERTIME_REQUEST');
  const canReview = hasPermission('ATTENDANCE_OVERTIME_REVIEW');
  const [searchParams] = useSearchParams();
  const deepDate = searchParams.get('date');

  const [tab, setTab] = useState('mine');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [month, setMonth] = useState(currentMonth());
  const [days, setDays] = useState([]);
  const [requests, setRequests] = useState([]);
  const [pending, setPending] = useState([]);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ attendanceDate: '', requestedMinutes: '', reason: '' });
  const [decideFor, setDecideFor] = useState(null);
  const [decideMinutes, setDecideMinutes] = useState('');
  const [decideReason, setDecideReason] = useState('');
  const [rejectFor, setRejectFor] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  const candidateOf = (date) => days.find((day) => day.attendanceDate === date) || null;

  const loadEligibility = useCallback(async () => {
    if (!canRequest) {
      setDays([]);
      return;
    }
    const bounds = monthBounds(month);
    if (!bounds) return;
    const result = await attendanceOvertimeService.eligibility(bounds.from, bounds.to);
    const rows = result?.data?.days;
    setDays(Array.isArray(rows) ? rows : []);
  }, [canRequest, month]);

  const loadMine = useCallback(async () => {
    if (!canRequest) return;
    const result = await attendanceOvertimeService.mine();
    const rows = result?.data;
    setRequests(Array.isArray(rows) ? rows : []);
  }, [canRequest]);

  const loadPending = useCallback(async () => {
    if (!canReview) return;
    const result = await attendanceOvertimeService.pending();
    const rows = result?.data;
    setPending(Array.isArray(rows) ? rows : []);
  }, [canReview]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await Promise.all([loadEligibility(), loadMine(), loadPending()]);
    } catch (loadError) {
      setError(loadError?.message || 'Could not load overtime requests');
    } finally {
      setLoading(false);
    }
  }, [loadEligibility, loadMine, loadPending]);

  useEffect(() => {
    if (!permissionsLoading) {
      if (!canRequest && canReview) setTab('pending');
      load();
    }
  }, [permissionsLoading, canRequest, canReview, load]);

  // Deep link (?date=): preset the day and open the form when the
  // day is currently requestable.
  useEffect(() => {
    if (!deepDate || !/^\d{4}-\d{2}-\d{2}$/.test(deepDate)) return;
    const candidate = candidateOf(deepDate);
    if (candidate?.requestable) {
      setForm({ attendanceDate: deepDate, requestedMinutes: String(candidate.eligibleMinutes), reason: '' });
      setFormOpen(true);
      setTab('mine');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepDate, days]);

  const openForm = (day) => {
    setForm({ attendanceDate: day.attendanceDate, requestedMinutes: String(day.eligibleMinutes), reason: '' });
    setFormOpen(true);
    setError('');
    setMessage('');
  };

  const submit = async () => {
    const candidate = candidateOf(form.attendanceDate);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await attendanceOvertimeService.submit({
        type: candidate?.type || 'OVERTIME',
        attendanceDate: form.attendanceDate,
        requestedMinutes: Number(form.requestedMinutes),
        reason: form.reason.trim(),
      });
      setMessage('Request submitted for review');
      setForm({ attendanceDate: '', requestedMinutes: '', reason: '' });
      setFormOpen(false);
      await load();
    } catch (submitError) {
      setError(submitError?.message || 'Could not submit the request');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (requestId) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await attendanceOvertimeService.cancel(requestId);
      setMessage('Request cancelled');
      await load();
    } catch (cancelError) {
      setError(cancelError?.message || 'Could not cancel the request');
    } finally {
      setBusy(false);
    }
  };

  const approve = async (row) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await attendanceOvertimeService.approve(row.id, {
        approvedMinutes: Number(decideMinutes),
        reviewReason: decideReason.trim() || null,
      });
      setMessage(row.type === 'COMP_OFF' ? `Comp-off approved — leave credit updated` : 'Overtime approved');
      setDecideFor(null);
      setDecideMinutes('');
      setDecideReason('');
      await load();
    } catch (approveError) {
      setError(approveError?.message || 'Could not approve the request');
    } finally {
      setBusy(false);
    }
  };

  const reject = async (row) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await attendanceOvertimeService.reject(row.id, rejectReason.trim() || null);
      setMessage('Request rejected');
      setRejectFor(null);
      setRejectReason('');
      await load();
    } catch (rejectError) {
      setError(rejectError?.message || 'Could not reject the request');
    } finally {
      setBusy(false);
    }
  };

  const openDecide = (row) => {
    setDecideFor(row.id);
    setDecideMinutes(String(row.requestedMinutes));
    setDecideReason('');
    setRejectFor(null);
  };

  if (permissionsLoading || loading) {
    return (
      <div className="space-y-5">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Timer className="h-6 w-6 text-crewly-green" /> Overtime &amp; Comp-Off
        </h1>
        <p className="text-sm text-crewly-dim">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h1 className="flex items-center gap-2 text-2xl font-bold">
        <Timer className="h-6 w-6 text-crewly-green" /> Overtime &amp; Comp-Off
      </h1>
      <p className="text-sm text-crewly-dim">
        Extra work becomes eligible through your attendance policy, then needs a human approval.
        Approvals grant time — payable minutes or leave credit — never a salary figure here.
      </p>

      {error && (
        <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
          {error}
        </div>
      )}
      {message && !error && (
        <div className="rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-4 py-3 text-sm text-crewly-green">
          {message}
        </div>
      )}

      <div className="flex gap-2">
        {canRequest && (
          <button
            className={tab === 'mine' ? 'btn-primary px-4 py-2' : 'btn-ghost px-4 py-2'}
            onClick={() => setTab('mine')}
          >
            <History className="mr-1 inline h-4 w-4" /> My overtime
          </button>
        )}
        {canReview && (
          <button
            className={tab === 'pending' ? 'btn-primary px-4 py-2' : 'btn-ghost px-4 py-2'}
            onClick={() => setTab('pending')}
          >
            <Inbox className="mr-1 inline h-4 w-4" /> Review queue
            {pending.length > 0 && <span className="badge ml-2 bg-crewly-orange/20 text-crewly-orange">{pending.length}</span>}
          </button>
        )}
      </div>

      {tab === 'mine' && canRequest && (
        <>
          {/* Eligibility calendar */}
          <div className="card p-0">
            <div className="flex items-center justify-between border-b border-crewly-border px-5 py-3">
              <h2 className="flex items-center gap-2 font-semibold">
                <CalendarDays className="h-4 w-4 text-crewly-dim" /> Eligible days
              </h2>
              <input type="month" className="input w-44" value={month} onChange={(e) => setMonth(e.target.value)} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-crewly-border text-crewly-dim">
                    <th className="px-5 py-3">Date</th>
                    <th className="px-5 py-3">Day</th>
                    <th className="px-5 py-3">Scheduled</th>
                    <th className="px-5 py-3">Worked</th>
                    <th className="px-5 py-3">Extra</th>
                    <th className="px-5 py-3">Eligible</th>
                    <th className="px-5 py-3">Benefit</th>
                    <th className="px-5 py-3"><span className="sr-only">Action</span></th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((day) => (
                    <tr key={day.attendanceDate} className="border-b border-crewly-border/50 last:border-0">
                      <td className="px-5 py-3">{fmtDate(day.attendanceDate)}</td>
                      <td className="px-5 py-3">
                        <span className={`badge ${CALENDAR_STYLE[day.calendarPrimary] || CALENDAR_STYLE.WORK_DAY}`}>
                          {CALENDAR_LABEL[day.calendarPrimary] || day.calendarPrimary || '—'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-crewly-dim">
                        {day.scheduledMinutes != null
                          ? `${fmtClock(day.scheduledStartAt)}–${fmtClock(day.scheduledEndAt)}`
                          : '—'}
                      </td>
                      <td className="px-5 py-3">
                        {day.workedMinutes > 0 ? `${fmtClock(day.effectiveIn)}–${fmtClock(day.effectiveOut)} (${day.workedMinutes}m)` : '—'}
                      </td>
                      <td className="px-5 py-3">{day.recordedMinutes > 0 ? `${day.recordedMinutes}m` : '—'}</td>
                      <td className="px-5 py-3">{day.eligibleMinutes > 0 ? `${day.eligibleMinutes}m` : '—'}</td>
                      <td className="px-5 py-3">
                        {day.type === 'OVERTIME' && <span className="badge bg-crewly-green/15 text-crewly-green">Overtime</span>}
                        {day.type === 'COMP_OFF' && (
                          <span className="badge bg-blue-400/15 text-blue-300" title={`Earns ${day.compOffDaysAtEligible} day(s)`}>
                            Comp-off
                          </span>
                        )}
                        {!day.type && <span className="text-xs text-crewly-dim">—</span>}
                      </td>
                      <td className="px-5 py-3 text-right">
                        {day.existingRequest ? (
                          <span className={`badge ${STATUS_STYLE[day.existingRequest.status]}`}>
                            {day.existingRequest.type === 'COMP_OFF' ? 'Comp-off' : 'OT'} {day.existingRequest.status.toLowerCase()}
                          </span>
                        ) : day.requestable ? (
                          <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => openForm(day)}>
                            <Plus className="mr-1 inline h-3.5 w-3.5" /> Request
                          </button>
                        ) : (
                          <span className="text-xs text-crewly-dim" title={day.blockers?.[0]?.message || ''}>
                            {day.blockers?.[0]?.code === 'NO_CONTROL' || day.blockers?.[0]?.code === 'NO_WORK'
                              ? 'No work'
                              : day.blockers?.[0]?.code === 'BELOW_THRESHOLD'
                                ? 'Below minimum'
                                : day.blockers?.[0]?.code === 'ALREADY_REQUESTED'
                                  ? 'Requested'
                                  : 'Not eligible'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {days.length === 0 && (
                    <tr><td colSpan={8} className="px-5 py-8 text-center text-crewly-dim">No days in this range.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="px-5 py-3 text-xs text-crewly-dim">
              Hover “Not eligible” for the reason. One request per day — an approved request cannot be claimed again.
            </p>
          </div>

          {/* Request form */}
          {formOpen && (
            <div className="card space-y-4">
              <h2 className="font-semibold">
                Request {candidateOf(form.attendanceDate)?.type === 'COMP_OFF' ? 'comp-off' : 'overtime'} —{' '}
                {form.attendanceDate ? fmtDate(form.attendanceDate) : ''}
              </h2>
              {(() => {
                const candidate = candidateOf(form.attendanceDate);
                return candidate ? (
                  <p className="text-sm text-crewly-dim">
                    {candidate.recordedMinutes}m extra recorded · {candidate.eligibleMinutes}m eligible
                    {candidate.type === 'COMP_OFF' && ` · earns ${candidate.compOffDaysAtEligible} leave day(s)`}
                  </p>
                ) : null;
              })()}
              <div className="max-w-xs">
                <label className="label">Minutes (max {candidateOf(form.attendanceDate)?.eligibleMinutes || 0})</label>
                <input
                  type="number"
                  className="input w-full"
                  min={1}
                  max={candidateOf(form.attendanceDate)?.eligibleMinutes || 1}
                  value={form.requestedMinutes}
                  onChange={(e) => setForm((previous) => ({ ...previous, requestedMinutes: e.target.value }))}
                />
              </div>
              <div>
                <label className="label">Reason</label>
                <textarea
                  className="input w-full"
                  rows={3}
                  maxLength={300}
                  value={form.reason}
                  onChange={(e) => setForm((previous) => ({ ...previous, reason: e.target.value }))}
                  placeholder="What was the extra work?"
                />
              </div>
              <div className="flex gap-2">
                <button className="btn-primary px-4 py-2" disabled={busy} onClick={submit}>Submit request</button>
                <button className="btn-ghost px-4 py-2" disabled={busy} onClick={() => setFormOpen(false)}>Cancel</button>
              </div>
            </div>
          )}

          {/* My requests */}
          <div className="card p-0">
            <div className="border-b border-crewly-border px-5 py-3">
              <h2 className="font-semibold">My requests</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-crewly-border text-crewly-dim">
                    <th className="px-5 py-3">Date</th>
                    <th className="px-5 py-3">Type</th>
                    <th className="px-5 py-3">Minutes</th>
                    <th className="px-5 py-3">Reason</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3"><span className="sr-only">Action</span></th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((row) => (
                    <tr key={row.id} className="border-b border-crewly-border/50 last:border-0">
                      <td className="px-5 py-3">{fmtDate(row.attendanceDate)}</td>
                      <td className="px-5 py-3">
                        <span className={`badge ${row.type === 'COMP_OFF' ? 'bg-blue-400/15 text-blue-300' : 'bg-crewly-green/15 text-crewly-green'}`}>
                          {row.typeLabel}
                        </span>
                        {row.calendar?.primary && row.calendar.primary !== 'WORK_DAY' && (
                          <span className={`badge ml-1 ${CALENDAR_STYLE[row.calendar.primary]}`}>
                            {CALENDAR_LABEL[row.calendar.primary]}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        asked {row.requestedMinutes}m
                        {row.approvedMinutes != null && ` · approved ${row.approvedMinutes}m`}
                        {row.compOffDays != null && ` · ${row.compOffDays} day(s)`}
                      </td>
                      <td className="max-w-xs truncate px-5 py-3 text-crewly-dim" title={row.reason}>{row.reason}</td>
                      <td className="px-5 py-3">
                        <span className={`badge ${STATUS_STYLE[row.status]}`}>{row.status}</span>
                        {row.reviewReason && (
                          <span className="ml-1 block text-xs text-crewly-dim" title={row.reviewReason}>
                            “{row.reviewReason.slice(0, 60)}{row.reviewReason.length > 60 ? '…' : ''}”
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        {row.canCancel ? (
                          <button className="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={() => cancel(row.id)}>
                            Cancel
                          </button>
                        ) : (
                          <span className="text-xs text-crewly-dim">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {requests.length === 0 && (
                    <tr><td colSpan={6} className="px-5 py-8 text-center text-crewly-dim">No requests yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'pending' && canReview && (
        <div className="card p-0">
          <div className="border-b border-crewly-border px-5 py-3">
            <h2 className="font-semibold">Review queue</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-crewly-border text-crewly-dim">
                  <th className="px-5 py-3">Employee</th>
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3">Worked</th>
                  <th className="px-5 py-3">Eligible / Asked</th>
                  <th className="px-5 py-3">Type</th>
                  <th className="px-5 py-3">Reason</th>
                  <th className="px-5 py-3"><span className="sr-only">Decision</span></th>
                </tr>
              </thead>
              <tbody>
                {pending.map((row) => (
                  <tr key={row.id} className="border-b border-crewly-border/50 align-top last:border-0">
                    <td className="px-5 py-3">
                      <div className="font-medium">{row.employee?.name || '—'}</div>
                      <div className="text-xs text-crewly-dim">{row.employee?.designation || ''}</div>
                    </td>
                    <td className="px-5 py-3">
                      {fmtDate(row.attendanceDate)}
                      {row.calendar?.primary && row.calendar.primary !== 'WORK_DAY' && (
                        <span className={`badge ml-1 ${CALENDAR_STYLE[row.calendar.primary]}`} title={row.calendar.holidayName || ''}>
                          {CALENDAR_LABEL[row.calendar.primary]}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-crewly-dim">
                      {row.schedule?.scheduledMinutes != null && row.calendar?.primary === 'WORK_DAY'
                        ? `sched ${row.schedule.scheduledMinutes}m · `
                        : ''}
                      extra {row.recordedMinutes}m
                    </td>
                    <td className="px-5 py-3">{row.eligibleMinutes}m / {row.requestedMinutes}m</td>
                    <td className="px-5 py-3">
                      <span className={`badge ${row.type === 'COMP_OFF' ? 'bg-blue-400/15 text-blue-300' : 'bg-crewly-green/15 text-crewly-green'}`}>
                        {row.typeLabel}
                      </span>
                    </td>
                    <td className="max-w-xs px-5 py-3 text-crewly-dim" title={row.reason}>{row.reason}</td>
                    <td className="px-5 py-3 text-right">
                      {decideFor === row.id ? (
                        <div className="flex flex-col items-end gap-2">
                          <input
                            type="number"
                            className="input w-28"
                            min={1}
                            max={Math.min(row.requestedMinutes, row.eligibleMinutes)}
                            value={decideMinutes}
                            onChange={(e) => setDecideMinutes(e.target.value)}
                            title="Approved minutes (at most asked and eligible)"
                          />
                          <input
                            className="input w-44"
                            maxLength={300}
                            value={decideReason}
                            onChange={(e) => setDecideReason(e.target.value)}
                            placeholder="Note (optional)"
                          />
                          <div className="flex gap-2">
                            <button className="btn-primary px-3 py-1.5 text-xs" disabled={busy} onClick={() => approve(row)}>
                              <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" /> Approve
                            </button>
                            <button className="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={() => setDecideFor(null)}>
                              Back
                            </button>
                          </div>
                        </div>
                      ) : rejectFor === row.id ? (
                        <div className="flex flex-col items-end gap-2">
                          <input
                            className="input w-44"
                            maxLength={300}
                            value={rejectReason}
                            onChange={(e) => setRejectReason(e.target.value)}
                            placeholder="Rejection reason"
                          />
                          <div className="flex gap-2">
                            <button className="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={() => reject(row)}>
                              <XCircle className="mr-1 inline h-3.5 w-3.5" /> Confirm reject
                            </button>
                            <button className="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={() => setRejectFor(null)}>
                              Back
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex justify-end gap-2">
                          <button className="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={() => openDecide(row)}>
                            <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" /> Approve
                          </button>
                          <button className="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={() => { setRejectFor(row.id); setRejectReason(''); }}>
                            <XCircle className="mr-1 inline h-3.5 w-3.5" /> Reject
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {pending.length === 0 && (
                  <tr><td colSpan={7} className="px-5 py-8 text-center text-crewly-dim">The queue is empty.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="px-5 py-3 text-xs text-crewly-dim">
            Approvals re-check the day against company records — changed attendance refuses stale numbers.
            Comp-off approvals credit leave days, visible under <Link className="text-crewly-green underline" to="/app/leaves">Leaves</Link>.
          </p>
        </div>
      )}

      {!canRequest && !canReview && (
        <p className="text-sm text-crewly-dim">You do not have access to overtime requests.</p>
      )}
    </div>
  );
};

export default AttendanceOvertimePage;
