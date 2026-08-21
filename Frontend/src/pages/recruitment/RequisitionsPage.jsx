import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Clock,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import api from '../../services/api';
import requisitionService from '../../services/requisitionService';
import Modal from '../../components/Modal';
import useAuth from '../../hooks/useAuth';
import { ROLES } from '../../utils/roles';

export const STATUS_STYLE = {
  DRAFT: 'bg-white/10 text-crewly-dim',
  SUBMITTED: 'bg-sky-400/15 text-sky-300',
  PENDING_HR: 'bg-sky-400/15 text-sky-300',
  APPROVED: 'bg-crewly-green/15 text-crewly-green',
  REJECTED: 'bg-crewly-red/15 text-crewly-red',
  SENT_BACK: 'bg-yellow-400/15 text-yellow-300',
  CLOSED: 'bg-white/10 text-crewly-dim',
};

export const PRIORITY_STYLE = {
  LOW: 'bg-white/10 text-crewly-dim',
  MEDIUM: 'bg-indigo-400/15 text-indigo-300',
  HIGH: 'bg-crewly-orange/15 text-crewly-orange',
  URGENT: 'bg-crewly-red/15 text-crewly-red',
};

export const pretty = (value) => String(value || '').replace(/_/g, ' ');

export const money = (value) =>
  Number(value || 0) > 0 ? `₹${Number(value).toLocaleString('en-IN')}` : '—';

export const isoDate = (value) => (value ? String(value).slice(0, 10) : '');

const emptyForm = {
  position: '',
  designation: '',
  department: '',
  team: '',
  openings: 1,
  hiringType: 'EXPERIENCED',
  minExperience: 0,
  maxExperience: 0,
  requiredSkills: '',
  preferredSkills: '',
  hiringReason: 'NEW_POSITION',
  reasonNote: '',
  priority: 'MEDIUM',
  expectedJoiningDate: '',
  minSalary: '',
  maxSalary: '',
  hiringBudget: '',
  employmentType: 'FULL_TIME',
  workMode: 'ONSITE',
  location: '',
  additionalRequirements: '',
};

const toForm = (row) => ({
  ...emptyForm,
  ...row,
  department: row.department?._id || row.department || '',
  requiredSkills: (row.requiredSkills || []).join(', '),
  preferredSkills: (row.preferredSkills || []).join(', '),
  expectedJoiningDate: isoDate(row.expectedJoiningDate),
});

const toPayload = (form) => ({
  ...form,
  openings: Number(form.openings) || 1,
  minExperience: Number(form.minExperience) || 0,
  maxExperience: Number(form.maxExperience) || 0,
  minSalary: Number(form.minSalary) || 0,
  maxSalary: Number(form.maxSalary) || 0,
  hiringBudget: Number(form.hiringBudget) || 0,
  requiredSkills: form.requiredSkills,
  preferredSkills: form.preferredSkills,
  department: form.department || undefined,
  expectedJoiningDate: form.expectedJoiningDate || undefined,
});

