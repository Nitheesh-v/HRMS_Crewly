import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { BRAND } from '../landingData.js';
import { primaryCta, secondaryCta } from '../landingStyles.js';

// The closing band uses the brand hairline as its top edge and the two accents
// together — emerald on the left, violet on the right — which is the page's
// visual signature in one place.
const CtaSection = () => (
  <section className="border-t border-white/[0.06] bg-crewly-night px-5 py-16 sm:px-6 lg:px-8 lg:py-20">
    <div className="mx-auto max-w-5xl">
      <div className="relative overflow-hidden rounded-[32px] border border-white/10 bg-gradient-to-br from-emerald-500/[0.12] via-white/[0.02] to-violet-600/[0.14] px-6 py-14 text-center sm:px-12">
        <div className="landing-hairline absolute inset-x-0 top-0 h-px" aria-hidden="true" />
        <div
          className="pointer-events-none absolute -left-20 -top-20 h-64 w-64 rounded-full bg-emerald-400/15 blur-3xl"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -bottom-24 -right-16 h-64 w-64 rounded-full bg-violet-500/20 blur-3xl"
          aria-hidden="true"
        />
        <div
          className="landing-dots pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_60%_70%_at_50%_50%,black,transparent)]"
          aria-hidden="true"
        />

        <p className="relative inline-flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-semibold text-emerald-300">
          <span className="landing-breathe h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
          Ready when you are
        </p>

        <h2 className="relative mt-5 text-balance text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-[2.9rem]">
          Set up your company in a few minutes
        </h2>
        <p className="relative mx-auto mt-4 max-w-xl text-base leading-relaxed text-slate-300">
          Register your company, invite your team and try every module for {BRAND.trialDays} days. If it
          is not for you, the workspace goes read-only — nothing is deleted.
        </p>

        <div className="relative mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link to="/register" className={`${primaryCta} w-full sm:w-auto`}>
            Create your workspace
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
          <Link to="/login" className={`${secondaryCta} w-full sm:w-auto`}>
            I already have an account
          </Link>
        </div>

        <p className="relative mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs font-medium text-slate-400">
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
