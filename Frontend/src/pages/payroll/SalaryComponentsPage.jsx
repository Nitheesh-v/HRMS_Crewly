/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Sparkles } from 'lucide-react';
import Modal from '../../components/Modal.jsx';
import usePermission from '../../hooks/usePermission.js';
import salaryComponentService from '../../services/salaryComponentService.js';

// ── domain mirrors of the backend rules (display only; the server decides) ──

const CATEGORIES = [
  { value: 'EARNING', label: 'Earning' },
  { value: 'DEDUCTION', label: 'Deduction' },
  { value: 'EMPLOYER_CONTRIBUTION', label: 'Employer Contribution' },
];

const CALCULATION_TYPES = [
  { value: 'FIXED_AMOUNT', label: 'Fixed Amount' },
  { value: 'PERCENTAGE', label: 'Percentage' },
  { value: 'FORMULA', label: 'Formula' },
];

const CALCULATION_BASES = [
  { value: 'BASIC', label: 'Basic Salary' },
  { value: 'GROSS', label: 'Gross Salary' },
  { value: 'CTC', label: 'CTC' },
  { value: 'COMPONENT', label: 'Another Component' },
];

const TAXABILITIES = [
  { value: 'TAXABLE', label: 'Taxable' },
  { value: 'NON_TAXABLE', label: 'Non-taxable' },
  { value: 'PARTIALLY_TAXABLE', label: 'Partially Taxable' },
  { value: 'DEFERRED', label: 'Configured Later' },
];

const emptyForm = {
  name: '',
  code: '',
  description: '',
  category: 'EARNING',
  calculationType: 'FIXED_AMOUNT',
  defaultAmount: '',
  percentage: '',
  calculationBase: '',
  dependsOnCode: '',
  taxability: 'TAXABLE',
  pfApplicable: false,
  esiApplicable: false,
  tdsApplicable: true,
  professionalTaxApplicable: false,
  status: 'ACTIVE',
  effectiveFrom: new Date().toISOString().slice(0, 10),
};

const toForm = (component) => ({
  ...emptyForm,
  ...(component || {}),
  defaultAmount: component?.defaultAmount ?? '',
  percentage: component?.percentage ?? '',
  effectiveFrom: component?.effectiveFrom
    ? new Date(component.effectiveFrom).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10),
});

const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

const formatAmount = (value) =>
  Number.isFinite(Number(value)) && Number(value) > 0 ? `Rs ${Number(value).toLocaleString('en-IN')}` : '—';

