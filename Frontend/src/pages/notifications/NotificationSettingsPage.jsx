import { useCallback, useEffect, useState } from 'react';
import { getNotifyPrefs, saveNotifyPrefs, obj } from '../../services/workService.js';

const LABELS = {
  LEAVE: ['🌴', 'Leaves'],
  TASK: ['📝', 'Tasks'],
  PROJECT: ['📁', 'Projects'],
  MEETING: ['📅', 'Meetings'],
  ANNOUNCEMENT: ['📢', 'Announcements'],
  DOCUMENT: ['📄', 'Documents'],
  PAYROLL: ['💰', 'Payroll'],
  BILLING: ['💳', 'Billing'],
  SUPPORT: ['🎫', 'Support'],
  SYSTEM: ['⚙️', 'System'],
};

const Toggle = ({ on, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`h-6 w-11 rounded-full transition ${on ? 'bg-indigo-600' : 'bg-slate-600'}`}
    aria-pressed={on}
  >
    <span className={`block h-5 w-5 rounded-full bg-white shadow transition ${on ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
  </button>
);

export default function NotificationSettingsPage() {
  const [categories, setCategories] = useState([]);
  const [inapp, setInapp] = useState({});
  const [email, setEmail] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = obj(await getNotifyPrefs());
      setCategories(d?.categories || Object.keys(LABELS));
      setInapp(d?.inapp || {});
      setEmail(d?.email || {});
    } catch (e) {
      setMsg('❌ Could not load preferences');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const flip = (box, setBox) => (cat) => setBox((p) => ({ ...p, [cat]: p[cat] === false })); // true/undefined → false, false → true

  const save = async () => {
    setBusy(true);
    setMsg('');
    try {
      await saveNotifyPrefs({ inapp, email });
      setMsg('✅ Preferences saved');
      setTimeout(() => setMsg(''), 3000);
    } catch (e) {
      setMsg('❌ Could not save');
    }
    setBusy(false);
  };

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">🔔 Notification Settings</h1>
          <p className="text-sm text-slate-400">Choose what pings your bell — and what reaches your inbox. Everything is ON by default.</p>
        </div>
        <button onClick={save} disabled={busy || loading} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
          {busy ? 'Saving…' : '💾 Save preferences'}
        </button>
      </div>

      {msg && (
        <div className={`mb-3 rounded-lg px-3 py-2 text-sm ${msg.startsWith('✅') ? 'bg-green-500/10 text-green-300' : 'bg-red-500/10 text-red-300'}`}>{msg}</div>
      )}
      {loading && <p className="text-sm text-slate-500">Loading preferences…</p>}

      {!loading && (
        <div className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-800">
          <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-slate-700 bg-slate-900/50 px-5 py-2.5 text-xs font-bold uppercase text-slate-400">
            <span>Category</span>
            <span className="w-16 text-center">🔔 In-app</span>
            <span className="w-16 text-center">📧 Email</span>
          </div>
          {categories.map((cat) => {
            const [emoji, label] = LABELS[cat] || ['🔔', cat];
            return (
              <div key={cat} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-slate-700/50 px-5 py-3 last:border-0">
                <span className="text-sm font-semibold text-slate-200">{emoji} {label}</span>
                <span className="flex w-16 justify-center"><Toggle on={inapp[cat] !== false} onClick={() => flip(inapp, setInapp)(cat)} /></span>
                <span className="flex w-16 justify-center"><Toggle on={email[cat] !== false} onClick={() => flip(email, setEmail)(cat)} /></span>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-3 text-xs text-slate-500">
        Emails are sent by a background queue — the app never waits on them. 🚀
      </p>
    </div>
  );
}