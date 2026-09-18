import { useCallback, useEffect, useState } from 'react';
import { AlarmClock, Banknote, Bell, CalendarDays, CreditCard, FileText, FolderOpen, ListTodo, Mail, Megaphone, Palmtree, Settings, Ticket } from 'lucide-react';
import { getNotifyPrefs, saveNotifyPrefs, obj } from '../../services/workService.js';

const LABELS = {
  LEAVE: [Palmtree, 'Leaves'],
  TASK: [ListTodo, 'Tasks'],
  PROJECT: [FolderOpen, 'Projects'],
  MEETING: [CalendarDays, 'Meetings'],
  ANNOUNCEMENT: [Megaphone, 'Announcements'],
  DOCUMENT: [FileText, 'Documents'],
  PAYROLL: [Banknote, 'Payroll'],
  BILLING: [CreditCard, 'Billing'],
  SUPPORT: [Ticket, 'Support'],
  SYSTEM: [Settings, 'System'],
  ATTENDANCE: [AlarmClock, 'Attendance'], // 31.13
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
  const [msgOk, setMsgOk] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = obj(await getNotifyPrefs());
      setCategories(d?.categories || Object.keys(LABELS));
      setInapp(d?.inapp || {});
      setEmail(d?.email || {});
    } catch (e) {
      setMsg('Could not load preferences');
      setMsgOk(false);
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
      setMsg('Preferences saved');
      setMsgOk(true);
      setTimeout(() => setMsg(''), 3000);
    } catch (e) {
      setMsg('Could not save');
      setMsgOk(false);
    }
    setBusy(false);
  };

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-100"><Bell className="h-6 w-6 text-indigo-400" />Notification Settings</h1>
          <p className="text-sm text-slate-400">Choose what pings your bell — and what reaches your inbox. Everything is ON by default.</p>
        </div>
        <button onClick={save} disabled={busy || loading} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
          {busy ? 'Saving…' : 'Save preferences'}
        </button>
      </div>

      {msg && (
        <div className={`mb-3 rounded-lg px-3 py-2 text-sm ${msgOk ? 'bg-green-500/10 text-green-300' : 'bg-red-500/10 text-red-300'}`}>{msg}</div>
      )}
      {loading && <p className="text-sm text-slate-500">Loading preferences…</p>}

      {!loading && (
        <div className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-800">
          <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-slate-700 bg-slate-900/50 px-5 py-2.5 text-xs font-bold uppercase text-slate-400">
            <span>Category</span>
            <span className="flex w-16 items-center justify-center gap-1 text-center"><Bell className="h-3.5 w-3.5" />In-app</span>
            <span className="flex w-16 items-center justify-center gap-1 text-center"><Mail className="h-3.5 w-3.5" />Email</span>
          </div>
          {categories.map((cat) => {
            const [Icon, label] = LABELS[cat] || [Bell, cat];
            return (
              <div key={cat} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-slate-700/50 px-5 py-3 last:border-0">
                <span className="flex items-center gap-2 text-sm font-semibold text-slate-200"><Icon className="h-4 w-4 text-slate-400" />{label}</span>
                <span className="flex w-16 justify-center"><Toggle on={inapp[cat] !== false} onClick={() => flip(inapp, setInapp)(cat)} /></span>
                <span className="flex w-16 justify-center"><Toggle on={email[cat] !== false} onClick={() => flip(email, setEmail)(cat)} /></span>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-3 text-xs text-slate-500">
        Emails are sent by a background queue — the app never waits on them.
      </p>
    </div>
  );
}