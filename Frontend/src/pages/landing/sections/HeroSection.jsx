import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { BRAND, TRUST_CHIPS } from '../landingData.js';
import LandingIcon from '../LandingIcon.jsx';
import DashboardPreview from '../DashboardPreview.jsx';

const HeroSection = () => (
  <section className="relative overflow-hidden px-5 pb-16 pt-14 sm:px-6 sm:pt-20 lg:px-8 lg:pb-24">
    {/* Layered glows instead of a flat canvas — the same language as the auth screens. */}
    <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.18),transparent_42%),radial-gradient(circle_at_bottom_right,rgba(99,102,241,0.18),transparent_45%)]" />

    <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
      <div>
        <p className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          AI assistant and presence, built in
        </p>

        <h1 className="mt-5 text-4xl font-bold leading-[1.08] tracking-tight text-white sm:text-5xl lg:text-6xl">
          Run HR, payroll and
          <span className="bg-gradient-to-r from-emerald-400 to-teal-300 bg-clip-text text-transparent">
            {' '}
            attendance
          </span>{' '}
          from one workspace
        </h1>

        <p className="mt-6 max-w-xl text-base leading-relaxed text-slate-300 sm:text-lg">
          Crewly keeps the people record, the timesheet and the payslip in the same
          place — so the numbers agree and your team stops chasing them. Each company
          is its own tenant, with roles and permissions deciding who sees what.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link
            to="/register"
            className="group inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-6 py-3.5 text-sm font-semibold text-[#06251a] transition-colors hover:bg-emerald-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
          >
            Start your {BRAND.trialDays}-day trial
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
          <a
            href="#modules"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 px-6 py-3.5 text-sm font-semibold text-slate-100 transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
          >
            See what&apos;s included
          </a>
        </div>

        <p className="mt-4 flex items-center gap-2 text-sm text-slate-400">
          <Check className="h-4 w-4 text-emerald-400" aria-hidden="true" />
          No credit card. Your workspace stays yours if you stop.
        </p>
      </div>

      <div className="flex justify-center lg:justify-end">
        <DashboardPreview />
      </div>
    </div>

    {/* Trust strip: capability facts, not invented customer numbers. */}
    <ul className="mx-auto mt-14 flex max-w-7xl flex-wrap gap-2.5 sm:mt-16">
      {TRUST_CHIPS.map((chip) => (
        <li
          key={chip.label}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-xs font-medium text-slate-300"
        >
          <LandingIcon name={chip.icon} className="h-3.5 w-3.5 text-emerald-300" />
          {chip.label}
        </li>
      ))}
    </ul>
  </section>
);

export default HeroSection;
