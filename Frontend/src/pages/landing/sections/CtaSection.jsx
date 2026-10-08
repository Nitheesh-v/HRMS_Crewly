import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { BRAND } from '../landingData.js';

const CtaSection = () => (
  <section className="border-t border-white/10 px-5 py-16 sm:px-6 lg:px-8 lg:py-20">
    <div className="mx-auto max-w-5xl">
      <div className="relative overflow-hidden rounded-3xl border border-emerald-400/20 bg-gradient-to-br from-emerald-500/[0.14] via-[#0e1526] to-indigo-500/[0.14] px-6 py-12 text-center sm:px-12">
        <div className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-emerald-500/20 blur-3xl" aria-hidden="true" />
        <div className="pointer-events-none absolute -bottom-20 -right-10 h-56 w-56 rounded-full bg-indigo-500/20 blur-3xl" aria-hidden="true" />

        <h2 className="relative text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Set up your company in a few minutes
        </h2>
        <p className="relative mx-auto mt-4 max-w-xl text-base leading-relaxed text-slate-300">
          Register your company, invite your team and try every module for {BRAND.trialDays} days.
          If it is not for you, the workspace goes read-only — nothing is deleted.
        </p>

        <div className="relative mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/register"
            className="group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-6 py-3.5 text-sm font-semibold text-[#06251a] transition-colors hover:bg-emerald-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 sm:w-auto"
          >
            Create your workspace
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
          <Link
            to="/login"
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 px-6 py-3.5 text-sm font-semibold text-slate-100 transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 sm:w-auto"
          >
            I already have an account
          </Link>
        </div>

        <p className="relative mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-slate-400">
          {['No credit card', `${BRAND.trialDays}-day trial`, 'Cancel by doing nothing'].map((item) => (
            <span key={item} className="inline-flex items-center gap-1.5">
              <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
              {item}
            </span>
          ))}
        </p>
      </div>
    </div>
  </section>
);

export default CtaSection;
