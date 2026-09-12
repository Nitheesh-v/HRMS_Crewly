import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Briefcase,
  CheckCircle2,
  Clock,
  Coffee,
  History,
  LogIn,
  LogOut,
  Play,
  X,
} from 'lucide-react';
import attendanceService from '../../services/attendanceService.js';

const fmtTime = (d) =>
  d ? new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
const currentMonth = () => new Date().toISOString().slice(0, 7);

const STATUS_STYLE = {
  PRESENT: 'bg-crewly-green/15 text-crewly-green',
  LATE: 'bg-crewly-orange/15 text-crewly-orange',
  HALF_DAY: 'bg-blue-400/15 text-blue-300',
};

const LIVE_STYLE = {
  NOT_IN: 'bg-crewly-dim/15 text-crewly-dim',
  WORKING: 'bg-crewly-green/15 text-crewly-green',
  ON_BREAK: 'bg-crewly-orange/15 text-crewly-orange',
  COMPLETED: 'bg-blue-400/15 text-blue-300',
};

const LIVE_LABEL = {
  NOT_IN: 'Not clocked in',
  WORKING: 'Working',
  ON_BREAK: 'On break',
  COMPLETED: 'Completed',
};

const MODE_LABEL = {
  OFFICE: 'Office',
  WFH: 'Work from home',
  FIELD: 'Field',
  CLIENT_SITE: 'Client site',
  BUSINESS_TRAVEL: 'Business travel',
};

const TIMELINE_LABEL = {
  CLOCK_IN: 'Clocked in',
  BREAK_START: 'Break started',
  BREAK_END: 'Break ended',
  CLOCK_OUT: 'Clocked out',
};

