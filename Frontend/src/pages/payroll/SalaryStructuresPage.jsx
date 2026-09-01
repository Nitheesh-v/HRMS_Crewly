/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from 'lucide-react';
import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import salaryStructureService from '../../services/salaryStructureService.js';

// ── display mirrors of the backend rules (the server always decides) ────────

const CATEGORIES = [
  { value: 'EARNING', label: 'Earnings' },
  { value: 'DEDUCTION', label: 'Deductions' },
  { value: 'EMPLOYER_CONTRIBUTION', label: 'Employer Contributions' },
];

const METHODS = [
  { value: 'FIXED_AMOUNT', label: 'Fixed Amount', unit: 'Rs', needsValue: true },
  { value: 'PERCENTAGE_OF_GROSS', label: 'Percentage of Gross', unit: '%', needsValue: true },
  { value: 'PERCENTAGE_OF_BASIC', label: 'Percentage of Basic', unit: '%', needsValue: true },
  { value: 'PERCENTAGE_OF_CTC', label: 'Percentage of CTC', unit: '%', needsValue: true },
  { value: 'REMAINING', label: 'Remaining Amount', unit: '', needsValue: false },
];

const STATUSES = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'ARCHIVED', label: 'Archived' },
];

const emptyForm = {
  name: '',
  code: '',
  description: '',
  designation: '',
  effectiveFrom: new Date().toISOString().slice(0, 10),
  items: [],
};

const toForm = (structure) => ({
  ...emptyForm,
  ...(structure || {}),
  designation: structure?.designation || '',
  effectiveFrom: structure?.effectiveFrom
    ? new Date(structure.effectiveFrom).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10),
  items: (structure?.items || []).map((item, index) => ({
    componentCode: item.componentCode,
    calculationMethod: item.calculationMethod,
    value: item.value ?? '',
    order: Number.isInteger(item.order) ? item.order : index,
  })),
});

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

const formatMoney = (value) => `Rs ${Number(value || 0).toLocaleString('en-IN')}`;

const methodOf = (value) => METHODS.find((method) => method.value === value) || METHODS[0];

