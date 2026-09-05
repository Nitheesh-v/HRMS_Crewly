import { useCallback, useEffect, useState } from 'react';
import { IndianRupee, Pencil, RefreshCw, ShieldCheck } from 'lucide-react';
import Modal from '../../components/Modal.jsx';
import superAdminService from '../../services/superAdminService.js';

// Phase 30.2 — BGV SERVICE CATALOGUE & PRICING (Super Admin portal).
// Backend is the only price authority: this page only displays and submits
// what the platform API allows; no price ever lives in React state alone.
const SuperAdminBgvCataloguePage = () => {
  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState(null);
  const [price, setPrice] = useState('');
  const [description, setDescription] = useState('');
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await superAdminService.bgvCatalogue();
      setView(data);
    } catch (requestError) {
      setError(requestError?.message || 'BGV catalogue could not be loaded');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openEditor = (service) => {
    setEditing(service);
    setPrice(
      service.configured && service.priceMinorUnits != null
        ? (service.priceMinorUnits / 100).toFixed(2)
        : ''
    );
    setDescription(service.description || '');
    setActive(service.configured ? service.active : true);
    setFormError('');
    setSaving(false);
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setFormError('');
    try {
      const result = await superAdminService.updateBgvCatalogue(editing.type, {
        price,
        description,
        active,
      });
      setMessage(
        `${result?.name || editing.name}: ${
          result?.priceDisplay || ''
        } saved (${result?.active ? 'active' : 'inactive'})`
      );
      setEditing(null);
      await load();
    } catch (requestError) {
      setFormError(requestError?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const statusBadge = (service) => {
    if (!service.configured) {
      return (
        <span className="rounded-full bg-slate-700/40 px-3 py-1 text-xs text-slate-300">
          Not configured
        </span>
      );
    }
    return service.active ? (
      <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs text-emerald-300">
        Active
      </span>
    ) : (
      <span className="rounded-full bg-amber-500/15 px-3 py-1 text-xs text-amber-300">
        Inactive
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-orange-500/10 p-2 text-orange-300">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-slate-100">BGV Service Catalogue</h1>
            <p className="text-sm text-slate-400">
              Crewly's five background verification products. Platform-managed pricing;
              changes apply to future purchases only.
            </p>
          </div>
        </div>
        <button type="button" className="btn-ghost gap-2" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          Refresh
        </button>
      </header>

      {message ? (
        <p className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
          {error}
        </p>
      ) : null}

      {loading && !view ? (
        <p className="text-sm text-slate-400">Loading catalogue…</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-700/40 bg-slate-800/20">
          <table className="w-full min-w-[850px] text-sm">
            <thead>
              <tr className="border-b border-slate-700/40 text-left text-slate-400">
                <th className="px-4 py-3 font-medium">Service</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Price</th>
                <th className="px-4 py-3 font-medium">Currency</th>
                <th className="px-4 py-3 font-medium">Last updated</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(view?.services || []).map((service) => (
                <tr key={service.type} className="border-b border-slate-700/20">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-100">{service.name}</p>
                    <p className="mt-1 max-w-md text-xs text-slate-500">{service.description}</p>
                  </td>
                  <td className="px-4 py-3">{statusBadge(service)}</td>
                  <td className="px-4 py-3 text-slate-200">
                    {service.configured ? (
                      <span className="inline-flex items-center gap-1">
                        <IndianRupee className="h-3.5 w-3.5" aria-hidden="true" />
                        {(service.priceMinorUnits / 100).toLocaleString('en-IN', {
                          minimumFractionDigits: 2,
                        })}
                      </span>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-300">{service.currency}</td>
                  <td className="px-4 py-3 text-slate-400">
                    {service.updatedAt
                      ? new Date(service.updatedAt).toLocaleString()
                      : 'Never configured'}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      className="btn-ghost gap-2"
                      onClick={() => openEditor(service)}
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                      {service.configured ? 'Edit' : 'Configure'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing ? (
        <Modal title={`${editing.configured ? 'Edit' : 'Configure'} — ${editing.name}`} onClose={() => !saving && setEditing(null)}>
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm text-slate-400">
              Price (₹, up to two decimals)
              <input
                className="rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-sm text-slate-200"
                inputMode="decimal"
                placeholder="e.g. 500 or 500.00"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-slate-400">
              Description (optional, max 2000 chars)
              <textarea
                className="min-h-[90px] rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-sm text-slate-200"
                maxLength={2000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={active}
                onChange={(event) => setActive(event.target.checked)}
              />
              Active (available for new purchases)
            </label>
            {formError ? <p className="text-sm text-rose-300">{formError}</p> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" disabled={saving} onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" disabled={saving} onClick={save}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
};

export default SuperAdminBgvCataloguePage;
