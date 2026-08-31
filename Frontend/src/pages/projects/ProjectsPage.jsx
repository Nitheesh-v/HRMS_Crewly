import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import api from '../../services/api';
import { listProjects, createProject, arr } from '../../services/workService.js';

const CREATE_ROLES = ['COMPANY_ADMIN', 'HR_MANAGER'];

const STATUS_META = {
  NOT_STARTED: { label: 'Not Started', cls: 'bg-slate-100 text-slate-600' },
  IN_PROGRESS: { label: 'In Progress', cls: 'bg-blue-100 text-blue-700' },
  ON_HOLD: { label: 'On Hold', cls: 'bg-amber-100 text-amber-700' },
  COMPLETED: { label: 'Completed', cls: 'bg-green-100 text-green-700' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-red-100 text-red-600' },
};
const PRIORITY_CLS = {
  LOW: 'bg-slate-100 text-slate-500',
  MEDIUM: 'bg-blue-50 text-blue-600',
  HIGH: 'bg-orange-100 text-orange-700',
  CRITICAL: 'bg-red-100 text-red-700',
};

const inp = 'w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-indigo-400';
const inpSm = 'rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-indigo-400';
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

const CreateProjectModal = ({ onClose, onCreated }) => {
  const [managers, setManagers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [form, setForm] = useState({
    name: '', description: '', priority: 'MEDIUM',
    startDate: '', endDate: '', managerId: '', departmentId: '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const users = arr(await api.get('/users'));
        setManagers(users.filter((u) => u.role === 'MANAGER'));
      } catch (e) { /* soft */ }
      try { setDepartments(arr(await api.get('/departments'))); } catch (e) { /* soft */ }
    })();
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    setErr('');
    if (!form.name.trim()) return setErr('Project name is required');
    if (!form.managerId) return setErr('Pick the Project Manager');
    setBusy(true);
    try {
      await createProject({
        name: form.name.trim(),
        description: form.description,
        priority: form.priority,
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        managerId: form.managerId,
        departmentId: form.departmentId || undefined,
      });
      onCreated?.();
      onClose();
    } catch (e) {
      setErr(e?.response?.data?.message || 'Could not create project');
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-800 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-700 px-6 py-4">
          <h2 className="text-lg font-bold text-slate-100">📁 Create Project</h2>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-700 hover:text-slate-200">✖</button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-4">
          {err && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{err}</div>}

          <input className={inp} placeholder="Project name *" value={form.name} onChange={set('name')} />
          <textarea className={inp} rows={2} placeholder="Description" value={form.description} onChange={set('description')} />

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

          <div className="grid grid-cols-2 gap-3">
            <select className={inp} value={form.priority} onChange={set('priority')}>
              {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select className={inp} value={form.departmentId} onChange={set('departmentId')}>
              <option value="">— Department —</option>
              {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
            </select>
          </div>

          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-slate-400">👤 Project Manager *</p>
            <select className={inp} value={form.managerId} onChange={set('managerId')}>
              <option value="">— Pick a Manager —</option>
              {managers.map((u) => <option key={u._id} value={u._id}>{u.name}{u.designation ? ` · ${u.designation}` : ''}</option>)}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              The Manager takes it from here — they assign Team Leads &amp; the team. You don't pick them here. 🛡️
            </p>
            {managers.length === 0 && (
              <p className="mt-1 text-xs text-amber-400">⚠️ No MANAGER-role users found — promote someone in User Management first.</p>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-700 px-6 py-3">
          <button onClick={onClose} className="rounded-lg px-4 py-1.5 text-sm font-semibold text-slate-300 hover:bg-slate-700">Cancel</button>
          <button disabled={busy} onClick={submit} className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default function ProjectsPage() {
  const navigate = useNavigate();
  const user = useSelector((s) => s.auth.user);
  const role = user?.role;
  const canCreate = CREATE_ROLES.includes(role);

  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (status) params.status = status;
      if (q) params.q = q;
      setProjects(arr(await listProjects(params)));
    } catch (e) {
      setMsg('❌ Could not load projects');
    }
    setLoading(false);
  }, [status, q]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">📁 Projects</h1>
          <p className="text-sm text-slate-400">Only projects inside your visibility are shown.</p>
        </div>
        {canCreate && (
          <button onClick={() => setShowCreate(true)} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">
            ＋ New Project
          </button>
        )}
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={inpSm}>
          <option value="">All statuses</option>
          {Object.keys(STATUS_META).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Search projects…" className={inpSm} />
      </div>

      {msg && <div className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{msg}</div>}
      {loading && <p className="text-sm text-slate-500">Loading projects…</p>}
      {!loading && projects.length === 0 && (
        <div className="rounded-2xl border border-dashed border-slate-700 p-10 text-center text-slate-400">
          <p className="text-3xl">🗂️</p>
          <p className="mt-2 text-sm">No projects in your scope yet{canCreate ? ' — create the first one!' : '.'}</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => {
          const sm = STATUS_META[p.status] || STATUS_META.NOT_STARTED;
          return (
            <div
              key={p._id}
              onClick={() => navigate(`/app/projects/${p._id}`)}
              className="cursor-pointer rounded-2xl border border-slate-700 bg-slate-800 p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-600 hover:shadow-md"
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <h3 className="font-bold text-slate-100">{p.name}</h3>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${sm.cls}`}>{sm.label}</span>
              </div>
              <div className="mb-2 flex flex-wrap gap-1 text-xs">
                <span className={`rounded-full px-2 py-0.5 font-semibold ${PRIORITY_CLS[p.priority] || ''}`}>{p.priority}</span>
                {p.department?.name && <span className="rounded-full bg-purple-500/15 px-2 py-0.5 font-semibold text-purple-300">{p.department.name}</span>}
              </div>
              <p className="mb-3 line-clamp-2 min-h-[1rem] text-xs text-slate-400">{p.description || ' '}</p>

              <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
                <span>Progress</span>
                <span className="font-semibold text-slate-200">{p.progress}% · {p.doneCount}/{p.taskCount} tasks</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-700">
                <div className={`h-full rounded-full transition-all ${p.progress === 100 ? 'bg-green-500' : 'bg-indigo-500'}`} style={{ width: `${p.progress}%` }} />
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-slate-700 pt-2 text-xs text-slate-400">
                <span>👤 {p.manager?.name || '—'} · 🧑‍🤝‍🧑 {p.teamLeads?.length || 0} TL</span>
                <span>{fmtDate(p.startDate)} → {fmtDate(p.endDate)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {showCreate && <CreateProjectModal onClose={() => setShowCreate(false)} onCreated={() => { setMsg(''); load(); }} />}
    </div>
  );
}