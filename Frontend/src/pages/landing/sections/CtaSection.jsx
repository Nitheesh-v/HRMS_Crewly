// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — CLOSING CTA
//
// The last thing a visitor reads is the first thing the hero promised, said once
// more in fewer words. No countdown, no "limited seats": the only urgency is that
// the trial is free and takes a minute.
// ═══════════════════════════════════════════════════════════════════════════

import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { BRAND, HERO } from '../landingData.js';
import { displayLg, primaryCta, secondaryCta } from '../landingStyles.js';

const CtaSection = () => (
  <section className="relative overflow-hidden py-20 sm:py-24 lg:py-28">
    <div
      className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(52%_60%_at_50%_110%,rgba(16,185,129,0.28),transparent_72%)]"
      aria-hidden="true"
    />
    <div
      className="landing-grid pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-80 [mask-image:radial-gradient(ellipse_60%_70%_at_50%_100%,black,transparent)]"
      aria-hidden="true"
    />

    <div className="landing-scroll-in mx-auto max-w-4xl px-5 text-center sm:px-6 lg:px-8">
      <div className="landing-beam mx-auto h-px w-32" aria-hidden="true" />

      <h2 className={`mx-auto mt-8 max-w-3xl ${displayLg}`}>
        Close the month once. Then get on with the work.
      </h2>

      <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-crewly-ink/60">
        Create a company, invite the team, and let attendance, leave and payroll read the same record
        from day one.
      </p>

      <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link to={HERO.primaryCta.to} className={primaryCta}>
          {HERO.primaryCta.label}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </Link>
        <Link to="/login" className={secondaryCta}>
          Sign in instead
        </Link>
      </div>

      <p className="mt-6 inline-flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[11.5px] font-medium text-crewly-ink/50">
        <span className="inline-flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5 text-crewly-forest" aria-hidden="true" />
          {BRAND.trialDays}-day trial
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5 text-crewly-forest" aria-hidden="true" />
          No card at signup
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5 text-crewly-forest" aria-hidden="true" />
          Cancel into read-only, nothing deleted
        </span>
      </p>
    </div>
  </section>
);

export default CtaSection;
