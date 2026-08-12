import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import api from '../../services/api';
import {
  listMeetings, getMeetingHistory, createMeeting, updateMeeting, cancelMeeting, deleteMeeting,
} from '../../services/meetingService.js';
import { arr } from '../../services/workService.js';

const CREATE_ROLES = ['COMPANY_ADMIN', 'MANAGER', 'TEAM_LEAD'];
const DAY_MS = 86400000;

const TYPE_META = {
  COMPANY: { label: 'Company', cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  DEPARTMENT: { label: 'Department', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  TEAM: { label: 'Team', cls: 'bg-green-500/15 text-green-300 border-green-500/30' },
  PRIVATE: { label: 'Private', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
};
const RECUR_LABEL = { NONE: '', DAILY: '🔁 Daily', WEEKLY: '🔁 Weekly', MONTHLY: '🔁 Monthly' };

const inp = 'w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-indigo-400';
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();
const fmtHM = (d) => new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
const fmtDM = (d) => new Date(d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const toInputDate = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const toInputTime = (d) => { const x = new Date(d); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };
const mondayOf = (d) => { const off = (d.getDay() + 6) % 7; return startOfDay(new Date(d.getTime() - off * DAY_MS)); };

const monthCells = (cursor) => {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = mondayOf(first);
  return Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * DAY_MS));
};

const rangeFor = (view, cursor) => {
  if (view === 'month') { const c = monthCells(cursor); return [c[0], new Date(c[41].getTime() + DAY_MS)]; }
  if (view === 'week') { const s = mondayOf(cursor); return [s, new Date(s.getTime() + 7 * DAY_MS)]; }
  if (view === 'day') { const s = startOfDay(cursor); return [s, new Date(s.getTime() + DAY_MS)]; }
  return [startOfDay(new Date()), new Date(Date.now() + 30 * DAY_MS)]; // agenda
};

function Chip({ m, onClick, dense }) {
  const tm = TYPE_META[m.type] || TYPE_META.PRIVATE;
  const cancelled = m.status === 'CANCELLED';
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(m); }}
      className={`w-full truncate rounded-md border px-1.5 py-0.5 text-left text-xs font-semibold ${tm.cls} ${cancelled ? 'opacity-40 line-through' : ''}`}
      title={m.title}
    >
      {!dense && `${fmtHM(m.occStart || m.startAt)} · `}{m.title}{m.recurrence !== 'NONE' ? ' 🔁' : ''}
    </button>
  );
}

