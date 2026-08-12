// 🔔 NOTIFICATIONS — full history (the bell shows recent; this is everything)
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import systemService from '../../services/systemService';

const errMsg = (err, fb) => err?.response?.data?.message || err?.data?.message || err?.message || fb;

const NotificationsPage = () => {
  const navigate = useNavigate();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await systemService.notifications();
      const items = Array.isArray(res) ? res : res?.data || res?.notifications || [];
      setList(items);
    } catch (err) { setError(errMsg(err, 'Failed to load notifications')); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openOne = async (n) => {
    if (!n.read) { try { await systemService.markRead(n._id); } catch { /* best-effort */ } }
    setList((l) => l.map((x) => (x._id === n._id ? { ...x, read: true } : x)));
    if (n.link) navigate(n.link);
  };

  const markAll = async () => {
    try { await systemService.markAllRead(); } catch { /* ignore */ }
    setList((l) => l.map((x) => ({ ...x, read: true })));
  };

  const unread = list.filter((n) => !n.read).length;

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">🔔 Notifications</h1>
          <p className="mt-1 text-sm text-crewly-dim">{unread ? `${unread} unread` : 'All caught up!'}</p>
        </div>
        {unread > 0 && <button className="btn-ghost px-4 py-2 text-sm" onClick={markAll}>✓ Mark all read</button>}
      </div>

      {error && <div className="mt-4 rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">{error}</div>}

      <div className="mt-5 space-y-2">
        {loading && <p className="text-crewly-dim">Loading…</p>}
        {!loading && list.length === 0 && <div className="card text-center text-crewly-dim">No notifications yet.</div>}
        {list.map((n) => (
          <button
            key={n._id}
            onClick={() => openOne(n)}
            className={`card flex w-full items-start gap-3 py-3 text-left transition hover:border-crewly-green/40 ${n.read ? 'opacity-60' : ''}`}
          >
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read ? 'bg-crewly-border' : 'bg-crewly-green'}`} />
            <div className="min-w-0 flex-1">
              <p className={`text-sm ${n.read ? '' : 'font-semibold'}`}>{n.title}</p>
              {n.message && <p className="mt-0.5 text-xs text-crewly-dim">{n.message}</p>}
              <p className="mt-1 text-[10px] text-crewly-dim">{new Date(n.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};

export default NotificationsPage;