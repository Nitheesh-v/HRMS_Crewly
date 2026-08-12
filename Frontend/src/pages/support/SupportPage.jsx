// 🎫 SUPPORT — raise tickets, track thread; HR manages all tickets
import { useCallback, useEffect, useState } from 'react';
import { supportService } from '../../services/selfService';
import useAuth from '../../hooks/useAuth';
import Modal from '../../components/Modal';


const errMsg = (err, fb) => err?.response?.data?.message || err?.data?.message || err?.message || fb;
const HR_SIDE = ['COMPANY_ADMIN', 'HR_MANAGER'];
const CATEGORIES = ['PAYROLL', 'ATTENDANCE', 'LEAVE', 'IT', 'FACILITIES', 'HR', 'OTHER'];
const STATUS_STYLE = {
  OPEN: 'bg-crewly-orange/15 text-crewly-orange',
  IN_PROGRESS: 'bg-blue-500/15 text-blue-400',
  RESOLVED: 'bg-crewly-green/15 text-crewly-green',
  CLOSED: 'bg-gray-500/15 text-gray-400',
};

const SupportPage = () => {
  const { user } = useAuth();
  const isHR = HR_SIDE.includes(user?.role);
  const [view, setView] = useState('my'); // 'my' | 'all'
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [active, setActive] = useState(null); // open ticket thread
  const [reply, setReply] = useState('');
  const [form, setForm] = useState({ subject: '', category: 'OTHER', message: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = view === 'all' && isHR ? await supportService.listAll() : await supportService.my();
      setTickets(Array.isArray(res) ? res : res?.data || []);
    } catch (err) { setError(errMsg(err, 'Failed to load tickets')); }
    finally { setLoading(false); }
  }, [view, isHR]);

  useEffect(() => { load(); }, [load]);

  const onCreate = async () => {
    if (!form.subject.trim() || !form.message.trim()) { setError('Subject and message are required'); return; }
    setBusy(true); setError('');
    try {
      await supportService.create(form);
      setCreateOpen(false); setForm({ subject: '', category: 'OTHER', message: '' });
      await load();
    } catch (err) { setError(errMsg(err, 'Failed to raise ticket')); }
    finally { setBusy(false); }
  };

  const onReply = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    try {
      const res = await supportService.reply(active._id, reply.trim());
      setActive(res?.data || res); setReply('');
      await load();
    } catch (err) { setError(errMsg(err, 'Reply failed')); }
    finally { setBusy(false); }
  };

  const onStatus = async (id, status) => {
    try { await supportService.setStatus(id, status); setActive(null); await load(); }
    catch (err) { setError(errMsg(err, 'Status update failed')); }
  };

  return (
    <div className="max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">🎫 Support</h1>
          <p className="mt-1 text-sm text-crewly-dim">Raise a ticket — HR gets notified instantly and replies here.</p>
        </div>
        <button className="btn-primary px-5 py-2.5 text-sm" onClick={() => setCreateOpen(true)}>+ Raise Ticket</button>
      </div>

      {error && <div className="mt-4 rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">{error}</div>}

      {isHR && (
        <div className="mt-5 flex gap-2">
          {[['my', 'My Tickets'], ['all', '🛠️ All Tickets (HR)']].map(([k, label]) => (
            <button key={k} onClick={() => setView(k)} className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${view === k ? 'bg-crewly-green/15 text-crewly-green' : 'text-crewly-dim hover:bg-crewly-card'}`}>{label}</button>
          ))}
        </div>
      )}

      <div className="mt-4 space-y-2">
        {loading && <p className="text-crewly-dim">Loading…</p>}
        {!loading && tickets.length === 0 && <div className="card text-center text-crewly-dim">No tickets here. Need help? Raise one! 🙋</div>}
        {tickets.map((t) => (
          <button key={t._id} onClick={() => { setActive(t); setReply(''); }} className="card flex w-full items-center gap-4 py-3 text-left transition hover:border-crewly-green/40">
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{t.subject}</p>
              <p className="text-xs text-crewly-dim">
                {t.category} · {view === 'all' ? `${t.user?.name || ''} · ` : ''}{new Date(t.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} · 💬 {t.replies?.length || 0}
              </p>
            </div>
            <span className={`badge ${STATUS_STYLE[t.status]}`}>{t.status.replace('_', ' ')}</span>
          </button>
        ))}
      </div>

      {/* ── Create modal ── */}
      {createOpen && (
        <Modal onClose={() => setCreateOpen(false)} title="🎫 Raise a Ticket">
          <div className="space-y-3">
            <div>
              <label className="label">Subject *</label>
              <input className="input" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="PF amount wrong in June payslip" />
            </div>
            <div>
              <label className="label">Category</label>
              <select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Describe the issue *</label>
              <textarea className="input" rows="4" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2 border-t border-crewly-border pt-3">
            <button className="btn-ghost px-4 py-2 text-sm" onClick={() => setCreateOpen(false)}>Cancel</button>
            <button className="btn-primary px-5 py-2 text-sm" onClick={onCreate} disabled={busy}>{busy ? 'Raising…' : 'Raise 🎫'}</button>
          </div>
        </Modal>
      )}

      {/* ── Thread modal ── */}
      {active && (
        <Modal onClose={() => setActive(null)} title={`🎫 ${active.subject}`}>
          <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            <div className="flex items-center gap-2 text-xs text-crewly-dim">
              <span className={`badge ${STATUS_STYLE[active.status]}`}>{active.status.replace('_', ' ')}</span>
              <span>{active.category}</span>
              {active.user?.name && <span>· by {active.user.name}</span>}
            </div>
            <div className="rounded-lg bg-crewly-bg p-3 text-sm">{active.message}</div>
            {(active.replies || []).map((r, i) => (
              <div key={i} className="rounded-lg border border-crewly-border p-3 text-sm">
                <p className="mb-1 text-xs text-crewly-dim">{r.by?.name || 'User'} · {r.createdAt ? new Date(r.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</p>
                {r.message}
              </div>
            ))}
            <div className="flex gap-2">
              <input className="input" placeholder="Write a reply…" value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onReply()} />
              <button className="btn-primary shrink-0 px-4 text-sm" onClick={onReply} disabled={busy || !reply.trim()}>Send</button>
            </div>
          </div>
          {isHR && (
            <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-crewly-border pt-3">
              {['IN_PROGRESS', 'RESOLVED', 'CLOSED', 'OPEN'].filter((s) => s !== active.status).map((s) => (
                <button key={s} onClick={() => onStatus(active._id, s)} className="btn-ghost px-3 py-1.5 text-xs">{s.replace('_', ' ')}</button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
};

export default SupportPage;