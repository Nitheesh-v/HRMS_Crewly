/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Save,
  ShieldAlert,
  Trash2,
  UsersRound,
} from 'lucide-react';
import helpdeskService from '../../services/helpdeskService.js';
import helpdeskWorkspaceService from '../../services/helpdeskWorkspaceService.js';
import { HelpdeskEmpty, HelpdeskError, HelpdeskLoading } from '../../components/helpdesk/HelpdeskUi.jsx';
import EmployeeMultiSelect from '../../components/helpdesk/EmployeeMultiSelect.jsx';
import { helpdeskData, helpdeskErrorStatus, safeHelpdeskError } from './helpdeskFormat.js';
import {
  emptyHelpdeskMemberGroups,
  helpdeskMemberGroupsFromQueue,
  helpdeskMemberGroupsFromResolution,
  helpdeskMembershipResolutionMatchesQueue,
  helpdeskEmployeeLabel,
  summarizeHelpdeskMembershipChanges,
} from './helpdeskMembership.js';

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const fieldClass = 'mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 py-2 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20';
const labelClass = 'block text-xs font-medium text-crewly-dim';
const emptyQueueForm = () => ({
  name: '',
  description: '',
  enabled: true,
  categories: [{ id: '', name: '', description: '', enabled: true }],
  ...emptyHelpdeskMemberGroups(),
  confidentialityEnabled: false,
  version: null,
});

const queueToForm = (queue) => ({
  name: queue?.name || '',
  description: queue?.description || '',
  enabled: queue?.enabled !== false,
  categories: (queue?.categories || []).map((category) => ({
    id: String(category.id || ''),
    name: category.name || '',
    description: category.description || '',
    enabled: category.enabled !== false,
  })).concat((queue?.categories || []).length ? [] : [{ id: '', name: '', description: '', enabled: true }]),
  ...helpdeskMemberGroupsFromQueue(queue),
  confidentialityEnabled: queue?.confidentiality?.enabled === true,
  version: Number.isSafeInteger(queue?.version) && queue.version >= 0 ? queue.version : null,
});

const MEMBER_GROUP_KEYS = ['agents', 'managers', 'confidentialAgents', 'confidentialReviewers'];
const memberIds = (members) => members.map((member) => String(member?.id || '').trim()).filter(Boolean);

const templatePolicy = () => ({
  enabled: false,
  clockMode: 'BUSINESS_HOURS',
  timeZone: 'Asia/Kolkata',
  excludeHolidays: false,
  weeklyHours: DAYS.map((weekday) => ({ weekday, windows: ['MON', 'TUE', 'WED', 'THU', 'FRI'].includes(weekday) ? [{ start: '09:00', end: '17:00' }] : [] })),
  targets: {
    low: { firstResponseMinutes: 480, resolutionMinutes: 2880 },
    normal: { firstResponseMinutes: 240, resolutionMinutes: 1440 },
    high: { firstResponseMinutes: 60, resolutionMinutes: 480 },
    urgent: { firstResponseMinutes: 15, resolutionMinutes: 120 },
  },
  warningPercent: 80,
  pauseStatuses: { firstResponse: [], resolution: ['waiting_for_employee'] },
});