const statusBadge = (status) => {
  const styles = {
    ACTIVE: 'bg-emerald-500/15 text-emerald-300',
    DRAFT: 'bg-indigo-500/15 text-indigo-300',
    INACTIVE: 'bg-slate-700/40 text-slate-300',
    ARCHIVED: 'bg-amber-500/15 text-amber-300',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] ${styles[status] || styles.INACTIVE}`}>
      {status ? status.charAt(0) + status.slice(1).toLowerCase() : '—'}
    </span>
  );
};

const SalaryStructuresPage = () => {
  const { loading: permsLoading, hasPermission, hasAnyPermission } = usePermission();

  const [loading, setLoading] = useState(true);
  const [structures, setStructures] = useState([]);
  const [components, setComponents] = useState([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 25, pages: 1 });
  const [banner, setBanner] = useState(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  const [filters, setFilters] = useState({ search: '', status: 'ALL', page: 1 });

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [sampleGross, setSampleGross] = useState('50000');
  const [preview, setPreview] = useState(null);
  const [detail, setDetail] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [addCode, setAddCode] = useState('');

  const canView = hasAnyPermission([
    'SALARY_STRUCTURE_READ',
    'SALARY_STRUCTURE_MANAGE',
    'SALARY_STRUCTURE_ACTIVATE',
  ]);
  const canManage = hasPermission('SALARY_STRUCTURE_MANAGE');
  const canActivate = hasPermission('SALARY_STRUCTURE_ACTIVATE');
  const noAccess = !permsLoading && !canView;

  const flash = useCallback((type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 5000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await salaryStructureService.list({
        search: filters.search || undefined,
        status: filters.status === 'ALL' ? undefined : filters.status,
        page: filters.page,
      });
      setStructures(data?.data || []);
      setComponents(data?.meta?.components || []);
      setMeta(
        data?.meta || { total: 0, page: 1, limit: 25, pages: 1 },
      );
      setAccessDenied(false);
    } catch (error) {
      if (error?.status === 403 || error?.code === 'PERMISSION_DENIED') {
        setAccessDenied(true);
      } else {
        flash('error', error?.message || 'Unable to load salary structures');
      }
    } finally {
      setLoading(false);
    }
  }, [filters, flash]);

  useEffect(() => {
    if (!permsLoading && canView) load();
    if (!permsLoading && !canView) setLoading(false);
  }, [permsLoading, canView, load]);

  // ── §9 live preview — pure, server-computed, never stored
  useEffect(() => {
    if (!formOpen || form.items.length === 0) {
      setPreview(null);
      return undefined;
    }

    const timer = setTimeout(async () => {
      try {
        const data = await salaryStructureService.preview({
          items: form.items.map((item) => ({
            componentCode: item.componentCode,
            calculationMethod: item.calculationMethod,
            value: item.value === '' ? null : Number(item.value),
            order: item.order,
          })),
          gross: Number(sampleGross) || 0,
        });
        setPreview(data?.data || null);
      } catch {
        setPreview(null);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [formOpen, form.items, sampleGross]);

  const componentByCode = useMemo(
    () => Object.fromEntries(components.map((component) => [component.code, component])),
    [components],
  );

  const availableComponents = useMemo(
    () => components.filter((component) => !form.items.some((item) => item.componentCode === component.code)),
    [components, form.items],
  );

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setAddCode('');
    setFormOpen(true);
  };

  const openEdit = async (structure) => {
    if (!components.length) await load();
    setEditingId(structure._id);
    setForm(toForm(structure));
    setAddCode('');
    setFormOpen(true);
  };

  const openDetail = async (structure) => {
    try {
      const data = await salaryStructureService.get(structure._id);
      setDetail(data?.data || structure);
    } catch {
      setDetail(structure);
    }
  };

  const addComponent = () => {
    if (!addCode) return;
    setForm((prev) => ({
      ...prev,
      items: [
        ...prev.items,
        {
          componentCode: addCode,
          calculationMethod: 'FIXED_AMOUNT',
          value: '',
          order: prev.items.length,
        },
      ],
    }));
    setAddCode('');
  };

  const updateItem = (index, patch) =>
    setForm((prev) => ({
      ...prev,
      items: prev.items.map((item, position) =>
        position === index
          ? {
              ...item,
              ...patch,
              // Remaining Amount has no value of its own.
              value: patch.calculationMethod === 'REMAINING' ? null : (patch.value ?? item.value),
            }
          : item,
      ),
    }));

  const removeItem = (index) =>
    setForm((prev) => ({
      ...prev,
      items: prev.items
        .filter((_, position) => position !== index)
        .map((item, position) => ({ ...item, order: position })),
    }));

  const moveItem = (index, direction) =>
    setForm((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.items.length) return prev;
      const items = [...prev.items];
      [items[index], items[target]] = [items[target], items[index]];
      return { ...prev, items: items.map((item, position) => ({ ...item, order: position })) };
    });

  const submit = async () => {
    setBusy(true);
    try {
      const payload = {
        name: form.name,
        code: form.code,
        description: form.description,
        designation: form.designation,
        effectiveFrom: form.effectiveFrom,
        sampleGross: Number(sampleGross) || 0,
        items: form.items.map((item, index) => ({
          componentCode: item.componentCode,
          calculationMethod: item.calculationMethod,
          value: item.value === '' || item.value === null ? null : Number(item.value),
          order: index,
        })),
      };

      const data = editingId
        ? await salaryStructureService.update(editingId, payload)
        : await salaryStructureService.create(payload);

      flash('success', data?.message || 'Salary structure saved successfully.');
      setFormOpen(false);
      await load();
    } catch (error) {
      flash('error', error?.message || 'Could not save this salary structure');
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (structure, status) => {
    setBusy(true);
    try {
      const data = await salaryStructureService.setStatus(structure._id, status);
      flash('success', data?.message || 'Salary structure updated successfully.');
      setConfirm(null);
      if (detail?._id === structure._id) setDetail(null);
      await load();
    } catch (error) {
      flash('error', error?.message || 'Could not change the structure status');
    } finally {
      setBusy(false);
    }
  };

  const clone = async (structure) => {
    setBusy(true);
    try {
      const data = await salaryStructureService.clone(structure._id, {
        name: `${structure.name} Copy`,
        code: `${structure.code}_COPY`,
      });
      flash('success', data?.message || 'Salary structure cloned successfully.');
      await load();
    } catch (error) {
      flash('error', error?.message || 'Could not clone this structure');
    } finally {
      setBusy(false);
    }
  };

  if (noAccess || accessDenied) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Salary Structures</h1>
        <div className="card space-y-2">
          <h2 className="text-lg font-semibold">Payroll access required</h2>
          <p className="text-sm text-crewly-dim">
            You don&apos;t have permission to manage salary structures. Contact your Company Admin or
            Payroll Administrator.
          </p>
        </div>
      </div>
    );
  }

  const previewRows = (rows = []) =>
    rows.map((row) => (
      <tr key={`${row.componentCode}-${row.order}`} className="border-b border-crewly-border/60">
        <td className="py-1.5 pr-3">{row.name}</td>
        <td className="py-1.5 pr-3 text-crewly-dim">{row.methodLabel}</td>
        <td className="py-1.5 pr-3 text-right">
          {row.isRemaining ? '—' : `${row.value}${methodOf(row.calculationMethod).unit === '%' ? '%' : ''}`}
        </td>
        <td className="py-1.5 text-right">{formatMoney(row.amount)}</td>
      </tr>
    ));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Salary Structures</h1>
          <p className="mt-1 text-sm text-crewly-dim">
            Reusable templates that assemble your salary components into a complete salary. A structure
            is not an employee salary — employees are assigned to one in the next phase.
          </p>
        </div>
        {canManage && (
          <button type="button" className="btn-primary" onClick={openCreate} disabled={busy}>
            <Plus size={14} className="mr-1 inline" />
            Create Structure
          </button>
        )}
      </div>

      {banner && (
        <div
          className={`card text-sm ${
            banner.type === 'error'
              ? 'border-red-500/40 text-red-300'
              : 'border-emerald-500/40 text-emerald-300'
          }`}
        >
          {banner.text}
        </div>
      )}

      {/* §15 — filters */}
      <div className="card grid gap-3 md:grid-cols-3">
        <input
          className="input"
          placeholder="Search name, code or description"
          value={filters.search}
          onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value, page: 1 }))}
        />
        <select
          className="input"
          value={filters.status}
          onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value, page: 1 }))}
        >
          {STATUSES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="flex items-center justify-end text-xs text-crewly-dim">
          {meta.total} structure(s)
        </div>
      </div>

      <div className="card">
        {loading ? (
          <p className="text-sm text-crewly-dim">Loading salary structures…</p>
        ) : structures.length === 0 ? (
          <div className="space-y-3 py-6 text-center">
            <h2 className="text-lg font-semibold">No Salary Structures Yet</h2>
            <p className="mx-auto max-w-xl text-sm text-crewly-dim">
              Structures are built from the salary components of this company. Create the components
              first, then assemble them here — for example Basic + HRA + Special Allowance − PF.
            </p>
            {canManage && (
              <button type="button" className="btn-primary" onClick={openCreate}>
                Create Salary Structure
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-crewly-border text-xs uppercase tracking-wide text-crewly-dim">
                    <th className="py-2 pr-3">Structure</th>
                    <th className="py-2 pr-3">Code</th>
                    <th className="py-2 pr-3">Components</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Version</th>
                    <th className="py-2 pr-3">Effective</th>
                    <th className="py-2 pr-3">Employees Using</th>
                    <th className="py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {structures.map((structure) => (
                    <tr key={structure._id} className="border-b border-crewly-border/60">
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          className="font-medium text-crewly-text hover:underline"
                          onClick={() => openDetail(structure)}
                        >
                          {structure.name}
                        </button>
                        {structure.designation ? (
                          <div className="text-xs text-crewly-dim">{structure.designation}</div>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">{structure.code}</td>
                      <td className="py-2 pr-3 text-xs text-crewly-dim">
                        {structure.componentCount || 0} total ·{' '}
                        {structure.earnings ?? 0} earnings · {structure.deductions ?? 0} deductions
                        {structure.employerContributions ? ` · ${structure.employerContributions} employer` : ''}
                      </td>
                      <td className="py-2 pr-3">{statusBadge(structure.status)}</td>
                      <td className="py-2 pr-3">v{structure.version || 1}</td>
                      <td className="py-2 pr-3">{formatDate(structure.effectiveFrom)}</td>
                      <td className="py-2 pr-3" title="Employee assignment arrives in the next payroll phase">
                        0
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {canManage && (
                            <button
                              type="button"
                              className="text-xs text-indigo-300 hover:underline"
                              onClick={() => openEdit(structure)}
                            >
                              Edit
                            </button>
                          )}
                          {canManage && (
                            <button
                              type="button"
                              className="text-xs text-indigo-300 hover:underline"
                              onClick={() => clone(structure)}
                            >
                              <Copy size={11} className="mr-1 inline" />
                              Clone
                            </button>
                          )}
                          {canActivate && structure.status !== 'ARCHIVED' && (
                            <button
                              type="button"
                              className="text-xs text-amber-300 hover:underline"
                              onClick={() =>
                                structure.status === 'ACTIVE'
                                  ? setConfirm({ structure, status: 'INACTIVE' })
                                  : changeStatus(structure, 'ACTIVE')
                              }
                            >
                              {structure.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {meta.pages > 1 && (
              <div className="mt-4 flex items-center justify-between text-sm">
                <span className="text-crewly-dim">
                  Page {meta.page} of {meta.pages} · {meta.total} structure(s)
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={meta.page <= 1}
                    onClick={() => setFilters((prev) => ({ ...prev, page: prev.page - 1 }))}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={meta.page >= meta.pages}
                    onClick={() => setFilters((prev) => ({ ...prev, page: prev.page + 1 }))}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {components.length === 0 && !loading && (
        <div className="card text-sm text-crewly-dim">
          No active salary components in this company yet. Create and activate components first — a
          structure can only use components that are active here.
        </div>
      )}

      {/* §6 / §9 — builder with live preview */}
      {formOpen && (
        <Modal
          title={editingId ? 'Edit Salary Structure' : 'Create Salary Structure'}
          onClose={() => setFormOpen(false)}
          wide
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Structure Details</h3>

              <label className="label block">
                Structure Name
                <input
                  className="input mt-1 w-full"
                  value={form.name}
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Standard Monthly Structure"
                />
              </label>

              <label className="label block">
                Structure Code
                <input
                  className="input mt-1 w-full"
                  value={form.code}
                  onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value }))}
                  placeholder="STD-2026"
                />
              </label>

              <label className="label block">
                Description
                <textarea
                  className="input mt-1 w-full"
                  rows={2}
                  value={form.description}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, description: event.target.value }))
                  }
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="label block">
                  Designation (optional)
                  <input
                    className="input mt-1 w-full"
                    value={form.designation}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, designation: event.target.value }))
                    }
                    placeholder="Software Engineer"
                  />
                </label>
                <label className="label block">
                  Effective From
                  <input
                    type="date"
                    className="input mt-1 w-full"
                    value={form.effectiveFrom}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, effectiveFrom: event.target.value }))
                    }
                  />
                </label>
              </div>

              {/* §11 — up / down ordering, no drag-and-drop dependency */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Components</h3>
                  <span className="text-xs text-crewly-dim">{form.items.length} selected</span>
                </div>

                <div className="flex gap-2">
                  <select
                    className="input flex-1"
                    value={addCode}
                    onChange={(event) => setAddCode(event.target.value)}
                  >
                    <option value="">Add a component…</option>
                    {CATEGORIES.map((category) => {
                      const rows = availableComponents.filter(
                        (component) => component.category === category.value,
                      );
                      if (!rows.length) return null;
                      return (
                        <optgroup key={category.value} label={category.label}>
                          {rows.map((component) => (
                            <option key={component.code} value={component.code}>
                              {component.name} ({component.code})
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={addComponent}
                    disabled={!addCode}
                  >
                    Add
                  </button>
                </div>

                {form.items.length === 0 ? (
                  <p className="text-xs text-crewly-dim">
                    No components added yet. Add at least one earning component.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {form.items.map((item, index) => {
                      const component = componentByCode[item.componentCode] || {};
                      const method = methodOf(item.calculationMethod);
                      return (
                        <div
                          key={`${item.componentCode}-${index}`}
                          className="rounded border border-crewly-border p-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="text-sm font-medium">
                                {component.name || item.componentCode}
                              </div>
                              <div className="text-[11px] uppercase tracking-wide text-crewly-dim">
                                {component.category || '—'}
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                className="btn-ghost px-1"
                                title="Move up"
                                onClick={() => moveItem(index, -1)}
                                disabled={index === 0}
                              >
                                <ArrowUp size={12} />
                              </button>
                              <button
                                type="button"
                                className="btn-ghost px-1"
                                title="Move down"
                                onClick={() => moveItem(index, 1)}
                                disabled={index === form.items.length - 1}
                              >
                                <ArrowDown size={12} />
                              </button>
                              <button
                                type="button"
                                className="btn-ghost px-1 text-red-300"
                                title="Remove"
                                onClick={() => removeItem(index)}
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          </div>

                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <select
                              className="input"
                              value={item.calculationMethod}
                              onChange={(event) =>
                                updateItem(index, { calculationMethod: event.target.value })
                              }
                            >
                              {METHODS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            <input
                              className="input"
                              type="number"
                              min="0"
                              step="0.01"
                              disabled={!method.needsValue}
                              placeholder={method.needsValue ? method.unit : 'Calculated'}
                              value={method.needsValue ? item.value ?? '' : ''}
                              onChange={(event) => updateItem(index, { value: event.target.value })}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* §9 — live preview, never stored */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Live Preview</h3>

              <label className="label block">
                Sample Gross Salary (Rs)
                <input
                  className="input mt-1 w-full"
                  type="number"
                  min="0"
                  value={sampleGross}
                  onChange={(event) => setSampleGross(event.target.value)}
                />
              </label>

              {!preview ? (
                <p className="text-xs text-crewly-dim">
                  Add at least one component to see how this structure splits the salary.
                </p>
              ) : (
                <div className="space-y-3">
                  {CATEGORIES.map((category) => {
                    const rows =
                      category.value === 'EARNING'
                        ? preview.earnings
                        : category.value === 'DEDUCTION'
                          ? preview.deductions
                          : preview.employerContributions;
                    if (!rows || rows.length === 0) return null;
                    return (
                      <div key={category.value}>
                        <div className="text-xs uppercase tracking-wide text-crewly-dim">
                          {category.label}
                        </div>
                        <table className="w-full text-left text-xs">
                          <tbody>{previewRows(rows)}</tbody>
                        </table>
                      </div>
                    );
                  })}

                  <div className="rounded border border-crewly-border p-3 text-sm">
                    <div className="flex justify-between">
                      <span className="text-crewly-dim">Gross Salary</span>
                      <span>{formatMoney(preview.totals.gross)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-crewly-dim">Total Deductions</span>
                      <span>{formatMoney(preview.totals.totalDeductions)}</span>
                    </div>
                    <div className="flex justify-between font-semibold">
                      <span>Net Pay</span>
                      <span>{formatMoney(preview.totals.netPay)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-crewly-dim">Employer Cost</span>
                      <span>{formatMoney(preview.totals.employerCost)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-crewly-dim">CTC</span>
                      <span>{formatMoney(preview.totals.ctc)}</span>
                    </div>
                  </div>

                  <p className="text-[11px] text-crewly-dim">
                    This preview only visualises the sample gross you typed. Nothing is saved and no
                    employee salary is calculated here.
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setFormOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={submit}
              disabled={busy || form.items.length === 0}
            >
              {editingId ? 'Save Changes' : 'Create Structure'}
            </button>
          </div>
        </Modal>
      )}

      {/* §13 / §17 / §16 — detail with usage and version history */}
      {detail && (
        <Modal title={detail.name} onClose={() => setDetail(null)} wide>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 text-sm">
              <h3 className="text-sm font-semibold">Details</h3>
              <div className="flex justify-between">
                <span className="text-crewly-dim">Code</span>
                <span className="font-mono text-xs">{detail.code}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-crewly-dim">Status</span>
                <span>{statusBadge(detail.status)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-crewly-dim">Version</span>
                <span>v{detail.version || 1}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-crewly-dim">Effective From</span>
                <span>{formatDate(detail.effectiveFrom)}</span>
              </div>
              {detail.designation ? (
                <div className="flex justify-between">
                  <span className="text-crewly-dim">Designation</span>
                  <span>{detail.designation}</span>
                </div>
              ) : null}
              {detail.description ? (
                <p className="pt-2 text-sm text-crewly-dim">{detail.description}</p>
              ) : null}
            </div>

            <div className="space-y-2 text-sm">
              <h3 className="text-sm font-semibold">Usage</h3>
              <div className="flex justify-between">
                <span className="text-crewly-dim">Employees using</span>
                <span>{detail.usage?.employees ?? 0}</span>
              </div>
              <p className="text-xs text-crewly-dim">
                Employees are assigned to a structure in the next payroll phase, so this count is 0
                today. Payroll history: {detail.usage?.hasProcessedPayroll ? 'present' : 'none'}.
              </p>
              <h3 className="pt-2 text-sm font-semibold">Versions</h3>
              <ul className="space-y-1 text-xs">
                {(detail.history || []).map((version) => (
                  <li key={version._id} className="flex justify-between">
                    <span>
                      v{version.version} · {version.status}
                      {version.isCurrent ? ' · current' : ''}
                    </span>
                    <span className="text-crewly-dim">{formatDate(version.effectiveFrom)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            <h3 className="text-sm font-semibold">Components</h3>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-crewly-border text-xs uppercase tracking-wide text-crewly-dim">
                  <th className="py-1.5 pr-3">Component</th>
                  <th className="py-1.5 pr-3">Method</th>
                  <th className="py-1.5">Value</th>
                </tr>
              </thead>
              <tbody>
                {(detail.items || []).map((item, index) => (
                  <tr key={`${item.componentCode}-${index}`} className="border-b border-crewly-border/60">
                    <td className="py-1.5 pr-3">
                      {(detail.components || []).find((row) => row.code === item.componentCode)?.name ||
                        item.componentCode}
                    </td>
                    <td className="py-1.5 pr-3">{methodOf(item.calculationMethod).label}</td>
                    <td className="py-1.5">
                      {item.calculationMethod === 'REMAINING'
                        ? 'Calculated'
                        : `${item.value}${methodOf(item.calculationMethod).unit === '%' ? '%' : ''}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {confirm && (
        <Modal title="Change structure status" onClose={() => setConfirm(null)}>
          <p className="text-sm text-crewly-dim">
            Set <span className="text-crewly-text">{confirm.structure.name}</span> to{' '}
            {confirm.status.toLowerCase()}? Existing assignments keep using the structure until you
            replace them.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => changeStatus(confirm.structure, confirm.status)}
              disabled={busy}
            >
              Confirm
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default SalaryStructuresPage;
