/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Filter, Search } from 'lucide-react';
import helpdeskService from '../../services/helpdeskService.js';
import usePermission from '../../hooks/usePermission.js';
import { HelpdeskEmpty, HelpdeskLoading, PriorityPill, StatusPill } from '../../components/helpdesk/HelpdeskUi.jsx';
import { HELPDESK_PRIORITIES, HELPDESK_STATUSES, helpdeskData, helpdeskDateTime, helpdeskErrorStatus, helpdeskMeta, safeHelpdeskError } from './helpdeskFormat.js';

const HelpdeskTicketsPage = () => {
  const { hasPermission } = usePermission();
  const [tickets, setTickets] = useState([]);
  const [filters, setFilters] = useState({ status: '', priority: '', search: '', sort: 'recently_updated' });
  const [draftSearch, setDraftSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadTickets = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, limit: 20, sort: filters.sort };
      if (filters.status) params.status = filters.status;
      if (filters.priority) params.priority = filters.priority;
      if (filters.search.trim()) params.search = filters.search.trim();
      const response = await helpdeskService.listMyTickets(params);
      setTickets(Array.isArray(helpdeskData(response)) ? helpdeskData(response) : []);
      setTotal(Number(helpdeskMeta(response)?.total) || 0);
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        setTickets([]);
        setTotal(0);
      }
      setError(safeHelpdeskError(requestError, 'Your tickets could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  const applySearch = (event) => {
    event.preventDefault();
    setFilters((current) => ({ ...current, search: draftSearch.trim() }));
    setPage(1);
  };

  const changeFilter = (field, value) => {
    setFilters((current) => ({ ...current, [field]: value }));
    setPage(1);
  };

  const maxPage = Math.max(1, Math.ceil(total / 20));

  return (
    <section className="space-y-4" aria-labelledby="my-tickets-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-crewly-green">Self-service</p>
          <h2 id="my-tickets-title" className="mt-1 text-xl font-semibold">My tickets</h2>
          <p className="mt-1 text-sm text-crewly-dim">Only your own requests are shown here.</p>
        </div>
        {hasPermission('HELPDESK_TICKET_CREATE_SELF') ? (
          <Link to="/app/helpdesk/tickets/new" className="inline-flex min-h-10 items-center justify-center rounded-lg bg-crewly-green px-4 text-sm font-semibold text-slate-950 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green">New ticket</Link>
        ) : null}
      </div>

      <form onSubmit={applySearch} className="grid gap-3 rounded-xl border border-crewly-border bg-crewly-card p-3 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1fr)_minmax(9rem,0.6fr)_minmax(9rem,0.6fr)_minmax(10rem,0.7fr)_auto] lg:items-end" aria-label="Filter your tickets">
        <label className="block text-xs font-medium text-crewly-dim">
          Search tickets
          <span className="relative mt-1.5 block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crewly-dim" aria-hidden="true" />
            <input value={draftSearch} onChange={(event) => setDraftSearch(event.target.value.slice(0, 60))} maxLength={60} className="min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg pl-9 pr-3 text-sm text-crewly-text placeholder:text-crewly-dim/70 focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20" placeholder="Subject or ticket number" />
          </span>
        </label>
        <label className="block text-xs font-medium text-crewly-dim">Status
          <select value={filters.status} onChange={(event) => changeFilter('status', event.target.value)} className="mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20">
            <option value="">All statuses</option>{HELPDESK_STATUSES.map((status) => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}
          </select>
        </label>
        <label className="block text-xs font-medium text-crewly-dim">Priority
          <select value={filters.priority} onChange={(event) => changeFilter('priority', event.target.value)} className="mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20">
            <option value="">All priorities</option>{HELPDESK_PRIORITIES.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
          </select>
        </label>
        <label className="block text-xs font-medium text-crewly-dim">Sort by
          <select value={filters.sort} onChange={(event) => changeFilter('sort', event.target.value)} className="mt-1.5 min-h-10 w-full rounded-lg border border-crewly-border bg-crewly-bg px-3 text-sm text-crewly-text focus:border-crewly-green focus:outline-none focus:ring-2 focus:ring-crewly-green/20">
            <option value="recently_updated">Recently updated</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option>
          </select>
        </label>
        <button type="submit" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-crewly-border px-4 text-sm font-semibold text-crewly-text hover:bg-crewly-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green"><Filter className="h-4 w-4" aria-hidden="true" />Apply</button>
      </form>

      <div className="rounded-xl border border-crewly-border bg-crewly-card p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-crewly-dim">
          <span>{total} matching ticket{total === 1 ? '' : 's'}</span>
          <span>Page {page} of {maxPage}</span>
        </div>
        {loading ? <HelpdeskLoading label="Loading tickets…" /> : null}
        {!loading && error ? (
          <div className="rounded-lg border border-rose-400/20 bg-rose-400/5 p-4" role="alert">
            <p className="text-sm text-rose-100">{error}</p>
            <button type="button" onClick={loadTickets} className="mt-2 text-xs font-semibold text-rose-100 underline">Retry</button>
          </div>
        ) : null}
        {!loading && !error && tickets.length === 0 ? <HelpdeskEmpty title="No matching tickets" detail="Adjust the filters or create a new request." /> : null}
        {!loading && tickets.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-crewly-border">
            <table className="w-full min-w-[700px] text-left text-sm">
              <thead className="bg-crewly-bg/80 text-[11px] uppercase tracking-wide text-crewly-dim">
                <tr><th scope="col" className="px-4 py-3 font-semibold">Ticket</th><th scope="col" className="px-4 py-3 font-semibold">Queue / category</th><th scope="col" className="px-4 py-3 font-semibold">Status</th><th scope="col" className="px-4 py-3 font-semibold">Priority</th><th scope="col" className="px-4 py-3 font-semibold">Updated</th></tr>
              </thead>
              <tbody className="divide-y divide-crewly-border">
                {tickets.map((ticket) => (
                  <tr key={ticket.ticketNumber} className="hover:bg-crewly-bg/50">
                    <td className="max-w-[20rem] px-4 py-3"><Link to={`/app/helpdesk/tickets/${encodeURIComponent(ticket.ticketNumber)}`} className="block truncate font-medium text-crewly-text hover:text-crewly-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green">{ticket.subject || ticket.ticketNumber}</Link><span className="mt-1 block text-[11px] text-crewly-dim">{ticket.ticketNumber}</span></td>
                    <td className="px-4 py-3 text-xs text-crewly-dim">{ticket.queue?.name || 'Queue unavailable'}{ticket.category?.name ? <span className="block mt-1">{ticket.category.name}</span> : null}</td>
                    <td className="px-4 py-3"><StatusPill status={ticket.status} /></td>
                    <td className="px-4 py-3"><PriorityPill priority={ticket.priority} /></td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-crewly-dim">{helpdeskDateTime(ticket.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <div className="mt-4 flex items-center justify-between gap-3">
          <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={loading || page <= 1} className="min-h-9 rounded-lg border border-crewly-border px-3 text-xs font-medium text-crewly-text hover:bg-crewly-bg disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green">Previous</button>
          <span className="text-xs text-crewly-dim">Showing {tickets.length ? ((page - 1) * 20) + 1 : 0}–{Math.min(page * 20, total)} of {total}</span>
          <button type="button" onClick={() => setPage((current) => Math.min(maxPage, current + 1))} disabled={loading || page >= maxPage} className="min-h-9 rounded-lg border border-crewly-border px-3 text-xs font-medium text-crewly-text hover:bg-crewly-bg disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green">Next</button>
        </div>
      </div>
    </section>
  );
};

export default HelpdeskTicketsPage;
