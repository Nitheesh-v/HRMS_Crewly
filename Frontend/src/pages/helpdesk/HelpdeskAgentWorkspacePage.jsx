/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Inbox, RefreshCw, Search, UsersRound } from 'lucide-react';
import helpdeskService from '../../services/helpdeskService.js';
import usePermission from '../../hooks/usePermission.js';
import { HelpdeskEmpty, HelpdeskError, HelpdeskLoading, PriorityPill, StatusPill } from '../../components/helpdesk/HelpdeskUi.jsx';
import { HELPDESK_PRIORITIES, HELPDESK_STATUSES, helpdeskData, helpdeskDateTime, helpdeskErrorStatus, helpdeskMeta, safeHelpdeskError } from './helpdeskFormat.js';

const WORK_MODES = [
  { id: 'queue', label: 'Queue tickets' },
  { id: 'assigned', label: 'Assigned to me' },
  { id: 'unassigned', label: 'Unassigned' },
];

const HelpdeskAgentWorkspacePage = () => {
  const { hasPermission } = usePermission();
  const canManage = hasPermission('HELPDESK_TICKET_MANAGE');
  const canManageQueues = hasPermission('HELPDESK_QUEUE_MANAGE');
  const [queues, setQueues] = useState([]);
  const [queueId, setQueueId] = useState('');
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState('');
  const [mode, setMode] = useState('assigned');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [tickets, setTickets] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [claiming, setClaiming] = useState('');

  const loadQueues = useCallback(async () => {
    setQueueLoading(true);
    setQueueError('');
    try {
      const response = canManageQueues ? await helpdeskService.listAdminQueues() : await helpdeskService.listQueues();
      const rows = Array.isArray(helpdeskData(response)) ? helpdeskData(response) : [];
      const safeRows = rows.map((queue) => ({
        id: queue.id,
        name: queue.name,
        description: queue.description,
        enabled: queue.enabled,
      }));
      setQueues(safeRows);
      setQueueId((current) => safeRows.some((queue) => String(queue.id) === String(current)) ? current : String(safeRows[0]?.id || ''));
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        setQueues([]);
        setQueueId('');
        setTickets([]);
        setTotal(0);
      }
      setQueueError(safeHelpdeskError(requestError, 'Queues you can browse could not be loaded.'));
    } finally {
      setQueueLoading(false);
    }
  }, [canManageQueues]);

  useEffect(() => {
    loadQueues();
  }, [loadQueues]);

  const loadTickets = useCallback(async () => {
    if (!queueId) {
      setTickets([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const params = { page, limit: 20, sort: 'recently_updated' };
      if (status) params.status = status;
      if (priority) params.priority = priority;
      if (search) params.search = search;
      const response = mode === 'assigned'
        ? await helpdeskService.listAssignedTickets(queueId, params)
        : mode === 'unassigned'
          ? await helpdeskService.listUnassignedTickets(queueId, params)
          : await helpdeskService.listQueueTickets(queueId, params);
      setTickets(Array.isArray(helpdeskData(response)) ? helpdeskData(response) : []);
      setTotal(Number(helpdeskMeta(response)?.total) || 0);
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        setTickets([]);
        setTotal(0);
      }
      setError(safeHelpdeskError(requestError, 'Tickets in this queue could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [mode, page, priority, queueId, search, status]);

  useEffect(() => {
    if (!queueLoading && !queueError) loadTickets();
  }, [loadTickets, queueError, queueLoading]);

  const applySearch = (event) => {
    event.preventDefault();
    setSearch(searchDraft.trim().slice(0, 60));
    setPage(1);
  };

  const claim = async (ticketNumber) => {
    setClaiming(ticketNumber);
    setError('');
    try {
      await helpdeskService.claimTicket(ticketNumber);
      await loadTickets();
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        setTickets([]);
        setTotal(0);
      }
      setError(safeHelpdeskError(requestError, 'This ticket could not be claimed.'));
    } finally {
      setClaiming('');
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / 20));
  const selectedQueue = queues.find((queue) => String(queue.id) === String(queueId));

  if (queueLoading) return <HelpdeskLoading label="Loading queues you can access…" />;
  if (queueError) return <HelpdeskError message={queueError} onRetry={loadQueues} />;

  return (
    <section className="space-y-4" aria-labelledby="agent-workspace-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-crewly-green">Authorized queue access</p><h2 id="agent-workspace-title" className="mt-1 text-xl font-semibold">Agent workspace</h2><p className="mt-1 text-sm text-crewly-dim">The queue directory is only a selector; ticket visibility and actions are independently rechecked by the server for every request.</p></div>
        <button type="button" onClick={loadTickets} disabled={loading || !queueId} className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-crewly-border px-3 text-xs font-semibold hover:bg-crewly-card disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />Refresh</button>
      </div>

      {!queues.length ? <HelpdeskEmpty icon={UsersRound} title="No support queues are available" detail="Ask a Helpdesk queue manager to confirm your queue access." /> : (
        <>
          <div className="grid gap-3 rounded-xl border border-crewly-border bg-crewly-card p-3 sm:grid-cols-2 lg:grid-cols-[minmax(12rem,0.8fr)_minmax(16rem,1fr)_minmax(10rem,0.7fr)_minmax(10rem,0.7fr)] lg:items-end">
            <label className="block text-xs font-medium text-crewly-dim">Queue<select value={queueId} onChange={(event) => { setQueueId(event.target.value); setPage(1); }} className="mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20">{queues.map((queue) => <option key={queue.id} value={queue.id}>{queue.name}</option>)}</select>{selectedQueue?.description ? <span className="mt-1 block text-[10px] leading-4">{selectedQueue.description}</span> : null}</label>
            <div className="flex flex-wrap gap-1 rounded-lg border border-crewly-border bg-crewly-bg p-1" role="tablist" aria-label="Ticket view">
              {WORK_MODES.map((item) => <button key={item.id} type="button" role="tab" aria-selected={mode === item.id} onClick={() => { setMode(item.id); setPage(1); }} className={`min-h-8 flex-1 rounded-md px-2 text-xs font-medium ${mode === item.id ? 'bg-crewly-green/15 text-crewly-text' : 'text-crewly-dim hover:text-crewly-text'}`}>{item.label}</button>)}
            </div>
            <label className="block text-xs font-medium text-crewly-dim">Status<select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} className="mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20"><option value="">All statuses</option>{HELPDESK_STATUSES.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
            <label className="block text-xs font-medium text-crewly-dim">Priority<select value={priority} onChange={(event) => { setPriority(event.target.value); setPage(1); }} className="mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20"><option value="">All priorities</option>{HELPDESK_PRIORITIES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <form onSubmit={applySearch} className="flex gap-2 sm:col-span-2 lg:col-span-4">
              <label className="sr-only" htmlFor="helpdesk-agent-search">Search this queue</label><div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crewly-dim" aria-hidden="true" /><input id="helpdesk-agent-search" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value.slice(0, 60))} maxLength={60} className="min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg pl-9 pr-3 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20" placeholder="Search subject or ticket number" /></div><button type="submit" className="min-h-10 rounded-lg border border-crewly-border px-4 text-xs font-semibold hover:bg-crewly-bg">Search</button>
            </form>
          </div>

          <div className="rounded-xl border border-crewly-border bg-crewly-card p-3 sm:p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-crewly-dim"><span>{total} ticket{total === 1 ? '' : 's'} · {mode === 'assigned' ? 'assigned to you' : mode === 'unassigned' ? 'unassigned' : 'in this queue'}</span><span>Page {page} of {totalPages}</span></div>
            {loading ? <HelpdeskLoading label="Loading queue tickets…" /> : null}
            {!loading && error ? <div className="mb-3" role="alert"><p className="text-sm text-rose-100">{error}</p><button type="button" onClick={loadTickets} className="mt-2 text-xs font-semibold text-rose-100 underline">Retry</button></div> : null}
            {!loading && !error && !tickets.length ? <HelpdeskEmpty icon={Inbox} title="No tickets in this view" detail="Try another queue view or change the filters." /> : null}
            {!loading && tickets.length ? <div className="overflow-x-auto rounded-lg border border-crewly-border"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-crewly-bg/80 text-[11px] uppercase tracking-wide text-crewly-dim"><tr><th scope="col" className="px-4 py-3 font-semibold">Ticket</th><th scope="col" className="px-4 py-3 font-semibold">Category</th><th scope="col" className="px-4 py-3 font-semibold">Status</th><th scope="col" className="px-4 py-3 font-semibold">Priority</th><th scope="col" className="px-4 py-3 font-semibold">Updated</th>{mode === 'unassigned' && canManage ? <th scope="col" className="px-4 py-3 font-semibold">Action</th> : null}</tr></thead><tbody className="divide-y divide-crewly-border">{tickets.map((ticket) => <tr key={ticket.ticketNumber} className="hover:bg-crewly-bg/50"><td className="max-w-[22rem] px-4 py-3"><Link to={`/app/helpdesk/tickets/${encodeURIComponent(ticket.ticketNumber)}`} className="block truncate font-medium hover:text-crewly-green">{ticket.subject || ticket.ticketNumber}</Link><span className="mt-1 block text-[11px] text-crewly-dim">{ticket.ticketNumber}{ticket.confidential ? ' · Confidential' : ''}</span></td><td className="px-4 py-3 text-xs text-crewly-dim">{ticket.category?.name || '—'}</td><td className="px-4 py-3"><StatusPill status={ticket.status} /></td><td className="px-4 py-3"><PriorityPill priority={ticket.priority} /></td><td className="whitespace-nowrap px-4 py-3 text-xs text-crewly-dim">{helpdeskDateTime(ticket.updatedAt)}</td>{mode === 'unassigned' && canManage ? <td className="px-4 py-3"><button type="button" onClick={() => claim(ticket.ticketNumber)} disabled={Boolean(claiming)} className="min-h-8 rounded-lg bg-crewly-green px-3 text-xs font-semibold text-slate-950 disabled:opacity-50">{claiming === ticket.ticketNumber ? 'Claiming…' : 'Claim'}</button></td> : null}</tr>)}</tbody></table></div> : null}
            <div className="mt-4 flex items-center justify-between gap-2"><button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={loading || page <= 1} className="min-h-9 rounded-lg border border-crewly-border px-3 text-xs font-medium disabled:opacity-40">Previous</button><span className="text-xs text-crewly-dim">Showing {tickets.length ? ((page - 1) * 20) + 1 : 0}–{Math.min(page * 20, total)} of {total}</span><button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={loading || page >= totalPages} className="min-h-9 rounded-lg border border-crewly-border px-3 text-xs font-medium disabled:opacity-40">Next</button></div>
          </div>
        </>
      )}
    </section>
  );
};

export default HelpdeskAgentWorkspacePage;