const PolicyEditor = ({ policy, setPolicy, configured, loading, saving, error, notice, onReload, onSubmit }) => {
  const [confirming, setConfirming] = useState(false);
  const updateDay = (weekday, enabled, field, value) => setPolicy((current) => ({
    ...current,
    weeklyHours: current.weeklyHours.map((day) => day.weekday !== weekday ? day : {
      ...day,
      windows: enabled ? [{ ...(day.windows?.[0] || { start: '09:00', end: '17:00' }), [field]: value }] : [],
    }),
  }));
  const toggleDay = (weekday, enabled) => setPolicy((current) => ({
    ...current,
    weeklyHours: current.weeklyHours.map((day) => day.weekday !== weekday ? day : {
      ...day,
      windows: enabled ? (day.windows?.length ? day.windows : [{ start: '09:00', end: '17:00' }]) : [],
    }),
  }));
  const updateTarget = (priority, field, value) => setPolicy((current) => ({
    ...current,
    targets: { ...current.targets, [priority]: { ...current.targets[priority], [field]: Number(value) } },
  }));
  const updatePauseStatus = (clock, status, checked) => setPolicy((current) => {
    const currentStatuses = current.pauseStatuses[clock] || [];
    const nextStatuses = checked
      ? [...new Set([...currentStatuses, status])]
      : currentStatuses.filter((value) => value !== status);
    return { ...current, pauseStatuses: { ...current.pauseStatuses, [clock]: nextStatuses } };
  });
  const totalWeeklyMinutes = policy.weeklyHours.reduce((total, day) => total + (day.windows || []).reduce((sum, window) => {
    const start = Number(String(window.start || '0:0').split(':')[0]) * 60 + Number(String(window.start || '0:0').split(':')[1]);
    const end = Number(String(window.end || '0:0').split(':')[0]) * 60 + Number(String(window.end || '0:0').split(':')[1]);
    return sum + Math.max(0, end - start);
  }, 0), 0);

  const submit = (event) => {
    event.preventDefault();
    setConfirming(true);
  };
  const confirm = async () => {
    await onSubmit();
    setConfirming(false);
  };

  return (
    <section className="rounded-2xl border border-crewly-border bg-crewly-card p-4 sm:p-5" aria-labelledby="sla-policy-title">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-crewly-green">Service levels</p><h3 id="sla-policy-title" className="mt-1 text-base font-semibold">Queue SLA policy</h3><p className="mt-1 text-[11px] leading-5 text-crewly-dim">Targets, business hours, pause statuses, and calendar rules are enforced by the backend.</p></div><button type="button" onClick={onReload} disabled={loading || saving} className="min-h-9 rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-bg disabled:opacity-50">Reload</button></div>
      {loading ? <HelpdeskLoading label="Loading queue policy…" /> : null}
      {!loading ? <>
        {!configured ? <div className="mt-3 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-xs leading-5 text-amber-100">No SLA policy is configured for this queue. The form below starts with an editable, disabled template; saving is required to create a policy.</div> : null}
        {error ? <p className="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-xs text-rose-100" role="alert">{error}</p> : null}
        {notice ? <p className="mt-3 rounded-lg border border-emerald-300/20 bg-emerald-300/5 px-3 py-2 text-xs text-emerald-100" role="status">{notice}</p> : null}
        {confirming ? <div className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/10 p-3" role="alertdialog" aria-labelledby="confirm-sla-heading"><h4 id="confirm-sla-heading" className="text-xs font-semibold text-amber-50">Confirm this SLA policy update</h4><p className="mt-1 text-[11px] leading-5 text-amber-50/80">This changes the queue’s service targets and schedule. Review the timezone and all four priority targets before saving.</p><div className="mt-2 flex gap-2"><button type="button" onClick={() => setConfirming(false)} className="min-h-8 rounded-lg border border-amber-100/20 px-3 text-[11px] font-semibold text-amber-50">Go back</button><button type="button" onClick={confirm} disabled={saving} className="min-h-8 rounded-lg bg-amber-200 px-3 text-[11px] font-semibold text-slate-950 disabled:opacity-50">{saving ? 'Saving…' : 'Confirm policy update'}</button></div></div> : null}
        <form onSubmit={submit} className="mt-4 space-y-4">
          <label className="flex items-start gap-2.5 rounded-lg border border-crewly-border bg-crewly-bg/40 p-3 text-xs"><input type="checkbox" checked={policy.enabled} onChange={(event) => setPolicy((current) => ({ ...current, enabled: event.target.checked }))} className="mt-0.5 h-4 w-4 accent-crewly-green" /><span><strong className="font-semibold">Enable SLA clock</strong><span className="mt-0.5 block text-[11px] text-crewly-dim">New ticket SLA snapshots use this policy when enabled.</span></span></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={labelClass}>Clock mode<select value={policy.clockMode} onChange={(event) => setPolicy((current) => ({ ...current, clockMode: event.target.value, excludeHolidays: event.target.value === 'CALENDAR' ? false : current.excludeHolidays }))} className={fieldClass}><option value="BUSINESS_HOURS">Business hours</option><option value="CALENDAR">Calendar time</option></select></label>
            <label className={labelClass}>IANA timezone<input value={policy.timeZone} onChange={(event) => setPolicy((current) => ({ ...current, timeZone: event.target.value.trim() }))} className={fieldClass} placeholder="Asia/Kolkata" maxLength={80} /></label>
            <label className={labelClass}>Warning threshold (%)<input type="number" min="1" max="99" step="1" value={policy.warningPercent} onChange={(event) => setPolicy((current) => ({ ...current, warningPercent: Number(event.target.value) }))} className={fieldClass} /></label>
            {policy.clockMode === 'BUSINESS_HOURS' ? <label className="flex min-h-10 items-center gap-2 rounded-lg border border-crewly-border px-3 text-xs text-crewly-text"><input type="checkbox" checked={policy.excludeHolidays} onChange={(event) => setPolicy((current) => ({ ...current, excludeHolidays: event.target.checked }))} className="h-4 w-4 accent-crewly-green" />Exclude company holidays</label> : null}
          </div>
          <div className="overflow-x-auto rounded-lg border border-crewly-border"><table className="w-full min-w-[430px] text-left text-xs"><caption className="sr-only">Weekly working hours for SLA calculations</caption><thead className="bg-crewly-bg/80 text-[10px] uppercase tracking-wide text-crewly-dim"><tr><th scope="col" className="px-3 py-2">Day</th><th scope="col" className="px-3 py-2">Working day</th><th scope="col" className="px-3 py-2">Start</th><th scope="col" className="px-3 py-2">End</th></tr></thead><tbody className="divide-y divide-crewly-border">{DAYS.map((dayKey) => { const day = policy.weeklyHours.find((item) => item.weekday === dayKey) || { windows: [] }; const active = Boolean(day.windows?.length); const window = day.windows?.[0] || { start: '09:00', end: '17:00' }; return <tr key={dayKey}><th scope="row" className="px-3 py-2 font-semibold">{dayKey}</th><td className="px-3 py-2"><input type="checkbox" aria-label={`${dayKey} is a working day`} checked={active} onChange={(event) => toggleDay(dayKey, event.target.checked)} className="h-4 w-4 accent-crewly-green" /></td><td className="px-3 py-2"><input type="time" value={window.start} disabled={!active} onChange={(event) => updateDay(dayKey, true, 'start', event.target.value)} className="min-h-8 rounded border border-crewly-border bg-crewly-bg px-2 text-xs text-crewly-text disabled:opacity-50" /></td><td className="px-3 py-2"><input type="time" value={window.end} disabled={!active} onChange={(event) => updateDay(dayKey, true, 'end', event.target.value)} className="min-h-8 rounded border border-crewly-border bg-crewly-bg px-2 text-xs text-crewly-text disabled:opacity-50" /></td></tr>; })}</tbody></table></div>
          {policy.clockMode === 'BUSINESS_HOURS' && totalWeeklyMinutes < 60 ? <p className="text-xs text-amber-100" role="alert">Business-hours schedules must include at least 60 minutes per week.</p> : null}
          <div className="overflow-x-auto rounded-lg border border-crewly-border"><table className="w-full min-w-[540px] text-left text-xs"><caption className="sr-only">SLA targets by ticket priority</caption><thead className="bg-crewly-bg/80 text-[10px] uppercase tracking-wide text-crewly-dim"><tr><th scope="col" className="px-3 py-2">Priority</th><th scope="col" className="px-3 py-2">First response (min)</th><th scope="col" className="px-3 py-2">Resolution (min)</th></tr></thead><tbody className="divide-y divide-crewly-border">{PRIORITIES.map((priority) => <tr key={priority}><th scope="row" className="px-3 py-2 font-semibold capitalize">{priority}</th><td className="px-3 py-2"><input type="number" min="1" max="10080" step="1" value={policy.targets[priority].firstResponseMinutes} onChange={(event) => updateTarget(priority, 'firstResponseMinutes', event.target.value)} className="min-h-9 w-full rounded border border-crewly-border bg-crewly-bg px-2 text-xs text-crewly-text" /></td><td className="px-3 py-2"><input type="number" min="1" max="10080" step="1" value={policy.targets[priority].resolutionMinutes} onChange={(event) => updateTarget(priority, 'resolutionMinutes', event.target.value)} className="min-h-9 w-full rounded border border-crewly-border bg-crewly-bg px-2 text-xs text-crewly-text" /></td></tr>)}</tbody></table></div>
          <fieldset className="rounded-lg border border-crewly-border p-3"><legend className="px-1 text-xs font-semibold text-crewly-text">Pause clocks in waiting states</legend><div className="grid gap-3 sm:grid-cols-2">{[['firstResponse', 'First response'], ['resolution', 'Resolution']].map(([key, label]) => <div key={key}><p className="mb-1 text-[11px] text-crewly-dim">{label}</p>{['waiting_for_employee', 'waiting_for_department'].map((status) => <label key={status} className="flex items-center gap-2 py-1 text-[11px] text-crewly-text"><input type="checkbox" checked={(policy.pauseStatuses[key] || []).includes(status)} onChange={(event) => updatePauseStatus(key, status, event.target.checked)} className="h-3.5 w-3.5 accent-crewly-green" />{status.replaceAll('_', ' ')}</label>)}</div>)}</div></fieldset>
          <button type="submit" disabled={saving || (policy.clockMode === 'BUSINESS_HOURS' && totalWeeklyMinutes < 60)} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-crewly-green px-4 text-xs font-semibold text-slate-950 disabled:opacity-50"><Save className="h-4 w-4" aria-hidden="true" />Review and save SLA policy</button>
        </form>
      </> : null}
    </section>
  );
};

const HelpdeskQueueAdminPage = () => {
  const [queues, setQueues] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState(emptyQueueForm);
  const [loading, setLoading] = useState(true);
  const [savingQueue, setSavingQueue] = useState(false);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmingQueue, setConfirmingQueue] = useState(false);
  const [membershipBaseline, setMembershipBaseline] = useState(emptyHelpdeskMemberGroups);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipError, setMembershipError] = useState('');
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [policy, setPolicy] = useState(templatePolicy);
  const [policyConfigured, setPolicyConfigured] = useState(false);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const [policyError, setPolicyError] = useState('');
  const [policyNotice, setPolicyNotice] = useState('');
  const queueRequestRef = useRef(0);
  const membershipRequestRef = useRef(0);
  const policyRequestRef = useRef(0);

  const selectedQueue = useMemo(() => queues.find((queue) => String(queue.id) === String(selectedId)) || null, [queues, selectedId]);
  const searchCandidates = useCallback(
    (params) => helpdeskWorkspaceService.searchMembershipCandidates(params),
    [],
  );
  const clearRestrictedState = useCallback(() => {
    queueRequestRef.current += 1;
    membershipRequestRef.current += 1;
    policyRequestRef.current += 1;
    setQueues([]);
    setSelectedId('');
    setForm(emptyQueueForm());
    setLoading(false);
    setSavingQueue(false);
    setError('');
    setFormError('');
    setNotice('');
    setConfirmingQueue(false);
    setMembershipBaseline(emptyHelpdeskMemberGroups());
    setMembershipLoading(false);
    setMembershipError('');
    setRefreshRequired(false);
    setPolicy(templatePolicy());
    setPolicyConfigured(false);
    setPolicyLoading(false);
    setPolicySaving(false);
    setPolicyError('');
    setPolicyNotice('');
  }, []);

  const handleMembershipAccessError = useCallback((requestError) => {
    if (![401, 403, 404].includes(helpdeskErrorStatus(requestError))) return;
    clearRestrictedState();
    setError(safeHelpdeskError(requestError, 'Employee search access changed.'));
  }, [clearRestrictedState]);

  const loadQueues = useCallback(async () => {
    const requestId = queueRequestRef.current + 1;
    queueRequestRef.current = requestId;
    setLoading(true);
    setError('');
    try {
      const response = await helpdeskService.listAdminQueues();
      if (queueRequestRef.current !== requestId) return;
      const rows = Array.isArray(helpdeskData(response)) ? helpdeskData(response) : [];
      setQueues(rows);
      setSelectedId((current) => rows.some((queue) => String(queue.id) === String(current)) ? current : String(rows[0]?.id || ''));
      return true;
    } catch (requestError) {
      if (queueRequestRef.current !== requestId) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) clearRestrictedState();
      setError(safeHelpdeskError(requestError, 'Queues could not be loaded.'));
      return false;
    } finally {
      if (queueRequestRef.current === requestId) setLoading(false);
    }
  }, [clearRestrictedState]);

  const loadQueueMembership = useCallback(async (queue) => {
    const requestId = membershipRequestRef.current + 1;
    membershipRequestRef.current = requestId;
    setMembershipLoading(true);
    setMembershipError('');
    try {
      const response = await helpdeskWorkspaceService.getQueueMembership(queue.id);
      if (membershipRequestRef.current !== requestId) return;
      const data = helpdeskData(response) || {};
      if (!Number.isSafeInteger(queue.version) || !Number.isSafeInteger(data.version) || data.version !== queue.version) {
        setRefreshRequired(true);
        setFormError('This queue changed while its members were loading. Reload the latest queue before continuing.');
        throw new Error('Queue membership belongs to a different queue version.');
      }
      if (!helpdeskMembershipResolutionMatchesQueue(queue, data)) {
        throw new Error('Queue membership lookup returned an incomplete result.');
      }
      const groups = helpdeskMemberGroupsFromResolution(data);
      setMembershipBaseline(groups);
      setForm((current) => ({
        ...current,
        ...groups,
        version: data.version,
      }));
    } catch (requestError) {
      if (membershipRequestRef.current !== requestId) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        clearRestrictedState();
        setError(safeHelpdeskError(requestError, 'Queue membership could not be loaded.'));
        return;
      }
      setMembershipError(safeHelpdeskError(requestError, 'Queue membership could not be resolved. Existing assignments are being preserved as unavailable.'));
    } finally {
      if (membershipRequestRef.current === requestId) setMembershipLoading(false);
    }
  }, [clearRestrictedState]);

  useEffect(() => {
    loadQueues();
  }, [loadQueues]);

  useEffect(() => {
    const nextForm = selectedQueue ? queueToForm(selectedQueue) : emptyQueueForm();
    const fallbackGroups = Object.fromEntries(MEMBER_GROUP_KEYS.map((key) => [key, nextForm[key]]));
    membershipRequestRef.current += 1;
    setForm(nextForm);
    setMembershipBaseline(fallbackGroups);
    setMembershipLoading(false);
    setMembershipError('');
    setRefreshRequired(false);
    setFormError('');
    setNotice('');
    setConfirmingQueue(false);
    if (selectedQueue) loadQueueMembership(selectedQueue);
  }, [loadQueueMembership, selectedQueue]);

  const loadPolicy = useCallback(async () => {
    const requestId = policyRequestRef.current + 1;
    policyRequestRef.current = requestId;
    if (!selectedId) {
      setPolicy(templatePolicy());
      setPolicyConfigured(false);
      setPolicyLoading(false);
      return;
    }
    setPolicyLoading(true);
    setPolicyError('');
    setPolicyNotice('');
    try {
      const response = await helpdeskWorkspaceService.getQueueSlaPolicy(selectedId);
      if (policyRequestRef.current !== requestId) return;
      const data = helpdeskData(response) || {};
      setPolicyConfigured(data.configured === true && Boolean(data.policy));
      setPolicy({ ...templatePolicy(), ...(data.policy || {}) });
    } catch (requestError) {
      if (policyRequestRef.current !== requestId) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        clearRestrictedState();
        setError(safeHelpdeskError(requestError, 'This queue SLA policy could not be loaded.'));
      }
      setPolicyError(safeHelpdeskError(requestError, 'This queue SLA policy could not be loaded.'));
    } finally {
      if (policyRequestRef.current === requestId) setPolicyLoading(false);
    }
  }, [clearRestrictedState, selectedId]);

  useEffect(() => {
    loadPolicy();
  }, [loadPolicy]);

  const updateForm = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const updateMembers = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const canSelectConfidentialAgent = useCallback(
    (candidate) => form.agents.some((agent) => String(agent.id).toLowerCase() === String(candidate.id).toLowerCase()),
    [form.agents],
  );
  const updateCategory = (index, field, value) => setForm((current) => ({
    ...current,
    categories: current.categories.map((category, categoryIndex) => categoryIndex === index ? { ...category, [field]: value } : category),
  }));
  const addCategory = () => setForm((current) => ({ ...current, categories: [...current.categories, { id: '', name: '', description: '', enabled: true }] }));
  const removeCategory = (index) => setForm((current) => ({ ...current, categories: current.categories.filter((_category, categoryIndex) => categoryIndex !== index) }));

  const membershipChanges = summarizeHelpdeskMembershipChanges({
    before: membershipBaseline,
    after: form,
  });
  const membershipRemovalCount = membershipChanges.reduce((total, change) => total + change.removed.length, 0);
  const hasUnresolvedMembership = MEMBER_GROUP_KEYS.some((key) => form[key].some((member) => member.eligible !== true));

  const buildQueuePayload = () => {
    const categories = form.categories.filter((category) => category.name.trim()).map((category) => ({
      ...(category.id ? { id: category.id } : {}),
      name: category.name.trim(),
      description: category.description.trim(),
      enabled: Boolean(category.enabled),
    }));
    const invalidCategory = categories.find((category) => category.name.length < 2 || category.name.length > 80 || category.description.length > 240);
    if (invalidCategory) throw new Error('Category names must be 2–80 characters and descriptions must be 240 characters or fewer.');

    const membershipIds = Object.fromEntries(MEMBER_GROUP_KEYS.map((key) => [key, memberIds(form[key])]));
    const allMembershipIds = Object.values(membershipIds).flat();
    if (allMembershipIds.some((id) => !/^[a-f\\d]{24}$/i.test(id))) {
      throw new Error('An employee selection could not be verified. Reload the queue and choose eligible employees again.');
    }
    for (const [key, label] of Object.entries({
      agents: 'Queue agents',
      managers: 'Queue managers',
      confidentialAgents: 'Confidential agents',
      confidentialReviewers: 'Confidential reviewers',
    })) {
      if (new Set(membershipIds[key].map((id) => id.toLowerCase())).size !== membershipIds[key].length) {
        throw new Error(`${label} must not contain duplicate employees.`);
      }
    }
    if (membershipIds.confidentialAgents.some((id) => !membershipIds.agents.some((agentId) => agentId.toLowerCase() === id.toLowerCase()))) {
      throw new Error('Confidential agents must also be selected as queue agents. This does not grant confidential access automatically.');
    }
    if (selectedId && !Number.isSafeInteger(form.version)) {
      throw new Error('The queue version could not be confirmed. Reload the queue before saving.');
    }

    return {
      name: form.name.trim(),
      description: form.description.trim(),
      enabled: Boolean(form.enabled),
      categories,
      agents: membershipIds.agents,
      managers: membershipIds.managers,
      confidentiality: {
        enabled: Boolean(form.confidentialityEnabled),
        agentIds: membershipIds.confidentialAgents,
        reviewerIds: membershipIds.confidentialReviewers,
      },
      ...(selectedId ? { expectedVersion: form.version } : {}),
    };
  };

  const reviewQueue = (event) => {
    event.preventDefault();
    setFormError('');
    setNotice('');
    try {
      if (membershipLoading) throw new Error('Wait for current queue membership to finish loading.');
      if (refreshRequired) throw new Error('Reload the latest queue before saving this draft.');
      if (form.name.trim().length < 2 || form.name.trim().length > 80) throw new Error('Queue name must be 2–80 characters.');
      if (form.description.length > 500) throw new Error('Queue description must be 500 characters or fewer.');
      const ineligibleMembers = MEMBER_GROUP_KEYS.flatMap((key) => form[key].filter((member) => member.eligible !== true));
      if (ineligibleMembers.length) {
        throw new Error('Remove unavailable, inactive, or setup-pending members before saving. Existing assignments have been preserved until you remove them.');
      }
      buildQueuePayload();
      setConfirmingQueue(true);
    } catch (validationError) {
      setFormError(validationError.message);
    }
  };

  const saveQueue = async () => {
    setSavingQueue(true);
    setFormError('');
    setNotice('');
    try {
      const payload = buildQueuePayload();
      const response = selectedId
        ? await helpdeskWorkspaceService.updateQueue(selectedId, payload)
        : await helpdeskWorkspaceService.createQueue(payload);
      const savedQueue = helpdeskData(response);
      setSelectedId(String(savedQueue?.id || selectedId));
      setConfirmingQueue(false);
      const refreshed = await loadQueues();
      setNotice(refreshed
        ? (selectedId ? 'Queue membership and configuration saved.' : 'Queue created.')
        : 'Queue saved, but the latest server state could not be reloaded. Use Refresh before editing again.');
    } catch (requestError) {
      const status = helpdeskErrorStatus(requestError);
      if ([401, 403, 404].includes(status)) {
        clearRestrictedState();
        setError(safeHelpdeskError(requestError, 'Queue access changed.'));
      }
      if (status === 409) {
        setRefreshRequired(true);
        setConfirmingQueue(false);
        setFormError('This queue changed or conflicted with another update. Your draft was not saved. Reload the latest queue and review the changes before trying again.');
      } else {
        setFormError(status ? safeHelpdeskError(requestError, 'Queue changes were not saved.') : String(requestError?.message || 'Queue changes were not saved.'));
      }
    } finally {
      setSavingQueue(false);
    }
  };

  const reloadLatestQueue = async () => {
    setRefreshRequired(false);
    setConfirmingQueue(false);
    setFormError('');
    setMembershipError('');
    setNotice('The draft was discarded. Loading the latest queue configuration.');
    await loadQueues();
  };

  const persistPolicy = async () => {
    if (!selectedId) return;
    const requestId = policyRequestRef.current;
    setPolicySaving(true);
    setPolicyError('');
    setPolicyNotice('');
    try {
      const payload = {
        enabled: Boolean(policy.enabled),
        clockMode: policy.clockMode,
        timeZone: policy.timeZone.trim(),
        excludeHolidays: Boolean(policy.excludeHolidays),
        weeklyHours: policy.weeklyHours.map((day) => ({
          weekday: day.weekday,
          windows: (day.windows || []).map((window) => ({ start: window.start, end: window.end })),
        })),
        targets: Object.fromEntries(PRIORITIES.map((priority) => [priority, {
          firstResponseMinutes: Number(policy.targets[priority].firstResponseMinutes),
          resolutionMinutes: Number(policy.targets[priority].resolutionMinutes),
        }])),
        warningPercent: Number(policy.warningPercent),
        pauseStatuses: {
          firstResponse: [...(policy.pauseStatuses.firstResponse || [])],
          resolution: [...(policy.pauseStatuses.resolution || [])],
        },
      };
      const response = await helpdeskWorkspaceService.updateQueueSlaPolicy(selectedId, payload);
      if (policyRequestRef.current !== requestId) return;
      const data = helpdeskData(response) || {};
      setPolicy({ ...templatePolicy(), ...(data.policy || {}) });
      setPolicyConfigured(data.configured === true);
      setPolicyNotice('Queue SLA policy saved.');
    } catch (requestError) {
      if (policyRequestRef.current !== requestId) return;
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        clearRestrictedState();
        setError(safeHelpdeskError(requestError, 'Queue access changed.'));
      }
      setPolicyError(safeHelpdeskError(requestError, 'The SLA policy was not saved.'));
    } finally {
      if (policyRequestRef.current === requestId) setPolicySaving(false);
    }
  };

  if (loading) return <HelpdeskLoading label="Loading queue administration…" />;
  if (error && !queues.length) return <HelpdeskError message={error} onRetry={loadQueues} />;

  return (
    <section className="space-y-4" aria-labelledby="queue-admin-title">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-crewly-green">Queue administration</p><h2 id="queue-admin-title" className="mt-1 text-xl font-semibold">Queues and service targets</h2><p className="mt-1 text-sm text-crewly-dim">Search active company employees by name, employee code, or work email. Queue membership is checked again by the server.</p></div><button type="button" onClick={() => { setSelectedId(''); setForm(emptyQueueForm()); setMembershipBaseline(emptyHelpdeskMemberGroups()); setMembershipError(''); setMembershipLoading(false); setRefreshRequired(false); setNotice(''); setFormError(''); }} disabled={refreshRequired} className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-card disabled:opacity-50"><Plus className="h-4 w-4" aria-hidden="true" />New queue</button></div>
      {error ? <p className="rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-sm text-rose-100" role="alert">{error}</p> : null}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(18rem,0.72fr)_minmax(0,1.28fr)]">
        <div className="space-y-4">
          <section className="rounded-2xl border border-crewly-border bg-crewly-card p-4" aria-labelledby="queue-list-heading"><div className="flex items-center justify-between gap-2"><h3 id="queue-list-heading" className="text-sm font-semibold">Tenant queues</h3><button type="button" onClick={loadQueues} disabled={loading || refreshRequired} className="text-xs font-semibold text-crewly-green hover:underline disabled:opacity-50">Refresh</button></div>{queues.length ? <ul className="mt-3 space-y-2">{queues.map((queue) => <li key={queue.id}><button type="button" onClick={() => setSelectedId(queue.id)} disabled={refreshRequired} aria-pressed={String(selectedId) === String(queue.id)} className={`w-full rounded-lg border p-3 text-left ${String(selectedId) === String(queue.id) ? 'border-crewly-green/40 bg-crewly-green/5' : 'border-crewly-border hover:bg-crewly-bg'}`}><span className="flex items-center justify-between gap-2"><span className="truncate text-xs font-semibold text-crewly-text">{queue.name}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${queue.enabled ? 'bg-emerald-300/10 text-emerald-200' : 'bg-slate-400/10 text-slate-300'}`}>{queue.enabled ? 'Enabled' : 'Disabled'}</span></span><span className="mt-1 block text-[10px] text-crewly-dim">{(queue.categories || []).filter((category) => category.enabled !== false).length} active categories · {(queue.agents || []).length} agents</span></button></li>)}</ul> : <div className="mt-3"><HelpdeskEmpty icon={UsersRound} title="No queues yet" detail="Create a queue to define support ownership and categories." /></div>}</section>

          <section className="rounded-2xl border border-crewly-border bg-crewly-card p-4 sm:p-5" aria-labelledby="queue-editor-title">
            <div className="flex items-center gap-2"><UsersRound className="h-4 w-4 text-crewly-green" aria-hidden="true" /><h3 id="queue-editor-title" className="text-sm font-semibold">{selectedId ? `Edit ${selectedQueue?.name || 'queue'}` : 'Create queue'}</h3></div>
            {notice ? <p className="mt-3 rounded-lg border border-emerald-300/20 bg-emerald-300/5 px-3 py-2 text-xs text-emerald-100" role="status">{notice}</p> : null}
            {formError ? <div className="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-xs text-rose-100" role="alert"><p>{formError}</p>{refreshRequired ? <button type="button" onClick={reloadLatestQueue} className="mt-2 min-h-8 rounded-lg border border-rose-200/30 px-3 font-semibold">Discard draft and reload latest queue</button> : null}</div> : null}
            {selectedQueue && membershipLoading ? <p className="mt-3 rounded-lg border border-crewly-border bg-crewly-bg/50 px-3 py-2 text-xs text-crewly-dim" role="status">Resolving existing queue members securely…</p> : null}
            {membershipError ? <div className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/5 px-3 py-2 text-xs text-amber-100" role="alert"><p>{membershipError} Current assignments remain as unavailable items until you explicitly remove them.</p><button type="button" onClick={reloadLatestQueue} className="mt-2 min-h-8 rounded-lg border border-amber-100/30 px-3 font-semibold">Discard draft and retry membership lookup</button></div> : null}
            {confirmingQueue ? <div className="mt-3 space-y-3 rounded-lg border border-amber-300/25 bg-amber-300/10 p-3" role="alertdialog" aria-labelledby="confirm-queue-title"><h4 id="confirm-queue-title" className="text-xs font-semibold text-amber-50">Review proposed queue membership</h4><p className="text-[11px] leading-5 text-amber-50/80">Check each added and removed employee before saving. Confidential assignments are separate restricted permissions.</p>{membershipChanges.length ? <div className="space-y-2">{membershipChanges.map((change) => <section key={change.key} className={`rounded-lg border p-2 ${change.confidential ? 'border-amber-200/30 bg-amber-100/5' : 'border-crewly-border bg-crewly-bg/50'}`}><h5 className="text-[11px] font-semibold text-crewly-text">{change.label}{change.confidential ? ' · Restricted access' : ''}</h5>{change.added.length ? <p className="mt-1 text-[10px] text-emerald-100">Added: {change.added.map(helpdeskEmployeeLabel).join(', ')}</p> : null}{change.removed.length ? <p className="mt-1 text-[10px] text-rose-100">Removed: {change.removed.map(helpdeskEmployeeLabel).join(', ')}</p> : null}</section>)}</div> : <p className="rounded-lg border border-crewly-border bg-crewly-bg/50 p-2 text-[10px] text-crewly-dim">No employee membership changes.</p>}{(selectedQueue?.confidentiality?.enabled === true) !== form.confidentialityEnabled ? <p className="rounded-lg border border-amber-200/30 bg-amber-100/5 p-2 text-[10px] font-semibold text-amber-100">{selectedQueue ? `Confidential ticket access will change from ${selectedQueue.confidentiality?.enabled ? 'enabled' : 'disabled'} to ${form.confidentialityEnabled ? 'enabled' : 'disabled'}.` : `This new queue will have confidential ticket access ${form.confidentialityEnabled ? 'enabled' : 'disabled'}.`}</p> : null}{membershipRemovalCount ? <p className="rounded-lg border border-rose-200/30 bg-rose-100/5 p-2 text-[10px] font-semibold text-rose-100">Confirmation required: {membershipRemovalCount} queue membership removal(s) will take effect.</p> : null}<p className="text-[10px] text-crewly-dim">{form.categories.filter((category) => category.name.trim()).length} ticket categories · Confidential tickets {form.confidentialityEnabled ? 'enabled' : 'disabled'}</p><div className="flex gap-2"><button type="button" onClick={() => setConfirmingQueue(false)} className="min-h-8 rounded-lg border border-amber-100/20 px-3 text-[11px] font-semibold text-amber-50">Review form</button><button type="button" onClick={saveQueue} disabled={savingQueue || membershipLoading || (Boolean(membershipError) && hasUnresolvedMembership) || refreshRequired} className="min-h-8 rounded-lg bg-amber-200 px-3 text-[11px] font-semibold text-slate-950 disabled:opacity-50">{savingQueue ? 'Saving…' : membershipRemovalCount ? 'Confirm removals and save' : 'Confirm and save'}</button></div></div> : null}
            <form onSubmit={reviewQueue} className="mt-4 space-y-3">
              <label className={labelClass}>Queue name<input value={form.name} onChange={(event) => updateForm('name', event.target.value.slice(0, 80))} maxLength={80} required className={fieldClass} /></label>
              <label className={labelClass}>Description<textarea value={form.description} onChange={(event) => updateForm('description', event.target.value.slice(0, 500))} maxLength={500} rows={2} className={`${fieldClass} resize-y`} /></label>
              <label className="flex items-center gap-2 text-xs text-crewly-text"><input type="checkbox" checked={form.enabled} onChange={(event) => updateForm('enabled', event.target.checked)} className="h-4 w-4 accent-crewly-green" />Queue enabled</label>
              <fieldset className="space-y-2 rounded-xl border border-crewly-border p-3"><legend className="px-1 text-xs font-semibold text-crewly-text">Ticket categories</legend><p className="text-[10px] leading-4 text-crewly-dim">Existing categories are preserved; disable one to stop offering it to employees.</p>{form.categories.map((category, index) => <div key={category.id || `new-${index}`} className="grid gap-2 rounded-lg border border-crewly-border/70 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center"><label className="sr-only" htmlFor={`queue-category-name-${index}`}>Category name</label><input id={`queue-category-name-${index}`} value={category.name} onChange={(event) => updateCategory(index, 'name', event.target.value.slice(0, 80))} maxLength={80} className="min-h-9 rounded-lg border border-crewly-border bg-crewly-bg px-2.5 text-xs text-crewly-text" placeholder="Category name" /><label className="sr-only" htmlFor={`queue-category-description-${index}`}>Category description</label><input id={`queue-category-description-${index}`} value={category.description} onChange={(event) => updateCategory(index, 'description', event.target.value.slice(0, 240))} maxLength={240} className="min-h-9 rounded-lg border border-crewly-border bg-crewly-bg px-2.5 text-xs text-crewly-text" placeholder="Description (optional)" />{category.id ? <label className="inline-flex items-center gap-1.5 text-[10px] text-crewly-dim"><input type="checkbox" checked={category.enabled} onChange={(event) => updateCategory(index, 'enabled', event.target.checked)} className="h-3.5 w-3.5 accent-crewly-green" />Enabled</label> : <button type="button" onClick={() => removeCategory(index)} aria-label="Remove new category" className="min-h-8 rounded-lg border border-crewly-border px-2 text-xs text-crewly-dim hover:text-rose-200"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>}</div>)}<button type="button" onClick={addCategory} className="inline-flex min-h-8 items-center gap-1.5 text-xs font-semibold text-crewly-green hover:underline"><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add category</button></fieldset>
              <div className="grid gap-4 lg:grid-cols-2">
                <EmployeeMultiSelect
                  label="Queue agents"
                  value={form.agents}
                  onChange={(value) => updateMembers('agents', value)}
                  searchCandidates={searchCandidates}
                  onAccessError={handleMembershipAccessError}
                  disabled={savingQueue || membershipLoading || refreshRequired}
                  helpText="Select active employees with a completed login account."
                  emptySelectionText="No queue agents selected."
                />
                <EmployeeMultiSelect
                  label="Queue managers"
                  value={form.managers}
                  onChange={(value) => updateMembers('managers', value)}
                  searchCandidates={searchCandidates}
                  onAccessError={handleMembershipAccessError}
                  disabled={savingQueue || membershipLoading || refreshRequired}
                  helpText="Managers administer this queue; that does not grant confidential-ticket access."
                  emptySelectionText="No queue managers selected."
                />
              </div>
              <fieldset className="space-y-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.025] p-3">
                <legend className="px-1 inline-flex items-center gap-1.5 text-xs font-semibold text-amber-100"><ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />Confidential queue access</legend>
                <label className="flex items-start gap-2 text-xs text-crewly-text"><input type="checkbox" checked={form.confidentialityEnabled} onChange={(event) => updateForm('confidentialityEnabled', event.target.checked)} className="mt-0.5 h-4 w-4 accent-amber-300" />Enable restricted access for confidential tickets in this queue</label>
                <p className="text-[10px] leading-4 text-amber-100/80">Confidential access is an additional restricted permission. Queue-agent and manager membership never grants it automatically. Confidential agents must also be selected as regular queue agents first.</p>
                <div className="grid gap-4 lg:grid-cols-2">
                  <EmployeeMultiSelect
                        label="Confidential agents"
                        value={form.confidentialAgents}
                        onChange={(value) => updateMembers('confidentialAgents', value)}
                        searchCandidates={searchCandidates}
                        onAccessError={handleMembershipAccessError}
                        canSelectCandidate={canSelectConfidentialAgent}
                    disabled={savingQueue || membershipLoading || refreshRequired}
                    helpText="Only explicitly selected queue agents may receive this additional access."
                    selectionHint="Add an employee as a regular queue agent before granting confidential-agent access."
                    emptySelectionText="No confidential agents selected."
                  />
                  <EmployeeMultiSelect
                        label="Confidential reviewers"
                        value={form.confidentialReviewers}
                        onChange={(value) => updateMembers('confidentialReviewers', value)}
                        searchCandidates={searchCandidates}
                        onAccessError={handleMembershipAccessError}
                        disabled={savingQueue || membershipLoading || refreshRequired}
                    helpText="Reviewers are separate from agents and managers; select only approved reviewers."
                    emptySelectionText="No confidential reviewers selected."
                  />
                </div>
              </fieldset>
              <div className="flex justify-end gap-2 border-t border-crewly-border pt-3"><button type="button" onClick={() => { const reset = selectedQueue ? queueToForm(selectedQueue) : emptyQueueForm(); setForm({ ...reset, ...membershipBaseline, version: selectedQueue ? form.version : null }); setFormError(''); setConfirmingQueue(false); }} disabled={membershipLoading || refreshRequired} className="min-h-9 rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-bg disabled:opacity-50">Reset</button><button type="submit" disabled={savingQueue || membershipLoading || (Boolean(membershipError) && hasUnresolvedMembership) || refreshRequired} className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-crewly-green px-3 text-xs font-semibold text-slate-950 disabled:opacity-50"><Save className="h-3.5 w-3.5" aria-hidden="true" />Review and save</button></div>
            </form>
          </section>
        </div>

        {selectedId ? <PolicyEditor policy={policy} setPolicy={setPolicy} configured={policyConfigured} loading={policyLoading} saving={policySaving} error={policyError} notice={policyNotice} onReload={loadPolicy} onSubmit={persistPolicy} /> : <section className="rounded-2xl border border-crewly-border bg-crewly-card p-5"><HelpdeskEmpty icon={ShieldAlert} title="Select or create a queue" detail="Choose an existing queue to view or edit its SLA policy." /></section>}
      </div>
    </section>
  );
};

export default HelpdeskQueueAdminPage;
