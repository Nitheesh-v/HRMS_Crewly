// 🎫 Help Center hub — pixel-faithful to Figma "131. Help Center"
// (title + subtitle left, bordered search right, 3-col panel cards
// with 48px icon circles; red count badge as in Figma sidebar language)
import { useState } from 'react';
import { ChevronRight, Inbox, Plus, Search } from 'lucide-react';
import { DEPARTMENTS, HD } from './supportMeta';

const cardCls = 'rounded-xl p-6 text-left transition hover:brightness-110';
const cardStyle = { backgroundColor: HD.panel };
const circleStyle = { borderColor: HD.border, backgroundColor: HD.greenSoft };

const SupportHub = ({ myOpenCount, onOpenDepartment, onOpenMy, onRaise, onSearch }) => {
  const [q, setQ] = useState('');

  return (
    <div>
      {/* Header — exact Figma arrangement */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: HD.text }}>Help Center</h1>
          <p className="mt-1.5 text-[13px]" style={{ color: HD.dim }}>What can we help you with?</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <form
            className="relative w-full sm:w-[380px]"
            onSubmit={(e) => { e.preventDefault(); onSearch(q.trim()); }}
          >
            <input
              className="h-12 w-full rounded-lg border pl-4 pr-11 text-sm outline-none transition"
              style={{ borderColor: HD.border, backgroundColor: 'transparent', color: HD.text }}
              placeholder="Search what you need"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search tickets"
            />
            <button
              type="submit"
              title="Search"
              className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border transition hover:brightness-125"
              style={{ borderColor: HD.border, color: HD.dim }}
            >
              <Search className="h-4 w-4" aria-hidden="true" />
            </button>
          </form>
          <button
            onClick={onRaise}
            className="flex h-12 shrink-0 items-center justify-center gap-2 rounded-lg px-5 text-sm font-semibold text-white transition hover:opacity-90"
            style={{ backgroundColor: HD.green }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />Raise Ticket
          </button>
        </div>
      </div>

      {/* Card grid — 1 / 2 / 3 columns like the export */}
      <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {DEPARTMENTS.map(({ code, label, blurb, Icon }) => (
          <button key={code} onClick={() => onOpenDepartment(code)} className={cardCls} style={cardStyle}>
            <span className="flex h-12 w-12 items-center justify-center rounded-full border" style={circleStyle}>
              <Icon className="h-5 w-5" strokeWidth={1.8} style={{ color: HD.green }} aria-hidden="true" />
            </span>
            <p className="mt-5 text-[17px] font-semibold" style={{ color: HD.text }}>{label}</p>
            <p className="mt-2 text-[13px]" style={{ color: HD.dim }}>{blurb}</p>
          </button>
        ))}

        <button onClick={onOpenMy} className={`${cardCls} relative`} style={cardStyle}>
          {myOpenCount > 0 && (
            <span
              className="absolute right-5 top-5 flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold text-white"
              style={{ backgroundColor: HD.red }}
            >
              {myOpenCount}
            </span>
          )}
          <span className="flex h-12 w-12 items-center justify-center rounded-full border" style={circleStyle}>
            <Inbox className="h-5 w-5" strokeWidth={1.8} style={{ color: HD.green }} aria-hidden="true" />
          </span>
          <p className="mt-5 text-[17px] font-semibold" style={{ color: HD.text }}>My Tickets</p>
          <p className="mt-2 flex items-center gap-1 text-[13px]" style={{ color: HD.dim }}>
            Track every ticket you have raised<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </p>
        </button>
      </div>
    </div>
  );
};

export default SupportHub;