const SalaryComponentsPage = () => {
  const { loading: permsLoading, hasPermission, hasAnyPermission } = usePermission();

  const [loading, setLoading] = useState(true);
  const [components, setComponents] = useState([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 25, pages: 1 });
  const [banner, setBanner] = useState(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  const [filters, setFilters] = useState({
    search: '',
    category: 'ALL',
    status: 'ALL',
    calculationType: 'ALL',
    taxability: 'ALL',
    page: 1,
  });

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [confirm, setConfirm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [defaults, setDefaults] = useState(null);

  const canView = hasAnyPermission([
    'SALARY_COMPONENT_READ',
    'SALARY_COMPONENT_MANAGE',
    'SALARY_COMPONENT_ACTIVATE',
  ]);
  const canManage = hasPermission('SALARY_COMPONENT_MANAGE');
  const canActivate = hasPermission('SALARY_COMPONENT_ACTIVATE');
  const noAccess = !permsLoading && !canView;

  const flash = useCallback((type, text) => {
    setBanner({ type, text });
    setTimeout(() => setBanner(null), 4000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await salaryComponentService.list({
        search: filters.search || undefined,
        category: filters.category === 'ALL' ? undefined : filters.category,
        status: filters.status === 'ALL' ? undefined : filters.status,
        calculationType: filters.calculationType === 'ALL' ? undefined : filters.calculationType,
        taxability: filters.taxability === 'ALL' ? undefined : filters.taxability,
        page: filters.page,
      });
      setComponents(data?.data || []);
      setMeta(data?.meta || { total: 0, page: 1, limit: 25, pages: 1 });
      setAccessDenied(false);
    } catch (error) {
      if (error?.status === 403 || error?.code === 'PERMISSION_DENIED') {
        setAccessDenied(true);
      } else {
        flash('error', error?.message || 'Unable to load salary components');
      }
    } finally {
      setLoading(false);
    }
  }, [filters, flash]);

  useEffect(() => {
    if (!permsLoading && canView) load();
    if (!permsLoading && !canView) setLoading(false);
  }, [permsLoading, canView, load]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setFormOpen(true);
  };

  const openEdit = (component) => {
    setEditingId(component._id);
    setForm(toForm(component));
    setFormOpen(true);
  };

  const openDetail = async (component) => {
    try {
      const data = await salaryComponentService.get(component._id);
      setDetail(data?.data || component);
    } catch {
      setDetail(component);
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      const payload = {
        ...form,
        defaultAmount: form.defaultAmount === '' ? null : Number(form.defaultAmount),
        percentage: form.percentage === '' ? null : Number(form.percentage),
        calculationBase: form.calculationType === 'PERCENTAGE' ? form.calculationBase || null : null,
        dependsOnCode:
          form.calculationType === 'PERCENTAGE' && form.calculationBase === 'COMPONENT'
            ? form.dependsOnCode
            : '',
      };

      if (editingId) {
        const data = await salaryComponentService.update(editingId, payload);
        flash('success', data?.message || 'Salary component updated successfully.');
      } else {
        const data = await salaryComponentService.create(payload);
        flash('success', data?.message || 'Salary component created successfully.');
      }

      setFormOpen(false);
      await load();
    } catch (error) {
      flash('error', error?.message || 'Could not save this salary component');
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (component, status) => {
    setBusy(true);
    try {
      const data = await salaryComponentService.setStatus(component._id, status);
      flash('success', data?.message || 'Salary component updated successfully.');
      setConfirm(null);
      if (detail?._id === component._id) setDetail(null);
      await load();
    } catch (error) {
      flash('error', error?.message || 'Could not change the component status');
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async (component) => {
    setBusy(true);
    try {
      const data = await salaryComponentService.duplicate(component._id, {
        name: `${component.name} Copy`,
        code: `${component.code}_COPY`,
      });
      flash('success', data?.message || 'Salary component duplicated successfully.');
      await load();
    } catch (error) {
      flash('error', error?.message || 'Could not duplicate this component');
    } finally {
      setBusy(false);
    }
  };

  const createDefaults = async () => {
    setBusy(true);
    try {
      const data = await salaryComponentService.createDefaults();
      flash('success', data?.message || 'Default salary components created.');
      await load();
    } catch (error) {
      flash('error', error?.message || 'Could not create default components');
    } finally {
      setBusy(false);
    }
  };

  const loadDefaults = async () => {
    try {
      const data = await salaryComponentService.defaults();
      setDefaults(data?.data || []);
    } catch {
      setDefaults([]);
    }
  };

  useEffect(() => {
    if (canManage) loadDefaults();
  }, [canManage]);

  // §29 — only the fields that matter for the chosen calculation type
  const showAmount = form.calculationType === 'FIXED_AMOUNT';
  const showPercentage = form.calculationType === 'PERCENTAGE';
  const showBase = showPercentage;
  const showDependency = showPercentage && form.calculationBase === 'COMPONENT';

  // §30 — plain-language preview before saving
  const preview = useMemo(() => {
    if (showAmount) {
      return form.defaultAmount === ''
        ? 'Fixed amount (set per employee)'
        : `Fixed ${formatAmount(form.defaultAmount)}`;
    }
    if (showPercentage) {
      const pct = form.percentage === '' ? '—' : form.percentage;
      if (form.calculationBase === 'COMPONENT') {
        const dep = components.find((component) => component.code === form.dependsOnCode);
        return `${pct}% of ${dep?.name || form.dependsOnCode || 'another component'}`;
      }
      const base = CALCULATION_BASES.find((option) => option.value === form.calculationBase);
      return `${pct}% of ${base?.label || 'Gross Salary'}`;
    }
    return 'Formula — configured with the controlled rule builder';
  }, [form, showAmount, showPercentage, components]);

  if (noAccess || accessDenied) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Salary Components</h1>
        <div className="card space-y-2">
          <h2 className="text-lg font-semibold">Payroll access required</h2>
          <p className="text-sm text-crewly-dim">
            You don&apos;t have permission to manage salary components. Contact your Company Admin or
            Payroll Administrator.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Salary Components</h1>
          <p className="mt-1 text-sm text-crewly-dim">
            The building blocks of every salary. Structures (next phase) are assembled from
            these components.
          </p>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost" onClick={createDefaults} disabled={busy}>
              <Sparkles size={14} className="mr-1 inline" />
              Add defaults
            </button>
            <button type="button" className="btn-primary" onClick={openCreate} disabled={busy}>
              <Plus size={14} className="mr-1 inline" />
              Create Component
            </button>
          </div>
        )}
      </div>

      {banner && (
        <div
          className={`card text-sm ${
            banner.type === 'error' ? 'border-red-500/40 text-red-300' : 'border-emerald-500/40 text-emerald-300'
          }`}
        >
          {banner.text}
        </div>
      )}

      {/* §26 / §27 — filters + search */}
      <div className="card grid gap-3 md:grid-cols-5">
        <input
          className="input"
          placeholder="Search name, code or description"
          value={filters.search}
          onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value, page: 1 }))}
        />
        <select
          className="input"
          value={filters.category}
          onChange={(event) => setFilters((prev) => ({ ...prev, category: event.target.value, page: 1 }))}
        >
          <option value="ALL">All types</option>
          {CATEGORIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={filters.status}
          onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value, page: 1 }))}
        >
          <option value="ALL">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
        <select
          className="input"
          value={filters.calculationType}
          onChange={(event) =>
            setFilters((prev) => ({ ...prev, calculationType: event.target.value, page: 1 }))
          }
        >
          <option value="ALL">All calculations</option>
          {CALCULATION_TYPES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={filters.taxability}
          onChange={(event) => setFilters((prev) => ({ ...prev, taxability: event.target.value, page: 1 }))}
        >
          <option value="ALL">All taxability</option>
          {TAXABILITIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="card">
        {loading ? (
          <p className="text-sm text-crewly-dim">Loading salary components…</p>
        ) : components.length === 0 ? (
          /* §52 — empty state */
          <div className="space-y-3 py-6 text-center">
            <h2 className="text-lg font-semibold">No Salary Components Yet</h2>
            <p className="mx-auto max-w-xl text-sm text-crewly-dim">
              Create salary components such as Basic, HRA, allowances, bonuses, deductions, and
              employer contributions before building salary structures.
            </p>
            {canManage && (
              <button type="button" className="btn-primary" onClick={openCreate}>
                Create Salary Component
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-crewly-border text-xs uppercase tracking-wide text-crewly-dim">
                    <th className="py-2 pr-3">Component</th>
                    <th className="py-2 pr-3">Code</th>
                    <th className="py-2 pr-3">Type</th>
                    <th className="py-2 pr-3">Calculation</th>
                    <th className="py-2 pr-3">Taxability</th>
                    <th className="py-2 pr-3">PF</th>
                    <th className="py-2 pr-3">ESI</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Effective</th>
                    <th className="py-2 pr-3">Usage</th>
                    <th className="py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {components.map((component) => (
                    <tr key={component._id} className="border-b border-crewly-border/60">
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          className="font-medium text-crewly-text hover:underline"
                          onClick={() => openDetail(component)}
                        >
                          {component.name}
                        </button>
                        {component.isSystemDefault && (
                          <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-crewly-dim">
                            Default
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">{component.code}</td>
                      <td className="py-2 pr-3">
                        {CATEGORIES.find((option) => option.value === component.category)?.label ||
                          component.category}
                      </td>
                      <td className="py-2 pr-3">{component.calculationLabel || '—'}</td>
                      <td className="py-2 pr-3">
                        {TAXABILITIES.find((option) => option.value === component.taxability)?.label ||
                          component.taxability}
                      </td>
                      <td className="py-2 pr-3">{component.pfApplicable ? 'Yes' : 'No'}</td>
                      <td className="py-2 pr-3">{component.esiApplicable ? 'Yes' : 'No'}</td>
                      <td className="py-2 pr-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] ${
                            component.status === 'ACTIVE'
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : 'bg-slate-700/40 text-slate-300'
                          }`}
                        >
                          {component.status === 'ACTIVE' ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="py-2 pr-3">{formatDate(component.effectiveFrom)}</td>
                      <td className="py-2 pr-3">{component.usage?.structures ?? 0} structures</td>
                      <td className="py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {canManage && (
                            <button
                              type="button"
                              className="text-xs text-indigo-300 hover:underline"
                              onClick={() => openEdit(component)}
                            >
                              Edit
                            </button>
                          )}
                          {canManage && (
                            <button
                              type="button"
                              className="text-xs text-indigo-300 hover:underline"
                              onClick={() => duplicate(component)}
                            >
                              Duplicate
                            </button>
                          )}
                          {canActivate && (
                            <button
                              type="button"
                              className="text-xs text-amber-300 hover:underline"
                              onClick={() =>
                                component.status === 'ACTIVE'
                                  ? setConfirm({ component, status: 'INACTIVE' })
                                  : changeStatus(component, 'ACTIVE')
                              }
                            >
                              {component.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
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
                  Page {meta.page} of {meta.pages} · {meta.total} component(s)
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

      {canManage && defaults && defaults.length > 0 && components.length === 0 && (
        <div className="card space-y-2">
          <h2 className="text-lg font-semibold">Suggested for your company</h2>
          <p className="text-sm text-crewly-dim">
            Based on your Payroll Setup statutory configuration (PF / ESI / Professional Tax / TDS).
          </p>
          <ul className="flex flex-wrap gap-2 text-xs">
            {defaults.map((item) => (
              <li key={item.code} className="rounded bg-slate-800 px-2 py-1">
                {item.name} ({item.code})
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* §28 — create / edit form with dynamic fields (§29) and preview (§30) */}
      {formOpen && (
        <Modal title={editingId ? 'Edit Salary Component' : 'Create Salary Component'} onClose={() => setFormOpen(false)} wide>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Basic Information</h3>
              <label className="label block">
                Component Name
                <input
                  className="input mt-1 w-full"
                  value={form.name}
                  onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="House Rent Allowance"
                />
              </label>
              <label className="label block">
                Component Code
                <input
                  className="input mt-1 w-full font-mono"
                  value={form.code}
                  onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value.toUpperCase() }))}
                  placeholder="HRA"
                />
              </label>
              <label className="label block">
                Description
                <textarea
                  className="input mt-1 w-full"
                  rows={2}
                  value={form.description}
                  onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                />
              </label>

              <h3 className="pt-2 text-sm font-semibold">Component Type</h3>
              <select
                className="input w-full"
                value={form.category}
                onChange={(event) => setForm((prev) => ({ ...prev, category: event.target.value }))}
              >
                {CATEGORIES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Calculation</h3>
              <select
                className="input w-full"
                value={form.calculationType}
                onChange={(event) => setForm((prev) => ({ ...prev, calculationType: event.target.value }))}
              >
                {CALCULATION_TYPES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>

              {showAmount && (
                <label className="label block">
                  Default Amount
                  <input
                    className="input mt-1 w-full"
                    type="number"
                    min="0"
                    value={form.defaultAmount}
                    onChange={(event) => setForm((prev) => ({ ...prev, defaultAmount: event.target.value }))}
                    placeholder="2000"
                  />
                  <span className="mt-1 block text-xs text-crewly-dim">
                    Reference only — employees and structures can override it.
                  </span>
                </label>
              )}

              {showPercentage && (
                <label className="label block">
                  Percentage
                  <input
                    className="input mt-1 w-full"
                    type="number"
                    min="0.01"
                    max="1000"
                    step="0.01"
                    value={form.percentage}
                    onChange={(event) => setForm((prev) => ({ ...prev, percentage: event.target.value }))}
                    placeholder="40"
                  />
                </label>
              )}

              {showBase && (
                <label className="label block">
                  Calculated From
                  <select
                    className="input mt-1 w-full"
                    value={form.calculationBase}
                    onChange={(event) => setForm((prev) => ({ ...prev, calculationBase: event.target.value }))}
                  >
                    <option value="">Select a base</option>
                    {CALCULATION_BASES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {showDependency && (
                <label className="label block">
                  Depends On
                  <select
                    className="input mt-1 w-full"
                    value={form.dependsOnCode}
                    onChange={(event) => setForm((prev) => ({ ...prev, dependsOnCode: event.target.value }))}
                  >
                    <option value="">Select a component</option>
                    {components
                      .filter((component) => component.code !== form.code)
                      .map((component) => (
                        <option key={component._id} value={component.code}>
                          {component.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}

              <h3 className="pt-2 text-sm font-semibold">Tax &amp; Statutory</h3>
              <select
                className="input w-full"
                value={form.taxability}
                onChange={(event) => setForm((prev) => ({ ...prev, taxability: event.target.value }))}
              >
                {TAXABILITIES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>

              <div className="grid grid-cols-2 gap-2">
                {[
                  ['pfApplicable', 'PF applicable'],
                  ['esiApplicable', 'ESI applicable'],
                  ['tdsApplicable', 'TDS applicable'],
                  ['professionalTaxApplicable', 'Professional Tax'],
                ].map(([field, label]) => (
                  <label key={field} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(form[field])}
                      onChange={(event) => setForm((prev) => ({ ...prev, [field]: event.target.checked }))}
                    />
                    {label}
                  </label>
                ))}
              </div>

              <label className="label block pt-2">
                Effective From
                <input
                  className="input mt-1 w-full"
                  type="date"
                  value={form.effectiveFrom}
                  onChange={(event) => setForm((prev) => ({ ...prev, effectiveFrom: event.target.value }))}
                />
              </label>
            </div>
          </div>

          {/* §30 */}
          <div className="mt-4 rounded-lg border border-crewly-border p-4">
            <h3 className="text-sm font-semibold">Preview</h3>
            <dl className="mt-2 grid gap-1 text-sm md:grid-cols-2">
              <div className="flex justify-between gap-3">
                <dt className="text-crewly-dim">Component</dt>
                <dd>{form.name || '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-crewly-dim">Type</dt>
                <dd>{CATEGORIES.find((option) => option.value === form.category)?.label}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-crewly-dim">Calculation</dt>
                <dd>{preview}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-crewly-dim">Status</dt>
                <dd>{form.status === 'ACTIVE' ? 'Active' : 'Inactive'}</dd>
              </div>
            </dl>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setFormOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={submit} disabled={busy}>
              {busy ? 'Saving…' : 'Save Component'}
            </button>
          </div>
        </Modal>
      )}

      {/* §33 — deactivation is never a delete */}
      {confirm && (
        <Modal title="Deactivate salary component?" onClose={() => setConfirm(null)}>
          <p className="text-sm text-crewly-dim">
            Deactivating <span className="font-semibold text-crewly-text">{confirm.component.name}</span> means:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-crewly-dim">
            <li>It will not be available for new salary structures.</li>
            <li>Historical payroll remains unchanged.</li>
            <li>Existing employee payroll history remains available.</li>
          </ul>
          <p className="mt-3 text-sm text-crewly-dim">
            This component is currently used in {confirm.component.usage?.structures ?? 0} salary
            structure(s). It will not be deleted.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => changeStatus(confirm.component, confirm.status)}
            >
              Deactivate
            </button>
          </div>
        </Modal>
      )}

      {/* §48 — detail / usage */}
      {detail && (
        <Modal title={detail.name} onClose={() => setDetail(null)}>
          <dl className="grid gap-2 text-sm md:grid-cols-2">
            <div>
              <dt className="text-crewly-dim">Code</dt>
              <dd className="font-mono">{detail.code}</dd>
            </div>
            <div>
              <dt className="text-crewly-dim">Type</dt>
              <dd>{CATEGORIES.find((option) => option.value === detail.category)?.label || detail.category}</dd>
            </div>
            <div>
              <dt className="text-crewly-dim">Calculation</dt>
              <dd>{detail.calculationLabel || '—'}</dd>
            </div>
            <div>
              <dt className="text-crewly-dim">Taxability</dt>
              <dd>
                {TAXABILITIES.find((option) => option.value === detail.taxability)?.label || detail.taxability}
              </dd>
            </div>
            <div>
              <dt className="text-crewly-dim">PF / ESI / TDS</dt>
              <dd>
                {detail.pfApplicable ? 'PF Yes' : 'PF No'} · {detail.esiApplicable ? 'ESI Yes' : 'ESI No'} ·{' '}
                {detail.tdsApplicable ? 'TDS Yes' : 'TDS No'}
              </dd>
            </div>
            <div>
              <dt className="text-crewly-dim">Status</dt>
              <dd>{detail.status === 'ACTIVE' ? 'Active' : 'Inactive'}</dd>
            </div>
            <div>
              <dt className="text-crewly-dim">Effective From</dt>
              <dd>{formatDate(detail.effectiveFrom)}</dd>
            </div>
            <div>
              <dt className="text-crewly-dim">Version</dt>
              <dd>{detail.version || 1}</dd>
            </div>
          </dl>

          <div className="mt-4 rounded-lg border border-crewly-border p-3">
            <h3 className="text-sm font-semibold">Usage</h3>
            <p className="mt-1 text-sm text-crewly-dim">
              {detail.usage?.structures ?? 0} salary structure(s) · {detail.usage?.payrollRuns ?? 0} payroll
              run(s)
              {detail.usage?.hasHistoricalVersions ? ' · has historical versions' : ''}
            </p>
            <p className="mt-1 text-xs text-crewly-dim">
              Salary structures arrive with the next phase, so usage is zero until then.
            </p>
          </div>

          {detail.description && (
            <p className="mt-4 text-sm text-crewly-dim">{detail.description}</p>
          )}
        </Modal>
      )}
    </div>
  );
};

export default SalaryComponentsPage;
