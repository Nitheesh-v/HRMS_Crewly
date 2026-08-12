import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSelector } from 'react-redux';
import api from '../../services/api';
import { getProject, updateProject, deleteProject, arr, obj } from '../../services/workService.js';
import TaskDetailModal, { STATUS_META, PRIORITY_META } from '../../components/TaskDetailModal.jsx';
import CreateTaskModal from '../../components/CreateTaskModal.jsx';

const ASSIGN_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD'];
const COLUMNS = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'COMPLETED', 'BLOCKED'];
const P_STATUS = {
  NOT_STARTED: { label: 'Not Started', cls: 'bg-slate-100 text-slate-600' },
  IN_PROGRESS: { label: 'In Progress', cls: 'bg-blue-100 text-blue-700' },
  ON_HOLD: { label: 'On Hold', cls: 'bg-amber-100 text-amber-700' },
  COMPLETED: { label: 'Completed', cls: 'bg-green-100 text-green-700' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-red-100 text-red-600' },
};

const inp = 'w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-indigo-400';
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');
const toInputDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const todayISO = () => new Date().toISOString().slice(0, 10);
const isOverdue = (t) => t.dueDate && t.status !== 'COMPLETED' && String(t.dueDate).slice(0, 10) < todayISO();

function EditProjectModal({ project, isAdmin, onClose, onSaved }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({
    name: project.name || '',
    description: project.description || '',
    priority: project.priority || 'MEDIUM',
    status: project.status || 'NOT_STARTED',
    startDate: toInputDate(project.startDate),
    endDate: toInputDate(project.endDate),
    managerId: String(project.manager?._id || project.manager || ''),
  });
  const [teamLeads, setTeamLeads] = useState((project.teamLeads || []).map((t) => String(t._id || t)));
  const [members, setMembers] = useState((project.members || []).map((m) => String(m._id || m)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try { setUsers(arr(await api.get('/users'))); } catch (e) { /* picker fails soft */ }
    })();
  }, []);

  const tlCandidates = users.filter((u) => ['TEAM_LEAD', 'MANAGER'].includes(u.role));
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (setter) => (id) => setter((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const submit = async () => {
    setErr('');
    if (!form.name.trim()) return setErr('Project name is required');
    setBusy(true);
    try {
      await updateProject(project._id, {
        name: form.name.trim(),
        description: form.description,
        priority: form.priority,
        status: form.status,
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        teamLeadIds: teamLeads,
        memberIds: members,
        ...(isAdmin ? { managerId: form.managerId || undefined } : {}),
      });
      onSaved?.();
      onClose();
    } catch (e) {
      setErr(e?.response?.data?.message || 'Could not save project');
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-800 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-700 px-6 py-4">
          <h2 className="text-lg font-bold text-slate-100">✏️ Manage Project</h2>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-700 hover:text-slate-200">✖</button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
          {err && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{err}</div>}

          <input className={inp} placeholder="Project name *" value={form.name} onChange={set('name')} />
          <textarea className={inp} rows={2} placeholder="Description" value={form.description} onChange={set('description')} />

          <div className="grid grid-cols-2 gap-3">
            <select className={inp} value={form.status} onChange={set('status')}>
              {Object.keys(P_STATUS).map((s) => <option key={s} value={s}>{P_STATUS[s].label}</option>)}
            </select>
            <select className={inp} value={form.priority} onChange={set('priority')}>
              {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="mb-1 text-xs font-semibold text-slate-400">Start date</p>
              <input type="date" className={inp} value={form.startDate} onChange={set('startDate')} />
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold text-slate-400">End date</p>
              <input type="date" className={inp} value={form.endDate} onChange={set('endDate')} />
            </div>
          </div>

          {isAdmin && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase text-slate-400">👤 Project Manager</p>
              <select className={inp} value={form.managerId} onChange={set('managerId')}>
                {users.filter((u) => ['MANAGER', 'COMPANY_ADMIN', 'HR_MANAGER'].includes(u.role)).map((u) => (
                  <option key={u._id} value={u._id}>{u.name} · {u.designation || u.role}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-slate-400">🧑‍🤝‍🧑 Team Leads ({teamLeads.length})</p>
            <div className="max-h-32 overflow-y-auto rounded-xl border border-slate-700">
              {tlCandidates.length === 0 && <p className="px-3 py-2 text-xs text-slate-500">No Team Leads in your department yet.</p>}
              {tlCandidates.map((u) => (
                <label key={u._id} className="flex cursor-pointer items-center gap-2 border-b border-slate-700/50 px-3 py-1.5 text-sm last:border-0 hover:bg-slate-700/40">
                  <input type="checkbox" checked={teamLeads.includes(u._id)} onChange={() => toggle(setTeamLeads)(u._id)} />
                  <span className="text-slate-200">{u.name} <span className="text-xs text-slate-400">{u.designation || u.role}</span></span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">Team Leads get a 🔔 and become the task-assigners for their teams.</p>
          </div>

          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-slate-400">Team members ({members.length})</p>
            <div className="max-h-32 overflow-y-auto rounded-xl border border-slate-700">
              {users.map((u) => (
                <label key={u._id} className="flex cursor-pointer items-center gap-2 border-b border-slate-700/50 px-3 py-1.5 text-sm last:border-0 hover:bg-slate-700/40">
                  <input type="checkbox" checked={members.includes(u._id)} onChange={() => toggle(setMembers)(u._id)} />
                  <span className="text-slate-200">{u.name} <span className="text-xs text-slate-400">{u.designation || u.role}</span></span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">Manager &amp; Team Leads are always included automatically.</p>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-700 px-6 py-3">
          <button onClick={onClose} className="rounded-lg px-4 py-1.5 text-sm font-semibold text-slate-300 hover:bg-slate-700">Cancel</button>
          <button disabled={busy} onClick={submit} className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ProjectDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const user = useSelector((s) => s.auth.user);
  const role = user?.role;

  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [openTaskId, setOpenTaskId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  const load = useCallback(async () => {
    setErr('');
    try {
      setData(obj(await getProject(id)));
    } catch (e) {
      setErr(e?.response?.data?.message || 'Could not load project');
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (err) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">{err}</div>
        <button onClick={() => navigate('/app/projects')} className="mt-3 text-sm font-semibold text-indigo-400 hover:underline">← Back to projects</button>
      </div>
    );
  }
  if (!data) return <p className="p-6 text-sm text-slate-500">Loading project…</p>;

  const { project, tasks = [], stats = {}, progress = 0 } = data;
  const me = String(user?._id || '');
  const isAdmin = ['COMPANY_ADMIN', 'HR_MANAGER'].includes(role);
  const isManagerHere = String(project.manager?._id || project.manager) === me;
  const canEdit = isAdmin || isManagerHere;
  const tlCount = project.teamLeads?.length || 0;
  const managerBlocked = role === 'MANAGER' && tlCount > 0;
  const showAddTask = ASSIGN_ROLES.includes(role) && !managerBlocked;
  const sm = P_STATUS[project.status] || P_STATUS.NOT_STARTED;

  const remove = async () => {
    if (!window.confirm('Delete this project AND all its tasks?')) return;
    try {
      await deleteProject(project._id);
      navigate('/app/projects');
    } catch (e) {
      setErr(e?.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <button onClick={() => navigate('/app/projects')} className="mb-3 text-sm font-semibold text-indigo-400 hover:underline">← All projects</button>

      {/* header card */}
      <div className="mb-4 rounded-2xl border border-slate-700 bg-slate-800 p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-slate-100">{project.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              <span className={`rounded-full px-2 py-0.5 font-semibold ${sm.cls}`}>{sm.label}</span>
              <span className={`rounded-full px-2 py-0.5 font-semibold ${PRIORITY_META[project.priority] || ''}`}>{project.priority}</span>
              {project.department?.name && <span className="rounded-full bg-purple-500/15 px-2 py-0.5 font-semibold text-purple-300">{project.department.name}</span>}
            </div>
            {project.description && <p className="mt-2 max-w-2xl text-sm text-slate-400">{project.description}</p>}
            <p className="mt-2 text-xs text-slate-400">
              👤 Manager: <b className="text-slate-200">{project.manager?.name || '—'}</b>
              {tlCount > 0 && <> · 🧑‍🤝‍🧑 TL: <b className="text-slate-200">{project.teamLeads.map((t) => t.name).join(', ')}</b></>}
              {' '}· 📅 {fmtDate(project.startDate) || '—'} → {fmtDate(project.endDate) || '—'}
              {' '}· 👥 {project.members?.length || 0} members
            </p>
          </div>

          <div className="flex flex-col items-end gap-2">
            <div className="flex gap-2">
              {showAddTask && (
                <button onClick={() => setShowCreate(true)} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">
                  ＋ Add Task
                </button>
              )}
              {canEdit && (
                <button onClick={() => setShowEdit(true)} className="rounded-xl bg-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-600">
                  ✏️ Manage
                </button>
              )}
            </div>
            {managerBlocked && (
              <p className="max-w-[220px] text-right text-xs text-slate-500">🧑‍🤝‍🧑 Team Leads assign tasks here — you monitor 📊</p>
            )}
            {isAdmin && (
              <button onClick={remove} className="text-xs font-semibold text-red-400 hover:text-red-300">🗑 Delete project</button>
            )}
          </div>
        </div>

        {/* progress */}
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-xs text-slate-400">
            <span>
              {stats.done || 0}/{stats.total || 0} completed
              {stats.inReview ? ` · ${stats.inReview} in review` : ''}
              {stats.blocked ? ` · 🚧 ${stats.blocked} blocked` : ''}
            </span>
            <span className="font-bold text-slate-200">{progress}%</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-slate-700">
            <div className={`h-full rounded-full transition-all ${progress === 100 ? 'bg-green-500' : 'bg-indigo-500'}`} style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>

      {/* board */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col);
          const cm = STATUS_META[col];
          return (
            <div key={col} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-2">
              <p className="mb-2 flex items-center justify-between px-1 text-xs font-bold uppercase text-slate-400">
                {cm.label}
                <span className={`rounded-full px-1.5 ${cm.cls}`}>{colTasks.length}</span>
              </p>
              <div className="space-y-2">
                {colTasks.map((t) => (
                  <div
                    key={t._id}
                    onClick={() => setOpenTaskId(t._id)}
                    className="cursor-pointer rounded-xl border border-slate-700 bg-slate-800 p-3 text-sm shadow-sm hover:border-slate-600"
                  >
                    <p className="font-semibold text-slate-100">{t.title}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs">
                      <span className={`rounded-full px-1.5 py-0.5 font-semibold ${PRIORITY_META[t.priority] || ''}`}>{t.priority}</span>
                      {t.dueDate && (
                        <span className={isOverdue(t) ? 'font-bold text-red-400' : 'text-slate-400'}>
                          📅 {fmtDate(t.dueDate)}{isOverdue(t) ? ' ⚠️' : ''}
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 flex items-center gap-1 text-xs text-slate-400">
                      {t.assignedTo?.avatarUrl
                        ? <img src={t.assignedTo.avatarUrl} alt="" className="h-4 w-4 rounded-full object-cover" />
                        : '👤'}
                      {t.assignedTo?.name || '—'}
                    </p>
                  </div>
                ))}
                {colTasks.length === 0 && <p className="px-1 py-3 text-center text-xs text-slate-600">—</p>}
              </div>
            </div>
          );
        })}
      </div>

      {openTaskId && <TaskDetailModal taskId={openTaskId} onClose={() => setOpenTaskId(null)} onChanged={load} />}
      {showCreate && <CreateTaskModal presetProjectId={project._id} onClose={() => setShowCreate(false)} onCreated={() => load()} />}
      {showEdit && <EditProjectModal project={project} isAdmin={isAdmin} onClose={() => setShowEdit(false)} onSaved={load} />}
    </div>
  );
}