function MeetingFormModal({ initial, me, role, onClose, onSaved }) {
  const isEdit = Boolean(initial?._id);
  const [users, setUsers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [form, setForm] = useState(() => {
    const s = initial?.occStart || initial?.startAt || Date.now();
    const e = initial?.occEnd || initial?.endAt || Date.now() + 3600000;
    return {
      title: initial?.title || '',
      description: initial?.description || '',
      type: initial?.type || 'TEAM',
      date: toInputDate(s),
      start: toInputTime(s),
      end: toInputTime(e),
      link: initial?.link || '',
      recurrence: initial?.recurrence || 'NONE',
      recurrenceEnd: initial?.recurrenceEnd ? toInputDate(initial.recurrenceEnd) : '',
      reminderMinutes: initial?.reminderMinutes ?? 15,
      departmentId: String(initial?.department || ''),
    };
  });
  const [participants, setParticipants] = useState(() => (initial?.participants || []).map((p) => String(p._id || p)));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try { setUsers(arr(await api.get('/users'))); } catch (e) { /* soft */ }
      if (role === 'COMPANY_ADMIN') {
        try { setDepartments(arr(await api.get('/departments'))); } catch (e) { /* soft */ }
      }
    })();
  }, [role]);

  const set = (k) => (ev) => setForm((f) => ({ ...f, [k]: ev.target.value }));
  const toggle = (id) => setParticipants((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const submit = async () => {
    setErr('');
    if (!form.title.trim()) return setErr('Title is required');
    const startAt = new Date(`${form.date}T${form.start}:00`);
    const endAt = new Date(`${form.date}T${form.end}:00`);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) return setErr('Pick date & times');
    if (endAt <= startAt) return setErr('End time must be after start time');

    const payload = {
      title: form.title.trim(),
      description: form.description,
      type: form.type,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      link: form.link,
      recurrence: form.recurrence,
      recurrenceEnd: form.recurrence !== 'NONE' && form.recurrenceEnd ? new Date(`${form.recurrenceEnd}T23:59:59`).toISOString() : null,
      reminderMinutes: Number(form.reminderMinutes) || 15,
      participantIds: participants,
      ...(role === 'COMPANY_ADMIN' && form.type === 'DEPARTMENT' ? { departmentId: form.departmentId || undefined } : {}),
    };

    setBusy(true);
    try {
      if (isEdit) await updateMeeting(initial._id, payload);
      else await createMeeting(payload);
      onSaved?.();
      onClose();
    } catch (e2) {
      setErr(e2?.response?.data?.message || 'Could not save meeting');
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-800 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-700 px-6 py-4">
          <h2 className="text-lg font-bold text-slate-100">{isEdit ? '✏️ Edit Meeting' : '📅 Create Meeting'}</h2>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-700 hover:text-slate-200">✖</button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
          {err && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{err}</div>}

          <input className={inp} placeholder="Meeting title *" value={form.title} onChange={set('title')} />
          <textarea className={inp} rows={2} placeholder="Agenda / description" value={form.description} onChange={set('description')} />

          <div className="grid grid-cols-2 gap-3">
            <select className={inp} value={form.type} onChange={set('type')}>
              <option value="TEAM">👥 Team meeting</option>
              <option value="DEPARTMENT">🏢 Department meeting</option>
              <option value="PRIVATE">🔒 Private meeting</option>
              {role === 'COMPANY_ADMIN' && <option value="COMPANY">📢 Company-wide</option>}
            </select>
            <input className={inp} placeholder="Meeting link (Zoom/Meet…)" value={form.link} onChange={set('link')} />
          </div>

          {form.type === 'DEPARTMENT' && role === 'COMPANY_ADMIN' && (
            <select className={inp} value={form.departmentId} onChange={set('departmentId')}>
              <option value="">— Department —</option>
              {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
            </select>
          )}
          {form.type === 'TEAM' && (
            <p className="rounded-lg bg-green-500/10 px-3 py-1.5 text-xs text-green-300">👥 Your whole team is added automatically — just add any extras below.</p>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="mb-1 text-xs font-semibold text-slate-400">Date</p>
              <input type="date" className={inp} value={form.date} onChange={set('date')} />
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold text-slate-400">Start</p>
              <input type="time" className={inp} value={form.start} onChange={set('start')} />
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold text-slate-400">End</p>
              <input type="time" className={inp} value={form.end} onChange={set('end')} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="mb-1 text-xs font-semibold text-slate-400">Repeats</p>
              <select className={inp} value={form.recurrence} onChange={set('recurrence')}>
                <option value="NONE">Once</option>
                <option value="DAILY">Daily</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </div>
            {form.recurrence !== 'NONE' && (
              <div>
                <p className="mb-1 text-xs font-semibold text-slate-400">Repeat until</p>
                <input type="date" className={inp} value={form.recurrenceEnd} onChange={set('recurrenceEnd')} />
              </div>
            )}
            <div>
              <p className="mb-1 text-xs font-semibold text-slate-400">Remind (min before)</p>
              <input type="number" min="0" className={inp} value={form.reminderMinutes} onChange={set('reminderMinutes')} />
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-slate-400">Participants ({participants.length})</p>
            <div className="max-h-36 overflow-y-auto rounded-xl border border-slate-700">
              {users.map((u) => (
                <label key={u._id} className="flex cursor-pointer items-center gap-2 border-b border-slate-700/50 px-3 py-1.5 text-sm last:border-0 hover:bg-slate-700/40">
                  <input type="checkbox" checked={participants.includes(u._id)} onChange={() => toggle(u._id)} />
                  <span className="text-slate-200">{u.name}{u._id === me ? ' (me)' : ''} <span className="text-xs text-slate-400">{u.designation || u.role}</span></span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-700 px-6 py-3">
          <button onClick={onClose} className="rounded-lg px-4 py-1.5 text-sm font-semibold text-slate-300 hover:bg-slate-700">Cancel</button>
          <button disabled={busy} onClick={submit} className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create meeting'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MeetingsPage() {
  const user = useSelector((s) => s.auth.user);
  const role = user?.role;
  const me = String(user?._id || '');
  const canCreate = CREATE_ROLES.includes(role);

  const [view, setView] = useState('month'); // month | week | day | agenda | history
  const [cursor, setCursor] = useState(new Date());
  const [meetings, setMeetings] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (view === 'history') {
        setHistory(arr(await getMeetingHistory()));
      } else {
        const [from, to] = rangeFor(view, cursor);
        setMeetings(arr(await listMeetings({ from: from.toISOString(), to: to.toISOString() })));
      }
    } catch (e) {
      setMsg('❌ Could not load meetings');
    }
    setLoading(false);
  }, [view, cursor]);

  useEffect(() => { load(); }, [load]);

  const onDay = useCallback((d) => meetings.filter((m) => sameDay(m.occStart || m.startAt, d)), [meetings]);

  const shift = (dir) => {
    const d = new Date(cursor);
    if (view === 'month') d.setMonth(d.getMonth() + dir);
    else if (view === 'week') d.setDate(d.getDate() + dir * 7);
    else d.setDate(d.getDate() + dir);
    setCursor(d);
  };

  const doCancel = async (m) => {
    const reason = window.prompt('Cancel this meeting? Reason (optional):', '');
    if (reason === null) return;
    try {
      await cancelMeeting(m._id, reason);
      setSelected(null);
      load();
    } catch (e) {
      alert(e?.response?.data?.message || 'Cancel failed');
    }
  };

  const doDelete = async (m) => {
    if (!window.confirm('Delete this meeting permanently?')) return;
    try {
      await deleteMeeting(m._id);
      setSelected(null);
      load();
    } catch (e) {
      alert(e?.response?.data?.message || 'Delete failed');
    }
  };

  const weekDays = useMemo(() => {
    const s = mondayOf(cursor);
    return Array.from({ length: 7 }, (_, i) => new Date(s.getTime() + i * DAY_MS));
  }, [cursor]);

  const selManageable = selected && (role === 'COMPANY_ADMIN' || String(selected.createdBy?._id || selected.createdBy) === me);

  const headLabel = view === 'month'
    ? cursor.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    : view === 'week'
      ? `${fmtDM(weekDays[0])} → ${fmtDM(weekDays[6])}`
      : fmtDM(cursor);

  const tabBtn = (v, label) => (
    <button
      key={v}
      onClick={() => setView(v)}
      className={`rounded-full px-3 py-1 text-sm font-semibold capitalize ${view === v ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">📅 Meetings</h1>
          <p className="text-sm text-slate-400">You only see meetings meant for you. 🛡️</p>
        </div>
        {canCreate && (
          <button onClick={() => { setEditTarget(null); setShowForm(true); }} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">
            ＋ New Meeting
          </button>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {tabBtn('month', '🗓 Month')}
        {tabBtn('week', '📆 Week')}
        {tabBtn('day', '📌 Day')}
        {tabBtn('agenda', '📋 Agenda')}
        {tabBtn('history', '🕰 History')}
        {['month', 'week', 'day'].includes(view) && (
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => shift(-1)} className="rounded-lg bg-slate-800 px-3 py-1 text-sm text-slate-300 hover:bg-slate-700">←</button>
            <button onClick={() => setCursor(new Date())} className="rounded-lg bg-slate-800 px-3 py-1 text-sm font-semibold text-slate-300 hover:bg-slate-700">Today</button>
            <span className="min-w-[140px] text-center text-sm font-bold text-slate-200">{headLabel}</span>
            <button onClick={() => shift(1)} className="rounded-lg bg-slate-800 px-3 py-1 text-sm text-slate-300 hover:bg-slate-700">→</button>
          </div>
        )}
      </div>

      {msg && <div className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{msg}</div>}
      {loading && <p className="text-sm text-slate-500">Loading meetings…</p>}

      {/* ── MONTH ── */}
      {!loading && view === 'month' && (
        <div className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-800">
          <div className="grid grid-cols-7 border-b border-slate-700 bg-slate-900/50 text-center text-xs font-bold uppercase text-slate-400">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="py-2">{d}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {monthCells(cursor).map((d, i) => {
              const dayM = onDay(d);
              const inMonth = d.getMonth() === cursor.getMonth();
              const isToday = sameDay(d, new Date());
              return (
                <div
                  key={i}
                  onClick={() => { setCursor(d); setView('day'); }}
                  className={`min-h-[96px] cursor-pointer border-b border-r border-slate-700/50 p-1.5 hover:bg-slate-700/20 ${inMonth ? '' : 'opacity-40'}`}
                >
                  <p className={`mb-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${isToday ? 'bg-indigo-600 text-white' : 'text-slate-300'}`}>
                    {d.getDate()}
                  </p>
                  <div className="space-y-1">
                    {dayM.slice(0, 2).map((m, j) => <Chip key={`${m._id}-${j}`} m={m} dense onClick={setSelected} />)}
                    {dayM.length > 2 && <p className="px-1 text-xs text-slate-500">+{dayM.length - 2} more</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── WEEK ── */}
      {!loading && view === 'week' && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-7">
          {weekDays.map((d, i) => {
            const dayM = onDay(d);
            const isToday = sameDay(d, new Date());
            return (
              <div key={i} className={`min-h-[160px] rounded-2xl border p-2 ${isToday ? 'border-indigo-500 bg-slate-800' : 'border-slate-700 bg-slate-800/60'}`}>
                <p className="mb-2 text-center text-xs font-bold text-slate-300">
                  {d.toLocaleDateString('en-IN', { weekday: 'short' })}
                  <span className={`ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full ${isToday ? 'bg-indigo-600 text-white' : 'text-slate-400'}`}>{d.getDate()}</span>
                </p>
                <div className="space-y-1">
                  {dayM.map((m, j) => <Chip key={`${m._id}-${j}`} m={m} onClick={setSelected} />)}
                  {dayM.length === 0 && <p className="pt-4 text-center text-xs text-slate-600">—</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── DAY ── */}
      {!loading && view === 'day' && (
        <div className="rounded-2xl border border-slate-700 bg-slate-800 p-4">
          <p className="mb-3 text-sm font-bold text-slate-200">{fmtDM(cursor)} · {onDay(cursor).length} meeting(s)</p>
          <div className="space-y-2">
            {onDay(cursor).map((m, j) => {
              const tm = TYPE_META[m.type] || TYPE_META.PRIVATE;
              return (
                <button
                  key={`${m._id}-${j}`}
                  onClick={() => setSelected(m)}
                  className="flex w-full items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/40 px-4 py-3 text-left hover:border-slate-600"
                >
                  <span className="w-24 shrink-0 text-sm font-bold text-slate-200">{fmtHM(m.occStart)}<span className="block text-xs font-normal text-slate-400">→ {fmtHM(m.occEnd)}</span></span>
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${tm.cls}`}>{tm.label}</span>
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-slate-100">{m.title} {m.recurrence !== 'NONE' && '🔁'}</span>
                    <span className="block text-xs text-slate-400">👥 {m.participants?.length || 0} · by {m.createdBy?.name || '—'}</span>
                  </span>
                </button>
              );
            })}
            {onDay(cursor).length === 0 && <p className="py-6 text-center text-sm text-slate-500">No meetings this day. 🌴</p>}
          </div>
        </div>
      )}

      {/* ── AGENDA / HISTORY shared list ── */}
      {!loading && ['agenda', 'history'].includes(view) && (
        <div className="space-y-2">
          {(view === 'agenda' ? meetings : history).map((m, j) => {
            const tm = TYPE_META[m.type] || TYPE_META.PRIVATE;
            const cancelled = m.status === 'CANCELLED';
            const start = m.occStart || m.startAt;
            const end = m.occEnd || m.endAt;
            return (
              <button
                key={`${m._id}-${j}`}
                onClick={() => setSelected(m)}
                className={`flex w-full items-center gap-3 rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-left hover:border-slate-600 ${cancelled ? 'opacity-50' : ''}`}
              >
                <span className="w-28 shrink-0 text-xs font-bold text-slate-300">{fmtDM(start)}<span className="block font-normal text-slate-400">{fmtHM(start)} → {fmtHM(end)}</span></span>
                <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${tm.cls}`}>{tm.label}</span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate font-semibold text-slate-100 ${cancelled ? 'line-through' : ''}`}>{m.title} {m.recurrence !== 'NONE' && `· ${RECUR_LABEL[m.recurrence]}`}</span>
                  <span className="block text-xs text-slate-400">👥 {m.participants?.length || 0} participants · by {m.createdBy?.name || '—'}{cancelled ? ` · ❌ cancelled${m.cancelReason ? `: ${m.cancelReason}` : ''}` : ''}</span>
                </span>
                {m.link && <span className="shrink-0 rounded-lg bg-indigo-500/15 px-2 py-1 text-xs font-semibold text-indigo-300">🔗 Link</span>}
              </button>
            );
          })}
          {(view === 'agenda' ? meetings : history).length === 0 && (
            <div className="rounded-2xl border border-dashed border-slate-700 p-10 text-center text-slate-400">
              <p className="text-3xl">{view === 'agenda' ? '🌴' : '🕰'}</p>
              <p className="mt-2 text-sm">{view === 'agenda' ? 'Nothing upcoming in the next 30 days.' : 'No past or cancelled meetings yet.'}</p>
            </div>
          )}
        </div>
      )}

      {/* ── DETAIL MODAL ── */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setSelected(null)}>
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-800 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 border-b border-slate-700 px-6 py-4">
              <div className="min-w-0">
                <h2 className={`truncate text-lg font-bold text-slate-100 ${selected.status === 'CANCELLED' ? 'line-through opacity-60' : ''}`}>{selected.title}</h2>
                <div className="mt-1 flex flex-wrap gap-2 text-xs">
                  <span className={`rounded-full border px-2 py-0.5 font-semibold ${(TYPE_META[selected.type] || TYPE_META.PRIVATE).cls}`}>{(TYPE_META[selected.type] || TYPE_META.PRIVATE).label}</span>
                  {selected.recurrence !== 'NONE' && <span className="rounded-full bg-slate-700 px-2 py-0.5 font-semibold text-slate-300">{RECUR_LABEL[selected.recurrence]}</span>}
                  {selected.status === 'CANCELLED' && <span className="rounded-full bg-red-500/15 px-2 py-0.5 font-semibold text-red-300">❌ Cancelled</span>}
                </div>
              </div>
              <button onClick={() => setSelected(null)} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-700 hover:text-slate-200">✖</button>
            </div>

            <div className="space-y-3 px-6 py-4 text-sm">
              <p className="text-slate-300">🕐 {fmtDM(selected.occStart || selected.startAt)} · {fmtHM(selected.occStart || selected.startAt)} → {fmtHM(selected.occEnd || selected.endAt)}</p>
              <p className="text-slate-400">👤 Organizer: <b className="text-slate-200">{selected.createdBy?.name || '—'}</b></p>
              {selected.description && <p className="whitespace-pre-wrap text-slate-300">{selected.description}</p>}
              {selected.cancelReason && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">Cancel reason: {selected.cancelReason}</p>}

              {selected.link && (
                <a href={selected.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">
                  🔗 Join Meeting
                </a>
              )}

              <div>
                <p className="mb-1 text-xs font-semibold uppercase text-slate-400">Participants ({selected.participants?.length || 0})</p>
                <div className="flex flex-wrap gap-1">
                  {(selected.participants || []).map((p) => (
                    <span key={p._id || p} className="rounded-full bg-slate-700 px-2 py-1 text-xs text-slate-200">
                      {p.avatarUrl ? <img src={p.avatarUrl} alt="" className="mr-1 inline h-4 w-4 rounded-full object-cover" /> : null}
                      {p.name || 'User'}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {selManageable && selected.status !== 'CANCELLED' && (
              <div className="flex justify-end gap-2 border-t border-slate-700 px-6 py-3">
                <button onClick={() => doDelete(selected)} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-red-400 hover:bg-red-500/10">🗑 Delete</button>
                <button onClick={() => doCancel(selected)} className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm font-semibold text-slate-200 hover:bg-slate-600">❌ Cancel meeting</button>
                <button onClick={() => { setEditTarget(selected); setShowForm(true); setSelected(null); }} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500">✏️ Edit</button>
              </div>
            )}
          </div>
        </div>
      )}

      {showForm && (
        <MeetingFormModal
          initial={editTarget}
          me={me}
          role={role}
          onClose={() => { setShowForm(false); setEditTarget(null); }}
          onSaved={load}
        />
      )}
    </div>
  );
}