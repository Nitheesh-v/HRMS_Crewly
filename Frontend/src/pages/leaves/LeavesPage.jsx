import { useEffect, useState } from 'react';
import leaveService from '../../services/leaveService.js';
import Modal from '../../components/Modal.jsx';

const STATUS_STYLE = {
  PENDING: 'bg-crewly-orange/15 text-crewly-orange',
  APPROVED: 'bg-crewly-green/15 text-crewly-green',
  REJECTED: 'bg-crewly-red/15 text-crewly-red',
  CANCELLED: 'bg-white/10 text-crewly-dim',
};

const TYPE_BADGE = {
  CASUAL: 'bg-blue-400/15 text-blue-300',
  SICK: 'bg-purple-400/15 text-purple-300',
  EARNED: 'bg-yellow-400/15 text-yellow-300',
};

const emptyForm = { type: 'CASUAL', startDate: '', endDate: '', reason: '' };

const LeavesPage = () => {
  const [data, setData] = useState({ leaves: [], balance: [], year: '' });
  const [showApply, setShowApply] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => leaveService.my().then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setSaving(true);
    try {
      await leaveService.apply(form);
      setShowApply(false);
      setForm(emptyForm);
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  const cancel = async (leave) => {
    if (!window.confirm('Cancel this leave request?')) return;
    setError('');
    try { await leaveService.cancel(leave._id); load(); }
    catch (err) { setError(err.message); }
  };

  const availableOf = (type) => data.balance.find((b) => b.type === type)?.available ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">🌴 My Leaves</h1>
        <button className="btn-primary" onClick={() => setShowApply(true)}>+ Apply Leave</button>
      </div>

      {error && <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">{error}</div>}

      {/* Balance cards */}
      <div className="grid gap-3 sm:grid-cols-3">
        {data.balance.map((b) => (
          <div key={b.type} className="card p-4">
            <div className="text-xs text-crewly-dim">{b.label}</div>
            <div className="mt-1 text-2xl font-bold">
              {b.available} <span className="text-sm font-normal text-crewly-dim">/ {b.total} left</span>
            </div>
            <div className="mt-1 text-xs text-crewly-dim">used {b.used} · pending {b.pending}</div>
            <div className="mt-2 h-1.5 rounded bg-crewly-bg">
              <div className="h-1.5 rounded bg-crewly-green" style={{ width: `${b.total ? (b.available / b.total) * 100 : 0}%` }} />
            </div>
          </div>
        ))}
      </div>

      {/* History */}
      <div className="card p-0">
        <div className="border-b border-crewly-border px-5 py-3 font-semibold">Leave History</div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-crewly-border text-crewly-dim">
                <th className="px-5 py-3">Dates</th>
                <th className="px-5 py-3">Type</th>
                <th className="px-5 py-3">Days</th>
                <th className="px-5 py-3">Reason</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {data.leaves.map((l) => (
                <tr key={l._id} className="border-b border-crewly-border/50 last:border-0">
                  <td className="px-5 py-3 whitespace-nowrap">{l.startDate} → {l.endDate}</td>
                  <td className="px-5 py-3"><span className={`badge ${TYPE_BADGE[l.type]}`}>{l.type}</span></td>
                  <td className="px-5 py-3">{l.days}</td>
                  <td className="max-w-56 px-5 py-3 text-crewly-dim">
                    <div className="truncate" title={l.reason}>{l.reason}</div>
                    {l.approverNote && <div className="text-xs text-crewly-dim/70">📝 {l.approverNote}</div>}
                  </td>
                  <td className="px-5 py-3">
                    <span className={`badge ${STATUS_STYLE[l.status]}`}>{l.status}</span>
                    {l.approver && <div className="mt-1 text-xs text-crewly-dim">by {l.approver.name}</div>}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {l.status === 'PENDING' && (
                      <button className="rounded-lg border border-crewly-red/40 px-3 py-1 text-xs text-crewly-red hover:bg-crewly-red/10"
                        onClick={() => cancel(l)}>Cancel</button>
                    )}
                  </td>
                </tr>
              ))}
              {data.leaves.length === 0 && (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-crewly-dim">No leave requests yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* APPLY MODAL */}
      {showApply && (
        <Modal title="Apply for Leave" onClose={() => setShowApply(false)}>
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className="label">Leave Type</label>
              <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {data.balance.map((b) => (
                  <option key={b.type} value={b.type}>{b.label} — {b.available} left</option>
                ))}
              </select>
              {availableOf(form.type) === 0 && (
                <p className="mt-1 text-xs text-crewly-red">⚠️ No balance left in this type</p>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Start Date</label>
                <input type="date" className="input" value={form.startDate}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value })} required />
              </div>
              <div>
                <label className="label">End Date</label>
                <input type="date" className="input" value={form.endDate}
                  min={form.startDate || new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })} required />
              </div>
            </div>
            <div>
              <label className="label">Reason</label>
              <textarea className="input" rows={3} maxLength={300} placeholder="Why do you need this leave?"
                value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required />
            </div>
            <p className="text-xs text-crewly-dim">Sat/Sun are auto-excluded from day count.</p>
            <button type="submit" className="btn-primary w-full" disabled={saving || availableOf(form.type) === 0}>
              {saving ? 'Submitting…' : 'Submit Request'}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
};

export default LeavesPage;