const RequisitionsPage = () => {
  const { user: me } = useAuth();

  const canReview = [ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER].includes(me?.role);

  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  const [departments, setDepartments] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState(null);

  const [formModal, setFormModal] = useState({ open: false, editing: null });
  const [form, setForm] = useState(emptyForm);
  const [detail, setDetail] = useState(null);

  const flash = (type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 5000);
  };

  const errText = (err) => err?.message || 'Something went wrong';

  const load = useCallback(async () => {
    try {
      const res = await requisitionService.list(
        statusFilter ? { status: statusFilter } : {},
      );

      setRows(Array.isArray(res) ? res : res?.data || []);
      setSummary(res?.meta?.summary || {});
    } catch (err) {
      flash('error', errText(err));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/departments');
        setDepartments(Array.isArray(res) ? res : res?.departments || res?.data || []);
      } catch {
        /* non-fatal */
      }
    })();
  }, []);

  const openCreate = () => {
    setForm(emptyForm);
    setFormModal({ open: true, editing: null });
  };

  const openEdit = (row) => {
    setForm(toForm(row));
    setFormModal({ open: true, editing: row });
  };

  const save = async (submit) => {
    if (!form.position.trim()) return flash('error', 'Position is required');

    setBusy(true);

    try {
      const payload = toPayload(form);

      if (formModal.editing) {
        await requisitionService.update(formModal.editing._id, payload);

        if (submit) await requisitionService.submit(formModal.editing._id);
      } else {
        await requisitionService.create({ ...payload, submit });
      }

      flash('success', submit ? 'Hiring request submitted to HR' : 'Draft saved');
      setFormModal({ open: false, editing: null });
      load();
    } catch (err) {
      flash('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  const submitRow = async (row) => {
    setBusy(true);

    try {
      await requisitionService.submit(row._id);
      flash('success', `${row.code} submitted to HR`);
      load();
    } catch (err) {
      flash('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  const removeRow = async (row) => {
    setBusy(true);

    try {
      await requisitionService.remove(row._id);
      flash('success', 'Draft deleted');
      load();
    } catch (err) {
      flash('error', errText(err));
    } finally {
      setBusy(false);
    }
  };

  const cards = useMemo(
    () => [
      { key: 'DRAFT', label: 'Drafts', icon: Pencil, value: summary.DRAFT || 0 },
      { key: 'PENDING_HR', label: 'Pending HR', icon: Clock, value: summary.PENDING_HR || 0 },
      { key: 'APPROVED', label: 'Approved', icon: CheckCircle2, value: summary.APPROVED || 0 },
      { key: 'SENT_BACK', label: 'Sent back', icon: RotateCcw, value: summary.SENT_BACK || 0 },
      { key: 'REJECTED', label: 'Rejected', icon: X, value: summary.REJECTED || 0 },
    ],
    [summary],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <ClipboardList size={22} className="text-indigo-400" />
            Hiring Requests
          </h1>

          <p className="text-sm text-crewly-dim">
            Raise a requisition for a new employee. HR reviews it before a job is published.
          </p>
        </div>

        <button onClick={openCreate} className="btn-primary gap-2">
          <Plus size={16} />
          New request
        </button>
      </div>

      {banner && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            banner.type === 'error'
              ? 'border-crewly-red/40 bg-crewly-red/10 text-crewly-red'
              : 'border-crewly-green/40 bg-crewly-green/10 text-crewly-green'
          }`}
        >
          {banner.text}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {cards.map((card) => (
          <button
            key={card.key}
            onClick={() => setStatusFilter(statusFilter === card.key ? '' : card.key)}
            className={`card flex items-center gap-3 p-4 text-left transition ${
              statusFilter === card.key ? 'border-indigo-400' : ''
            }`}
          >
            <card.icon size={18} className="text-crewly-dim" />

            <div>
              <p className="text-xl font-semibold">{card.value}</p>
              <p className="text-xs text-crewly-dim">{card.label}</p>
            </div>
          </button>
        ))}
      </div>

      <div className="card overflow-x-auto p-0">
        {loading ? (
          <p className="flex items-center gap-2 p-6 text-sm text-crewly-dim">
            <Loader2 size={16} className="animate-spin" /> Loading hiring requests…
          </p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-crewly-dim">
            No hiring requests yet. Click “New request” to raise one.
          </p>
        ) : (
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-crewly-border text-left text-xs uppercase text-crewly-dim">
              <tr>
                <th className="p-3">Reference</th>
                <th className="p-3">Position</th>
                <th className="p-3">Department</th>
                <th className="p-3">Openings</th>
                <th className="p-3">Priority</th>
                <th className="p-3">Status</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => (
                <tr key={row._id} className="border-b border-crewly-border/60 last:border-0">
                  <td className="p-3 font-mono text-xs">{row.code}</td>

                  <td className="p-3">
                    <button
                      onClick={() => setDetail(row)}
                      className="font-medium hover:text-indigo-400"
                    >
                      {row.position}
                    </button>

                    <p className="text-xs text-crewly-dim">{row.designation || '—'}</p>
                  </td>

                  <td className="p-3 text-crewly-dim">{row.department?.name || '—'}</td>

                  <td className="p-3">{row.openings}</td>

                  <td className="p-3">
                    <span className={`badge ${PRIORITY_STYLE[row.priority] || ''}`}>
                      {pretty(row.priority)}
                    </span>
                  </td>

                  <td className="p-3">
                    <span className={`badge ${STATUS_STYLE[row.status] || ''}`}>
                      {pretty(row.status)}
                    </span>
                  </td>

                  <td className="p-3">
                    <div className="flex justify-end gap-2">
                      {['DRAFT', 'SENT_BACK'].includes(row.status) && (
                        <>
                          <button
                            onClick={() => openEdit(row)}
                            className="rounded-lg border border-crewly-border p-2 hover:border-indigo-400"
                            title="Edit"
                          >
                            <Pencil size={14} />
                          </button>

                          <button
                            disabled={busy}
                            onClick={() => submitRow(row)}
                            className="rounded-lg border border-crewly-border p-2 text-crewly-green hover:border-crewly-green"
                            title="Submit to HR"
                          >
                            <Send size={14} />
                          </button>
                        </>
                      )}

                      {row.status === 'DRAFT' && (
                        <button
                          disabled={busy}
                          onClick={() => removeRow(row)}
                          className="rounded-lg border border-crewly-border p-2 text-crewly-red hover:border-crewly-red"
                          title="Delete draft"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {canReview && (
        <p className="text-xs text-crewly-dim">
          You review requests in Recruitment → Requisition Review.
        </p>
      )}

      {formModal.open && (
        <Modal
          title={formModal.editing ? `Edit ${formModal.editing.code}` : 'New hiring request'}
          onClose={() => setFormModal({ open: false, editing: null })}
        >
          <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
            <Field label="Position *">
              <input
                className="input"
                value={form.position}
                onChange={(e) => setForm({ ...form, position: e.target.value })}
                placeholder="React Developer"
              />
            </Field>

            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Designation">
                <input
                  className="input"
                  value={form.designation}
                  onChange={(e) => setForm({ ...form, designation: e.target.value })}
                />
              </Field>

              <Field label="Department">
                <select
                  className="input"
                  value={form.department}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                >
                  <option value="">—</option>

                  {departments.map((d) => (
                    <option key={d._id} value={d._id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Team">
                <input
                  className="input"
                  value={form.team}
                  onChange={(e) => setForm({ ...form, team: e.target.value })}
                />
              </Field>

              <Field label="Openings">
                <input
                  type="number"
                  min="1"
                  className="input"
                  value={form.openings}
                  onChange={(e) => setForm({ ...form, openings: e.target.value })}
                />
              </Field>

              <Field label="Hiring type">
                <select
                  className="input"
                  value={form.hiringType}
                  onChange={(e) => setForm({ ...form, hiringType: e.target.value })}
                >
                  {['FRESHER', 'EXPERIENCED', 'BOTH'].map((v) => (
                    <option key={v} value={v}>
                      {pretty(v)}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Priority">
                <select
                  className="input"
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                >
                  {['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((v) => (
                    <option key={v} value={v}>
                      {pretty(v)}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Min experience (years)">
                <input
                  type="number"
                  min="0"
                  className="input"
                  value={form.minExperience}
                  onChange={(e) => setForm({ ...form, minExperience: e.target.value })}
                />
              </Field>

              <Field label="Max experience (years)">
                <input
                  type="number"
                  min="0"
                  className="input"
                  value={form.maxExperience}
                  onChange={(e) => setForm({ ...form, maxExperience: e.target.value })}
                />
              </Field>

              <Field label="Min salary (₹)">
                <input
                  type="number"
                  min="0"
                  className="input"
                  value={form.minSalary}
                  onChange={(e) => setForm({ ...form, minSalary: e.target.value })}
                />
              </Field>

              <Field label="Max salary (₹)">
                <input
                  type="number"
                  min="0"
                  className="input"
                  value={form.maxSalary}
                  onChange={(e) => setForm({ ...form, maxSalary: e.target.value })}
                />
              </Field>

              <Field label="Hiring budget (₹)">
                <input
                  type="number"
                  min="0"
                  className="input"
                  value={form.hiringBudget}
                  onChange={(e) => setForm({ ...form, hiringBudget: e.target.value })}
                />
              </Field>

              <Field label="Expected joining date">
                <input
                  type="date"
                  className="input"
                  value={form.expectedJoiningDate}
                  onChange={(e) => setForm({ ...form, expectedJoiningDate: e.target.value })}
                />
              </Field>

              <Field label="Employment type">
                <select
                  className="input"
                  value={form.employmentType}
                  onChange={(e) => setForm({ ...form, employmentType: e.target.value })}
                >
                  {['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'].map((v) => (
                    <option key={v} value={v}>
                      {pretty(v)}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Work mode">
                <select
                  className="input"
                  value={form.workMode}
                  onChange={(e) => setForm({ ...form, workMode: e.target.value })}
                >
                  {['ONSITE', 'HYBRID', 'REMOTE'].map((v) => (
                    <option key={v} value={v}>
                      {pretty(v)}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Location">
                <input
                  className="input"
                  value={form.location}
                  onChange={(e) => setForm({ ...form, location: e.target.value })}
                  placeholder="Chennai"
                />
              </Field>

              <Field label="Hiring reason">
                <select
                  className="input"
                  value={form.hiringReason}
                  onChange={(e) => setForm({ ...form, hiringReason: e.target.value })}
                >
                  {[
                    'NEW_POSITION',
                    'REPLACEMENT',
                    'BACKFILL',
                    'EXPANSION',
                    'PROJECT_BASED',
                    'OTHER',
                  ].map((v) => (
                    <option key={v} value={v}>
                      {pretty(v)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Required skills (comma separated)">
              <input
                className="input"
                value={form.requiredSkills}
                onChange={(e) => setForm({ ...form, requiredSkills: e.target.value })}
                placeholder="React, Node.js, MongoDB"
              />
            </Field>

            <Field label="Preferred skills (comma separated)">
              <input
                className="input"
                value={form.preferredSkills}
                onChange={(e) => setForm({ ...form, preferredSkills: e.target.value })}
                placeholder="Redis, Docker"
              />
            </Field>

            <Field label="Reason note">
              <input
                className="input"
                value={form.reasonNote}
                onChange={(e) => setForm({ ...form, reasonNote: e.target.value })}
              />
            </Field>

            <Field label="Additional requirements">
              <textarea
                rows="3"
                className="input"
                value={form.additionalRequirements}
                onChange={(e) => setForm({ ...form, additionalRequirements: e.target.value })}
              />
            </Field>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              disabled={busy}
              onClick={() => save(false)}
              className="btn-ghost gap-2"
            >
              Save draft
            </button>

            <button
              disabled={busy}
              onClick={() => save(true)}
              className="btn-primary gap-2"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              Submit to HR
            </button>
          </div>
        </Modal>
      )}

      {detail && (
        <Modal title={`${detail.code} · ${detail.position}`} onClose={() => setDetail(null)}>
          <RequisitionDetail row={detail} />
        </Modal>
      )}
    </div>
  );
};

export const Field = ({ label, children }) => (
  <div>
    <label className="label">{label}</label>
    {children}
  </div>
);

export const RequisitionDetail = ({ row }) => (
  <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1 text-sm">
    <div className="flex flex-wrap gap-2">
      <span className={`badge ${STATUS_STYLE[row.status] || ''}`}>{pretty(row.status)}</span>

      <span className={`badge ${PRIORITY_STYLE[row.priority] || ''}`}>
        {pretty(row.priority)} priority
      </span>

      <span className="badge bg-white/10 text-crewly-dim">{row.openings} opening(s)</span>
    </div>

    <div className="grid gap-2 md:grid-cols-2">
      <Info label="Requester" value={row.requester?.name} />
      <Info label="Department" value={row.department?.name} />
      <Info label="Team" value={row.team} />
      <Info label="Designation" value={row.designation} />
      <Info label="Hiring type" value={pretty(row.hiringType)} />
      <Info label="Experience" value={`${row.minExperience || 0}–${row.maxExperience || 0} yrs`} />
      <Info label="Employment" value={pretty(row.employmentType)} />
      <Info label="Work mode" value={pretty(row.workMode)} />
      <Info label="Location" value={row.location} />
      <Info label="Expected joining" value={isoDate(row.expectedJoiningDate)} />
      <Info label="Salary range" value={`${money(row.minSalary)} – ${money(row.maxSalary)}`} />
      <Info label="Hiring budget" value={money(row.hiringBudget)} />
      <Info label="Hiring reason" value={pretty(row.hiringReason)} />
    </div>

    {(row.requiredSkills?.length || 0) > 0 && (
      <div>
        <p className="label">Required skills</p>

        <div className="flex flex-wrap gap-2">
          {row.requiredSkills.map((skill) => (
            <span key={skill} className="badge bg-indigo-400/15 text-indigo-300">
              {skill}
            </span>
          ))}
        </div>
      </div>
    )}

    {(row.preferredSkills?.length || 0) > 0 && (
      <div>
        <p className="label">Preferred skills</p>

        <div className="flex flex-wrap gap-2">
          {row.preferredSkills.map((skill) => (
            <span key={skill} className="badge bg-white/10 text-crewly-dim">
              {skill}
            </span>
          ))}
        </div>
      </div>
    )}

    {row.additionalRequirements && (
      <div>
        <p className="label">Additional requirements</p>
        <p className="whitespace-pre-wrap text-crewly-dim">{row.additionalRequirements}</p>
      </div>
    )}

    {row.decisionReason && (
      <div className="flex gap-2 rounded-lg border border-yellow-400/40 bg-yellow-400/10 p-3 text-yellow-200">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <span>{row.decisionReason}</span>
      </div>
    )}

    <div>
      <p className="label">History</p>

      <ul className="space-y-2">
        {(row.history || []).map((entry, index) => (
          <li key={index} className="rounded-lg border border-crewly-border p-2 text-xs">
            <p className="font-medium">{pretty(entry.action)}</p>

            <p className="text-crewly-dim">
              {entry.actorName || 'System'} · {new Date(entry.at).toLocaleString('en-IN')}
            </p>

            {entry.reason && <p className="mt-1 text-crewly-dim">“{entry.reason}”</p>}
          </li>
        ))}
      </ul>
    </div>
  </div>
);

export const Info = ({ label, value }) => (
  <div>
    <p className="text-xs text-crewly-dim">{label}</p>
    <p>{value || '—'}</p>
  </div>
);

export default RequisitionsPage;
