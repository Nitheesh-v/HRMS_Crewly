import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import systemService from '../services/systemService';

const timeAgo = (d) => {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export default function NotificationBell() {
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const boxRef = useRef(null);
  const navigate = useNavigate();

  // poll unread count every 30s
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await systemService.unreadCount();
        if (alive) setCount(res?.count ?? 0);
      } catch { /* keep old count */ }
    };
    tick();
    const t = setInterval(tick, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // close dropdown on outside click
  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      try {
        const list = await systemService.notifications();
        setItems(Array.isArray(list) ? list : []);
      } catch { /* ignore */ }
    }
  };

  const openItem = async (n) => {
    if (!n.readAt) {
      try { await systemService.markRead(n._id); } catch { /* ignore */ }
      setCount((c) => Math.max(0, c - 1));
      setItems((arr) => arr.map((x) => (x._id === n._id ? { ...x, readAt: new Date().toISOString() } : x)));
    }
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  const markAll = async () => {
    try { await systemService.markAllRead(); } catch { /* ignore */ }
    setCount(0);
    setItems((arr) => arr.map((x) => ({ ...x, readAt: x.readAt || new Date().toISOString() })));
  };

  return (
    <div className="relative" ref={boxRef}>
      <button onClick={toggle} className="relative rounded-lg p-2 text-crewly-dim hover:text-crewly-text" title="Notifications">
        🔔
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-crewly-red px-1 text-[10px] font-bold text-white">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="card absolute right-0 z-50 mt-2 w-80 max-h-96 overflow-y-auto p-2 shadow-xl">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-xs font-semibold">🔔 Notifications</span>
            {count > 0 && (
              <button className="text-[11px] text-crewly-green hover:underline" onClick={markAll}>Mark all read</button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-crewly-dim">No notifications yet</p>
          ) : items.map((n) => (
            <button key={n._id} onClick={() => openItem(n)}
              className={`block w-full rounded-lg px-2 py-2 text-left hover:bg-crewly-bg ${!n.readAt ? 'bg-crewly-green/5' : ''}`}>
              <div className="flex items-start gap-2">
                {!n.readAt && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-crewly-green" />}
                <div className={!n.readAt ? '' : 'pl-3.5'}>
                  <div className="text-xs font-medium">{n.title}</div>
                  {n.message && <div className="text-[11px] text-crewly-dim">{n.message}</div>}
                  <div className="text-[10px] text-crewly-dim/70">{timeAgo(n.createdAt)}</div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}