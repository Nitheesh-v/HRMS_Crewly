/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, ChartNoAxesCombined, Save, UsersRound } from 'lucide-react';
import helpdeskService from '../../services/helpdeskService.js';
import helpdeskWorkspaceService from '../../services/helpdeskWorkspaceService.js';
import usePermission from '../../hooks/usePermission.js';
import { HelpdeskError, HelpdeskLoading } from '../../components/helpdesk/HelpdeskUi.jsx';
import { helpdeskData, helpdeskDateTime, helpdeskErrorStatus, safeHelpdeskError } from './helpdeskFormat.js';

const initialConfig = {
  enabled: false,
  allowEmployeeTickets: true,
  attachmentsEnabled: false,
  confidentialTicketsEnabled: false,
  defaultPriority: 'normal',
  allowEmployeeReopen: true,
  reopenWindowHours: 72,
  autoCloseEnabled: false,
  autoCloseDelayHours: 72,
};

const ToggleField = ({ checked, onChange, title, detail }) => (
  <label className="flex min-h-16 items-start gap-3 rounded-xl border border-crewly-border bg-crewly-bg/40 p-3">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-4 w-4 accent-crewly-green focus-visible:ring-2 focus-visible:ring-crewly-green" />
    <span><span className="block text-xs font-semibold text-crewly-text">{title}</span><span className="mt-1 block text-[11px] leading-5 text-crewly-dim">{detail}</span></span>
  </label>
);

