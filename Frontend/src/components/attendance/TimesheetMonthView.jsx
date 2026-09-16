import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CalendarOff,
  CheckCircle2,
  Clock,
  Coffee,
  Moon,
  Plane,
  Timer,
} from 'lucide-react';
import Modal from '../Modal.jsx';

// Phase 31.10 — shared month view (My Timesheet + team drill-down).
// Calendar grid + month summary + day drawer over one month payload.
// READ-ONLY: no edits, no money, no reasons; workflow links hand off
// to the owning pages (regularizations, work modes, overtime, leaves).

const OUTCOME_LABEL = {
  PRESENT: 'Present',
  HALF_DAY: 'Half day',
  ABSENT: 'Absent',
  LEAVE: 'Leave',
  HOLIDAY: 'Holiday',
  WEEKLY_OFF: 'Weekly off',
  UNRESOLVED: 'Unresolved',
  FUTURE: 'Upcoming',
};

const OUTCOME_STYLE = {
  PRESENT: 'bg-crewly-green/15 text-crewly-green',
  HALF_DAY: 'bg-blue-400/15 text-blue-300',
  ABSENT: 'bg-crewly-red/15 text-crewly-red',
  LEAVE: 'bg-violet-400/15 text-violet-300',
  HOLIDAY: 'bg-crewly-orange/15 text-crewly-orange',
  WEEKLY_OFF: 'bg-white/10 text-crewly-dim',
  UNRESOLVED: 'bg-white/10 text-crewly-dim',
  FUTURE: 'bg-white/5 text-crewly-dim',
};

const OUTCOME_DOT = {
  PRESENT: 'bg-crewly-green',
  HALF_DAY: 'bg-blue-400',
  ABSENT: 'bg-crewly-red',
  LEAVE: 'bg-violet-400',
  HOLIDAY: 'bg-crewly-orange',
  WEEKLY_OFF: 'bg-white/20',
  UNRESOLVED: 'bg-white/20',
  FUTURE: 'bg-white/10',
};

const EXCEPTION_LABEL = {
  LATE_ARRIVAL: 'Late arrival',
  EARLY_EXIT: 'Early exit',
  MISSING_PUNCH: 'Missing punch',
  REGULARIZATION_PENDING: 'Correction pending',
  ATTENDANCE_ON_LEAVE: 'Worked on leave',
};

const MODE_LABEL = {
  OFFICE: 'Office',
  WFH: 'WFH',
  FIELD: 'Field',
  CLIENT_SITE: 'Client site',
  BUSINESS_TRAVEL: 'Travel',
};

const fmtClock = (value) => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const fmtDay = (value) => {
  if (!value) return '';
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
};

const fmtSpan = (totalMinutes) => {
  const minutes = Math.max(0, Math.floor(Number(totalMinutes) || 0));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours <= 0) return `${rest}m`;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const Stat = ({ label, value, tone = '' }) => (
  <div className="rounded-lg bg-white/5 px-3 py-2">
    <div className={`text-lg font-semibold ${tone}`}>{value}</div>
    <div className="text-xs text-crewly-dim">{label}</div>
  </div>
);

const Row = ({ label, children }) => (
  <div className="flex items-start justify-between gap-3 py-1.5">
    <span className="shrink-0 text-sm text-crewly-dim">{label}</span>
    <span className="text-right text-sm">{children}</span>
  </div>
);

