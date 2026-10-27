import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock,
  FileText,
  Inbox,
  Info,
  Scale,
  ShieldCheck,
  Timer,
  TrendingUp,
  Wallet,
  XCircle,
} from 'lucide-react';
import usePermission from '../../hooks/usePermission.js';
import attendanceOvertimeService from '../../services/attendanceOvertimeService.js';
import leaveService from '../../services/leaveService.js';
import { notify } from '../../utils/notify.js';
import { TableEmpty } from '../../components/common/EmptyState.jsx';

// Phase 31.8 — Overtime / Comp-Off, re-cut to the Operations mock.
//
// The rule that has not moved: recorded extra time becomes *eligible* through
// the attendance policy gate, then needs a human approval before it counts as
// payable minutes or leave credit. This page never shows a salary amount, and
// every figure below is a sum over rows the API returned.

const STATUS_META = {
  PENDING: { label: 'Under review', chip: 'bg-st-primary-fixed text-st-on-primary-fixed-variant' },
  APPROVED: { label: 'Approved & banked', chip: 'bg-st-secondary-container text-st-on-secondary-container' },
  REJECTED: { label: 'Declined', chip: 'bg-st-error-container text-st-on-error-container' },
  CANCELLED: { label: 'Cancelled', chip: 'bg-st-high text-st-on-variant' },
};
const statusOf = (s) => STATUS_META[s] || { label: s, chip: 'bg-st-high text-st-on-variant' };

const CALENDAR_LABEL = { WORK_DAY: 'Work day', WEEKLY_OFF: 'Weekly off', HOLIDAY: 'Holiday' };

const currentMonth = () => new Date().toISOString().slice(0, 7);

const monthBounds = (month) => {
  const [year, mon] = String(month || '').split('-').map(Number);
  if (!year || !mon) return null;
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
};

const fmtDate = (value) =>
  new Date(`${value}T00:00:00`).toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
  });

