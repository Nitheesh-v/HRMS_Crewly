// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — PRODUCT MOCK (markup only: no screenshot, no client data)
//
// The values are illustrative UI, the same convention AuthLayout already uses
// for its sign-in panel, and the whole block is aria-hidden so a screen reader
// is never read a fake dashboard as if it were real data.
//
// Built from markup rather than an image on purpose: it stays sharp on every
// screen, adds no request, and cannot silently go stale against the product.
// ═══════════════════════════════════════════════════════════════════════════

import {
  Bell,
  CalendarCheck,
  ChevronRight,
  CreditCard,
  FileCheck2,
  LayoutDashboard,
  Search,
  Sparkles,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';

const bars = [62, 84, 71, 92, 80, 96, 74];

const navRows = [
  { icon: LayoutDashboard, label: 'Home', active: true },
  { icon: Users, label: 'People' },
  { icon: CalendarCheck, label: 'Time & leave' },
  { icon: Wallet, label: 'Payroll' },
  { icon: UserPlus, label: 'Recruitment' },
];

const stats = [
  { label: 'Present today', value: '128', meta: 'of 137', tone: 'text-emerald-600', chip: 'bg-emerald-50 text-emerald-700' },
  { label: 'On leave', value: '9', meta: 'approved', tone: 'text-violet-600', chip: 'bg-violet-50 text-violet-700' },
  { label: 'Joining soon', value: '6', meta: 'this month', tone: 'text-indigo-600', chip: 'bg-indigo-50 text-indigo-700' },
  { label: 'Payroll due', value: '3', meta: 'days', tone: 'text-amber-600', chip: 'bg-amber-50 text-amber-700' },
];

const approvals = [
  { title: 'Casual leave · 2 days', who: 'Ravi S.', meta: 'Awaiting you', tone: 'bg-violet-50 text-violet-700' },
  { title: 'Regularisation · 1 day', who: 'Meena K.', meta: 'Awaiting you', tone: 'bg-indigo-50 text-indigo-700' },
  { title: 'Payroll run · October', who: 'HR desk', meta: 'In review', tone: 'bg-amber-50 text-amber-700' },
];

const DashboardPreview = () => (
  <div
    aria-hidden="true"
    className="landing-preview relative w-full overflow-hidden rounded-[22px]"
  >
    {/* Browser chrome — the frame, not a real page. */}
    <div className="flex items-center gap-2 border-b border-slate-200/80 bg-slate-50/80 px-4 py-2.5">
      <span className="flex gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-300" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
      </span>
      <span className="mx-auto inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-0.5 text-[10px] font-medium text-slate-500">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        app.crewly.in
      </span>
      <span className="w-8" />
    </div>

    <div className="flex bg-white">
      {/* App navigation */}
      <aside className="hidden w-40 shrink-0 border-r border-slate-200/80 bg-slate-50/60 p-3 sm:block">
        <div className="flex items-center gap-2 px-1">
          <img src="/logo-crewly-mark.png" alt="" className="h-5 w-5 shrink-0 object-contain" />
          <span className="text-[11px] font-bold tracking-tight text-[#171233]">Crewly</span>
        </div>

        <div className="mt-3 space-y-0.5">
          {navRows.map((row) => (
            <div
              key={row.label}
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[10px] font-medium ${
                row.active ? 'bg-violet-100/80 text-violet-800' : 'text-slate-500'
              }`}
            >
              <row.icon className="h-3 w-3" />
              {row.label}
            </div>
          ))}
        </div>

        <div className="mt-4 rounded-xl border border-violet-200/70 bg-violet-50/70 p-2">
          <div className="flex items-center gap-1.5 text-[9px] font-semibold text-violet-800">
            <Sparkles className="h-3 w-3" />
            Crewly AI
          </div>
          <p className="mt-1 text-[9px] leading-snug text-violet-700/80">
            Ask about leave, attendance or payslips.
          </p>
        </div>
      </aside>

      {/* Dashboard body */}
      <div className="min-w-0 flex-1 p-3.5 sm:p-4">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-[#171233]">Good morning, Priya</p>
            <p className="text-[9px] text-slate-400">Friday, 24 October · HR overview</p>
          </div>
          <span className="hidden items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[9px] text-slate-400 sm:inline-flex">
            <Search className="h-2.5 w-2.5" />
            Search
          </span>
          <span className="relative inline-flex h-6 w-6 items-center justify-center rounded-lg border border-slate-200 text-slate-400">
            <Bell className="h-3 w-3" />
            <span className="absolute right-1 top-1 h-1 w-1 rounded-full bg-rose-500" />
          </span>
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-100 text-[9px] font-bold text-violet-700">
            PS
          </span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-xl border border-slate-200/80 bg-white p-2.5">
              <p className="text-[9px] font-medium text-slate-500">{stat.label}</p>
              <div className="mt-0.5 flex items-baseline gap-1">
                <p className={`text-lg font-bold leading-none ${stat.tone}`}>{stat.value}</p>
                <span className="text-[8px] text-slate-400">{stat.meta}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-2 grid gap-2 lg:grid-cols-[1.15fr_1fr]">
          <div className="rounded-xl border border-slate-200/80 bg-white p-3">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold text-[#171233]">Attendance · last 7 days</p>
              <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[8px] font-semibold text-emerald-700">
                94% average
              </span>
            </div>
            {/* Real pixel heights, not percentages: a percentage height needs a
                parent with a definite height, and inside this flex column it
                resolved to zero — the chart rendered as an empty box. */}
            <div className="mt-2.5 flex items-end gap-1.5">
              {bars.map((height, index) => (
                <span key={index} className="flex flex-1 flex-col items-center gap-1">
                  <span
                    style={{ height: `${Math.round((height / 100) * 56)}px` }}
                    className={`w-full rounded-t-md ${
                      index === 5 ? 'bg-gradient-to-t from-violet-500 to-violet-400' : 'bg-slate-200'
                    }`}
                  />
                  <span className="text-[7px] text-slate-400">
                    {['M', 'T', 'W', 'T', 'F', 'S', 'S'][index]}
                  </span>
                </span>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200/80 bg-white p-3">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold text-[#171233]">Needs you</p>
              <span className="text-[8px] font-semibold text-violet-700">3 open</span>
            </div>
            <div className="mt-2 space-y-1.5">
              {approvals.map((row) => (
                <div key={row.title} className="flex items-center gap-2 rounded-lg border border-slate-100 px-2 py-1.5">
                  <span className={`rounded-md px-1.5 py-0.5 text-[7px] font-bold ${row.tone}`}>{row.meta}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[9px] font-medium text-slate-700">{row.title}</span>
                    <span className="block truncate text-[8px] text-slate-400">{row.who}</span>
                  </span>
                  <ChevronRight className="h-2.5 w-2.5 text-slate-300" />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {[
            { icon: CreditCard, label: 'Payslip ready' },
            { icon: FileCheck2, label: 'Policy acknowledged' },
            { icon: Sparkles, label: 'AI asked 4 questions' },
          ].map((chip) => (
            <span
              key={chip.label}
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-1 text-[8px] font-medium text-slate-500"
            >
              <chip.icon className="h-2.5 w-2.5 text-slate-400" />
              {chip.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  </div>
);

export default DashboardPreview;