const fmtElapsed = (s) =>
  `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

const newIdempotencyKey = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

const AttendancePage = () => {
  const [live, setLive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState({ records: [], summary: null });
  const [workMode, setWorkMode] = useState('OFFICE');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fetchedAtRef = useRef(Date.now());
  // Synchronous double-submit guard: React state updates async, so two
  // rapid clicks can both pass the `busy` check and fire duplicate
  // requests (each with its own idempotency key). The ref closes that.
  const busyRef = useRef(false);

  // 1s local tick — the display derives from server-authoritative
  // timestamps; no per-second backend traffic happens here.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const loadLive = useCallback(async () => {
    try {
      const snapshot = await attendanceService.todayLive();
      setLive(snapshot);
      fetchedAtRef.current = Date.now();
      if (snapshot?.enabledWorkModes?.length) {
        setWorkMode((current) =>
          snapshot.enabledWorkModes.includes(current)
            ? current
            : snapshot.enabledWorkModes[0],
        );
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMonth = useCallback(
    () => attendanceService.my(month).then(setData).catch((e) => setError(e.message)),
    [month],
  );

  useEffect(() => { loadLive(); }, [loadLive]);
  useEffect(() => { loadMonth(); }, [loadMonth]);

  // Reconcile to authoritative state whenever the tab regains focus.
  useEffect(() => {
    window.addEventListener('focus', loadLive);
    return () => window.removeEventListener('focus', loadLive);
  }, [loadLive]);

  const doAction = async (action, extra = {}) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError('');
    setBusy(true);
    try {
      const result = await attendanceService.recordEvent({
        action,
        ...(action === 'CLOCK_IN' ? { workMode } : {}),
        idempotencyKey: newIdempotencyKey(),
        ...extra,
      });
      if (result?.snapshot) {
        setLive(result.snapshot);
        fetchedAtRef.current = Date.now();
      } else {
        await loadLive();
      }
      await loadMonth();
    } catch (err) {
      setError(err.message);
      // Backend is authoritative — refresh even on failure (a 409 means
      // state moved under us).
      loadLive();
      loadMonth();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const can = (action) => live?.allowedActions?.includes(action);

  // Live counters: server "so far" base + wall-clock since fetch, but
  // only the RUNNING interval ticks — the other one stays frozen.
  const sinceFetch = Math.max(0, Math.floor((now - fetchedAtRef.current) / 1000));
  const openKind = live?.openInterval?.kind || null;
  const workSeconds = (live?.workedSecondsSoFar || 0) + (openKind === 'WORK' ? sinceFetch : 0);
  const breakSeconds = (live?.breakSecondsSoFar || 0) + (openKind === 'BREAK' ? sinceFetch : 0);

  const s = data.summary;

  return (
    <div className="space-y-5">
      <h1 className="flex items-center gap-2 text-2xl font-bold">
        <Clock className="h-6 w-6 text-crewly-green" /> My Attendance
      </h1>

      {error && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
          <span>{error}</span>
          <button
            onClick={() => setError('')}
            aria-label="Dismiss error"
            className="rounded p-0.5 transition hover:bg-crewly-red/20"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Today / live card */}
      <div className="card flex flex-col items-center gap-3 py-8 text-center">
        {loading || !live ? (
          <p className="py-6 text-sm text-crewly-dim">Loading today's attendance…</p>
        ) : (
          <>
            <span className={`badge ${LIVE_STYLE[live.liveState] || LIVE_STYLE.NOT_IN}`}>
              {LIVE_LABEL[live.liveState] || live.liveState}
            </span>

            <div className="text-4xl font-bold tabular-nums tracking-wide">
              {new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </div>
            <div className="text-sm text-crewly-dim">
              {new Date(now).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </div>

            {!live.isToday && (
              <p className="rounded-lg bg-crewly-orange/10 px-4 py-2 text-sm text-crewly-orange">
                Showing your open session from {live.date} — close it to start a new day.
              </p>
            )}

            {live.otherOpenSession && (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-crewly-orange/40 bg-crewly-orange/10 px-4 py-3 text-sm">
                <span className="text-crewly-orange">
                  You also have an open session from {live.otherOpenSession.date}.
                </span>
                <button
                  onClick={() => doAction('CLOCK_OUT', { date: live.otherOpenSession.date })}
                  disabled={busy}
                  className="btn-ghost px-4 py-2 text-sm"
                >
                  Clock out {live.otherOpenSession.date}
                </button>
              </div>
            )}

            {live.liveState === 'NOT_IN' && (
              <>
                {live.schedule && live.schedule.source !== 'DEFAULT' && (
                  <p className="text-sm text-crewly-dim">
                    {live.schedule.name}
                    {live.schedule.startTime && live.schedule.endTime
                      ? ` · ${live.schedule.startTime}–${live.schedule.endTime}`
                      : ''}
                  </p>
                )}
                <label className="label mt-1 flex items-center gap-2" htmlFor="work-mode">
                  <Briefcase className="h-4 w-4" /> Work mode
                </label>
                <select
                  id="work-mode"
                  className="input w-56 text-center"
                  value={workMode}
                  onChange={(e) => setWorkMode(e.target.value)}
                  disabled={busy}
                >
                  {(live.enabledWorkModes || ['OFFICE']).map((mode) => (
                    <option key={mode} value={mode}>{MODE_LABEL[mode] || mode}</option>
                  ))}
                </select>
                {can('CLOCK_IN') && (
                  <button
                    onClick={() => doAction('CLOCK_IN')}
                    disabled={busy}
                    className="btn-primary mt-2 inline-flex items-center gap-2 px-10 py-3 text-lg"
                  >
                    <LogIn className="h-5 w-5" /> Clock In
                  </button>
                )}
              </>
            )}

            {live.liveState === 'WORKING' && (
              <>
                <p className="text-sm text-crewly-dim">
                  On duty since <span className="text-crewly-green">{fmtTime(live.clockInAt)}</span>
                  {live.workMode && (
                    <span className="text-crewly-dim"> · {MODE_LABEL[live.workMode] || live.workMode}</span>
                  )}
                  {live.status === 'LATE' && (
                    <span className="badge ml-2 bg-crewly-orange/15 text-crewly-orange">LATE</span>
                  )}
                </p>
                <p className="text-sm text-crewly-dim">
                  Worked <span className="font-mono text-lg text-crewly-text">{fmtElapsed(workSeconds)}</span>
                  {live.breakSecondsSoFar > 0 && (
                    <span> · Breaks {fmtElapsed(breakSeconds)}</span>
                  )}
                </p>
                <div className="mt-1 flex flex-wrap items-center justify-center gap-3">
                  {can('BREAK_START') && (
                    <button
                      onClick={() => doAction('BREAK_START')}
                      disabled={busy}
                      className="btn-ghost inline-flex items-center gap-2 px-6 py-3"
                    >
                      <Coffee className="h-5 w-5" /> Start Break
                    </button>
                  )}
                  {can('CLOCK_OUT') && (
                    <button
                      onClick={() => doAction('CLOCK_OUT')}
                      disabled={busy}
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-crewly-red px-8 py-3 text-lg font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
                    >
                      <LogOut className="h-5 w-5" /> Clock Out
                    </button>
                  )}
                </div>
              </>
            )}

            {live.liveState === 'ON_BREAK' && (
              <>
                <p className="text-sm text-crewly-dim">
                  On break since{' '}
                  <span className="text-crewly-orange">{fmtTime(live.openInterval?.startedAt)}</span>
                </p>
                <p className="text-sm text-crewly-dim">
                  Break <span className="font-mono text-lg text-crewly-text">{fmtElapsed(breakSeconds)}</span>
                  <span> · Worked {fmtElapsed(workSeconds)}</span>
                </p>
                {can('BREAK_END') && (
                  <button
                    onClick={() => doAction('BREAK_END')}
                    disabled={busy}
                    className="btn-primary mt-1 inline-flex items-center gap-2 px-8 py-3 text-lg"
                  >
                    <Play className="h-5 w-5" /> End Break
                  </button>
                )}
              </>
            )}

            {live.liveState === 'COMPLETED' && (
              <>
                <p className="text-sm text-crewly-dim">
                  <CheckCircle2 className="mr-1 inline h-4 w-4 text-crewly-green" />
                  Done for {live.date === live.today ? 'today' : live.date}:{' '}
                  <span className="text-crewly-text">
                    {fmtTime(live.clockInAt)} → {fmtTime(live.clockOutAt)}
                  </span>
                </p>
                <p className="text-sm text-crewly-dim">
                  Worked <span className="text-crewly-text">{(live.workedMinutes / 60).toFixed(1)}h</span>
                  {live.breakMinutes > 0 && (
                    <span> · Breaks {live.breakMinutes}m</span>
                  )}
                  {live.status && (
                    <span className={`badge ml-2 ${STATUS_STYLE[live.status] || ''}`}>
                      {live.status.replace('_', ' ')}
                    </span>
                  )}
                </p>
              </>
            )}
          </>
        )}
      </div>

      {/* Today's timeline */}
      {live?.timeline?.length > 0 && (
        <div className="card p-0">
          <div className="flex items-center gap-2 border-b border-crewly-border px-5 py-3">
            <History className="h-4 w-4 text-crewly-dim" />
            <h2 className="font-semibold">Today's timeline</h2>
          </div>
          <ul className="divide-y divide-crewly-border/50">
            {live.timeline.map((row) => (
              <li key={row.seq} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                <span className="w-16 shrink-0 font-mono text-crewly-dim">{fmtTime(row.at)}</span>
                <span className="text-crewly-text">{TIMELINE_LABEL[row.type] || row.type}</span>
                {row.type === 'CLOCK_IN' && row.workMode && (
                  <span className="badge bg-crewly-dim/15 text-crewly-dim">
                    {MODE_LABEL[row.workMode] || row.workMode}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Month summary chips */}
      {s && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            ['Present', s.present, 'text-crewly-green'],
            ['Late', s.late, 'text-crewly-orange'],
            ['Half Day', s.halfDay, 'text-blue-300'],
            ['Absent', s.absent, 'text-crewly-red'],
            ['Hours', s.totalHours, 'text-crewly-text'],
          ].map(([label, value, cls]) => (
            <div key={label} className="card p-4 text-center">
              <div className={`text-2xl font-bold ${cls}`}>{value}</div>
              <div className="text-xs text-crewly-dim">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* History */}
      <div className="card p-0">
        <div className="flex items-center justify-between border-b border-crewly-border px-5 py-3">
          <h2 className="font-semibold">Attendance History</h2>
          <input type="month" className="input w-44" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-crewly-border text-crewly-dim">
                <th className="px-5 py-3">Date</th>
                <th className="px-5 py-3">Punch In</th>
                <th className="px-5 py-3">Punch Out</th>
                <th className="px-5 py-3">Hours</th>
                <th className="px-5 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {[...data.records].reverse().map((r) => (
                <tr key={r._id} className="border-b border-crewly-border/50 last:border-0">
                  <td className="px-5 py-3">{new Date(`${r.date}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', weekday: 'short' })}</td>
                  <td className="px-5 py-3">{fmtTime(r.punchIn)}</td>
                  <td className="px-5 py-3">{fmtTime(r.punchOut)}</td>
                  <td className="px-5 py-3">{r.workMinutes ? `${(r.workMinutes / 60).toFixed(1)}h` : '—'}</td>
                  <td className="px-5 py-3"><span className={`badge ${STATUS_STYLE[r.status]}`}>{r.status.replace('_', ' ')}</span></td>
                </tr>
              ))}
              {data.records.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-crewly-dim">No records this month.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default AttendancePage;
