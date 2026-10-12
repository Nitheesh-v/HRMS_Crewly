// 🎫 Helpdesk hub — Figma "131. Help Center" card-grid pattern, Crewly tokens
import { useState } from 'react';
import { Inbox, Plus, Search } from 'lucide-react';
import { DEPARTMENTS } from './supportMeta';

const SupportHub = ({ myOpenCount, openCountByCat, onOpenDepartment, onOpenMy, onRaise, onSearch }) => {
  const [q, setQ] = useState('');

  return (
    <div>
      {/* Header — title left, search + CTA right (stacks on mobile) */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Helpdesk</h1>
          <p className="mt-1 text-sm text-crewly-dim">
            What can we help you with? Raise a ticket or track an existing one.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <form
            className="relative sm:w-64"
            onSubmit={(e) => { e.preventDefault(); onSearch(q.trim()); }}
          >
            <input
              className="input w-full pr-9"
              placeholder="Search tickets…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search tickets"
            />
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crewly-dim" aria-hidden="true" />
          </form>
          <button className="btn-primary shrink-0 px-4 py-2 text-sm" onClick={onRaise}>
            <Plus className="mr-1 inline h-4 w-4" aria-hidden="true" />Raise Ticket
          </button>
        </div>
      </div>

      {/* Department cards — 1 col mobile, 2 sm, 3 lg (as Figma hub grid) */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
        {DEPARTMENTS.map(({ code, label, blurb, Icon }) => (
          <button
            key={code}
            onClick={() => onOpenDepartment(code)}
            className="card relative p-5 text-left transition hover:border-crewly-green/40"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full border border-crewly-border bg-crewly-bg">
              <Icon className="h-5 w-5 text-crewly-green" strokeWidth={1.8} aria-hidden="true" />
            </span>
            {openCountByCat[code] > 0 && (
              <span className="badge absolute right-4 top-4 bg-crewly-orange/15 text-crewly-orange">
                {openCountByCat[code]} open
              </span>
            )}
            <p className="mt-4 font-semibold">{label}</p>
            <p className="mt-1 text-sm text-crewly-dim">{blurb}</p>
          </button>
        ))}

        <button
          onClick={onOpenMy}
          className="card relative p-5 text-left transition hover:border-crewly-green/40"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-full border border-crewly-border bg-crewly-bg">
            <Inbox className="h-5 w-5 text-crewly-green" strokeWidth={1.8} aria-hidden="true" />
          </span>
          {myOpenCount > 0 && (
            <span className="badge absolute right-4 top-4 bg-crewly-orange/15 text-crewly-orange">
              {myOpenCount} open
            </span>
          )}
          <p className="mt-4 font-semibold">My Tickets</p>
          <p className="mt-1 text-sm text-crewly-dim">Track every ticket you have raised</p>
        </button>
      </div>
    </div>
  );
};

export default SupportHub;
