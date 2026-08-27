/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, FilePlus2, Pencil, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import usePermission from '../../hooks/usePermission.js';
import offerService from '../../services/offerService.js';

const TemplateForm = ({ template, variables = [], onClose, onSaved }) => {
  const [form, setForm] = useState({ name: template?.name || '', description: template?.description || '', content: template?.content || '', isDefault: template?.isDefault || false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const variableList = Array.isArray(variables) ? variables : [];
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const templateId = template?._id || template?.id;
      const saved = templateId
        ? await offerService.updateTemplate(templateId, form)
        : await offerService.createTemplate(form);
      onSaved(saved);
    } catch (requestError) {
      setError(requestError.message || 'Template could not be saved');
    } finally {
      setBusy(false);
    }
  };
  const insertVariable = (variable) => setForm((current) => ({ ...current, content: `${current.content}${current.content ? ' ' : ''}{{${variable}}}` }));

  return <form onSubmit={submit} className="space-y-4"><div><h2 className="text-lg font-semibold text-slate-100">{template ? 'Edit offer template' : 'Create offer template'}</h2><p className="mt-1 text-xs text-slate-500">Plain text only. Unsupported or unresolved variables cannot be approved.</p></div>{error ? <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null}<label className="block"><span className="label">Name</span><input className="input" required minLength="2" maxLength="120" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label><label className="block"><span className="label">Description</span><input className="input" maxLength="500" value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label><div><p className="label">Supported variables</p><div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/40 p-3">{variableList.map((variable) => <button key={variable} type="button" className="rounded-md border border-indigo-500/25 bg-indigo-500/10 px-2 py-1 font-mono text-[11px] text-indigo-200" onClick={() => insertVariable(variable)}>{`{{${variable}}}`}</button>)}</div></div><label className="block"><span className="label">Template content</span><textarea className="input min-h-[320px] font-mono text-sm leading-6" required minLength="20" maxLength="8000" value={form.content} onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))} /></label><label className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4"><input type="checkbox" checked={form.isDefault} onChange={(event) => setForm((current) => ({ ...current, isDefault: event.target.checked }))} /><span><span className="block text-sm font-medium text-slate-200">Default template</span><span className="block text-xs text-slate-500">New offer drafts will select this template first.</span></span></label><div className="flex justify-end gap-3"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save template'}</button></div></form>;
};

const OfferTemplatesPage = () => {
  const { hasPermission } = usePermission();
  const [templates, setTemplates] = useState([]);
  const [variables, setVariables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await offerService.templates({ includeInactive: true });
      setTemplates(Array.isArray(result?.templates) ? result.templates : []);
      setVariables(Array.isArray(result?.supportedVariables) ? result.supportedVariables : []);
    } catch (requestError) {
      setError(requestError.message || 'Templates could not be loaded');
      setTemplates([]);
      setVariables([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const deactivate = async (template) => {
    if (!window.confirm(`Deactivate ${template.name}? Existing offer snapshots will be preserved.`)) return;
    try {
      await offerService.deactivateTemplate(template._id || template.id);
      load();
    } catch (requestError) {
      setError(requestError.message || 'Template could not be deactivated');
    }
  };

  const activate = async (template) => {
    try {
      await offerService.updateTemplate(template._id || template.id, { isActive: true });
      load();
    } catch (requestError) {
      setError(requestError.message || 'Template could not be activated');
    }
  };

  return <div className="space-y-5"><Link to="/app/recruitment/offers" className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-100"><ArrowLeft className="h-4 w-4" />Back to offers</Link><header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><h1 className="text-2xl font-bold text-slate-100">Offer templates</h1><p className="mt-1 text-sm text-slate-400">Reusable tenant-owned, plain-text offer language with deterministic variables.</p></div>{hasPermission('OFFER_TEMPLATE_CREATE') ? <button type="button" className="btn-primary gap-2" onClick={() => setEditing(null)}><FilePlus2 className="h-4 w-4" />New template</button> : null}</header>{error ? <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null}{loading ? <div className="h-64 animate-pulse rounded-2xl bg-slate-900" /> : <div className="grid gap-4 lg:grid-cols-2">{templates.map((template) => {
    const templateId = template._id || template.id;
    const variableCount = Array.isArray(template.variables) ? template.variables.length : 0;
    return <article key={templateId} className={`rounded-2xl border p-5 ${template.isActive ? 'border-slate-800 bg-slate-900' : 'border-slate-800 bg-slate-950 opacity-60'}`}><div className="flex items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold text-slate-100">{template.name}</h2>{template.isDefault ? <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-200">Default</span> : null}{!template.isActive ? <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">Inactive</span> : null}</div><p className="mt-1 text-xs text-slate-500">Version {template.version ?? 1} · {variableCount} variables</p></div>{hasPermission('OFFER_TEMPLATE_UPDATE') ? <div className="flex gap-1"><button type="button" className="btn-ghost p-2" aria-label={`Edit ${template.name}`} onClick={() => setEditing(template)}><Pencil className="h-4 w-4" /></button>{template.isActive ? <button type="button" className="btn-ghost p-2 text-rose-300" aria-label={`Deactivate ${template.name}`} onClick={() => deactivate(template)}><Trash2 className="h-4 w-4" /></button> : <button type="button" className="btn-ghost p-2 text-emerald-300" aria-label={`Activate ${template.name}`} onClick={() => activate(template)}><RotateCcw className="h-4 w-4" /></button>}</div> : null}</div><p className="mt-3 text-sm text-slate-400">{template.description || 'No description'}</p><pre className="mt-4 line-clamp-6 whitespace-pre-wrap rounded-xl border border-slate-800 bg-slate-950/50 p-4 font-sans text-xs leading-5 text-slate-400">{template.content || 'No content'}</pre><div className="mt-3 flex items-center gap-2 text-xs text-slate-500"><ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />Plain-text safe rendering</div></article>;
  })}</div>}{editing !== undefined ? <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/85 p-4 backdrop-blur-sm" role="dialog" aria-modal="true"><div className="mx-auto my-6 max-w-4xl rounded-2xl border border-slate-700 bg-slate-900 p-6"><TemplateForm template={editing} variables={variables} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); load(); }} /></div></div> : null}</div>;
};

export default OfferTemplatesPage;
