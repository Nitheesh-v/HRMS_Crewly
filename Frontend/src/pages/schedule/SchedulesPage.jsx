import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import scheduleService from '../../services/scheduleService';

const inp = 'w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500';
const primary = 'rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50';
const ghost = 'rounded-lg bg-slate-700 hover:bg-slate-600 px-3 py-2 text-sm text-slate-200';
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const emptyForm = { name: '', workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], startTime: '09:00', endTime: '18:00', breakMinutes: 60, graceMinutes: 10, minWorkingHours: 8, halfDayHours: 4, overtimeEligible: false, lateGrace: 10, maxLatePerMonth: 3, earlyGrace: 10, branch: '' };

export default function SchedulesPage() {
  const user = useSelector((s) => s.auth.user);
  const isHR = ['COMPANY_ADMIN', 'HR_MANAGER'].includes(user?.role);
  const [schedules, setSchedules] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState(null);
  const [saving, setSaving] = useState(false);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 3000); };
  const load = async () => {
    try {
      const d = await scheduleService.listSchedules();
      setSchedules(d.schedules || []);
      const deps = await scheduleService.getDepartments();
      setDepartments(deps.departments || []);
    } catch (e) { flash(e?.response?.data?.message || e.message); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  if (!isHR) return <div className="p-6 text-slate-300">🔒 Only Admin/HR manage work schedules. Check your schedule under 🔀 Shifts → My current shift.</div>;

  const save = async () => {
    setSaving(true);
    try {
      const f = modal.form;
      const payload = { name: f.name, workingDays: f.workingDays, startTime: f.startTime, endTime: f.endTime, breakMinutes: +f.breakMinutes, graceMinutes: +f.graceMinutes, minWorkingHours: +f.minWorkingHours, halfDayHours: +f.halfDayHours, overtimeEligible: !!f.overtimeEligible, branch: f.branch, departments: f.departments || [], lateRule: { graceMinutes: +f.lateGrace, maxLatePerMonth: +f.maxLatePerMonth }, earlyCheckoutRule: { graceMinutes: +f.earlyGrace } };
      const r = modal.mode === 'create' ? await scheduleService.createSchedule(payload) : await scheduleService.updateSchedule(modal.id, payload);
      flash(r.message || 'Saved ✅'); setModal(null); load();
    } catch (e) { flash(e?.response?.data?.message || e.message); }
    setSaving(false);
  };

  return (
    <div className="p-6 space-y-5 text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">🗓 Work Schedules</h1>
          <p className="text-sm text-slate-400">Reusable working-day patterns — never hard-coded Mon–Fri</p>
        </div>
        <button onClick={() => setModal({ mode: 'create', form: { ...emptyForm, departments: [] } })} className={primary}>＋ New Schedule</button>
      </div>

      {toast && <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2 text-sm text-indigo-200">{toast}</div>}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {schedules.map((s) => (
          <div key={s.id} className={`rounded-xl border bg-slate-900 p-4 ${s.isActive ? 'border-slate-700' : 'border-slate-800 opacity-60'}`}>
            <div className="flex items-start justify-between">
              <div>
                <div className="font-semibold">{s.name} {!s.isActive && <span className="text-xs text-slate-500">(inactive)</span>}</div>
                <div className="text-xs text-slate-400">{s.startTime} → {s.endTime} · ☕ {s.breakMinutes}m · ⏰ grace {s.lateRule?.graceMinutes ?? s.graceMinutes}m</div>
              </div>
              <span className="text-xs text-slate-400">🎯 {s.minWorkingHours}h/day</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {DAYS.map((d) => (
                <span key={d} className={`rounded px-2 py-0.5 text-[10px] font-semibold ${s.workingDays.includes(d) ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-slate-800 text-slate-500 border border-slate-700 line-through'}`}>{d}</span>
              ))}
            </div>
            <div className="mt-2 text-[11px] text-slate-500">
              {s.branch && <>📍 {s.branch} · </>}🏬 {s.departments.map((d) => d.name).join(', ') || '—'} · 👥 {s.employees.length} direct
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => setModal({ mode: 'edit', id: s.id, form: { name: s.name, workingDays: s.workingDays, startTime: s.startTime, endTime: s.endTime, breakMinutes: s.breakMinutes, graceMinutes: s.graceMinutes, minWorkingHours: s.minWorkingHours, halfDayHours: s.halfDayHours, overtimeEligible: s.overtimeEligible, lateGrace: s.lateRule?.graceMinutes ?? 10, maxLatePerMonth: s.lateRule?.maxLatePerMonth ?? 3, earlyGrace: s.earlyCheckoutRule?.graceMinutes ?? 10, branch: s.branch || '', departments: s.departments.map((d) => d.id) } })} className={`${ghost} text-xs`}>✏️ Edit</button>
              {s.isActive && <button onClick={async () => { if (window.confirm(`Deactivate "${s.name}"?`)) { await scheduleService.deleteSchedule(s.id); load(); } }} className="rounded-lg bg-rose-600/70 hover:bg-rose-600 px-3 py-1 text-xs text-white">🗑</button>}
            </div>
          </div>
        ))}
        {!schedules.length && <p className="text-sm text-slate-500">No schedules yet — create “General Office 09:00–18:00”, a 6-day support schedule, etc.</p>}
      </div>

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setModal(null)}>
          <div className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-lg font-semibold">{modal.mode === 'create' ? '＋ New Schedule' : '✏️ Edit Schedule'}</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="mb-1 block text-xs text-slate-400">Name</label>
                <input className={inp} value={modal.form.name} onChange={(e) => setModal({ ...modal, form: { ...modal.form, name: e.target.value } })} placeholder="General Office Schedule" />
              </div>
              <div className="col-span-2">
                <label className="mb-1 block text-xs text-slate-400">Working days</label>
                <div className="flex flex-wrap gap-1">
                  {DAYS.map((d) => {
                    const on = modal.form.workingDays.includes(d);
                    return (
                      <button type="button" key={d} onClick={() => setModal({ ...modal, form: { ...modal.form, workingDays: on ? modal.form.workingDays.filter((x) => x !== d) : [...modal.form.workingDays, d] } })}
                        className={on ? 'rounded bg-emerald-600/70 px-3 py-1 text-xs text-white' : 'rounded border border-slate-600 px-3 py-1 text-xs text-slate-400'}>
                        {d}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Start</label>
                <input type="time" className={inp} value={modal.form.startTime} onChange={(e) => setModal({ ...modal, form: { ...modal.form, startTime: e.target.value } })} />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">End</label>
                <input type="time" className={inp} value={modal.form.endTime} onChange={(e) => setModal({ ...modal, form: { ...modal.form, endTime: e.target.value } })} />
              </div>
              {[['breakMinutes', '☕ Break (min)'], ['graceMinutes', '⏰ Grace (min)'], ['minWorkingHours', '🎯 Min hours/day'], ['halfDayHours', '🌗 Half-day hours'], ['lateGrace', '⚠️ Late grace (min)'], ['earlyGrace', '🏃 Early-out grace (min)']].map(([k, label]) => (
                <div key={k}>
                  <label className="mb-1 block text-xs text-slate-400">{label}</label>
                  <input type="number" min="0" step="0.5" className={inp} value={modal.form[k]} onChange={(e) => setModal({ ...modal, form: { ...modal.form, [k]: e.target.value } })} />
                </div>
              ))}
              <div className="col-span-2">
                <label className="mb-1 block text-xs text-slate-400">Departments on this schedule</label>
                <div className="flex flex-wrap gap-1">
                  {departments.map((d) => {
                    const id = String(d._id || d.id);
                    const on = (modal.form.departments || []).includes(id);
                    return (
                      <button type="button" key={id} onClick={() => setModal({ ...modal, form: { ...modal.form, departments: on ? modal.form.departments.filter((x) => x !== id) : [...(modal.form.departments || []), id] } })}
                        className={on ? 'rounded bg-amber-600/70 px-3 py-1 text-xs text-white' : 'rounded border border-slate-600 px-3 py-1 text-xs text-slate-400'}>
                        {d.name}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="col-span-2 flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={modal.form.overtimeEligible} onChange={(e) => setModal({ ...modal, form: { ...modal.form, overtimeEligible: e.target.checked } })} /> Overtime eligible
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button className={ghost} onClick={() => setModal(null)}>Cancel</button>
              <button className={primary} disabled={saving || !modal.form.name || !modal.form.workingDays.length} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}