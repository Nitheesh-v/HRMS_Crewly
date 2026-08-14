// ============================================================
// 🧬 Employee Lifecycle (Phase 15)
// HR: stage console + promote/transfer · Employee: journey + timeline
// ============================================================
import React, { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  getMyJourney, getCompanyLifecycles, getUserJourney,
  setStage, promoteUser, transferUser, getDepartments,
} from '../../services/lifecycleService.js';

const inp = 'w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500';
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

const STAGE_META = {
  PRE_JOINING: { label: 'Pre-joining', emoji: '📨', cls: 'bg-sky-400/15 text-sky-300' },
  ONBOARDING: { label: 'Onboarding', emoji: '🧳', cls: 'bg-indigo-400/15 text-indigo-300' },
  PROBATION: { label: 'Probation', emoji: '⏳', cls: 'bg-amber-400/15 text-amber-300' },
  CONFIRMED: { label: 'Confirmed', emoji: '✅', cls: 'bg-emerald-400/15 text-emerald-300' },
  NOTICE_PERIOD: { label: 'Notice period', emoji: '📄', cls: 'bg-orange-400/15 text-orange-300' },
  EXITED: { label: 'Exited', emoji: '🚪', cls: 'bg-red-400/15 text-red-300' },
  ALUMNI: { label: 'Alumni', emoji: '🎓', cls: 'bg-purple-400/15 text-purple-300' },
};
const STEPPER = ['ONBOARDING', 'PROBATION', 'CONFIRMED', 'NOTICE_PERIOD', 'EXITED', 'ALUMNI'];
const EVENT_EMOJI = { PROMOTED: '🚀', TRANSFERRED: '🔄', JOINED: '🤝', CONFIRMED: '🎉' };

