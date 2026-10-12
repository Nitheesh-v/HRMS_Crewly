import { Link } from 'react-router-dom';
import { ArrowRight, Check, Target } from 'lucide-react';
import { BRAND, TRUST_CHIPS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';
import DashboardPreview from '../DashboardPreview.jsx';

const HeroSection = () => (
  <section className="relative overflow-hidden px-5 pb-16 pt-14 sm:px-6 sm:pt-20 lg:px-8 lg:pb-24">
    {/* Depth, not a flat canvas: aurora glows + a fading dot grid, the same
        emerald/indigo language as the auth screens one click away. */}
    <div
      className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.16),transparent_42%),radial-gradient(circle_at_bottom_right,rgba(99,102,241,0.16),transparent_45%)]"
      aria-hidden="true"
    />
    <div
      className="landing-dots pointer-events-none absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_75%_60%_at_50%_0%,black,transparent)]"
      aria-hidden="true"
    />

    <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
      <div>
        <p className="landing-rise inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-semibold text-emerald-300">
          <span className="landing-breathe h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          AI assistant and presence, built in
        </p>

        <h1 className="landing-rise landing-rise-1 mt-6 text-4xl font-bold leading-[1.06] tracking-tight text-white sm:text-5xl lg:text-[3.55rem]">
          Run HR, payroll and
          <span className="bg-gradient-to-r from-emerald-400 via-teal-300 to-emerald-400 bg-clip-text text-transparent">
            {' '}
            attendance
          </span>{' '}
          from one workspace
        </h1>

        <p className="landing-rise landing-rise-2 mt-6 max-w-xl text-base leading-relaxed text-slate-300 sm:text-lg">
          Crewly keeps the people record, the timesheet and the payslip in the same
          place — so the numbers agree and your team stops chasing them. Each company
          is its own tenant, with roles and permissions deciding who sees what.
        </p>

        <div className="landing-rise landing-rise-2 mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link
            to="/register"
            className="group inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-6 py-3.5 text-sm font-semibold text-[#06251a] shadow-[0_10px_36px_-10px_rgba(16,185,129,0.65)] transition-all hover:-translate-y-0.5 hover:bg-emerald-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
          >
            Start your {BRAND.trialDays}-day trial
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
          <a
            href="#modules"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.02] px-6 py-3.5 text-sm font-semibold text-slate-100 transition-colors hover:border-white/25 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
          >
            See what&apos;s included
          </a>
        </div>

        <p className="landing-rise landing-rise-3 mt-5 flex items-center gap-2 text-sm text-slate-400">
          <Check className="h-4 w-4 text-emerald-400" aria-hidden="true" />
          No credit card. Your workspace stays yours if you stop.
        </p>
      </div>

      {/* Product preview with a glow ring and one floating capability card.
          Purely decorative — the whole column is hidden from assistive tech. */}
      <div className="landing-rise landing-rise-2 relative flex justify-center lg:justify-end">
        <div
          className="pointer-events-none absolute -inset-6 -z-10 rounded-[2rem] bg-[radial-gradient(circle_at_30%_20%,rgba(16,185,129,0.14),transparent_55%),radial-gradient(circle_at_75%_85%,rgba(99,102,241,0.14),transparent_55%)] blur-xl"
          aria-hidden="true"
        />
        <DashboardPreview />

        <div
          aria-hidden="true"
          className="landing-float absolute -bottom-7 left-2 hidden w-52 rounded-2xl border border-white/10 bg-[#0e1526]/95 p-3.5 shadow-2xl backdrop-blur sm:block lg:-left-4"
        >
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-300">
              <Target className="h-3.5 w-3.5" />
            </span>
            <p className="text-[11px] font-semibold text-white">Weekly hours goal</p>
          </div>
          <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full w-[80%] rounded-full bg-gradient-to-r from-emerald-500 to-teal-300" />
          </div>
          <p className="mt-1.5 text-[10px] text-slate-400">Goal met → earned rest, auto-marked</p>
        </div>
      </div>
    </div>

    {/* Trust strip: capability facts, not invented customer numbers. */}
    <div className="mx-auto mt-16 max-w-7xl sm:mt-20">
      <div className="landing-hairline h-px w-full" aria-hidden="true" />
      <p className="mt-8 text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
        Every plan includes
      </p>
      <ul className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {TRUST_CHIPS.map((chip) => (
          <li
            key={chip.label}
            className="inline-flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:border-white/20 hover:bg-white/[0.05]"
          >
            <LandingIcon name={chip.icon} className="h-4 w-4 shrink-0 text-emerald-300" />
            {chip.label}
          </li>
        ))}
      </ul>
    </div>
  </section>
);

export default HeroSection;
