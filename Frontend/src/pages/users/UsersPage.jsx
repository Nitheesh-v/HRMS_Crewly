import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Building2,
  ChevronLeft,
  ChevronRight,
  Download,
  KeyRound,
  Landmark,
  LayoutGrid,
  List,
  Mail,
  Pencil,
  Phone,
  Plus,
  Search,
  Users,
} from 'lucide-react';
import api from '../../services/api';
import Modal from '../../components/Modal';
import useAuth from '../../hooks/useAuth';
import { ROLES, CREATION_RIGHTS, ROLE_STYLES, roleLabel } from '../../utils/roles';
import { notify } from '../../utils/notify.js';

const EMPTY_FORM = {
  name: '', email: '', password: '', role: 'EMPLOYEE', department: '', reportingTo: '', status: 'ACTIVE',
  employeeCode: '', designation: '', dateOfBirth: '', dateOfJoining: '',
  pan: '', uan: '', esic: '', bankAccount: '', ifsc: '',
};

// Figma "Add New Profile" drawer shape. The backend stores a single `name`,
// so first + last are joined on submit; role + initial password are required
// by POST /api/users even though the artwork's drawer omits them.
const EMPTY_DRAWER = { firstName: '', lastName: '', email: '', joinDate: '', role: 'EMPLOYEE', password: '' };

const isoDate = (d) => (d ? String(d).slice(0, 10) : '');

const initials = (name = '') =>
  String(name).trim().split(/\s+/).slice(0, 2).map((w) => (w[0] || '').toUpperCase()).join('') || '–';

// Compact numbered pagination: 1 … around current … N (Figma row style).
const pageItems = (pages, current) => {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const wanted = [1, 2, current - 1, current, current + 1, pages - 1, pages]
    .filter((p) => p >= 1 && p <= pages);
  const uniq = [...new Set(wanted)].sort((a, b) => a - b);
  const out = [];
  uniq.forEach((p, i) => {
    if (i > 0 && p - uniq[i - 1] > 1) out.push('gap');
    out.push(p);
  });
  return out;
};

function Avatar({ user, className = 'h-9 w-9 text-xs' }) {
  if (user?.avatarUrl) {
    return <img src={user.avatarUrl} alt="" className={`${className} rounded-full object-cover`} />;
  }
  return (
    <span className={`${className} inline-flex items-center justify-center rounded-full bg-crewly-green/15 font-semibold text-crewly-green`}>
      {initials(user?.name)}
    </span>
  );
}

