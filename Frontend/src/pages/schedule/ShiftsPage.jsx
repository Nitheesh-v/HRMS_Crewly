import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import scheduleService from '../../services/scheduleService';
import { getEmployees } from '../../services/docsService';

const inp = 'w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500';
const primary = 'rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50';
const ghost = 'rounded-lg bg-slate-700 hover:bg-slate-600 px-3 py-2 text-sm text-slate-200';
const HR = ['COMPANY_ADMIN', 'HR_MANAGER'];
const SHIFT_TYPES = ['MORNING', 'GENERAL', 'EVENING', 'NIGHT', 'FLEXIBLE', 'CUSTOM'];
const TYPE_EMOJI = { MORNING: '🌅', GENERAL: '🏢', EVENING: '🌆', NIGHT: '🌙', FLEXIBLE: '🤸', CUSTOM: '🛠' };

const emptyForm = { name: '', type: 'GENERAL', startTime: '09:00', endTime: '18:00', breakMinutes: 60, graceMinutes: 10, overtimeEligible: false, overtimeRatePerHour: 0, shiftAllowance: 0, nightAllowance: 0, lateGrace: 10, maxLatePerMonth: 3, earlyGrace: 10 };

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

export default function ShiftsPage() {
  const user = useSelector((s) => s.auth.user);
  const isHR = HR.includes(user?.role);
  const [shifts, setShifts] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [mine, setMine] = useState(null);
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState(null);     // create/edit
  const [assignFor, setAssignFor] = useState(null); // shift being assigned
  const [historyFor, setHistoryFor] = useState('');
  const [history, setHistory] = useState([]);
  const [saving, setSaving] = useState(false);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 3500); };
  const empList = Array.isArray(employees) ? employees : employees?.employees || [];

  const load = async () => {
    try {
      if (isHR) {
        const d = await scheduleService.listShifts();
        setShifts(d.shifts || []);
        const emps = await getEmployees();
        setEmployees(emps?.employees || emps || []);
        const deps = await scheduleService.getDepartments();
        setDepartments(deps.departments || []);
      }
      const m = await scheduleService.myShift();
      setMine(m);
    } catch (e) { flash(e?.response?.data?.message || e.message); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const openCreate = () => setModal({ mode: 'create', form: { ...emptyForm } });
  const openEdit = (s) => setModal({ mode: 'edit', id: s.id, form: { name: s.name, type: s.type, startTime: s.startTime, endTime: s.endTime, breakMinutes: s.breakMinutes, graceMinutes: s.graceMinutes, overtimeEligible: s.overtimeEligible, overtimeRatePerHour: s.overtimeRatePerHour, shiftAllowance: s.shiftAllowance, nightAllowance: s.nightAllowance, lateGrace: s.lateRule?.graceMinutes ?? 10, maxLatePerMonth: s.lateRule?.maxLatePerMonth ?? 3, earlyGrace: s.earlyCheckoutRule?.graceMinutes ?? 10 } });

  const save = async () => {
    setSaving(true);
    try {
      const f = modal.form;
      const payload = { name: f.name, type: f.type, startTime: f.startTime, endTime: f.endTime, breakMinutes: +f.breakMinutes, graceMinutes: +f.graceMinutes, overtimeEligible: !!f.overtimeEligible, overtimeRatePerHour: +f.overtimeRatePerHour, shiftAllowance: +f.shiftAllowance, nightAllowance: +f.nightAllowance, lateRule: { graceMinutes: +f.lateGrace, maxLatePerMonth: +f.maxLatePerMonth }, earlyCheckoutRule: { graceMinutes: +f.earlyGrace } };
      const r = modal.mode === 'create' ? await scheduleService.createShift(payload) : await scheduleService.updateShift(modal.id, payload);
      flash(r.message || 'Saved ✅'); setModal(null); load();
    } catch (e) { flash(e?.response?.data?.message || e.message); }
    setSaving(false);
  };

  const deactivate = async (s) => {
    if (!window.confirm(`Deactivate "${s.name}"?`)) return;
    const r = await scheduleService.deleteShift(s.id); flash(r.message || 'Done'); load();
  };

  const loadHistory = async (uid) => {
    setHistoryFor(uid);
    if (!uid) return setHistory([]);
    try { const d = await scheduleService.shiftHistory(uid); setHistory(d.history || []); } catch { setHistory([]); }
  };

  const myCurrent = mine?.current;

  return (
    <div className="p-6 space-y-5 text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">🔀 Shifts</h1>
          <p className="text-sm text-slate-400">Morning · general · evening · night 🌙 (cross-midnight safe) · flexible · custom</p>
        </div>
        {isHR && <button onClick={openCreate} className={primary}>＋ New Shift</button>}
      </div>

      {toast && <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2 text-sm text-indigo-200">{toast}</div>}

      {/* ── MY SHIFT CARD (all roles) ── */}
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">My current shift</h2>
        {myCurrent?.shift ? (
          <div className="flex flex-wrap items-center gap-4">
            <div className="text-3xl">{TYPE_EMOJI[myCurrent.shift.type] || '🔀'}</div>
            <div>
              <div className="text-lg font-bold">{myCurrent.shift.name}
                {myCurrent.shift.crossesMidnight && <span className="ml-2 rounded-full bg-indigo-500/20 border border-indigo-500/40 px-2 py-0.5 text-[10px] text-indigo-300">🌙 crosses midnight</span>}
              </div>
              <div className="text-sm text-slate-400">{myCurrent.shift.startTime} → {myCurrent.shift.endTime} · break {myCurrent.shift.breakMinutes}m · grace {myCurrent.shift.lateRule?.graceMinutes ?? myCurrent.shift.graceMinutes}m</div>
            </div>
            <span className="rounded-full bg-slate-700 px-3 py-1 text-xs text-slate-300">
              {myCurrent.source === 'EMPLOYEE_OVERRIDE' ? '👤 personal override' : myCurrent.source === 'DEPARTMENT_DEFAULT' ? '🏬 department default' : '📋 assigned'}
            </span>
            {(myCurrent.shift.nightAllowance > 0 || myCurrent.shift.shiftAllowance > 0) && (
              <span className="text-xs text-emerald-300">💰 allowances: {myCurrent.shift.nightAllowance > 0 ? `night ${money(myCurrent.shift.nightAllowance)}/day` : ''} {myCurrent.shift.shiftAllowance > 0 ? `shift ${money(myCurrent.shift.shiftAllowance)}/day` : ''}</span>
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-500">No shift assigned yet. Default work hours apply.</p>
        )}
        {(mine?.history || []).length > 0 && (
          <div className="mt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase text-slate-500">My shift history</h3>
            <div className="space-y-1">
              {mine.history.map((h) => (
                <div key={h.id} className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span className={h.current ? 'text-emerald-300' : ''}>{h.current ? '●' : '○'} {h.shift}</span>
                  <span>{h.effectiveFrom} → {h.effectiveTo || 'present'}</span>
                  {h.prevShift && <span className="text-slate-500">(was: {h.prevShift})</span>}
                  {h.reason && <span className="text-slate-500">· {h.reason}</span>}
                  {h.changedBy && <span className="text-slate-600">by {h.changedBy}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── HR MANAGEMENT ── */}
      {isHR && (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {shifts.filter((s) => s.isActive).map((s) => (
              <div key={s.id} className="rounded-xl border border-slate-700 bg-slate-900 p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-semibold">{TYPE_EMOJI[s.type]} {s.name}</div>
                    <div className="text-xs text-slate-400">{s.type}{s.crossesMidnight ? ' · 🌙 cross-midnight' : ''}</div>
                  </div>
                  <span className="text-sm font-mono text-slate-300">{s.startTime}–{s.endTime}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-slate-400">
                  <span className="rounded bg-slate-800 px-2 py-0.5">☕ {s.breakMinutes}m</span>
                  <span className="rounded bg-slate-800 px-2 py-0.5">⏰ grace {s.lateRule?.graceMinutes ?? s.graceMinutes}m</span>
                  {s.overtimeEligible && <span className="rounded bg-slate-800 px-2 py-0.5">💪 OT {money(s.overtimeRatePerHour)}/hr</span>}
                  {s.nightAllowance > 0 && <span className="rounded bg-slate-800 px-2 py-0.5">🌙 {money(s.nightAllowance)}/day</span>}
                  {s.shiftAllowance > 0 && <span className="rounded bg-slate-800 px-2 py-0.5">💰 {money(s.shiftAllowance)}/day</span>}
                  <span className="rounded bg-slate-800 px-2 py-0.5">👥 {s.employees.length} · 🏬 {s.departments.length}</span>
                </div>
                <div className="mt-3 flex gap-2">
                  <button onClick={() => setAssignFor({ ...s, mode: 'EMPLOYEE', userIds: [], departmentId: '', effectiveFrom: new Date().toISOString().slice(0, 10), reason: '' })} className={`${ghost} text-xs`}>👤 Assign</button>
                  <button onClick={() => openEdit(s)} className={`${ghost} text-xs`}>✏️ Edit</button>
                  <button onClick={() => deactivate(s)} className="rounded-lg bg-rose-600/70 hover:bg-rose-600 px-3 py-1 text-xs text-white">🗑</button>
                </div>
              </div>
            ))}
            {!shifts.length && <p className="text-sm text-slate-500">No shifts yet — create General, Morning, Night…</p>}
          </div>

          {/* history viewer */}
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">📜 Assignment history</h2>
            <div className="flex flex-wrap items-center gap-3">
              <select className={`${inp} w-72`} value={historyFor} onChange={(e) => loadHistory(e.target.value)}>
                <option value="">Pick an employee…</option>
                {empList.map((u) => <option key={u._id || u.id} value={u._id || u.id}>{u.name} {u.email ? `(${u.email})` : ''}</option>)}
              </select>
            </div>
            {historyFor && (
              <div className="mt-3 space-y-1">
                {!history.length && <p className="text-xs text-slate-500">No assignment history.</p>}
                {history.map((h) => (
                  <div key={h.id} className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span className={h.current ? 'text-emerald-300' : ''}>{h.current ? '●' : '○'} <b className="text-slate-200">{h.shift?.name || '—'}</b></span>
                    <span>{h.effectiveFrom} → {h.effectiveTo || 'present'}</span>
                    {h.prevShift && <span className="text-slate-500">(was: {h.prevShift})</span>}
                    {h.reason && <span className="text-slate-500">· {h.reason}</span>}
                    {h.changedBy && <span className="text-slate-600">by {h.changedBy}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── create/edit modal ── */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setModal(null)}>
          <div className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-lg font-semibold">{modal.mode === 'create' ? '＋ New Shift' : '✏️ Edit Shift'}</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-slate-400">Name</label>
                <input className={inp} value={modal.form.name} onChange={(e) => setModal({ ...modal, form: { ...modal.form, name: e.target.value } })} placeholder="Night Shift" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Type</label>
                <select className={inp} value={modal.form.type} onChange={(e) => setModal({ ...modal, form: { ...modal.form, type: e.target.value } })}>
                  {SHIFT_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Start</label>
                <input type="time" className={inp} value={modal.form.startTime} onChange={(e) => setModal({ ...modal, form: { ...modal.form, startTime: e.target.value } })} />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">End (earlier than start = 🌙 next day)</label>
                <input type="time" className={inp} value={modal.form.endTime} onChange={(e) => setModal({ ...modal, form: { ...modal.form, endTime: e.target.value } })} />
              </div>
              {[['breakMinutes', '☕ Break (min)'], ['lateGrace', '⏰ Late grace (min)'], ['earlyGrace', '🏃 Early-out grace (min)'], ['maxLatePerMonth', '⚠️ Max lates / month'], ['overtimeRatePerHour', '💪 OT ₹/hr'], ['shiftAllowance', '💰 Shift allowance ₹/day'], ['nightAllowance', '🌙 Night allowance ₹/day']].map(([k, label]) => (
                <div key={k}>
                  <label className="mb-1 block text-xs text-slate-400">{label}</label>
                  <input type="number" min="0" className={inp} value={modal.form[k]} onChange={(e) => setModal({ ...modal, form: { ...modal.form, [k]: e.target.value } })} />
                </div>
              ))}
              <label className="col-span-2 flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={modal.form.overtimeEligible} onChange={(e) => setModal({ ...modal, form: { ...modal.form, overtimeEligible: e.target.checked } })} /> Overtime eligible
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button className={ghost} onClick={() => setModal(null)}>Cancel</button>
              <button className={primary} disabled={saving || !modal.form.name} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── assign modal ── */}
      {assignFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setAssignFor(null)}>
          <div className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-lg font-semibold">👤 Assign “{assignFor.name}”</h3>
            <div className="mb-3 flex gap-2">
              {[['EMPLOYEE', '👤 Employees / bulk'], ['DEPARTMENT', '🏬 Whole department']].map(([m, l]) => (
                <button key={m} onClick={() => setAssignFor({ ...assignFor, mode: m })} className={assignFor.mode === m ? primary : ghost}>{l}</button>
              ))}
            </div>
            {assignFor.mode === 'EMPLOYEE' ? (
              <div className="max-h-56 space-y-1 overflow-auto rounded-lg border border-slate-700 p-2">
                {empList.map((u) => {
                  const id = String(u._id || u.id);
                  const on = assignFor.userIds.includes(id);
                  return (
                    <label key={id} className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${on ? 'bg-indigo-600/30 text-white' : 'text-slate-300 hover:bg-slate-800'}`}>
                      <input type="checkbox" checked={on} onChange={() => setAssignFor({ ...assignFor, userIds: on ? assignFor.userIds.filter((x) => x !== id) : [...assignFor.userIds, id] })} />
                      {u.name} <span className="text-xs text-slate-500">{u.email}</span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <select className={inp} value={assignFor.departmentId} onChange={(e) => setAssignFor({ ...assignFor, departmentId: e.target.value })}>
                <option value="">Pick department…</option>
                {departments.map((d) => <option key={d._id || d.id} value={d._id || d.id}>{d.name}</option>)}
              </select>
            )}
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-slate-400">Effective from</label>
                <input type="date" className={inp} value={assignFor.effectiveFrom} onChange={(e) => setAssignFor({ ...assignFor, effectiveFrom: e.target.value })} />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Reason</label>
                <input className={inp} value={assignFor.reason} onChange={(e) => setAssignFor({ ...assignFor, reason: e.target.value })} placeholder="Project requirement" />
              </div>
            </div>
            <p className="mt-2 text-xs text-slate-500">📜 History is preserved — the previous assignment closes the day before this starts. Employee-level assignment overrides the department default.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className={ghost} onClick={() => setAssignFor(null)}>Cancel</button>
              <button className={primary} onClick={async () => {
                setSaving(true);
                try {
                  const r = await scheduleService.assignShift(assignFor.id, { userIds: assignFor.mode === 'EMPLOYEE' ? assignFor.userIds : [], departmentId: assignFor.mode === 'DEPARTMENT' ? assignFor.departmentId : null, effectiveFrom: assignFor.effectiveFrom, reason: assignFor.reason });
                  flash(r.message || 'Assigned ✅'); setAssignFor(null); load();
                } catch (e) { flash(e?.response?.data?.message || e.message); }
                setSaving(false);
              }} disabled={saving || (assignFor.mode === 'EMPLOYEE' ? !assignFor.userIds.length : !assignFor.departmentId)}>
                {saving ? 'Assigning…' : 'Assign'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}