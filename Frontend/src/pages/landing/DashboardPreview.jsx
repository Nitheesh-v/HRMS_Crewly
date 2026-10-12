// ═══════════════════════════════════════════════════════════════════════════
// HOME PAGE — PRODUCT PREVIEW (markup only, no screenshot, no client data)
//
// The values are illustrative UI, the same convention AuthLayout already uses
// for its sign-in panel. It is decorative: the whole block is aria-hidden, so a
// screen reader is not read a fake dashboard as if it were real.
//
// The look: a browser-chrome frame so it reads as "the product", stat tiles,
// a real capability row (the weekly hours goal that ships in the product) and
// a work-feed. The 7-day bars are a decorative sparkline, not a claim.
// ═══════════════════════════════════════════════════════════════════════════

import { CalendarCheck, Check, CreditCard, Target, UserPlus } from 'lucide-react';

const bars = [68, 82, 74, 91, 86, 95, 79];

const DashboardPreview = () => (
  <div
    aria-hidden="true"
    className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-[#0e1526]/95 shadow-[0_30px_80px_-30px_rgba(2,6,23,0.9)] backdrop-blur"
  >
    {/* Browser chrome — decorative frame, not a real page. */}
    <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-4 py-2.5">
      <span className="flex gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-400/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/60" />
      </span>
      <span className="mx-auto inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[10px] font-medium text-slate-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        Crewly workspace
      </span>
      <span className="w-10" />
    </div>

    <div className="p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-white">Today</p>
          <p className="text-[11px] text-slate-400">HR overview</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[10px] font-medium text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Live
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <div className="rounded-xl border border-white/5 bg-white/[0.04] p-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-300">
            <CalendarCheck className="h-3.5 w-3.5" />
          </span>
          <p className="mt-2 text-[11px] text-slate-400">Checked in</p>
          <p className="text-lg font-bold text-white">128</p>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/[0.04] p-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-300">
            <UserPlus className="h-3.5 w-3.5" />
          </span>
          <p className="mt-2 text-[11px] text-slate-400">Joining this week</p>
          <p className="text-lg font-bold text-white">6</p>
        </div>
      </div>

      <div className="mt-2.5 rounded-xl border border-white/5 bg-white/[0.04] p-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-medium text-slate-400">Attendance, last 7 days</p>
          <span className="text-[11px] font-semibold text-emerald-300">94%</span>
        </div>
        <div className="mt-2 flex h-12 items-end gap-1.5">
          {bars.map((height, index) => (
            <span
              key={index}
              style={{ height: `${height}%` }}
              className="flex-1 rounded-t bg-gradient-to-t from-emerald-500/40 to-emerald-400"
            />
          ))}
        </div>
      </div>

      <div className="mt-2.5 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.06] p-3">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-[11px] font-semibold text-emerald-200">
            <Target className="h-3.5 w-3.5" />
            Weekly hours goal
          </span>
          <span className="text-[10px] font-medium text-emerald-300">32h / 40h</span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full w-[80%] rounded-full bg-gradient-to-r from-emerald-500 to-teal-300" />
        </div>
        <p className="mt-1.5 text-[10px] text-slate-400">Goal met → remaining days become paid earned rest</p>
      </div>

      <div className="mt-2.5 space-y-2">
        {[
          { icon: CreditCard, label: 'Payroll run ready for review', meta: '12 pending', tone: 'text-indigo-300' },
          { icon: Check, label: 'Leave approved · 2 days', meta: 'Ravi S.', tone: 'text-emerald-300' },
        ].map((row) => (
          <div key={row.label} className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.04] px-3 py-2.5">
            <span className={`flex h-7 w-7 items-center justify-center rounded-lg bg-white/5 ${row.tone}`}>
              <row.icon className="h-3.5 w-3.5" />
            </span>
            <p className="min-w-0 flex-1 truncate text-xs text-slate-200">{row.label}</p>
            <span className="shrink-0 text-[10px] text-slate-400">{row.meta}</span>
          </div>
        ))}
      </div>
    </div>
  </div>
);

export default DashboardPreview;
