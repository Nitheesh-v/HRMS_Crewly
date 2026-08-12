import { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { listTasks, arr } from '../../services/workService.js';
import TaskDetailModal, { STATUS_META, PRIORITY_META } from '../../components/TaskDetailModal.jsx';
import CreateTaskModal from '../../components/CreateTaskModal.jsx';

const ASSIGN_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD'];

const inpSm = 'rounded-lg border border-slate-600 bg-slate-800 px-3 py-1 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-indigo-400';
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—');
const todayISO = () => new Date().toISOString().slice(0, 10);
const isOverdue = (t) => t.dueDate && t.status !== 'COMPLETED' && String(t.dueDate).slice(0, 10) < todayISO();

export default function TasksPage() {
  const user = useSelector((s) => s.auth.user);
  const role = user?.role;
  const canAssign = ASSIGN_ROLES.includes(role);

  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState(role === 'EMPLOYEE' ? 'mine' : 'all');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (view !== 'all') params.view = view;
      if (status) params.status = status;
      if (priority) params.priority = priority;
      if (q) params.q = q;
      setTasks(arr(await listTasks(params)));
    } catch (e) {
      setMsg('❌ Could not load tasks');
    }
    setLoading(false);
  }, [view, status, priority, q]);

  useEffect(() => { load(); }, [load]);

  const tab = (v, label) => (
    <button
      key={v}
      onClick={() => setView(v)}
      className={`rounded-full px-3 py-1 text-sm font-semibold ${
        view === v ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
      }`}
    >
      {label}
    </button>
  );

  const okMsg = msg.startsWith('✅');

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">📝 Tasks</h1>
          <p className="text-sm text-slate-400">
            {role === 'EMPLOYEE' ? 'Your assigned work — submit for review when done.' : 'Everything inside your team scope.'}
          </p>
        </div>
        {canAssign && (
          <button onClick={() => setShowCreate(true)} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">
            ＋ Assign Task
          </button>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {tab('all', 'All in scope')}
        {tab('mine', '👤 My tasks')}
        {canAssign && tab('created', '📤 Assigned by me')}
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={inpSm}>
          <option value="">All statuses</option>
          {Object.keys(STATUS_META).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} className={inpSm}>
          <option value="">All priorities</option>
          {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Search…" className={inpSm} />
      </div>

      {msg && (
        <div className={`mb-3 rounded-lg px-3 py-2 text-sm ${okMsg ? 'bg-green-500/10 text-green-300' : 'bg-red-500/10 text-red-300'}`}>
          {msg}
        </div>
      )}
      {loading && <p className="text-sm text-slate-500">Loading tasks…</p>}
      {!loading && tasks.length === 0 && (
        <div className="rounded-2xl border border-dashed border-slate-700 p-10 text-center text-slate-400">
          <p className="text-3xl">✨</p>
          <p className="mt-2 text-sm">No tasks here.</p>
        </div>
      )}

      {!loading && tasks.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-800 shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900/50 text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-2.5">Task</th>
                <th className="px-4 py-2.5">Assignee</th>
                <th className="px-4 py-2.5">Priority</th>
                <th className="px-4 py-2.5">Due</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const sm = STATUS_META[t.status] || STATUS_META.TODO;
                return (
                  <tr key={t._id} onClick={() => setOpenId(t._id)} className="cursor-pointer border-t border-slate-700 hover:bg-slate-700/40">
                    <td className="px-4 py-2.5">
                      <p className="font-semibold text-slate-100">{t.title}</p>
                      {t.project?.name && <p className="text-xs text-indigo-400">📁 {t.project.name}</p>}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-1.5 text-slate-300">
                        {t.assignedTo?.avatarUrl
                          ? <img src={t.assignedTo.avatarUrl} alt="" className="h-5 w-5 rounded-full object-cover" />
                          : '👤'}
                        {t.assignedTo?.name || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${PRIORITY_META[t.priority] || ''}`}>{t.priority}</span>
                    </td>
                    <td className={`px-4 py-2.5 ${isOverdue(t) ? 'font-bold text-red-400' : 'text-slate-400'}`}>
                      {fmtDate(t.dueDate)}{isOverdue(t) ? ' ⚠️' : ''}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${sm.cls}`}>{sm.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {openId && <TaskDetailModal taskId={openId} onClose={() => setOpenId(null)} onChanged={load} />}
      {showCreate && (
        <CreateTaskModal
          onClose={() => setShowCreate(false)}
          onCreated={(n) => { setMsg(n > 1 ? `✅ ${n} tasks created` : '✅ Task created'); load(); setTimeout(() => setMsg(''), 4000); }}
        />
      )}
    </div>
  );
}