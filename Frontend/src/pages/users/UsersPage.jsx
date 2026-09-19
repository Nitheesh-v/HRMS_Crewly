import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, KeyRound, Landmark, Pencil, Users, Info, Search, UserCircle } from 'lucide-react';
import api from '../../services/api';
import Modal from '../../components/Modal';
import useAuth from '../../hooks/useAuth';
import permissionService from '../../services/permissionService.js';
import { ROLES, CREATION_RIGHTS, ROLE_STYLES, roleLabel } from '../../utils/roles';

const EMPTY_FORM = {
  name: '', email: '', password: '', role: 'EMPLOYEE', department: '', reportingTo: '', status: 'ACTIVE',
  employeeCode: '', designation: '', dateOfBirth: '', dateOfJoining: '',
  pan: '', uan: '', esic: '', bankAccount: '', ifsc: '',
};
const isoDate = (d) => (d ? String(d).slice(0, 10) : '');

export default function UsersPage() {
  const { user: me } = useAuth();
  const myId = String(me?._id || me?.id || '');
  const [companyRoles, setCompanyRoles] = useState([]);
  const creatable = CREATION_RIGHTS[me?.role] || [];
  const manages = (role) => creatable.includes(role);
  const roleOptions = [
    ...creatable.map((code) => ({ code, label: roleLabel(code) })),
    ...companyRoles.map((role) => ({ code: role.code, label: role.name || role.code })),
  ];
  const ROLE_ASSIGNERS = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];
  const canAssignCompanyRoles = ROLE_ASSIGNERS.includes(me?.role);
  const assignable = canAssignCompanyRoles ? roleOptions : creatable.map((code) => ({ code, label: roleLabel(code) }));
  const isKnownRole = (role) => assignable.some((option) => option.code === role) || role === me?.role;

  const [users, setUsers] = useState([]);
  const [options, setOptions] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [meta, setMeta] = useState({ page: 1, pages: 1, total: 0 });
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ search: '', role: '', department: '', status: '' });
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState(null);

  const [modal, setModal] = useState({ open: false, mode: 'create', user: null });
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [pwModal, setPwModal] = useState({ open: false, user: null, password: '', confirm: '' });
  const [pwSaving, setPwSaving] = useState(false);

  const flash = (type, text) => { setBanner({ type, text }); setTimeout(() => setBanner(null), 4000); };
  const errText = (err) => err?.response?.data?.message || err?.message || 'Something went wrong';
  const extractUsers = (res) => {
    const payload = res?.data ?? res;
    if (Array.isArray(payload)) return { list: payload, meta: null };
    return { list: payload?.users || [], meta: res?.meta || payload?.meta || null };
  };
  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 10 };
      Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
      const res = await api.get('/users', { params });
      const { list, meta: m } = extractUsers(res);
      setUsers(list);
      setMeta(m || { page: 1, pages: 1, total: list.length });
    } catch (err) { flash('error', errText(err)); } finally { setLoading(false); }
  }, [page, filters]);
  const loadOptions = useCallback(async () => {
    try { const res = await api.get('/users', { params: { limit: 200 } }); setOptions(extractUsers(res).list); } catch {}
  }, []);
  useEffect(() => { loadUsers(); }, [loadUsers]);
  useEffect(() => {
    loadOptions();
    (async () => {
      try { const res = await api.get('/departments'); setDepartments(Array.isArray(res) ? res : res?.departments || res?.data || []); } catch {}
    })();
  }, [loadOptions]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const openCreate = () => { setForm({ ...EMPTY_FORM, role: assignable[assignable.length - 1]?.code || 'EMPLOYEE' }); setModal({ open: true, mode: 'create', user: null }); };
  const openEdit = (u) => {
    setForm({
      name: u.name || '', email: u.email || '', password: '', role: u.role,
      department: u.department?._id || '', reportingTo: u.reportingTo?._id || '', status: u.status || 'ACTIVE',
      employeeCode: u.employeeCode || '', designation: u.designation || '',
      dateOfBirth: isoDate(u.dateOfBirth), dateOfJoining: isoDate(u.dateOfJoining),
      pan: u.pan || '', uan: u.uan || '', esic: u.esic || '',
      bankAccount: u.bankAccount || '', ifsc: u.ifsc || '',
    });
    setModal({ open: true, mode: 'edit', user: u });
  };
  const submit = async (e) => {
    e.preventDefault(); setSaving(true);
    try {
      const payload = {
        name: form.name.trim(), role: form.role, department: form.department || '', reportingTo: form.reportingTo || '',
        employeeCode: form.employeeCode.trim(), designation: form.designation.trim(),
        dateOfBirth: form.dateOfBirth || '', dateOfJoining: form.dateOfJoining || '',
        pan: form.pan.trim().toUpperCase(), uan: form.uan.trim(), esic: form.esic.trim(),
        bankAccount: form.bankAccount.trim(), ifsc: form.ifsc.trim().toUpperCase(),
      };
      if (modal.mode === 'create') { payload.email = form.email.trim(); payload.password = form.password; await api.post('/users', payload); flash('success', `User ${payload.name} created`); }
      else {
        const u = modal.user; const isSelf = String(u._id) === myId;
        if (isSelf) delete payload.role;
        if (!isSelf && manages(u.role)) payload.status = form.status;
        await api.patch(`/users/${u._id}`, payload); flash('success', 'User updated');
      }
      setModal({ open: false, mode: 'create', user: null }); loadUsers(); loadOptions();
    } catch (err) { flash('error', errText(err)); } finally { setSaving(false); }
  };
  const submitPassword = async (e) => {
    e.preventDefault();
    if (pwModal.password !== pwModal.confirm) return flash('error', 'Passwords do not match');
    setPwSaving(true);
    try { await api.post(`/users/${pwModal.user._id}/reset-password`, { newPassword: pwModal.password }); flash('success', `Password reset for ${pwModal.user.name}`); setPwModal({ open: false, user: null, password: '', confirm: '' }); } catch (err) { flash('error', errText(err)); } finally { setPwSaving(false); }
  };
  const editingSelf = modal.user && String(modal.user._id) === myId;
  const roleEditable = modal.mode === 'create' || (!editingSelf && (manages(modal.user?.role) || (canAssignCompanyRoles && isKnownRole(modal.user?.role))));

  const activeCount = users.filter(u => u.status === 'ACTIVE').length;

  return (
    <div className="min-h-[calc(100dvh-64px)] bg-[#F5F7FB] dark:bg-crewly-bg -m-3 sm:-m-4 lg:-m-6 p-3 sm:p-4 lg:p-6">
      <div className="mx-auto max-w-[1160px]">
        <p className="text-[11px] tracking-wide text-slate-500 dark:text-white/60"><Link to="/app" className="hover:text-slate-800 dark:hover:text-white">Dashboard</Link> <span className="mx-1">›</span> People <span className="mx-1">›</span> <span className="text-slate-800 dark:text-white">Employees</span></p>
        <p className="mt-0.5 text-[11px] text-slate-400 dark:text-white/40">Manage &gt; People &gt; Employees</p>

        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-[22px] font-extrabold tracking-tight text-slate-800 dark:text-white"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#0f1a2b] text-white dark:bg-white dark:text-slate-900"><Users className="h-4 w-4" /></span>Employees</h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-white/60">{meta.total} people in your company · manage directory, roles and hierarchy</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-[#E6E9F0] bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-white/70"><span className="h-1.5 w-1.5 rounded-full bg-[#00C875]" /> {meta.total} total</span>
            {creatable.length > 0 && <button className="inline-flex items-center justify-center rounded-full bg-[#00C875] px-4 py-2 text-sm font-semibold text-white hover:brightness-105" onClick={openCreate}>+ Add Employee</button>}
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-[#E6E9F0] bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.04]"><div className="flex items-start justify-between"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-white/5"><Users className="h-4 w-4" /></div><span className="text-lg font-extrabold text-slate-800 dark:text-white">{meta.total}</span></div><p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-white/60">Total Employees</p><p className="mt-1 text-xs text-slate-600 dark:text-white/70">{departments.length} departments</p></div>
          <div className="rounded-xl border border-[#E6E9F0] bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.04]"><div className="flex items-start justify-between"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-white/5 dark:text-emerald-400"><UserCircle className="h-4 w-4" /></div><span className="text-lg font-extrabold text-emerald-600">{activeCount}</span></div><p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-white/60">Active</p><p className="mt-1 text-xs text-slate-600 dark:text-white/70">{users.length - activeCount} inactive</p></div>
          <div className="rounded-xl border border-[#E6E9F0] bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.04]"><div className="flex items-start justify-between"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-white/5"><Building2 className="h-4 w-4" /></div><span className="text-lg font-extrabold text-slate-800 dark:text-white">{departments.length}</span></div><p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-white/60">Departments</p><p className="mt-1 text-xs text-slate-600 dark:text-white/70">Across company</p></div>
          <div className="rounded-xl border border-[#E6E9F0] bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.04]"><div className="flex items-start justify-between"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-white/5"><KeyRound className="h-4 w-4" /></div><span className="text-lg font-extrabold text-slate-800 dark:text-white">{roleOptions.length}</span></div><p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-white/60">Assignable Roles</p><p className="mt-1 text-xs text-slate-600 dark:text-white/70">Including company roles</p></div>
        </div>

        <div className="mt-4 flex items-start gap-3 rounded-xl border border-[#dbe4ff] bg-[#eef2ff] px-4 py-3 text-xs leading-relaxed text-[#3b5bdb] dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300"><Info className="mt-0.5 h-4 w-4 shrink-0" /><p>Search by name or email, filter by role and department. Roles reflect your permissions — you can only create roles below your own.</p></div>

        {banner && <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${banner.type === 'error' ? 'border-red-200 bg-red-50 text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400' : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300'}`}>{banner.text}</div>}

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-[#E6E9F0] bg-white p-3 shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input className="w-full rounded-full border border-[#E6E9F0] bg-[#F5F7FB] py-2 pl-9 pr-3 text-sm outline-none focus:border-[#00C875] focus:ring-2 focus:ring-[#00C875]/20 dark:border-white/10 dark:bg-white/5 dark:text-white" placeholder="Search name or email…" value={filters.search} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, search: e.target.value })); }} />
          </div>
          <div className="flex gap-2">
            <select className="flex-1 sm:flex-none rounded-full border border-[#E6E9F0] bg-white px-3 py-2 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" value={filters.role} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, role: e.target.value })); }}><option value="">All roles</option>{[...[ROLES.HR_MANAGER, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE].map((r) => <option key={r} value={r}>{roleLabel(r)}</option>), ...companyRoles.map((role) => <option key={role.code} value={role.code}>{role.name || roleLabel(role.code)}</option>)]}</select>
            <select className="flex-1 sm:flex-none rounded-full border border-[#E6E9F0] bg-white px-3 py-2 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" value={filters.department} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, department: e.target.value })); }}><option value="">All depts</option>{departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}</select>
            <select className="hidden sm:block rounded-full border border-[#E6E9F0] bg-white px-3 py-2 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" value={filters.status} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, status: e.target.value })); }}><option value="">Any status</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-[#E6E9F0] bg-white shadow-sm dark:border-white/10 dark:bg-white/[0.04]">
          <div className="overflow-x-auto">
            <table className="min-w-[900px] w-full text-sm">
              <thead><tr className="border-b border-[#E6E9F0] text-left text-[11px] uppercase tracking-wide text-slate-500 dark:border-white/10 dark:text-white/60"><th className="px-4 py-3 font-semibold">Employee</th><th className="px-3 py-3 font-semibold">Role</th><th className="px-3 py-3 font-semibold">Department</th><th className="px-3 py-3 font-semibold">Reports To</th><th className="px-3 py-3 font-semibold">Status</th><th className="px-4 py-3 text-right font-semibold">Actions</th></tr></thead>
              <tbody>
                {loading ? <tr><td className="p-6 text-center text-sm text-slate-400" colSpan={6}>Loading…</td></tr>
                  : users.length === 0 ? <tr><td className="p-6 text-center text-sm text-slate-400" colSpan={6}>No users found.</td></tr>
                    : users.map((u) => (
                      <tr key={u._id} className="border-b border-[#E6E9F0]/70 last:border-0 hover:bg-slate-50/60 dark:border-white/5 dark:hover:bg-white/[0.02]">
                        <td className="px-4 py-3"><div className="flex items-center gap-3"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#F5F7FB] text-xs font-bold text-slate-600 dark:bg-white/10 dark:text-white/80">{u.name?.[0]?.toUpperCase()}</div><div className="min-w-0"><div className="truncate text-sm font-semibold text-slate-800 dark:text-white">{u.name}</div><div className="truncate text-xs text-slate-500 dark:text-white/60">{u.email}</div></div></div></td>
                        <td className="px-3 py-3"><span className={`${ROLE_STYLES[u.role] || 'inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold dark:bg-white/10 dark:text-white'}`}>{roleLabel(u.role)}</span></td>
                        <td className="px-3 py-3 text-slate-700 dark:text-white/80">{u.department?.name || '—'}</td>
                        <td className="px-3 py-3 text-slate-700 dark:text-white/80">{u.reportingTo?.name || '—'}</td>
                        <td className="px-3 py-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${u.status === 'ACTIVE' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-red-500/15 text-red-500'}`}>{u.status}</span></td>
                        <td className="px-4 py-3 text-right"><div className="flex justify-end gap-1.5">{(manages(u.role) || String(u._id) === myId) && <button className="inline-flex items-center gap-1 rounded-full border border-[#E6E9F0] bg-white px-3 py-1 text-xs font-semibold hover:border-[#00C875]/40 dark:border-white/10 dark:bg-white/5" onClick={() => openEdit(u)}><Pencil className="h-3 w-3" />Edit</button>}{manages(u.role) && String(u._id) !== myId && <button className="inline-flex items-center gap-1 rounded-full border border-[#E6E9F0] bg-white px-3 py-1 text-xs font-semibold hover:border-[#00C875]/40 dark:border-white/10 dark:bg-white/5" onClick={() => setPwModal({ open: true, user: u, password: '', confirm: '' })}><KeyRound className="h-3 w-3" />Reset</button>}</div></td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-t border-[#E6E9F0] px-4 py-3 text-sm text-slate-500 dark:border-white/10 dark:text-white/60"><span>Page {meta.page} of {meta.pages} · {meta.total} people</span><div className="flex gap-2"><button className="flex-1 sm:flex-none rounded-full border border-[#E6E9F0] bg-white px-4 py-1.5 text-sm font-semibold hover:border-[#00C875]/40 disabled:opacity-40 dark:border-white/10 dark:bg-white/5" disabled={meta.page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</button><button className="flex-1 sm:flex-none rounded-full border border-[#E6E9F0] bg-white px-4 py-1.5 text-sm font-semibold hover:border-[#00C875]/40 disabled:opacity-40 dark:border-white/10 dark:bg-white/5" disabled={meta.page >= meta.pages} onClick={() => setPage((p) => p + 1)}>Next →</button></div></div>
        </div>

        {/* modals reused — unchanged logic but figma card styling via Modal */}
        {modal.open && (
          <Modal onClose={() => setModal({ open: false, mode: 'create', user: null })} title={modal.mode === 'create' ? 'Add Employee' : `Edit ${modal.user?.name}`}>
            <form onSubmit={submit} className="flex flex-col max-h-[70vh]">
              <div className="space-y-5 overflow-y-auto pr-2 flex-1 min-h-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div><label className="mb-1.5 block text-xs text-slate-500">Full Name *</label><input className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm outline-none focus:border-[#00C875] dark:border-white/10 dark:bg-white/5 dark:text-white" value={form.name} onChange={set('name')} required minLength={2} /></div>
                  <div><label className="mb-1.5 block text-xs text-slate-500">Email *</label><input className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm outline-none focus:border-[#00C875] dark:border-white/10 dark:bg-white/5 dark:text-white" type="email" value={form.email} onChange={set('email')} required disabled={modal.mode === 'edit'} /></div>
                  {modal.mode === 'create' && <div><label className="mb-1.5 block text-xs text-slate-500">Initial Password *</label><input className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm outline-none focus:border-[#00C875] dark:border-white/10 dark:bg-white/5 dark:text-white" type="text" value={form.password} onChange={set('password')} required minLength={8} placeholder="min 8 characters" /></div>}
                  <div><label className="mb-1.5 block text-xs text-slate-500">Role *</label>{roleEditable ? <select className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" value={form.role} onChange={set('role')}>{assignable.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}</select> : <input className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm opacity-60 dark:bg-white/5" value={roleLabel(form.role)} disabled />}</div>
                </div>
                <div><p className="text-xs font-semibold text-slate-500 mb-2 flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5" />ORGANIZATION</p><div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><label className="mb-1.5 block text-xs text-slate-500">Department</label><select className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" value={form.department} onChange={set('department')}><option value="">— None —</option>{departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}</select></div><div><label className="mb-1.5 block text-xs text-slate-500">Reports To</label><select className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" value={form.reportingTo} onChange={set('reportingTo')}><option value="">— None —</option>{options.filter((o) => String(o._id) !== String(modal.user?._id)).map((o) => (<option key={o._id} value={o._id}>{o.name} ({roleLabel(o.role)})</option>))}</select></div>{modal.mode === 'edit' && !editingSelf && manages(modal.user?.role) && <div><label className="mb-1.5 block text-xs text-slate-500">Status</label><select className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" value={form.status} onChange={set('status')}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></div>}</div></div>
                <div><p className="text-xs font-semibold text-slate-500 mb-1 flex items-center gap-1.5"><Landmark className="h-3.5 w-3.5" />PAYROLL &amp; STATUTORY <span className="font-normal">(optional)</span></p><p className="text-[11px] text-slate-500 mb-2">Real formats → PAN <b>ABCDE1234F</b> · UAN <b>12 digits</b> · IFSC like <b>KKBK0008655</b></p><div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><label className="mb-1.5 block text-xs text-slate-500">Employee Code</label><input className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" value={form.employeeCode} onChange={set('employeeCode')} placeholder="INF001" maxLength={20} /></div><div><label className="mb-1.5 block text-xs text-slate-500">Designation</label><input className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" value={form.designation} onChange={set('designation')} placeholder="HR Manager" maxLength={80} /></div><div><label className="mb-1.5 block text-xs text-slate-500">Date of Birth</label><input className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} /></div><div><label className="mb-1.5 block text-xs text-slate-500">Date of Joining</label><input className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" type="date" value={form.dateOfJoining} onChange={set('dateOfJoining')} /></div><div><label className="mb-1.5 block text-xs text-slate-500">PAN</label><input className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm uppercase dark:border-white/10 dark:bg-white/5 dark:text-white" value={form.pan} onChange={set('pan')} placeholder="ABCDE1234F" maxLength={10} /></div><div><label className="mb-1.5 block text-xs text-slate-500">UAN</label><input className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" value={form.uan} onChange={set('uan')} placeholder="100012345678" maxLength={12} /></div><div><label className="mb-1.5 block text-xs text-slate-500">ESIC</label><input className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" value={form.esic} onChange={set('esic')} placeholder="5610615623" maxLength={17} /></div><div><label className="mb-1.5 block text-xs text-slate-500">IFSC Code</label><input className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm uppercase dark:border-white/10 dark:bg-white/5 dark:text-white" value={form.ifsc} onChange={set('ifsc')} placeholder="KKBK0008655" maxLength={11} /></div><div className="sm:col-span-2"><label className="mb-1.5 block text-xs text-slate-500">Bank Account No.</label><input className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" value={form.bankAccount} onChange={set('bankAccount')} placeholder="7647368517" maxLength={18} /></div></div></div>
              </div>
              <div className="flex justify-end gap-2 pt-3"><button type="button" className="rounded-full border border-[#E6E9F0] bg-white px-5 py-2 text-sm font-semibold dark:border-white/10 dark:bg-white/5" onClick={() => setModal({ open: false, mode: 'create', user: null })}>Cancel</button><button type="submit" className="rounded-full bg-[#00C875] px-5 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={saving}>{saving ? 'Saving…' : modal.mode === 'create' ? 'Create User' : 'Save Changes'}</button></div>
            </form>
          </Modal>
        )}
        {pwModal.open && (
          <Modal onClose={() => setPwModal({ open: false, user: null, password: '', confirm: '' })} title={`Reset Password — ${pwModal.user?.name}`}>
            <form onSubmit={submitPassword} className="space-y-4">
              <div><label className="mb-1.5 block text-xs text-slate-500">New Password</label><input className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" type="text" value={pwModal.password} minLength={8} required onChange={(e) => setPwModal((m) => ({ ...m, password: e.target.value }))} /></div>
              <div><label className="mb-1.5 block text-xs text-slate-500">Confirm Password</label><input className="w-full rounded-lg border border-[#E6E9F0] bg-white px-3 py-2.5 text-sm dark:border-white/10 dark:bg-white/5 dark:text-white" type="text" value={pwModal.confirm} minLength={8} required onChange={(e) => setPwModal((m) => ({ ...m, confirm: e.target.value }))} /></div>
              <div className="flex justify-end gap-2"><button type="button" className="rounded-full border border-[#E6E9F0] bg-white px-5 py-2 text-sm font-semibold dark:border-white/10 dark:bg-white/5" onClick={() => setPwModal({ open: false, user: null, password: '', confirm: '' })}>Cancel</button><button type="submit" className="rounded-full bg-[#00C875] px-5 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={pwSaving}>{pwSaving ? 'Saving…' : 'Reset Password'}</button></div>
            </form>
          </Modal>
        )}
      </div>
    </div>
  );
}
