import { useMemo } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import {
  BookOpen,
  ChartNoAxesCombined,
  CircleHelp,
  ClipboardList,
  FilePlus2,
  Settings2,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import useAuth from '../../hooks/useAuth.jsx';
import usePermission from '../../hooks/usePermission.js';

const navClass = ({ isActive }) => [
  'inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green',
  isActive
    ? 'border-crewly-green/40 bg-crewly-green/10 text-crewly-text'
    : 'border-transparent text-crewly-dim hover:border-crewly-border hover:bg-crewly-bg hover:text-crewly-text',
].join(' ');

const HelpdeskShell = () => {
  const { user } = useAuth();
  const { hasPermission, hasAnyPermission } = usePermission();
  const links = useMemo(() => [
    { to: '/app/helpdesk', label: 'Overview', icon: CircleHelp, show: true, end: true },
    { to: '/app/helpdesk/tickets', label: 'My tickets', icon: ClipboardList, show: hasPermission('HELPDESK_TICKET_READ_SELF') },
    { to: '/app/helpdesk/tickets/new', label: 'New ticket', icon: FilePlus2, show: hasPermission('HELPDESK_TICKET_CREATE_SELF') },
    { to: '/app/helpdesk/workspace', label: 'Agent workspace', icon: UsersRound, show: hasPermission('HELPDESK_TICKET_READ') },
    { to: '/app/helpdesk/knowledge-base', label: 'Knowledge Base', icon: BookOpen, show: hasPermission('HELPDESK_KB_READ') },
    { to: '/app/helpdesk/analytics', label: 'Analytics', icon: ChartNoAxesCombined, show: hasPermission('HELPDESK_TICKET_READ') },
    { to: '/app/helpdesk/queues', label: 'Queue setup', icon: Settings2, show: hasPermission('HELPDESK_QUEUE_MANAGE') },
    { to: '/app/helpdesk/admin/knowledge-base', label: 'KB management', icon: ShieldCheck, show: hasPermission('HELPDESK_KB_MANAGE') },
    { to: '/app/helpdesk/admin', label: 'Settings', icon: Settings2, show: hasPermission('HELPDESK_QUEUE_MANAGE') },
  ].filter((item) => item.show), [hasPermission]);

  return (
    <div className="min-h-full bg-crewly-bg px-3 py-4 text-crewly-text sm:px-5 sm:py-6 lg:px-7">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="rounded-2xl border border-crewly-border bg-crewly-card p-4 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-crewly-green/10 text-crewly-green">
                <CircleHelp className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-crewly-green">Crewly support</p>
                <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">Helpdesk</h1>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-crewly-dim">
                  Find an answer, follow a request, or work on tickets assigned to your queues.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {hasAnyPermission('HELPDESK_TICKET_CREATE_SELF') ? (
                <Link
                  to="/app/helpdesk/tickets/new"
                  className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-crewly-green px-4 py-2 text-sm font-semibold text-slate-950 transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crewly-green focus-visible:ring-offset-2 focus-visible:ring-offset-crewly-card"
                >
                  <FilePlus2 className="h-4 w-4" aria-hidden="true" />
                  Create a ticket
                </Link>
              ) : null}
              {user?.name ? <span className="hidden text-xs text-crewly-dim sm:inline">Signed in as {user.name}</span> : null}
            </div>
          </div>
          <nav className="mt-5 flex gap-1.5 overflow-x-auto border-t border-crewly-border pt-3 pb-1" aria-label="Helpdesk sections">
            {links.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end} className={navClass}>
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="whitespace-nowrap">{label}</span>
              </NavLink>
            ))}
          </nav>
        </header>
        <main id="helpdesk-main" className="min-w-0" aria-live="off">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default HelpdeskShell;