function StatusPill({ status }) {
  const active = status === 'ACTIVE';
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide ${active ? 'bg-crewly-green/15 text-crewly-green' : 'bg-crewly-red/15 text-crewly-red'}`}>
      {active ? 'ACTIVE' : 'INACTIVE'}
    </span>
  );
}

export default function UsersPage() {
  const { user: me } = useAuth();
  // Auth stores the user as { id, name, email, role } — no _id!
  const myId = String(me?._id || me?.id || '');
  // Phase 29.1 company roles (HR Head, Payroll Admin, Payroll Executive, ...)
  // created from templates. They are real roles, so they belong in the
  // dropdown — otherwise you can create the role but never assign it here.
  const [companyRoles, setCompanyRoles] = useState([]);

  const creatable = CREATION_RIGHTS[me?.role] || [];
  const manages = (role) => creatable.includes(role);

  // Built-in roles keep their labels; company roles show the name the
  // administrator typed when creating them.
  const roleOptions = [
    ...creatable.map((code) => ({ code, label: roleLabel(code) })),
    ...companyRoles.map((role) => ({ code: role.code, label: role.name || role.code })),
  ];
  const ROLE_ASSIGNERS = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER];
  const canAssignCompanyRoles = ROLE_ASSIGNERS.includes(me?.role);
  const assignable = canAssignCompanyRoles ? roleOptions : creatable.map((code) => ({ code, label: roleLabel(code) }));
  const isKnownRole = (role) =>
    assignable.some((option) => option.code === role) || role === me?.role;

  const [users, setUsers] = useState([]);
  const [options, setOptions] = useState([]);       // all users, for "Reports To" select
  const [departments, setDepartments] = useState([]);
  const [meta, setMeta] = useState({ page: 1, pages: 1, total: 0 });
  const [page, setPage] = useState(1);
  const [view, setView] = useState('table');        // 'table' | 'directory'
  const [filters, setFilters] = useState({ search: '', role: '', department: '', status: '' });
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const [modal, setModal] = useState({ open: false, mode: 'create', user: null });
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [pwModal, setPwModal] = useState({ open: false, user: null, password: '', confirm: '' });
  const [pwSaving, setPwSaving] = useState(false);

  // Figma "Add New Profile" right-hand drawer (create only; edit keeps the
  // full modal because the artwork has no edit surface of its own).
  const [drawer, setDrawer] = useState(false);
  const [dForm, setDForm] = useState(EMPTY_DRAWER);
  const [dErrors, setDErrors] = useState({});

  /*
   * 35.1 — feedback is a toast now. The signature is unchanged so every call
   * site keeps working; only the destination moved (out of the page flow and
   * into the app-wide stack).
   */
  const flash = (type, text) => {
    const body = typeof text === 'string' && text ? text : '';

    if (!body) return;

    const kind = String(type).toLowerCase();

    if (kind === 'error' || kind === 'danger' || kind === 'failed') notify.error(body);
    else if (kind === 'warning' || kind === 'warn') notify.warning(body);
    else if (kind === 'info') notify.info(body);
    else notify.success(body);
  };
  const errText = (err) => err?.response?.data?.message || err?.message || 'Something went wrong';

  // Defensive unwrapping: works whether the interceptor returns the
  // full body (meta present) or already-unwrapped data.
  const extractUsers = (res) => {
    const payload = res?.data ?? res;
    if (Array.isArray(payload)) return { list: payload, meta: null };
    return { list: payload?.users || [], meta: res?.meta || payload?.meta || null };
  };

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: view === 'directory' ? 24 : 10 };
      Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
      const res = await api.get('/users', { params });
      const { list, meta: m } = extractUsers(res);
      setUsers(list);
      setMeta(m || { page: 1, pages: 1, total: list.length });
    } catch (err) {
      flash('error', errText(err));
    } finally {
      setLoading(false);
    }
  }, [page, filters, view]);

  const loadOptions = useCallback(async () => {
    try {
      const res = await api.get('/users', { params: { limit: 200 } });
      setOptions(extractUsers(res).list);
    } catch { /* non-fatal */ }
  }, []);

  // Repo convention (49 call sites): data-loading effects trip this rule
  // because the fetch starts synchronously; the pattern is intentional.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { loadUsers(); }, [loadUsers]);
  useEffect(() => {
    loadOptions();
    (async () => {
      try {
        const res = await api.get('/departments');
        setDepartments(Array.isArray(res) ? res : res?.departments || res?.data || []);
      } catch { /* non-fatal */ }
      try {
        // Phase 29.1 company roles (GET /api/roles, SETTINGS_READ-gated).
        // Non-fatal: actors without the permission still get built-in roles.
        const res = await api.get('/roles');
        setCompanyRoles(Array.isArray(res) ? res : res?.data || res?.roles || []);
      } catch { /* non-fatal: built-in roles still work */ }
    })();
  }, [loadOptions]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const openDrawer = () => {
    setDForm({ ...EMPTY_DRAWER, role: assignable[assignable.length - 1]?.code || 'EMPLOYEE' });
    setDErrors({});
    setDrawer(true);
  };

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
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        role: form.role,
        department: form.department || '',
        reportingTo: form.reportingTo || '',
        employeeCode: form.employeeCode.trim(),
        designation: form.designation.trim(),
        dateOfBirth: form.dateOfBirth || '',
        dateOfJoining: form.dateOfJoining || '',
        pan: form.pan.trim().toUpperCase(),
        uan: form.uan.trim(),
        esic: form.esic.trim(),
        bankAccount: form.bankAccount.trim(),
        ifsc: form.ifsc.trim().toUpperCase(),
      };
      if (modal.mode === 'create') {
        payload.email = form.email.trim();
        payload.password = form.password;
        await api.post('/users', payload);
        flash('success', `User ${payload.name} created`);
      } else {
        const u = modal.user;
        const isSelf = String(u._id) === myId;
        if (isSelf) delete payload.role;                             // never change your own role
        if (!isSelf && manages(u.role)) payload.status = form.status; // status only when allowed
        await api.patch(`/users/${u._id}`, payload);
        flash('success', 'User updated');
      }
      setModal({ open: false, mode: 'create', user: null });
      loadUsers();
      loadOptions();
    } catch (err) {
      flash('error', errText(err));
    } finally {
      setSaving(false);
    }
  };

  // Drawer create — inline "This field is required." validation, exactly the
  // artwork's red-ring + message pattern; payload matches POST /api/users.
  const submitDrawer = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!dForm.firstName.trim()) errs.firstName = true;
    if (!dForm.lastName.trim()) errs.lastName = true;
    if (!dForm.email.trim()) errs.email = true;
    else if (!/^\S+@\S+\.\S+$/.test(dForm.email.trim())) errs.email = 'Enter a valid email';
    if (!dForm.joinDate) errs.joinDate = true;
    if (!dForm.password) errs.password = true;
    else if (dForm.password.length < 8) errs.password = 'Password must be at least 8 characters';
    setDErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    try {
      await api.post('/users', {
        name: `${dForm.firstName.trim()} ${dForm.lastName.trim()}`,
        email: dForm.email.trim(),
        password: dForm.password,
        role: dForm.role,
        dateOfJoining: dForm.joinDate,
      });
      flash('success', `Employee ${dForm.firstName.trim()} ${dForm.lastName.trim()} created`);
      setDrawer(false);
      loadUsers();
      loadOptions();
    } catch (err) {
      flash('error', errText(err));
    } finally {
      setSaving(false);
    }
  };

  const submitPassword = async (e) => {
    e.preventDefault();
    if (pwModal.password !== pwModal.confirm) return flash('error', 'Passwords do not match');
    setPwSaving(true);
    try {
      await api.post(`/users/${pwModal.user._id}/reset-password`, { newPassword: pwModal.password });
      flash('success', `Password reset for ${pwModal.user.name}`);
      setPwModal({ open: false, user: null, password: '', confirm: '' });
    } catch (err) {
      flash('error', errText(err));
    } finally {
      setPwSaving(false);
    }
  };

  // Download — real client-side CSV of the current filter set (bounded at
  // 200 rows, the same cap the backend allows per request).
  const exportCsv = async () => {
    setExporting(true);
    try {
      const params = { limit: 200 };
      Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
      const res = await api.get('/users', { params });
      const list = extractUsers(res).list;
      const rows = [
        ['Name', 'Email', 'Role', 'Designation', 'Department', 'Reports To', 'Status', 'Join Date'],
        ...list.map((u) => [
          u.name, u.email, roleLabel(u.role), u.designation || '',
          u.department?.name || '', u.reportingTo?.name || '', u.status || '', isoDate(u.dateOfJoining),
        ]),
      ];
      const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'employees.csv';
      a.click();
      URL.revokeObjectURL(url);
      flash('success', `Exported ${list.length} employees`);
    } catch (err) {
      flash('error', errText(err));
    } finally {
      setExporting(false);
    }
  };

  const editingSelf = modal.user && String(modal.user._id) === myId;
  const roleEditable =
    modal.mode === 'create' ||
    (!editingSelf && (manages(modal.user?.role) || (canAssignCompanyRoles && isKnownRole(modal.user?.role))));

  const dSet = (key) => (e) => setDForm((f) => ({ ...f, [key]: e.target.value }));
  const dRing = (key) => `input ${dErrors[key] ? '!border-crewly-red !ring-2 !ring-crewly-red/20' : ''}`;
  const dErr = (key) =>
    dErrors[key] ? (
      <p className="mt-1.5 flex items-center gap-1 text-xs text-crewly-red">
        <AlertCircle className="h-3.5 w-3.5" />
        {dErrors[key] === true ? 'This field is required.' : dErrors[key]}
      </p>
    ) : null;

  return (
    <div className="p-3 sm:p-4 lg:p-6 space-y-4 sm:space-y-6">
      {/* ── header — Figma: title left, Download + Add New right ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold"><Users className="h-5 w-5" />Employees</h1>
          <p className="text-sm text-crewly-dim">Manage your employees — {meta.total} people in your company</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={exportCsv} disabled={exporting}>
            <Download className="mr-1 inline h-4 w-4" />{exporting ? 'Exporting…' : 'Download'}
          </button>
          {creatable.length > 0 && (
            <button className="btn-primary" onClick={openDrawer}>
              <Plus className="mr-1 inline h-4 w-4" />Add New
            </button>
          )}
        </div>
      </div>

      {/* ── controls — search + filters + view toggle ── */}
      <div className="card p-3 sm:p-4 flex flex-col lg:flex-row gap-2 sm:gap-3">
        <div className="relative w-full lg:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crewly-dim" />
          <input
            className="input w-full pl-9"
            placeholder="Search employee"
            value={filters.search}
            onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, search: e.target.value })); }}
          />
        </div>
        <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
          <select className="input w-full sm:w-auto" value={filters.department} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, department: e.target.value })); }}>
            <option value="">All Departments</option>
            {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
          </select>
          <select className="input w-full sm:w-auto" value={filters.role} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, role: e.target.value })); }}>
            <option value="">All Roles</option>
            {[...[ROLES.HR_MANAGER, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE].map((r) => (
              <option key={r} value={r}>{roleLabel(r)}</option>
            )),
            ...companyRoles.map((role) => (
              <option key={role.code} value={role.code}>{role.name || roleLabel(role.code)}</option>
            ))]}
          </select>
          <select className="input w-full sm:w-auto" value={filters.status} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, status: e.target.value })); }}>
            <option value="">All Status</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
          <div className="flex rounded-lg border border-crewly-border overflow-hidden">
            <button
              type="button"
              className={`px-3 py-2 text-sm ${view === 'table' ? 'bg-crewly-green text-crewly-bg font-semibold' : 'text-crewly-dim hover:text-crewly-text'}`}
              onClick={() => { setPage(1); setView('table'); }}
              aria-pressed={view === 'table'}
            >
              <List className="h-4 w-4" /><span className="sr-only">Table view</span>
            </button>
            <button
              type="button"
              className={`px-3 py-2 text-sm ${view === 'directory' ? 'bg-crewly-green text-crewly-bg font-semibold' : 'text-crewly-dim hover:text-crewly-text'}`}
              onClick={() => { setPage(1); setView('directory'); }}
              aria-pressed={view === 'directory'}
            >
              <LayoutGrid className="h-4 w-4" /><span className="sr-only">Directory view</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── table view ── */}
      {view === 'table' && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-crewly-dim border-b border-crewly-border">
                <th className="p-3">Employee</th>
                <th className="p-3">Job Title</th>
                <th className="p-3">Line Manager</th>
                <th className="p-3">Department</th>
                <th className="p-3">Employee Status</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td className="p-4 text-crewly-dim" colSpan={6}>Loading…</td></tr>
              ) : users.length === 0 ? (
                <tr><td className="p-4 text-crewly-dim" colSpan={6}>No users found.</td></tr>
              ) : users.map((u) => (
                <tr key={u._id} className="border-b border-crewly-border/50">
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <Avatar user={u} />
                      <div>
                        <div className="font-medium">{u.name}</div>
                        <div className="text-xs text-crewly-dim">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-3">
                    <div>{u.designation || roleLabel(u.role)}</div>
                    <div className="text-xs text-crewly-dim"><span className={ROLE_STYLES[u.role] || 'badge'}>{roleLabel(u.role)}</span></div>
                  </td>
                  <td className="p-3">{u.reportingTo?.name || '—'}</td>
                  <td className="p-3">{u.department?.name || '—'}</td>
                  <td className="p-3"><StatusPill status={u.status} /></td>
                  <td className="p-3">
                    <div className="flex justify-end gap-2">
                      {(manages(u.role) || String(u._id) === myId) && (
                        <button
                          className="rounded-lg bg-crewly-green/15 p-2 text-crewly-green transition hover:bg-crewly-green/25"
                          title="Edit"
                          onClick={() => openEdit(u)}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                      )}
                      {manages(u.role) && String(u._id) !== myId && (
                        <button
                          className="rounded-lg bg-blue-400/15 p-2 text-blue-300 transition hover:bg-blue-400/25"
                          title="Reset password"
                          onClick={() => setPwModal({ open: true, user: u, password: '', confirm: '' })}
                        >
                          <KeyRound className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── directory view — Figma card grid ── */}
      {view === 'directory' && (
        <div>
          {loading ? (
            <div className="card p-4 text-crewly-dim">Loading…</div>
          ) : users.length === 0 ? (
            <div className="card p-4 text-crewly-dim">No users found.</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {users.map((u) => (
                <div key={u._id} className="card p-5 flex flex-col items-center text-center gap-1">
                  <Avatar user={u} className="h-16 w-16 text-lg" />
                  <div className="mt-2 font-semibold">{u.name}</div>
                  <div className="text-sm text-crewly-dim">{u.designation || roleLabel(u.role)}</div>
                  <div className="mt-3 w-full border-t border-crewly-border/50 pt-3 space-y-2 text-sm">
                    <div className="flex items-center justify-center gap-2 text-crewly-dim"><Mail className="h-4 w-4" />{u.email}</div>
                    {u.phone && (
                      <div className="flex items-center justify-center gap-2 text-crewly-dim"><Phone className="h-4 w-4" />{u.phone}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── pagination — numbered, Figma row style ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-sm text-crewly-dim">
        <span>Page {meta.page} of {meta.pages} — {meta.total} people</span>
        <div className="flex items-center gap-1">
          <button className="btn-ghost px-2" disabled={meta.page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" />
          </button>
          {pageItems(meta.pages, meta.page).map((item, idx) =>
            item === 'gap' ? (
              <span key={`gap-${idx}`} className="px-1">…</span>
            ) : (
              <button
                key={item}
                className={`min-w-[32px] rounded-lg px-2 py-1.5 ${item === meta.page ? 'bg-crewly-green text-crewly-bg font-semibold' : 'hover:bg-crewly-border/30'}`}
                onClick={() => setPage(item)}
                aria-current={item === meta.page ? 'page' : undefined}
              >
                {item}
              </button>
            ),
          )}
          <button className="btn-ghost px-2" disabled={meta.page >= meta.pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ── Add New Profile drawer (Figma right slide-over) ── */}
      {drawer && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
          <div className="employees-drawer absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto border-l border-crewly-border bg-crewly-card p-6">
            <h2 className="text-lg font-bold">Add New Profile</h2>
            <form onSubmit={submitDrawer} className="mt-5 space-y-4" noValidate>
              <div>
                <label className="label">First Name *</label>
                <input className={dRing('firstName')} value={dForm.firstName} onChange={dSet('firstName')} />
                {dErr('firstName')}
              </div>
              <div>
                <label className="label">Last Name *</label>
                <input className={dRing('lastName')} value={dForm.lastName} onChange={dSet('lastName')} />
                {dErr('lastName')}
              </div>
              <div>
                <label className="label">Email Address *</label>
                <input className={dRing('email')} type="email" value={dForm.email} onChange={dSet('email')} />
                {dErr('email')}
              </div>
              <div>
                <label className="label">Join Date *</label>
                <input className={dRing('joinDate')} type="date" value={dForm.joinDate} onChange={dSet('joinDate')} />
                {dErr('joinDate')}
              </div>
              <div>
                <label className="label">Role *</label>
                <select className="input" value={dForm.role} onChange={dSet('role')}>
                  {assignable.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Initial Password *</label>
                <input className={dRing('password')} type="text" value={dForm.password} onChange={dSet('password')} placeholder="min 8 characters" />
                {dErr('password')}
                <p className="mt-1.5 text-xs text-crewly-dim">The backend requires a role and an initial password when creating an account — the artwork's drawer omits both.</p>
              </div>
              <div className="flex justify-end gap-2 pt-3 border-t border-crewly-border/50">
                <button type="button" className="btn-ghost" onClick={() => setDrawer(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Add / Edit modal (full backend field set) ── */}
      {/* Form = flex column capped at 70vh; only the FIELDS scroll,
          the footer buttons stay pinned & visible at the bottom. */}
      {modal.open && (
        <Modal onClose={() => setModal({ open: false, mode: 'create', user: null })}
          title={modal.mode === 'create' ? 'Add User' : `Edit ${modal.user?.name}`}>
          <form onSubmit={submit} className="flex flex-col max-h-[70vh]">

            {/* scrollable fields area */}
            <div className="space-y-5 overflow-y-auto pr-2 flex-1 min-h-0">
              {/* basic */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Full Name *</label>
                  <input className="input" value={form.name} onChange={set('name')} required minLength={2} />
                </div>
                <div>
                  <label className="label">Email *</label>
                  <input className="input" type="email" value={form.email} onChange={set('email')} required disabled={modal.mode === 'edit'} />
                </div>
                {modal.mode === 'create' && (
                  <div>
                    <label className="label">Initial Password *</label>
                    <input className="input" type="text" value={form.password} onChange={set('password')} required minLength={8} placeholder="min 8 characters" />
                  </div>
                )}
                <div>
                  <label className="label">Role *</label>
                  {roleEditable ? (
                    <select className="input" value={form.role} onChange={set('role')}>
                      {assignable.map((r) => <option key={r.code}>{r.label}</option>)}
                    </select>
                  ) : (
                    <input className="input opacity-60" value={roleLabel(form.role)} disabled />
                  )}
                </div>
              </div>

              {/* organization */}
              <div>
                <p className="text-xs font-semibold text-crewly-dim mb-2 flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5" />ORGANIZATION</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="label">Department</label>
                    <select className="input" value={form.department} onChange={set('department')}>
                      <option value="">— None —</option>
                      {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">Reports To</label>
                    <select className="input" value={form.reportingTo} onChange={set('reportingTo')}>
                      <option value="">— None —</option>
                      {options.filter((o) => String(o._id) !== String(modal.user?._id)).map((o) => (
                        <option key={o._id} value={o._id}>{o.name} ({roleLabel(o.role)})</option>
                      ))}
                    </select>
                  </div>
                  {modal.mode === 'edit' && !editingSelf && manages(modal.user?.role) && (
                    <div>
                      <label className="label">Status</label>
                      <select className="input" value={form.status} onChange={set('status')}>
                        <option value="ACTIVE">Active</option>
                        <option value="INACTIVE">Inactive</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>

              {/* payroll & statutory */}
              <div>
                <p className="text-xs font-semibold text-crewly-dim mb-1 flex items-center gap-1.5"><Landmark className="h-3.5 w-3.5" />PAYROLL &amp; STATUTORY <span className="font-normal">(optional — printed on payslips)</span></p>
                <p className="text-[11px] text-crewly-dim mb-2">
                  Real formats required → PAN <b>ABCDE1234F</b> · UAN <b>12 digits</b> · IFSC like <b>KKBK0008655</b> (4th char is the digit 0)
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="label">Employee Code</label>
                    <input className="input" value={form.employeeCode} onChange={set('employeeCode')} placeholder="INF001" maxLength={20} />
                  </div>
                  <div>
                    <label className="label">Designation</label>
                    <input className="input" value={form.designation} onChange={set('designation')} placeholder="HR Manager" maxLength={80} />
                  </div>
                  <div>
                    <label className="label">Date of Birth</label>
                    <input className="input" type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} />
                  </div>
                  <div>
                    <label className="label">Date of Joining</label>
                    <input className="input" type="date" value={form.dateOfJoining} onChange={set('dateOfJoining')} />
                  </div>
                  <div>
                    <label className="label">PAN</label>
                    <input className="input uppercase" value={form.pan} onChange={set('pan')} placeholder="ABCDE1234F" maxLength={10} />
                  </div>
                  <div>
                    <label className="label">UAN</label>
                    <input className="input" value={form.uan} onChange={set('uan')} placeholder="100012345678" maxLength={12} />
                  </div>
                  <div>
                    <label className="label">ESIC</label>
                    <input className="input" value={form.esic} onChange={set('esic')} placeholder="5610615623" maxLength={17} />
                  </div>
                  <div>
                    <label className="label">IFSC Code</label>
                    <input className="input uppercase" value={form.ifsc} onChange={set('ifsc')} placeholder="KKBK0008655" maxLength={11} />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label">Bank Account No.</label>
                    <input className="input" value={form.bankAccount} onChange={set('bankAccount')} placeholder="7647368517" maxLength={18} />
                  </div>
                </div>
              </div>
            </div>

            {/* pinned footer — always visible */}
            <div className="flex justify-end gap-2 pt-3">
              <button type="button" className="btn-ghost" onClick={() => setModal({ open: false, mode: 'create', user: null })}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={saving}>
                {saving ? 'Saving…' : modal.mode === 'create' ? 'Create User' : 'Save Changes'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── Reset password modal (short — no scroll needed) ── */}
      {pwModal.open && (
        <Modal onClose={() => setPwModal({ open: false, user: null, password: '', confirm: '' })}
          title={`Reset Password — ${pwModal.user?.name}`}>
          <form onSubmit={submitPassword} className="space-y-4">
            <div>
              <label className="label">New Password</label>
              <input className="input" type="text" value={pwModal.password} minLength={8} required
                onChange={(e) => setPwModal((m) => ({ ...m, password: e.target.value }))} />
            </div>
            <div>
              <label className="label">Confirm Password</label>
              <input className="input" type="text" value={pwModal.confirm} minLength={8} required
                onChange={(e) => setPwModal((m) => ({ ...m, confirm: e.target.value }))} />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setPwModal({ open: false, user: null, password: '', confirm: '' })}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={pwSaving}>{pwSaving ? 'Saving…' : 'Reset Password'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
