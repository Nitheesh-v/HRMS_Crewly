import { useEffect, useState } from 'react';
import attendanceService from '../../services/attendanceService.js';

const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
const currentMonth = () => new Date().toISOString().slice(0, 7);

const STATUS_STYLE = {
  PRESENT: 'bg-crewly-green/15 text-crewly-green',
  LATE: 'bg-crewly-orange/15 text-crewly-orange',
  HALF_DAY: 'bg-blue-400/15 text-blue-300',
};

const AttendancePage = () => {
  const [today, setToday] = useState(null);
  const [now, setNow] = useState(new Date());
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState({ records: [], summary: null });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // live clock tick
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const loadToday = () => attendanceService.today().then(setToday).catch((e) => setError(e.message));
  const loadMonth = () =>
    attendanceService.my(month).then(setData).catch((e) => setError(e.message));

  useEffect(() => { loadToday(); }, []);
  useEffect(() => { loadMonth(); }, [month]);

  const doPunch = async (kind) => {
    setError(''); setBusy(true);
    try {
      if (kind === 'in') await attendanceService.punchIn();
      else await attendanceService.punchOut();
      await loadToday();
      loadMonth();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  // live elapsed timer while on duty
  const elapsed =
    today?.punchIn && !today?.punchOut
      ? Math.max(0, Math.floor((now - new Date(today.punchIn)) / 1000))
      : null;
  const fmtElapsed = (s) =>
    `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const s = data.summary;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">🕒 My Attendance</h1>

      {error && <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">{error}</div>}

      {/* Punch card */}
      <div className="card flex flex-col items-center gap-4 py-10 text-center">
        <div className="text-4xl font-bold tabular-nums tracking-wide">
          {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </div>
        <div className="text-sm text-crewly-dim">
          {now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </div>

     {!today?.punchIn &&  (
          <button onClick={() => doPunch('in')} disabled={busy} className="btn-primary mt-3 px-10 py-3 text-lg">
            ● Punch In
          </button>
        )}

       {today?.punchIn && !today?.punchOut && (
          <>
            <p className="text-sm text-crewly-dim">
              On duty since <span className="text-crewly-green">{fmtTime(today.punchIn)}</span>
              {today.status === 'LATE' && <span className="badge ml-2 bg-crewly-orange/15 text-crewly-orange">LATE</span>}
              {' · '}
              <span className="font-mono text-crewly-text">{fmtElapsed(elapsed)}</span>
            </p>
            <button onClick={() => doPunch('out')} disabled={busy} className="mt-2 inline-flex items-center justify-center rounded-lg bg-crewly-red px-10 py-3 text-lg font-semibold text-white transition hover:opacity-90 disabled:opacity-50">
              ■ Punch Out
            </button>
          </>
        )}

        {today?.punchOut && (
          <p className="mt-2 text-sm text-crewly-dim">
            ✅ Done for today: <span className="text-crewly-text">{fmtTime(today.punchIn)} → {fmtTime(today.punchOut)}</span>
            {' · '}{(today.workMinutes / 60).toFixed(1)}h worked
          </p>
        )}
      </div>

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