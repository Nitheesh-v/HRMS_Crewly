// ============================================================
// 💸 Expenses — submit · approvals (manager) · finance (HR) · reimburse
// ============================================================
import React, { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  submitExpense, getMyExpenses, getApprovals,
  managerDecide, financeDecide, markReimbursed, cancelExpense, getAllExpenses,
} from '../../services/expenseService.js';

const inp = 'w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500';
const btn = 'rounded-lg px-3 py-1.5 text-xs font-bold transition disabled:opacity-50';
const chip = (txt, cls) => <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${cls}`}>{txt}</span>;
const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

const CATS = [
  ['TRAVEL', '✈️ Travel'], ['FOOD', '🍱 Food'], ['ACCOMMODATION', '🏨 Accommodation'],
  ['CLIENT_MEETING', '🤝 Client Meeting'], ['TRANSPORT', '🚕 Transport'], ['OTHER', '📦 Other'],
];
const catLabel = (v) => CATS.find(([k]) => k === v)?.[1] || v;
const STATUS_CHIP = {
  PENDING_MANAGER: 'bg-amber-400/15 text-amber-300', PENDING_FINANCE: 'bg-orange-400/15 text-orange-300',
  APPROVED: 'bg-emerald-400/15 text-emerald-300', REJECTED: 'bg-red-400/15 text-red-300',
  REIMBURSED: 'bg-sky-400/15 text-sky-300', CANCELLED: 'bg-slate-500/20 text-slate-400',
};
const statusLabel = (s) => s.replaceAll('_', ' ');

const Row = ({ e, children }) => (
  <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2.5">
    <div className="min-w-0 flex-1">
      <p className="text-sm font-semibold text-slate-100">{catLabel(e.category)} {e.description ? <span className="font-normal text-slate-400">— {e.description}</span> : null}</p>
      <p className="text-xs text-slate-400">
        {e.expenseDate || fmtDate(e.createdAt)}
        {e.user?.name ? ` · ${e.user.name}` : ''}
        {e.receiptUrl ? <> · <a href={e.receiptUrl} target="_blank" rel="noreferrer" className="text-indigo-300 underline">📎 receipt</a></> : ''}
        {e.rejectNote ? <span className="text-red-300"> · "{e.rejectNote}"</span> : ''}
      </p>
    </div>
    <span className="text-sm font-extrabold text-slate-100">{money(e.amount)}</span>
    {chip(statusLabel(e.status), STATUS_CHIP[e.status])}
    {children}
  </div>
);

export default function ExpensesPage() {
  const me = useSelector((s) => s.auth.user);
  const isHR = ['COMPANY_ADMIN', 'HR_MANAGER'].includes(me?.role);
  const isSenior = isHR || ['MANAGER', 'TEAM_LEAD'].includes(me?.role);

  const [mine, setMine] = useState([]);
  const [queue, setQueue] = useState([]);
  const [allBox, setAllBox] = useState({ expenses: [], totals: {} });
  const [form, setForm] = useState({ category: 'TRAVEL', amount: '', expenseDate: '', description: '' });
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const flash = (ok, text) => { setBanner({ ok, text }); setTimeout(() => setBanner(null), 3500); };

  const load = async () => {
    try {
      const [m, q] = await Promise.all([getMyExpenses(), isSenior ? getApprovals() : Promise.resolve([])]);
      setMine(m);
      setQueue(q);
      if (isHR) setAllBox(await getAllExpenses());
    } catch { flash(false, 'Could not load expenses'); }
  };
  useEffect(() => { load(); }, []);

  const doSubmit = async () => {
    const amt = Number(form.amount);
    if (!amt || amt < 1) return flash(false, 'Enter a valid amount');
    setBusy(true);
    try {
      const fd = new FormData();
      const file = fileRef.current?.files?.[0];
      if (file) fd.append('receipt', file);
      fd.append('category', form.category);
      fd.append('amount', String(amt));
      fd.append('expenseDate', form.expenseDate || new Date().toISOString().slice(0, 10));
      fd.append('description', form.description.trim());
      await submitExpense(fd);
      setForm({ category: 'TRAVEL', amount: '', expenseDate: '', description: '' });
      if (fileRef.current) fileRef.current.value = '';
      flash(true, 'Expense submitted ✅ — approver notified 🔔');
      await load();
    } catch (e) { flash(false, e?.response?.data?.message || 'Submit failed'); }
    finally { setBusy(false); }
  };

  const decide = async (e, action, stage) => {
    let note = '';
    if (action === 'REJECT') {
      note = window.prompt('Reason for rejection? (shown to the employee)') || '';
      if (!note.trim()) return flash(false, 'A reason is required to reject');
    }
    setBusy(true);
    try {
      const fn = stage === 'manager' ? managerDecide : financeDecide;
      await fn(e._id, action, note);
      flash(true, `Expense ${action === 'APPROVE' ? 'approved ✅' : 'rejected ❌'}`);
      await load();
    } catch (err) { flash(false, err?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const doReimburse = async (e) => {
    setBusy(true);
    try { await markReimbursed(e._id); flash(true, `${money(e.amount)} reimbursed 💸`); await load(); }
    catch (err) { flash(false, err?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  const doCancel = async (e) => {
    if (!window.confirm(`Cancel this ${money(e.amount)} expense?`)) return;
    try { await cancelExpense(e._id); await load(); } catch (err) { flash(false, err?.response?.data?.message || 'Failed'); }
  };

  const approvedAwaiting = isHR ? (allBox.expenses || []).filter((x) => x.status === 'APPROVED') : [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-100">💸 Expenses</h1>

      {banner && <div className={`rounded-lg px-4 py-2.5 text-sm font-medium ${banner.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{banner.text}</div>}

      {/* submit */}
      <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300">➕ Submit an expense</h2>
        <div className="flex flex-wrap items-center gap-3">
          <select className={`${inp} max-w-[190px]`} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {CATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input className={`${inp} w-32`} type="number" min="1" placeholder="Amount ₹" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <input className={`${inp} w-40`} type="date" value={form.expenseDate} onChange={(e) => setForm({ ...form, expenseDate: e.target.value })} />
          <input className={`${inp} min-w-[200px] flex-1`} placeholder="Description (client lunch in Chennai…)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <input ref={fileRef} type="file" accept=".pdf,image/*" className="text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-700 file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-slate-100 hover:file:bg-slate-600" />
          <button onClick={doSubmit} disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-500 disabled:opacity-50">{busy ? 'Submitting…' : 'Submit'}</button>
        </div>
      </section>

      {/* approvals queue (seniors) */}
      {isSenior && (
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-amber-300">
            {isHR ? '💼 Finance queue' : '👥 Team approvals'} ({queue.length})
          </h2>
          {queue.length === 0 ? (
            <p className="text-xs text-slate-500">Queue is clear. ☕</p>
          ) : (
            <div className="space-y-2">
              {queue.map((e) => (
                <Row key={e._id} e={e}>
                  <button disabled={busy} onClick={() => decide(e, 'APPROVE', isHR ? 'finance' : 'manager')} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-500`}>✓ Approve</button>
                  <button disabled={busy} onClick={() => decide(e, 'REJECT', isHR ? 'finance' : 'manager')} className={`${btn} border border-red-500/40 text-red-300 hover:bg-red-500/10`}>✕ Reject</button>
                </Row>
              ))}
            </div>
          )}
        </section>
      )}

      {/* HR: approved → reimburse */}
      {isHR && approvedAwaiting.length > 0 && (
        <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-emerald-300">✅ Approved — awaiting reimbursement ({approvedAwaiting.length})</h2>
          <div className="space-y-2">
            {approvedAwaiting.map((e) => (
              <Row key={e._id} e={e}>
                <button disabled={busy} onClick={() => doReimburse(e)} className={`${btn} bg-sky-600 text-white hover:bg-sky-500`}>💸 Mark reimbursed</button>
              </Row>
            ))}
          </div>
        </section>
      )}

      {/* HR totals */}
      {isHR && (
        <section className="flex flex-wrap gap-2">
          {[['PENDING_MANAGER'], ['PENDING_FINANCE'], ['APPROVED'], ['REIMBURSED'], ['REJECTED']].map(([s]) => (
            <span key={s} className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_CHIP[s]}`}>
              {statusLabel(s)}: {money(allBox.totals?.[s] || 0)}
            </span>
          ))}
        </section>
      )}

      {/* my expenses */}
      <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-300">🧾 My expenses ({mine.length})</h2>
        {mine.length === 0 ? (
          <p className="text-xs text-slate-500">Nothing submitted yet.</p>
        ) : (
          <div className="space-y-2">
            {mine.map((e) => (
              <Row key={e._id} e={e}>
                {['PENDING_MANAGER', 'PENDING_FINANCE'].includes(e.status) && (
                  <button onClick={() => doCancel(e)} className={`${btn} border border-slate-600 text-slate-300 hover:bg-slate-700`}>Cancel</button>
                )}
              </Row>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}