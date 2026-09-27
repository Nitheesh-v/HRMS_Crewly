/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Plus, RefreshCw } from 'lucide-react';
import usePermission from '../../hooks/usePermission.js';
import bgvService from '../../services/bgvService.js';
import { notify } from '../../utils/notify.js';

const BackgroundVerificationSettingsPage = () => {
  const { hasPermission } = usePermission();
  const canRead = hasPermission('BACKGROUND_VERIFICATION_SETTINGS_READ');
  const canManage = hasPermission('BACKGROUND_VERIFICATION_SETTINGS_MANAGE');
  const [settings, setSettings] = useState(null);
  const [types, setTypes] = useState([]);
  const [form, setForm] = useState({
    name: '',
    code: '',
    category: 'OTHER',
    required: true,
    instructions: '',
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);

    try {
      const [settingsData, typeRows] = await Promise.all([
        bgvService.getSettings(),
        bgvService.listCheckTypes(),
      ]);
      setSettings(settingsData);
      setTypes(typeRows || []);
    } catch (requestError) {
      notify.error(requestError, 'Settings could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    load();
  }, [load]);

  const saveSettings = async (event) => {
    event.preventDefault();
    if (!canManage || !settings) return;
    setBusy(true);


    try {
      const updated = await bgvService.updateSettings({
        enabled: settings.enabled,
        triggerStage: settings.triggerStage,
        consentRequired: settings.consentRequired,
        bgvRequiredBeforeConversion: settings.bgvRequiredBeforeConversion,
        bgvRequiredBeforeJoining: settings.bgvRequiredBeforeJoining,
      });
      setSettings(updated);
      notify.success('Settings saved');
    } catch (requestError) {
      notify.error(requestError, 'Settings could not be saved');
    } finally {
      setBusy(false);
    }
  };

  const createType = async (event) => {
    event.preventDefault();
    if (!canManage) return;
    setBusy(true);

    try {
      await bgvService.createCheckType(form);
      setForm({
        name: '',
        code: '',
        category: 'OTHER',
        required: true,
        instructions: '',
      });
      await load();
    } catch (requestError) {
      notify.error(requestError, 'Check type could not be created');
    } finally {
      setBusy(false);
    }
  };

  if (!canRead) {
    return (
      <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-6 text-amber-100">
        BGV settings permission required.
      </div>
    );
  }

  if (loading) return <div className="h-64 animate-pulse rounded-2xl bg-slate-900" />;

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/app/recruitment/background-verification"
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-100"
        >
          <ArrowLeft className="h-4 w-4" />
          Background verification
        </Link>
        <h1 className="mt-3 text-2xl font-bold text-slate-100">BGV settings</h1>
      </div>




      <div className="grid gap-6 xl:grid-cols-2">
        <form onSubmit={saveSettings} className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Policy</h2>
            <button type="button" className="btn-ghost gap-2" onClick={load}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
          {[
            ['enabled', 'BGV enabled'],
            ['consentRequired', 'Consent required'],
            ['bgvRequiredBeforeConversion', 'Required before employee conversion'],
            ['bgvRequiredBeforeJoining', 'Required before joining (policy flag)'],
          ].map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                disabled={!canManage}
                checked={Boolean(settings?.[key])}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    [key]: event.target.checked,
                  }))
                }
              />
              {label}
            </label>
          ))}
          <label className="block">
            <span className="label">Trigger stage</span>
            <select
              className="input"
              disabled={!canManage}
              value={settings?.triggerStage || 'PRE_JOINING'}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  triggerStage: event.target.value,
                }))
              }
            >
              {['PRE_OFFER', 'POST_OFFER', 'PRE_JOINING'].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          {canManage ? (
            <button type="submit" className="btn-primary" disabled={busy}>
              Save settings
            </button>
          ) : null}
        </form>

        <div className="space-y-4">
          {canManage ? (
            <form onSubmit={createType} className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="font-semibold">Add check type</h2>
              <input
                className="input"
                placeholder="Name"
                required
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              />
              <input
                className="input"
                placeholder="Code (optional)"
                value={form.code}
                onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))}
              />
              <select
                className="input"
                value={form.category}
                onChange={(event) =>
                  setForm((current) => ({ ...current, category: event.target.value }))
                }
              >
                {['IDENTITY', 'ADDRESS', 'EDUCATION', 'EMPLOYMENT', 'REFERENCE', 'CRIMINAL', 'OTHER'].map(
                  (value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  )
                )}
              </select>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={form.required}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, required: event.target.checked }))
                  }
                />
                Required
              </label>
              <button type="submit" className="btn-primary w-full gap-2" disabled={busy}>
                <Plus className="h-4 w-4" />
                Create check type
              </button>
            </form>
          ) : null}

          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="font-semibold">Configured checks</h2>
            <div className="mt-3 space-y-2">
              {types.map((row) => (
                <div
                  key={row.id}
                  className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-slate-100">{row.name}</p>
                    <span className="text-[11px] uppercase text-slate-500">
                      {row.required ? 'Required' : 'Optional'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {row.code} · {row.category} · {row.active ? 'Active' : 'Inactive'}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default BackgroundVerificationSettingsPage;
