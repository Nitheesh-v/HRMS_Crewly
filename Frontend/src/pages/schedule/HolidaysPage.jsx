import { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import scheduleService from '../../services/scheduleService';

const inp = 'w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500';
const primary = 'rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50';
const ghost = 'rounded-lg bg-slate-700 hover:bg-slate-600 px-3 py-2 text-sm text-slate-200';

const HR = ['COMPANY_ADMIN', 'HR_MANAGER'];
const TYPES = ['COMPANY', 'BRANCH', 'DEPARTMENT', 'OPTIONAL', 'PUBLIC'];
const TYPE_STYLE = {
  COMPANY: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  PUBLIC: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  BRANCH: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
  DEPARTMENT: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  OPTIONAL: 'bg-violet-500/20 text-violet-300 border-violet-500/40',
};
const badge = (t) => `inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${TYPE_STYLE[t] || TYPE_STYLE.COMPANY}`;
const dstr = (d) => d.toISOString().slice(0, 10);
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const emptyForm = { name: '', type: 'COMPANY', date: '', endDate: '', description: '', branch: '', departments: [], isOptional: false, recurringYearly: false };

export default function HolidaysPage() {
  const user = useSelector((s) => s.auth.user);
  const isHR = HR.includes(user?.role);
  const now = new Date();
  const [view, setView] = useState('month'); // month | year | list
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);
  const [typeFilter, setTypeFilter] = useState('');
  const [holidays, setHolidays] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState(null); // { mode:'create'|'edit', form, id? }
  const [saving, setSaving] = useState(false);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 3000); };

  const load = async () => {
    setLoading(true);
    try {
      const params = view === 'month' ? { year, month } : { year };
      if (isHR) params.scope = 'all';
      if (typeFilter) params.type = typeFilter;
      const d = await scheduleService.listHolidays(params);
      setHolidays(d.holidays || []);
    } catch (e) { flash(e?.response?.data?.message || e.message); }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [view, year, month, typeFilter]);
  useEffect(() => { if (isHR) scheduleService.getDepartments().then((d) => setDepartments(d.departments || [])); }, [isHR]);

  const byDate = useMemo(() => {
    const map = {};
    holidays.forEach((h) =>
      ((h.dates && h.dates.length ? h.dates : [h.date]).forEach((d) => {
        const k = String(d || '').slice(0, 10);
        if (!k) return;
        (map[k] = map[k] || []).push(h);
      }))
    );
    console.log('📅 [holidays] count:', holidays.length, '| byDate keys:', Object.keys(map), '| feed sample:', holidays[0]);
    return map;
  }, [holidays]);

  const cells = useMemo(() => {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const start = first.getUTCDay();
    const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const arr = [];
    for (let i = 0; i < start; i += 1) arr.push(null);
    for (let d = 1; d <= dim; d += 1) arr.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    while (arr.length % 7) arr.push(null);
    return arr;
  }, [year, month]);

  const nav = (dir) => {
    let m = month + dir; let y = year;
    if (m < 1) { m = 12; y -= 1; } if (m > 12) { m = 1; y += 1; }
    setMonth(m); setYear(y);
  };

  const openCreate = () => setModal({ mode: 'create', form: { ...emptyForm, date: dstr(new Date()) } });
  const openEdit = (h) => setModal({ mode: 'edit', id: h.id, form: { name: h.name, type: h.type === 'OPTIONAL' ? 'COMPANY' : h.type, date: h.date, endDate: h.endDate, description: h.description || '', branch: h.branch || '', departments: (h.departments || []).map((d) => d.id || d), isOptional: h.isOptional, recurringYearly: h.recurringYearly } });

  const save = async () => {
    setSaving(true);
    try {
      const f = modal.form;
      const payload = { ...f, endDate: f.endDate || f.date };
      const r = modal.mode === 'create' ? await scheduleService.createHoliday(payload) : await scheduleService.updateHoliday(modal.id, payload);
      flash(r.message || 'Saved ✅'); setModal(null); load();
    } catch (e) { flash(e?.response?.data?.message || e.message); }
    setSaving(false);
  };

  const deactivate = async (h) => {
    if (!window.confirm(`Deactivate "${h.name}"?`)) return;
    const r = await scheduleService.deleteHoliday(h.id); flash(r.message || 'Done'); load();
  };

  const togglePick = async (h) => {
    try {
      const r = h.picked ? await scheduleService.unpick(h.id) : await scheduleService.pick(h.id);
      flash(r.message || 'Done'); load();
    } catch (e) { flash(e?.response?.data?.message || e.message); }
  };

  const upcoming = useMemo(() => {
    const t = dstr(new Date());
    return holidays.filter((h) => h.endDate >= t && !(h.isOptional && !h.picked)).slice(0, 6);
  }, [holidays]);

  return (
    <div className="p-6 space-y-5 text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">🎉 Holidays</h1>
          <p className="text-sm text-slate-400">Company · branch · department · optional & public holidays</p>
        </div>
        <div className="flex items-center gap-2">
          {['month', 'year', 'list'].map((v) => (
            <button key={v} onClick={() => setView(v)} className={view === v ? primary : ghost}>{v === 'month' ? '📆 Month' : v === 'year' ? '🗓 Year' : '📋 List'}</button>
          ))}
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={`${inp} w-auto`}>
            <option value="">All types</option>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {isHR && <button onClick={openCreate} className={primary}>＋ Add Holiday</button>}
        </div>
      </div>

      {toast && <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2 text-sm text-indigo-200">{toast}</div>}

      {upcoming.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {upcoming.map((h) => (
            <span key={h.id + h.date} className="rounded-full bg-slate-800 border border-slate-700 px-3 py-1 text-xs text-slate-300">
              ⏭ <b className="text-slate-100">{h.name}</b> · {h.date}{h.endDate !== h.date ? ` → ${h.endDate}` : ''} <span className={badge(h.type)}>{h.type}</span>
            </span>
          ))}
        </div>
      )}

      {view === 'month' && (
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
          <div className="mb-3 flex items-center justify-between">
            <button onClick={() => nav(-1)} className={ghost}>←</button>
            <h2 className="text-lg font-semibold">{MONTHS[month - 1]} {year}</h2>
            <button onClick={() => nav(1)} className={ghost}>→</button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[10px] uppercase tracking-wide text-slate-500">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="py-1">{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((c, i) => (
              <div key={i} className={`min-h-[74px] rounded-lg border p-1 ${c ? 'border-slate-700 bg-slate-800/60' : 'border-transparent'}`}>
                {c && (
                  <>
                    <div className={`text-xs ${c === dstr(new Date()) ? 'font-bold text-indigo-300' : 'text-slate-400'}`}>{parseInt(c.slice(8), 10)}</div>
                    <div className="mt-0.5 space-y-0.5">
                      {(byDate[c] || []).slice(0, 3).map((h) => (
                        <div key={h.id + c} title={`${h.name} (${h.type})${isHR ? ' — click to edit' : ''}`} onClick={() => { if (isHR) openEdit(h); }} className={`truncate rounded px-1 text-[10px] border ${TYPE_STYLE[h.type]} ${isHR ? 'cursor-pointer hover:opacity-80' : ''}`}>
                          {h.isOptional && !h.picked ? '○ ' : ''}{h.name}
                        </div>
                      ))}
                      {(byDate[c] || []).length > 3 && <div className="text-[10px] text-slate-500">+{byDate[c].length - 3} more</div>}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-400">
            {TYPES.map((t) => <span key={t} className={badge(t)}>{t}</span>)}
            <span>○ = optional, not picked yet</span>
          </div>
        </div>
      )}

      {(view === 'year' || view === 'list') && (
        <div className="space-y-4">
          {view === 'year' && (
            <div className="flex items-center gap-2">
              <button onClick={() => setYear(year - 1)} className={ghost}>←</button>
              <h2 className="text-lg font-semibold">{year}</h2>
              <button onClick={() => setYear(year + 1)} className={ghost}>→</button>
            </div>
          )}
          {loading && <p className="text-sm text-slate-400">Loading…</p>}
          {!loading && holidays.length === 0 && <p className="text-sm text-slate-500">No holidays found for this filter.</p>}
          {(view === 'year' ? MONTHS : [null]).map((mlabel, mi) => {
            const rows = view === 'year' ? holidays.filter((h) => parseInt(h.date.slice(5, 7), 10) === mi + 1) : holidays;
            if (view === 'year' && !rows.length) return null;
            return (
              <div key={mlabel || 'list'} className="rounded-xl border border-slate-700 bg-slate-900">
                {mlabel && <div className="border-b border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300">{mlabel} {year}</div>}
                <div className="divide-y divide-slate-800">
                  {rows.map((h) => (
                    <div key={h.id + h.date} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                      <span className="w-44 text-slate-400">{h.date}{h.endDate !== h.date ? ` → ${h.endDate}` : ''}</span>
                      <span className="font-medium">{h.name}</span>
                      <span className={badge(h.type)}>{h.type}</span>
                      {h.recurringYearly && <span className="text-xs text-slate-500">🔁 yearly</span>}
                      {h.branch && <span className="text-xs text-slate-500">📍 {h.branch}</span>}
                      {(h.departments || []).map((d) => <span key={d.id || d} className="text-xs text-amber-300/80">🏬 {d.name || d}</span>)}
                      <span className="flex-1" />
                      {h.isOptional && (
                        <button onClick={() => togglePick(h)} className={h.picked ? 'rounded-lg bg-violet-600/80 hover:bg-violet-600 px-3 py-1 text-xs text-white' : 'rounded-lg border border-violet-500/50 px-3 py-1 text-xs text-violet-300 hover:bg-violet-500/10'}>
                          {h.picked ? '✔ Picked' : 'Pick'}
                        </button>
                      )}
                      {isHR && (
                        <>
                          <button onClick={() => openEdit(h)} className="rounded-lg bg-slate-700 px-3 py-1 text-xs hover:bg-slate-600">✏️ Edit</button>
                          <button onClick={() => deactivate(h)} className="rounded-lg bg-rose-600/70 px-3 py-1 text-xs hover:bg-rose-600">🗑</button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setModal(null)}>
          <div className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-lg font-semibold">{modal.mode === 'create' ? '＋ Add Holiday' : '✏️ Edit Holiday'}</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="mb-1 block text-xs text-slate-400">Name</label>
                <input className={inp} value={modal.form.name} onChange={(e) => setModal({ ...modal, form: { ...modal.form, name: e.target.value } })} placeholder="Diwali 🪔" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Type</label>
                <select className={inp} disabled={modal.form.isOptional} value={modal.form.type} onChange={(e) => setModal({ ...modal, form: { ...modal.form, type: e.target.value } })}>
                  {TYPES.filter((t) => t !== 'OPTIONAL').map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Branch (for BRANCH type)</label>
                <input className={inp} value={modal.form.branch} onChange={(e) => setModal({ ...modal, form: { ...modal.form, branch: e.target.value } })} placeholder="Chennai" />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Date</label>
                <input type="date" className={inp} value={modal.form.date} onChange={(e) => setModal({ ...modal, form: { ...modal.form, date: e.target.value } })} />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">End date (multi-day, optional)</label>
                <input type="date" className={inp} value={modal.form.endDate} onChange={(e) => setModal({ ...modal, form: { ...modal.form, endDate: e.target.value } })} />
              </div>
              {modal.form.type === 'DEPARTMENT' && (
                <div className="col-span-2">
                  <label className="mb-1 block text-xs text-slate-400">Departments</label>
                  <div className="flex flex-wrap gap-2">
                    {departments.map((d) => {
                      const id = String(d._id || d.id);
                      const on = modal.form.departments.includes(id);
                      return (
                        <button type="button" key={id} onClick={() => setModal({ ...modal, form: { ...modal.form, departments: on ? modal.form.departments.filter((x) => x !== id) : [...modal.form.departments, id] } })}
                          className={on ? 'rounded-full bg-amber-600/70 px-3 py-1 text-xs text-white' : 'rounded-full border border-slate-600 px-3 py-1 text-xs text-slate-300'}>
                          {d.name}
                        </button>
                      );
                    })}
                    {!departments.length && <span className="text-xs text-slate-500">No departments loaded</span>}
                  </div>
                </div>
              )}
              <div className="col-span-2">
                <label className="mb-1 block text-xs text-slate-400">Description</label>
                <textarea className={inp} rows="2" value={modal.form.description} onChange={(e) => setModal({ ...modal, form: { ...modal.form, description: e.target.value } })} />
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={modal.form.isOptional} onChange={(e) => setModal({ ...modal, form: { ...modal.form, isOptional: e.target.checked } })} /> Optional holiday (employees pick)
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={modal.form.recurringYearly} onChange={(e) => setModal({ ...modal, form: { ...modal.form, recurringYearly: e.target.checked } })} /> 🔁 Recurs every year
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button className={ghost} onClick={() => setModal(null)}>Cancel</button>
              <button className={primary} disabled={saving || !modal.form.name || !modal.form.date} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}