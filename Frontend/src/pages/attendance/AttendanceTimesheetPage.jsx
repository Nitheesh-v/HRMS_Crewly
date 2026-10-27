import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Building2,
  CalendarOff,
  CalendarPlus,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Coffee,
  Download,
  FileClock,
  Info,
  LogIn,
  LogOut,
  Moon,
  Plane,
  RefreshCw,
  Sparkles,
  Timer,
  TriangleAlert,
} from 'lucide-react';
import attendanceService from '../../services/attendanceService.js';
import EmptyState from '../../components/common/EmptyState.jsx';

// Phase 31.10 — My Timesheet: the employee's monthly attendance
// ledger. READ-ONLY: every figure comes from punch facts,
// schedules, leave and holidays — no edits, no money, no reasons.
// Corrections happen on the Regularizations page; this view links
// there from any day and from the header.
//
// Redesign (2026-10): the month grid is the page, and the day the
// employee selects opens beside it instead of in a modal, so the
// calendar never disappears behind a dialog. Everything printed is
// either a payload field or arithmetic over payload fields; blocks
// the API cannot back say so in place.

const currentMonth = () => new Date().toISOString().slice(0, 7);
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const shiftMonth = (month, delta) => {
  const [year, mon] = month.split('-').map(Number);
  const next = new Date(Date.UTC(year, mon - 1 + delta, 1));
  return next.toISOString().slice(0, 7);
};

const monthLabel = (month) => {
  const [year, mon] = (month || '').split('-').map(Number);
  if (!year || !mon) return month;
  return `${MONTH_NAMES[mon - 1]} ${year}`;
};

const fmtClock = (value) => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
};

const fmtSpan = (totalMinutes) => {
  const minutes = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) return `${rest}m`;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
};

const fmtDayLong = (date) => {
  if (!date) return '';
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
};