const DayDrawer = ({ day, onClose }) => {
  if (!day) return null;
  const ot = day.ot;
  return (
    <Modal title={fmtDay(day.date)} onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${OUTCOME_STYLE[day.bucket] || ''}`}>
          {OUTCOME_LABEL[day.bucket] || day.bucket}
        </span>
        {day.workMode && (
          <span className="rounded-full bg-white/10 px-3 py-1 text-xs">
            {MODE_LABEL[day.workMode] || day.workMode}
          </span>
        )}
        {day.regularized && (
          <span className="rounded-full bg-crewly-green/15 px-3 py-1 text-xs text-crewly-green">
            Corrected
          </span>
        )}
      </div>

      {day.isFuture ? (
        <p className="text-sm text-crewly-dim">
          This day has not happened yet — nothing to show.
          {day.schedule ? (
            <>
              {' '}Scheduled {day.schedule.startTime || '—'}–{day.schedule.endTime || '—'}
              {day.schedule.shiftName ? ` (${day.schedule.shiftName})` : ''}.
            </>
          ) : null}
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg bg-white/5 p-3">
            <h3 className="mb-1 text-sm font-semibold">Schedule</h3>
            {day.schedule ? (
              <>
                <Row label="Shift">
                  {day.schedule.startTime || '—'}–{day.schedule.endTime || '—'}
                  {day.schedule.crossesMidnight ? ' (overnight)' : ''}
                </Row>
                <Row label="Name">{day.schedule.shiftName || day.schedule.scheduleName || '—'}</Row>
              </>
            ) : (
              <p className="text-sm text-crewly-dim">
                {day.scheduleUnresolved ? 'No schedule resolved for this day.' : 'No scheduled shift.'}
              </p>
            )}
            <h3 className="mb-1 mt-3 text-sm font-semibold">Actual</h3>
            <Row label="Recorded in / out">
              {fmtClock(day.actual?.recordedIn)} / {fmtClock(day.actual?.recordedOut)}
            </Row>
            <Row label="Effective in / out">
              {fmtClock(day.actual?.effectiveIn)} / {fmtClock(day.actual?.effectiveOut)}
            </Row>
            <Row label="Worked">
              <span className="inline-flex items-center gap-1">
                <Clock size={13} /> {fmtSpan(day.actual?.workedMinutes)}
              </span>
            </Row>
            <Row label="Break">
              <span className="inline-flex items-center gap-1">
                <Coffee size={13} /> {fmtSpan(day.actual?.breakMinutes)}
              </span>
            </Row>
            {(day.actual?.lateMinutes > 0 || day.actual?.earlyMinutes > 0) && (
              <Row label="Late / early">
                {day.actual.lateMinutes > 0 ? `${day.actual.lateMinutes}m late` : '—'}
                {' / '}
                {day.actual.earlyMinutes > 0 ? `${day.actual.earlyMinutes}m early` : '—'}
              </Row>
            )}
          </div>

          <div className="rounded-lg bg-white/5 p-3">
            <h3 className="mb-1 text-sm font-semibold">Calendar</h3>
            {day.calendar?.leave ? (
              <Row label="Leave">
                {day.calendar.leave.label || day.calendar.leave.type || 'Leave'}
                {' '}(full day)
              </Row>
            ) : null}
            {day.calendar?.holiday ? (
              <Row label="Holiday">{day.calendar.holiday.name || 'Holiday'}</Row>
            ) : null}
            {day.calendar?.primary === 'WEEKLY_OFF' && !day.calendar?.holiday ? (
              <Row label="Day type">Weekly off</Row>
            ) : null}
            {!day.calendar?.leave && !day.calendar?.holiday && day.calendar?.primary === 'WORK_DAY' ? (
              <p className="text-sm text-crewly-dim">Regular working day.</p>
            ) : null}

            <h3 className="mb-1 mt-3 text-sm font-semibold">Timeline</h3>
            {day.timeline?.length ? (
              <ul className="space-y-1">
                {day.timeline.map((event) => (
                  <li key={`${event.seq}-${event.at}`} className="flex items-center justify-between gap-2 text-sm">
                    <span>{event.type?.replaceAll('_', ' ')}</span>
                    <span className="text-crewly-dim">
                      {fmtClock(event.at)}
                      {event.locationName ? ` · ${event.locationName}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-crewly-dim">No recorded events.</p>
            )}

            {(day.regularization?.pending || day.regularization?.applied) && (
              <>
                <h3 className="mb-1 mt-3 text-sm font-semibold">Corrections</h3>
                <p className="text-sm text-crewly-dim">
                  {day.regularization.applied ? 'An approved correction is applied to this day. ' : ''}
                  {day.regularization.pending ? 'A correction request is still pending review.' : ''}
                </p>
              </>
            )}

            {ot && (
              <>
                <h3 className="mb-1 mt-3 flex items-center gap-1 text-sm font-semibold">
                  <Timer size={14} /> Overtime
                </h3>
                <Row label="Type / status">
                  {ot.type === 'COMP_OFF' ? 'Comp-off' : 'Overtime'} · {ot.status?.toLowerCase()}
                </Row>
                <Row label="Requested">{fmtSpan(ot.requestedMinutes)}</Row>
                {ot.status === 'APPROVED' && ot.type === 'OVERTIME' ? (
                  <Row label="Approved">{fmtSpan(day.approvedOtMinutes)}</Row>
                ) : null}
                {ot.status === 'APPROVED' && ot.type === 'COMP_OFF' ? (
                  <Row label="Comp-off earned">{day.compOffDays} day(s)</Row>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}

      {day.exceptions?.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <AlertTriangle size={14} className="text-crewly-orange" />
          {day.exceptions.map((code) => (
            <span key={code} className="rounded-full bg-crewly-orange/15 px-2 py-0.5 text-xs text-crewly-orange">
              {EXCEPTION_LABEL[code] || code}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-3 border-t border-white/10 pt-3 text-sm">
        <Link to="/app/attendance/regularizations" className="inline-flex items-center gap-1 text-crewly-green hover:underline">
          Corrections <ArrowRight size={13} />
        </Link>
        <Link to="/app/attendance/work-modes" className="inline-flex items-center gap-1 text-crewly-green hover:underline">
          Work modes <ArrowRight size={13} />
        </Link>
        <Link to="/app/attendance/overtime" className="inline-flex items-center gap-1 text-crewly-green hover:underline">
          Overtime <ArrowRight size={13} />
        </Link>
        <Link to="/app/leaves" className="inline-flex items-center gap-1 text-crewly-green hover:underline">
          Leaves <ArrowRight size={13} />
        </Link>
      </div>
    </Modal>
  );
};

const TimesheetMonthView = ({ sheet, employeeName = '' }) => {
  const [openDate, setOpenDate] = useState(null);
  const days = sheet?.days || [];
  const summary = sheet?.summary;

  const cells = useMemo(() => {
    if (!days.length) return [];
    const first = new Date(`${days[0].date}T00:00:00`);
    const lead = (first.getDay() + 6) % 7; // Monday-first grid
    return [...Array(lead).fill(null), ...days];
  }, [days]);

  const openDay = openDate ? days.find((day) => day.date === openDate) : null;
  const counts = summary?.dayCounts || {};

  return (
    <div className="space-y-4">
      {employeeName && (
        <p className="text-sm text-crewly-dim">
          Showing <span className="font-medium text-crewly-text">{employeeName}</span>
          {sheet?.employee?.employeeCode ? ` (${sheet.employee.employeeCode})` : ''}
          {sheet?.employee?.department?.name ? ` · ${sheet.employee.department.name}` : ''}.
        </p>
      )}

      {summary && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          <Stat label="Present" value={counts.present ?? 0} tone="text-crewly-green" />
          <Stat label="Half day" value={counts.halfDay ?? 0} tone="text-blue-300" />
          <Stat label="Absent" value={counts.absent ?? 0} tone="text-crewly-red" />
          <Stat label="Leave" value={counts.leave ?? 0} tone="text-violet-300" />
          <Stat label="Worked" value={fmtSpan(summary.workedMinutes)} />
          <Stat label="Late days" value={summary.lateDays ?? 0} />
          <Stat label="Approved OT" value={fmtSpan(summary.approvedOtMinutes)} />
          <Stat label="Exceptions" value={summary.exceptionDays ?? 0} tone={(summary.exceptionDays || 0) > 0 ? 'text-crewly-orange' : ''} />
        </div>
      )}

      <div className="card">
        <div className="mb-2 grid grid-cols-7 gap-1 text-center text-xs text-crewly-dim">
          {WEEKDAYS.map((name) => <span key={name}>{name}</span>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((day, index) => {
            if (!day) return <span key={`blank-${index}`} />;
            return (
              <button
                key={day.date}
                type="button"
                onClick={() => setOpenDate(day.date)}
                title={`${fmtDay(day.date)} — ${OUTCOME_LABEL[day.bucket] || day.bucket}`}
                className={`flex min-h-14 flex-col items-start justify-between rounded-lg border p-1.5 text-left transition-colors hover:border-crewly-green/50 ${
                  day.isToday ? 'border-crewly-green/60' : 'border-white/10'
                } ${day.isFuture ? 'opacity-50' : ''}`}
              >
                <span className="flex w-full items-center justify-between">
                  <span className="text-sm font-medium">{Number(day.date.slice(8, 10))}</span>
                  <span className={`h-2 w-2 rounded-full ${OUTCOME_DOT[day.bucket] || 'bg-white/10'}`} />
                </span>
                <span className="flex items-center gap-1 text-[11px] text-crewly-dim">
                  {day.bucket === 'LEAVE' && <Plane size={11} />}
                  {day.bucket === 'HOLIDAY' && <CalendarOff size={11} />}
                  {day.bucket === 'WEEKLY_OFF' && <Moon size={11} />}
                  {day.bucket === 'PRESENT' && day.workMode === 'OFFICE' && <Building2 size={11} />}
                  {day.bucket === 'PRESENT' && day.workMode && day.workMode !== 'OFFICE' && <CheckCircle2 size={11} />}
                  <span className="hidden sm:inline">{OUTCOME_LABEL[day.bucket] || ''}</span>
                </span>
                {day.exceptions?.length > 0 && (
                  <span className="text-[11px] font-medium text-crewly-orange">
                    {day.exceptions.length} flag{day.exceptions.length > 1 ? 's' : ''}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-crewly-dim">
          Select any day for the full breakdown. Past months stay readable — corrections and
          schedule history apply to the day they belong to.
        </p>
      </div>

      {openDay && <DayDrawer day={openDay} onClose={() => setOpenDate(null)} />}
    </div>
  );
};

export default TimesheetMonthView;
