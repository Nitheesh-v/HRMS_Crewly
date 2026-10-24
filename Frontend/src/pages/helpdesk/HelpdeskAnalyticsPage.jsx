/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';
import helpdeskService from '../../services/helpdeskService.js';
import helpdeskWorkspaceService from '../../services/helpdeskWorkspaceService.js';
import usePermission from '../../hooks/usePermission.js';
import { HelpdeskEmpty, HelpdeskError, HelpdeskLoading } from '../../components/helpdesk/HelpdeskUi.jsx';
import { helpdeskData, helpdeskErrorStatus, nextUtcDate, safeHelpdeskError } from './helpdeskFormat.js';

const dateInput = (date) => date.toISOString().slice(0, 10);
const initialTo = dateInput(new Date());
const initialFrom = (() => { const date = new Date(); date.setUTCDate(date.getUTCDate() - 29); return dateInput(date); })();
const numberLabel = (value) => Number(value || 0).toLocaleString('en-IN');
const durationLabel = (value) => {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const totalMinutes = Math.round(milliseconds / 60000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 48) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
};

const MetricCard = ({ label, value, detail }) => (
  <div className="rounded-xl border border-crewly-border bg-crewly-card p-4"><p className="text-xs text-crewly-dim">{label}</p><p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>{detail ? <p className="mt-1 text-[10px] leading-4 text-crewly-dim">{detail}</p> : null}</div>
);

