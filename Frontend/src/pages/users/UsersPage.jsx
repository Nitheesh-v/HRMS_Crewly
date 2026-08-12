import { useCallback, useEffect, useState } from 'react';
import api from '../../services/api';
import Modal from '../../components/Modal';
import useAuth from '../../hooks/useAuth';
import { ROLES, CREATION_RIGHTS, ROLE_STYLES, roleLabel } from '../../utils/roles';



const EMPTY_FORM = {
  name: '', email: '', password: '', role: 'EMPLOYEE', department: '', reportingTo: '', status: 'ACTIVE',
  employeeCode: '', designation: '', dateOfBirth: '', dateOfJoining: '',
  pan: '', uan: '', esic: '', bankAccount: '', ifsc: '',
};

const isoDate = (d) => (d ? String(d).slice(0, 10) : '');

export default function UsersPage() {
  const { user: me } = useAuth();
  // Auth stores the user as { id, name, email, role } — no _id!
  const myId = String(me?._id || me?.id || '');
  const creatable = CREATION_RIGHTS[me?.role] || [];
  const manages = (role) => creatable.includes(role);

  const [users, setUsers] = useState([]);
  const [options, setOptions] = useState([]);       // all users, for "Reports To" select
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

  const flash = (type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 4000);
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
      const params = { page, limit: 10 };
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
  }, [page, filters]);

  const loadOptions = useCallback(async () => {
    try {
      const res = await api.get('/users', { params: { limit: 200 } });
      setOptions(extractUsers(res).list);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);
  useEffect(() => {
    loadOptions();
    (async () => {
      try {
        const res = await api.get('/departments');
        setDepartments(Array.isArray(res) ? res : res?.departments || res?.data || []);
      } catch { /* non-fatal */ }
    })();
  }, [loadOptions]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const openCreate = () => {
    setForm({ ...EMPTY_FORM, role: creatable[creatable.length - 1] || 'EMPLOYEE' });
    setModal({ open: true, mode: 'create', user: null });
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
        flash('success', `User ${payload.name} created 🎉`);
      } else {
        const u = modal.user;
        const isSelf = String(u._id) === myId;
        if (isSelf) delete payload.role;                             // never change your own role
        if (!isSelf && manages(u.role)) payload.status = form.status; // status only when allowed
        await api.patch(`/users/${u._id}`, payload);
        flash('success', 'User updated ✅');
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

  const submitPassword = async (e) => {
    e.preventDefault();
    if (pwModal.password !== pwModal.confirm) return flash('error', 'Passwords do not match');
    setPwSaving(true);
    try {
      await api.post(`/users/${pwModal.user._id}/reset-password`, { newPassword: pwModal.password });
      flash('success', `Password reset for ${pwModal.user.name} 🔑`);
      setPwModal({ open: false, user: null, password: '', confirm: '' });
    } catch (err) {
      flash('error', errText(err));
    } finally {
      setPwSaving(false);
    }
  };

  const editingSelf = modal.user && String(modal.user._id) === myId;
  const roleEditable = modal.mode === 'create' || (!editingSelf && manages(modal.user?.role));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">👥 User Management</h1>
          <p className="text-sm text-crewly-dim">{meta.total} people in your company</p>
        </div>
        {creatable.length > 0 && (
          <button className="btn-primary" onClick={openCreate}>+ Add User</button>
        )}
      </div>

      {banner && (
        <div className={`card px-4 py-3 text-sm ${banner.type === 'error' ? 'text-crewly-red' : 'text-crewly-green'}`}>
          {banner.text}
        </div>
      )}

      {/* filters */}
      <div className="card p-4 flex flex-wrap gap-3">
        <input
          className="input flex-1 min-w-[180px]"
          placeholder="Search name or email…"
          value={filters.search}
          onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, search: e.target.value })); }}
        />
        <select className="input" value={filters.role} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, role: e.target.value })); }}>
          <option value="">All roles</option>
          {[ROLES.HR_MANAGER, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE].map((r) => (
            <option key={r} value={r}>{roleLabel(r)}</option>
          ))}
        </select>
        <select className="input" value={filters.department} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, department: e.target.value })); }}>
          <option value="">All departments</option>
          {departments.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
        </select>
        <select className="input" value={filters.status} onChange={(e) => { setPage(1); setFilters((f) => ({ ...f, status: e.target.value })); }}>
          <option value="">Any status</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
      </div>

      {/* table */}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-crewly-dim border-b border-crewly-border">
              <th className="p-3">Employee</th>
              <th className="p-3">Role</th>
              <th className="p-3">Department</th>
              <th className="p-3">Reports To</th>
              <th className="p-3">Status</th>
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
                  <div className="font-medium">{u.name}</div>
                  <div className="text-xs text-crewly-dim">{u.email}</div>
                </td>
                <td className="p-3"><span className={ROLE_STYLES[u.role] || 'badge'}>{roleLabel(u.role)}</span></td>
                <td className="p-3">{u.department?.name || '—'}</td>
                <td className="p-3">{u.reportingTo?.name || '—'}</td>
                <td className="p-3">
                  <span className={`badge ${u.status === 'ACTIVE' ? 'text-crewly-green' : 'text-crewly-red'}`}>{u.status}</span>
                </td>
                <td className="p-3 text-right space-x-2">
                  {(manages(u.role) || String(u._id) === myId) && (
                    <button className="btn-ghost text-xs" onClick={() => openEdit(u)}>✏️ Edit</button>
                  )}
                  {manages(u.role) && String(u._id) !== myId && (
                    <button className="btn-ghost text-xs" onClick={() => setPwModal({ open: true, user: u, password: '', confirm: '' })}>🔑 Reset PW</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* pagination */}
      <div className="flex items-center justify-between text-sm text-crewly-dim">
        <span>Page {meta.page} of {meta.pages}</span>
        <div className="space-x-2">
          <button className="btn-ghost" disabled={meta.page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</button>
          <button className="btn-ghost" disabled={meta.page >= meta.pages} onClick={() => setPage((p) => p + 1)}>Next →</button>
        </div>
      </div>

      {/* ── Add / Edit modal ── */}
      {/* Form = flex column capped at 70vh; only the FIELDS scroll,
          the footer buttons stay pinned & visible at the bottom. */}
      {modal.open && (
        <Modal onClose={() => setModal({ open: false, mode: 'create', user: null })}
          title={modal.mode === 'create' ? '➕ Add User' : `✏️ Edit ${modal.user?.name}`}>
          <form onSubmit={submit} className="flex flex-col max-h-[70vh]">

            {/* ↕ scrollable fields area */}
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
                      {creatable.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
                    </select>
                  ) : (
                    <input className="input opacity-60" value={roleLabel(form.role)} disabled />
                  )}
                </div>
              </div>

              {/* organization */}
              <div>
                <p className="text-xs font-semibold text-crewly-dim mb-2">🏗️ ORGANIZATION</p>
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
                <p className="text-xs font-semibold text-crewly-dim mb-1">💰 PAYROLL &amp; STATUTORY <span className="font-normal">(optional — printed on payslips)</span></p>
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

            {/* 📌 pinned footer — always visible */}
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
          title={`🔑 Reset Password — ${pwModal.user?.name}`}>
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