import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Briefcase,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock,
  Coffee,
  Download,
  Hourglass,
  Info,
  LogIn,
  LogOut,
  MapPin,
  Play,
  Route,
  TrendingUp,
  X,
} from 'lucide-react';
import attendanceService from '../../services/attendanceService.js';
import attendanceLocationService from '../../services/attendanceLocationService.js';
import attendanceOvertimeService from '../../services/attendanceOvertimeService.js';
import KioskPinCard from '../../components/attendance/KioskPinCard.jsx';

// One-shot browser position for the explicit Clock-In click. Resolves
// { latitude, longitude, accuracy? } or throws an employee-safe Error.
// getCurrentPosition ONLY — watchPosition must never appear in this file.
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
        // GeolocationPositionError codes: 1 denied, 2 unavailable, 3 timeout.
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
  HALF_DAY: 'bg-crewly-accent/15 text-crewly-orange',
};

const LIVE_STYLE = {
  NOT_IN: 'bg-crewly-dim/15 text-crewly-dim',
  WORKING: 'bg-crewly-green/15 text-crewly-green',
  ON_BREAK: 'bg-crewly-orange/15 text-crewly-orange',
  COMPLETED: 'bg-crewly-inset-strong text-crewly-dim',
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

const newIdempotencyKey = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

/* ── small pieces of the attendance surface ────────────────────────────────
   The page is a clock, a session trace and a month's record. Each of those
   reads as one block, so the layout gives them their own card rather than
   stacking labelled paragraphs. */

/* "5h 09m" — the unit the record itself stores (minutes), shown as hours and
   minutes so a partial hour never rounds into a full one. */
const fmtHM = (seconds) => {
  const total = Math.max(0, Math.floor((Number(seconds) || 0) / 60));
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
};

const clockParts = (ms) => {
  const d = new Date(ms);
  const hours = d.getHours();
  const hh = String(hours % 12 === 0 ? 12 : hours % 12).padStart(2, '0');
  return {
    time: `${hh}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`,
    ampm: hours >= 12 ? 'PM' : 'AM',
  };
};

const monthLabel = (month) => {
  const [year, mon] = String(month || '').split('-').map(Number);
  if (!year || !mon) return 'This month';
  return new Date(Date.UTC(year, mon - 1, 1)).toLocaleDateString([], {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

/* A counted number with its caption and an icon in its own tile — the shape
   the rest of the app's censuses use, so attendance does not invent a fifth
   one. */
const Tile = ({ icon: Icon, label, value, sub, tone = 'dim', className = '' }) => {
  const tones = {
    green: 'bg-crewly-green/12 text-crewly-green',
    orange: 'bg-crewly-orange/12 text-crewly-orange',
    red: 'bg-crewly-red/12 text-crewly-red',
    dim: 'bg-crewly-inset text-crewly-dim',
  };
  return (
    <div className={`flex items-center gap-3 bg-crewly-card p-4 ${className}`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tones[tone] || tones.dim}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-crewly-dim">{label}</p>
        <p className="mt-0.5 text-xl font-bold leading-tight">{value}</p>
        {sub ? <p className="mt-0.5 text-[11px] leading-snug text-crewly-dim">{sub}</p> : null}
      </div>
    </div>
  );
};

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

  // Phase 31.3 — geofenced Clock In. Eligible offices load only when the
  // policy enforces location for OFFICE; the browser position is sampled
  // one-shot inside the explicit Clock-In click — never on load, tick
  // or break. No watchPosition anywhere in this file, by design.
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [locNote, setLocNote] = useState('');
  // Phase 31.8 — overtime / comp-off state per visible day (date →
  // eligibility day). Fails silent: the page works without it.
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

  // Builds the CLOCK_IN location payload (or throws an employee-safe
  // error that aborts the click without posting). REQUIRED blocks on
  // any gap; OPTIONAL degrades to unverified.
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

  // Phase 31.8 — eligibility for the visible month (read-only; a
  // 403 or network gap leaves the map empty, never an error).
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

  // Reconcile to authoritative state whenever the tab regains focus.
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
      // Geofence sampling happens inside the guarded click: aborts here
      // (REQUIRED gaps) post nothing.
      const location = action === 'CLOCK_IN' ? await resolveClockInLocation() : null;
      const result = await attendanceService.recordEvent({
        action,
        ...(action === 'CLOCK_IN' ? { workMode } : {}),
        idempotencyKey: newIdempotencyKey(),
        ...(location ? { location } : {}),
        ...extra,
      });
      // Employee-safe verification note from the server's own snapshot.
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
      // Backend is authoritative — refresh even on failure (a 409 means
      // state moved under us).
      loadLive();
      loadMonth();
      loadOt();
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

  // Phase 31.8 — one additive OT / comp-off badge per day. Never
  // replaces the underlying Holiday / Weekly Off / Leave badges.
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
        <span
          className="badge ml-1 bg-crewly-inset-strong text-crewly-dim"
          title={`${day.eligibleMinutes}m eligible — request it from Overtime & Comp-Off`}
        >
          OT candidate
        </span>
      );
    }
    if (day.requestable && day.type === 'COMP_OFF') {
      return (
        <span
          className="badge ml-1 bg-crewly-inset-strong text-crewly-dim"
          title={`Earns ${day.compOffDaysAtEligible} leave day(s) — request it from Overtime & Comp-Off`}
        >
          Comp-off candidate
        </span>
      );
    }
    return null;
  };

  /* ── derived view data ─────────────────────────────────────────────────── */
  const clock = clockParts(now);
  const dateLine = new Date(now).toLocaleDateString([], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  /* A shift target exists only when the schedule resolved. Without one the
     bar is not drawn at all — an invented 8h target would be a promise the
     record cannot keep. */
  const targetMinutes = Number(live?.schedule?.scheduledMinutes) || null;
  const workedPct = targetMinutes
    ? Math.min(100, Math.round(((workSeconds / 60) / targetMinutes) * 100))
    : null;
  const shiftWindow =
    live?.schedule?.windowLabel ||
    (live?.schedule?.startTime && live?.schedule?.endTime
      ? `${live.schedule.startTime}–${live.schedule.endTime}`
      : null);
  const scheduleName =
    live?.schedule?.shiftName || live?.schedule?.scheduleName || live?.schedule?.name || null;

  /* The session trace: what the record holds, plus the one planned step the
     schedule makes factual (when today's shift ends). Nothing is projected
     beyond that. */
  const steps = [
    ...((live?.timeline || []).map((row) => ({
      key: `ev-${row.seq}`,
      time: fmtTime(row.at),
      label: TIMELINE_LABEL[row.type] || row.type,
      detail:
        row.type === 'CLOCK_IN' && row.workMode
          ? MODE_LABEL[row.workMode] || row.workMode
          : null,
      tag: 'Recorded',
      done: true,
    }))),
    ...(live?.liveState === 'WORKING' && live?.schedule?.scheduledEndAt
      ? [
          {
            key: 'planned-end',
            time: fmtTime(live.schedule.scheduledEndAt),
            label: 'Scheduled shift end',
            detail: 'Where today\'s shift is rostered to end',
            tag: 'Planned',
            done: false,
          },
        ]
      : []),
  ];

  /* Notices the server already derives about this day. They are informational
     — the record itself is not altered by showing them. */
  const notices = [];
  if (live && !live.isToday) {
    notices.push(`Showing your open session from ${live.date} — clock out to start a new day.`);
  }
  if (live?.reconciliation?.leave?.portion && live.reconciliation.leave.portion !== 'NONE') {
    notices.push(
      `On approved ${live.reconciliation.leave.portion === 'FULL_DAY' ? 'leave' : 'half-day leave'}${
        live.reconciliation.leave.label ? ` (${live.reconciliation.leave.label})` : ''
      }.`,
    );
  }
  if (live?.reconciliation?.calendar?.primary === 'HOLIDAY') {
    notices.push(
      `Holiday${live.reconciliation.calendar.holiday?.name ? `: ${live.reconciliation.calendar.holiday.name}` : ''} — a punch today is recorded and flagged.`,
    );
  }
  if (live?.reconciliation?.conflicts?.length) {
    notices.push('This day needs review — the punch overlaps approved leave.');
  }

  const monthTiles = [
    { icon: CheckCircle2, label: 'Present', value: s ? `${s.present}` : '—', sub: s ? `${s.workingDays} expected working days` : 'No summary yet', tone: 'green' },
    { icon: Clock, label: 'Late', value: s ? `${s.late}` : '—', sub: s ? `Of ${s.present} marked days` : 'No summary yet', tone: 'orange' },
    { icon: Coffee, label: 'Half day', value: s ? `${s.halfDay}` : '—', sub: s ? 'Short or split days' : 'No summary yet', tone: 'dim' },
    { icon: X, label: 'Absent', value: s ? `${s.absent}` : '—', sub: s ? 'Working days with no punch' : 'No summary yet', tone: 'red' },
    { icon: Hourglass, label: 'Hours', value: s ? `${s.totalHours}h` : '—', sub: s ? `Across ${data.records.length} record${data.records.length === 1 ? '' : 's'}` : 'No summary yet', tone: 'dim' },
  ];

  /* The month as a file, built from the rows already on screen — there is no
     export endpoint for a personal attendance sheet, and pretending there is
     would leave a button that cannot work. */
  const exportMonthCsv = () => {
    const rows = [...(data.records || [])].reverse();
    if (!rows.length) return;
    const csv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [
        r.date,
        fmtTime(r.regularization?.correctedIn || r.punchIn),
        fmtTime(r.regularization?.correctedOut || r.punchOut),
        r.scheduleSnapshot?.startTime
          ? `${r.scheduleSnapshot.startTime}-${r.scheduleSnapshot.endTime}`
          : '',
        r.workMinutes ? (r.workMinutes / 60).toFixed(1) : '',
        r.status || (r.derived === 'LEAVE' ? 'LEAVE' : ''),
      ]
        .map(csv)
        .join(','),
    );
    const blob = new Blob(
      [['Date,Punch in,Punch out,Scheduled,Worked hours,Status', ...lines].join('\n')],
      { type: 'text/csv;charset=utf-8' },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `my-attendance-${month}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-crewly-border bg-crewly-inset/50 p-4 sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-crewly-inset text-crewly-green">
            <Clock className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold sm:text-2xl">My attendance</h1>
              {live ? (
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${LIVE_STYLE[live.liveState] || LIVE_STYLE.NOT_IN}`}>
                  {LIVE_LABEL[live.liveState] || live.liveState}
                </span>
              ) : null}
              {scheduleName ? (
                <span className="rounded-full bg-crewly-inset px-2.5 py-0.5 text-[11px] font-semibold text-crewly-dim">
                  {scheduleName}
                </span>
              ) : null}
            </div>
            <p className="mt-1 max-w-2xl text-sm text-crewly-dim">
              Your own clock-in station: today's session, the month's record, and the PIN for a
              shared terminal.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link
            to="/app/schedules"
            className="btn-ghost inline-flex items-center justify-center gap-2 whitespace-nowrap px-3 py-2 text-sm"
          >
            <CalendarDays className="h-4 w-4 shrink-0" aria-hidden="true" />Shift calendar
          </Link>
          <Link
            to="/app/attendance/regularizations"
            className="btn-ghost inline-flex items-center justify-center gap-2 whitespace-nowrap px-3 py-2 text-sm"
          >
            <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />Request correction
          </Link>
        </div>
      </div>

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

      {locNote && !error && (
        <div className="rounded-lg border border-crewly-green/40 bg-crewly-green/10 px-4 py-3 text-sm text-crewly-green">
          {locNote}
        </div>
      )}

      {notices.length ? (
        <div className="flex items-start gap-3 rounded-xl border border-crewly-border bg-crewly-inset/40 p-3.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-crewly-orange/12 text-crewly-orange">
            <Info className="h-4 w-4" aria-hidden="true" />
          </span>
          <ul className="min-w-0 space-y-1 text-xs leading-relaxed">
            {notices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── clock and session ──────────────────────────────────────────── */}
      <div className="grid items-start gap-4 xl:grid-cols-12">
        <section className="card xl:col-span-7">
          {loading || !live ? (
            <p className="py-10 text-center text-sm text-crewly-dim">Loading today's attendance…</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${LIVE_STYLE[live.liveState] || LIVE_STYLE.NOT_IN}`}>
                    <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                    {LIVE_LABEL[live.liveState] || live.liveState}
                  </span>
                  <span className="text-xs text-crewly-dim">
                    {live.liveState === 'NOT_IN'
                      ? 'No session open today'
                      : live.liveState === 'COMPLETED'
                        ? `${fmtTime(live.clockInAt)} → ${fmtTime(live.clockOutAt)}`
                        : `Clocked in at ${fmtTime(live.clockInAt)}`}
                    {live.workMode ? ` · ${MODE_LABEL[live.workMode] || live.workMode}` : ''}
                    {shiftWindow ? ` · Shift ${shiftWindow}` : ''}
                  </span>
                </div>
                {live.status ? (
                  <span className={`badge ${STATUS_STYLE[live.status] || ''}`}>{live.status.replace('_', ' ')}</span>
                ) : null}
              </div>

              <div className="mt-4 flex flex-wrap items-baseline gap-2">
                <span className="text-5xl font-black tabular-nums tracking-tight sm:text-6xl">
                  {clock.time}
                </span>
                <span className="text-xl font-bold text-crewly-dim sm:text-2xl">{clock.ampm}</span>
              </div>
              <p className="mt-1 text-xs font-semibold uppercase tracking-[0.1em] text-crewly-dim">
                {dateLine}
              </p>

              {/* progress against the rostered shift — only when there is one, and
                  only once there is a session to measure */}
              {targetMinutes && live.liveState !== 'NOT_IN' ? (
                <div className="mt-5 rounded-xl bg-crewly-inset/60 p-3.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                    <span className="font-semibold">
                      Worked {fmtHM(workSeconds)} of {fmtHM(targetMinutes * 60)}
                    </span>
                    <span className="font-mono font-bold text-crewly-green">
                      {workedPct === null ? '—' : `${workedPct}%`}
                    </span>
                  </div>
                  <span className="mt-2 block h-2 overflow-hidden rounded-full bg-crewly-inset-strong">
                    <span
                      className="block h-full rounded-full bg-crewly-green transition-[width]"
                      style={{ width: `${workedPct || 0}%` }}
                    />
                  </span>
                  <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 text-[11px] text-crewly-dim">
                    <span>Shift target {fmtHM(targetMinutes * 60)}</span>
                    {live.schedule?.scheduledEndAt ? (
                      <span>Shift ends {fmtTime(live.schedule.scheduledEndAt)}</span>
                    ) : null}
                  </div>
                  {live.breakSecondsSoFar > 0 ? (
                    <p className="mt-1 text-[11px] text-crewly-dim">
                      Breaks: {fmtHM(breakSeconds)}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {/* ── actions ── */}
              {live.liveState === 'NOT_IN' ? (
                <div className="mt-4 space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs" htmlFor="work-mode">
                      <span className="mb-1 flex items-center gap-1.5 font-semibold text-crewly-dim">
                        <Briefcase className="h-3.5 w-3.5" aria-hidden="true" />Work mode
                      </span>
                      <select
                        id="work-mode"
                        className="input w-full"
                        value={workMode}
                        onChange={(e) => setWorkMode(e.target.value)}
                        disabled={busy}
                      >
                        {(live.enabledWorkModes || ['OFFICE']).map((mode) => (
                          <option key={mode} value={mode}>{MODE_LABEL[mode] || mode}</option>
                        ))}
                      </select>
                    </label>

                    {needsGeofencePick ? (
                      <label className="block text-xs" htmlFor="attendance-location">
                        <span className="mb-1 flex items-center gap-1.5 font-semibold text-crewly-dim">
                          <MapPin className="h-3.5 w-3.5" aria-hidden="true" />Attendance location
                        </span>
                        {locations.length === 0 ? (
                          <p className="text-xs text-crewly-orange">
                            No active attendance locations — contact your administrator.
                          </p>
                        ) : (
                          <select
                            id="attendance-location"
                            className="input w-full"
                            value={locationId}
                            onChange={(e) => setLocationId(e.target.value)}
                            disabled={busy}
                          >
                            {locations.map((row) => (
                              <option key={row.id} value={row.id}>{row.name}</option>
                            ))}
                          </select>
                        )}
                      </label>
                    ) : null}
                  </div>

                  {needsGeofencePick ? (
                    <p className="text-[11px] text-crewly-dim">
                      Your location is checked once, only for this clock-in — Crewly never tracks you
                      continuously.
                    </p>
                  ) : null}

                  {workMode !== 'OFFICE' &&
                  live.workModeAuthorization &&
                  live.workModeAuthorization[workMode] === false ? (
                    <p className="text-xs text-crewly-red">
                      An approved {MODE_LABEL[workMode] || workMode} request is required for today.
                    </p>
                  ) : null}

                  {can('CLOCK_IN') ? (
                    <button
                      onClick={() => doAction('CLOCK_IN')}
                      disabled={busy}
                      className="btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm disabled:opacity-50"
                    >
                      <LogIn className="h-4 w-4" /> Clock in
                    </button>
                  ) : null}
                </div>
              ) : null}

              {live.liveState === 'WORKING' ? (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {can('CLOCK_OUT') ? (
                    <button
                      onClick={() => doAction('CLOCK_OUT')}
                      disabled={busy}
                      className="btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm disabled:opacity-50"
                    >
                      <LogOut className="h-4 w-4" /> Clock out
                    </button>
                  ) : null}
                  {can('BREAK_START') ? (
                    <button
                      onClick={() => doAction('BREAK_START')}
                      disabled={busy}
                      className="btn-ghost inline-flex items-center gap-2 px-4 py-2.5 text-sm disabled:opacity-50"
                    >
                      <Coffee className="h-4 w-4" /> Start lunch break
                    </button>
                  ) : null}
                </div>
              ) : null}

              {live.liveState === 'ON_BREAK' ? (
                <div className="mt-4 space-y-2">
                  <p className="text-xs text-crewly-dim">
                    On break since {fmtTime(live.openInterval?.startedAt)} · {fmtHM(breakSeconds)} so far
                  </p>
                  {can('BREAK_END') ? (
                    <button
                      onClick={() => doAction('BREAK_END')}
                      disabled={busy}
                      className="btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm disabled:opacity-50"
                    >
                      <Play className="h-4 w-4" /> End break
                    </button>
                  ) : null}
                </div>
              ) : null}

              {live.liveState === 'COMPLETED' ? (
                <p className="mt-4 flex flex-wrap items-center gap-x-2 text-xs text-crewly-dim">
                  <CheckCircle2 className="h-4 w-4 text-crewly-green" aria-hidden="true" />
                  Done for {live.date === live.today ? 'today' : live.date}:{' '}
                  <span className="font-semibold text-crewly-text">
                    {live.workedMinutes ? `${(live.workedMinutes / 60).toFixed(1)}h worked` : '—'}
                  </span>
                  {live.breakMinutes > 0 ? <span>· Breaks {live.breakMinutes}m</span> : null}
                </p>
              ) : null}

              {live.otherOpenSession ? (
                <div className="mt-3 rounded-lg border border-crewly-orange/40 bg-crewly-orange/10 px-3 py-2.5 text-xs">
                  <p className="text-crewly-orange">
                    You also have an open session from {live.otherOpenSession.date}.
                  </p>
                  <button
                    onClick={() => doAction('CLOCK_OUT', { date: live.otherOpenSession.date })}
                    disabled={busy}
                    className="btn-ghost mt-2 px-3 py-1.5 text-xs"
                  >
                    Clock out {live.otherOpenSession.date}
                  </button>
                </div>
              ) : null}

              <p className="mt-4 border-t border-crewly-border pt-3 text-[11px] text-crewly-dim">
                Forgot to punch?{' '}
                <Link className="font-semibold text-crewly-green underline" to="/app/attendance/regularizations">
                  Request a correction
                </Link>{' '}
                — it is applied to the record once approved.
              </p>
            </>
          )}
        </section>

        <section className="card flex flex-col xl:col-span-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="card-title flex items-center gap-2 text-sm font-bold">
                <Route className="h-4 w-4 text-crewly-dim" aria-hidden="true" />
                Today's session sequence
              </h2>
              <p className="mt-0.5 text-[11px] text-crewly-dim">
                Every punch this record holds, in order.
              </p>
            </div>
            <span className="rounded-full bg-crewly-inset px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-crewly-dim">
              {live?.timeline?.length ? `${live.timeline.length} events` : 'No events'}
            </span>
          </div>

          {steps.length ? (
            <ol className="mt-4">
              {steps.map((step, index) => (
                <li key={step.key} className="relative flex gap-3 pb-4 last:pb-0">
                  {index < steps.length - 1 ? (
                    <span className="absolute left-[7px] top-5 h-full w-px bg-crewly-border" aria-hidden="true" />
                  ) : null}
                  <span
                    className={`relative z-10 mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                      step.done
                        ? 'border-crewly-green bg-crewly-green/15 text-crewly-green'
                        : 'border-crewly-border bg-crewly-inset text-crewly-dim'
                    }`}
                  >
                    {step.done ? (
                      <Check className="h-2.5 w-2.5" aria-hidden="true" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                      <p className="text-xs font-semibold">
                        {step.time} — {step.label}
                      </p>
                      <span
                        className={`text-[10px] font-bold uppercase tracking-wide ${
                          step.done ? 'text-crewly-green' : 'text-crewly-dim'
                        }`}
                      >
                        {step.tag}
                      </span>
                    </div>
                    {step.detail ? (
                      <p className="text-[11px] text-crewly-dim">{step.detail}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-4 rounded-lg border border-dashed border-crewly-border px-3 py-6 text-center text-xs text-crewly-dim">
              Nothing punched yet today.
            </p>
          )}

          <div className="mt-auto pt-4">
            <div className="rounded-lg bg-crewly-inset/60 p-3">
              <p className="text-[11px] font-semibold">
                {live?.locationEnforcement === 'REQUIRED'
                  ? 'Location required at clock-in'
                  : live?.locationEnforcement === 'OPTIONAL'
                    ? 'Location verified when available'
                    : 'No location check on this policy'}
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-crewly-dim">
                Your position is read once, when you press Clock in — never in the background.
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* ── the month, counted ─────────────────────────────────────────── */}
      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="card-title flex items-center gap-2 px-1 text-sm font-bold">
            <TrendingUp className="h-4 w-4 text-crewly-dim" aria-hidden="true" />
            {monthLabel(month)} in numbers
          </h2>
          <span className="px-1 text-[11px] text-crewly-dim">
            {s ? `${s.workingDays} expected working days` : 'Summary unavailable'}
          </span>
        </div>
        <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-px overflow-hidden rounded-xl border border-crewly-border bg-crewly-border sm:grid-cols-3 xl:grid-cols-5">
          {monthTiles.map((tile, index) => (
            <Tile
              key={tile.label}
              {...tile}
              className={index === monthTiles.length - 1 ? 'col-span-2 sm:col-span-1' : ''}
            />
          ))}
        </div>
      </div>

      {/* ── history and the terminal PIN ───────────────────────────────── */}
      <div className="grid items-start gap-4 lg:grid-cols-12">
        <section className="card overflow-hidden p-0 lg:col-span-8">
          <div className="flex flex-col gap-3 border-b border-crewly-border bg-crewly-inset/40 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-crewly-accent/15 text-crewly-orange">
                <CalendarDays className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <h2 className="card-title flex items-center gap-2 text-sm font-bold">Attendance history</h2>
                <p className="text-[11px] text-crewly-dim">Daily records and the shift each one was judged against.</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="month"
                className="input w-full sm:w-40"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                aria-label="Month"
              />
              <button
                type="button"
                onClick={exportMonthCsv}
                disabled={!data.records.length}
                className="btn-ghost inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 py-2 text-xs disabled:opacity-50"
                title={`Download ${monthLabel(month)} as CSV`}
                aria-label={`Download ${monthLabel(month)} as CSV`}
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                CSV
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[660px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-crewly-border text-[10px] uppercase tracking-[0.1em] text-crewly-dim">
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Date</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Punch in</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Punch out</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Scheduled</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Hours</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-semibold">Status</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right font-semibold">Action</th>
                </tr>
              </thead>
            <tbody>
              {[...data.records].reverse().map((r) => (
                <tr key={r._id} className="border-b border-crewly-border/50 last:border-0">
                  <td className="whitespace-nowrap px-3 py-2.5">{new Date(`${r.date}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', weekday: 'short' })}</td>
                  {/* Phase 31.5 — effective times win for display; the
                      recorded punch stays one hover away. */}
                  <td className="whitespace-nowrap px-3 py-2.5">
                    {fmtTime(r.regularization?.correctedIn || r.punchIn)}
                    {r.regularization?.correctedIn && (
                      <span className="ml-1 text-crewly-green" title={`Recorded: ${fmtTime(r.punchIn)}`}>*</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    {fmtTime(r.regularization?.correctedOut || r.punchOut)}
                    {r.regularization?.correctedOut && (
                      <span className="ml-1 text-crewly-green" title={`Recorded: ${fmtTime(r.punchOut)}`}>*</span>
                    )}
                  </td>
                  {/* Phase 31.6 — the versioned schedule behind the
                      verdict; legacy rows predate snapshots. */}
                  <td className="whitespace-nowrap px-3 py-2.5 text-crewly-dim" title={r.scheduleSnapshot ? (r.scheduleSnapshot.shiftName || r.scheduleSnapshot.scheduleName || '') : ''}>
                    {r.scheduleSnapshot?.startTime
                      ? `${r.scheduleSnapshot.startTime}–${r.scheduleSnapshot.endTime}${r.scheduleSnapshot.crossesMidnight ? ' +1' : ''}`
                      : '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">{r.workMinutes ? `${(r.workMinutes / 60).toFixed(1)}h` : '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    {r.status ? (
                      <span className={`badge ${STATUS_STYLE[r.status]}`}>{r.status.replace('_', ' ')}</span>
                    ) : r.derived === 'LEAVE' ? (
                      <span className="badge bg-crewly-inset-strong text-crewly-dim" title={r.reconciliation?.leave?.label || ''}>Leave</span>
                    ) : null}
                    {r.regularized && (
                      <span className="badge ml-1 bg-crewly-green/15 text-crewly-green" title="An approved correction overlays this day">Regularized</span>
                    )}
                    {/* Phase 31.7 — derived dimensions stay separate badges. */}
                    {r.reconciliation?.conflicts?.length > 0 && (
                      <span className="badge ml-1 bg-crewly-red/15 text-crewly-red" title={r.reconciliation.conflicts.join(', ')}>Needs review</span>
                    )}
                    {r.status && r.reconciliation?.leave?.portion === 'FULL_DAY' && (
                      <span className="badge ml-1 bg-crewly-inset-strong text-crewly-dim" title={r.reconciliation.leave.label || ''}>Leave</span>
                    )}
                    {r.reconciliation?.halves && (
                      <span
                        className="badge ml-1 bg-crewly-inset-strong text-crewly-dim"
                        title={`First half: ${r.reconciliation.halves.first}, second half: ${r.reconciliation.halves.second}`}
                      >
                        1st {r.reconciliation.halves.first} · 2nd {r.reconciliation.halves.second}
                      </span>
                    )}
                    {r.reconciliation?.nonWorkingDayWorked && r.reconciliation.calendar?.primary === 'HOLIDAY' && (
                      <span className="badge ml-1 bg-crewly-orange/15 text-crewly-orange" title={r.reconciliation.calendar.holiday?.name || ''}>Worked on holiday</span>
                    )}
                    {r.reconciliation?.nonWorkingDayWorked && r.reconciliation.calendar?.primary === 'WEEKLY_OFF' && (
                      <span className="badge ml-1 bg-crewly-orange/15 text-crewly-orange">Worked on weekly off</span>
                    )}
                    {/* Phase 31.8 — OT / comp-off state, additive. */}
                    {otChipFor(r.date)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {r.derived === 'LEAVE' ? (
                      <span className="text-xs text-crewly-dim">{r.reconciliation?.leave?.label || 'Leave'}</span>
                    ) : (
                      <>
                        <Link
                          className="inline-flex items-center rounded-lg border border-crewly-border px-2 py-1 text-[11px] font-semibold text-crewly-text transition hover:bg-crewly-inset"
                          title="Request a correction for this day"
                          to={`/app/attendance/regularizations?date=${r.date}`}
                        >
                          Correct
                        </Link>
                        {/* Phase 31.8 — deep link into the OT request form. */}
                        {otDays[r.date]?.requestable && (
                          <Link className="ml-2 text-xs text-crewly-green underline" to={`/app/attendance/overtime?date=${r.date}`}>
                            {otDays[r.date]?.type === 'COMP_OFF' ? 'Request comp-off' : 'Request OT'}
                          </Link>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {data.records.length === 0 && (
                <tr><td colSpan={7} className="px-5 py-8 text-center text-crewly-dim">No records this month.</td></tr>
              )}
            </tbody>
            </table>
          </div>

          <div className="border-t border-crewly-border px-3 py-2.5 text-[11px] text-crewly-dim">
            {data.records.length
              ? `${data.records.length} record${data.records.length === 1 ? '' : 's'} in ${monthLabel(month)}`
              : `No records in ${monthLabel(month)}`}
          </div>
        </section>

        <div className="space-y-4 lg:col-span-4">
          <KioskPinCard />

          <section className="card">
            <h2 className="card-title flex items-center gap-2 text-sm font-bold">
              <Info className="h-4 w-4 text-crewly-dim" aria-hidden="true" />
              What a punch records
            </h2>
            <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-crewly-dim">
              <li>· The time, the work mode you chose, and the shift that was in force that day.</li>
              <li>· A location verdict only when your policy asks for one.</li>
              <li>· Corrections are applied on top of the punch, and the original stays visible.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

export default AttendancePage;
