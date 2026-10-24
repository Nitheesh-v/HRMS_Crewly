// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC HOME PAGE — CLOSING CTA
//
// The last thing a visitor reads is the first thing the hero promised, said once
// more in fewer words. No countdown, no "limited seats": the only urgency is that
// the trial is free and takes a minute.
//
// It is the page's second dark moment: a forest panel set into the paper, with
// the lilac action on top. After two thousand pixels of cream, the colour change
// is what makes the last block read as an ending rather than more scrolling.
// ═══════════════════════════════════════════════════════════════════════════

import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { BRAND, HERO } from '../landingData.js';
import { displayLgOnDark, primaryCta, secondaryCtaOnDark } from '../landingStyles.js';

const CtaSection = () => (
  <section className="relative px-4 pb-20 pt-4 sm:px-6 sm:pb-24 lg:px-8 lg:pb-28">
    <div className="landing-band landing-scroll-in relative mx-auto max-w-6xl overflow-hidden rounded-[2rem] px-6 py-16 sm:rounded-[2.5rem] sm:px-10 sm:py-20">
      <div
        className="landing-dots-light pointer-events-none absolute inset-0 opacity-30 [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]"
        aria-hidden="true"
      />

      <div className="relative mx-auto max-w-3xl text-center">
        <div className="mx-auto h-px w-32 bg-crewly-lilac/70" aria-hidden="true" />

        <h2 className={`mx-auto mt-8 max-w-3xl ${displayLgOnDark}`}>
          Close the month once. Then get on with the work.
        </h2>

        <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-crewly-void/70">
          Create a company, invite the team, and let attendance, leave and payroll read the same
          record from day one.
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link to={HERO.primaryCta.to} className={primaryCta}>
            {HERO.primaryCta.label}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
          <Link to="/login" className={secondaryCtaOnDark}>
            Sign in instead
          </Link>
        </div>

        <p className="mt-6 inline-flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[11.5px] font-medium text-crewly-void/65">
          <span className="inline-flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-crewly-lilac" aria-hidden="true" />
            {BRAND.trialDays}-day trial
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-crewly-lilac" aria-hidden="true" />
            No card at signup
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Check className="h-3.5 w-3.5 text-crewly-lilac" aria-hidden="true" />
            Cancel into read-only, nothing deleted
          </span>
        </p>
      </div>
    </div>
  </section>
);

export default CtaSection;
