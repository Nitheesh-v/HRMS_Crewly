// ═══════════════════════════════════════════════════════════════════════════
// HOME PAGE — PRODUCT PREVIEW (markup only, no screenshot, no client data)
//
// The values are illustrative UI, the same convention AuthLayout already uses
// for its sign-in panel. It is decorative: the whole block is aria-hidden, so a
// screen reader is not read a fake dashboard as if it were real.
// ═══════════════════════════════════════════════════════════════════════════

import { CalendarCheck, Check, CreditCard, UserPlus } from 'lucide-react';

const bars = [68, 82, 74, 91, 86, 95, 79];

const DashboardPreview = () => (
  <div
    aria-hidden="true"
    className="relative w-full max-w-md rounded-2xl border border-white/10 bg-[#0e1526]/90 p-4 shadow-2xl backdrop-blur"
  >
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-semibold text-white">Today</p>
        <p className="text-[11px] text-slate-400">Acme Workspace · HR overview</p>
      </div>
      <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-[10px] font-medium text-emerald-300">
        Live
      </span>
    </div>

    <div className="mt-3 grid grid-cols-2 gap-2.5">
      <div className="rounded-xl bg-white/[0.04] p-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-300">
          <CalendarCheck className="h-3.5 w-3.5" />
        </span>
        <p className="mt-2 text-[11px] text-slate-400">Checked in</p>
        <p className="text-lg font-bold text-white">128</p>
      </div>
      <div className="rounded-xl bg-white/[0.04] p-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-300">
          <UserPlus className="h-3.5 w-3.5" />
        </span>
        <p className="mt-2 text-[11px] text-slate-400">Joining this week</p>
        <p className="text-lg font-bold text-white">6</p>
      </div>
    </div>

    <div className="mt-2.5 rounded-xl bg-white/[0.04] p-3">
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

    <div className="mt-2.5 space-y-2">
      {[
        { icon: CreditCard, label: 'Payroll run ready for review', meta: '12 pending', tone: 'text-indigo-300' },
        { icon: Check, label: 'Leave approved · 2 days', meta: 'Ravi S.', tone: 'text-emerald-300' },
      ].map((row) => (
        <div key={row.label} className="flex items-center gap-3 rounded-xl bg-white/[0.04] px-3 py-2.5">
          <span className={`flex h-7 w-7 items-center justify-center rounded-lg bg-white/5 ${row.tone}`}>
            <row.icon className="h-3.5 w-3.5" />
          </span>
          <p className="min-w-0 flex-1 truncate text-xs text-slate-200">{row.label}</p>
          <span className="shrink-0 text-[10px] text-slate-400">{row.meta}</span>
        </div>
      ))}
    </div>
  </div>
);

export default DashboardPreview;
