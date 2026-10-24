// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — THE PRODUCT MOCK IN THE HERO.
//
// Decorative markup, aria-hidden at the root: no screenshot asset, no request,
// no client data. It is deliberately the REAL app's shape — night canvas,
// emerald for attendance, violet for the assistant — because the strongest
// differentiator this page has is that the product looks like this.
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
  { label: 'Present today', value: '128', meta: 'of 137', tone: 'text-emerald-300' },
  { label: 'On leave', value: '9', meta: 'approved', tone: 'text-teal-300' },
  { label: 'Joining soon', value: '6', meta: 'this month', tone: 'text-violet-300' },
  { label: 'Payroll due', value: '3', meta: 'days', tone: 'text-amber-300' },
];

const approvals = [
  { title: 'Casual leave · 2 days', who: 'Ravi S.', meta: 'Awaiting you', tone: 'bg-amber-400/10 text-amber-300' },
  { title: 'Regularisation · 1 day', who: 'Meena K.', meta: 'Awaiting you', tone: 'bg-amber-400/10 text-amber-300' },
  { title: 'Payroll run · October', who: 'HR desk', meta: 'In review', tone: 'bg-violet-400/10 text-violet-300' },
];

const DashboardPreview = () => (
  <div aria-hidden="true" className="landing-preview relative w-full overflow-hidden rounded-[22px]">
    {/* App chrome — the frame, not a real page. */}
    <div className="flex items-center gap-2 border-b border-white/[0.08] bg-white/[0.03] px-4 py-2.5">
      <span className="flex gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-400/50" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/50" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/50" />
      </span>
      <span className="mx-auto inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-3 py-0.5 text-[10px] font-medium text-slate-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        app.crewly.in
      </span>
      <span className="w-8" />
    </div>

    <div className="flex">
      {/* App navigation */}
      <aside className="hidden w-40 shrink-0 border-r border-white/[0.06] bg-white/[0.015] p-3 sm:block">
        <div className="flex items-center gap-2 px-1">
          <img src="/logo-crewly-mark.png" alt="" className="h-5 w-5 shrink-0 object-contain" />
          <span className="text-[11px] font-bold tracking-tight text-white">Crewly</span>
        </div>

        <div className="mt-3 space-y-0.5">
          {navRows.map((row) => (
            <div
              key={row.label}
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[10px] font-medium ${
                row.active ? 'bg-emerald-500/15 text-emerald-200' : 'text-slate-400'
              }`}
            >
              <row.icon className="h-3 w-3" />
              {row.label}
            </div>
          ))}
        </div>

        <div className="mt-4 rounded-xl border border-violet-400/20 bg-violet-500/[0.08] p-2">
          <div className="flex items-center gap-1.5 text-[9px] font-semibold text-violet-200">
            <Sparkles className="h-3 w-3" />
            Crewly AI
          </div>
          <p className="mt-1 text-[9px] leading-snug text-violet-200/60">
            Ask about leave, attendance or payslips.
          </p>
        </div>
      </aside>

      {/* Dashboard body */}
      <div className="min-w-0 flex-1 p-3.5 sm:p-4">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-white">Good morning, Priya</p>
            <p className="text-[9px] text-slate-500">Friday, 24 October · HR overview</p>
          </div>
          <span className="hidden items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[9px] text-slate-500 sm:inline-flex">
            <Search className="h-2.5 w-2.5" />
            Search
          </span>
          <span className="relative inline-flex h-6 w-6 items-center justify-center rounded-lg border border-white/10 text-slate-500">
            <Bell className="h-3 w-3" />
            <span className="absolute right-1 top-1 h-1 w-1 rounded-full bg-emerald-400" />
          </span>
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/15 text-[9px] font-bold text-emerald-300">
            PS
          </span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-2.5">
              <p className="text-[9px] font-medium text-slate-400">{stat.label}</p>
              <div className="mt-0.5 flex items-baseline gap-1">
                <p className={`text-lg font-bold leading-none ${stat.tone}`}>{stat.value}</p>
                <span className="text-[8px] text-slate-500">{stat.meta}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-2 grid gap-2 lg:grid-cols-[1.15fr_1fr]">
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold text-white">Attendance · last 7 days</p>
              <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[8px] font-semibold text-emerald-300">
                94% average
              </span>
            </div>
            {/* Real pixel heights: a percentage height needs a parent with a
                definite height, and inside this flex column it resolves to zero. */}
            <div className="mt-2.5 flex items-end gap-1.5">
              {bars.map((height, index) => (
                <span key={index} className="flex flex-1 flex-col items-center gap-1">
                  <span
                    style={{ height: `${Math.round((height / 100) * 56)}px` }}
                    className={`w-full rounded-t-md ${
                      index === 5
                        ? 'bg-gradient-to-t from-emerald-500 to-teal-300'
                        : 'bg-white/[0.09]'
                    }`}
                  />
                  <span className="text-[7px] text-slate-500">
                    {['M', 'T', 'W', 'T', 'F', 'S', 'S'][index]}
                  </span>
                </span>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold text-white">Needs you</p>
              <span className="text-[8px] font-semibold text-emerald-300">3 open</span>
            </div>
            <div className="mt-2 space-y-1.5">
              {approvals.map((row) => (
                <div
                  key={row.title}
                  className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1.5"
                >
                  <span className={`rounded-md px-1.5 py-0.5 text-[7px] font-bold ${row.tone}`}>{row.meta}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[9px] font-medium text-slate-200">{row.title}</span>
                    <span className="block truncate text-[8px] text-slate-500">{row.who}</span>
                  </span>
                  <ChevronRight className="h-2.5 w-2.5 text-slate-600" />
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
              className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-[8px] font-medium text-slate-400"
            >
              <chip.icon className="h-2.5 w-2.5 text-slate-500" />
              {chip.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  </div>
);

export default DashboardPreview;
