// 🎫 Ticket list — Figma table/filter + Messages underline-tab patterns;
// desktop table, stacked cards on mobile.
import { ArrowLeft, Inbox, MessageCircle, Plus, Search } from 'lucide-react';
import { DEPARTMENTS, STATUSES, categoryLabel, fmtDay, statusMeta } from './supportMeta';

const TABS = [{ code: 'ALL', label: 'All' }, ...STATUSES.map(({ code, label }) => ({ code, label }))];

const TicketList = ({
  title,
  tickets,
  loading,
  isHR,
  scope,
  onScope,
  statusTab,
  onStatusTab,
  categoryCode,
  onCategory,
  query,
  onQuery,
  onSelect,
  onRaise,
  onBack,
}) => (
  <div>
    {/* Header */}
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-crewly-dim transition hover:text-crewly-text">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />Helpdesk
        </button>
        <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold">
          <span className="truncate">{title}</span>
          {!loading && <span className="badge bg-crewly-card text-crewly-dim">{tickets.length}</span>}
        </h1>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {isHR && (
          <div className="flex rounded-lg border border-crewly-border p-0.5">
            {[['my', 'My tickets'], ['all', 'All tickets']].map(([k, label]) => (
              <button
                key={k}
                onClick={() => onScope(k)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${scope === k ? 'bg-crewly-green/15 text-crewly-green' : 'text-crewly-dim hover:text-crewly-text'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="relative sm:w-56">
          <input
            className="input w-full pr-9"
            placeholder="Search…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            aria-label="Search tickets"
          />
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crewly-dim" aria-hidden="true" />
        </div>
        <button className="btn-primary shrink-0 px-4 py-2 text-sm" onClick={onRaise}>
          <Plus className="mr-1 inline h-4 w-4" aria-hidden="true" />Raise
        </button>
      </div>
    </div>

    {/* Status tabs — underline style (Figma Messages "All | Unread") */}
    <div className="mt-5 flex gap-1 overflow-x-auto border-b border-crewly-border">
      {TABS.map(({ code, label }) => (
        <button
          key={code}
          onClick={() => onStatusTab(code)}
          className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition ${statusTab === code ? 'border-crewly-green font-semibold text-crewly-green' : 'border-transparent text-crewly-dim hover:text-crewly-text'}`}
        >
          {label}
        </button>
      ))}
    </div>

    {/* Department filter chips */}
    <div className="mt-3 flex flex-wrap gap-2">
      <button
        onClick={() => onCategory(null)}
        className={`rounded-full border px-3 py-1 text-xs transition ${!categoryCode ? 'border-crewly-green/40 bg-crewly-green/15 text-crewly-green' : 'border-crewly-border text-crewly-dim hover:text-crewly-text'}`}
      >
        All departments
      </button>
      {DEPARTMENTS.map(({ code, label }) => (
        <button
          key={code}
          onClick={() => onCategory(code)}
          className={`rounded-full border px-3 py-1 text-xs transition ${categoryCode === code ? 'border-crewly-green/40 bg-crewly-green/15 text-crewly-green' : 'border-crewly-border text-crewly-dim hover:text-crewly-text'}`}
        >
          {label}
        </button>
      ))}
    </div>

    {/* Body */}
    <div className="mt-4">
      {loading && (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card flex items-center gap-4 py-4">
              <div className="h-4 w-1/3 animate-pulse rounded bg-crewly-border/40" />
              <div className="h-4 w-20 animate-pulse rounded bg-crewly-border/30" />
              <div className="ml-auto h-4 w-16 animate-pulse rounded bg-crewly-border/30" />
            </div>
          ))}
        </div>
      )}

      {!loading && tickets.length === 0 && (
        <div className="card flex flex-col items-center gap-3 py-12 text-center">
          <Inbox className="h-8 w-8 text-crewly-dim" aria-hidden="true" />
          <p className="text-sm text-crewly-dim">No tickets match this view yet.</p>
          <button className="btn-primary px-4 py-2 text-sm" onClick={onRaise}>Raise a ticket</button>
        </div>
      )}

      {!loading && tickets.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="card hidden overflow-x-auto p-0 md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-crewly-border text-left text-xs text-crewly-dim">
                  <th className="px-4 py-3 font-medium">Subject</th>
                  <th className="px-4 py-3 font-medium">Department</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Updated</th>
                  <th className="px-4 py-3 text-right font-medium">Replies</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => {
                  const sm = statusMeta(t.status);
                  return (
                    <tr
                      key={t._id}
                      onClick={() => onSelect(t._id)}
                      className="cursor-pointer border-b border-crewly-border/60 transition last:border-0 hover:bg-crewly-bg/60"
                    >
                      <td className="max-w-[26rem] px-4 py-3">
                        <p className="truncate font-semibold">{t.subject}</p>
                        <p className="truncate text-xs text-crewly-dim">{t.message}</p>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-crewly-dim">{categoryLabel(t.category)}</td>
                      <td className="px-4 py-3">
                        <span className={`badge ${sm.badge}`}>{sm.label}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-crewly-dim">{fmtDay(t.updatedAt || t.createdAt)}</td>
                      <td className="px-4 py-3 text-right text-crewly-dim">
                        <MessageCircle className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                        {t.replies?.length || 0}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-2 md:hidden">
            {tickets.map((t) => {
              const sm = statusMeta(t.status);
              return (
                <button key={t._id} onClick={() => onSelect(t._id)} className="card w-full p-4 text-left transition hover:border-crewly-green/40">
                  <p className="truncate font-semibold">{t.subject}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className={`badge ${sm.badge}`}>{sm.label}</span>
                    <span className="text-crewly-dim">{categoryLabel(t.category)}</span>
                  </div>
                  <p className="mt-2 flex items-center gap-2 text-xs text-crewly-dim">
                    {fmtDay(t.updatedAt || t.createdAt)}
                    <span className="inline-flex items-center gap-1">
                      <MessageCircle className="h-3 w-3" aria-hidden="true" />{t.replies?.length || 0}
                    </span>
                  </p>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  </div>
);

export default TicketList;
