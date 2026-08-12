import { useEffect, useState } from 'react';
import departmentService from '../../services/departmentService.js';
import Modal from '../../components/Modal.jsx';
import useAuth from '../../hooks/useAuth.jsx';
import { ROLES } from '../../utils/roles.js';

const emptyForm = { name: '', description: '' };

const DepartmentsPage = () => {
  const { user, hasRole } = useAuth();
  const canManage = hasRole(ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER);
  const canDelete = user?.role === ROLES.COMPANY_ADMIN;

  const [departments, setDepartments] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(null); // department being edited
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => departmentService.getAll().then(setDepartments).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const submitCreate = async (e) => {
    e.preventDefault();
    setError(''); setSaving(true);
    try {
      await departmentService.create(form);
      setForm(emptyForm);
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  const submitEdit = async (e) => {
    e.preventDefault();
    setError(''); setSaving(true);
    try {
      await departmentService.update(editing._id, { name: editing.name, description: editing.description, status: editing.status });
      setEditing(null);
      load();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  const remove = async (dept) => {
    if (!window.confirm(`Delete department "${dept.name}"?`)) return;
    setError('');
    try { await departmentService.remove(dept._id); load(); }
    catch (err) { setError(err.message); }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">🏢 Departments</h1>
        <span className="text-sm text-crewly-dim">{departments.length} total</span>
      </div>

      {error && <div className="rounded-lg border border-crewly-red/40 bg-crewly-red/10 px-4 py-3 text-sm text-crewly-red">{error}</div>}

      {canManage && (
        <form onSubmit={submitCreate} className="card flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label className="label">Department Name</label>
            <input className="input" placeholder="e.g. Engineering" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div className="flex-1">
            <label className="label">Description (optional)</label>
            <input className="input" placeholder="What this team does" value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving…' : '+ Add Department'}
          </button>
        </form>
      )}

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-crewly-border text-crewly-dim">
              <th className="px-5 py-3">Name</th>
              <th className="px-5 py-3">Description</th>
              <th className="px-5 py-3">Members</th>
              <th className="px-5 py-3">Status</th>
              {canManage && <th className="px-5 py-3 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {departments.map((d) => (
              <tr key={d._id} className="border-b border-crewly-border/50 last:border-0 hover:bg-crewly-bg/50">
                <td className="px-5 py-3 font-medium">{d.name}</td>
                <td className="px-5 py-3 text-crewly-dim">{d.description || '—'}</td>
                <td className="px-5 py-3">{d.memberCount}</td>
                <td className="px-5 py-3">
                  <span className={`badge ${d.status === 'ACTIVE' ? 'bg-crewly-green/15 text-crewly-green' : 'bg-crewly-red/15 text-crewly-red'}`}>{d.status}</span>
                </td>
                {canManage && (
                  <td className="px-5 py-3 text-right">
                    <button className="btn-ghost px-3 py-1 text-xs" onClick={() => setEditing(d)}>Edit</button>
                    {canDelete && (
                      <button className="ml-2 rounded-lg border border-crewly-red/40 px-3 py-1 text-xs text-crewly-red hover:bg-crewly-red/10"
                        onClick={() => remove(d)}>Delete</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {departments.length === 0 && (
              <tr><td colSpan={5} className="px-5 py-8 text-center text-crewly-dim">No departments yet — create your first one above.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <Modal title={`Edit: ${editing.name}`} onClose={() => setEditing(null)}>
          <form onSubmit={submitEdit} className="space-y-3">
            <div>
              <label className="label">Name</label>
              <input className="input" value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
            </div>
            <div>
              <label className="label">Description</label>
              <input className="input" value={editing.description || ''}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </div>
            <div>
              <label className="label">Status</label>
              <select className="input" value={editing.status}
                onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                <option value="ACTIVE">ACTIVE</option>
                <option value="INACTIVE">INACTIVE</option>
              </select>
            </div>
            <button type="submit" className="btn-primary w-full" disabled={saving}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
};

export default DepartmentsPage;