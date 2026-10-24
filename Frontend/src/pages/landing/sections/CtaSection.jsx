import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { BRAND } from '../landingData.js';

const CtaSection = () => (
  <section className="border-t border-crewly-lilac-line bg-white px-5 py-16 sm:px-6 lg:px-8 lg:py-20">
    <div className="mx-auto max-w-5xl">
      <div className="relative overflow-hidden rounded-[32px] border border-crewly-lilac-line bg-gradient-to-br from-crewly-lilac via-white to-emerald-50/60 px-6 py-14 text-center sm:px-12">
        <div
          className="pointer-events-none absolute -left-20 -top-20 h-64 w-64 rounded-full bg-violet-300/25 blur-3xl"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -bottom-24 -right-16 h-64 w-64 rounded-full bg-emerald-300/25 blur-3xl"
          aria-hidden="true"
        />
        <div
          className="landing-dots pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_60%_70%_at_50%_50%,black,transparent)]"
          aria-hidden="true"
        />

        <p className="relative inline-flex items-center gap-2 rounded-full border border-violet-200 bg-white/80 px-3.5 py-1.5 text-xs font-semibold text-violet-800 backdrop-blur">
          <span className="landing-breathe h-1.5 w-1.5 rounded-full bg-violet-600" aria-hidden="true" />
          Ready when you are
        </p>

        <h2 className="relative mt-5 text-3xl font-bold tracking-tight text-crewly-ink sm:text-4xl lg:text-[2.9rem]">
          Set up your company in a few minutes
        </h2>
        <p className="relative mx-auto mt-4 max-w-xl text-base leading-relaxed text-slate-600">
          Register your company, invite your team and try every module for {BRAND.trialDays} days. If it
          is not for you, the workspace goes read-only — nothing is deleted.
        </p>

        <div className="relative mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/register"
            className="group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-violet-700 to-[#4c1d95] px-6 py-3.5 text-sm font-semibold text-white shadow-[0_16px_34px_-16px_rgba(76,29,149,0.85)] transition-[color,background-color,border-color,box-shadow,transform] hover:-translate-y-0.5 hover:from-violet-600 hover:to-violet-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700 sm:w-auto"
          >
            Create your workspace
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
          <Link
            to="/login"
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-6 py-3.5 text-sm font-semibold text-crewly-ink transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-700 sm:w-auto"
          >
            I already have an account
          </Link>
        </div>

        <p className="relative mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs font-medium text-slate-500">
          {['No credit card', `${BRAND.trialDays}-day trial`, 'Cancel by doing nothing'].map((item) => (
            <span key={item} className="inline-flex items-center gap-1.5">
              <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
              {item}
            </span>
          ))}
        </p>
      </div>
    </div>
  </section>
);

export default CtaSection;
