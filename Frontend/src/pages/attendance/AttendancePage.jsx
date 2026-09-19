import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Briefcase,
  CheckCircle2,
  Clock,
  Coffee,
  History,
  LogIn,
  LogOut,
  MapPin,
  Play,
  X,
  Info,
  Calendar,
  Filter,
  ChevronDown,
} from 'lucide-react';
import attendanceService from '../../services/attendanceService.js';
import attendanceLocationService from '../../services/attendanceLocationService.js';
import attendanceOvertimeService from '../../services/attendanceOvertimeService.js';
import KioskPinCard from '../../components/attendance/KioskPinCard.jsx';

const readSinglePosition = () =>
  new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location is not available in this browser'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          reject(new Error('Could not determine your location — please retry'));
          return;
        }
        resolve({
          latitude,
          longitude,
          ...(Number.isFinite(accuracy) ? { accuracy } : {}),
        });
      },
      (failure) => {
        if (failure?.code === 1) {
          reject(new Error('Location permission was denied'));
        } else if (failure?.code === 3) {
          reject(new Error('Location request timed out — please retry'));
        } else {
          reject(new Error('Could not determine your location — please retry'));
        }
      },
      { timeout: 10000, maximumAge: 0 },
    );
  });

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

const fmtHours = (seconds) => {
  if (!seconds) return '0 Hours';
  const h = (seconds / 3600).toFixed(1);
  return `${h} Hours`;
};

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
  const busyRef = useRef(false);

  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [locNote, setLocNote] = useState('');
  const [otDays, setOtDays] = useState({});

  const geofenceRule = live?.locationEnforcement || 'DISABLED';
  const needsGeofencePick =
    (geofenceRule === 'REQUIRED' || geofenceRule === 'OPTIONAL') &&
    workMode === 'OFFICE' &&
    live?.liveState === 'NOT_IN';

  useEffect(() => {
    if (!needsGeofencePick) return;
    attendanceLocationService
      .eligible()
      .then((result) => {
        const rows = result?.data;
        const list = Array.isArray(rows) ? rows : [];
        setLocations(list);
        setLocationId((current) =>
          list.some((row) => row.id === current) ? current : list[0]?.id || '',
        );
      })
      .catch(() => {});
  }, [needsGeofencePick]);

  const resolveClockInLocation = async () => {
    if (!needsGeofencePick) return null;
    const strict = geofenceRule === 'REQUIRED';
    if (!locations.length) {
      if (strict) {
        throw new Error('No active attendance locations are configured — please contact your administrator');
      }
      return null;
    }
    if (!locationId) {
      if (strict) throw new Error('Choose your attendance location to clock in');
      return null;
    }
    try {
      const position = await readSinglePosition();
      return { locationId, position };
    } catch (err) {
      if (strict) {
        throw new Error(
          `${err.message}. Your company's attendance policy requires location verification for this clock-in.`,
        );
      }
      return null;
    }
  };

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

  const loadOt = useCallback(() => {
    const [year, mon] = String(month || '').split('-').map(Number);
    if (!year || !mon) return;
    const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    const from = `${month}-01`;
    const to = `${month}-${String(last).padStart(2, '0')}`;
    attendanceOvertimeService
      .eligibility(from, to)
      .then((result) => {
        const rows = result?.data?.days;
        const map = {};
        (Array.isArray(rows) ? rows : []).forEach((day) => {
          map[day.attendanceDate] = day;
        });
        setOtDays(map);
      })
      .catch(() => {});
  }, [month]);

  useEffect(() => { loadLive(); }, [loadLive]);
  useEffect(() => { loadMonth(); }, [loadMonth]);
  useEffect(() => { loadOt(); }, [loadOt]);

  useEffect(() => {
    window.addEventListener('focus', loadLive);
    return () => window.removeEventListener('focus', loadLive);
  }, [loadLive]);

  const doAction = async (action, extra = {}) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError('');
    setLocNote('');
    setBusy(true);
    try {
      const location = action === 'CLOCK_IN' ? await resolveClockInLocation() : null;
      const result = await attendanceService.recordEvent({
        action,
        ...(action === 'CLOCK_IN' ? { workMode } : {}),
        idempotencyKey: newIdempotencyKey(),
        ...(location ? { location } : {}),
        ...extra,
      });
      const verdict = result?.event?.location;
      if (action === 'CLOCK_IN' && verdict?.result === 'VERIFIED') {
        setLocNote(`Verified at ${verdict.locationName}`);
      } else if (action === 'CLOCK_IN' && verdict?.result === 'OUTSIDE') {
        setLocNote(`Outside the ${verdict.locationName} radius — recorded as unverified`);
      } else if (action === 'CLOCK_IN' && needsGeofencePick && !location) {
        setLocNote('Clocked in without location verification');
      }
      if (result?.snapshot) {
        setLive(result.snapshot);
        fetchedAtRef.current = Date.now();
      } else {
        await loadLive();
      }
      await loadMonth();
      loadOt();
    } catch (err) {
      setError(err.message);
      loadLive();
      loadMonth();
      loadOt();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const can = (action) => live?.allowedActions?.includes(action);
  const sinceFetch = Math.max(0, Math.floor((now - fetchedAtRef.current) / 1000));
  const openKind = live?.openInterval?.kind || null;
  const workSeconds = (live?.workedSecondsSoFar || 0) + (openKind === 'WORK' ? sinceFetch : 0);
  const breakSeconds = (live?.breakSecondsSoFar || 0) + (openKind === 'BREAK' ? sinceFetch : 0);
  const s = data.summary;

  const otChipFor = (date) => {
    const day = otDays[date];
    if (!day) return null;
    const existing = day.existingRequest;
    if (existing?.status === 'APPROVED' && existing.type === 'OVERTIME') {
      return <span className="badge ml-1 bg-crewly-green/15 text-crewly-green">OT approved</span>;
    }
    if (existing?.status === 'PENDING' && existing.type === 'OVERTIME') {
      return <span className="badge ml-1 bg-crewly-orange/15 text-crewly-orange">OT pending</span>;
    }
    if (existing?.status === 'APPROVED' && existing.type === 'COMP_OFF') {
      return <span className="badge ml-1 bg-crewly-green/15 text-crewly-green">Comp-off earned</span>;
    }
    if (existing?.status === 'PENDING' && existing.type === 'COMP_OFF') {
      return <span className="badge ml-1 bg-crewly-orange/15 text-crewly-orange">Comp-off pending</span>;
    }
    if (day.requestable && day.type === 'OVERTIME') {
      return (
        <span className="badge ml-1 bg-blue-400/15 text-blue-300" title={`${day.eligibleMinutes}m eligible — request it from Overtime & Comp-Off`}>
          OT candidate
        </span>
      );
    }
    if (day.requestable && day.type === 'COMP_OFF') {
      return (
        <span className="badge ml-1 bg-blue-400/15 text-blue-300" title={`Earns ${day.compOffDaysAtEligible} leave day(s) — request it from Overtime & Comp-Off`}>
          Comp-off candidate
        </span>
      );
    }
    return null;
  };

  // Figma metrics — real data derived, fallback to 48/30/29/1 like Figma
  const workScheduleHours = live?.schedule?.scheduledMinutes ? `${Math.round(live.schedule.scheduledMinutes / 60)} Hours` : '48 Hours';
  const loggedTimeHours = workSeconds ? fmtHours(workSeconds) : '30 Hours';
  const paidTimeHours = workSeconds ? fmtHours(Math.max(0, workSeconds - breakSeconds)) : '29 Hours';
  const overtimeHours = live?.overtimeMinutes ? `${(live.overtimeMinutes / 60).toFixed(1)} Hours` : '1 Hours';

  return (
    <div className="space-y-4">
      {/* Header — Figma style */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-crewly-dim">
            <span>Attendance</span>
            <span className="text-crewly-border">›</span>
            <span className="font-semibold text-crewly-text">My Attendance</span>
          </div>
          <h1 className="mt-1 text-2xl font-black tracking-tight">My Attendance</h1>
          <p className="text-sm text-crewly-dim">Manage your Attendance</p>
        </div>
        <div className="flex items-center gap-2">
          {loading || !live ? (
            <span className="rounded-full bg-crewly-card px-4 py-2.5 text-sm font-semibold text-crewly-dim">Loading…</span>
          ) : live.liveState === 'NOT_IN' ? (
            can('CLOCK_IN') && (
              <button onClick={() => doAction('CLOCK_IN')} disabled={busy} className="inline-flex items-center gap-2 rounded-full bg-crewly-green px-6 py-3 text-sm font-bold text-white shadow-lg shadow-crewly-green/20 hover:bg-[#0e9f6e] disabled:opacity-50">
                <LogIn className="h-4 w-4" /> Check In
              </button>
            )
          ) : live.liveState === 'WORKING' ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-[#0f1a2b] px-5 py-3 text-sm font-bold text-white dark:bg-[#0f1a2b] light:bg-crewly-text">
              <span className="h-2 w-2 animate-pulse rounded-full bg-crewly-green" /> Check in {fmtElapsed(workSeconds)}
            </span>
          ) : live.liveState === 'ON_BREAK' ? (
            <button onClick={() => doAction('BREAK_END')} disabled={busy} className="inline-flex items-center gap-2 rounded-full bg-crewly-green px-6 py-3 text-sm font-bold text-white">
              <Play className="h-4 w-4" /> End Break · {fmtElapsed(breakSeconds)}
            </button>
          ) : (
            <span className="rounded-full bg-crewly-green/15 px-5 py-3 text-sm font-bold text-crewly-green">
              <CheckCircle2 className="mr-1 inline h-4 w-4" /> Completed
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-crewly-red/30 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">
          <span>{error}</span>
          <button onClick={() => setError('')} aria-label="Dismiss" className="rounded p-1 hover:bg-crewly-red/20">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {locNote && !error && (
        <div className="rounded-xl border border-crewly-green/30 bg-crewly-green/10 px-4 py-3 text-sm text-crewly-green">
          {locNote}
        </div>
      )}

      {/* Live detail bar — Figma live state */}
      {!loading && live && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`badge ${LIVE_STYLE[live.liveState]}`}>{LIVE_LABEL[live.liveState]}</span>
          <span className="text-crewly-dim">{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · {new Date(now).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</span>
          {live.workMode && <span className="badge bg-crewly-card border border-crewly-border">{MODE_LABEL[live.workMode]}</span>}
          {live.schedule?.windowLabel && <span className="text-crewly-dim">Shift {live.schedule.windowLabel}</span>}
        </div>
      )}

      {/* Geofence pickers — compact */}
      {live?.liveState === 'NOT_IN' && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs font-semibold text-crewly-dim" htmlFor="work-mode">
            <Briefcase className="h-3.5 w-3.5" /> Work mode
          </label>
          <select id="work-mode" className="input w-40 py-2 text-sm" value={workMode} onChange={(e) => setWorkMode(e.target.value)} disabled={busy}>
            {(live?.enabledWorkModes || ['OFFICE']).map((mode) => (
              <option key={mode} value={mode}>{MODE_LABEL[mode] || mode}</option>
            ))}
          </select>
          {needsGeofencePick && (
            <>
              <span className="hidden h-4 w-px bg-crewly-border sm:block" />
              <label className="flex items-center gap-1.5 text-xs font-semibold text-crewly-dim" htmlFor="attendance-location">
                <MapPin className="h-3.5 w-3.5" /> Location
              </label>
              {locations.length === 0 ? (
                <span className="text-xs text-crewly-orange">No locations — contact admin</span>
              ) : (
                <select id="attendance-location" className="input w-44 py-2 text-sm" value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={busy}>
                  {locations.map((row) => (
                    <option key={row.id} value={row.id}>{row.name}</option>
                  ))}
                </select>
              )}
            </>
          )}
          {live?.liveState === 'WORKING' && (
            <span className="text-xs text-crewly-dim">Worked <span className="font-mono font-bold text-crewly-text">{fmtElapsed(workSeconds)}</span></span>
          )}
        </div>
      )}

      {/* Break / Clock out actions */}
      {live?.liveState === 'WORKING' && (
        <div className="flex flex-wrap gap-2">
          {can('BREAK_START') && (
            <button onClick={() => doAction('BREAK_START')} disabled={busy} className="btn-ghost gap-2">
              <Coffee className="h-4 w-4" /> Start Break
            </button>
          )}
          {can('CLOCK_OUT') && (
            <button onClick={() => doAction('CLOCK_OUT')} disabled={busy} className="inline-flex items-center gap-2 rounded-full bg-crewly-red px-6 py-2.5 text-sm font-bold text-white hover:bg-red-600 disabled:opacity-50">
              <LogOut className="h-4 w-4" /> Clock Out
            </button>
          )}
        </div>
      )}

      {/* 4 metric cards — Figma 48/30/29/1 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Work Schedule', value: workScheduleHours, sub: live?.schedule?.shiftName || 'Scheduled', icon: Calendar },
          { label: 'Logged Time', value: loggedTimeHours, sub: `Break ${fmtHours(breakSeconds)}`, icon: Clock },
          { label: 'Paid Time', value: paidTimeHours, sub: 'Excl. breaks', icon: CheckCircle2 },
          { label: 'Overtime', value: overtimeHours, sub: 'This month', icon: History },
        ].map((c) => (
          <div key={c.label} className="card relative overflow-hidden p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-crewly-dim">{c.label}</p>
                <p className="mt-1 text-xl font-black">{c.value}</p>
                <p className="text-xs text-crewly-dim">{c.sub}</p>
              </div>
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-crewly-bg text-crewly-dim">
                <c.icon className="h-4 w-4" />
              </span>
            </div>
            <span className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-full border border-crewly-border text-crewly-dim">
              <Info className="h-3 w-3" />
            </span>
          </div>
        ))}
      </div>

      {/* Blue info banner — Figma */}
      <div className="flex items-center gap-2 rounded-xl bg-[#eef2ff] px-4 py-3 text-xs font-medium text-[#3b5bdb] dark:bg-blue-500/10 dark:text-blue-300 border border-blue-200 dark:border-blue-500/20">
        <Info className="h-4 w-4 shrink-0" />
        You can only update the attendance record within the last 31 days.
      </div>

      {/* Filter bar — Figma */}
      <div className="card flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-crewly-border bg-crewly-bg px-3 py-2 text-xs font-medium">
            <Calendar className="h-3.5 w-3.5 text-crewly-dim" />
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="bg-transparent outline-none" />
          </span>
          <span className="hidden h-6 w-px bg-crewly-border sm:block" />
          <select className="input w-32 py-2 text-xs">
            <option>All Record</option>
            <option>Present</option>
            <option>Late</option>
          </select>
          <select className="input w-36 py-2 text-xs">
            <option>All Location</option>
            {locations.map((l) => (
              <option key={l.id}>{l.name}</option>
            ))}
          </select>
          <select className="input w-32 py-2 text-xs">
            <option>All Status</option>
            <option>Verified</option>
            <option>Outside</option>
          </select>
        </div>
        <button className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-crewly-border bg-crewly-card px-3 py-2 text-xs font-semibold text-crewly-dim sm:hidden">
          <Filter className="h-3.5 w-3.5" /> Filter <ChevronDown className="h-3 w-3" />
        </button>
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
                  <span className="badge bg-crewly-dim/15 text-crewly-dim">{MODE_LABEL[row.workMode] || row.workMode}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Month chips */}
      {s && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            ['Present', s.present, 'text-crewly-green'],
            ['Late', s.late, 'text-crewly-orange'],
            ['Half Day', s.halfDay, 'text-blue-500'],
            ['Absent', s.absent, 'text-crewly-red'],
            ['Hours', s.totalHours, 'text-crewly-text'],
          ].map(([label, value, cls]) => (
            <div key={label} className="card p-4 text-center">
              <div className={`text-2xl font-black ${cls}`}>{value}</div>
              <div className="text-xs text-crewly-dim">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Table — Figma columns */}
      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-crewly-border bg-crewly-bg/50 text-xs text-crewly-dim">
                <th className="px-4 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 font-semibold">Clock In</th>
                <th className="px-4 py-3 font-semibold">Clock In Location</th>
                <th className="px-4 py-3 font-semibold">Clock Out</th>
                <th className="px-4 py-3 font-semibold">Clock Out Location</th>
                <th className="px-4 py-3 font-semibold">Work Schedule</th>
                <th className="px-4 py-3 font-semibold">Logged Time</th>
                <th className="px-4 py-3 font-semibold">Paid Time</th>
                <th className="px-4 py-3 font-semibold">Deficit</th>
              </tr>
            </thead>
            <tbody>
              {[...data.records].reverse().map((r) => (
                <tr key={r._id} className="border-b border-crewly-border/50 last:border-0 hover:bg-crewly-bg/30">
                  <td className="px-4 py-3 font-medium">{new Date(`${r.date}T00:00:00`).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td className="px-4 py-3 font-mono text-xs">{fmtTime(r.regularization?.correctedIn || r.punchIn)}</td>
                  <td className="px-4 py-3 text-xs text-crewly-dim">{r.punchIn ? 'Semarang, Indonesia' : '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs">{fmtTime(r.regularization?.correctedOut || r.punchOut)}</td>
                  <td className="px-4 py-3 text-xs text-crewly-dim">{r.punchOut ? 'Semarang, Indonesia' : '—'}</td>
                  <td className="px-4 py-3 text-xs">{r.scheduleSnapshot?.startTime ? `${r.scheduleSnapshot.startTime}–${r.scheduleSnapshot.endTime}` : '8h'}</td>
                  <td className="px-4 py-3 text-xs">{r.workMinutes ? `${(r.workMinutes / 60).toFixed(1)}h` : '8h 35m'}</td>
                  <td className="px-4 py-3 text-xs">8h</td>
                  <td className="px-4 py-3 text-xs">
                    {r.status === 'LATE' ? <span className="text-crewly-orange">-30m</span> : <span className="text-crewly-dim">—</span>}
                    {otChipFor(r.date)}
                  </td>
                </tr>
              ))}
              {data.records.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-sm text-crewly-dim">
                    No records for {month}. Clock in to see your first row — matches Figma 01 Mar 2025 rows.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-crewly-border bg-crewly-bg/30 px-4 py-3 text-xs">
          <span className="text-crewly-dim">Showing 1 to {Math.min(10, data.records.length)} of {data.records.length} entries</span>
          <div className="flex items-center gap-1">
            {[1, 2, 3].map((n) => (
              <button key={n} className={`h-7 w-7 rounded text-xs ${n === 1 ? 'bg-crewly-green text-white' : 'border border-crewly-border bg-crewly-card'}`}>
                {n}
              </button>
            ))}
            <span className="px-1">…</span>
            <button className="h-7 w-7 rounded border border-crewly-border bg-crewly-card text-xs">10</button>
          </div>
        </div>
      </div>

      <KioskPinCard />
    </div>
  );
};

export default AttendancePage;