const HelpdeskAdminPage = () => {
  const { hasPermission } = usePermission();
  const [config, setConfig] = useState(initialConfig);
  const [baseline, setBaseline] = useState(initialConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmingSave, setConfirmingSave] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await helpdeskService.getConfig();
      const data = { ...initialConfig, ...(helpdeskData(response) || {}) };
      setConfig(data);
      setBaseline(data);
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        setConfig(initialConfig);
        setBaseline(initialConfig);
        setConfirmingSave(false);
      }
      setError(safeHelpdeskError(requestError, 'Helpdesk settings could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const update = (field, value) => setConfig((current) => ({ ...current, [field]: value }));
  const dirty = JSON.stringify(config) !== JSON.stringify(baseline);
  const settingLabels = {
    enabled: 'Helpdesk availability',
    allowEmployeeTickets: 'Employee ticket submission',
    attachmentsEnabled: 'Secure attachments',
    confidentialTicketsEnabled: 'Confidential ticket access',
    defaultPriority: 'Default priority',
    allowEmployeeReopen: 'Employee reopening',
    reopenWindowHours: 'Reopen window',
    autoCloseEnabled: 'Automatic closure',
    autoCloseDelayHours: 'Auto-close delay',
  };
  const changedSettings = Object.entries(settingLabels)
    .filter(([field]) => String(config[field]) !== String(baseline[field]))
    .map(([, label]) => label);

  const reviewSave = (event) => {
    event.preventDefault();
    setConfirmingSave(true);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await helpdeskWorkspaceService.updateConfig({
        enabled: Boolean(config.enabled),
        allowEmployeeTickets: Boolean(config.allowEmployeeTickets),
        attachmentsEnabled: Boolean(config.attachmentsEnabled),
        confidentialTicketsEnabled: Boolean(config.confidentialTicketsEnabled),
        defaultPriority: config.defaultPriority,
        allowEmployeeReopen: Boolean(config.allowEmployeeReopen),
        reopenWindowHours: Number(config.reopenWindowHours),
        autoCloseEnabled: Boolean(config.autoCloseEnabled),
        autoCloseDelayHours: Number(config.autoCloseDelayHours),
      });
      const data = { ...initialConfig, ...(helpdeskData(response) || {}) };
      setConfig(data);
      setBaseline(data);
      setConfirmingSave(false);
      setNotice('Helpdesk settings saved.');
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        setConfig(initialConfig);
        setBaseline(initialConfig);
        setConfirmingSave(false);
      }
      setError(safeHelpdeskError(requestError, 'Helpdesk settings were not saved.'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <HelpdeskLoading label="Loading Helpdesk settings…" />;
  if (error && !config.updatedAt) return <HelpdeskError message={error} onRetry={loadConfig} />;

  return (
    <section className="space-y-4" aria-labelledby="helpdesk-admin-title">
      <div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-crewly-green">Tenant administration</p><h2 id="helpdesk-admin-title" className="mt-1 text-xl font-semibold">Helpdesk settings</h2><p className="mt-1 text-sm text-crewly-dim">Changes are submitted to the tenant-scoped Helpdesk configuration API.</p></div>
      {error ? <p className="rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-sm text-rose-100" role="alert">{error}</p> : null}
      {notice ? <p className="rounded-lg border border-emerald-300/20 bg-emerald-300/5 px-3 py-2 text-sm text-emerald-100" role="status">{notice}</p> : null}
      <form onSubmit={reviewSave} className="space-y-4 rounded-2xl border border-crewly-border bg-crewly-card p-4 sm:p-6">
        {confirmingSave ? <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-4" role="alertdialog" aria-labelledby="helpdesk-settings-confirm-title"><h3 id="helpdesk-settings-confirm-title" className="text-sm font-semibold text-amber-50">Review Helpdesk setting changes</h3><p className="mt-1 text-xs leading-5 text-amber-50/80">Confirm the tenant-wide impact before saving. Confidential access, attachments, reopen rules, and automatic closure remain enforced by the server.</p><ul className="mt-2 list-inside list-disc space-y-1 text-xs text-amber-50">{changedSettings.map((label) => <li key={label}>{label}</li>)}</ul>{config.confidentialTicketsEnabled !== baseline.confidentialTicketsEnabled ? <p className="mt-2 text-xs font-semibold text-amber-50">Confidential ticket access is changing. Verify queue membership and reviewer rules before confirming.</p> : null}<div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => setConfirmingSave(false)} disabled={saving} className="min-h-9 rounded-lg border border-amber-100/20 px-3 text-xs font-semibold text-amber-50">Go back</button><button type="button" onClick={save} disabled={saving || !dirty} className="min-h-9 rounded-lg bg-amber-200 px-3 text-xs font-semibold text-slate-950 disabled:opacity-50">{saving ? 'Saving…' : 'Confirm and save settings'}</button></div></div> : null}
        <div className="grid gap-3 md:grid-cols-2">
          <ToggleField checked={config.enabled} onChange={(value) => update('enabled', value)} title="Enable Helpdesk" detail="Makes the tenant Helpdesk available to authorized employees and staff." />
          <ToggleField checked={config.allowEmployeeTickets} onChange={(value) => update('allowEmployeeTickets', value)} title="Allow employee ticket submission" detail="Allows employee-facing ticket creation and available queue discovery." />
          <ToggleField checked={config.attachmentsEnabled} onChange={(value) => update('attachmentsEnabled', value)} title="Allow secure attachments" detail="Enables the existing private Helpdesk attachment workflow. File access remains server-authorized." />
          <ToggleField checked={config.confidentialTicketsEnabled} onChange={(value) => update('confidentialTicketsEnabled', value)} title="Allow confidential tickets" detail="Confidential ticket access is still limited by explicit queue membership and the backend authorization fence." />
          <ToggleField checked={config.allowEmployeeReopen} onChange={(value) => update('allowEmployeeReopen', value)} title="Allow employee reopening" detail="The backend also checks the resolution timestamp and reopening window for every request." />
          <ToggleField checked={config.autoCloseEnabled} onChange={(value) => update('autoCloseEnabled', value)} title="Enable automatic closure" detail="Resolved tickets may be closed by the existing lifecycle process after the configured delay." />
        </div>
        <div className="grid gap-4 border-t border-crewly-border pt-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block text-xs font-medium text-crewly-dim">Default priority<select value={config.defaultPriority} onChange={(event) => update('defaultPriority', event.target.value)} className="mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
          <label className="block text-xs font-medium text-crewly-dim">Employee reopen window (hours)<input type="number" min="1" max="720" step="1" value={config.reopenWindowHours} onChange={(event) => update('reopenWindowHours', event.target.value)} className="mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20" /></label>
          <label className="block text-xs font-medium text-crewly-dim">Auto-close delay (hours)<input type="number" min="1" max="720" step="1" value={config.autoCloseDelayHours} onChange={(event) => update('autoCloseDelayHours', event.target.value)} disabled={!config.autoCloseEnabled} className="mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20 disabled:opacity-50" /></label>
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-crewly-border pt-4 sm:flex-row sm:items-center sm:justify-between"><span className="text-[11px] text-crewly-dim">Last updated {helpdeskDateTime(config.updatedAt)}</span><div className="flex justify-end gap-2"><button type="button" onClick={() => { setConfig(baseline); setError(''); setConfirmingSave(false); }} disabled={!dirty || saving} className="min-h-10 rounded-lg border border-crewly-border px-4 text-xs font-semibold hover:bg-crewly-bg disabled:opacity-40">Discard</button><button type="submit" disabled={!dirty || saving} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-crewly-green px-4 text-xs font-semibold text-slate-950 disabled:opacity-50"><Save className="h-4 w-4" aria-hidden="true" />{saving ? 'Saving…' : 'Review and save'}</button></div></div>
      </form>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Helpdesk administration pages">
        <Link to="/app/helpdesk/queues" className="flex min-h-24 items-center gap-3 rounded-xl border border-crewly-border bg-crewly-card p-4 hover:border-crewly-green/40"><UsersRound className="h-5 w-5 text-crewly-green" aria-hidden="true" /><span><strong className="block text-sm">Queues and SLA</strong><span className="mt-1 block text-xs text-crewly-dim">Manage queue access, categories, and service targets.</span></span></Link>
        {hasPermission('HELPDESK_KB_MANAGE') ? <Link to="/app/helpdesk/admin/knowledge-base" className="flex min-h-24 items-center gap-3 rounded-xl border border-crewly-border bg-crewly-card p-4 hover:border-crewly-green/40"><BookOpen className="h-5 w-5 text-crewly-green" aria-hidden="true" /><span><strong className="block text-sm">Knowledge Base management</strong><span className="mt-1 block text-xs text-crewly-dim">Manage categories, drafts, publication, and revisions.</span></span></Link> : null}
        {hasPermission('HELPDESK_TICKET_READ') ? <Link to="/app/helpdesk/analytics" className="flex min-h-24 items-center gap-3 rounded-xl border border-crewly-border bg-crewly-card p-4 hover:border-crewly-green/40"><ChartNoAxesCombined className="h-5 w-5 text-crewly-green" aria-hidden="true" /><span><strong className="block text-sm">Analytics</strong><span className="mt-1 block text-xs text-crewly-dim">Review authorized aggregates and service-level trends.</span></span></Link> : null}
      </div>
      <p className="text-[11px] leading-5 text-crewly-dim">Helpdesk notification preference controls are not exposed by the current Helpdesk API; this page does not change the separate Crewly notification preferences.</p>
    </section>
  );
};

export default HelpdeskAdminPage;
