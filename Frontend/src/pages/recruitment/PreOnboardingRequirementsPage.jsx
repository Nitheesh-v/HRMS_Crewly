/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Plus, RefreshCw, ToggleLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import usePermission from '../../hooks/usePermission.js';
import preOnboardingService from '../../services/preOnboardingService.js';

const CATEGORIES = [
  'IDENTITY',
  'ADDRESS',
  'EDUCATION',
  'EMPLOYMENT',
  'FINANCE',
  'TAX',
  'PHOTO',
  'OTHER',
];

const emptyForm = {
  name: '',
  code: '',
  category: 'OTHER',
  required: true,
  instructions: '',
  requiresDocumentNumber: false,
  requiresExpiryDate: false,
  displayOrder: 100,
};

const PreOnboardingRequirementsPage = () => {
  const { hasPermission } = usePermission();
  const canManage = hasPermission('PRE_ONBOARDING_SETTINGS_MANAGE');
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await preOnboardingService.listRequirements();
      setRows(result);
    } catch (requestError) {
      setError(requestError.message || 'Requirements could not be loaded');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (event) => {
    event.preventDefault();
    if (!canManage) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await preOnboardingService.createRequirement(form);
      setForm(emptyForm);
      setMessage('Requirement created');
      await load();
    } catch (requestError) {
      setError(requestError.message || 'Requirement could not be created');
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async (requirementId) => {
    if (!canManage) return;
    setBusy(true);
    setError('');
    try {
      await preOnboardingService.deactivateRequirement(requirementId);
      await load();
    } catch (requestError) {
      setError(requestError.message || 'Requirement could not be deactivated');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <Link
            to="/app/recruitment/pre-onboarding"
            className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200"
          >
            <ArrowLeft className="h-4 w-4" />
            Pre-onboarding
          </Link>
          <h1 className="mt-3 text-2xl font-bold text-slate-100">
            Document requirements
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Tenant catalog used when a candidate starts pre-onboarding. Existing cases keep
            their snapshot.
          </p>
        </div>
        <button type="button" className="btn-ghost gap-2" onClick={load}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3 text-sm text-emerald-200">
          {message}
        </p>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        {canManage ? (
          <form
            onSubmit={create}
            className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5"
          >
            <h2 className="font-semibold">Add requirement</h2>
            <label className="block">
              <span className="label">Name</span>
              <input
                className="input"
                required
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
              />
            </label>
            <label className="block">
              <span className="label">Code (optional)</span>
              <input
                className="input"
                value={form.code}
                onChange={(event) =>
                  setForm((current) => ({ ...current, code: event.target.value }))
                }
              />
            </label>
            <label className="block">
              <span className="label">Category</span>
              <select
                className="input"
                value={form.category}
                onChange={(event) =>
                  setForm((current) => ({ ...current, category: event.target.value }))
                }
              >
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Instructions</span>
              <textarea
                className="input min-h-24"
                value={form.instructions}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    instructions: event.target.value,
                  }))
                }
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={form.required}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    required: event.target.checked,
                  }))
                }
              />
              Required for ready-to-join
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={form.requiresDocumentNumber}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    requiresDocumentNumber: event.target.checked,
                  }))
                }
              />
              Collect document number
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={form.requiresExpiryDate}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    requiresExpiryDate: event.target.checked,
                  }))
                }
              />
              Collect expiry date
            </label>
            <button type="submit" className="btn-primary w-full gap-2" disabled={busy}>
              <Plus className="h-4 w-4" />
              Create requirement
            </button>
          </form>
        ) : (
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
            You can view requirements but cannot change the catalog.
          </div>
        )}

        <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-slate-800 bg-slate-950/60 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Required</th>
                  <th className="px-4 py-3">Active</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan="5" className="px-4 py-10 text-center text-slate-500">
                      Loading requirements...
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan="5" className="px-4 py-10 text-center text-slate-500">
                      No requirements configured.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.id} className="border-t border-slate-800/80">
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-100">{row.name}</p>
                        <p className="text-xs text-slate-500">{row.code}</p>
                      </td>
                      <td className="px-4 py-3 text-slate-300">{row.category}</td>
                      <td className="px-4 py-3 text-slate-300">
                        {row.required ? 'Yes' : 'Optional'}
                      </td>
                      <td className="px-4 py-3 text-slate-300">
                        {row.active ? 'Active' : 'Inactive'}
                      </td>
                      <td className="px-4 py-3">
                        {canManage && row.active ? (
                          <button
                            type="button"
                            className="btn-ghost gap-2"
                            disabled={busy}
                            onClick={() => deactivate(row.id)}
                          >
                            <ToggleLeft className="h-4 w-4" />
                            Deactivate
                          </button>
                        ) : (
                          <span className="text-xs text-slate-500">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
};

export default PreOnboardingRequirementsPage;
