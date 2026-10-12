// 🎫 Ticket list — Figma fidelity: "129 Messages" underline tabs,
// "19 Employee" table-on-panel rows, dropdown filters, panel cards on mobile.
import { ArrowLeft, ChevronRight, Inbox, MessageCircle, Plus, Search } from 'lucide-react';
import { DEPARTMENTS, HD, STATUSES, categoryLabel, fmtDay, statusMeta } from './supportMeta';

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
    {/* Breadcrumb (Figma 135 pattern) */}
    <button onClick={onBack} className="flex items-center gap-1.5 text-[13px] transition hover:brightness-125" style={{ color: HD.dim }}>
      Help Center<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
      <span style={{ color: HD.text }}>{title}</span>
    </button>

    {/* Header row */}
    <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <h1 className="text-2xl font-bold" style={{ color: HD.text }}>{title}</h1>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {isHR && (
          <div className="flex rounded-lg p-1" style={{ backgroundColor: HD.panel2 }}>
            {[['my', 'My tickets'], ['all', 'All tickets']].map(([k, label]) => (
              <button
                key={k}
                onClick={() => onScope(k)}
                className="rounded-md px-4 py-2 text-[13px] font-semibold transition"
                style={scope === k ? { backgroundColor: HD.greenSoft, color: HD.green } : { color: HD.dim }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="relative sm:w-64">
          <input
            className="h-11 w-full rounded-lg border pl-4 pr-10 text-sm outline-none transition"
            style={{ borderColor: HD.border, backgroundColor: HD.panel2, color: HD.text }}
            placeholder="Search…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            aria-label="Search tickets"
          />
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: HD.dim }} aria-hidden="true" />
        </div>
        <button
          onClick={onRaise}
          className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg px-5 text-sm font-semibold text-white transition hover:opacity-90"
          style={{ backgroundColor: HD.green }}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />Raise
        </button>
      </div>
    </div>

    {/* Status tabs — underline style exactly like 129 */}
    <div className="mt-6 flex gap-2 overflow-x-auto border-b" style={{ borderColor: HD.divider }}>
      {TABS.map(({ code, label }) => (
        <button
          key={code}
          onClick={() => onStatusTab(code)}
          className="-mb-px whitespace-nowrap border-b-2 px-4 py-3 text-sm transition"
          style={statusTab === code
            ? { borderColor: HD.green, color: HD.green, fontWeight: 600 }
            : { borderColor: 'transparent', color: HD.dim }}
        >
          {label}
        </button>
      ))}
    </div>

    {/* Department dropdown filter (Figma table filter language) */}
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <select
        className="h-11 rounded-lg border px-3 text-sm outline-none"
        style={{ borderColor: HD.border, backgroundColor: HD.panel2, color: HD.text }}
        value={categoryCode || ''}
        onChange={(e) => onCategory(e.target.value || null)}
        aria-label="Filter by department"
      >
        <option value="">All departments</option>
        {DEPARTMENTS.map(({ code, label }) => (
          <option key={code} value={code}>{label}</option>
        ))}
      </select>
      {!loading && (
        <span className="text-[13px]" style={{ color: HD.dim }}>{tickets.length} ticket{tickets.length === 1 ? '' : 's'}</span>
      )}
    </div>

    {/* Body */}
    <div className="mt-5">
      {loading && (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex animate-pulse items-center gap-4 rounded-xl p-5" style={{ backgroundColor: HD.panel }}>
              <div className="h-4 w-1/3 rounded" style={{ backgroundColor: HD.panel2 }} />
              <div className="h-4 w-20 rounded" style={{ backgroundColor: HD.panel2 }} />
              <div className="ml-auto h-4 w-16 rounded" style={{ backgroundColor: HD.panel2 }} />
            </div>
          ))}
        </div>
      )}

      {!loading && tickets.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl py-14 text-center" style={{ backgroundColor: HD.panel }}>
          <Inbox className="h-8 w-8" style={{ color: HD.dim }} aria-hidden="true" />
          <p className="text-[13px]" style={{ color: HD.dim }}>No tickets match this view yet.</p>
          <button
            onClick={onRaise}
            className="rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
            style={{ backgroundColor: HD.green }}
          >
            Raise a ticket
          </button>
        </div>
      )}

      {!loading && tickets.length > 0 && (
        <>
          {/* Desktop table on panel (19 Employee pattern) */}
          <div className="hidden overflow-hidden rounded-xl md:block" style={{ backgroundColor: HD.panel }}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[13px]" style={{ backgroundColor: HD.panel2, color: HD.dim }}>
                  <th className="px-5 py-3.5 font-medium">Subject</th>
                  <th className="px-5 py-3.5 font-medium">Department</th>
                  <th className="px-5 py-3.5 font-medium">Status</th>
                  <th className="px-5 py-3.5 font-medium">Updated</th>
                  <th className="px-5 py-3.5 text-right font-medium">Replies</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => {
                  const sm = statusMeta(t.status);
                  return (
                    <tr
                      key={t._id}
                      onClick={() => onSelect(t._id)}
                      className="cursor-pointer transition hover:brightness-110"
                      style={{ borderTop: `1px solid ${HD.divider}` }}
                    >
                      <td className="max-w-[26rem] px-5 py-4">
                        <p className="truncate font-medium" style={{ color: HD.text }}>{t.subject}</p>
                        <p className="truncate text-xs" style={{ color: HD.dim }}>{t.message}</p>
                      </td>
                      <td className="whitespace-nowrap px-5 py-4" style={{ color: HD.dim }}>{categoryLabel(t.category)}</td>
                      <td className="px-5 py-4">
                        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${sm.badge}`}>{sm.label}</span>
                      </td>
                      <td className="whitespace-nowrap px-5 py-4" style={{ color: HD.dim }}>{fmtDay(t.updatedAt || t.createdAt)}</td>
                      <td className="whitespace-nowrap px-5 py-4 text-right" style={{ color: HD.dim }}>
                        <MessageCircle className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                        {t.replies?.length || 0}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile panel cards */}
          <div className="space-y-3 md:hidden">
            {tickets.map((t) => {
              const sm = statusMeta(t.status);
              return (
                <button
                  key={t._id}
                  onClick={() => onSelect(t._id)}
                  className="w-full rounded-xl p-4 text-left transition hover:brightness-110"
                  style={{ backgroundColor: HD.panel }}
                >
                  <p className="truncate font-medium" style={{ color: HD.text }}>{t.subject}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className={`rounded-full px-3 py-1 font-semibold ${sm.badge}`}>{sm.label}</span>
                    <span style={{ color: HD.dim }}>{categoryLabel(t.category)}</span>
                  </div>
                  <p className="mt-2 flex items-center gap-2 text-xs" style={{ color: HD.dim }}>
                    {fmtDay(t.updatedAt || t.createdAt)}
                    <span className="inline-flex items-center gap-1">
                      <MessageCircle className="h-3 w-3" aria-hidden="true" />{t.replies?.length || 0}
                    </span>
                    <ArrowLeft className="ml-auto h-3.5 w-3.5 rotate-180" aria-hidden="true" />
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