const fmtLongDate = (value) =>
  new Date(`${value}T00:00:00`).toLocaleDateString([], {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

const fmtClock = (value) => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const fmtMinutes = (value) => {
  const total = Math.max(0, Math.trunc(Number(value) || 0));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (!hours) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
};

const BLOCKER_LABEL = {
  NO_CONTROL: 'No punch on record',
  NO_WORK: 'No work recorded',
  BELOW_THRESHOLD: 'Below the minimum',
  ALREADY_REQUESTED: 'Already claimed',
  PAYROLL_LOCKED: 'Payroll closed',
  NOT_CONFIGURED: 'Overtime is off',
  NOT_ELIGIBLE_DAY: 'Not an eligible day',
};

const quarterOf = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
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
  const [message, setMessage] = useState('');
  const [month, setMonth] = useState(currentMonth());
  const [days, setDays] = useState([]);
  const [requests, setRequests] = useState([]);
  const [pending, setPending] = useState([]);
  const [compOff, setCompOff] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ attendanceDate: '', requestedMinutes: '', reason: '' });
  const [decideFor, setDecideFor] = useState(null);
  const [decideMinutes, setDecideMinutes] = useState('');
  const [decideReason, setDecideReason] = useState('');
  const [rejectFor, setRejectFor] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  const candidateOf = (date) => days.find((day) => day.attendanceDate === date) || null;

  const loadEligibility = useCallback(async () => {
    if (!canRequest) return;
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

  /* The comp-off bank is a leave balance, so it is read from the leave service
     rather than recomputed here — one number, one owner. */
  const loadCompOff = useCallback(async () => {
    const result = await leaveService.my();
    const rows = result?.balance || [];
    setCompOff(rows.find((b) => b.type === 'COMP_OFF') || null);
  }, []);

  const load = useCallback(async () => {
    try {
      await Promise.all([loadEligibility(), loadMine(), loadPending(), loadCompOff().catch(() => {})]);
    } catch (loadError) {
      notify.error(loadError?.message || 'Could not load overtime requests');
    } finally {
      setLoading(false);
    }
  }, [loadEligibility, loadMine, loadPending, loadCompOff]);

  useEffect(() => {
    if (!permissionsLoading) {
      if (!canRequest && canReview) setTab('pending');
      load();
    }
  }, [permissionsLoading, canRequest, canReview, load]);

  // Deep link (?date=): preset the day and open the claim form when that day is
  // currently requestable.
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
    setMessage('');
  };

  const submit = async () => {
    const candidate = candidateOf(form.attendanceDate);
    setBusy(true);
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
      notify.error(submitError?.message || 'Could not submit the request');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (requestId) => {
    setBusy(true);
    setMessage('');
    try {
      await attendanceOvertimeService.cancel(requestId);
      setMessage('Request cancelled');
      await load();
    } catch (cancelError) {
      notify.error(cancelError?.message || 'Could not cancel the request');
    } finally {
      setBusy(false);
    }
  };

  const approve = async (row) => {
    setBusy(true);
    setMessage('');
    try {
      await attendanceOvertimeService.approve(row.id, {
        approvedMinutes: Number(decideMinutes),
        reviewReason: decideReason.trim() || null,
      });
      setMessage(row.type === 'COMP_OFF' ? 'Comp-off approved — leave credit updated' : 'Overtime approved');
      setDecideFor(null);
      setDecideMinutes('');
      setDecideReason('');
      await load();
    } catch (approveError) {
      notify.error(approveError?.message || 'Could not approve the request');
    } finally {
      setBusy(false);
    }
  };

  const reject = async (row) => {
    setBusy(true);
    setMessage('');
    try {
      await attendanceOvertimeService.reject(row.id, rejectReason.trim() || null);
      setMessage('Request rejected');
      setRejectFor(null);
      setRejectReason('');
      await load();
    } catch (rejectError) {
      notify.error(rejectError?.message || 'Could not reject the request');
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

  /* ── arithmetic over what the API returned ─────────────────────────────── */
  const claimable = useMemo(() => days.filter((d) => d.requestable && !d.existingRequest), [days]);
  const pendingMine = useMemo(() => requests.filter((r) => r.status === 'PENDING'), [requests]);
  const myQuarter = useMemo(() => {
    const now = quarterOf(new Date().toISOString().slice(0, 10));
    return requests
      .filter((r) => r.status === 'APPROVED' && quarterOf(r.attendanceDate) === now)
      .reduce((acc, r) => acc + (Number(r.approvedMinutes ?? r.requestedMinutes) || 0), 0);
  }, [requests]);
  const bankedDays = Number(compOff?.available) || 0;
  const monthRows = useMemo(
    () => [...days].sort((a, b) => b.attendanceDate.localeCompare(a.attendanceDate)),
    [days],
  );
  const visibleDays = monthRows.slice(0, 8);
  const belowThreshold = monthRows.filter(
    (d) => !d.requestable && !d.existingRequest && (d.blockers || []).some((b) => b.code === 'BELOW_THRESHOLD'),
  ).length;
  const queue = tab === 'pending' ? pending : requests;
  const cycles = monthBounds(month);

  if (permissionsLoading || loading) {
    return <p className="st-surface p-6 text-sm text-st-on-variant">Reading overtime…</p>;
  }

  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-6">
        {/* ── hero ─────────────────────────────────────────────────────── */}
        <section className="rounded-xl bg-st-lowest p-6 shadow-sm md:p-7">
          <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-start">
            <div className="max-w-2xl space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-st-secondary-container px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-st-on-secondary-container">
                  Work-life ergonomics
                </span>
                <span className="text-[11px] font-medium text-st-on-variant">Policy cycle Q{Math.ceil((new Date().getMonth() + 1) / 3)}</span>
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-st-on lg:text-4xl">
                Overtime, comp-off &amp; attendance exceptions
              </h1>
              <p className="text-sm leading-relaxed text-st-on-variant">
                Surplus hours become eligible time through the attendance policy, then a manager
                decides whether they bank as comp-off or payable minutes. Nothing here is a salary
                figure.
              </p>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Link
                to="/app/attendance/policy"
                className="inline-flex items-center gap-2 rounded-lg bg-st-container px-3.5 py-2.5 text-xs font-semibold text-st-on transition hover:bg-st-high"
              >
                <Scale className="h-4 w-4" aria-hidden="true" />
                View guidelines
              </Link>
              {canRequest && claimable[0] ? (
                <button
                  type="button"
                  onClick={() => openForm(claimable[0])}
                  className="inline-flex items-center gap-2 rounded-lg bg-st-primary-container px-4 py-2.5 text-xs font-bold text-st-on-primary-container shadow-sm transition hover:opacity-95"
                >
                  <Timer className="h-4 w-4" aria-hidden="true" />
                  Claim overtime
                </button>
              ) : (
                <span className="rounded-lg bg-st-container px-3.5 py-2.5 text-xs font-semibold text-st-on-variant">
                  Nothing claimable this month
                </span>
              )}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-st-high pt-4">
            <div className="flex flex-wrap items-center gap-1 rounded-lg bg-st-high p-1">
              {canRequest ? (
                <button
                  type="button"
                  onClick={() => setTab('mine')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] transition ${
                    tab === 'mine' ? 'bg-st-lowest font-bold text-st-on shadow-sm' : 'font-medium text-st-on-variant'
                  }`}
                >
                  <Timer className="h-3.5 w-3.5" aria-hidden="true" /> Overtime &amp; comp-off claims
                </button>
              ) : null}
              {canReview ? (
                <button
                  type="button"
                  onClick={() => setTab('pending')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] transition ${
                    tab === 'pending' ? 'bg-st-lowest font-bold text-st-on shadow-sm' : 'font-medium text-st-on-variant'
                  }`}
                >
                  <Inbox className="h-3.5 w-3.5" aria-hidden="true" /> Review queue
                  {pending.length ? (
                    <span className="rounded-full bg-st-primary-container px-1.5 text-[10px] font-bold text-st-on-primary-container">
                      {pending.length}
                    </span>
                  ) : null}
                </button>
              ) : null}
              <Link
                to="/app/attendance/regularizations"
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-st-on-variant transition hover:text-st-on"
              >
                <Clock className="h-3.5 w-3.5" aria-hidden="true" /> Punch regularizations
                <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </Link>
              <Link
                to="/app/attendance/work-modes"
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-st-on-variant transition hover:text-st-on"
              >
                <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" /> Work mode requests
                <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            </div>
            {cycles ? (
              <span className="text-[11px] text-st-on-variant">
                Billing cycle:{' '}
                <strong className="font-semibold text-st-on">
                  {fmtDate(cycles.from)} – {fmtDate(cycles.to)}
                </strong>
              </span>
            ) : null}
          </div>

          {message ? (
            <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-st-secondary-container/50 px-3 py-2 text-xs font-medium text-st-on-secondary-container">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> {message}
            </p>
          ) : null}
        </section>

        {/* ── three metrics ────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-xl bg-st-lowest p-5 shadow-sm">
            <div className="flex items-start justify-between">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-st-on-variant">
                Available comp-off bank
              </h2>
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-st-secondary-container text-st-secondary">
                <Wallet className="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-3xl font-bold text-st-on">{bankedDays.toFixed(1)}</span>
              <span className="text-xs font-semibold text-st-on-variant">days</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-st-low px-2.5 py-1 text-[10px] font-semibold text-st-on-variant">
                {compOff ? `${Math.round(bankedDays * 480)} mins banked` : 'No comp-off balance yet'}
              </span>
              <Link
                to="/app/leaves"
                className="text-[11px] font-bold text-st-secondary transition hover:underline"
              >
                Apply leave
              </Link>
            </div>
          </div>

          <div className="rounded-xl bg-st-lowest p-5 shadow-sm">
            <div className="flex items-start justify-between">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-st-on-variant">
                Pending manager approval
              </h2>
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-st-primary-fixed text-st-primary">
                <Inbox className="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-3xl font-bold text-st-on">{pendingMine.length}</span>
              <span className="text-xs font-semibold text-st-on-variant">
                {pendingMine.length === 1 ? 'request' : 'requests'}
              </span>
            </div>
            <p className="mt-3 text-[11px] text-st-on-variant">
              {pendingMine.length
                ? `${fmtMinutes(
                    pendingMine.reduce((a, r) => a + (Number(r.requestedMinutes) || 0), 0),
                  )} of surplus waiting on a decision.`
                : 'Nothing of yours is waiting.'}
            </p>
          </div>

          <div className="rounded-xl bg-st-lowest p-5 shadow-sm">
            <div className="flex items-start justify-between">
              <h2 className="text-[11px] font-bold uppercase tracking-wider text-st-on-variant">
                Approved this quarter
              </h2>
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-st-tertiary-fixed text-st-on-tertiary-fixed">
                <TrendingUp className="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-3xl font-bold text-st-on">{fmtMinutes(myQuarter)}</span>
              <span className="text-xs font-semibold text-st-on-variant">banked time</span>
            </div>
            <p className="mt-3 text-[11px] text-st-on-variant">
              Sum of every approved claim in this quarter. There is no quarterly cap on the policy —
              the bar would be empty if there were.
            </p>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-st-high">
              <div
                className="h-full rounded-full bg-st-secondary"
                style={{ width: `${Math.min(100, (myQuarter / (40 * 60)) * 100)}%` }}
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
          <div className="flex flex-col gap-6 xl:col-span-9">
            {tab === 'mine' ? (
              <>
                {/* ── eligible days ─────────────────────────────────────── */}
                <section className="rounded-xl bg-st-lowest p-6 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="flex items-center gap-1.5 text-base font-bold text-st-on">
                        <span className="h-2 w-2 rounded-full bg-st-primary-container" aria-hidden="true" />
                        Eligible overtime &amp; weekend days
                      </h2>
                      <p className="text-xs text-st-on-variant">
                        Recorded punch time against the assigned roster, for the month you select.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-lg bg-st-container px-2.5 py-1.5 text-[11px] font-semibold text-st-on">
                        {claimable.length
                          ? `${claimable.length} claimable`
                          : 'Nothing above the threshold'}
                      </span>
                      <input
                        type="month"
                        value={month}
                        onChange={(e) => setMonth(e.target.value)}
                        className="rounded-lg bg-st-container px-2.5 py-1.5 text-[11px] font-semibold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                        aria-label="Eligibility month"
                      />
                    </div>
                  </div>

                  <div className="mt-4 space-y-2">
                    {visibleDays.map((day) => {
                      const calendar = day.calendarPrimary;
                      const isWeekendOrHoliday = calendar === 'WEEKLY_OFF' || calendar === 'HOLIDAY';
                      const blocker = day.blockers?.[0];
                      return (
                        <div
                          key={day.attendanceDate}
                          className={`flex flex-col gap-3 rounded-xl p-3 sm:flex-row sm:items-center ${
                            isWeekendOrHoliday && day.requestable ? 'bg-st-secondary-container/30' : 'bg-st-low'
                          }`}
                        >
                          <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-lg bg-st-lowest text-center leading-none shadow-sm">
                            <span className="text-[9px] font-bold uppercase text-st-on-variant">
                              {new Date(`${day.attendanceDate}T00:00:00`).toLocaleDateString([], { month: 'short' })}
                            </span>
                            <span className="text-sm font-bold text-st-on">
                              {day.attendanceDate.slice(8, 10)}
                            </span>
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-bold text-st-on">{fmtLongDate(day.attendanceDate)}</span>
                              {isWeekendOrHoliday ? (
                                <span className="rounded-full bg-st-tertiary-fixed px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-st-on-tertiary-fixed">
                                  {CALENDAR_LABEL[calendar]}
                                </span>
                              ) : null}
                              {day.existingRequest ? (
                                <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${statusOf(day.existingRequest.status).chip}`}>
                                  {statusOf(day.existingRequest.status).label}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-st-on-variant">
                              {day.scheduledMinutes != null ? (
                                <span>Sched: {fmtClock(day.scheduledStartAt)} – {fmtClock(day.scheduledEndAt)}</span>
                              ) : (
                                <span>No roster on file</span>
                              )}
                              {day.workedMinutes > 0 ? (
                                <span>
                                  Punch: {fmtClock(day.effectiveIn)} – {fmtClock(day.effectiveOut)}
                                </span>
                              ) : null}
                              {day.recordedMinutes > 0 ? (
                                <span>
                                  Extra: <strong className="font-semibold text-st-on">{fmtMinutes(day.recordedMinutes)}</strong>
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-0.5 text-[11px] text-st-on-variant">
                              {day.requestable ? (
                                <>
                                  Eligible:{' '}
                                  <strong className="font-semibold text-st-primary">
                                    {fmtMinutes(day.eligibleMinutes)}
                                  </strong>
                                  {day.type === 'COMP_OFF'
                                    ? ` · earns ${day.compOffDaysAtEligible} comp-off day(s)`
                                    : ' · payable as overtime'}
                                </>
                              ) : (
                                <span title={blocker?.message || ''}>
                                  {blocker ? BLOCKER_LABEL[blocker.code] || blocker.message : 'Not eligible'}
                                </span>
                              )}
                            </p>
                          </div>

                          <div className="shrink-0">
                            {day.existingRequest ? (
                              <span className="text-[11px] font-semibold text-st-on-variant">Already claimed</span>
                            ) : day.requestable ? (
                              <button
                                type="button"
                                onClick={() => openForm(day)}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-st-primary-container px-3 py-1.5 text-[11px] font-bold text-st-on-primary-container shadow-sm transition hover:opacity-95"
                              >
                                <Timer className="h-3.5 w-3.5" aria-hidden="true" /> Claim
                              </button>
                            ) : (
                              <span className="rounded-lg bg-st-container px-2.5 py-1.5 text-[10px] font-semibold text-st-on-variant">
                                Not eligible
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {!visibleDays.length ? (
                      <p className="rounded-xl border border-dashed border-st-high px-3 py-6 text-center text-[11px] text-st-on-variant">
                        No attendance recorded for {month}. Eligibility needs a punch and a roster on
                        the same day.
                      </p>
                    ) : null}
                  </div>

                  {monthRows.length > visibleDays.length ? (
                    <p className="mt-2 text-[11px] text-st-on-variant">
                      Showing the {visibleDays.length} most recent of {monthRows.length} days in this
                      month.
                    </p>
                  ) : null}

                  {belowThreshold ? (
                    <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-st-low px-3 py-2 text-[11px] leading-relaxed text-st-on-variant">
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-st-outline" aria-hidden="true" />
                      {belowThreshold} day{belowThreshold === 1 ? '' : 's'} fell under the minimum
                      excess and are absorbed into the flexible buffer, exactly as the policy states.
                    </p>
                  ) : null}
                </section>

                {/* ── claim form ────────────────────────────────────────── */}
                {formOpen ? (
                  <section className="rounded-xl bg-st-lowest p-6 shadow-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h2 className="text-base font-bold text-st-on">
                          Claim {candidateOf(form.attendanceDate)?.type === 'COMP_OFF' ? 'comp-off' : 'overtime'}
                          {form.attendanceDate ? ` — ${fmtLongDate(form.attendanceDate)}` : ''}
                        </h2>
                        <p className="text-xs text-st-on-variant">
                          {(() => {
                            const c = candidateOf(form.attendanceDate);
                            if (!c) return 'Pick a day from the list above.';
                            return `${fmtMinutes(c.recordedMinutes)} extra recorded · ${fmtMinutes(c.eligibleMinutes)} eligible${
                              c.type === 'COMP_OFF' ? ` · earns ${c.compOffDaysAtEligible} leave day(s)` : ''
                            }`;
                          })()}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setFormOpen(false)}
                        className="rounded-lg bg-st-container px-2.5 py-1.5 text-[11px] font-semibold text-st-on-variant hover:text-st-on"
                      >
                        Close
                      </button>
                    </div>

                    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <label className="block">
                        <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
                          Minutes claimed
                        </span>
                        <input
                          type="number"
                          min={1}
                          max={candidateOf(form.attendanceDate)?.eligibleMinutes || 1}
                          value={form.requestedMinutes}
                          onChange={(e) => setForm((p) => ({ ...p, requestedMinutes: e.target.value }))}
                          className="w-full rounded-lg bg-st-low px-3 py-2 text-sm font-bold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                        />
                        <span className="mt-1 block text-[10px] text-st-on-variant">
                          Max {candidateOf(form.attendanceDate)?.eligibleMinutes || 0} mins
                        </span>
                      </label>
                      <div className="rounded-lg bg-st-low px-3 py-2">
                        <span className="block text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
                          Remuneration
                        </span>
                        <span className="mt-1 block text-sm font-bold text-st-on">
                          {candidateOf(form.attendanceDate)?.type === 'COMP_OFF'
                            ? 'Comp-off credit'
                            : 'Overtime minutes'}
                        </span>
                        <span className="mt-0.5 block text-[10px] text-st-on-variant">
                          Set by the policy's weekend / holiday benefit; not editable per claim.
                        </span>
                      </div>
                      <label className="block sm:col-span-1">
                        <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
                          Reason &amp; project
                        </span>
                        <input
                          maxLength={300}
                          value={form.reason}
                          onChange={(e) => setForm((p) => ({ ...p, reason: e.target.value }))}
                          placeholder="What was the extra work?"
                          className="w-full rounded-lg bg-st-low px-3 py-2 text-xs text-st-on placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                        />
                      </label>
                    </div>

                    <div className="mt-4 flex justify-end gap-2 border-t border-st-high pt-3">
                      <button
                        type="button"
                        onClick={() => setFormOpen(false)}
                        className="rounded-lg bg-st-low px-4 py-2 text-xs font-semibold text-st-on-variant hover:bg-st-container hover:text-st-on"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={busy || !form.requestedMinutes}
                        onClick={submit}
                        className="rounded-lg bg-st-primary-container px-5 py-2 text-xs font-bold text-st-on-primary-container shadow-sm transition hover:opacity-95 disabled:opacity-50"
                      >
                        {busy ? 'Submitting…' : 'Submit for approval'}
                      </button>
                    </div>
                  </section>
                ) : null}
              </>
            ) : null}

            {/* ── request table (mine or the review queue) ─────────────── */}
            <section className="rounded-xl bg-st-lowest p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-bold text-st-on">
                  {tab === 'pending' ? 'Pending decisions' : 'My overtime requests & approval status'}
                </h2>
                <span className="text-[11px] text-st-on-variant">
                  {tab === 'pending' ? `${pending.length} waiting` : `Last ${requests.length} requests`}
                </span>
              </div>

              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse text-left">
                  <thead>
                    <tr className="bg-st-low text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
                      <th className="rounded-l-lg px-3 py-2.5">Ref</th>
                      <th className="px-3 py-2.5">Date worked</th>
                      <th className="px-3 py-2.5">Excess hours</th>
                      <th className="px-3 py-2.5">Compensation</th>
                      <th className="px-3 py-2.5">Approver</th>
                      <th className="px-3 py-2.5">Status</th>
                      <th className="rounded-r-lg px-3 py-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="text-xs">
                    {queue.map((row) => {
                      const st = statusOf(row.status);
                      const who =
                        row.user?.name || row.requester?.name || row.approver?.name || '—';
                      return (
                        <tr key={row.id} className="border-b border-st-high/70 last:border-0 hover:bg-st-low/50">
                          <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[10px] font-semibold text-st-on-variant">
                            OT-{String(row.attendanceDate || '').replace(/-/g, '').slice(2)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-st-on">
                            {fmtDate(row.attendanceDate)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-st-on">
                            {fmtMinutes(row.requestedMinutes)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5">
                            <span className="inline-flex items-center gap-1.5 text-st-on-variant">
                              {row.type === 'COMP_OFF' ? (
                                <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                              ) : (
                                <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
                              )}
                              {row.type === 'COMP_OFF' ? 'Comp-off credit' : 'Overtime minutes'}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-st-on-variant">{who}</td>
                          <td className="whitespace-nowrap px-3 py-2.5">
                            <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${st.chip}`}>
                              {st.label}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right">
                            {tab === 'pending' ? (
                              <div className="inline-flex gap-1">
                                <button
                                  type="button"
                                  onClick={() => openDecide(row)}
                                  className="rounded-lg bg-st-secondary px-2.5 py-1 text-[10px] font-bold text-st-on-secondary"
                                >
                                  Decide
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRejectFor(row.id);
                                    setRejectReason('');
                                  }}
                                  className="rounded-lg bg-st-container px-2.5 py-1 text-[10px] font-semibold text-st-on-variant hover:text-st-error"
                                >
                                  Decline
                                </button>
                              </div>
                            ) : row.status === 'PENDING' ? (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => cancel(row.id)}
                                className="text-[10px] font-semibold text-st-on-variant hover:text-st-error disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            ) : (
                              <span className="text-[10px] text-st-on-variant/50">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {!queue.length ? (
                      <TableEmpty
                        colSpan={7}
                        illustration="wallet"
                        title={tab === 'pending' ? 'No decisions waiting' : 'No requests yet'}
                        description={
                          tab === 'pending'
                            ? 'Every claim in your scope has been decided.'
                            : 'Claim a day above and it appears here with its decision attached.'
                        }
                      />
                    ) : null}
                  </tbody>
                </table>
              </div>

              {/* decide / reject panels */}
              {decideFor ? (
                <div className="mt-4 rounded-xl border border-st-high p-4">
                  <h3 className="text-xs font-bold text-st-on">Approve this claim</h3>
                  <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
                        Approved minutes
                      </span>
                      <input
                        type="number"
                        min={1}
                        value={decideMinutes}
                        onChange={(e) => setDecideMinutes(e.target.value)}
                        className="w-full rounded-lg bg-st-low px-3 py-2 text-sm font-bold text-st-on focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                      />
                    </label>
                    <label className="block sm:col-span-2">
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
                        Review note (optional)
                      </span>
                      <input
                        value={decideReason}
                        onChange={(e) => setDecideReason(e.target.value)}
                        placeholder="Why these minutes?"
                        className="w-full rounded-lg bg-st-low px-3 py-2 text-xs text-st-on placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                      />
                    </label>
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setDecideFor(null)}
                      className="rounded-lg bg-st-low px-3 py-1.5 text-[11px] font-semibold text-st-on-variant"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => approve(pending.find((p) => p.id === decideFor))}
                      className="inline-flex items-center gap-1 rounded-lg bg-st-secondary px-3 py-1.5 text-[11px] font-bold text-st-on-secondary disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Approve
                    </button>
                  </div>
                </div>
              ) : null}

              {rejectFor ? (
                <div className="mt-4 rounded-xl border border-st-high p-4">
                  <h3 className="text-xs font-bold text-st-on">Decline this claim</h3>
                  <input
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Reason (shown to the employee)"
                    className="mt-2 w-full rounded-lg bg-st-low px-3 py-2 text-xs text-st-on placeholder:text-st-on-variant/60 focus:outline-none focus:ring-2 focus:ring-st-primary-container/40"
                  />
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setRejectFor(null)}
                      className="rounded-lg bg-st-low px-3 py-1.5 text-[11px] font-semibold text-st-on-variant"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => reject(pending.find((p) => p.id === rejectFor))}
                      className="inline-flex items-center gap-1 rounded-lg bg-st-error px-3 py-1.5 text-[11px] font-bold text-st-on-error disabled:opacity-50"
                    >
                      <XCircle className="h-3.5 w-3.5" aria-hidden="true" /> Decline
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          </div>

          {/* ── rail ─────────────────────────────────────────────────────── */}
          <aside className="flex flex-col gap-6 xl:col-span-3">
            <div className="rounded-xl bg-st-lowest p-5 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-st-outline">
                    <Scale className="h-3.5 w-3.5" aria-hidden="true" /> How it is decided
                  </h3>
                  <p className="mt-1 text-[11px] text-st-on-variant">From the attendance policy</p>
                </div>
                <Link
                  to="/app/attendance/policy"
                  className="rounded-lg bg-st-container px-2 py-1 text-[10px] font-bold text-st-on"
                >
                  Open
                </Link>
              </div>
              <ul className="mt-3 space-y-2 text-[11px]">
                {[
                  [
                    'Standard weekday surplus',
                    'Above the policy threshold, credited as overtime minutes',
                  ],
                  ['Weekend / holiday work', 'Credited as comp-off days, per the policy benefit'],
                  ['Below the threshold', 'Absorbed as flexible buffer — never claimable'],
                  ['Approval', 'A manager decision is required before the time counts'],
                ].map(([title, note]) => (
                  <li key={title} className="rounded-lg bg-st-low p-2.5">
                    <p className="font-bold text-st-on">{title}</p>
                    <p className="mt-0.5 leading-snug text-st-on-variant">{note}</p>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-xl bg-st-lowest p-5 shadow-sm">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-st-outline">
                <FileText className="h-3.5 w-3.5" aria-hidden="true" /> This month at a glance
              </h3>
              <dl className="mt-3 space-y-2 text-[11px]">
                {[
                  ['Days with a surplus', monthRows.filter((d) => d.recordedMinutes > 0).length],
                  ['Claimable now', claimable.length],
                  ['Below threshold', belowThreshold],
                  ['Eligible minutes', fmtMinutes(monthRows.reduce((a, d) => a + (d.eligibleMinutes || 0), 0))],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <dt className="text-st-on-variant">{label}</dt>
                    <dd className="font-bold text-st-on">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="rounded-xl bg-st-secondary-container/40 p-5">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-st-on-secondary-container">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Time, not money
              </h3>
              <p className="mt-2 text-[11px] leading-relaxed text-st-on-variant">
                This surface tracks eligible minutes and leave credit. Payroll converts an approved
                claim on its own run — the amount never appears here, and nothing on this page can
                change a payslip.
              </p>
            </div>

            <div className="rounded-xl bg-st-low p-5">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-st-outline">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> Not configured
              </h3>
              <ul className="mt-2 space-y-1.5 text-[10px] leading-relaxed text-st-on-variant">
                <li>Quarterly overtime cap — the policy has no cap field.</li>
                <li>Comp-off expiry (60-day rule) — no expiry is enforced.</li>
                <li>Work-mode allowance quotas — set on the work-mode surface.</li>
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
};

export default AttendanceOvertimePage;
