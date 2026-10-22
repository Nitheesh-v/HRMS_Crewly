/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, ClipboardList, FilePlus2, RefreshCw, UsersRound } from 'lucide-react';
import helpdeskService from '../../services/helpdeskService.js';
import usePermission from '../../hooks/usePermission.js';
import { HelpdeskEmpty, HelpdeskLoading, PriorityPill, StatusPill } from '../../components/helpdesk/HelpdeskUi.jsx';
import { helpdeskData, helpdeskDateTime, helpdeskErrorStatus, helpdeskMeta, safeHelpdeskError } from './helpdeskFormat.js';

const QuickLink = ({ to, icon: Icon, title, detail }) => (
  <Link to={to} className="group flex min-h-32 flex-col rounded-xl border border-crewly-border bg-crewly-card p-4 transition hover:border-crewly-green/40 hover:bg-crewly-card/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green">
    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-crewly-green/10 text-crewly-green">
      <Icon className="h-4 w-4" aria-hidden="true" />
    </span>
    <span className="mt-3 flex items-center gap-2 text-sm font-semibold text-crewly-text">{title}<ArrowRight className="h-3.5 w-3.5 text-crewly-dim transition group-hover:translate-x-0.5" aria-hidden="true" /></span>
    <span className="mt-1 text-xs leading-5 text-crewly-dim">{detail}</span>
  </Link>
);

const HelpdeskHomePage = () => {
  const { hasPermission } = usePermission();
  const canReadMine = hasPermission('HELPDESK_TICKET_READ_SELF');
  const [tickets, setTickets] = useState([]);
  const [total, setTotal] = useState(null);
  const [loading, setLoading] = useState(canReadMine);
  const [error, setError] = useState('');

  const loadRecent = useCallback(async () => {
    if (!canReadMine) {
      setTickets([]);
      setTotal(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await helpdeskService.listMyTickets({ page: 1, limit: 5, sort: 'recently_updated' });
      setTickets(Array.isArray(helpdeskData(response)) ? helpdeskData(response) : []);
      setTotal(Number(helpdeskMeta(response)?.total) || 0);
    } catch (requestError) {
      if ([401, 403, 404].includes(helpdeskErrorStatus(requestError))) {
        setTickets([]);
        setTotal(null);
      }
      setError(safeHelpdeskError(requestError, 'Recent tickets are temporarily unavailable.'));
    } finally {
      setLoading(false);
    }
  }, [canReadMine]);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Helpdesk shortcuts">
        {canReadMine ? <QuickLink to="/app/helpdesk/tickets" icon={ClipboardList} title="My tickets" detail="Review your requests and their latest status." /> : null}
        {hasPermission('HELPDESK_TICKET_CREATE_SELF') ? <QuickLink to="/app/helpdesk/tickets/new" icon={FilePlus2} title="Create a ticket" detail="Send a request to an available support queue." /> : null}
        {hasPermission('HELPDESK_KB_READ') ? <QuickLink to="/app/helpdesk/knowledge-base" icon={BookOpen} title="Knowledge Base" detail="Search published answers and guidance." /> : null}
        {hasPermission('HELPDESK_TICKET_READ') ? <QuickLink to="/app/helpdesk/workspace" icon={UsersRound} title="Agent workspace" detail="Review tickets in queues you can access." /> : null}
      </section>

      {canReadMine ? (
        <section className="rounded-2xl border border-crewly-border bg-crewly-card p-4 sm:p-5" aria-labelledby="recent-tickets-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="recent-tickets-heading" className="text-base font-semibold">Recent tickets</h2>
              <p className="mt-1 text-xs text-crewly-dim">{total === null ? 'Your recent requests' : `${total} request${total === 1 ? '' : 's'} in your self-service view`}</p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={loadRecent} disabled={loading} className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-crewly-border px-3 text-xs font-medium text-crewly-text hover:bg-crewly-bg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green">
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />Refresh
              </button>
              <Link to="/app/helpdesk/tickets" className="text-xs font-semibold text-crewly-green hover:underline">All my tickets</Link>
            </div>
          </div>
          {loading ? <HelpdeskLoading label="Loading your latest tickets…" /> : null}
          {!loading && error ? (
            <div className="mt-4 rounded-xl border border-rose-400/20 bg-rose-400/5 p-4" role="alert">
              <p className="text-sm text-rose-100">{error}</p>
              <button type="button" onClick={loadRecent} className="mt-2 text-xs font-semibold text-rose-100 underline">Try again</button>
            </div>
          ) : null}
          {!loading && !error && !tickets.length ? <div className="mt-4"><HelpdeskEmpty title="No tickets yet" detail="Your Helpdesk requests will appear here after you submit one." action={hasPermission('HELPDESK_TICKET_CREATE_SELF') ? <Link to="/app/helpdesk/tickets/new" className="inline-flex min-h-9 items-center rounded-lg bg-crewly-green px-3 text-xs font-semibold text-slate-950">Create a ticket</Link> : null} /></div> : null}
          {!loading && tickets.length ? (
            <div className="mt-4 divide-y divide-crewly-border rounded-xl border border-crewly-border">
              {tickets.map((ticket) => (
                <Link key={ticket.ticketNumber} to={`/app/helpdesk/tickets/${encodeURIComponent(ticket.ticketNumber)}`} className="grid gap-2 px-3 py-3 transition hover:bg-crewly-bg/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-crewly-green sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-4">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{ticket.subject || ticket.ticketNumber}</span>
                    <span className="mt-1 block text-[11px] text-crewly-dim">{ticket.ticketNumber} · Updated {helpdeskDateTime(ticket.updatedAt)}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusPill status={ticket.status} />
                    <PriorityPill priority={ticket.priority} />
                  </span>
                </Link>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {!canReadMine && !hasPermission('HELPDESK_TICKET_READ') && !hasPermission('HELPDESK_KB_READ') && !hasPermission('HELPDESK_TICKET_CREATE_SELF') ? (
        <div className="rounded-xl border border-amber-300/20 bg-amber-300/5 p-4 text-sm text-amber-100" role="status">
          Your account does not currently have an employee, agent, or Knowledge Base Helpdesk permission.
        </div>
      ) : null}
    </div>
  );
};

export default HelpdeskHomePage;