const StageBadge = ({ stage }) => {
  const m = STAGE_META[stage] || STAGE_META.CONFIRMED;
  return <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${m.cls}`}>{m.emoji} {m.label}</span>;
};

const Stepper = ({ stage }) => {
  const idx = STEPPER.indexOf(stage);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {STEPPER.map((s, i) => {
        const m = STAGE_META[s];
        const done = idx >= 0 && i < idx;
        const current = i === idx;
        return (
          <React.Fragment key={s}>
            {i > 0 && <span className={`h-px w-4 ${done || current ? 'bg-indigo-400' : 'bg-slate-600'}`} />}
            <span
              title={m.label}
              className={`flex h-9 w-9 items-center justify-center rounded-full border text-base ${
                current ? 'border-indigo-400 bg-indigo-500/20 ring-2 ring-indigo-400/50'
                : done ? 'border-emerald-400/50 bg-emerald-500/10' : 'border-slate-600 bg-slate-800/60 opacity-50'
              }`}
            >
              {done ? '✓' : m.emoji}
            </span>
          </React.Fragment>
        );
      })}
      <span className="ml-2 text-sm font-bold text-slate-200">{STAGE_META[stage]?.label || stage}</span>
    </div>
  );
};

const Timeline = ({ events = [] }) => (
  <div className="space-y-0">
    {[...events].sort((a, b) => new Date(b.at) - new Date(a.at)).map((e) => (
      <div key={e._id} className="relative border-l-2 border-slate-700 pb-4 pl-5">
        <span className="absolute -left-[9px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-slate-700 text-[10px]" />
        <p className="text-sm font-semibold text-slate-100">{EVENT_EMOJI[e.type] ? `${EVENT_EMOJI[e.type]} ` : ''}{e.title}</p>
        {e.note ? <p className="text-xs text-slate-400">"{e.note}"</p> : null}
        <p className="text-[11px] text-slate-500">{fmtDate(e.at)}{e.by?.name ? ` · by ${e.by.name}` : ''}</p>
      </div>
    ))}
  </div>
);

const JourneyCard = ({ journey, actionsSlot }) => {
  if (!journey) return null;
  const u = journey.user || {};
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-lg font-bold text-slate-100">{u.name || 'My journey'}</p>
            <p className="text-xs text-slate-400">{u.designation || u.role} · joined {fmtDate(journey.joinedOn)}</p>
          </div>
          <StageBadge stage={journey.stage} />
        </div>
        <Stepper stage={journey.stage} />
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-400 sm:grid-cols-3">
          {journey.probationEndsOn && <p>⏳ Probation ends: <span className="text-slate-200">{fmtDate(journey.probationEndsOn)}</span></p>}
          {journey.confirmedOn && <p>✅ Confirmed: <span className="text-slate-200">{fmtDate(journey.confirmedOn)}</span></p>}
          {journey.noticeEndsOn && <p>📄 Notice ends: <span className="text-slate-200">{fmtDate(journey.noticeEndsOn)}</span></p>}
          {journey.exitedOn && <p>🚪 Exited: <span className="text-slate-200">{fmtDate(journey.exitedOn)}</span></p>}
          {journey.alumniSince && <p>🎓 Alumni since: <span className="text-slate-200">{fmtDate(journey.alumniSince)}</span></p>}
        </div>
      </div>
      {actionsSlot}
      <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300">🕓 Timeline</h3>
        <Timeline events={journey.events} />
      </div>
    </div>
  );
};

export default function LifecyclePage() {
  const me = useSelector((s) => s.auth.user);
  const isHR = ['COMPANY_ADMIN', 'HR_MANAGER'].includes(me?.role);

  const [list, setList] = useState([]);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [journey, setJourney] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState(null); // 'confirm'|'probation'|'extend'|'notice'|'exit'|'alumni'|'promote'|'transfer'
  const [form, setForm] = useState({ note: '', probationMonths: 3, noticeDays: 30, designation: '', role: '', departmentId: '' });

  const flash = (okv, text) => { setBanner({ ok: okv, text }); setTimeout(() => setBanner(null), 3500); };

  const loadList = async () => setList(await getCompanyLifecycles(stageFilter || undefined));
  useEffect(() => { if (isHR) loadList(); }, [isHR, stageFilter]);
  useEffect(() => { if (!isHR) getMyJourney().then(setJourney).catch(() => {}); }, [isHR]);
  useEffect(() => { if (isHR) getDepartments().then(setDepartments); }, [isHR]);

  const openJourney = async (userId) => {
    setBusy(true);
    try { setJourney(await getUserJourney(userId)); }
    catch { flash(false, 'Could not open journey'); }
    finally { setBusy(false); }
  };

  const run = async () => {
    const uid = journey?.user?._id;
    if (!uid) return;
    setBusy(true);
    try {
      const note = form.note.trim();
      let res;
      if (action === 'promote') res = await promoteUser(uid, { designation: form.designation, role: form.role, note });
      else if (action === 'transfer') res = await transferUser(uid, { departmentId: form.departmentId, note });
      else if (action === 'confirm') res = await setStage(uid, { to: 'CONFIRMED', note });
      else if (action === 'probation') res = await setStage(uid, { to: 'PROBATION', note, probationMonths: form.probationMonths });
      else if (action === 'extend') res = await setStage(uid, { to: 'PROBATION', note, probationMonths: form.probationMonths });
      else if (action === 'notice') res = await setStage(uid, { to: 'NOTICE_PERIOD', note, noticeDays: form.noticeDays });
      else if (action === 'exit') res = await setStage(uid, { to: 'EXITED', note });
      else if (action === 'alumni') res = await setStage(uid, { to: 'ALUMNI', note });
      const data = res?.data ?? res;
      setJourney((data?.data ?? data) || journey);
      setAction(null);
      setForm({ note: '', probationMonths: 3, noticeDays: 30, designation: '', role: '', departmentId: '' });
      flash(true, 'Done ✅ — employee notified 🔔');
      loadList();
    } catch (e) {
      flash(false, e?.response?.data?.message || 'Action failed');
    } finally { setBusy(false); }
  };

  const btn = 'rounded-lg px-3 py-1.5 text-xs font-bold transition disabled:opacity-50';
  const actions = useMemo(() => {
    if (!journey) return [];
    const s = journey.stage;
    const A = [];
    if (['ONBOARDING', 'CONFIRMED'].includes(s)) A.push({ id: 'probation', label: '⏳ Start probation', cls: 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25' });
    if (['ONBOARDING', 'PROBATION'].includes(s)) A.push({ id: 'confirm', label: '🎉 Confirm employment', cls: 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25' });
    if (s === 'PROBATION') A.push({ id: 'extend', label: '⏳ Extend probation', cls: 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25' });
    if (['ONBOARDING', 'PROBATION', 'CONFIRMED'].includes(s)) {
      A.push({ id: 'promote', label: '🚀 Promote', cls: 'bg-indigo-600 text-white hover:bg-indigo-500' });
      A.push({ id: 'transfer', label: '🔄 Transfer', cls: 'bg-sky-500/15 text-sky-300 hover:bg-sky-500/25' });
      A.push({ id: 'notice', label: '📄 Start notice', cls: 'bg-orange-500/15 text-orange-300 hover:bg-orange-500/25' });
    }
    if (['NOTICE_PERIOD', 'ONBOARDING', 'PROBATION', 'CONFIRMED'].includes(s)) A.push({ id: 'exit', label: '🚪 Complete exit', cls: 'bg-red-500/15 text-red-300 hover:bg-red-500/25' });
    if (s === 'EXITED') A.push({ id: 'alumni', label: '🎓 Mark alumni (FnF done)', cls: 'bg-purple-500/15 text-purple-300 hover:bg-purple-500/25' });
    return A;
  }, [journey]);

  const filtered = list.filter((r) =>
    `${r.user?.name || ''} ${r.user?.email || ''} ${r.user?.designation || ''}`.toLowerCase().includes(search.toLowerCase())
  );

  /* ───────── EMPLOYEE VIEW ───────── */
  if (!isHR) {
    return (
      <div className="max-w-3xl space-y-5">
        <h1 className="text-2xl font-bold text-slate-100">🧬 My Journey</h1>
        {banner && <div className={`rounded-lg px-4 py-2.5 text-sm font-medium ${banner.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{banner.text}</div>}
        {journey ? <JourneyCard journey={journey} /> : <p className="rounded-xl border border-slate-700 bg-slate-800/40 p-8 text-center text-sm text-slate-400">Loading your journey…</p>}
      </div>
    );
  }

  /* ───────── HR CONSOLE ───────── */
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-slate-100">🧬 Employee Lifecycle</h1>
        <span className="text-sm text-slate-400">{list.length} record(s)</span>
      </div>

      {banner && <div className={`rounded-lg px-4 py-2.5 text-sm font-medium ${banner.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{banner.text}</div>}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px,1fr]">
        <aside className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
          <input className={`${inp} mb-2`} placeholder="🔎 Search employees…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className={`${inp} mb-3`} value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
            <option value="">All stages</option>
            {Object.entries(STAGE_META).map(([v, m]) => <option key={v} value={v}>{m.emoji} {m.label}</option>)}
          </select>
          <div className="max-h-[62vh] space-y-1 overflow-y-auto">
            {filtered.map((r) => (
              <button
                key={r._id}
                onClick={() => openJourney(r.user?._id)}
                className={`block w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                  journey?.user?._id === r.user?._id ? 'bg-indigo-600 text-white' : 'text-slate-200 hover:bg-slate-700/60'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-semibold">{r.user?.name || '—'}</span>
                  <StageBadge stage={r.stage} />
                </span>
                <span className={`block truncate text-xs ${journey?.user?._id === r.user?._id ? 'text-indigo-200' : 'text-slate-400'}`}>
                  {r.user?.designation || r.user?.role}
                </span>
              </button>
            ))}
            {filtered.length === 0 && <p className="px-2 py-6 text-center text-xs text-slate-500">No records</p>}
          </div>
        </aside>

        <section>
          {!journey ? (
            <p className="rounded-xl border border-slate-700 bg-slate-800/40 p-10 text-center text-sm text-slate-400">👈 Pick an employee to open their journey</p>
          ) : (
            <JourneyCard
              journey={journey}
              actionsSlot={
                <div className="flex flex-wrap gap-2 rounded-xl border border-slate-700 bg-slate-800/60 p-3">
                  <span className="mr-1 self-center text-xs font-bold uppercase tracking-wide text-slate-400">Actions:</span>
                  {actions.map((a) => (
                    <button key={a.id} disabled={busy} onClick={() => setAction(a.id)} className={`${btn} ${a.cls}`}>{a.label}</button>
                  ))}
                  {actions.length === 0 && <span className="text-xs text-slate-500">No actions available at this stage 🎓</span>}
                </div>
              }
            />
          )}
        </section>
      </div>

      {/* action modal */}
      {action && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setAction(null)}>
          <div className="w-full max-w-md space-y-3 rounded-xl border border-slate-600 bg-slate-800 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-slate-100">
              {actions.find((a) => a.id === action)?.label} — {journey?.user?.name}
            </h3>

            {action === 'promote' && (
              <>
                <input className={inp} placeholder="New designation (e.g. Senior Developer)" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} />
                <select className={inp} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="">Keep current role</option>
                  <option value="EMPLOYEE">EMPLOYEE</option>
                  <option value="TEAM_LEAD">TEAM_LEAD</option>
                  <option value="MANAGER">MANAGER</option>
                  {me?.role === 'COMPANY_ADMIN' && <option value="HR_MANAGER">HR_MANAGER</option>}
                </select>
              </>
            )}
            {action === 'transfer' && (
              <select className={inp} value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
                <option value="">Pick new department…</option>
                {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
              </select>
            )}
            {(action === 'probation' || action === 'extend') && (
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-400">Probation length (months)</label>
                <input type="number" min="1" max="24" className={inp} value={form.probationMonths} onChange={(e) => setForm({ ...form, probationMonths: e.target.value })} />
              </div>
            )}
            {action === 'notice' && (
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-400">Notice period (days)</label>
                <input type="number" min="1" max="180" className={inp} value={form.noticeDays} onChange={(e) => setForm({ ...form, noticeDays: e.target.value })} />
              </div>
            )}
            {action === 'exit' && (
              <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                ⚠️ This deactivates the account (login stops). Best done on their last working day.
              </p>
            )}
            <textarea className={`${inp} min-h-[70px]`} placeholder="Note (optional — shows in the timeline + notification)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setAction(null)} className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-bold text-slate-300 hover:bg-slate-700">Cancel</button>
              <button onClick={run} disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-500 disabled:opacity-50">
                {busy ? 'Working…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}