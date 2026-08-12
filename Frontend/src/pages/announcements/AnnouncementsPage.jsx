// 📢 ANNOUNCEMENTS — HR/admin post, everyone reads (incl. dashboard feed)
import { useCallback, useEffect, useState } from 'react';
import { announcementService } from '../../services/selfService.js';
import * as authHook from '../../hooks/useAuth.jsx';
import Modal from '../../components/Modal.jsx';

const useAuth = authHook.useAuth || authHook.default;
const errMsg = (err, fb) => err?.response?.data?.message || err?.data?.message || err?.message || fb;
const POSTERS = ['COMPANY_ADMIN', 'HR_MANAGER'];

const AnnouncementsPage = () => {
  const { user } = useAuth();
  const canPost = POSTERS.includes(user?.role);
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', pinned: false });

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await announcementService.list();
      setList(Array.isArray(res) ? res : res?.data || []);
    } catch (err) { setError(errMsg(err, 'Failed to load announcements')); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onPost = async () => {
    if (!form.title.trim() || !form.body.trim()) { setError('Title and message are required'); return; }
    setSaving(true); setError('');
    try {
      await announcementService.create(form);
      setOpen(false); setForm({ title: '', body: '', pinned: false });
      await load();
    } catch (err) { setError(errMsg(err, 'Post failed')); }
    finally { setSaving(false); }
  };

  const onDelete = async (a) => {
    if (!window.confirm(`Delete announcement "${a.title}"?`)) return;
    try { await announcementService.remove(a._id); setList((l) => l.filter((x) => x._id !== a._id)); }
    catch (err) { setError(errMsg(err, 'Delete failed')); }
  };

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">📢 Announcements</h1>
          <p className="mt-1 text-sm text-crewly-dim">Company news from HR & leadership.</p>
        </div>
        {canPost && <button className="btn-primary px-5 py-2.5 text-sm" onClick={() => setOpen(true)}>+ New Announcement</button>}
      </div>

      {error && <div className="mt-4 rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">{error}</div>}

      <div className="mt-5 space-y-3">
        {loading && <p className="text-crewly-dim">Loading…</p>}
        {!loading && list.length === 0 && <div className="card text-center text-crewly-dim">No announcements yet{canPost ? ' — post the first one! 📣' : '.'}</div>}
        {list.map((a) => (
          <article key={a._id} className={`card ${a.pinned ? 'border-crewly-orange/50' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{a.pinned && '📌 '}{a.title}</h3>
                <p className="mt-0.5 text-xs text-crewly-dim">
                  {a.postedBy?.name || 'HR'} · {new Date(a.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                </p>
              </div>
              {(canPost && (String(a.postedBy?._id || a.postedBy) === String(user?._id || user?.id) || user?.role === 'COMPANY_ADMIN')) && (
                <button onClick={() => onDelete(a)} className="rounded-md bg-crewly-red/15 px-2.5 py-1 text-xs text-crewly-red hover:bg-crewly-red/25">Delete</button>
              )}
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm text-crewly-text/90">{a.body}</p>
          </article>
        ))}
      </div>

      {open && (
        <Modal onClose={() => setOpen(false)} title="📢 New Announcement">
          <div className="space-y-3">
            <div>
              <label className="label">Title *</label>
              <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Office closed on Aug 15 🇮🇳" />
            </div>
            <div>
              <label className="label">Message *</label>
              <textarea className="input" rows="5" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-sm text-crewly-dim">
              <input type="checkbox" checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} /> 📌 Pin to top
            </label>
          </div>
          <div className="mt-4 flex justify-end gap-2 border-t border-crewly-border pt-3">
            <button className="btn-ghost px-4 py-2 text-sm" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn-primary px-5 py-2 text-sm" onClick={onPost} disabled={saving}>{saving ? 'Posting…' : 'Post 📢'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default AnnouncementsPage;