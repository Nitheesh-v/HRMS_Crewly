import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import api from '../services/api';
import { listProjects, createTask, arr } from '../services/workService.js';

// 🎨 dark-theme input (all fields share this one constant — edit here to recolor everything)
const inp = 'w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-indigo-400';

export default function CreateTaskModal({ presetProjectId = '', onClose, onCreated }) {
  const user = useSelector((s) => s.auth.user);
  const role = user?.role;
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [form, setForm] = useState({ title: '', description: '', projectId: presetProjectId, priority: 'MEDIUM', dueDate: '' });
  const [assignees, setAssignees] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try { setUsers(arr(await api.get('/users'))); } catch (e) { /* soft */ }
      try { setProjects(arr(await listProjects())); } catch (e) { /* soft */ }
    })();
  }, []);

  // TL → only employees under them (backend double-checks). Others → their scoped list as-is.
  const pickable = role === 'TEAM_LEAD'
    ? users.filter((u) => u.role === 'EMPLOYEE' || u._id === user?._id)
    : users;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (id) => setAssignees((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const submit = async () => {
    setErr('');
    if (!form.title.trim()) return setErr('Task title is required');
    if (!assignees.length) return setErr('Pick at least one employee');
    setBusy(true);
    try {
      await createTask({
        title: form.title.trim(),
        description: form.description,
        projectId: form.projectId || null,
        priority: form.priority,
        dueDate: form.dueDate || null,
        assigneeIds: assignees,
      });
      onCreated?.(assignees.length);
      onClose();
    } catch (e) {
      setErr(e?.response?.data?.message || 'Could not create task');
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-800 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-700 px-6 py-4">
          <h2 className="text-lg font-bold text-slate-100">📝 Create Task</h2>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-700 hover:text-slate-200">✖</button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
          {err && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{err}</div>}

          <input className={inp} placeholder="Task title *" value={form.title} onChange={set('title')} />
          <textarea className={inp} rows={2} placeholder="Description" value={form.description} onChange={set('description')} />

          <div className="grid grid-cols-2 gap-3">
            <select className={inp} value={form.projectId} onChange={set('projectId')}>
              <option value="">— No project —</option>
              {projects.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
            </select>
            <select className={inp} value={form.priority} onChange={set('priority')}>
              {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>

          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-slate-400">Deadline</p>
            <input type="date" className={inp} value={form.dueDate} onChange={set('dueDate')} />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase text-slate-400">Assign to ({assignees.length})</p>
              <div className="flex gap-2 text-xs font-semibold">
                <button type="button" onClick={() => setAssignees(pickable.map((u) => u._id))} className="text-indigo-400 hover:underline">👥 Select whole team</button>
                <button type="button" onClick={() => setAssignees([])} className="text-slate-400 hover:underline">Clear</button>
              </div>
            </div>
            <div className="max-h-40 overflow-y-auto rounded-xl border border-slate-700">
              {pickable.length === 0 && <p className="px-3 py-2 text-xs text-slate-500">No people in your scope.</p>}
              {pickable.map((u) => (
                <label key={u._id} className="flex cursor-pointer items-center gap-2 border-b border-slate-700/50 px-3 py-1.5 text-sm last:border-0 hover:bg-slate-700/40">
                  <input type="checkbox" checked={assignees.includes(u._id)} onChange={() => toggle(u._id)} />
                  <span className="text-slate-200">
                    {u.name}{u._id === user?._id ? ' (me)' : ''}
                    <span className="ml-1 text-xs text-slate-400">{u.designation || u.role}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">One task is created per selected person — perfect for team-wide work.</p>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-700 px-6 py-3">
          <button onClick={onClose} className="rounded-lg px-4 py-1.5 text-sm font-semibold text-slate-300 hover:bg-slate-700">Cancel</button>
          <button disabled={busy} onClick={submit} className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
            {busy ? 'Creating…' : `Create ${assignees.length > 1 ? `${assignees.length} tasks` : 'task'}`}
          </button>
        </div>
      </div>
    </div>
  );
}