// "09:00" → 540. Shift windows are bare wall-clock strings.
const toMinutes = (value) => {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

const scheduleMinutes = (schedule) => {
  if (!schedule) return null;
  const start = toMinutes(schedule.startTime);
  const end = toMinutes(schedule.endTime);
  if (start === null || end === null) return null;
  const span = end >= start ? end - start : end + 24 * 60 - start;
  return span > 0 ? span : null;
};

const OUTCOME = {
  PRESENT: {
    label: 'Present',
    chip: 'bg-st-secondary-container text-st-on-secondary-container',
    dot: 'bg-st-secondary',
    bar: 'bg-st-secondary/15',
  },
  HALF_DAY: {
    label: 'Half day',
    chip: 'bg-st-primary-fixed text-st-on-primary-fixed',
    dot: 'bg-st-primary-container',
    bar: 'bg-st-primary-fixed/40',
  },
  LEAVE: {
    label: 'Leave',
    chip: 'bg-st-tertiary-fixed text-st-on-tertiary-fixed',
    dot: 'bg-st-tertiary',
    bar: 'bg-st-tertiary-fixed/30',
  },
  ABSENT: {
    label: 'Absent',
    chip: 'bg-st-error-container text-st-on-error-container',
    dot: 'bg-st-error',
    bar: 'bg-st-error-container/50',
  },
  HOLIDAY: {
    label: 'Holiday',
    chip: 'bg-st-primary-fixed-dim/40 text-st-on-primary-fixed-variant',
    dot: 'bg-st-primary-fixed-dim',
    bar: 'bg-st-primary-fixed-dim/20',
  },
  WEEKLY_OFF: {
    label: 'Weekly off',
    chip: 'bg-st-high text-st-on-variant',
    dot: 'bg-st-outline',
    bar: 'bg-st-high/60',
  },
  UNRESOLVED: {
    label: 'Unresolved',
    chip: 'bg-st-error-container text-st-on-error-container',
    dot: 'bg-st-error',
    bar: 'bg-st-error-container/40',
  },
  FUTURE: {
    label: 'Upcoming',
    chip: 'bg-st-low text-st-on-variant/70',
    dot: 'bg-st-outline-variant',
    bar: 'bg-st-low',
  },
};

const outcomeOf = (day) => (day?.weeklyTarget ? { ...OUTCOME.WEEKLY_OFF, label: 'Earned off' } : OUTCOME[day?.bucket] || OUTCOME.UNRESOLVED);

const EXCEPTION_LABEL = {
  LATE_ARRIVAL: 'Late arrival',
  EARLY_EXIT: 'Early exit',
  MISSING_PUNCH: 'Missing punch',
  REGULARIZATION_PENDING: 'Correction pending',
  ATTENDANCE_ON_LEAVE: 'Worked on leave',
  STALE_OPEN_SESSION: 'Session left open',
};

const MODE_LABEL = {
  OFFICE: 'Office',
  WFH: 'WFH',
  FIELD: 'Field',
  CLIENT_SITE: 'Client site',
  BUSINESS_TRAVEL: 'Travel',
};

const EVENT_LABEL = {
  CLOCK_IN: 'Clock in',
  CLOCK_OUT: 'Clock out',
  BREAK_START: 'Break start',
  BREAK_END: 'Break end',
  WORK_MODE_CHANGE: 'Work mode',
  REGULARIZATION_APPLIED: 'Correction applied',
};

const workedOf = (day) => Number(day?.actual?.workedMinutes ?? day?.workedMinutes ?? 0) || 0;
const breakOf = (day) => Number(day?.actual?.breakMinutes ?? day?.breakMinutes ?? 0) || 0;

const KpiTile = ({ label, value, unit, hint, icon: Icon, bar = 'bg-st-secondary', tone = 'text-st-on' }) => (
  <div className="rounded-xl bg-st-lowest p-3.5 shadow-sm">
    <div className="flex items-start justify-between gap-2">
      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-st-on-variant">
        {label}
        {Icon ? <Icon className="h-3 w-3 text-st-outline" aria-hidden="true" /> : null}
      </span>
    </div>
    <div className="mt-1 flex items-baseline gap-1">
      <span className={`text-xl font-bold ${tone}`}>{value}</span>
      {unit ? <span className="text-[10px] font-semibold text-st-on-variant">{unit}</span> : null}
    </div>
    <div className="mt-1 truncate text-[10px] leading-snug text-st-on-variant" title={hint}>
      {hint}
    </div>
    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-st-high">
      <div className={`h-full rounded-full ${bar}`} style={{ width: '100%', opacity: 0.55 }} />
    </div>
  </div>
);

const Rail = ({ title, icon: Icon, action = null, children }) => (
  <section className="rounded-xl bg-st-lowest p-4 shadow-sm">
    <div className="flex items-center gap-1.5">
      <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
        {Icon ? <Icon className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" /> : null}
        {title}
      </h2>
      {action ? <span className="ml-auto text-[10px] font-semibold text-st-on-variant">{action}</span> : null}
    </div>
    <div className="mt-2.5">{children}</div>
  </section>
);

const Row = ({ label, children, tone = '' }) => (
  <div className="flex items-start justify-between gap-3 py-1">
    <span className="text-[11px] text-st-on-variant">{label}</span>
    <span className={`text-right text-[11px] font-semibold ${tone || 'text-st-on'}`}>{children}</span>
  </div>
);

const AttendanceTimesheetPage = () => {
  const [month, setMonth] = useState(currentMonth());
  const [sheet, setSheet] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const [refreshedAt, setRefreshedAt] = useState(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const result = await attendanceService.myTimesheet(month);
      setSheet(result);
      setRefreshedAt(new Date());
    } catch (err) {
      if (!silent) setSheet(null);
      setError(err?.response?.data?.message || err?.message || 'Failed to load timesheet');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [month]);

  useEffect(() => { load(); }, [load]);

  const days = useMemo(() => sheet?.days || [], [sheet]);
  const summary = sheet?.summary;
  const today = sheet?.today || '';

  // The rail defaults to today when it is in view, else the last day
  // that has already happened — never to a future day. Derived, not
  // stored, so switching months cannot leave a stale selection behind.
  const fallbackDate = useMemo(() => {
    if (!days.length) return '';
    if (today && days.some((day) => day.date === today)) return today;
    const past = days.filter((day) => !day.isFuture);
    return (past[past.length - 1] || days[0]).date;
  }, [days, today]);
  const activeDate = selectedDate && days.some((day) => day.date === selectedDate)
    ? selectedDate
    : fallbackDate;

  const cells = useMemo(() => {
    if (!days.length) return [];
    const first = new Date(`${days[0].date}T00:00:00`);
    const lead = (first.getDay() + 6) % 7;
    return [...Array(lead).fill(null), ...days];
  }, [days]);

  const selected = days.find((day) => day.date === activeDate) || null;

  const scheduledMinutes = useMemo(
    () => days.reduce((total, day) => {
      if (day.bucket === 'FUTURE') return total;
      const span = day.scheduledWorkingDay ? scheduleMinutes(day.schedule) : null;
      return total + (span || 0);
    }, 0),
    [days],
  );
  const workedMinutes = summary?.workedMinutes || 0;
  const expectedPct = scheduledMinutes > 0 ? Math.round((workedMinutes / scheduledMinutes) * 100) : null;

  const shiftAnchors = useMemo(() => {
    const counts = new Map();
    days.forEach((day) => {
      if (!day.schedule?.startTime || !day.schedule?.endTime) return;
      const key = `${day.schedule.shiftName || 'Shift'}|${day.schedule.startTime}|${day.schedule.endTime}|${day.schedule.crossesMidnight ? 'x' : ''}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return [...counts.entries()]
      .map(([key, count]) => {
        const [name, startTime, endTime, overnight] = key.split('|');
        return { name, startTime, endTime, overnight: overnight === 'x', count };
      })
      .sort((a, b) => b.count - a.count);
  }, [days]);
  const unresolvedScheduleDays = days.filter((day) => day.scheduleUnresolved).length;
  const daysWithoutRoster = days.filter((day) => !day.schedule && !day.isFuture && day.bucket !== 'WEEKLY_OFF' && day.bucket !== 'HOLIDAY').length;

  if (loading && !sheet) {
    return (
      <div className="st-surface min-h-screen">
        <div className="rounded-xl bg-st-lowest p-6 text-sm text-st-on-variant shadow-sm">Loading your timesheet…</div>
      </div>
    );
  }

  return (
    <div className="st-surface min-h-screen">
      <div className="flex flex-col gap-5">
        {/* ── hero ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-st-on-variant">
                Time &amp; Leave · My Timesheet
              </span>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                refreshedAt ? 'bg-st-secondary-container text-st-on-secondary-container' : 'bg-st-high text-st-on-variant'
              }`}>
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                {refreshedAt ? `Synced ${fmtClock(refreshedAt)}` : 'Sync pending'}
              </span>
            </div>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-st-on lg:text-[2rem]">My Timesheet</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-st-on-variant">
              Your personal monthly attendance ledger — recorded punches, scheduled shifts, leave and
              verified work hours in one place. Read-only: corrections are requested, not edited in.
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-stretch gap-2">
            <div className="flex items-center justify-between gap-1 rounded-lg bg-st-lowest p-1 shadow-sm">
              <button
                type="button"
                onClick={() => setMonth((value) => shiftMonth(value, -1))}
                className="rounded p-1.5 text-st-on-variant transition hover:bg-st-low hover:text-st-on"
                aria-label="Previous month"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-[8.5rem] text-center text-xs font-bold text-st-on">{monthLabel(month)}</span>
              <button
                type="button"
                onClick={() => setMonth((value) => shiftMonth(value, 1))}
                className="rounded p-1.5 text-st-on-variant transition hover:bg-st-low hover:text-st-on"
                aria-label="Next month"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setMonth(currentMonth())}
                disabled={month === currentMonth()}
                className="ml-1 rounded bg-st-high px-2 py-1 text-[10px] font-bold text-st-on transition hover:bg-st-container disabled:opacity-40"
              >
                Today
              </button>
            </div>
            <div className="flex items-center gap-2">
              <Link
                to="/app/attendance/regularizations"
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-st-lowest px-3 py-2 text-[11px] font-bold text-st-on shadow-sm transition hover:bg-st-low"
              >
                <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" /> Request a correction
              </Link>
              <button
                type="button"
                onClick={() => load({ silent: true })}
                disabled={refreshing}
                className="rounded-lg bg-st-lowest p-2 text-st-on-variant shadow-sm transition hover:text-st-on disabled:opacity-50"
                aria-label="Reload this month"
              >
                <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
        </section>

        {error ? (
          <div className="flex items-center gap-3 rounded-lg bg-st-error-container px-4 py-2.5 text-xs font-medium text-st-on-error-container">
            {error}
            <button type="button" onClick={() => load()} className="rounded bg-st-lowest px-2 py-1 text-[11px] font-bold text-st-on">
              Retry
            </button>
          </div>
        ) : null}

        {!sheet ? null : (
          <>
            {/* ── eight counters ───────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
              <KpiTile label="Present" value={summary?.dayCounts?.present ?? 0} unit="days" hint={`${summary?.scheduledWorkingDays ?? 0} scheduled`} bar="bg-st-secondary" />
              <KpiTile label="Half day" value={summary?.dayCounts?.halfDay ?? 0} unit="days" hint="0.5 ratio applied" bar="bg-st-primary-container" />
              <KpiTile label="Absent" value={summary?.dayCounts?.absent ?? 0} unit="days" hint={`${summary?.unresolvedDays ?? 0} unresolved`} bar="bg-st-error" tone={(summary?.dayCounts?.absent || 0) > 0 ? 'text-st-error' : 'text-st-on'} />
              <KpiTile label="Leave" value={summary?.dayCounts?.leave ?? 0} unit="days" hint={`${summary?.dayCounts?.holiday ?? 0} holiday · ${summary?.dayCounts?.weeklyOff ?? 0} off`} bar="bg-st-tertiary" />
              <KpiTile label="Total worked" value={fmtSpan(workedMinutes)} hint={expectedPct === null ? 'no scheduled window' : `${expectedPct}% of scheduled`} bar="bg-st-secondary" />
              <KpiTile label="Late in" value={summary?.lateDays ?? 0} unit="days" hint={`${summary?.earlyExitDays ?? 0} early exits`} bar="bg-st-primary-fixed-dim" />
              <KpiTile label="Approved OT" value={fmtSpan(summary?.approvedOtMinutes ?? 0)} hint={`${summary?.compOffEarnedDays ?? 0} comp-off days`} bar="bg-st-primary" />
              <KpiTile
                label="Exceptions"
                value={summary?.exceptionDays ?? 0}
                unit="days"
                hint={`${summary?.missingPunchDays ?? 0} missing punch`}
                bar="bg-st-error"
                tone={(summary?.exceptionDays || 0) > 0 ? 'text-st-error' : 'text-st-on'}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_22rem]">
              {/* ── calendar column ─────────────────────────────────── */}
              <div className="flex min-w-0 flex-col gap-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-st-lowest px-4 py-2.5 shadow-sm">
                  {[
                    ['Present', 'bg-st-secondary'],
                    ['Half day', 'bg-st-primary-container'],
                    ['Leave', 'bg-st-tertiary'],
                    ['Weekly off', 'bg-st-outline'],
                    ['Holiday', 'bg-st-primary-fixed-dim'],
                    ['Absent / unresolved', 'bg-st-error'],
                  ].map(([label, dot]) => (
                    <span key={label} className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-st-on-variant">
                      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${dot}`} />
                      {label}
                    </span>
                  ))}
                  <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-st-secondary-container px-2.5 py-1 text-[10px] font-bold text-st-on-secondary-container" title="Recorded work minutes ÷ scheduled minutes of the days that have already happened">
                    <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                    {expectedPct === null ? 'No scheduled window to compare' : `${expectedPct}% of scheduled hours met`}
                  </span>
                </div>

                <section className="rounded-xl bg-st-lowest p-4 shadow-sm">
                  <div className="mb-2 grid grid-cols-7 gap-1.5 text-center">
                    {WEEKDAYS.map((name) => (
                      <span key={name} className="text-[10px] font-bold uppercase tracking-wider text-st-on-variant">{name}</span>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-1.5">
                    {cells.map((day, index) => {
                      if (!day) return <span key={`blank-${index}`} aria-hidden="true" />;
                      const outcome = outcomeOf(day);
                      const isSelected = day.date === activeDate;
                      const worked = workedOf(day);
                      const flags = day.exceptions?.length || 0;
                      return (
                        <button
                          key={day.date}
                          type="button"
                          onClick={() => setSelectedDate(day.date)}
                          aria-pressed={isSelected}
                          title={`${fmtDayLong(day.date)} — ${outcome.label}${worked ? ` · ${fmtSpan(worked)} worked` : ''}`}
                          className={`relative flex min-h-[4.75rem] flex-col gap-0.5 rounded-lg border p-1.5 text-left transition ${
                            isSelected
                              ? 'border-st-secondary bg-st-container'
                              : 'border-st-high hover:border-st-secondary/60 hover:bg-st-low'
                          } ${day.isFuture ? 'opacity-60' : ''}`}
                        >
                          <span className="flex w-full items-center justify-between">
                            <span className={`text-xs font-bold ${day.isToday ? 'text-st-primary' : 'text-st-on'}`}>{Number(day.date.slice(8, 10))}</span>
                            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${outcome.dot}`} />
                          </span>
                          {worked > 0 ? (
                            <span className="text-[10px] font-bold text-st-on">{fmtSpan(worked)}</span>
                          ) : (
                            <span className="text-[10px] text-st-on-variant/70">{day.bucket === 'WEEKLY_OFF' ? 'Off' : day.bucket === 'HOLIDAY' ? 'Holiday' : '—'}</span>
                          )}
                          <span className="text-[9px] leading-tight text-st-on-variant">
                            {day.actual?.recordedIn || day.actual?.effectiveIn ? fmtClock(day.actual?.effectiveIn || day.actual?.recordedIn) : outcome.label}
                          </span>
                          <span className="mt-auto flex items-center gap-0.5">
                            {day.bucket === 'LEAVE' ? <Plane className="h-2.5 w-2.5 text-st-tertiary" aria-hidden="true" /> : null}
                            {day.bucket === 'HOLIDAY' ? <CalendarOff className="h-2.5 w-2.5 text-st-primary" aria-hidden="true" /> : null}
                            {day.bucket === 'WEEKLY_OFF' ? <Moon className="h-2.5 w-2.5 text-st-outline" aria-hidden="true" /> : null}
                            {day.workMode === 'OFFICE' && day.bucket === 'PRESENT' ? <Building2 className="h-2.5 w-2.5 text-st-secondary" aria-hidden="true" /> : null}
                            {flags > 0 ? (
                              <span className="ml-auto inline-flex items-center gap-0.5 text-[9px] font-bold text-st-error">
                                <TriangleAlert className="h-2.5 w-2.5" aria-hidden="true" /> {flags}
                              </span>
                            ) : null}
                          </span>
                          {day.isToday ? (
                            <span aria-hidden="true" className="absolute inset-x-1.5 bottom-0.5 h-0.5 rounded-full bg-st-primary" />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-st-on-variant">
                    <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                    Select any day to open its punches, break deductions and shift window on the right.
                    Past months stay readable; corrections apply to the day they belong to.
                  </p>
                </section>

                {/* Where the mock shows a payroll-readiness strip, this month
                    has an honest statement of what the ledger cannot know. */}
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-st-low px-4 py-3 text-[11px] text-st-on-variant">
                  <span className="inline-flex items-center gap-1.5 font-bold text-st-on">
                    <FileClock className="h-3.5 w-3.5" aria-hidden="true" /> Month totals
                  </span>
                  <span><strong className="font-bold text-st-on">{fmtSpan(summary?.workedMinutes)}</strong> worked</span>
                  <span><strong className="font-bold text-st-on">{fmtSpan(summary?.breakMinutes)}</strong> breaks recorded</span>
                  <span><strong className="font-bold text-st-on">{summary?.regularizedDays ?? 0}</strong> corrected days</span>
                  <span><strong className="font-bold text-st-on">{summary?.workedOnHolidayDays ?? 0}</strong> worked holidays</span>
                  <span className="ml-auto text-[10px]">
                    Pay, deductions and money never appear on this page — payroll owns them.
                  </span>
                </div>
              </div>

              {/* ── day rail ────────────────────────────────────────── */}
              <div className="flex flex-col gap-4">
                <Rail title="Day breakdown" icon={Sparkles} action={selected?.isToday ? 'Today' : undefined}>
                  {selected ? (
                    <>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-bold text-st-on">{fmtDayLong(selected.date)}</p>
                          <p className="text-[10px] text-st-on-variant">
                            {selected.schedule
                              ? `${selected.schedule.shiftName || 'Shift'} · ${selected.schedule.startTime}–${selected.schedule.endTime}${selected.schedule.crossesMidnight ? ' (overnight)' : ''}`
                              : selected.scheduleUnresolved
                                ? 'No schedule resolved for this day'
                                : 'No scheduled shift'}
                          </p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${outcomeOf(selected).chip}`}>
                          {outcomeOf(selected).label}
                        </span>
                      </div>

                      <div className="mt-3 flex items-end justify-between gap-2 rounded-lg bg-st-low px-3 py-2">
                        <div>
                          <p className="text-[9px] font-bold uppercase tracking-wider text-st-on-variant">Worked</p>
                          <p className="text-lg font-bold text-st-on">{fmtSpan(workedOf(selected))}</p>
                        </div>
                        <span className={`pb-1 text-[10px] font-bold ${
                          workedOf(selected) - (scheduleMinutes(selected.schedule) || 0) >= 0 ? 'text-st-secondary' : 'text-st-primary'
                        }`}>
                          {scheduleMinutes(selected.schedule)
                            ? `${workedOf(selected) - (scheduleMinutes(selected.schedule) || 0) >= 0 ? '+' : '−'}${fmtSpan(Math.abs(workedOf(selected) - (scheduleMinutes(selected.schedule) || 0)))} vs shift`
                            : 'no shift window'}
                        </span>
                      </div>

                      <div className="mt-2 divide-y divide-st-high/60">
                        <Row label="Recorded in / out">
                          {fmtClock(selected.actual?.recordedIn)} / {fmtClock(selected.actual?.recordedOut)}
                        </Row>
                        <Row label="Break">
                          <span className="inline-flex items-center gap-1"><Coffee className="h-3 w-3 text-st-outline" aria-hidden="true" /> {fmtSpan(breakOf(selected))}</span>
                        </Row>
                        {selected.workMode ? <Row label="Modality">{MODE_LABEL[selected.workMode] || selected.workMode}</Row> : null}
                        {selected.actual?.lateMinutes > 0 ? <Row label="Late" tone="text-st-error">{selected.actual.lateMinutes}m</Row> : null}
                        {selected.actual?.earlyMinutes > 0 ? <Row label="Left early" tone="text-st-error">{selected.actual.earlyMinutes}m</Row> : null}
                        {selected.regularized ? <Row label="Correction" tone="text-st-secondary">Applied</Row> : null}
                        {selected.ot ? (
                          <Row label="Overtime">
                            {selected.ot.type === 'COMP_OFF' ? 'Comp-off' : 'Overtime'} · {String(selected.ot.status || '').toLowerCase()}
                          </Row>
                        ) : null}
                      </div>

                      {selected.exceptions?.length ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {selected.exceptions.map((code) => (
                            <span key={code} className="rounded-full bg-st-error-container px-2 py-0.5 text-[9px] font-bold text-st-on-error-container">
                              {EXCEPTION_LABEL[code] || code}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-[11px] text-st-on-variant">Select a day on the calendar.</p>
                  )}
                </Rail>

                <Rail title="Punch timeline" icon={Clock} action={selected?.timeline?.length ? `${selected.timeline.length} events` : undefined}>
                  {selected?.timeline?.length ? (
                    <ol className="space-y-1.5">
                      {selected.timeline.map((event) => (
                        <li key={`${event.seq}-${event.at}`} className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="inline-flex items-center gap-1 text-st-on">
                            {event.type === 'CLOCK_IN' ? <LogIn className="h-3 w-3 text-st-secondary" aria-hidden="true" /> : null}
                            {event.type === 'CLOCK_OUT' ? <LogOut className="h-3 w-3 text-st-primary" aria-hidden="true" /> : null}
                            {!(event.type === 'CLOCK_IN' || event.type === 'CLOCK_OUT') ? <Timer className="h-3 w-3 text-st-outline" aria-hidden="true" /> : null}
                            {EVENT_LABEL[event.type] || String(event.type || '').replaceAll('_', ' ')}
                          </span>
                          <span className="text-right text-st-on-variant">
                            {fmtClock(event.at)}
                            {event.locationName ? <span className="block text-[9px]">{event.locationName}</span> : null}
                          </span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-[11px] text-st-on-variant">
                      {selected?.isFuture ? 'This day has not happened yet.' : 'No punches recorded for this day.'}
                    </p>
                  )}
                </Rail>

                <div className="flex flex-col gap-2">
                  <Link
                    to="/app/attendance/regularizations"
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-st-primary px-3 py-2 text-[11px] font-bold text-st-on-primary shadow-sm transition hover:opacity-95"
                  >
                    Request regularization / correction
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                  <Link
                    to="/app/attendance/overtime"
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-st-low px-3 py-2 text-[11px] font-bold text-st-on transition hover:bg-st-container"
                  >
                    Comp-off bank &amp; overtime claims
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </div>

                <Rail title="Assigned shift policy" icon={Building2}>
                  {shiftAnchors.length ? (
                    <div className="space-y-2">
                      {shiftAnchors.slice(0, 2).map((shift) => (
                        <div key={`${shift.name}-${shift.startTime}`} className="rounded-lg bg-st-low px-3 py-2">
                          <p className="text-[10px] font-bold uppercase tracking-wider text-st-on-variant">{shift.name}</p>
                          <p className="text-sm font-bold text-st-on">
                            {shift.startTime} – {shift.endTime}
                            {shift.overnight ? <span className="ml-1 text-[10px] font-semibold text-st-on-variant">overnight</span> : null}
                          </p>
                          <p className="text-[10px] text-st-on-variant">{shift.count} day{shift.count === 1 ? '' : 's'} this month</p>
                        </div>
                      ))}
                      {unresolvedScheduleDays > 0 || daysWithoutRoster > 0 ? (
                        <p className="text-[10px] text-st-on-variant">
                          {unresolvedScheduleDays > 0 ? `${unresolvedScheduleDays} day${unresolvedScheduleDays === 1 ? '' : 's'} could not resolve a schedule. ` : ''}
                          {daysWithoutRoster > 0 ? `${daysWithoutRoster} working day${daysWithoutRoster === 1 ? '' : 's'} had no roster at all.` : ''}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-[11px] text-st-on-variant">
                      No shift is attached to any day of this month, so there is no policy card to show.
                      Raise a roster on Work Schedules.
                    </p>
                  )}
                  <Link to="/app/schedules" className="mt-2 inline-flex items-center gap-1 text-[10px] font-bold text-st-primary hover:underline">
                    Open work schedules <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </Rail>

                {/* The mock's "Legacy Punch Audit Log" renders a screenshot of
                    an older screen. There is no such export, so the block says so. */}
                <section className="rounded-xl bg-st-high/40 p-4 shadow-sm">
                  <h2 className="flex items-center gap-1.5 text-sm font-bold text-st-on">
                    <FileClock className="h-3.5 w-3.5 text-st-outline" aria-hidden="true" /> Legacy punch audit log
                    <span className="ml-auto rounded-full bg-st-high px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-st-on-variant">
                      Not configured
                    </span>
                  </h2>
                  <p className="mt-2 text-[10px] leading-relaxed text-st-on-variant">
                    Historical badge-reader archives are held by the audit log, not by this timesheet. No
                    legacy export endpoint is published, so nothing here is reconstructed.
                  </p>
                  {selected ? (
                    <p className="mt-1 text-[10px] text-st-on-variant">
                      This month's evidence is the {days.reduce((total, day) => total + (day.timeline?.length || 0), 0)} recorded events above.
                    </p>
                  ) : null}
                </section>
              </div>
            </div>

            {days.length === 0 ? (
              <EmptyState
                illustration="calendar"
                title="No calendar for this month"
                description="Nothing was resolved for this period — no roster, punches, leave or holidays. Pick another month or ask HR to publish the roster."
              />
            ) : null}

            <p className="flex items-start gap-2 rounded-xl bg-st-low px-4 py-3 text-[11px] leading-relaxed text-st-on-variant">
              <Download className="mt-0.5 h-3.5 w-3.5 shrink-0 text-st-outline" aria-hidden="true" />
              <span>
                <strong className="font-semibold text-st-on">A statement download is not wired yet.</strong>{' '}
                No PDF endpoint is published for a personal month, so the button is absent rather than
                printing a file that does not exist. Export your scope from Attendance Analytics or ask HR
                for the signed copy.
              </span>
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default AttendanceTimesheetPage;