const Distribution = ({ title, entries, nameKey, valueKey }) => {
  const rows = Array.isArray(entries) ? entries : [];
  const max = Math.max(1, ...rows.map((row) => Number(row[valueKey]) || 0));
  return (
    <section className="rounded-xl border border-crewly-border bg-crewly-card p-4"><h3 className="text-sm font-semibold">{title}</h3>{rows.length ? <ul className="mt-3 space-y-3">{rows.map((row, index) => { const value = Number(row[valueKey]) || 0; return <li key={`${row[nameKey]}-${index}`}><div className="flex items-center justify-between gap-3 text-xs"><span className="truncate capitalize text-crewly-dim">{String(row[nameKey] || 'Other').replaceAll('_', ' ')}</span><strong className="text-crewly-text">{numberLabel(value)}</strong></div><div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-crewly-border/60"><div className="h-full rounded-full bg-crewly-green" style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%` }} /></div></li>; })}</ul> : <p className="mt-3 text-xs text-crewly-dim">No aggregate rows for this period.</p>}</section>
  );
};

const HelpdeskAnalyticsPage = () => {
  const { hasPermission } = usePermission();
  const canManageQueues = hasPermission('HELPDESK_QUEUE_MANAGE');
  const canReadQueueList = hasPermission('HELPDESK_QUEUE_READ');
  const canManageKb = hasPermission('HELPDESK_KB_MANAGE');
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [queueId, setQueueId] = useState('');
  const [queues, setQueues] = useState([]);
  const [overview, setOverview] = useState(null);
  const [queueReport, setQueueReport] = useState(null);
  const [agentReport, setAgentReport] = useState(null);
  const [kbReport, setKbReport] = useState(null);
  const [queueReportError, setQueueReportError] = useState('');
  const [agentReportError, setAgentReportError] = useState('');
  const [kbReportError, setKbReportError] = useState('');
  const [loading, setLoading] = useState(true);
  const [queueListError, setQueueListError] = useState('');
  const [error, setError] = useState('');
  const [rangeError, setRangeError] = useState('');
  const requestRef = useRef(0);

  const params = useMemo(() => {
    const exclusiveTo = nextUtcDate(to);
    if (!from || !to || !exclusiveTo) return null;
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${exclusiveTo}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end || end.getTime() - start.getTime() > 366 * 24 * 60 * 60 * 1000) return null;
    return { from: start.toISOString(), to: end.toISOString(), page: 1, limit: 50 };
  }, [from, to]);

  useEffect(() => {
    let active = true;
    const loadQueueOptions = async () => {
      if (!canManageQueues && !canReadQueueList) return;
      try {
        const response = canManageQueues ? await helpdeskService.listAdminQueues() : await helpdeskService.listQueues();
        if (active) setQueues((Array.isArray(helpdeskData(response)) ? helpdeskData(response) : []).map((queue) => ({ id: queue.id, name: queue.name, enabled: queue.enabled })));
      } catch (requestError) {
        if (active) {
          if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
            setQueues([]);
            setQueueId('');
            setQueueReport(null);
            setAgentReport(null);
          }
          setQueueListError(safeHelpdeskError(requestError, 'Queue labels could not be loaded. You can still view the authorized overview.'));
        }
      }
    };
    loadQueueOptions();
    return () => { active = false; };
  }, [canManageQueues, canReadQueueList]);

  const loadReports = useCallback(async () => {
    if (!params) {
      setOverview(null);
      setQueueReport(null);
      setAgentReport(null);
      setKbReport(null);
      setQueueReportError('');
      setAgentReportError('');
      setKbReportError('');
      setError('');
      setLoading(false);
      setRangeError('Choose a date range of no more than 366 days.');
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError('');
    setRangeError('');
    setQueueReport(null);
    setAgentReport(null);
    setKbReport(null);
    setQueueReportError('');
    setAgentReportError('');
    setKbReportError('');

    try {
      const overviewResponse = await helpdeskWorkspaceService.getAnalyticsOverview(params);
      if (requestRef.current !== requestId) return;
      setOverview(helpdeskData(overviewResponse) || null);
    } catch (requestError) {
      if (requestRef.current !== requestId) return;
      setOverview(null);
      setQueueReport(null);
      setAgentReport(null);
      setKbReport(null);
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        setQueueReportError('');
        setAgentReportError('');
        setKbReportError('');
      }
      setError(safeHelpdeskError(requestError, 'The authorized Helpdesk overview could not be loaded.'));
      setLoading(false);
      return;
    }

    const jobs = [];
    if (queueId) {
      jobs.push({ key: 'queue', load: () => helpdeskWorkspaceService.getQueueAnalytics(queueId, params) });
      if (canManageQueues) jobs.push({ key: 'agent', load: () => helpdeskWorkspaceService.getAgentPerformance(queueId, params) });
    }
    if (canManageKb) jobs.push({ key: 'kb', load: () => helpdeskWorkspaceService.getKnowledgeBaseUsage(params) });
    const results = await Promise.all(jobs.map(async ({ key, load }) => {
      try {
        return { key, status: 'fulfilled', value: await load() };
      } catch (reason) {
        return { key, status: 'rejected', reason };
      }
    }));
    if (requestRef.current !== requestId) return;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const report = helpdeskData(result.value) || null;
        if (result.key === 'queue') setQueueReport(report);
        if (result.key === 'agent') setAgentReport(report);
        if (result.key === 'kb') setKbReport(report);
        continue;
      }
      const message = safeHelpdeskError(result.reason, 'This aggregate report could not be loaded.');
      if (result.key === 'queue') {
        setQueueReport(null);
        setQueueReportError(message);
      }
      if (result.key === 'agent') {
        setAgentReport(null);
        setAgentReportError(message);
      }
      if (result.key === 'kb') {
        setKbReport(null);
        setKbReportError(message);
      }
    }
    if (requestRef.current === requestId) setLoading(false);
  }, [canManageKb, canManageQueues, params, queueId]);

  useEffect(() => {
    if (params) loadReports();
    else {
      setOverview(null);
      setQueueReport(null);
      setAgentReport(null);
      setKbReport(null);
      setQueueReportError('');
      setAgentReportError('');
      setKbReportError('');
      setLoading(false);
      setRangeError('Choose a date range of no more than 366 days.');
    }
    return () => { requestRef.current += 1; };
  }, [loadReports, params]);

  const totals = overview?.tickets || {};
  const firstResponse = overview?.sla?.firstResponse || {};
  const resolution = overview?.sla?.resolution || {};
  const selectedQueue = queues.find((queue) => String(queue.id) === String(queueId));

  return (
    <section className="space-y-4" aria-labelledby="helpdesk-analytics-title">
      <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-crewly-green">Authorized aggregates</p><h2 id="helpdesk-analytics-title" className="mt-1 flex items-center gap-2 text-xl font-semibold"><BarChart3 className="h-5 w-5 text-crewly-green" aria-hidden="true" />Helpdesk analytics</h2><p className="mt-1 text-sm text-crewly-dim">Aggregate reports only; ticket bodies, internal notes, and requester profiles are not returned.</p></div><button type="button" onClick={loadReports} disabled={loading || !params} className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-card disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />Refresh</button></div>

      <div className="grid gap-3 rounded-xl border border-crewly-border bg-crewly-card p-3 sm:grid-cols-2 lg:grid-cols-[minmax(10rem,0.7fr)_minmax(10rem,0.7fr)_minmax(13rem,1fr)_auto] lg:items-end" aria-label="Analytics filters">
        <label className="block text-xs font-medium text-crewly-dim">From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20" /></label>
        <label className="block text-xs font-medium text-crewly-dim">Through<input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20" /></label>
        <label className="block text-xs font-medium text-crewly-dim">Queue report scope<select value={queueId} onChange={(event) => setQueueId(event.target.value)} disabled={!queues.length} className="mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20 disabled:opacity-50"><option value="">Authorized overview</option>{queues.map((queue) => <option key={queue.id} value={queue.id}>{queue.name}{queue.enabled === false ? ' (disabled)' : ''}</option>)}</select></label>
        <button type="button" onClick={loadReports} disabled={loading || !params} className="min-h-10 rounded-lg bg-crewly-green px-4 text-xs font-semibold text-slate-950 disabled:opacity-50">Apply period</button>
      </div>
      {rangeError ? <p className="rounded-lg border border-amber-300/20 bg-amber-300/5 px-3 py-2 text-xs text-amber-100" role="alert">{rangeError}</p> : null}
      {queueListError ? <p className="rounded-lg border border-amber-300/20 bg-amber-300/5 px-3 py-2 text-xs text-amber-100" role="status">{queueListError}</p> : null}
      {error ? <HelpdeskError message={error} onRetry={loadReports} /> : null}
      {loading && !overview ? <HelpdeskLoading label="Loading authorized reports…" /> : null}
      {!loading && !error && !overview ? <HelpdeskEmpty icon={BarChart3} title="No report data available" detail="No aggregate report could be loaded for this period and permission scope." /> : null}

      {overview ? <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label="Tickets created" value={numberLabel(totals.created)} detail={`${overview.scope?.readableQueues ?? 0} readable queue(s) in scope`} /><MetricCard label="Currently unassigned" value={numberLabel(totals.currentUnassigned)} detail="Current snapshot within the authorized scope" /><MetricCard label="Resolved or closed" value={numberLabel(totals.currentResolvedOrClosed)} detail="Tickets in resolved or closed states" /><MetricCard label="Average first resolution" value={durationLabel(overview.lifecycle?.averageFirstResolutionMs)} detail={`${numberLabel(overview.lifecycle?.firstResolutions)} first resolutions in period`} /></div>

        <div className="grid gap-3 xl:grid-cols-2"><Distribution title="Tickets by status" entries={totals.byStatus} nameKey="status" valueKey="tickets" /><Distribution title="Tickets by priority" entries={totals.byPriority} nameKey="priority" valueKey="tickets" /></div>

        <div className="grid gap-3 lg:grid-cols-2">
          <section className="rounded-xl border border-crewly-border bg-crewly-card p-4"><h3 className="text-sm font-semibold">SLA performance</h3><p className="mt-1 text-[10px] text-crewly-dim">Tracked only for tickets with a persisted SLA snapshot.</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><div className="rounded-lg border border-crewly-border p-3"><p className="text-[11px] text-crewly-dim">First response</p><p className="mt-1 text-sm font-semibold">{numberLabel(firstResponse.compliant)} compliant · {numberLabel(firstResponse.breached)} missed</p><p className="mt-1 text-[10px] text-crewly-dim">{numberLabel(firstResponse.observed)} observed</p></div><div className="rounded-lg border border-crewly-border p-3"><p className="text-[11px] text-crewly-dim">Resolution</p><p className="mt-1 text-sm font-semibold">{numberLabel(resolution.compliant)} compliant · {numberLabel(resolution.breached)} missed</p><p className="mt-1 text-[10px] text-crewly-dim">{numberLabel(resolution.observed)} observed</p></div></div></section>
          <section className="rounded-xl border border-crewly-border bg-crewly-card p-4"><h3 className="text-sm font-semibold">Lifecycle and feedback</h3><div className="mt-3 grid grid-cols-2 gap-2 text-xs"><p className="rounded-lg border border-crewly-border p-3 text-crewly-dim">Resolutions <strong className="float-right text-crewly-text">{numberLabel(overview.lifecycle?.resolutions)}</strong></p><p className="rounded-lg border border-crewly-border p-3 text-crewly-dim">Requester reopened <strong className="float-right text-crewly-text">{numberLabel(overview.lifecycle?.requesterReopens)}</strong></p><p className="rounded-lg border border-crewly-border p-3 text-crewly-dim">Confirmed <strong className="float-right text-crewly-text">{numberLabel(overview.lifecycle?.requesterConfirmed)}</strong></p><p className="rounded-lg border border-crewly-border p-3 text-crewly-dim">Auto-closed <strong className="float-right text-crewly-text">{numberLabel(overview.lifecycle?.autoClosed)}</strong></p></div><p className="mt-3 text-xs text-crewly-dim">Feedback responses: <strong className="text-crewly-text">{numberLabel(overview.feedback?.responses)}</strong> · Average rating: <strong className="text-crewly-text">{overview.feedback?.averageRating == null ? '—' : `${Number(overview.feedback.averageRating).toFixed(1)}/5`}</strong></p><p className="mt-2 text-[10px] leading-4 text-crewly-dim">{overview.lifecycle?.historyCoverage}</p></section>
        </div>

        {overview.queues?.items?.length ? <section className="rounded-xl border border-crewly-border bg-crewly-card p-4"><h3 className="text-sm font-semibold">Queue breakdown</h3><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-xs"><thead className="border-b border-crewly-border text-[10px] uppercase tracking-wide text-crewly-dim"><tr><th scope="col" className="py-2 pr-3">Queue</th><th scope="col" className="py-2 pr-3">Created</th><th scope="col" className="py-2 pr-3">Unassigned now</th><th scope="col" className="py-2">Resolved / closed</th></tr></thead><tbody className="divide-y divide-crewly-border">{overview.queues.items.map((row) => <tr key={row.queueId}><th scope="row" className="py-3 pr-3 font-medium">{row.queueName}</th><td className="py-3 pr-3">{numberLabel(row.ticketsCreated)}</td><td className="py-3 pr-3">{numberLabel(row.currentUnassigned)}</td><td className="py-3">{numberLabel(row.currentResolvedOrClosed)}</td></tr>)}</tbody></table></div><p className="mt-2 text-[10px] leading-4 text-crewly-dim">Only queues and ticket aggregates readable by your current authorization scope are included.</p></section> : null}

        {queueReportError ? <p className="rounded-lg border border-amber-300/20 bg-amber-300/5 px-3 py-2 text-xs text-amber-100" role="status">{queueReportError}</p> : null}
        {queueReport ? <section className="rounded-xl border border-crewly-border bg-crewly-card p-4"><h3 className="text-sm font-semibold">{selectedQueue?.name || queueReport.queue?.name || 'Queue'} report</h3><div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label="Queue tickets created" value={numberLabel(queueReport.tickets?.created)} /><MetricCard label="Unassigned now" value={numberLabel(queueReport.tickets?.currentUnassigned)} /><MetricCard label="First response compliant" value={numberLabel(queueReport.sla?.firstResponse?.compliant)} /><MetricCard label="Resolution compliant" value={numberLabel(queueReport.sla?.resolution?.compliant)} /></div></section> : null}

        {agentReportError ? <p className="rounded-lg border border-amber-300/20 bg-amber-300/5 px-3 py-2 text-xs text-amber-100" role="status">{agentReportError}</p> : null}
        {agentReport ? <section className="rounded-xl border border-crewly-border bg-crewly-card p-4"><h3 className="text-sm font-semibold">Queue agent performance</h3><p className="mt-1 text-[10px] leading-4 text-crewly-dim">Ticket workload uses the current assignee snapshot; reply counts include persisted public replies only.</p>{agentReport.agents?.items?.length ? <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[600px] text-left text-xs"><thead className="border-b border-crewly-border text-[10px] uppercase tracking-wide text-crewly-dim"><tr><th scope="col" className="py-2 pr-3">Agent identifier</th><th scope="col" className="py-2 pr-3">Tickets assigned</th><th scope="col" className="py-2 pr-3">Resolved / closed</th><th scope="col" className="py-2 pr-3">Public replies</th><th scope="col" className="py-2">Tickets replied to</th></tr></thead><tbody className="divide-y divide-crewly-border">{agentReport.agents.items.map((agent) => <tr key={agent.agentId}><th scope="row" className="break-all py-3 pr-3 font-medium">{agent.agentId}</th><td className="py-3 pr-3">{numberLabel(agent.currentAssigneeTicketsCreatedInPeriod)}</td><td className="py-3 pr-3">{numberLabel(agent.currentResolvedOrClosedTickets)}</td><td className="py-3 pr-3">{numberLabel(agent.publicRepliesAuthoredInPeriod)}</td><td className="py-3">{numberLabel(agent.visibleTicketsRepliedTo)}</td></tr>)}</tbody></table></div> : <p className="mt-3 text-xs text-crewly-dim">No agent rows in this period.</p>}{agentReport.attribution ? <p className="mt-2 text-[10px] leading-4 text-crewly-dim">{agentReport.attribution}</p> : null}</section> : null}

        {kbReportError ? <p className="rounded-lg border border-amber-300/20 bg-amber-300/5 px-3 py-2 text-xs text-amber-100" role="status">{kbReportError}</p> : null}
        {kbReport ? <section className="rounded-xl border border-crewly-border bg-crewly-card p-4"><h3 className="text-sm font-semibold">Knowledge Base usage</h3><div className="mt-3 grid gap-2 sm:grid-cols-2"><MetricCard label="Public reply references" value={numberLabel(kbReport.publicReplyReferences)} /><MetricCard label="Distinct referenced articles" value={numberLabel(kbReport.distinctArticlesReferenced)} /></div><p className="mt-2 text-[10px] leading-4 text-crewly-dim">{kbReport.measurement}</p>{kbReport.articles?.items?.length ? <ul className="mt-3 divide-y divide-crewly-border rounded-lg border border-crewly-border">{kbReport.articles.items.map((article) => <li key={article.articleId} className="flex flex-wrap justify-between gap-2 px-3 py-2 text-xs"><code className="break-all text-crewly-dim">{article.articleId}</code><span>{numberLabel(article.publicReplyReferences)} references</span></li>)}</ul> : null}</section> : null}
        <p className="text-[10px] leading-4 text-crewly-dim">Helpdesk reports support date range and bounded pagination only. Status, priority, category, and agent query filters are not sent because the current analytics API does not accept them.</p>
      </> : null}
    </section>
  );
};

export default HelpdeskAnalyticsPage;
