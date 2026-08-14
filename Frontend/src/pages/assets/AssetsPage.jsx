// ============================================================
// 🖥 Assets — HR inventory + assign/return · employees: my assets
// ============================================================
import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { getMyAssets, getAllAssets, createAsset, assignAsset, returnAsset, deleteAsset } from '../../services/assetService.js';
import { getEmployees } from '../../services/docsService.js';

const inp = 'w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500';
const btn = 'rounded-lg px-3 py-1.5 text-xs font-bold transition disabled:opacity-50';
const chip = (txt, cls) => <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${cls}`}>{txt}</span>;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

const CATS = {
  LAPTOP: '💻 Laptop', MONITOR: '🖥 Monitor', KEYBOARD: '⌨️ Keyboard',
  MOUSE: '🖱 Mouse', MOBILE: '📱 Mobile', ID_CARD: '🪪 ID Card', OTHER: '📦 Other',
};

export default function AssetsPage() {
  const me = useSelector((s) => s.auth.user);
  const isHR = ['COMPANY_ADMIN', 'HR_MANAGER'].includes(me?.role);

  const [mine, setMine] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [form, setForm] = useState({ name: '', category: 'LAPTOP', serialNumber: '', note: '' });
  const [assignTarget, setAssignTarget] = useState(null);
  const [assignForm, setAssignForm] = useState({ userId: '', note: '' });
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);

  const flash = (ok, text) => { setBanner({ ok, text }); setTimeout(() => setBanner(null), 3500); };

  const load = async () => {
    try {
      setMine(await getMyAssets());
      if (isHR) {
        setInventory(await getAllAssets());
        if (!employees.length) setEmployees(await getEmployees());
      }
    } catch { flash(false, 'Could not load assets'); }
  };
  useEffect(() => { load(); }, []);

  const doCreate = async () => {
    if (!form.name.trim()) return flash(false, 'Asset name needed');
    setBusy(true);
    try {
      await createAsset(form);
      setForm({ name: '', category: 'LAPTOP', serialNumber: '', note: '' });
      flash(true, 'Asset added 🖥');
      await load();
    } catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const doAssign = async () => {
    if (!assignForm.userId) return flash(false, 'Pick an employee');
    setBusy(true);
    try {
      await assignAsset(assignTarget._id, assignForm);
      setAssignTarget(null); setAssignForm({ userId: '', note: '' });
      flash(true, 'Assigned — employee notified 🔔');
      await load();
    } catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const doReturn = async (a) => {
    const note = window.prompt(`Return "${a.name}" from ${a.currentHolder?.name || 'holder'}? Condition note (optional):`) ?? null;
    if (note === null) return;
    setBusy(true);
    try { await returnAsset(a._id, note); flash(true, 'Returned — asset available ✅'); await load(); }
    catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const doDelete = async (a) => {
    if (!window.confirm(`Delete "${a.name}" permanently?`)) return;
    try { await deleteAsset(a._id); flash(true, 'Deleted 🗑'); await load(); }
    catch (e) { flash(false, e?.response?.data?.message || 'Failed'); }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-100">🖥 Assets</h1>

      {banner && <div className={`rounded-lg px-4 py-2.5 text-sm font-medium ${banner.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{banner.text}</div>}

      {/* my assets — everyone */}
      <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300">🎒 In my hands ({mine.length})</h2>
        {mine.length === 0 ? (
          <p className="text-xs text-slate-500">No equipment assigned to you right now.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {mine.map((a) => {
              const since = a.assignments?.length ? a.assignments[a.assignments.length - 1].assignedAt : a.updatedAt;
              return (
                <div key={a._id} className="rounded-xl border border-slate-700 bg-slate-900/40 p-4">
                  <p className="text-2xl">{(CATS[a.category] || '📦').split(' ')[0]}</p>
                  <p className="mt-1 text-sm font-bold text-slate-100">{a.name}</p>
                  <p className="text-xs text-slate-400">{CATS[a.category]}{a.serialNumber ? ` · S/N ${a.serialNumber}` : ''}</p>
                  <p className="mt-2 text-[11px] text-slate-500">with you since {fmtDate(since)}</p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {isHR && (
        <>
          {/* create */}
          <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300">➕ Add equipment</h2>
            <div className="flex flex-wrap items-center gap-3">
              <input className={`${inp} min-w-[200px] flex-1`} placeholder="Asset name (MacBook Pro 14…)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <select className={`${inp} max-w-[170px]`} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {Object.entries(CATS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <input className={`${inp} w-44`} placeholder="Serial # (optional)" value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} />
              <input className={`${inp} w-44`} placeholder="Note (optional)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              <button onClick={doCreate} disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-500 disabled:opacity-50">Add</button>
            </div>
          </section>

          {/* inventory */}
          <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300">📦 Inventory ({inventory.length})</h2>
            {inventory.length === 0 ? (
              <p className="text-xs text-slate-500">No assets yet — add the first one above.</p>
            ) : (
              <div className="space-y-2">
                {inventory.map((a) => (
                  <div key={a._id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2.5">
                    <span className="text-xl">{(CATS[a.category] || '📦').split(' ')[0]}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-100">{a.name} {a.serialNumber ? <span className="font-normal text-slate-400">· {a.serialNumber}</span> : null}</p>
                      <p className="text-xs text-slate-400">
                        {a.status === 'ASSIGNED' ? `with ${a.currentHolder?.name || '—'}` : 'in stock'} · {a.assignments?.length || 0} assignment(s)
                      </p>
                    </div>
                    {a.status === 'ASSIGNED'
                      ? chip(`ASSIGNED → ${a.currentHolder?.name || ''}`, 'bg-amber-400/15 text-amber-300')
                      : chip('AVAILABLE', 'bg-emerald-400/15 text-emerald-300')}
                    {a.status === 'AVAILABLE' && (
                      <button onClick={() => { setAssignTarget(a); setAssignForm({ userId: '', note: '' }); }} className={`${btn} bg-indigo-600 text-white hover:bg-indigo-500`}>📤 Assign</button>
                    )}
                    {a.status === 'ASSIGNED' && (
                      <button onClick={() => doReturn(a)} className={`${btn} bg-sky-600 text-white hover:bg-sky-500`}>↩️ Return</button>
                    )}
                    {a.status === 'AVAILABLE' && (
                      <button onClick={() => doDelete(a)} className={`${btn} border border-red-500/40 text-red-300 hover:bg-red-500/10`}>🗑</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {/* assign modal */}
      {assignTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setAssignTarget(null)}>
          <div className="w-full max-w-md space-y-3 rounded-xl border border-slate-600 bg-slate-800 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-slate-100">📤 Assign {assignTarget.name}</h3>
            <select className={inp} value={assignForm.userId} onChange={(e) => setAssignForm({ ...assignForm, userId: e.target.value })}>
              <option value="">Pick employee…</option>
              {employees.map((e2) => <option key={e2._id} value={e2._id}>{e2.name} — {e2.designation || e2.role}</option>)}
            </select>
            <input className={inp} placeholder="Note (charger included, handle with care…)" value={assignForm.note} onChange={(e) => setAssignForm({ ...assignForm, note: e.target.value })} />
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setAssignTarget(null)} className={`${btn} border border-slate-600 text-slate-300 hover:bg-slate-700`}>Cancel</button>
              <button onClick={doAssign} disabled={busy} className={`${btn} bg-indigo-600 text-white hover:bg-indigo-500`}>{busy ? 'Assigning…' : 'Assign 🔔'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}